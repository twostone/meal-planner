"""Config flow for Meal Planner.

Single step, no credentials: generates a webhook and shows its URL so the user can paste it
into the meal-planner add-on's `ha_webhook_url` option. Single-instance only (one household,
one add-on).
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.components import webhook
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN


class MealPlannerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Meal Planner."""

    VERSION = 1

    # Generated once per flow attempt and reused across async_step_user calls, so the URL
    # shown to the user is the same one that ends up stored in the config entry.
    _webhook_id: str | None = None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Show the webhook URL to configure in the add-on, then create the entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if self._webhook_id is None:
            self._webhook_id = webhook.async_generate_id()

        if user_input is not None:
            return self.async_create_entry(title="Meal Planner", data={"webhook_id": self._webhook_id})

        webhook_url = webhook.async_generate_url(self.hass, self._webhook_id)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({}),
            description_placeholders={"webhook_url": webhook_url},
        )
