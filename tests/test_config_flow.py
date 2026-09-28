"""Tests for the Meal Planner config flow."""

from homeassistant import config_entries
from homeassistant.core import HomeAssistant

from custom_components.meal_planner.const import DOMAIN


async def test_user_flow_shows_webhook_url_then_creates_entry(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] == "form"
    assert "webhook_url" in result["description_placeholders"]
    shown_url = result["description_placeholders"]["webhook_url"]

    result2 = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result2["type"] == "create_entry"
    assert result2["title"] == "Meal Planner"
    assert result2["data"]["webhook_id"]
    # the URL shown in the form must be the one that was actually stored, not a re-generated one
    assert shown_url.endswith(result2["data"]["webhook_id"])


async def test_single_instance_allowed(hass: HomeAssistant) -> None:
    first = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    await hass.config_entries.flow.async_configure(first["flow_id"], {})

    second = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert second["type"] == "abort"
    assert second["reason"] == "single_instance_allowed"
