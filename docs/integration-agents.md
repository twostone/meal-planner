# AGENTS.md

Anleitung für Coding-Agents und Mitwirkende. Nutzer- und Entwickler-Doku steht in der
[README](README.md); hier stehen Architektur, Konventionen und bewusste Entscheidungen.

## Projekt

Begleitende Home-Assistant-Integration für das [meal-planner](https://github.com/twostone/meal-planner)
Add-on. Bildet dessen aktuelle und nächste Liste als Entitäten ab, beschreibt dessen Events im Logbuch
und liefert eine Lovelace-Karte mit aus. Grundsatz wie im Add-on-Repo: **KISS und YAGNI**.

## Architektur

- **Abruf mit Push-Anstoß (`local_polling`):** Das Add-on bietet auf einem zweiten Port (8100) genau eine Route,
  `GET /ha/state` mit Bearer-Token, Antwort `{current, next, generated_at}`. `coordinator.py` holt sie alle
  5 Minuten (`UPDATE_INTERVAL`, nur Sicherheitsnetz für Datumswechsel und Neustarts) und sofort, wenn das Add-on
  eines seiner Bus-Events feuert. „Aktuell“/„nächste“ bestimmt das Add-on bei jedem Abruf aus dem Datum. Diese
  Integration schreibt nie ins Add-on zurück. Details zur Add-on-Seite (Token, Events, Discovery, warum `fetch`
  statt `fetchLimited`) stehen in dessen [`AGENTS.md`](https://github.com/twostone/meal-planner/blob/main/AGENTS.md).
- **Einrichtung per Supervisor-Discovery:** Das Add-on meldet `{host, port, token}` unter dem Dienstnamen
  `meal_planner` (= Domain dieser Integration, das ist Voraussetzung: Core startet den Flow mit `service` als
  Handler). `async_step_hassio` fragt nur nach Bestätigung. Gibt es schon einen Eintrag (auch einen manuell
  angelegten), wird er aktualisiert (Host, Port, Token, `unique_id` = neue Discovery-UUID) statt einen zweiten
  anzulegen; `reload_even_if_entry_is_unchanged=False`, weil die Meldung bei jedem Start des Add-ons kommt.
  Fallback: Schritt `user` mit Host, Port, Token und Verbindungstest. Ein abgelehntes Token (401) startet Reauth.
- **Events:** Das Add-on feuert sie über die Core-API des Supervisors, diese Integration feuert nichts selbst.
  `meal_planner_plan_created|entry_added|entry_removed|entry_done|entry_undone`, Daten `plan`, `entry` (außer bei
  `plan_created`), `user {id, name, display_name}` oder `null`. `logbook.py` beschreibt sie
  („Anna hat „Pasta“ abgehakt“, Rückfall auf Benutzername, dann „Jemand“). Ein verlorenes Event wird nicht
  nachgeholt, der Zustand kommt beim nächsten Abruf.
- **Karte ohne Bilder, bewusst:** `entry.image` ist nur ein Dateiname, den das Add-on hinter seiner
  Ingress-only-API ausliefert (`api/images/<name>`). Der Browser, der die Lovelace-Karte zeigt, läuft
  im HA-Frontend, nicht im Ingress-Iframe des Add-ons, und kann diese API nicht erreichen. Ein Weg
  über die `hassio`-Ingress-Session wäre denkbar, ist aber ungeklärt (Supervisor-Token, den eine
  gewöhnliche Custom-Integration nicht hat) – siehe Karte vorerst ohne Bilder.
- **Bewusst nicht gebaut:** Bild-Anzeige in der Karte (s. o.), Schreibzugriff aus HA zurück ins
  Add-on (abhaken etc. – es gibt keinen authentifizierten Schreib-Endpunkt am Add-on), mehrere Instanzen
  (ein Haushalt, ein Add-on, eine Integration), Migration alter Webhook-Einträge (nie am echten System betrieben).
- **Nicht am echten System geprüft:** Discovery, Erreichbarkeit des Add-on-Ports von Core aus und der Event-Weg
  (siehe Phase 0 im Umbauplan des Add-on-Repos, `docs/umbauplan-ha-integration.md`).

## Layout

```
custom_components/meal_planner/
  __init__.py       Einrichtung, Event-Anstoß für den Coordinator, Karten-Resource-Registrierung
  api.py            Abruf von /ha/state (CannotConnect, InvalidAuth)
  coordinator.py    DataUpdateCoordinator (Intervall + Refresh bei Events)
  config_flow.py    Discovery (hassio), manuell (user), Reauth
  logbook.py        Beschreibung der Events im Logbuch
  const.py
  sensor.py         Vier Entitäten (aktuelle/nächste Liste, offen, erledigt), CoordinatorEntity
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
- Komponenten, die `__init__.py` per `hass.http` nutzt, müssen in `manifest.json` unter `dependencies`
  stehen (`http`), sonst registriert HA die Route in Produktion nie – hassfest prüft das.
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
raten (`async_update_reload_and_abort`, `HassioServiceInfo`, `StaticPathConfig`, `add_extra_js_url`, Entity-Naming/
`has_entity_name` ändern sich zwischen HA-Versionen).

## Git und Releases

Kein Release-Please/Conventional-Commits-Zwang wie im Add-on-Repo (noch kein Release-Prozess
aufgesetzt). `version` in `manifest.json` von Hand pflegen, bei jeder inhaltlichen Änderung an der
Karte (Cache-Busting über `?v=` in `__init__.py`) mit anheben.
