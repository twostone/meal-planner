"""Constants for the Meal Planner integration."""

from datetime import timedelta

DOMAIN = "meal_planner"
VERSION = "1.2.2"  # x-release-please-version

PLATFORMS = ["sensor"]

CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"
CONF_SLUG = "slug"  # add-on slug from Supervisor discovery, builds the Ingress path (optional)
DEFAULT_PORT = 8100

# Safety net only: the add-on fires a bus event on every relevant change, which triggers an
# immediate refresh. The interval also covers the date rolling over at midnight and a restarted add-on.
UPDATE_INTERVAL = timedelta(minutes=5)

# Bus events fired by the add-on (through the Supervisor's Core API proxy), not by this integration.
EVENT_TYPES = ("plan_created", "entry_added", "entry_removed", "entry_done", "entry_undone")
EVENT_PREFIX = f"{DOMAIN}_"
