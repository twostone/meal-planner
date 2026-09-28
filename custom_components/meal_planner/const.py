"""Constants for the Meal Planner integration."""

DOMAIN = "meal_planner"
VERSION = "0.1.0"

PLATFORMS = ["sensor"]

# Dispatcher signal fired (per config entry) whenever a webhook push updates the stored plan.
SIGNAL_UPDATE = f"{DOMAIN}_update"

# Bus events, fired only when the add-on's webhook payload carries that event name.
EVENT_PLAN_CREATED = "meal_planner_plan_created"
EVENT_ENTRY_ADDED = "meal_planner_entry_added"
