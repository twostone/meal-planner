# Essensplanung – Home-Assistant-App

Eine kleine App für die wöchentliche Essensplanung im Haushalt. Sie läuft als App (früher „Add-on“) direkt in Home
Assistant, erscheint in der Seitenleiste und braucht keine eigene Anmeldung: Wer Home Assistant nutzen darf, sieht
dieselbe Liste.

## Funktionen

- Eine gemeinsame Liste pro Zeitraum (frei wählbar, z. B. Samstag bis Freitag). Gerichte lassen sich abhaken.
- Ein Katalog aller bisherigen Gerichte mit Rezept-Link. Beim Eintragen schlägt die App passende Gerichte vor.
- Aus einem eingefügten Link (Rezeptseite, Instagram, …) holt der Server Titel und Vorschaubild. Klappt das nicht,
  trägt man den Titel selbst ein.
- Bedienung für das Handy ausgelegt, auch in der Home-Assistant-Companion-App.

## Installation

Voraussetzung: Home Assistant mit App-Store (Home Assistant OS oder Supervised), Architektur amd64 oder arm64.

1. In Home Assistant: *Einstellungen → Apps* (in älteren Versionen *Add-ons*) *→ App-Store → ⋮ → Repositories* und
   eintragen:

   ```
   https://github.com/twostone/meal-planner
   ```

2. „Essensplanung“ installieren und starten, danach „In Seitenleiste anzeigen“ aktivieren.

Home Assistant lädt dabei ein fertiges Image von `ghcr.io/twostone/meal-planner`, es wird nichts lokal gebaut. Die Daten
liegen im Datenspeicher der App (`/data`) und sind in Home-Assistant-Backups enthalten.

## Updates

Sobald eine neue Version veröffentlicht ist, zeigt der App-Store ein Update an. Was sich geändert hat, steht in
[`meal-planner/CHANGELOG.md`](meal-planner/CHANGELOG.md).

## Datenschutz und Sicherheit

- Die App ist nur über Home-Assistant-Ingress erreichbar. Der Server nimmt ausschließlich Verbindungen von Supervisor
  an und ist kein eigener Port im Netzwerk.
- Extern ruft nur der Server ab, und nur Links, die jemand selbst eingegeben hat. Interne Adressen (Heimnetz, andere
  Apps, Router) sind dabei gesperrt. Der Browser lädt nichts von Drittservern: Schriften und Bilder kommen vom eigenen Server.
- Es gibt keine Nutzerverwaltung: Alle, die die App in Home Assistant öffnen dürfen, sehen und ändern dieselbe Liste.

## Entwicklung

Node 22.13 oder neuer (wegen `node:sqlite`). Alles Weitere liegt in `meal-planner/`:

```
npm ci
npm test            # Tests
npx tsc --noEmit    # Typprüfung Backend
npm run check       # Svelte-/TypeScript-Prüfung
npm run build       # Frontend nach dist/
DB_PATH=./data/dev.db PORT=8099 npm start
```

Lokal ist die Ingress-Sperre aus, solange `INGRESS_ONLY_IP` nicht gesetzt ist. Architektur, Regeln und bewusste
Entscheidungen stehen in [`AGENTS.md`](AGENTS.md).

### Commits und Releases

Änderungen kommen mit Conventional-Commit-Präfix auf `main` (`feat:`, `fix:`, `perf:`; `docs:`, `ci:`, `chore:` lösen
keinen Release aus). [Release Please](https://github.com/googleapis/release-please) sammelt sie in einem Release-PR mit
neuer Version und Changelog. **Den PR zu mergen ist der Release:** GitHub taggt `vX.Y.Z`, testet, baut das Image
(amd64 und arm64) und veröffentlicht es als `ghcr.io/twostone/meal-planner:<version>`. Die Version nie von Hand ändern.
Nach dem Merge erst abwarten, bis der Workflow „Release“ grün ist: Erst dann existiert das Image, das Home Assistant
für die neue Version lädt.
