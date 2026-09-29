"""Tests for the Meal Planner config flow."""

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from custom_components.meal_planner.const import CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN

from .conftest import HOST, PORT, STATE, STATE_URL, TOKEN, make_entry

DATA = {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}


def discovery(uuid="uuid-1", token=TOKEN, host=HOST):
    return HassioServiceInfo(
        config={"host": host, "port": PORT, "token": token, "addon": "Essensplanung"},
        name="Essensplanung",
        slug="essensplanung",
        uuid=uuid,
    )


async def _discover(hass, info):
    return await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=info)


async def test_discovery_confirm_creates_entry(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(STATE_URL, json=STATE)
    result = await _discover(hass, discovery())
    assert result["type"] == "form" and result["step_id"] == "hassio_confirm"

    done = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert done["type"] == "create_entry"
    assert done["title"] == "Meal Planner"
    assert done["data"] == {**DATA, "slug": "essensplanung"}  # the add-on name is not stored
    assert done["result"].unique_id == "uuid-1"
    assert aioclient_mock.mock_calls[0][3]["Authorization"] == f"Bearer {TOKEN}"


async def test_discovery_confirm_with_unreachable_addon_shows_error(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(STATE_URL, exc=TimeoutError)
    result = await _discover(hass, discovery())
    again = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert again["type"] == "form"
    assert again["errors"] == {"base": "cannot_connect"}


async def test_discovery_again_updates_the_existing_entry(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(STATE_URL, json=STATE)
    entry = make_entry()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    result = await _discover(hass, discovery(uuid="uuid-2", token="rotated"))
    assert result["type"] == "abort"
    assert result["reason"] == "already_configured"
    assert entry.data[CONF_TOKEN] == "rotated"
    assert entry.data["slug"] == "essensplanung"
    assert entry.unique_id == "uuid-2"  # a reinstalled add-on gets a new discovery uuid


async def test_discovery_takes_over_a_manual_entry(hass: HomeAssistant) -> None:
    entry = make_entry()
    entry.add_to_hass(hass)
    result = await _discover(hass, discovery(uuid="uuid-9", host="new-host"))
    assert result["reason"] == "already_configured"
    assert entry.data[CONF_HOST] == "new-host"


async def test_user_flow_creates_entry(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(STATE_URL, json=STATE)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] == "form" and result["step_id"] == "user"
    done = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
    assert done["type"] == "create_entry"
    assert done["data"] == DATA
    assert done["result"].unique_id == f"{HOST}:{PORT}"


async def test_user_flow_errors(hass: HomeAssistant, aioclient_mock) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    aioclient_mock.get(STATE_URL, status=401)
    bad = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
    assert bad["errors"] == {"base": "invalid_auth"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, status=500)
    bad = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
    assert bad["errors"] == {"base": "cannot_connect"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, json=STATE)
    ok = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
    assert ok["type"] == "create_entry"


async def test_single_instance_allowed(hass: HomeAssistant) -> None:
    make_entry().add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] == "abort"
    assert result["reason"] == "single_instance_allowed"


async def test_reauth_with_a_new_token(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(STATE_URL, status=401)
    entry = make_entry()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is config_entries.ConfigEntryState.SETUP_ERROR
    flow = next(iter(hass.config_entries.flow.async_progress_by_handler(DOMAIN)))
    assert flow["context"]["source"] == config_entries.SOURCE_REAUTH

    aioclient_mock.clear_requests()
    aioclient_mock.get(STATE_URL, json=STATE)
    done = await hass.config_entries.flow.async_configure(flow["flow_id"], {CONF_TOKEN: "new"})
    assert done["type"] == "abort" and done["reason"] == "reauth_successful"
    assert entry.data[CONF_TOKEN] == "new"
