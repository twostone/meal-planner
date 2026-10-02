# Meal Planner

<img src="custom_components/meal_planner/brand/icon.png" alt="Meal Planner" width="96" align="right">

[![Validate](https://github.com/twostone/ha-meal-planner/actions/workflows/validate.yml/badge.svg)](https://github.com/twostone/ha-meal-planner/actions/workflows/validate.yml)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![License](https://img.shields.io/github/license/twostone/ha-meal-planner.svg)](LICENSE)

Zeigt die aktuelle Liste des [meal-planner](https://github.com/twostone/meal-planner)-Add-ons
("Essensplanung") als Sensoren und Lovelace-Karte im Home-Assistant-Dashboard an, zeigt auch die nächste
Liste, schreibt Änderungen ins Logbuch und löst Automatisierungen aus (neue Liste, Liste umbenannt oder
verschoben, Gericht hinzugefügt, entfernt, abgehakt), jeweils mit dem Nutzer, der es getan hat.

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
3. Die Meal-Planner-App (mindestens die Version mit Discovery) starten oder neu starten. Home Assistant zeigt
   unter *Einstellungen → Geräte & Dienste* eine erkannte Integration „Meal Planner“: *Konfigurieren* und
   bestätigen. Das war es.

Fällt die Erkennung aus, geht es von Hand: *Integration hinzufügen → „Meal Planner“*, Host (Hostname der App,
steht in deren Info-Seite), Port `8100` und das Token aus der Datei `/data/ha-token` der App eintragen.
Wurde das Token in der App erneuert (Datei löschen, App neu starten), aktualisiert die Erkennung es von selbst;
sonst fragt Home Assistant nach dem neuen Token.

Die Liste wird alle 5 Minuten und bei jeder Änderung in der App aktualisiert. Ist die App gestoppt, sind die
Entitäten „nicht verfügbar“.

## Entitäten

| Entität | Beispiel-Zustand | Attribute / Bedeutung |
|---|---|---|
| `sensor.meal_planner_current_list` | `3 offen von 7` | Liste, die heute enthält: `title` (Name der Liste, sonst `null`), `start_date`, `end_date`, `entries` (Titel, Notiz, Kategorien, Link, erledigt je Gericht) |
| `sensor.meal_planner_next_list` | `5 Gerichte` | frühste Liste, die nach heute beginnt, gleiche Attribute |
| `sensor.meal_planner_open_count` | `3` | Anzahl offener Gerichte der aktuellen Liste |
| `sensor.meal_planner_done_count` | `4` | Anzahl erledigter Gerichte der aktuellen Liste |

Liegt heute in keiner Liste, ist die aktuelle Liste „Keine Liste“. Das Attribut `title` gibt es erst mit einer App-Version,
die Listen-Namen kennt; mit einer älteren ist es immer `null`.

## Events

Für Automatisierungen (*Einstellungen → Automatisierungen → Trigger → Ereignis*). Alle Events stehen auch im Logbuch.

| Event | Ausgelöst durch |
|---|---|
| `meal_planner_plan_created` | Neue Liste angelegt |
| `meal_planner_plan_updated` | Name oder Zeitraum einer Liste geändert |
| `meal_planner_entry_added` | Gericht zu einer Liste hinzugefügt |
| `meal_planner_entry_removed` | Gericht aus einer Liste entfernt |
| `meal_planner_entry_done` | Gericht abgehakt |
| `meal_planner_entry_undone` | Gericht wieder geöffnet |

Eventdaten: `plan` (`id`, `start_date`, `end_date`; bei `plan_updated` zusätzlich `title`), `previous` (`start_date`,
`end_date`, `title` vor der Änderung; nur bei `plan_updated`), `entry` (`id`, `dish_id`, `title`; nur bei den
`entry_*`-Events) und `user` (`id` = Home-Assistant-Nutzer-ID, `name`, `display_name`; `null`, wenn die App den Nutzer
nicht kennt), z. B. `{{ trigger.event.data.user.display_name }}`. Details aus den Eventdaten lesen, nicht aus den
Sensoren: die ziehen einen Moment nach.

## Lovelace-Karte

Wird automatisch als Dashboard-Ressource registriert, kein manueller Eintrag nötig (bei Dashboards im YAML-Modus
lädt sie stattdessen als Extra-Modul; tritt dort in der Companion App „Konfigurationsfehler“ auf, den Eintrag
`/meal_planner/meal-planner-card.js` als JavaScript-Modul unter `lovelace: resources:` ergänzen):

```yaml
type: custom:meal-planner-card
entity: sensor.meal_planner_current_list
next_entity: sensor.meal_planner_next_list   # optional, das ist der Standard
title: Essensplanung                          # optional
show_next: true                               # optional: nächste Liste anzeigen
show_done: true                               # optional: gekochte Gerichte anzeigen
app_url: /<slug>               # optional: überschreibt den automatischen Link
```

Die Karte zeigt oben rechts „App öffnen ↗“ zur Oberfläche der App. Der Link kommt automatisch aus der
Einrichtung per Discovery (auch als „Besuchen“-Link am Gerät); bei manueller Einrichtung gibt es ihn nur,
wenn `app_url` gesetzt ist.

Die Karte lässt sich auch ohne YAML im Dashboard-Editor konfigurieren; im „Karte hinzufügen“-Dialog
erscheint sie mit Vorschau (mit Beispieldaten, solange die Sensoren noch fehlen).

Zeigt Titel, Notiz, Kategorien, Link sowie offen/erledigt der aktuellen Liste und darunter die nächste Liste an. Hat eine
Liste einen Namen, steht er vor dem Zeitraum. Reine Anzeige (kein Abhaken aus der Karte heraus) und ohne Vorschaubilder.

## Entwicklung

```bash
uv run pytest tests -q
```

Architektur und bewusste Entscheidungen stehen in [`AGENTS.md`](AGENTS.md).

Releases entstehen automatisch: Commits nach [Conventional Commits](https://www.conventionalcommits.org/)
schreiben, den von Release-Please gepflegten Release-PR mergen – Tag und GitHub-Release folgen.

## Lizenz

[Apache License 2.0](LICENSE)
