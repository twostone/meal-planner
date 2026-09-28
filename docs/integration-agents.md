# AGENTS.md

Anleitung für Coding-Agents und Mitwirkende. Nutzer- und Entwickler-Doku steht in der
[README](README.md); hier stehen Architektur, Konventionen und bewusste Entscheidungen.

## Projekt

Begleitende Home-Assistant-Integration für das [meal-planner](https://github.com/twostone/meal-planner)
Add-on. Bildet dessen aktuelle Liste als Entitäten ab, feuert zwei HA-Events und liefert eine
Lovelace-Karte mit aus. Grundsatz wie im Add-on-Repo: **KISS und YAGNI**.

## Architektur

- **Push-only, kein Polling:** Das Add-on ruft nach jeder Änderung der aktuellen Liste (und einmal
  beim Start) den von dieser Integration registrierten Webhook auf. Diese Integration ruft nie von
  sich aus das Add-on auf – es gibt keinen Rückkanal. Details zur Add-on-Seite (wann gepusht wird,
  warum `fetch` statt der SSRF-geschützten `fetchLimited`) stehen in dessen eigenem
  [`AGENTS.md`](https://github.com/twostone/meal-planner/blob/main/AGENTS.md).
- **Warum Webhook statt direktem API-Aufruf vom Add-on:** Das Add-on könnte über
  `homeassistant_api: true` auch ohne jede Konfiguration direkt die HA-REST-API aufrufen
  (`POST /api/events/...`, `POST /api/states/...`). Für Events wäre das unproblematisch, für
  Entitäten aber nicht: von HA als veraltet markiert (Unterstützung soll bis 2027.8 entfallen),
  keine Geräte-Zuordnung, keine `unique_id`, verschwindet bei jedem HA-Neustart bis zum nächsten
  Push. Bewusst zugunsten einer echten Integration mit „richtigen" Entitäten verworfen.
- **Webhook-Payload** (vom Add-on gesendet, siehe dessen `src/ha-notify.ts`):
  ```json
  {
    "event": "plan_created" | "entry_added" | null,
    "plan": {
      "id": 1, "start_date": "2026-09-26", "end_date": "2026-10-02",
      "entry_count": 7, "done_count": 3,
      "entries": [
        { "id": 1, "dish_id": 1, "title": "…", "note": null, "tags": [],
          "image": null, "url": null, "done": false }
      ]
    } | null
  }
  ```
  `plan` ist immer die *aktuelle* Liste, unabhängig davon, welche Liste die Aktion ausgelöst hat.
  `event` ist nur bei den zwei benannten Aktionen gesetzt; alle anderen Pushes (`event: null`)
  aktualisieren nur still den Anzeigezustand.
- **`local_only=True`** bei `webhook.async_register`: Der Webhook nimmt nur Aufrufe aus dem lokalen
  Netz an, unabhängig davon, welche URL-Form `webhook.async_generate_url` liefert. Nicht lockern.
- **Karte ohne Bilder, bewusst:** `entry.image` ist nur ein Dateiname, den das Add-on hinter seiner
  Ingress-only-API ausliefert (`api/images/<name>`). Der Browser, der die Lovelace-Karte zeigt, läuft
  im HA-Frontend, nicht im Ingress-Iframe des Add-ons, und kann diese API nicht erreichen. Ein Weg
  über die `hassio`-Ingress-Session wäre denkbar, ist aber ungeklärt (Supervisor-Token, den eine
  gewöhnliche Custom-Integration nicht hat) – siehe Karte vorerst ohne Bilder.
- **Bewusst nicht gebaut:** Bild-Anzeige in der Karte (s. o.), Schreibzugriff aus HA zurück ins
  Add-on (abhaken etc. – es gibt keinen authentifizierten Schreib-Endpunkt am Add-on), Polling/
  REST-Abfrage der Add-on-API, mehrere Instanzen (ein Haushalt, ein Add-on, eine Integration).

## Layout

```
custom_components/meal_planner/
  __init__.py       Webhook-Registrierung, Event-Feuerung, Karten-Resource-Registrierung
  config_flow.py     Einziger Schritt: generiert webhook_id, zeigt die URL an
  const.py
  sensor.py           Drei Entitäten, dispatcher-getrieben (kein Polling-Coordinator)
  manifest.json
  strings.json / translations/
  www/meal-planner-card.js   Lovelace-Karte, reine Anzeige
  brand/icon.png      Für HACS-Validierung („brands"), falls nicht in home-assistant/brands gelistet
tests/                pytest + pytest-homeassistant-custom-component
```

## Entwickeln und Testen

```
python3 -m venv .venv && .venv/bin/pip install -r requirements_test.txt
.venv/bin/python -m pytest tests -q
```

Stolpersteine, gegen die die Tests schon mal gelaufen sind (bei Änderungen im Hinterkopf behalten):

- `pyproject.toml` braucht `[tool.pytest.ini_options] asyncio_mode = "auto"` und
  `pythonpath = ["."]` – ohne Letzteres findet ein bloßes `pytest` (anders als `python -m pytest`)
  `custom_components` in CI nicht.
- Komponenten, die `__init__.py` per `hass.http`/`webhook.async_register` nutzt, müssen in
  `manifest.json` unter `dependencies` stehen (`http`, `webhook`), sonst registriert HA die
  Webhook-Route in Produktion nie – hassfest prüft das, ein lokaler Testlauf ohne echtes
  `async_setup_component(hass, "webhook", …)` deckt es nicht automatisch auf.
- `manifest.json`-Schlüssel müssen alphabetisch sortiert sein (nach `domain`, `name`), sonst
  schlägt hassfest fehl.
- HACS verlangt am Repository gesetzte Topics und entweder einen Eintrag in
  [home-assistant/brands](https://github.com/home-assistant/brands) oder lokale Assets unter
  `custom_components/meal_planner/brand/icon.png`.
- `add_extra_js_url`/`hass.http.async_register_static_paths` in Tests: `hass`-Fixture lädt weder
  `http` noch `frontend` von selbst. `http` kommt inzwischen über die deklarierte Dependency mit;
  für `frontend` reicht es, `hass.data[DATA_EXTRA_MODULE_URL]` direkt zu seeden, statt die (schwere,
  separate) `home-assistant-frontend`-Paketabhängigkeit für Tests zu installieren.

## APIs prüfen

Wie im Add-on-Repo: HA-APIs vor Nutzung gegen aktuelle Doku/Quellcode prüfen, nicht aus dem Training
raten (`webhook.async_generate_url`, `StaticPathConfig`, `add_extra_js_url`, Entity-Naming/
`has_entity_name` ändern sich zwischen HA-Versionen).

## Git und Releases

Kein Release-Please/Conventional-Commits-Zwang wie im Add-on-Repo (noch kein Release-Prozess
aufgesetzt). `version` in `manifest.json` von Hand pflegen, bei jeder inhaltlichen Änderung an der
Karte (Cache-Busting über `?v=` in `__init__.py`) mit anheben.
