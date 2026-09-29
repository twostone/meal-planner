"""Tests for the logbook descriptions."""

import pytest
from homeassistant.core import Event

from custom_components.meal_planner.const import EVENT_PREFIX, EVENT_TYPES
from custom_components.meal_planner.logbook import async_describe_events

PLAN = {"id": 1, "start_date": "2026-09-26", "end_date": "2026-10-02"}
ENTRY = {"id": 1, "dish_id": 1, "title": "Pasta"}


def describe(kind, data):
    registered = {}
    async_describe_events(None, lambda domain, event_type, cb: registered.update({event_type: (domain, cb)}))
    assert set(registered) == {f"{EVENT_PREFIX}{k}" for k in EVENT_TYPES}
    _domain, cb = registered[f"{EVENT_PREFIX}{kind}"]
    return cb(Event(f"{EVENT_PREFIX}{kind}", data))


@pytest.mark.parametrize(
    ("kind", "message"),
    [
        ("entry_added", "hat „Pasta“ zur Liste hinzugefügt"),
        ("entry_removed", "hat „Pasta“ aus der Liste entfernt"),
        ("entry_done", "hat „Pasta“ abgehakt"),
        ("entry_undone", "hat „Pasta“ wieder geöffnet"),
    ],
)
def test_entry_events_name_the_user_and_the_dish(kind, message):
    out = describe(kind, {"plan": PLAN, "entry": ENTRY, "user": {"id": "u", "name": "anna", "display_name": "Anna"}})
    assert out == {"name": "Anna", "message": message}


def test_plan_created_shows_the_period():
    out = describe("plan_created", {"plan": PLAN, "user": {"id": "u", "name": "anna", "display_name": None}})
    assert out == {"name": "anna", "message": "hat eine neue Liste angelegt (26.09. – 02.10.)"}


def test_without_a_user_it_is_someone():
    assert describe("entry_done", {"plan": PLAN, "entry": ENTRY, "user": None})["name"] == "Jemand"
    assert describe("entry_done", {"plan": PLAN, "entry": ENTRY})["name"] == "Jemand"


def test_odd_data_does_not_raise():
    out = describe("plan_created", {})
    assert out["message"] == "hat eine neue Liste angelegt (? – ?)"
