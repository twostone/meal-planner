"""Tests for the logbook descriptions."""

import pytest
from homeassistant.core import Event

from custom_components.meal_planner.const import EVENT_PREFIX, EVENT_TYPES
from custom_components.meal_planner.logbook import async_describe_events

PLAN = {"id": 1, "start_date": "2026-09-26", "end_date": "2026-10-02"}
ENTRY = {"id": 1, "dish_id": 1, "title": "Pasta"}
ANNA = {"id": "u", "name": "anna", "display_name": "Anna"}
# plan_updated carries the new values in `plan` (with title) and the old ones in `previous`.
PREVIOUS = {"start_date": "2026-09-26", "end_date": "2026-10-02", "title": None}


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


def test_plan_updated_rename():
    plan = {**PLAN, "title": "Geburtstagswoche"}
    out = describe("plan_updated", {"plan": plan, "previous": PREVIOUS, "user": ANNA})
    assert out == {"name": "Anna", "message": "hat die Liste in „Geburtstagswoche“ umbenannt"}


def test_plan_updated_name_removed():
    previous = {**PREVIOUS, "title": "Alt"}
    out = describe("plan_updated", {"plan": {**PLAN, "title": None}, "previous": previous, "user": ANNA})
    assert out["message"] == "hat den Namen der Liste entfernt"


def test_plan_updated_period_shows_old_and_new():
    plan = {"id": 1, "start_date": "2026-09-27", "end_date": "2026-10-03", "title": None}
    out = describe("plan_updated", {"plan": plan, "previous": PREVIOUS, "user": ANNA})
    assert out["message"] == "hat den Zeitraum von 26.09. – 02.10. auf 27.09. – 03.10. geändert"


def test_plan_updated_name_and_period_in_one_sentence():
    plan = {"id": 1, "start_date": "2026-09-27", "end_date": "2026-10-03", "title": "Gäste"}
    out = describe("plan_updated", {"plan": plan, "previous": PREVIOUS, "user": ANNA})
    assert out["message"] == (
        "hat die Liste in „Gäste“ umbenannt und den Zeitraum von 26.09. – 02.10. auf 27.09. – 03.10. geändert"
    )


def test_without_a_user_it_is_someone():
    assert describe("entry_done", {"plan": PLAN, "entry": ENTRY, "user": None})["name"] == "Jemand"
    assert describe("entry_done", {"plan": PLAN, "entry": ENTRY})["name"] == "Jemand"


def test_odd_data_does_not_raise():
    out = describe("plan_created", {})
    assert out["message"] == "hat eine neue Liste angelegt (? – ?)"
    assert describe("plan_updated", {})["message"] == "hat die Liste geändert"
