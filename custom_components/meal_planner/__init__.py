"""The Meal Planner integration.

Polling, with a push assist (iot_class: local_polling): the meal-planner add-on serves its state on a
second, token-protected port and announces host, port and token through Supervisor discovery (see
config_flow.py). The coordinator fetches it every few minutes and immediately whenever the add-on
fires one of its `meal_planner_*` bus events (which it posts through the Supervisor, not this
integration). Nothing is ever sent back to the add-on (read-only: sensors and the bundled card).
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.const import LOVELACE_DATA, MODE_STORAGE
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant

from .const import DOMAIN, EVENT_PREFIX, EVENT_TYPES, PLATFORMS, VERSION
from .coordinator import MealPlannerCoordinator

CARD_URL_PATH = f"/{DOMAIN}/meal-planner-card.js"
CARD_FILE = Path(__file__).parent / "www" / "meal-planner-card.js"
CARD_REGISTERED = f"{DOMAIN}_card_registered"

type MealPlannerConfigEntry = ConfigEntry[MealPlannerCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: MealPlannerConfigEntry) -> bool:
    """Set up Meal Planner from a config entry."""
    coordinator = MealPlannerCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    async def _refresh(_event: Event) -> None:
        await coordinator.async_request_refresh()

    for event_type in EVENT_TYPES:
        entry.async_on_unload(hass.bus.async_listen(f"{EVENT_PREFIX}{event_type}", _refresh))

    await _async_register_card(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: MealPlannerConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card and make the frontend load it, once per HA run.

    async_register_static_paths raises if the same path is registered twice (e.g. on an
    integration reload), so this is guarded: nothing to redo once it has happened, since the
    path/registration never changes. The flag lives directly in hass.data, not per entry.
    """
    if hass.data.get(CARD_REGISTERED):
        return
    hass.data[CARD_REGISTERED] = True

    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL_PATH, str(CARD_FILE), True)])
    card_url = f"{CARD_URL_PATH}?v={VERSION}"
    if not await _async_ensure_lovelace_resource(hass, card_url):
        add_extra_js_url(hass, card_url)


async def _async_ensure_lovelace_resource(hass: HomeAssistant, url: str) -> bool:
    """Register the card as a Lovelace resource (storage mode only); False if that is not possible.

    add_extra_js_url loads the module in parallel to the dashboard, so the Companion App can render
    the card before `meal-planner-card` is defined ("Konfigurationsfehler", back after each reload).
    Lovelace resources are loaded before the dashboard renders. An existing entry for the card
    (also a manually added one) is updated to the current version instead of duplicated.
    """
    lovelace = hass.data.get(LOVELACE_DATA)
    if lovelace is None or lovelace.resource_mode != MODE_STORAGE:
        return False  # YAML mode: resources are user-managed, fall back to the extra module URL
    resources = lovelace.resources
    if not resources.loaded:
        await resources.async_load()
        resources.loaded = True
    for item in resources.async_items():
        if item["url"].split("?")[0] == CARD_URL_PATH:
            if item["url"] != url or item["type"] != "module":
                await resources.async_update_item(item["id"], {"res_type": "module", "url": url})
            return True
    await resources.async_create_item({"res_type": "module", "url": url})
    return True
