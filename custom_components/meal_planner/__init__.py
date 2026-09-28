"""The Meal Planner integration.

Push-only (iot_class: local_push): the meal-planner add-on POSTs a snapshot of the current list
to a webhook this integration registers, after every change plus once on startup. Two of those
pushes carry an `event` ("plan_created"/"entry_added"), which this integration turns into HA bus
events; every push updates the entities in sensor.py via a dispatcher signal. There is no polling
and nothing is ever sent back to the add-on (see sensor.py / the bundled card: read-only).
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web

from homeassistant.components import webhook
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import DOMAIN, EVENT_ENTRY_ADDED, EVENT_PLAN_CREATED, PLATFORMS, SIGNAL_UPDATE, VERSION

CARD_URL_PATH = f"/{DOMAIN}/meal-planner-card.js"
CARD_FILE = Path(__file__).parent / "www" / "meal-planner-card.js"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Meal Planner from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data[entry.entry_id] = {"plan": None}

    async def handle_webhook(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return web.Response(status=400)

        domain_data[entry.entry_id]["plan"] = body.get("plan")
        async_dispatcher_send(hass, f"{SIGNAL_UPDATE}_{entry.entry_id}")

        event = body.get("event")
        if event == "plan_created":
            hass.bus.async_fire(EVENT_PLAN_CREATED, {"plan": body.get("plan")})
        elif event == "entry_added":
            hass.bus.async_fire(EVENT_ENTRY_ADDED, {"plan": body.get("plan")})

        return web.Response(status=200)

    # local_only: the add-on always calls in from the LAN, so the internet never needs a path in.
    webhook.async_register(
        hass,
        DOMAIN,
        "Meal Planner",
        entry.data["webhook_id"],
        handle_webhook,
        local_only=True,
        allowed_methods={"POST"},
    )

    await _async_register_card(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    webhook.async_unregister(hass, entry.data["webhook_id"])
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card and register it as an extra frontend module, once per HA run.

    async_register_static_paths raises if the same path is registered twice (e.g. on an
    integration reload), so this is guarded the same way the single-instance config entry is:
    nothing to redo once it has happened, since the path/registration never changes.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_card_registered"):
        return
    domain_data["_card_registered"] = True

    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL_PATH, str(CARD_FILE), True)])
    add_extra_js_url(hass, f"{CARD_URL_PATH}?v={VERSION}")
