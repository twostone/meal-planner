# Meal Planner – Home Assistant Integration

Begleitende Home-Assistant-Integration für das [meal-planner](https://github.com/twostone/meal-planner)
Add-on ("Essensplanung"): zeigt die aktuelle Liste als Sensoren an, feuert HA-Events bei neuer Liste bzw.
neuem Eintrag, und bringt eine fertige Lovelace-Karte mit.

## Funktionsweise

Das Add-on **pusht** die aktuelle Liste per Webhook an diese Integration – es gibt kein Polling und keinen
Weg zurück ins Add-on (die Karte ist rein anzeigend). Details und die Gegenseite: siehe
[`AGENTS.md`](https://github.com/twostone/meal-planner/blob/main/AGENTS.md) im Add-on-Repo, Abschnitt
„Home-Assistant-Push“.

## Installation

1. Über [HACS](https://hacs.xyz/) → Integrationen → Benutzerdefinierte Repositories → dieses Repo als
   „Integration“ hinzufügen, dann „Meal Planner“ installieren. HA neu starten.
2. Einstellungen → Geräte & Dienste → Integration hinzufügen → „Meal Planner“. Der Assistent zeigt eine
   Webhook-URL an.
3. Diese URL in die Option **„Home Assistant Webhook URL“** (`ha_webhook_url`) des meal-planner-Add-ons
   eintragen und das Add-on neu starten.

Danach erscheinen drei Entitäten:

- `sensor.meal_planner_current_list` – Zustand z. B. „3 offen von 7“, Attribute `start_date`, `end_date`,
  `entries` (volle Liste: Titel, Notiz, Kategorien, Link, erledigt).
- `sensor.meal_planner_open_count`, `sensor.meal_planner_done_count` – reine Zähler.

Und zwei Events, für Automatisierungen: `meal_planner_plan_created`, `meal_planner_entry_added`.

## Lovelace-Karte

Wird automatisch als Ressource registriert (kein manueller Eintrag nötig). In einem Dashboard:

```yaml
type: custom:meal-planner-card
entity: sensor.meal_planner_current_list
```

Zeigt Titel, Notiz, Kategorien, Link und offen/erledigt – **ohne Bilder**: Vorschaubilder liegen hinter der
Ingress-only-API des Add-ons, die diese Karte (im HA-Frontend, nicht im Add-on-Iframe) nicht erreichen
kann. Nur Anzeige, keine Bearbeitung.

## Voraussetzungen

- Ein Haushalt, eine Add-on-Instanz, eine Integrations-Instanz (Single-Instance).
- Add-on und Home Assistant im selben Netz. Der Webhook selbst ist `local_only`: Home Assistant nimmt
  Aufrufe dafür nur von lokalen Adressen an, unabhängig davon, welche URL-Form angezeigt wird.

## Entwicklung

```
pip install -r requirements_test.txt
pytest
```

CI (`hassfest`, `hacs/action`) läuft bei jedem Push/PR.

## Bewusst nicht gebaut (KISS/YAGNI)

Bild-Anzeige in der Karte (siehe oben), Schreibzugriff aus HA (abhaken etc.), Polling/REST-Abfrage der
Add-on-API, mehrere Instanzen.
