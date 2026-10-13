"""Fixtures for Meal Planner tests."""

import pytest
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.meal_planner.const import CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN

pytest_plugins = "pytest_homeassistant_custom_component"

HOST = "abc-essensplanung"
PORT = 8100
TOKEN = "secret"
STATE_URL = f"http://{HOST}:{PORT}/ha/state"

ENTRY = {
    "id": 1,
    "dish_id": 1,
    "title": "Linsensuppe",
    "note": None,
    "tags": [],
    "image": None,
    "url": None,
    "done": False,
}
CURRENT = {
    "id": 1,
    "start_date": "2026-09-26",
    "end_date": "2026-10-02",
    "entry_count": 2,
    "done_count": 1,
    "entries": [ENTRY, {**ENTRY, "id": 2, "dish_id": 2, "title": "Pasta", "done": True}],
}
NEXT = {
    "id": 2,
    "start_date": "2026-10-03",
    "end_date": "2026-10-09",
    "entry_count": 1,
    "done_count": 0,
    "entries": [{**ENTRY, "id": 3, "dish_id": 3, "title": "Pizza"}],
}
STATE = {"current": CURRENT, "next": NEXT, "generated_at": "2026-09-29T09:00:00+00:00"}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def _frontend_registry(hass):
    # async_setup_entry registers an extra JS module on the frontend's registry, but loading the real
    # "frontend" component would need the separate, heavy home-assistant-frontend PyPI package just for
    # its data key to exist, so that registry set is seeded directly instead.
    hass.data.setdefault(DATA_EXTRA_MODULE_URL, set())


def make_entry(**overrides) -> MockConfigEntry:
    data = {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}
    return MockConfigEntry(domain=DOMAIN, data={**data, **overrides}, unique_id="uuid-1", title="Meal Planner")
