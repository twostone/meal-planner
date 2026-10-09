# AGENTS.md

Anleitung für Coding-Agents und Mitwirkende. Kurz halten, bei Änderungen an Architektur oder Regeln mitpflegen.

## Projekt

Essensplanung für einen Haushalt als Home-Assistant-Add-on (Ingress). Eine gemeinsame Liste pro Zeitraum (z. B. Sa–Fr),
ein Katalog aller bisherigen Gerichte mit Rezept-Link, Autocomplete beim Eintragen. Aus einem Link holt der Server Titel
und Vorschaubild. Grundsatz: **KISS und YAGNI**. Nichts bauen, was nicht ausdrücklich gebraucht wird.

## Layout

```
repository.yaml          HA-Add-on-Repository
README.md                Installation, Updates, Entwicklung (das Repository ist öffentlich)
LICENSE                  Apache-2.0
AGENTS.md                diese Datei
release-please-config.json, .release-please-manifest.json   Release-Automatik (Version, Changelog)
.github/workflows/       ci.yml (Tests, Docker-Build, Smoke-Test), release.yml (Release Please, Image)
.github/dependabot.yml   hält die festgepinnten Actions aktuell
meal-planner/            das Add-on (Docker-Build-Kontext)
  config.yaml            Add-on-Konfiguration (Version pflegt Release Please)
  icon.png               Icon im App-Store (128×128 PNG, aus web/public/favicon.svg erzeugt)
  CHANGELOG.md           entsteht und wächst durch Release Please, nicht von Hand ändern
  Dockerfile             zweistufig, node:22-alpine
  src/                   Backend: Hono + node:sqlite
    db.ts, repo.ts         Datenbank (Migrationen) und Zugriff
    app.ts, server.ts      API, Ingress-Sperre, Start
    net-guard.ts           Adress-Sperre (SSRF)
    safe-fetch.ts          der einzige Weg, fremde URLs abzurufen
    preview.ts             Titel und Bild aus HTML (og:-Tags, schema.org-Rezept)
    images.ts              Bildspeicher (/data/images, Dateiname = Hash)
    ha-api.ts, ha-state.ts  Zweiter Listener (Token) und Zustand für die HA-Integration
    ha-notify.ts            Bus-Events an Home Assistant (über den Supervisor)
    ha-ai.ts                ai_task.generate_data über den Supervisor (Rezept in Zutaten zerlegen)
    recipe-draft.ts         prüft und bereinigt die LLM-Antwort, gleicht sie mit dem Originaltext ab
    ha-discovery.ts         Meldung von Host, Port und Token per Supervisor-Discovery
  web/                   Frontend: Svelte 5 + Vite (Runes, TypeScript)
    public/favicon.svg     Favicon der App, Vorlage für icon.png
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

Vor jedem Commit: Tests, `tsc`, `check` und `build` müssen sauber durchlaufen (genau das prüft auch die CI).

## Architektur und bewusste Entscheidungen

- **Datenmodell:** `dish` (Katalog, mit `url`, `note`, `image`), `dish_tag` (Kategorien), `plan` (Zeitraum, Start/Ende,
  optional `title`), `plan_entry` (Gericht in Zeitraum, `done`, `note`). Bewusst **keine Tageszuordnung** und keine manuelle
  Reihenfolge per Drag.
- **Liste bearbeiten:** Name und Zeitraum einer Liste ändert `PATCH /api/plans/:id` (`updatePlan` in `repo.ts`), im UI per
  Stift-Symbol im Zeitraum-Blatt. `title`: höchstens 100 Zeichen, `""`/`null` löscht den Namen, fehlt es, bleibt er. Ohne
  Namen gilt der Datumsbereich als Anzeigename. `start_date` und `end_date` gibt es nur zusammen (sonst 400), Ende nicht vor
  Start. Überschneidet der neue Zeitraum eine andere Liste (Grenzen inklusive), antwortet die API mit 409 `plan overlaps`
  und ändert nichts. Die Prüfung läuft nur, wenn sich die Daten ändern: eine schon überlappende Liste bleibt umbenennbar.
  `POST /api/plans` prüft dieselbe Regel (`overlapsOther` in `repo.ts`): Überschneidung -> 409 `plan overlaps`, es wird
  nichts angelegt und kein Event gesendet. Berühren ohne gemeinsamen Tag ist erlaubt. Bereits überlappende Altdaten
  bleiben unverändert bestehen.
- **Rezept** (Plan: `docs/plan-rezepte.md`, Stufe 1 bis 3 gebaut): gehört zum Gericht, nicht zum Listeneintrag. `dish.servings`
  (1–50) und `dish.instructions` (ein Schritt pro Zeile, höchstens 10 000 Zeichen) plus `dish_ingredient` (Reihenfolge `pos`,
  `section`, `amount`/`amount_max`, `unit`, `name`, `note`, `raw`). `GET/PUT /api/dishes/:id/recipe`: PUT ersetzt alles in einer
  Transaktion (wie `setTags`), ein leeres Rezept löscht es. Höchstens 60 Zutaten. `unit` nur aus `UNITS` in `repo.ts`
  (wie `UNITS` in `web/src/types.ts`), **kein „Stück“**: Gezähltes hat `unit = null`. `raw` ist die Originalzeile und bleibt
  immer erhalten, bei Handeingabe wird sie aus Menge/Einheit/Name gebildet. Die Rezeptspalten kommen nie mit dem Katalog
  (`DISH_COLS` in `repo.ts`, kein `SELECT *` auf `dish`). Im UI öffnet „Rezept“ im Bearbeiten-Blatt ein eigenes Blatt
  (Ansicht und Editor in `RecipeSheet.svelte`).
  **Originaltext (Stufe 2):** `dish.source_text` (höchstens 10 000 Zeichen) und `source_truncated` sichern das Rezept so, wie es
  am Link steht, ohne LLM und ohne Deutung. Die Vorschau (`extractSource` in `preview.ts`, `sourceText`/`sourceTruncated` in
  `POST /api/preview`) liefert schema.org-Zutatenzeilen, Leerzeile, Schritte, sonst die Instagram-Caption. Ein neues Gericht
  aus dem Link nimmt den Text mit (`source_text` in `POST /api/dishes`), bei einem gespeicherten Gericht holt ihn nur
  `POST /api/dishes/:id/source` (Link neu abrufen; ohne Fund `{reason}` und nichts ändert sich; im UI „Rezept aus Link holen“
  mit zweiter Bestätigung, wenn schon ein Text da ist). Er kommt mit `GET /api/dishes/:id/recipe`, nie mit dem Katalog, und
  `PUT …/recipe` lässt ihn unberührt.
  **Zutaten erkennen (Stufe 3):** `POST /api/dishes/:id/recipe/draft` schickt `source_text` über `ha-ai.ts` an die bevorzugte
  AI-Task-Entität von HA und liefert einen **Entwurf** (wird nie gespeichert). Die LLM-Antwort gilt als Nutzereingabe
  (`buildDraft` in `recipe-draft.ts`): Schema, Grenzen, Einheitenliste (Unbekanntes -> `unit` null, Rest in `note`),
  Aufräumen (Nummerierung der Schritte, `:` am Abschnittsende). Abgleich mit der Quelle (ohne Leerzeichen, Aufzählungszeichen,
  Emojis, Doppelpunkte, Groß-/Kleinschreibung bleibt): `raw` und `section` müssen wörtlich im Text stehen, sonst
  `verified: false` (im Editor rot markiert, bis man die Zeile ändert); `servings` gilt nur mit `servings_quote`, die im Text
  steht, und mit mindestens einer Zutat. Weggelassene Zeilen lassen sich nicht automatisch prüfen: Der Editor zeigt den
  Originaltext im Entwurf aufgeklappt. `GET /api/recipe/status` (`{ai, reason}`: `disabled`, `no_entity`, `unreachable`)
  steuert, ob die UI den Knopf zeigt. Ohne Token ist `ai` nicht gesetzt: die Entwurfsroute gibt es dann nicht. Ablauf: 30 s
  Zeitlimit, kein Wiederholen, höchstens 2 parallele Entwürfe, Fehler -> 502 `ai failed` und im UI „Von Hand eintragen“.
  Das LLM hat keine Tools. Der Text geht an den in HA eingerichteten (evtl. Cloud-)Dienst: im README vermerkt.
- Ein Gericht kann pro Zeitraum nur einmal vorkommen. Der Titel ist im Katalog eindeutig (ohne Groß-/Kleinschreibung).
  Ein Eintrag per Titel legt das Gericht an oder verwendet ein vorhandenes wieder. Löschen eines Gerichts, das noch
  in einer Liste steht, ist absichtlich gesperrt (409).
- **Zwei Notizen, bewusst getrennt:** `dish.note` gilt für das Gericht überall (im Bearbeiten-Blatt, dort „Notiz zum
  Gericht (gilt überall)“), `plan_entry.note` nur für dieses Gericht in genau dieser Liste. Die Listen-Notiz hat ein eigenes
  Feld „Notiz für diese Liste“ im Bearbeiten-Blatt (nur wenn das Blatt aus der Liste geöffnet wurde, nicht aus dem Katalog)
  und steht in der Liste unter dem Titel, auf zwei Zeilen gekürzt. Sie wird nicht in andere Listen übernommen und
  verschwindet mit dem Eintrag. Setzen/Löschen per `PATCH /api/entries/:id` (`note`: Text, `""` oder `null` löscht, fehlt =
  unverändert); das Blatt schickt das nur, wenn sich die Notiz geändert hat.
- **Zeilen in der Liste bleiben schlank** (auf 360 px Breite ist es sonst zu eng): Checkbox, Vorschaubild, Titel mit Notiz und
  Kategorien darunter, am Ende nur ein Link-Symbol ohne Domainnamen. Keine weiteren Buttons in der Zeile, Bearbeiten läuft
  über Tippen auf den Titel. Lange Wörter im Titel brechen um (`overflow-wrap: anywhere`).
- **Kategorien** sind frei wählbare Tags pro Gericht (höchstens 10, je höchstens 30 Zeichen). Es gibt keine Tag-Tabelle: Die
  Liste der Kategorien ist die Menge der verwendeten Werte, eine Kategorie verschwindet mit ihrem letzten Gericht. Groß-/
  Kleinschreibung ist egal, die zuerst verwendete Schreibweise gilt (`setTags` in `repo.ts`). Ein Update ersetzt die Tags,
  fehlt `tags`, bleiben sie unverändert. Im Katalog filtern Chips nach genau einer Kategorie, ein neues Gericht übernimmt
  die aktive. Snacks sind normale Einträge (Kategorie „Snack“), keine eigene Art. Umbenennen/Zusammenführen von
  Kategorien gibt es bewusst nicht.
- SQLite `NOCASE` gilt nur für ASCII. Für die Anzeige-Sortierung (Umlaute) wird im Frontend `localeCompare("de")` genutzt.
- `createDish` und `updateDish` sind je eine Transaktion. `addEntry` legt Gerichte über `insertDish` (ohne eigene
  Transaktion) an, weil es selbst in einer läuft: SQLite kennt keine verschachtelten `BEGIN`.
- Optionale Textfelder in der API: `""` und `null` löschen das Feld (`optional()` in `app.ts`, der Zweig für `""` muss
  vor dem String-Schema stehen, sonst wird `""` selbst akzeptiert).
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
- **Instagram:** Der Abruf ist der allgemeine (`fetchLimited`) mit dem Bot-User-Agent `EssensplanungBot`, **nicht in einen
  Browser-User-Agent ändern**: nur damit liefert Instagram eine vorgerenderte Seite mit der vollständigen Caption in `og:title`
  (`<Name> auf Instagram: "<Caption>"`); mit Browser-UA kommt nur eine JavaScript-Hülle. Das ist undokumentiertes Verhalten,
  getestet bis 1 490 Zeichen. Fehlt das schließende `"`, gilt die Caption als gekürzt (`source_truncated`). Die Caption wird
  als `source_text` gespeichert (Nutzungsbedingungen: für einen privaten Haushalt bewusst akzeptiert). Die oEmbed-Schnittstelle (seit 15.06.2026 ohne Token) ist
  nicht eingebaut: das Antwortformat ohne Token ist ungeprüft, und Metas Bedingungen verbieten das Speichern der
  Metadaten. Vor einem Einbau am echten Gerät testen und die Bedingungen erneut lesen.
- **Keine externen Anfragen aus dem Browser:** Schriften sind lokal eingebunden (`@fontsource-variable`), Bilder kommen
  vom eigenen Server. Extern ruft nur der Server ab, und nur Links, die der Nutzer eingegeben hat.
- **Home-Assistant-Anbindung** (für die HA-Integration/Lovelace-Karte, separates Repo, per HACS installierbar; zwei Kanäle):
  - **Daten (Abruf):** Ein zweiter Listener (`HA_API_PORT`, im Dockerfile 8100, `ha-api.ts`) hat genau eine Route,
    `GET /ha/state` mit Bearer-Token, Antwort `{current, next, generated_at}` (Form `HaPlan` mit `title`, `ha-state.ts`).
    „Aktuell“ ist die Liste, die heute enthält, sonst `null` (`repo.getPlanOn`), „nächste“ die früheste mit Start nach heute
    (`getNextPlan`). Beides wird bei jedem Abruf aus dem Datum abgeleitet, ohne Zeitgeber. „Heute“ ist das lokale Datum
    (`TZ`), nicht UTC. Das Token entsteht beim ersten Start und liegt in `/data/ha-token` (Rotation: Datei löschen, App neu
    starten). Alles andere ist 404, der Listener liest keine `X-Remote-User-*`-Header und feuert keine Events.
  - **Events (Push):** `ha-notify.ts` postet `meal_planner_<typ>` an `http://supervisor/core/api/events/` (`homeassistant_api: true`,
    `SUPERVISOR_TOKEN`). Typen: `plan_created`, `plan_updated` (nur bei echter Änderung von Name oder Zeitraum), `entry_added`,
    `entry_removed`, `entry_done`, `entry_undone` (nur wenn sich `done` ändert). Daten: `plan {id,start_date,end_date}`
    (bei `plan_updated` zusätzlich `title`), `previous {start_date,end_date,title}` (nur `plan_updated`, die Werte davor),
    `entry {id,dish_id,title}` (nur bei den `entry_*`-Events) und `user {id,name,display_name}` oder `null` (aus den
    Ingress-Headern, `haUser()` in `app.ts`). Kein Snapshot im Event. Liste löschen und Katalog-Änderungen feuern bewusst
    nichts. Fire-and-forget wie `sweep()`: Fehler werden geloggt, ein verlorenes Event wird nicht nachgeholt (der Zustand
    kommt beim nächsten Abruf).
  - **Einrichtung:** Beim Start postet `ha-discovery.ts` `{service: "meal_planner", config: {host, port, token}}` an
    `http://supervisor/discovery` (`discovery: [meal_planner]`), mit Wiederholung, nie fatal. Der Dienstname muss der
    Domain der Integration entsprechen. Ohne `SUPERVISOR_TOKEN` (Entwicklung, Tests) sind Events und Discovery aus.

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
- **`ha-notify.ts` ist bewusst die eine Ausnahme von der SSRF-Regel oben (ebenso `ha-ai.ts`):** Es nutzt einfaches `fetch`,
  nicht `fetchLimited`. Das Ziel (`http://supervisor`, `ha-discovery.ts` und `ha-ai.ts` ebenso) ist im Code festgelegt, kein Nutzer-Input, und
  liegt im internen Netz – genau die Adressen, die `net-guard.ts` für Rezept-Links zu Recht sperrt. Diese Pfade
  nicht vermischen.
- Änderungen an `net-guard.ts` mit Vorsicht: Node prüft IPv4-Adressen als IPv4-gemappte IPv6-Adressen, eine Regel für
  `::ffff:0:0/96` würde daher **jede** IPv4-Adresse sperren (der Test `isPublicIp` fängt das).
- Bildnamen kommen nur aus dem Bildspeicher (Hash + Endung, geprüft per `IMAGE_NAME`), nie Pfade vom Client.
  Ausgeliefert wird mit `nosniff` und `Content-Security-Policy: default-src 'none'`.
- Neue Ports oder `host_network` nicht ohne Rückfrage freigeben. Der Port 8100 (`ha-api.ts`) ist die eine bewusste Ausnahme:
  nur `GET /ha/state`, Token-Vergleich zeitkonstant, kein `ports:`-Mapping (nur im Supervisor-Netz erreichbar).
- **Das Repository ist öffentlich:** keine Zugangsdaten, Tokens, privaten Hostnamen oder Adressen aus dem Heimnetz
  einchecken (auch nicht in Tests, Kommentaren oder Beispielen).
- Workflows: keine eigenen Secrets. Veröffentlicht wird nur mit dem `GITHUB_TOKEN` im Job `publish` nach einem Release.

## CI und Releases

- **Commits nach Conventional Commits:** `typ(bereich): Beschreibung`, deutscher Text. Nur `feat` (Minor), `fix` und `perf`
  (Patch) sowie `feat!:`/`BREAKING CHANGE:` lösen einen Release aus. `docs`, `ci`, `chore`, `refactor`, `test`, `build`
  erscheinen nicht im Changelog und lösen nichts aus. Vor 1.0 erhöht ein Breaking Change nur die Minor-Version.
- **Release Please** (`release.yml`) sammelt die Commits seit dem letzten Release in einem Release-PR
  („chore(main): release x.y.z“). Der PR ändert `meal-planner/config.yaml` (Zeile mit `# x-release-please-version`),
  `package.json`, `package-lock.json` und `CHANGELOG.md`. **Mergen des PR ist der Release:** Tag `vX.Y.Z`, GitHub-Release,
  dann im selben Workflow-Lauf Tests und Bau des Images. Version, Tag und Changelog nie von Hand ändern, die Annotation
  in `config.yaml` nicht entfernen.
- **Warum alles in einem Workflow:** Was Release Please mit dem eingebauten `GITHUB_TOKEN` erzeugt (PR, Tag, Release),
  löst keine weiteren Workflows aus. Deshalb rufen `ci` und `publish` in `release.yml` erst nach einem Release an.
  Der Release-PR selbst bekommt dadurch keine automatischen Checks. Die Tests laufen auf `main` und beim Release.
  Release Please baut den Branch des Release-PR nur neu, wenn sich der Release-Inhalt ändert (`chore`/`docs` auf `main`
  zählen nicht). Ist die CI dort wegen eines inzwischen behobenen Fehlers rot, den Branch mit `main` aktualisieren.
- **CI** (`ci.yml`, bei Push auf `main`, bei Pull Requests und vor jedem Release): `npm ci`, `tsc`, `svelte-check`,
  Tests, Build. Dazu ein Docker-Build für amd64 mit **Smoke-Test** (Frontend und API antworten, SQLite funktioniert,
  ohne Ingress-Sperre; mit Standard-Konfiguration antwortet der Server Fremden mit 403) und ein Build für amd64 + arm64.
- **Image:** `ghcr.io/twostone/meal-planner:<version>` und `:latest`, Tag = Version aus `config.yaml`. Das Paket muss
  **öffentlich** sein (Package settings → Change visibility), sonst kann Home Assistant es nicht ohne Zugangsdaten laden.
  Provenance und SBOM sind aus (KISS).
- **Actions nur mit vollem Commit-SHA pinnen** (Kommentar mit der Version), Dependabot aktualisiert sie wöchentlich.
  Rechte in den Workflows so klein wie möglich lassen (`packages: write` nur im Job `publish`).
- **`image:` in `config.yaml`** steht ohne Tag (`ghcr.io/twostone/meal-planner`), Home Assistant hängt `version` als Tag an.
  Nie einen Tag oder `latest` eintragen. Nach dem Merge eines Release-PR steht die neue Version sofort in `config.yaml`,
  das Image gibt es aber erst nach dem grünen Publish-Job: erst dann Updates in Home Assistant einspielen.

## Regeln beim Ändern

- **Frontend-URLs immer relativ** (`api/plans`, `api/images/...`, Vite `base: "./"`), nie `/api/...`. Die App läuft unter
  einem wechselnden Ingress-Präfix. Ausnahme: Dateien aus `web/public/` (Favicon) werden in `index.html` mit `/name` verlinkt,
  Vite schreibt das beim Build auf `./name` um.
- **App-Icon:** `web/public/favicon.svg` ist die Quelle. `meal-planner/icon.png` (128×128, Dateiname von Home Assistant
  vorgegeben) ist daraus abgeleitet und muss bei jeder Änderung am SVG neu erzeugt und mit eingecheckt werden. Ein `logo.png`
  ist optional und bewusst nicht vorhanden.
- **Die Version nicht von Hand erhöhen:** sie kommt aus dem Release-PR (siehe „CI und Releases“). Ohne Commit mit `feat`/`fix`/`perf`
  gibt es keinen Release und HA zeigt kein Update.
- **Datenbank nur über Migrationen ändern:** in `src/db.ts` einen Eintrag an `MIGRATIONS` **anhängen**, nie ändern oder
  umsortieren (`PRAGMA user_version` zählt sie). Neue Migrationen mit einem Test gegen eine Datenbank im alten Stand.
  Die Tests, die die Schema-Version prüfen (`dish-image`, `tags`, `entry-note`, `plan-edit`, `recipe`), bei jeder neuen Migration
  mit anheben.
- **Add-on-Build:** Kein `build.yaml`, kein `BUILD_FROM` (beides gilt seit Supervisor 2026.04 nicht mehr). HA baut nicht
  selbst, es lädt das Image aus `image:`. Das Dockerfile ist zweistufig: Das Frontend wird auf der Architektur des Builders
  gebaut (`--platform=$BUILDPLATFORM`, sonst dauert arm64 unter Emulation sehr lange), die Laufzeit-Stufe je Zielarchitektur.
- `node:sqlite` ist unter Node 22 noch experimentell. Der gesamte DB-Zugriff bleibt in `src/db.ts` und `src/repo.ts`,
  damit ein Wechsel (z. B. `better-sqlite3`) klein bleibt.
- **TypeScript 6 ist gepinnt**, weil `svelte-check` TypeScript 7 noch nicht unterstützt. Erst umstellen, wenn es geht.
- `tsx` ist absichtlich eine Runtime-Dependency (der Server läuft im Container per `node --import tsx`).
- Neue Abhängigkeiten nur mit Grund: jede ändert `package-lock.json` und damit den Image-Build.
  Die Link-Vorschau kommt bewusst ohne HTML-Parser-Bibliothek und ohne Bildverarbeitung (`sharp`) aus.
- Sheets nutzen das native `<dialog>`. Kein `alert()`/`confirm()` (in der HA-Companion-App unzuverlässig), stattdessen
  zweistufige Bestätigung im UI.
- **Zurück-Taste:** Ein offenes Blatt belegt einen History-Eintrag (`pushSheetEntry`/`closeSheet` in `store.svelte.ts`), damit
  „Zurück“ das Blatt schließt statt die App zu verlassen. Blätter nur über `openDishSheet`/`openPeriods` öffnen
  und über `closeSheet` schließen, nie `app.sheet` direkt setzen. Getestet im Browser mit der App in einem iframe, in der
  HA-Companion-App auf dem Handy noch nicht.
- **APIs und Schnittstellen vor der Nutzung gegen die aktuelle Dokumentation prüfen** (HA-Add-on-Konfiguration, Hono,
  Svelte, Vite, Node). HA nennt Add-ons inzwischen „Apps“.
- Neue Backend-Logik bekommt Tests in `test/` (`app.request(...)` mit `node:test`). Für Netzwerkcode gilt: gegen einen
  lokalen Testserver testen, nie gegen das Internet. Bei UI-Änderungen zusätzlich im Browser bei 390 px Breite prüfen.
- UI-Texte deutsch, Code und Kommentare englisch. Bedienelemente mindestens 44 px, echte `<button>`/`<a>`.

## Bewusst nicht gebaut (nur auf ausdrücklichen Wunsch)

Einkaufsliste, Nährwerte, Anbindung an HA-Todo/Kalender, Tageszuordnung, Drag-and-Drop, OAuth, Instagram-oEmbed,
Bildverkleinerung, Image-Signatur/SBOM, Renovate/Dependabot für npm (TypeScript ist bewusst gepinnt),
Kategorien umbenennen/zusammenführen, Mehrfachauswahl im Kategorie-Filter.

## Stand und offene Punkte

- Der Docker-Build lief in der Entwicklungsumgebung nie (Container-Registries dort gesperrt), dort wurden nur die
  einzelnen Schritte nachgestellt. Ob das Add-on mit dem fertigen Image in Home Assistant startet und angezeigt wird,
  ist hier nicht festgehalten.
- Die Link-Vorschau ist gegen eine lokale Testseite und im Browser geprüft, **nicht gegen echte Seiten** (Chefkoch & Co.)
  und nicht gegen Instagram. Seiten hinter Cloudflare oder Login liefern keinen Titel (dann trägt der Nutzer ihn ein).
  Das Add-on-Protokoll zeigt pro Abruf eine Zeile `[preview] <host> title=… image=… reason=…` (nur der Host, nie die URL).
- Ob HA-Ingress die `X-Remote-User-*`-Header wirklich liefert, ist gegen die Doku, aber nicht am echten System geprüft.
- Die Releases laufen über Release Please (siehe „CI und Releases“). Der Stand des Pakets auf ghcr.io ist hier nicht
  festgehalten.
- Voraussetzung im Repository (gesetzt): Einstellungen → Actions → General → „Allow GitHub Actions to create and approve pull requests“.
- Kein Dunkelmodus (HA-Theme dunkel, App bleibt hell).
- Die HA-Integration + Lovelace-Karte lebt in [twostone/ha-meal-planner](https://github.com/twostone/ha-meal-planner)
  (eigenes Repo, per HACS installierbar) und ist nicht von diesem Repo/dieser CI abgedeckt. Die Anbindung (Discovery,
  zweiter Port, Events über den Supervisor) ist hier nur gegen lokale Testserver getestet, **nicht am echten System**:
  offen sind Hostname und Erreichbarkeit des Ports, der Event-Weg, die Zeitzone im Container und die Nutzer-Header
  (siehe `docs/umbauplan-ha-integration.md`, Phase 0). Die Lovelace-Karte zeigt bewusst keine Bilder (die
  Vorschaubilder liegen hinter der Ingress-only-API des Add-ons, für das HA-Frontend unerreichbar).

## Git und Pull Requests

- **Neue Features und größere Änderungen kommen über einen Pull Request**, nicht direkt auf `main`: Branch `feat/<thema>` bzw.
  `fix/<thema>`, ein PR pro Feature mit Backend, Migration, UI, Tests und angepasster Doku (`AGENTS.md`/`README.md`).
  Kleine Doku-, CI- und Chore-Änderungen dürfen direkt auf `main`.
- **Der PR-Titel ist eine Conventional-Commit-Zeile** (`feat(bereich): …`, deutscher Text), weil er beim Squash-Merge zur
  Commit-Nachricht wird und daraus Version und Changelog entstehen. Empfohlen ist in den Repository-Einstellungen nur
  Squash-Merge (Standardnachricht: PR-Titel) und „Automatically delete head branches“.
- Die CI läuft auf dem PR und muss vor dem Merge grün sein. Die UI vorher bei 390 px Breite prüfen.
- Commit-Nachrichten: das „Warum“ zuerst, kurz, deutsch. Kein Force-Push auf `main`.
