"""Tests for setup, the coordinator, the sensors and the event-driven refresh."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.components.lovelace.const import LOVELACE_DATA, MODE_STORAGE
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import device_registry as dr
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.meal_planner import CARD_URL_PATH
from custom_components.meal_planner.const import DOMAIN, EVENT_PREFIX, EVENT_TYPES, UPDATE_INTERVAL, VERSION

from .conftest import CURRENT, NEXT, STATE, STATE_URL, make_entry


async def _setup(hass, aioclient_mock, state=STATE, **kw):
    aioclient_mock.get(STATE_URL, json=state, **kw)
    entry = make_entry()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_sensors_show_current_and_next_list(hass, aioclient_mock):
    await _setup(hass, aioclient_mock)
    cur = hass.states.get("sensor.meal_planner_current_list")
    assert cur.state == "1 offen von 2"
    assert cur.attributes["start_date"] == "2026-09-26"
    assert cur.attributes["entries"] == CURRENT["entries"]
    nxt = hass.states.get("sensor.meal_planner_next_list")
    assert nxt.state == "1 Gerichte"
    assert nxt.attributes["entries"] == NEXT["entries"]
    assert hass.states.get("sensor.meal_planner_open_count").state == "1"
    assert hass.states.get("sensor.meal_planner_done_count").state == "1"


async def test_list_name_is_an_attribute_and_none_without_one(hass, aioclient_mock):
    state = {**STATE, "current": {**CURRENT, "title": "Geburtstagswoche"}}
    await _setup(hass, aioclient_mock, state)
    assert hass.states.get("sensor.meal_planner_current_list").attributes["title"] == "Geburtstagswoche"
    # a list without a name (or an add-on too old to send one) has title None
    assert hass.states.get("sensor.meal_planner_next_list").attributes["title"] is None


async def test_app_link_comes_from_the_discovered_slug(hass, aioclient_mock):
    aioclient_mock.get(STATE_URL, json=STATE)
    entry = make_entry(slug="abc_meal_planner")
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.meal_planner_current_list").attributes["app_url"] == "/abc_meal_planner"
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, entry.entry_id)})
    assert device.configuration_url == "homeassistant://abc_meal_planner"


async def test_no_app_link_without_slug(hass, aioclient_mock):
    entry = await _setup(hass, aioclient_mock)
    assert "app_url" not in hass.states.get("sensor.meal_planner_current_list").attributes
    assert dr.async_get(hass).async_get_device(identifiers={(DOMAIN, entry.entry_id)}).configuration_url is None


async def test_no_lists_is_a_neutral_state(hass, aioclient_mock):
    await _setup(hass, aioclient_mock, {"current": None, "next": None, "generated_at": "x"})
    assert hass.states.get("sensor.meal_planner_current_list").state == "Keine Liste"
    assert hass.states.get("sensor.meal_planner_next_list").state == "Keine Liste"
    assert hass.states.get("sensor.meal_planner_open_count").state == "0"


def test_entries_are_kept_out_of_the_recorder():
    from custom_components.meal_planner.sensor import CurrentListSensor, NextListSensor

    assert "entries" in CurrentListSensor._unrecorded_attributes
    assert "entries" in NextListSensor._unrecorded_attributes


async def test_unreachable_addon_makes_setup_retry_then_entities_unavailable(hass, aioclient_mock):
    entry = await _setup(hass, aioclient_mock, exc=TimeoutError)
    assert entry.state is ConfigEntryState.SETUP_RETRY

    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, json=STATE)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=2))
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.LOADED

    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, exc=TimeoutError)
    async_fire_time_changed(hass, dt_util.utcnow() + UPDATE_INTERVAL + timedelta(seconds=5))
    await hass.async_block_till_done()
    assert hass.states.get("sensor.meal_planner_current_list").state == "unavailable"


async def test_bad_token_starts_reauth(hass, aioclient_mock):
    entry = await _setup(hass, aioclient_mock, status=401)
    assert entry.state is ConfigEntryState.SETUP_ERROR


async def test_bus_event_refreshes_immediately(hass, aioclient_mock):
    await _setup(hass, aioclient_mock)
    changed = {**STATE, "current": {**CURRENT, "done_count": 2}}
    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, json=changed)

    hass.bus.async_fire("meal_planner_entry_done", {"plan": {"id": 1}, "entry": {"id": 1, "title": "x"}, "user": None})
    await hass.async_block_till_done()
    assert hass.states.get("sensor.meal_planner_current_list").state == "0 offen von 2"


async def test_every_event_type_triggers_a_refresh(hass, aioclient_mock):
    await _setup(hass, aioclient_mock)
    assert len(EVENT_TYPES) == 6
    assert "plan_updated" in EVENT_TYPES
    for kind in EVENT_TYPES:
        aioclient_mock.mock_calls.clear()
        hass.bus.async_fire(f"{EVENT_PREFIX}{kind}", {})
        await hass.async_block_till_done()
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=15))  # debouncer cooldown
        await hass.async_block_till_done()
        assert aioclient_mock.call_count >= 1, kind


def _fake_lovelace(hass, items, mode=MODE_STORAGE):
    resources = ResourceStorageCollection(hass, None)
    resources.loaded = True
    resources.data = {}
    for item in items:
        resources.data[item["id"]] = item
    resources.store.async_save = AsyncMock()
    hass.data[LOVELACE_DATA] = SimpleNamespace(resource_mode=mode, resources=resources)
    return resources


async def test_card_registered_as_lovelace_resource_in_storage_mode(hass, aioclient_mock):
    resources = _fake_lovelace(hass, [])
    await _setup(hass, aioclient_mock)
    [item] = resources.async_items()
    assert item["type"] == "module"
    assert item["url"] == f"{CARD_URL_PATH}?v={VERSION}"
    assert not hass.data[DATA_EXTRA_MODULE_URL]


async def test_existing_resource_is_updated_not_duplicated(hass, aioclient_mock):
    resources = _fake_lovelace(hass, [{"id": "a", "type": "js", "url": f"{CARD_URL_PATH}?v=1"}])
    await _setup(hass, aioclient_mock)
    [item] = resources.async_items()
    assert item["id"] == "a"
    assert item["type"] == "module"
    assert item["url"] == f"{CARD_URL_PATH}?v={VERSION}"


async def test_yaml_mode_falls_back_to_extra_module_url(hass, aioclient_mock):
    _fake_lovelace(hass, [], mode="yaml")
    await _setup(hass, aioclient_mock)
    assert hass.data[DATA_EXTRA_MODULE_URL] == {f"{CARD_URL_PATH}?v={VERSION}"}


async def test_no_lovelace_falls_back_to_extra_module_url(hass, aioclient_mock):
    await _setup(hass, aioclient_mock)
    assert hass.data[DATA_EXTRA_MODULE_URL] == {f"{CARD_URL_PATH}?v={VERSION}"}


async def test_unload_and_reload_keep_working(hass, aioclient_mock):
    entry = await _setup(hass, aioclient_mock)
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert await hass.config_entries.async_setup(entry.entry_id)  # card is registered only once
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
