# Meal Planner

[![Validate](https://github.com/twostone/ha-meal-planner/actions/workflows/validate.yml/badge.svg)](https://github.com/twostone/ha-meal-planner/actions/workflows/validate.yml)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![License](https://img.shields.io/github/license/twostone/ha-meal-planner.svg)](LICENSE)

Zeigt die aktuelle Liste des [meal-planner](https://github.com/twostone/meal-planner)-Add-ons
("Essensplanung") als Sensoren und Lovelace-Karte im Home-Assistant-Dashboard an und löst
Automatisierungen bei neuer Liste bzw. neuem Eintrag aus.

<a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=twostone&repository=ha-meal-planner&category=integration">
  <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Zu HACS hinzufügen">
</a>

## Voraussetzungen

- Das [meal-planner-Add-on](https://github.com/twostone/meal-planner) läuft bereits in derselben
  Home-Assistant-Installation.
- [HACS](https://hacs.xyz/) ist installiert.

## Installation

1. Repository-Badge oben klicken (oder manuell: HACS → Integrationen → ⋮ → Benutzerdefinierte
   Repositories → dieses Repo als „Integration" hinzufügen) und „Meal Planner" installieren.
2. Home Assistant neu starten.
3. *Einstellungen → Geräte & Dienste → Integration hinzufügen → „Meal Planner"*. Der Assistent
   zeigt eine Webhook-URL an – ohne weitere Eingabe einfach bestätigen.
4. Diese URL in die Add-on-Option **„Home Assistant Webhook URL"** (`ha_webhook_url`) eintragen und
   das Add-on neu starten.

Ab hier hält die Integration die Liste automatisch aktuell, sobald sich im Add-on etwas ändert.

## Entitäten

| Entität | Beispiel-Zustand | Attribute / Bedeutung |
|---|---|---|
| `sensor.meal_planner_current_list` | `3 offen von 7` | `start_date`, `end_date`, `entries` (Titel, Notiz, Kategorien, Link, erledigt je Gericht) |
| `sensor.meal_planner_open_count` | `3` | Anzahl offener Gerichte |
| `sensor.meal_planner_done_count` | `4` | Anzahl erledigter Gerichte |

## Events

Für Automatisierungen (*Einstellungen → Automatisierungen → Trigger → Ereignis*):

| Event | Ausgelöst durch |
|---|---|
| `meal_planner_plan_created` | Neue Liste im Add-on angelegt |
| `meal_planner_entry_added` | Neuer Eintrag zu einer Liste hinzugefügt |

## Lovelace-Karte

Wird automatisch als Dashboard-Ressource registriert, kein manueller Eintrag nötig:

```yaml
type: custom:meal-planner-card
entity: sensor.meal_planner_current_list
```

Zeigt Titel, Notiz, Kategorien, Link sowie offen/erledigt an. Reine Anzeige (kein Abhaken aus der
Karte heraus) und ohne Vorschaubilder.

## Entwicklung

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements_test.txt
.venv/bin/python -m pytest tests -q
```

Architektur, Payload-Format und bewusste Entscheidungen stehen in [`AGENTS.md`](AGENTS.md).

## Lizenz

[Apache License 2.0](LICENSE)
