# Meal-planner – Home-Assistant-Add-on

Wöchentliche Essensplanung für den Haushalt: eine gemeinsame Liste pro Zeitraum (z. B. Sa–Fr), ein Katalog aller
bisherigen Gerichte mit Rezept-Link, Autocomplete beim Eintragen. Läuft als Add-on hinter Home-Assistant-Ingress,
die Anmeldung übernimmt Home Assistant.

## Installation (privates Repository)

1. Auf GitHub ein **Fine-grained Personal Access Token** anlegen: nur Zugriff auf dieses Repository,
   Berechtigung *Contents: Read-only*.
2. In Home Assistant: *Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories* und eintragen:

   ```
   https://twostone:<TOKEN>@github.com/twostone/meal-planner.git
   ```

   Das Token steht danach in der HA-Konfiguration. Bei einem öffentlichen Repository entfällt es.
3. „Essensplanung“ installieren und starten. Das Image wird auf dem Gerät gebaut, der erste Start dauert deshalb
   einige Minuten. Danach „In Seitenleiste anzeigen“ aktivieren.

Daten liegen in der Add-on-Datenablage (`/data`) und sind in HA-Backups enthalten.

## Updates

In `meal-planner/config.yaml` die `version` erhöhen und pushen. Home Assistant zeigt dann ein Update an.

## Entwicklung

Alles Weitere liegt in `meal-planner/`:

```
npm install
npm test            # API-Tests
npm run check       # Svelte-/TypeScript-Prüfung
npm run build       # Frontend nach dist/
DB_PATH=./data/dev.db PORT=8099 npm start
```

Der Server verweigert im Add-on alle Verbindungen außer von Supervisor (172.30.32.2). Lokal ist diese Sperre aus,
solange `INGRESS_ONLY_IP` nicht gesetzt ist.
