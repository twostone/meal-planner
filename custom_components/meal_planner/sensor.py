"""Sensor platform for Meal Planner.

Three push-driven entities (iot_class: local_push, see __init__.py): there is nothing to poll,
so each entity just re-renders from `hass.data[DOMAIN][entry.entry_id]["plan"]` whenever the
webhook handler sends an update signal.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_UPDATE


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up the three Meal Planner sensors."""
    data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            CurrentListSensor(entry, data),
            OpenCountSensor(entry, data),
            DoneCountSensor(entry, data),
        ]
    )


class _MealPlannerSensor(SensorEntity):
    """Base for the three sensors: shared device, shared dispatcher-driven update."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, data: dict[str, Any], key: str) -> None:
        self._entry = entry
        self._data = data
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name="Meal Planner")

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, f"{SIGNAL_UPDATE}_{self._entry.entry_id}", self._handle_update)
        )

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()

    @property
    def _plan(self) -> dict[str, Any] | None:
        return self._data.get("plan")


class CurrentListSensor(_MealPlannerSensor):
    """State is a short summary; the full list lives in the attributes for cards/automations."""

    _attr_icon = "mdi:silverware-fork-knife"

    def __init__(self, entry: ConfigEntry, data: dict[str, Any]) -> None:
        super().__init__(entry, data, "current_list")

    @property
    def native_value(self) -> str:
        plan = self._plan
        if not plan:
            return "Keine Liste"
        open_count = plan["entry_count"] - plan["done_count"]
        return f"{open_count} offen von {plan['entry_count']}"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        plan = self._plan
        if not plan:
            return {}
        return {"start_date": plan["start_date"], "end_date": plan["end_date"], "entries": plan["entries"]}


class OpenCountSensor(_MealPlannerSensor):
    _attr_icon = "mdi:checkbox-blank-outline"
    _attr_native_unit_of_measurement = "Gerichte"
    _attr_state_class = "measurement"

    def __init__(self, entry: ConfigEntry, data: dict[str, Any]) -> None:
        super().__init__(entry, data, "open_count")

    @property
    def native_value(self) -> int:
        plan = self._plan
        return plan["entry_count"] - plan["done_count"] if plan else 0


class DoneCountSensor(_MealPlannerSensor):
    _attr_icon = "mdi:checkbox-marked-outline"
    _attr_native_unit_of_measurement = "Gerichte"
    _attr_state_class = "measurement"

    def __init__(self, entry: ConfigEntry, data: dict[str, Any]) -> None:
        super().__init__(entry, data, "done_count")

    @property
    def native_value(self) -> int:
        plan = self._plan
        return plan["done_count"] if plan else 0
