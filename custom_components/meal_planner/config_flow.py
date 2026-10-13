"""Config flow for Meal Planner.

Normally the add-on announces itself through Supervisor discovery (`async_step_hassio`): the user only
confirms. Manual setup (host, port, token) is the fallback. Single-instance only (one household, one
add-on). A repeated discovery (add-on restarted, reinstalled, token rotated) updates the existing entry.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .api import CannotConnect, InvalidAuth, async_fetch_state
from .const import CONF_HOST, CONF_PORT, CONF_SLUG, CONF_TOKEN, DEFAULT_PORT, DOMAIN

TITLE = "Meal Planner"


class MealPlannerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Meal Planner."""

    VERSION = 1

    _discovered: dict[str, Any]

    async def _validate(self, data: Mapping[str, Any]) -> str | None:
        """Return an error key, or None if the add-on answers with this token."""
        try:
            await async_fetch_state(self.hass, data[CONF_HOST], data[CONF_PORT], data[CONF_TOKEN])
        except InvalidAuth:
            return "invalid_auth"
        except CannotConnect:
            return "cannot_connect"
        return None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Manual setup: host, port and token of the add-on."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            error = await self._validate(user_input)
            if error is None:
                await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=TITLE, data=user_input)
            errors["base"] = error

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=(user_input or {}).get(CONF_HOST, "")): str,
                vol.Required(CONF_PORT, default=(user_input or {}).get(CONF_PORT, DEFAULT_PORT)): int,
                vol.Required(CONF_TOKEN): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """The add-on announced itself through the Supervisor."""
        config = discovery_info.config
        data = {
            CONF_HOST: config[CONF_HOST],
            CONF_PORT: config[CONF_PORT],
            CONF_TOKEN: config[CONF_TOKEN],
            CONF_SLUG: discovery_info.slug,
        }

        # Already set up (also by hand): keep the entry, follow the add-on's current address and token.
        if entries := self._async_current_entries(include_ignore=False):
            return self.async_update_reload_and_abort(
                entries[0],
                unique_id=discovery_info.uuid,
                data=data,
                reason="already_configured",
                reload_even_if_entry_is_unchanged=False,
            )

        await self.async_set_unique_id(discovery_info.uuid)
        self._abort_if_unique_id_configured(updates=data)
        self._discovered = data
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Nothing to enter: confirm that the discovered add-on is the one to use."""
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await self._validate(self._discovered)
            if error is None:
                return self.async_create_entry(title=TITLE, data=self._discovered)
            errors["base"] = error
        return self.async_show_form(step_id="hassio_confirm", errors=errors)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The add-on rejected the token (e.g. it was rotated): ask for the new one."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry: ConfigEntry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data = {**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]}
            error = await self._validate(data)
            if error is None:
                return self.async_update_reload_and_abort(entry, data=data)
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors
        )
