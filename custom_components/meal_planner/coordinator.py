"""Fetches the add-on's state: on a timer and whenever the add-on fires one of its bus events."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import CannotConnect, InvalidAuth, async_fetch_state
from .const import CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN, UPDATE_INTERVAL

_LOGGER = logging.getLogger(__name__)


class MealPlannerCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """`data` is the add-on's `{current, next, generated_at}`."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN, update_interval=UPDATE_INTERVAL)

    async def _async_update_data(self) -> dict[str, Any]:
        data = self.config_entry.data
        try:
            return await async_fetch_state(self.hass, data[CONF_HOST], data[CONF_PORT], data[CONF_TOKEN])
        except InvalidAuth as err:
            raise ConfigEntryAuthFailed from err
        except CannotConnect as err:
            raise UpdateFailed(f"Meal Planner add-on not reachable: {err}") from err
