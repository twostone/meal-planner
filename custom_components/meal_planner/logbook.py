"""Describes the add-on's bus events in the logbook ("Anna hat Pasta hinzugefügt")."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.logbook import LOGBOOK_ENTRY_MESSAGE, LOGBOOK_ENTRY_NAME
from homeassistant.core import Event, HomeAssistant, callback

from .const import DOMAIN, EVENT_PREFIX, EVENT_TYPES

_ACTIONS = {
    "entry_added": "hat „{title}“ zur Liste hinzugefügt",
    "entry_removed": "hat „{title}“ aus der Liste entfernt",
    "entry_done": "hat „{title}“ abgehakt",
    "entry_undone": "hat „{title}“ wieder geöffnet",
    "plan_created": "hat eine neue Liste angelegt ({start} – {end})",
}


def _short_date(iso: str | None) -> str:
    """2026-09-26 -> 26.09."""
    try:
        _year, month, day = (iso or "").split("-")
        return f"{day}.{month}."
    except ValueError:
        return iso or "?"


def _who(user: dict[str, Any] | None) -> str:
    user = user or {}
    return user.get("display_name") or user.get("name") or "Jemand"


@callback
def async_describe_events(
    hass: HomeAssistant,
    async_describe_event: Callable[[str, str, Callable[[Event], dict[str, str]]], None],
) -> None:
    """Describe the Meal Planner events."""

    @callback
    def _describe(event: Event) -> dict[str, str]:
        data = event.data
        kind = event.event_type.removeprefix(EVENT_PREFIX)
        plan = data.get("plan") or {}
        message = _ACTIONS[kind].format(
            title=(data.get("entry") or {}).get("title", "?"),
            start=_short_date(plan.get("start_date")),
            end=_short_date(plan.get("end_date")),
        )
        return {LOGBOOK_ENTRY_NAME: _who(data.get("user")), LOGBOOK_ENTRY_MESSAGE: message}

    for kind in EVENT_TYPES:
        async_describe_event(DOMAIN, f"{EVENT_PREFIX}{kind}", _describe)
