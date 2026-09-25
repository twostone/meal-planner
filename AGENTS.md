# AGENTS.md

Anleitung für Coding-Agents und Mitwirkende. Kurz halten, bei Änderungen an Architektur oder Regeln mitpflegen.

## Projekt

Essensplanung für einen Haushalt als Home-Assistant-Add-on (Ingress). Eine gemeinsame Liste pro Zeitraum (z. B. Sa–Fr),
ein Katalog aller bisherigen Gerichte mit Rezept-Link, Autocomplete beim Eintragen. Aus einem Link holt der Server Titel
und Vorschaubild. Grundsatz: **KISS und YAGNI**. Nichts bauen, was nicht ausdrücklich gebraucht wird.

## Layout

```
repository.yaml          HA-Add-on-Repository
README.md                Installation (privates Repo mit Token-URL), Updates
AGENTS.md                diese Datei
meal-planner/            das Add-on (Docker-Build-Kontext)
  config.yaml            Add-on-Konfiguration (version!)
  Dockerfile             node:22-alpine, Build läuft auf dem HA-Gerät
  src/                   Backend: Hono + node:sqlite
    db.ts, repo.ts         Datenbank (Migrationen) und Zugriff
    app.ts, server.ts      API, Ingress-Sperre, Start
    net-guard.ts           Adress-Sperre (SSRF)
    safe-fetch.ts          der einzige Weg, fremde URLs abzurufen
    preview.ts             Titel und Bild aus HTML (og:-Tags, schema.org-Rezept)
    images.ts              Bildspeicher (/data/images, Dateiname = Hash)
  web/                   Frontend: Svelte 5 + Vite (Runes, TypeScript)
  test/                  Tests (node:test)
```

Der Ordner heißt `meal-planner/`, der **Slug** des Add-ons in `config.yaml` ist weiterhin `essensplanung`. Home Assistant
identifiziert das Add-on über den Slug, nicht über den Ordnernamen. Den Slug nicht ändern, sonst gilt es als neues Add-on
und die Daten in `/data` gehen für die neue Installation verloren.

## Befehle (in `meal-planner/`)

```
npm ci
npm test                          # alle Tests
npx tsc --noEmit                  # Typprüfung Backend
npm run check                     # svelte-check Frontend
npm run build                     # Frontend nach dist/ (wird vom Server ausgeliefert)
DB_PATH=./data/dev.db PORT=8099 npm start
npm run dev:web                   # Vite-Dev-Server, /api geht per Proxy an :8099
```

Vor jedem Commit: Tests, `tsc`, `check` und `build` müssen sauber durchlaufen.

## Architektur und bewusste Entscheidungen

- **Datenmodell:** `dish` (Katalog, mit `url`, `note`, `image`), `plan` (Zeitraum, Start/Ende), `plan_entry` (Gericht in
  Zeitraum, `done`). Bewusst **keine Tageszuordnung** und keine manuelle Reihenfolge per Drag.
- Ein Gericht kann pro Zeitraum nur einmal vorkommen. Der Titel ist im Katalog eindeutig (ohne Groß-/Kleinschreibung).
  Ein Eintrag per Titel legt das Gericht an oder verwendet ein vorhandenes wieder. Löschen eines Gerichts, das noch
  in einer Liste steht, ist absichtlich gesperrt (409).
- SQLite `NOCASE` gilt nur für ASCII. Für die Anzeige-Sortierung (Umlaute) wird im Frontend `localeCompare("de")` genutzt.
- **Anmeldung:** nur über HA-Ingress. Kein OAuth, keine eigene Nutzerverwaltung, keine installierbare PWA und kein
  Web Share Target (beides bräuchte einen eigenen Origin, Ingress läuft im iframe unter dem HA-Origin).
  Der HA-Nutzer (`X-Remote-User-*`) ist rein informativ (`/api/me`), die Liste ist gemeinsam.
- **Links:** nur `http(s)` (Server prüft, sonst 400).
- **Link-Vorschau:** `POST api/preview {url}` ruft die Seite serverseitig ab und liefert `{title, image, reason}`. Der Titel
  kommt aus dem schema.org-Rezept (sauberster Name), sonst `og:title` (ohne Seitennamen-Suffix), sonst `<title>`. Das Bild
  kommt aus `og:image`, sonst aus dem Rezept. Login- und Bot-Prüfseiten („Login • Instagram“, „Just a moment...“) ergeben
  keinen Titel. Eine Vorschau darf nie etwas blockieren: jeder Fehler wird zu `{title: null, image: null, reason}`,
  der Nutzer trägt den Titel dann selbst ein. Ein getippter Titel wird nie überschrieben.
- **Bilder** lädt der Server einmal herunter und speichert sie unter `/data/images/<hash>.<ext>` (max. 3 MB, kein SVG,
  Typ nach den Datei-Bytes). Nie fremde Bild-URLs im Frontend einbinden (Adressen, besonders bei Instagram, laufen ab,
  und der Browser würde Drittserver anfragen). Nicht mehr verwendete Dateien räumt `ImageStore.sweep` auf (Dateien unter
  einer Stunde bleiben, damit Vorschauen vor dem Speichern nicht verschwinden).
- **Instagram:** nur der allgemeine Abruf, ohne eigene Behandlung. Die oEmbed-Schnittstelle (seit 15.06.2026 ohne Token) ist
  nicht eingebaut: das Antwortformat ohne Token ist ungeprüft, und Metas Bedingungen verbieten das Speichern der
  Metadaten. Vor einem Einbau am echten Gerät testen und die Bedingungen erneut lesen.
- **Keine externen Anfragen aus dem Browser:** Schriften sind lokal eingebunden (`@fontsource-variable`), Bilder kommen
  vom eigenen Server. Extern ruft nur der Server ab, und nur Links, die der Nutzer eingegeben hat.

## Sicherheit

- Der Server nimmt im Add-on nur Verbindungen von `172.30.32.2` (Supervisor-Ingress) an (`INGRESS_ONLY_IP`, im
  Dockerfile gesetzt). Ohne Verbindungsinfo wird abgelehnt (fail closed). Ohne die Sperre wären die `X-Remote-User-*`-Header
  fälschbar. Nicht lockern und nicht entfernen.
- **SSRF:** Der Server steht im Heimnetz neben Home Assistant, Router und anderen Add-ons. Fremde URLs werden
  **ausschließlich über `fetchLimited` (`src/safe-fetch.ts`)** abgerufen, nie direkt mit `fetch`/`http.get`. Das erzwingt:
  nur `http(s)`, nur Port 80/443, keine Zugangsdaten in der URL, keine privaten/internen Adressen (`net-guard.ts`), die
  Prüfung beim Verbinden (gegen DNS-Rebinding) und bei jeder Weiterleitung, höchstens 4 Weiterleitungen, 8 s Gesamtzeit,
  Größenlimit nach dem Entpacken (gegen Zip-Bomben). Nicht lockern.
- `allowPrivate` in `fetchLimited` ist **nur für Tests** (lokaler Testserver auf 127.0.0.1). Nie im Produktivcode setzen,
  nie über eine Umgebungsvariable oder Konfiguration erreichbar machen.
- Änderungen an `net-guard.ts` mit Vorsicht: Node prüft IPv4-Adressen als IPv4-gemappte IPv6-Adressen, eine Regel für
  `::ffff:0:0/96` würde daher **jede** IPv4-Adresse sperren (der Test `isPublicIp` fängt das).
- Bildnamen kommen nur aus dem Bildspeicher (Hash + Endung, geprüft per `IMAGE_NAME`), nie Pfade vom Client.
  Ausgeliefert wird mit `nosniff` und `Content-Security-Policy: default-src 'none'`.
- Neue Ports oder `host_network` nicht ohne Rückfrage freigeben.

## Regeln beim Ändern

- **Frontend-URLs immer relativ** (`api/plans`, `api/images/...`, Vite `base: "./"`), nie `/api/...`. Die App läuft unter
  einem wechselnden Ingress-Präfix.
- **`version` in `meal-planner/config.yaml` bei jeder auslieferbaren Änderung erhöhen**, sonst zeigt HA kein Update.
- **Datenbank nur über Migrationen ändern:** in `src/db.ts` einen Eintrag an `MIGRATIONS` **anhängen**, nie ändern oder
  umsortieren (`PRAGMA user_version` zählt sie). Neue Migrationen mit einem Test gegen eine Datenbank im alten Stand.
- **Add-on-Build:** Kein `build.yaml`, kein `BUILD_FROM` (beides gilt seit Supervisor 2026.04 nicht mehr). Es gibt kein
  vorgebautes Image (`image` fehlt in `config.yaml` absichtlich, HA baut lokal).
- `node:sqlite` ist unter Node 22 noch experimentell. Der gesamte DB-Zugriff bleibt in `src/db.ts` und `src/repo.ts`,
  damit ein Wechsel (z. B. `better-sqlite3`) klein bleibt.
- **TypeScript 6 ist gepinnt**, weil `svelte-check` TypeScript 7 noch nicht unterstützt. Erst umstellen, wenn es geht.
- `tsx` ist absichtlich eine Runtime-Dependency (der Server läuft im Container per `node --import tsx`).
- Neue Abhängigkeiten nur mit Grund: jede ändert `package-lock.json` und damit den Build auf dem HA-Gerät.
  Die Link-Vorschau kommt bewusst ohne HTML-Parser-Bibliothek und ohne Bildverarbeitung (`sharp`) aus.
- Sheets nutzen das native `<dialog>`. Kein `alert()`/`confirm()` (in der HA-Companion-App unzuverlässig), stattdessen
  zweistufige Bestätigung im UI.
- **APIs und Schnittstellen vor der Nutzung gegen die aktuelle Dokumentation prüfen** (HA-Add-on-Konfiguration, Hono,
  Svelte, Vite, Node). HA nennt Add-ons inzwischen „Apps“.
- Neue Backend-Logik bekommt Tests in `test/` (`app.request(...)` mit `node:test`). Für Netzwerkcode gilt: gegen einen
  lokalen Testserver testen, nie gegen das Internet. Bei UI-Änderungen zusätzlich im Browser bei 390 px Breite prüfen.
- UI-Texte deutsch, Code und Kommentare englisch. Bedienelemente mindestens 44 px, echte `<button>`/`<a>`.

## Bewusst nicht gebaut (nur auf ausdrücklichen Wunsch)

Einkaufsliste/Zutaten, Anbindung an HA-Todo/Kalender, Tageszuordnung, Drag-and-Drop, OAuth, Instagram-oEmbed,
Bildverkleinerung, vorgebautes Image über GitHub Actions.

## Stand und offene Punkte

- Der Docker-Build lief in der Entwicklungsumgebung nie (Container-Registries dort gesperrt), dort wurden nur die
  einzelnen Schritte nachgestellt. Das Add-on wurde vom Nutzer aus dem privaten Repository in Home Assistant installiert.
  Ob es dort wie erwartet startet und angezeigt wird, ist hier nicht festgehalten.
- Die Link-Vorschau ist gegen eine lokale Testseite und im Browser geprüft, **nicht gegen echte Seiten** (Chefkoch & Co.)
  und nicht gegen Instagram. Seiten hinter Cloudflare oder Login liefern keinen Titel (dann trägt der Nutzer ihn ein).
  Das Add-on-Protokoll zeigt pro Abruf eine Zeile `[preview] <host> title=… image=… reason=…` (nur der Host, nie die URL).
- Ob HA-Ingress die `X-Remote-User-*`-Header wirklich liefert, ist gegen die Doku, aber nicht am echten System geprüft.
- Kein Dunkelmodus (HA-Theme dunkel, App bleibt hell).

## Git

Kurze deutsche Commit-Nachrichten, das „Warum“ zuerst. Kein Force-Push auf `main`.
