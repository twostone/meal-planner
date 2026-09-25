# AGENTS.md

Anleitung für Coding-Agents und Mitwirkende. Kurz halten, bei Änderungen an Architektur oder Regeln mitpflegen.

## Projekt

Essensplanung für einen Haushalt als Home-Assistant-Add-on (Ingress). Eine gemeinsame Liste pro Zeitraum (z. B. Sa–Fr),
ein Katalog aller bisherigen Gerichte mit Rezept-Link, Autocomplete beim Eintragen. Grundsatz: **KISS und YAGNI**.
Nichts bauen, was nicht ausdrücklich gebraucht wird.

## Layout

```
repository.yaml          HA-Add-on-Repository
README.md                Installation (privates Repo mit Token-URL), Updates
AGENTS.md                diese Datei
meal-planner/            das Add-on (Docker-Build-Kontext)
  config.yaml            Add-on-Konfiguration (version!)
  Dockerfile             node:22-alpine, Build läuft auf dem HA-Gerät
  src/                   Backend: Hono + node:sqlite (db.ts, repo.ts, app.ts, server.ts)
  web/                   Frontend: Svelte 5 + Vite (Runes, TypeScript)
  test/                  API-Tests (node:test)
```

Der Ordner heißt `meal-planner/`, der **Slug** des Add-ons in `config.yaml` ist weiterhin `essensplanung`. Home Assistant
identifiziert das Add-on über den Slug, nicht über den Ordnernamen. Den Slug nicht ändern, sonst gilt es als neues Add-on
und die Daten in `/data` gehen für die neue Installation verloren.

## Befehle (in `meal-planner/`)

```
npm ci
npm test                          # API-Tests
npx tsc --noEmit                  # Typprüfung Backend
npm run check                     # svelte-check Frontend
npm run build                     # Frontend nach dist/ (wird vom Server ausgeliefert)
DB_PATH=./data/dev.db PORT=8099 npm start
npm run dev:web                   # Vite-Dev-Server, /api geht per Proxy an :8099
```

Vor jedem Commit: Tests, `tsc`, `check` und `build` müssen sauber durchlaufen.

## Architektur und bewusste Entscheidungen

- **Datenmodell:** `dish` (Katalog), `plan` (Zeitraum, Start/Ende), `plan_entry` (Gericht in Zeitraum, `done`).
  Bewusst **keine Tageszuordnung** und keine manuelle Reihenfolge per Drag.
- Ein Gericht kann pro Zeitraum nur einmal vorkommen. Der Titel ist im Katalog eindeutig (ohne Groß-/Kleinschreibung).
  Ein Eintrag per Titel legt das Gericht an oder verwendet ein vorhandenes wieder. Löschen eines Gerichts, das noch
  in einer Liste steht, ist absichtlich gesperrt (409).
- SQLite `NOCASE` gilt nur für ASCII. Für die Anzeige-Sortierung (Umlaute) wird im Frontend `localeCompare("de")` genutzt.
- **Anmeldung:** nur über HA-Ingress. Kein OAuth, keine eigene Nutzerverwaltung, keine installierbare PWA und kein
  Web Share Target (beides bräuchte einen eigenen Origin, Ingress läuft im iframe unter dem HA-Origin).
  Der HA-Nutzer (`X-Remote-User-*`) ist rein informativ (`/api/me`), die Liste ist gemeinsam.
- **Links:** nur `http(s)` (Server prüft, sonst 400). Kein automatisches Abrufen von Titeln oder Vorschaubildern
  (Instagram blockiert das).
- **Keine externen Anfragen** aus der App: Schriften sind lokal eingebunden (`@fontsource-variable`), nichts von Google.

## Sicherheit

- Der Server nimmt im Add-on nur Verbindungen von `172.30.32.2` (Supervisor-Ingress) an (`INGRESS_ONLY_IP`, im
  Dockerfile gesetzt). Ohne Verbindungsinfo wird abgelehnt (fail closed). Ohne die Sperre wären die `X-Remote-User-*`-Header
  fälschbar. Nicht lockern und nicht entfernen.
- Neue Ports oder `host_network` nicht ohne Rückfrage freigeben.

## Regeln beim Ändern

- **Frontend-URLs immer relativ** (`api/plans`, Vite `base: "./"`), nie `/api/...`. Die App läuft unter einem wechselnden
  Ingress-Präfix.
- **`version` in `meal-planner/config.yaml` bei jeder auslieferbaren Änderung erhöhen**, sonst zeigt HA kein Update.
- **Add-on-Build:** Kein `build.yaml`, kein `BUILD_FROM` (beides gilt seit Supervisor 2026.04 nicht mehr). Es gibt kein
  vorgebautes Image (`image` fehlt in `config.yaml` absichtlich, HA baut lokal).
- `node:sqlite` ist unter Node 22 noch experimentell. Der gesamte DB-Zugriff bleibt in `src/db.ts` und `src/repo.ts`,
  damit ein Wechsel (z. B. `better-sqlite3`) klein bleibt.
- **TypeScript 6 ist gepinnt**, weil `svelte-check` TypeScript 7 noch nicht unterstützt. Erst umstellen, wenn es geht.
- `tsx` ist absichtlich eine Runtime-Dependency (der Server läuft im Container per `node --import tsx`).
- Sheets nutzen das native `<dialog>`. Kein `alert()`/`confirm()` (in der HA-Companion-App unzuverlässig), stattdessen
  zweistufige Bestätigung im UI.
- **APIs und Schnittstellen vor der Nutzung gegen die aktuelle Dokumentation prüfen** (HA-Add-on-Konfiguration, Hono,
  Svelte, Vite, Node). HA nennt Add-ons inzwischen „Apps“.
- Neue Backend-Logik bekommt Tests in `test/` (`app.request(...)` mit `node:test`). Bei UI-Änderungen zusätzlich im
  Browser bei 390 px Breite prüfen.
- UI-Texte deutsch, Code und Kommentare englisch. Bedienelemente mindestens 44 px, echte `<button>`/`<a>`.

## Bewusst nicht gebaut (nur auf ausdrücklichen Wunsch)

Einkaufsliste/Zutaten, Anbindung an HA-Todo/Kalender, Tageszuordnung, Drag-and-Drop, OAuth, Titel-Scraping,
Vorschaubilder, vorgebautes Image über GitHub Actions.

## Stand und offene Punkte

- Der Docker-Build lief in der Entwicklungsumgebung nie (Container-Registries dort gesperrt), dort wurden nur die
  einzelnen Schritte nachgestellt. Das Add-on wurde vom Nutzer aus dem privaten Repository in Home Assistant installiert.
  Ob es dort wie erwartet startet und angezeigt wird, ist hier nicht festgehalten.
- Ob HA-Ingress die `X-Remote-User-*`-Header wirklich liefert, ist gegen die Doku, aber nicht am echten System geprüft.
- Kein Dunkelmodus (HA-Theme dunkel, App bleibt hell).

## Git

Kurze deutsche Commit-Nachrichten, das „Warum“ zuerst. Kein Force-Push auf `main`.
