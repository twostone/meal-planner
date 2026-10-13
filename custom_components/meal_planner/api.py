"""Client for the add-on's read-only state endpoint (`GET /ha/state`, Bearer token)."""

from __future__ import annotations

from typing import Any

from aiohttp import ClientError, ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

TIMEOUT = ClientTimeout(total=10)


class CannotConnect(Exception):
    """The add-on could not be reached (stopped, wrong host/port, network)."""


class InvalidAuth(Exception):
    """The add-on rejected the token."""


async def async_fetch_state(hass: HomeAssistant, host: str, port: int, token: str) -> dict[str, Any]:
    """Return `{current, next, generated_at}`; raise CannotConnect or InvalidAuth."""
    session = async_get_clientsession(hass)
    try:
        resp = await session.get(
            f"http://{host}:{port}/ha/state",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT,
        )
        if resp.status == 401:
            raise InvalidAuth
        resp.raise_for_status()
        return await resp.json()
    except (ClientError, TimeoutError, ValueError) as err:
        raise CannotConnect(str(err)) from err
