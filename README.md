# Essensplanung – Home-Assistant-App

<img src="meal-planner/web/public/favicon.svg" alt="Essensplanung" width="96" align="right">

[![CI](https://github.com/twostone/meal-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/twostone/meal-planner/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/twostone/meal-planner.svg)](https://github.com/twostone/meal-planner/releases)
[![License](https://img.shields.io/github/license/twostone/meal-planner.svg)](LICENSE)

Eine kleine App für die wöchentliche Essensplanung im Haushalt. Sie läuft als App (früher „Add-on“) direkt in Home
Assistant, erscheint in der Seitenleiste und braucht keine eigene Anmeldung: Wer Home Assistant nutzen darf, sieht
dieselbe Liste.

## Funktionen

- Eine gemeinsame Liste pro Zeitraum (frei wählbar, z. B. Samstag bis Freitag). Gerichte lassen sich abhaken.
- Ein Katalog aller bisherigen Gerichte mit Rezept-Link. Beim Eintragen schlägt die App passende Gerichte vor.
- Kategorien: Gerichte lassen sich frei kategorisieren (z. B. Snack, Suppe, Vegan), mehrere pro Gericht. Im Katalog
  filtern Chips nach einer Kategorie.
- Aus einem eingefügten Link (Rezeptseite, Instagram, …) holt der Server Titel und Vorschaubild. Klappt das nicht,
  trägt man den Titel selbst ein. Dazu gibt es Titelvorschläge: zwei aus festen Regeln (der Originaltitel und ein
  bereinigter) und, wenn Home Assistant eine KI hat, zwei von der KI.
- Rezepte: Zutaten (Menge, Einheit, Zutat), Portionen und Zubereitung pro Gericht, von Hand oder aus dem Text, den die
  App beim Link-Abruf sichert (Rezeptseite oder Instagram-Caption). Optional zerlegt die KI von Home Assistant den Text in
  Zutaten und Schritte. Das Ergebnis ist ein Entwurf, den man mit dem Originaltext vergleicht und erst dann speichert.
  Dabei vereinheitlicht die KI die Zutaten: Name in der Grundform („Zwiebel“), Sorte („rot“) und Zubereitung
  („gewürfelt“) in eigenen Feldern, schon verwendete Namen werden wiederverwendet. Englische Einheiten rechnet die App
  um (1 cup Mehl → 120 g, 1 cup Milch → 235 ml, US-Maße).
- Die Suche im Katalog findet Gerichte auch über ihre Zutaten („Zucchini“ zeigt alle Gerichte mit Zucchini im Rezept,
  „Zwiebeln“ findet auch „Zwiebel“) und schlägt beim Tippen die vorhandenen Zutaten vor.
- Kochmodus: „Kochen“ in der Liste zeigt alle Gerichte der Liste mit ihren Rezepten, zwischen denen man per Reiter
  wechselt (praktisch zum Vorkochen mehrerer Gerichte). Zutaten und Schritte lassen sich abhaken, auf allen Handys
  gleichzeitig (Abgleich alle paar Sekunden). „Fertig“ hakt das Gericht auch in der Liste ab. Der Bildschirm bleibt an,
  soweit die App das zulässt.
- Einkaufsliste: Der Einkaufswagen in der Liste fasst die Zutaten der offenen Gerichte zusammen (gleiche Zutaten werden
  addiert, g/kg und ml/l umgerechnet) und schickt die angehakten Artikel an eine Todo-Liste in Home Assistant, z. B. eine
  Bring-Liste. Was dort schon offen steht, ist abgewählt. Siehe „Einkaufsliste (Bring)“.
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

## Home Assistant Dashboard

Die aktuelle Liste lässt sich zusätzlich im Home-Assistant-Dashboard anzeigen (Entitäten + Lovelace-Karte) und für
Automatisierungen nutzen (Events bei neuer Liste sowie bei hinzugefügten, entfernten und abgehakten Gerichten, jeweils mit
dem auslösenden Nutzer): per HACS installierbar: in HACS das Repository `https://github.com/twostone/ha-meal-planner` als
benutzerdefiniertes Repository (Kategorie „Integration“) hinzufügen, siehe dessen README. Der Quellcode der Integration liegt
in diesem Repository unter `custom_components/meal_planner/` (`ha-meal-planner` ist nur ein automatisch befülltes Mirror für HACS). Die Integration wird von der App per Discovery gefunden; die App bietet dafür einen zweiten, nur lesenden
Port (8100, Token, nur im Supervisor-Netz erreichbar). Wer das Token erneuern will, löscht `/data/ha-token` und startet die
App neu. In Automationen die Details aus den Eventdaten lesen, nicht aus den Sensoren: sie ziehen einen Moment nach.

## KI-Funktionen

Der Knopf „Zutaten erkennen“ und die KI-Titelvorschläge gibt es nur, wenn Home Assistant eine **AI-Task-Entität** hat
(Einstellungen → System → KI-Aufgaben, eingerichtet über eine LLM-Integration wie OpenAI, Anthropic oder Google; ein
Gesprächsagent allein reicht nicht). Genutzt wird die dort bevorzugte Entität. Ohne sie bleibt es bei den regelbasierten
Titelvorschlägen und der Handeingabe.

Home Assistant kennt nur eine bevorzugte Entität für alle Textaufgaben. Wer für die Titel ein schnelles, kleines Modell und
für die Zutaten ein stärkeres nutzen will, trägt in der App-Konfiguration die Entitäts-ID von Hand ein (z. B.
`ai_task.openai_ai_task`, zu finden unter Einstellungen → Geräte & Dienste → Entitäten):

- `ai_entity_recipe`: Entität für „Zutaten erkennen“
- `ai_entity_titles`: Entität für die KI-Titelvorschläge

Leer heißt: die bevorzugte Entität. Eine Änderung gilt nach einem Neustart der App. Gibt es eine eingetragene Entität nicht
(Tippfehler) oder ist sie nicht verfügbar, sind **beide** KI-Funktionen aus; das Protokoll nennt dann die Option
(`configured_entity_missing option=… entity=…`).

Die KI-Titel erscheinen automatisch nach jeder Link-Vorschau, zunächst als zwei Platzhalter mit „KI“-Kennzeichen. Fehlt
die Antwort oder dauert sie länger als 15 Sekunden, verschwinden die Platzhalter, die übrigen Vorschläge bleiben. Die
Sprache der Titel ist die Sprache des Browsers (auf dem Handy: die Systemsprache). Ein Titel wird nie ungefragt
überschrieben: Man wählt einen Vorschlag selbst.

## Einkaufsliste (Bring)

Der Einkaufswagen erscheint, wenn Home Assistant mindestens eine **Todo-Liste** hat, der man Einträge hinzufügen kann. Für
Bring ist das die [Bring-Integration](https://www.home-assistant.io/integrations/bring/): Jede Bring-Liste wird dort zu
einer Todo-Entität. Die App braucht keine eigenen Zugangsdaten, sie nutzt die Integration über Home Assistant.

- Im Blatt wählt man die Ziel-Liste (die zuletzt genutzte ist vorbelegt, für alle Handys gleich) und per Chip die Gerichte
  (Standard: alle noch nicht gekochten). Gerichte ohne Zutaten werden genannt, aber nicht berücksichtigt.
- Gleiche Zutaten (ohne Groß-/Kleinschreibung) werden zu einem Artikel; Mengen gleicher Einheit werden addiert, andere
  Einheiten mit „+“ angehängt („400 g + 1 Dose“). Ähnliche Namen („Knoblauch“, „Knoblauchzehe“) bleiben getrennt.
- Der Hinweis einer Zutat kommt in die Beschreibung („Macadamia, 50 g“) und trennt Einträge: „Nüsse (Macadamia)“ und
  „Nüsse (Walnuss)“ stehen als zwei Einträge „Nüsse“ in Bring, ihre Mengen werden nicht addiert. Das gilt für jeden
  Hinweis, auch für „fein gehackt“; unerwünschte Einträge wählt man im Blatt vor dem Senden ab.
- Die Menge landet in Bring als Spezifikation. Listen ohne Beschreibungsfeld (z. B. die eingebaute Einkaufsliste von Home
  Assistant) bekommen sie in Klammern hinter den Namen.
- Was auf der Liste schon offen steht, ist abgewählt und markiert; vorhandene Einträge werden nie geändert.

## Protokoll

Die App schreibt eine Zeile pro Ereignis ins Protokoll der App (*Einstellungen → Apps → Essensplanung → Protokoll*), mit
Uhrzeit und Abweichung zur UTC-Zeit, Stufe, Bereich und Ereignis:

```
2026-10-11T14:41:03.123+02:00 ERROR ha-ai task_failed task=meal_planner_title status=400 ms=812 body="Data should be valid JSON."
```

In der App-Konfiguration stellt `log_level` ein, wie viel geschrieben wird (`debug`, `info`, `warning`, `error`; Standard
`info`). Eine Änderung gilt nach einem Neustart der App. Anfragen an die App erscheinen nur, wenn sie fehlschlagen (Status ab
400) oder länger als 2 Sekunden dauern. Rezepttexte, vollständige Links und Zugangsdaten stehen nie im Protokoll.

## Datenschutz und Sicherheit

- Die App ist nur über Home-Assistant-Ingress erreichbar. Der Server nimmt ausschließlich Verbindungen von Supervisor
  an. Einzige Ausnahme ist der nur lesende, per Token geschützte Port für die HA-Integration (siehe oben).
- Extern ruft nur der Server ab, und nur Links, die jemand selbst eingegeben hat. Interne Adressen (Heimnetz, andere
  Apps, Router) sind dabei gesperrt. Der Browser lädt nichts von Drittservern: Schriften und Bilder kommen vom eigenen Server.
- „Zutaten erkennen“ schickt den gesicherten Rezepttext an den KI-Dienst, der in Home Assistant eingerichtet ist (bei
  einem Cloud-Dienst also ins Internet), zusammen mit der Liste der schon verwendeten Zutatennamen (höchstens 300), und
  zwar nur auf Knopfdruck. **Die KI-Titelvorschläge dagegen laufen automatisch:**
  Jede Link-Vorschau schickt den Seitentitel und den gefundenen Text (höchstens 10 000 Zeichen) an denselben Dienst (oder an
  den unter `ai_entity_titles` eingetragenen). Wer das
  nicht möchte, richtet in Home Assistant keine AI-Task-Entität ein (oder entfernt sie): dann bleiben beide Funktionen aus.
- Die Einkaufsliste geht nur auf Knopfdruck an die gewählte Todo-Liste in Home Assistant, bei Bring also über dessen
  Cloud-Dienst an Bring.
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

Die Integration (`custom_components/meal_planner/`) hat ihre Python-Tests im Repo-Root: `uv run pytest tests -q`.

Lokal ist die Ingress-Sperre aus, solange `INGRESS_ONLY_IP` nicht gesetzt ist. Architektur, Regeln und bewusste
Entscheidungen stehen in [`AGENTS.md`](AGENTS.md).

### Commits und Releases

Änderungen kommen mit Conventional-Commit-Präfix auf `main` (`feat:`, `fix:`, `perf:`; `docs:`, `ci:`, `chore:` lösen
keinen Release aus). [Release Please](https://github.com/googleapis/release-please) sammelt sie in einem Release-PR mit
neuer Version und Changelog. **Den PR zu mergen ist der Release:** GitHub taggt `vX.Y.Z`, testet, baut das Image
(amd64 und arm64) und veröffentlicht es als `ghcr.io/twostone/meal-planner:<version>`. Die Version nie von Hand ändern.
Die Integration hat einen eigenen Release-PR (Tag `integration-vX.Y.Z`, Commit-Bereich `integration`); nach dessen Merge
kopiert die CI sie ins HACS-Mirror `twostone/ha-meal-planner`. Nach dem Merge erst abwarten, bis der Workflow „Release“ grün ist: Erst dann existiert das Image, das Home Assistant
für die neue Version lädt.

## Lizenz

[Apache License 2.0](LICENSE), wie Home Assistant und dessen offizielle Apps.
