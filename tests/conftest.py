"""Fixtures for Meal Planner tests."""

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def _configured_internal_url(hass):
    # webhook.async_generate_url() needs *some* URL to build on; outside a real HTTP request
    # (which is all a unit test is) HA falls back to config.internal_url. A placeholder hostname,
    # not a real user's address.
    hass.config.internal_url = "http://homeassistant.local:8123"
