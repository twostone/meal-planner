"""Tests for the Meal Planner webhook -> entities/events."""

import pytest
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.meal_planner.const import DOMAIN, EVENT_ENTRY_ADDED, EVENT_PLAN_CREATED

WEBHOOK_ID = "test_webhook_id"

SAMPLE_PLAN = {
    "id": 1,
    "start_date": "2026-09-26",
    "end_date": "2026-10-02",
    "entry_count": 1,
    "done_count": 0,
    "entries": [
        {
            "id": 1,
            "dish_id": 1,
            "title": "Linsensuppe",
            "note": None,
            "tags": [],
            "image": None,
            "url": None,
            "done": False,
        }
    ],
}


@pytest.fixture
async def config_entry(hass):
    # async_setup_entry registers a static path on hass.http (needs the http component) and an
    # extra JS module on the frontend's registry. Loading the real "frontend" component here
    # would need the separate, heavy home-assistant-frontend PyPI package just for its data key
    # to exist, so the registry set is seeded directly instead.
    await async_setup_component(hass, "http", {})
    hass.data.setdefault(DATA_EXTRA_MODULE_URL, set())
    entry = MockConfigEntry(domain=DOMAIN, data={"webhook_id": WEBHOOK_ID})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_webhook_push_updates_the_three_sensors(hass, hass_client_no_auth, config_entry):
    client = await hass_client_no_auth()
    resp = await client.post(f"/api/webhook/{WEBHOOK_ID}", json={"event": None, "plan": SAMPLE_PLAN})
    assert resp.status == 200
    await hass.async_block_till_done()

    assert hass.states.get("sensor.meal_planner_current_list").state == "1 offen von 1"
    assert hass.states.get("sensor.meal_planner_current_list").attributes["entries"] == SAMPLE_PLAN["entries"]
    assert hass.states.get("sensor.meal_planner_open_count").state == "1"
    assert hass.states.get("sensor.meal_planner_done_count").state == "0"


async def test_no_plan_yet_is_a_neutral_state(hass, hass_client_no_auth, config_entry):
    client = await hass_client_no_auth()
    resp = await client.post(f"/api/webhook/{WEBHOOK_ID}", json={"event": None, "plan": None})
    assert resp.status == 200
    await hass.async_block_till_done()

    assert hass.states.get("sensor.meal_planner_current_list").state == "Keine Liste"
    assert hass.states.get("sensor.meal_planner_open_count").state == "0"


@pytest.mark.parametrize(
    ("event_field", "expect_plan_created", "expect_entry_added"),
    [(None, False, False), ("plan_created", True, False), ("entry_added", False, True)],
)
async def test_bus_events_fire_only_for_their_own_event(
    hass, hass_client_no_auth, config_entry, event_field, expect_plan_created, expect_entry_added
):
    plan_created_events = []
    entry_added_events = []
    hass.bus.async_listen(EVENT_PLAN_CREATED, lambda e: plan_created_events.append(e))
    hass.bus.async_listen(EVENT_ENTRY_ADDED, lambda e: entry_added_events.append(e))

    client = await hass_client_no_auth()
    await client.post(f"/api/webhook/{WEBHOOK_ID}", json={"event": event_field, "plan": SAMPLE_PLAN})
    await hass.async_block_till_done()

    assert bool(plan_created_events) is expect_plan_created
    assert bool(entry_added_events) is expect_entry_added


async def test_malformed_body_is_400_and_does_not_crash(hass, hass_client_no_auth, config_entry):
    client = await hass_client_no_auth()
    resp = await client.post(
        f"/api/webhook/{WEBHOOK_ID}", data="not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status == 400
