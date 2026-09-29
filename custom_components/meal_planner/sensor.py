"""Sensor platform for Meal Planner.

Four entities fed by the coordinator (see __init__.py): the current and the next list (state is a short
summary, the full list lives in the attributes for cards/automations) and the open/done counts of the
current list.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import MealPlannerConfigEntry
from .const import DOMAIN
from .coordinator import MealPlannerCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: MealPlannerConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up the Meal Planner sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            CurrentListSensor(entry, coordinator),
            NextListSensor(entry, coordinator),
            OpenCountSensor(entry, coordinator),
            DoneCountSensor(entry, coordinator),
        ]
    )


class _MealPlannerSensor(CoordinatorEntity[MealPlannerCoordinator], SensorEntity):
    """Base: shared device, one key into the coordinator's data."""

    _attr_has_entity_name = True
    _plan_key = "current"

    def __init__(self, entry: MealPlannerConfigEntry, coordinator: MealPlannerCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name="Meal Planner")

    @property
    def _plan(self) -> dict[str, Any] | None:
        return (self.coordinator.data or {}).get(self._plan_key)


class _ListSensor(_MealPlannerSensor):
    """A list as attributes. `entries` can be long, so it is kept out of the recorder database."""

    _unrecorded_attributes = frozenset({"entries"})

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        plan = self._plan
        if not plan:
            return {}
        return {"start_date": plan["start_date"], "end_date": plan["end_date"], "entries": plan["entries"]}


class CurrentListSensor(_ListSensor):
    _attr_icon = "mdi:silverware-fork-knife"

    def __init__(self, entry: MealPlannerConfigEntry, coordinator: MealPlannerCoordinator) -> None:
        super().__init__(entry, coordinator, "current_list")

    @property
    def native_value(self) -> str:
        plan = self._plan
        if not plan:
            return "Keine Liste"
        return f"{plan['entry_count'] - plan['done_count']} offen von {plan['entry_count']}"


class NextListSensor(_ListSensor):
    _attr_icon = "mdi:calendar-arrow-right"
    _plan_key = "next"

    def __init__(self, entry: MealPlannerConfigEntry, coordinator: MealPlannerCoordinator) -> None:
        super().__init__(entry, coordinator, "next_list")

    @property
    def native_value(self) -> str:
        plan = self._plan
        return f"{plan['entry_count']} Gerichte" if plan else "Keine Liste"


class OpenCountSensor(_MealPlannerSensor):
    _attr_icon = "mdi:checkbox-blank-outline"
    _attr_native_unit_of_measurement = "Gerichte"
    _attr_state_class = "measurement"

    def __init__(self, entry: MealPlannerConfigEntry, coordinator: MealPlannerCoordinator) -> None:
        super().__init__(entry, coordinator, "open_count")

    @property
    def native_value(self) -> int:
        plan = self._plan
        return plan["entry_count"] - plan["done_count"] if plan else 0


class DoneCountSensor(_MealPlannerSensor):
    _attr_icon = "mdi:checkbox-marked-outline"
    _attr_native_unit_of_measurement = "Gerichte"
    _attr_state_class = "measurement"

    def __init__(self, entry: MealPlannerConfigEntry, coordinator: MealPlannerCoordinator) -> None:
        super().__init__(entry, coordinator, "done_count")

    @property
    def native_value(self) -> int:
        plan = self._plan
        return plan["done_count"] if plan else 0
