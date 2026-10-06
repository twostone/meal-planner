# Plan: Rezepte mit Zutaten und Zubereitung

_Stand: 06.10.2026. Grundlage: `AGENTS.md`, `src/preview.ts` und `src/safe-fetch.ts` auf `main`, HA-Doku zu `ai_task`,
`rest_command` und zur REST-API, curl-Tests gegen Instagram (Abschnitt 3), LLM-Tests über ein HA-Script (Abschnitt 4).
`db.ts` und `repo.ts` wurden für diesen Plan nicht im Detail gelesen._

## 1. Ziel und Entscheidungen (vom Nutzer)

Bisher speichert die App pro Gericht nur Titel, Link, Bild, Notiz und Kategorien. Künftig soll das ganze Rezept in der
App liegen.

- **Zweck:** Nachschlagen beim Kochen (unabhängig davon, ob Link oder Instagram-Post noch existiert), Suche nach Zutat,
  Portionen umrechnen, später Einkaufsliste.
- **Zutaten gleich strukturiert** (Menge, Einheit, Zutat), nicht als Freitext.
- **Einkaufsliste kommt nicht in diese Stufe.** Diese Stufe legt nur das Datenmodell an, auf das sie später aufbaut.
- **Quellen:** überwiegend Instagram, daneben Rezeptseiten. Bei etwa jedem dritten Instagram-Post steht das Rezept nur im
  Bild oder Video, nicht in der Caption.
- **Erfassung:** **aus dem Link** (Instagram-Caption oder schema.org-Rezept) als Hauptweg, **„Text einfügen“** als
  Rückfall, Handeingabe immer möglich. **Screenshot** (Rezept im Bild) als spätere Phase 4.
- **Zerlegung per LLM** über die HA-Action **`ai_task.generate_data`**. Eingerichtet ist ein Cloud-LLM. Die App braucht
  keinen eigenen API-Key, aber eine AI-Task-Entität in HA.
- **Prüfansicht immer vor dem Speichern.** Ohne LLM (keine Entität, Fehler, Zeitüberschreitung) bleibt die Handeingabe.
- **Zubereitungsschritte** und ein **Kochmodus** gehören dazu. Wake Lock wird vorher am Handy getestet.
- **Keine Nährwerte**, **kein Feld „fehlende Zutaten“** (im Test unzuverlässig, Abschnitt 4).

## 2. Datenmodell (Migration, an `MIGRATIONS` anhängen)

```sql
ALTER TABLE dish ADD COLUMN servings INTEGER;        -- Basis für das Umrechnen, NULL = unbekannt
ALTER TABLE dish ADD COLUMN instructions TEXT;       -- Schritte, ein Schritt pro Zeile

CREATE TABLE dish_ingredient (
  id        INTEGER PRIMARY KEY,
  dish_id   INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL,          -- Reihenfolge wie im Rezept
  section   TEXT,                      -- z. B. "Für den Dip", NULL = ohne Abschnitt
  amount    REAL,                      -- NULL bei "etwas", "nach Geschmack", "optional"
  amount_max REAL,                     -- nur bei Spannen ("1–2 Zehen")
  unit      TEXT,                      -- normierte Einheit, NULL = gezählt ohne Einheit ("1 Zwiebel") oder ohne Menge
  name      TEXT NOT NULL,             -- "Zwiebel" (für Suche und spätere Einkaufsliste)
  note      TEXT,                      -- "große", "kleine Würfel", "optional"
  raw       TEXT NOT NULL              -- Originalzeile, wird nie verändert
);
CREATE INDEX dish_ingredient_dish ON dish_ingredient(dish_id, pos);
```

Begründungen:

- **`raw` immer speichern.** Ist die Struktur falsch, bleibt die Originalzeile sichtbar, und eine spätere bessere Zerlegung
  kann neu laufen.
- **Schritte als Text, nicht als Tabelle.** Schritte werden nur angezeigt und nicht ausgewertet (YAGNI).
- **Rezept gehört zum Gericht** (`dish`), nicht zum Listeneintrag, und gilt also überall, wie `dish.note`.
- **Ersetzen statt Einzelupdate:** Beim Speichern ersetzt die App alle Zutaten eines Gerichts in einer Transaktion
  (wie `setTags`).
- **Einheiten:** feste Liste `g`, `kg`, `ml`, `l`, `EL`, `TL`, `Prise`, `Zehe`, `Bund`, `Dose`, `Packung`, `Becher`,
  `Scheibe`, `Handvoll`. **Kein „Stück“:** Gezähltes hat `unit = NULL`, es gibt also nur eine Schreibweise (wichtig für
  die Einkaufsliste). Passt sonst keine Einheit, `unit = NULL` und der Rest in `note`.
- Grenzen: höchstens 60 Zutaten, `name` höchstens 80 Zeichen, `raw`/`note` höchstens 200, `instructions` höchstens 10 000
  Zeichen, `servings` 1–50.

## 3. Quelle Instagram: Caption aus dem Link (getestet 03.–06.10.2026)

**Befund (curl vom Heimnetz, bestätigt per `rest_command` aus HA):**

| User-Agent | Antwort | Caption |
|---|---|---|
| Browser (Chrome Android) | ~629 KB JavaScript-Hülle, `<title>Instagram</title>`, keine og:-Tags | nein |
| Browser, Seite `/embed/captioned/` | dieselbe Hülle | nein |
| `facebookexternalhit/1.1` | Hülle, keine og:-Tags | nein |
| **`Mozilla/5.0 (compatible; EssensplanungBot/1.0)`** (der der App) | ~155 KB, vorgerendert, og:-Tags | **ja, vollständig** |

- Die Caption steht mit echten Zeilenumbrüchen in `og:title` (`<Name> auf Instagram: "<Caption>"`), `og:description` und
  `description` (beide mit Präfix „11K likes, 81 comments - <user> am <Datum>: "…"`). `og:title` ist die bessere Quelle
  (ohne Likes-Präfix). Die Caption ist der Text zwischen dem ersten `: "` und dem letzten `"`, nach `decodeEntities`.
- Vollständig geprüft bei 4 Posts von 4 Accounts mit bis zu 1 490 Zeichen, Pfade `/reel/`, `/reels/` und `/p/`, Abruf aus
  HA in 0,6–1 s. **Nicht geprüft: Captions über 1 500 Zeichen** (Instagram erlaubt 2 200).
- **Kürzung erkennen statt weiter testen:** Endet `og:title` nicht mit `"`, gilt die Caption als möglicherweise gekürzt.
  Die Prüfansicht zeigt dann „Caption evtl. gekürzt, ggf. Text einfügen“.
- **Rezept nicht in der Caption:** Bei einem der vier Posts stand das Rezept als Rezeptkarte im letzten Karussell-Bild
  („bis zum letzten Bild wischen“). `og:image` liefert nur das erste Bild. Das LLM lieferte korrekt leere Zutaten (aber
  erfundene Portionen, Abschnitt 4). Laut Nutzer ist das bei etwa jedem dritten Post so → Phase 4.
- **Nicht stabil:** Das ist undokumentiertes Verhalten für Link-Vorschauen. Instagram kann es jederzeit ändern, deshalb
  bleibt „Text einfügen“ als Rückfall. Den User-Agent nicht in einen Browser-UA ändern (dann kommt nichts mehr).
- **Nutzungsbedingungen:** Die App liest schon heute den Titel aus derselben Seite. Die Caption als Rezept zu speichern
  geht einen Schritt weiter. Für einen privaten Haushalt bewusst akzeptiert, in `AGENTS.md` neben dem oEmbed-Absatz
  festhalten.
- Kein eigener Abruf: Die Caption kommt aus derselben Seite, die `preview.ts` schon lädt (`fetchLimited`, 1,5 MB Limit
  reicht bei 155 KB).

## 4. LLM-Test (Phase 0, Punkt 2; 05./06.10.2026)

HA-Script: Caption per `rest_command` holen, `ai_task.generate_data` mit `structure` (`servings` als `number`, die übrigen
Felder als `text`, Zutaten als JSON-Text). Prompt siehe Anhang.

| Rezept | Zeichen | LLM | Ergebnis |
|---|---|---|---|
| Hähnchen-Reis | 617 | 2,6 s | fehlerfrei (2 Läufe, im 2. ein Werbesatz im letzten Schritt) |
| Hackbällchen (Rezept im Bild) | 559 | 1,0 s | Zutaten/Schritte korrekt leer, **Portionen 4 erfunden** |
| Kürbislasagne | 1 490 | 3,9 s | Zutaten und Schritte sehr gut, Rauschen entfernt, **Portionen 3 erfunden** |
| Champignon-Bowl | 1 340 | 5,2 s | Portionen korrekt, aber **„Salz & Pfeffer“ (2×) weggelassen**, Abschnitt **„Auflerdin:“ statt „Außerdem:“**, „Knoblauchzehen“ vs. „Knoblauch“ uneinheitlich |

Bestätigt: JSON im `text`-Feld ist jedes Mal gültig, die Einheitenliste wird eingehalten, Zahlwörter werden umgewandelt,
Hashtags (auch ohne `#`), Emojis und Werbung fallen weg. Dauer 1–5 s.

**Fehlerarten und Gegenmittel:**

| Fehlerart | Gegenmittel |
|---|---|
| **Erfundene Werte** (Portionen) | LLM liefert `servings_quote` (Textstelle). Kommt sie nicht wörtlich in der Quelle vor, oder gibt es keine Zutaten, wird `servings` verworfen |
| **Verfälschter Text** („Auflerdin“) | `raw` und `section` müssen wörtlich in der Quelle vorkommen (Vergleich ohne Leerzeichen-/Aufzählungszeichen-Unterschiede). Sonst Markierung in der Prüfansicht |
| **Weggelassene Zeilen** („Salz & Pfeffer“) | Lässt sich nicht automatisch prüfen. Die Prüfansicht zeigt den Originaltext **neben** dem Entwurf, nicht nur aufklappbar |
| **Uneinheitliche Normalisierung**, Alternativen im Namen („Wasser oder Gemüsebrühe“) | Jetzt egal (`raw` bleibt). Erst bei der Einkaufsliste relevant |
| **Nicht deterministisch** (gleicher Text, leicht anderes Ergebnis) | Prüfansicht. Kein automatisches Speichern |
| Kosmetik: Nummern/Keycap-Emojis am Schrittanfang (`1.`, `1️⃣`), Doppelpunkt am Abschnittsnamen, Leerzeilen zwischen Schritten | Die App räumt auf: führende Nummerierung entfernen, `:` am Abschnittsende entfernen, leere Zeilen verwerfen |

**Verworfen:** Feld „fehlende Zutaten“ (`missing`). Einmal richtig („Salz“), einmal falsch (meldete „Salz, Pfeffer“ als
fehlend, obwohl sie in der Liste standen).

## 5. LLM-Anbindung über Home Assistant

- **Aufruf:** `POST http://supervisor/core/api/services/ai_task/generate_data?return_response` mit `SUPERVISOR_TOKEN`
  (`homeassistant_api: true` ist schon gesetzt). Laut REST-Doku liefert `?return_response` die Antwort unter
  `service_response`, das Ergebnis liegt in `service_response.data`. Ohne `entity_id` nimmt HA die bevorzugte
  AI-Task-Entität (Einstellungen → System → AI tasks).
- **Voraussetzung AI-Task-Entität:** Eine LLM-Integration (OpenAI, Anthropic, Google, …) braucht einen eigenen Untereintrag
  „AI Task“. Ein Gesprächsagent allein reicht nicht (beim Test zunächst gefehlt). README: Einrichtung beschreiben.
- **Ausgabe per `structure`:** `servings` (`number`), `servings_quote`, `ingredients` (JSON-Text), `instructions` (je
  `text`). Im Test funktioniert JSON im Textfeld zuverlässig, verschachtelte `structure` wird nicht gebraucht.
- **Neues Modul `ha-ai.ts`**, nach dem Muster von `ha-notify.ts`: festes Ziel `http://supervisor`, einfaches `fetch`, kein
  Nutzer-Input in der URL. Das ist dieselbe bewusste Ausnahme von der SSRF-Regel und in `AGENTS.md` zu ergänzen.
- **LLM-Ausgabe ist nicht vertrauenswürdig:** JSON parsen, Schema, Grenzen, Einheitenliste, Abgleich mit der Quelle
  (Abschnitt 4). Unbekannte Einheit wird zu `NULL` plus `note`. Nichts davon wird ungeprüft gespeichert, sondern geht nur
  als Entwurf in die Prüfansicht. Prompt-Injection über die Caption kann damit nur den Entwurf verfälschen, den der Nutzer
  sieht. Das LLM hat keine Tools.
- **Zeitlimit 30 s** (Test: 1–5 s), danach Fehler mit dem Hinweis „Von Hand eintragen“. Kein automatisches Wiederholen.
- **Datenschutz:** Caption bzw. Text gehen an das in HA eingerichtete Cloud-LLM. Bewusste Entscheidung, in README und UI
  kurz vermerken („Text wird an den KI-Dienst von Home Assistant geschickt“).
- **Ohne `SUPERVISOR_TOKEN`** (Entwicklung, Tests) ist die Funktion aus. Tests laufen gegen einen lokalen Fake-Supervisor.

## 6. API

| Route | Zweck |
|---|---|
| `GET /api/dishes/:id/recipe` | `{servings, ingredients[], instructions}` |
| `PUT /api/dishes/:id/recipe` | ersetzt das ganze Rezept (Transaktion). Leeres Rezept = löschen |
| `POST /api/recipe/import {url}` | Seite über `fetchLimited` laden (wie `preview.ts`, gemeinsame Analyse). Quelle in dieser Reihenfolge: schema.org-Rezept (`recipeIngredient`, `recipeInstructions` inkl. `HowToStep`/`HowToSection`, `recipeYield`), sonst Instagram-Caption aus `og:title` (Abschnitt 3). Text → LLM → **Entwurf** mit `source` (Originaltext), `maybeTruncated` und pro Zutat `verified` (Abgleich). Ohne Quelle: `{reason: "no recipe"}`, die UI bietet „Text einfügen“ an |
| `POST /api/recipe/parse {text}` | eingefügter Text → LLM → Entwurf (nicht gespeichert), gleiche Form. Text höchstens 10 000 Zeichen |
| `GET /api/recipe/status` | `{ai: true/false, reason}`. `false` ohne `SUPERVISOR_TOKEN` oder ohne `ai_task.*`-Entität (`GET /core/api/states`, gegen die REST-Doku prüfen). Die UI zeigt die LLM-Knöpfe nur bei `true`, sonst einen Hinweis zur Einrichtung |
| `GET /api/dishes?ingredient=zucchini` | Suche über `dish_ingredient.name` (`LIKE`, ohne Groß-/Kleinschreibung) |

Kein HA-Event für Rezept-Änderungen (Katalog-Änderungen feuern bewusst nichts).

## 7. UI

- **Bearbeiten-Blatt des Gerichts:** neuer Bereich „Rezept“ mit Knopf „Rezept ansehen“ bzw. „Rezept hinzufügen“. Die Zeile
  in der Liste bleibt unverändert schlank (höchstens ein kleines Symbol, wenn ein Rezept da ist).
- **Rezept-Ansicht** (eigene Ansicht, kein Blatt, sonst wird es zu eng): Portionen-Stepper, Zutaten nach Abschnitt, Schritte,
  Knöpfe „Kochmodus“ und „Bearbeiten“.
- **Erfassen:** „Aus Link übernehmen“ (Standard, wenn ein Link da ist), „Text einfügen“ und „Von Hand“. Die ersten beiden
  führen in die Prüfansicht.
- **Prüfansicht / Editor** (ein und dieselbe Ansicht): Jede Zutat ist eine Zeile mit Menge, Einheit (Auswahl) und Zutat, dazu
  die Originalzeile klein darunter. Nicht im Text gefundene Zeilen/Abschnitte sind markiert. **Originaltext daneben** bzw.
  auf dem Handy als zweiter Reiter („Entwurf | Original“), damit weggelassene Zeilen auffallen. Zeile löschen, Zeile
  hinzufügen, Schritte als Textfeld, Hinweis bei möglicherweise gekürzter Caption. Erst „Speichern“ schreibt. Auf 360 px
  ist eine Zeile mit drei Feldern eng → im Browser bei 390 px prüfen, notfalls Menge+Einheit über der Zutat.
- **Umrechnen:** `amount × (gewählte / servings)`, Rundung je Einheit (g/ml auf 5, gezählt/Zehe auf ½, EL/TL auf ½). Ohne
  `amount` wird nichts gerechnet. Ohne `servings` ist der Stepper aus. Nur Anzeige, die gespeicherten Werte bleiben.
- **Kochmodus:** große Schrift, Zutaten abhakbar (nur im Speicher, nicht gespeichert), Schritte einzeln oder als Liste,
  Bildschirm bleibt an (Wake Lock, falls Phase 0 grün, sonst stiller Rückfall).
- **Katalog:** Suchfeld findet auch Zutaten („zucchini“ zeigt alle Gerichte mit Zucchini).

## 8. Phasen (je ein PR)

### Phase 0 – Unverifiziertes klären
1. ~~Liefert der Link die Instagram-Caption?~~ **Erledigt:** ja, mit dem Bot-User-Agent der App (Abschnitt 3).
2. ~~LLM-Qualität mit echten Captions~~ **Erledigt:** reicht mit Prüfansicht und Abgleich (Abschnitt 4). Offen: 2
   Rezeptseiten (schema.org-Zeilen statt Caption).
3. ~~`structure` mit Liste von Objekten?~~ **Entschieden:** nicht nötig, JSON im `text`-Feld funktioniert.
4. `ai_task` über den **Supervisor-Proxy** (aus dem Add-on, nicht per langlebigem Token) mit `?return_response`: Kommt
   `service_response` an? Reicht `homeassistant_api`? Und `GET /core/api/states` für die Statusprüfung.
5. Wake Lock (`navigator.wakeLock.request("screen")`) in der Companion-App im Ingress-iframe. Erwartung: Der iframe hat
   denselben Origin, deshalb erlaubt die Permissions-Policy (Standard `self`) es. Unklar ist, ob die WebView die API kennt.
6. schema.org auf echten Seiten (Chefkoch & Co.): Kommt `recipeIngredient` durch oder blockt Cloudflare?
7. Für Phase 4: Wie übergibt die App ein Bild als `attachments` (`media_content_id`) an `ai_task`? Laut Doku gibt es
   Anhänge, der Weg aus einem Add-on ist ungeklärt.

### Phase 1 – Datenmodell, API und Handeingabe (`feat/rezepte`)
Migration, `repo.ts` (`getRecipe`, `setRecipe`), `GET/PUT …/recipe`, Rezept-Ansicht, Editor ohne LLM, Zutatensuche.
Tests inkl. Migration gegen eine Datenbank im alten Stand, Schema-Version in den bestehenden Tests anheben.

### Phase 2 – LLM und Import (`feat/rezept-import`)
`ha-ai.ts`, Caption-Extraktion (gemeinsam mit `preview.ts`), Abgleich mit der Quelle, Aufräumen (Nummern, Doppelpunkte),
`POST /api/recipe/import`, `/parse`, `/status`, Prüfansicht mit Entwurf und Original. Tests: Caption-Extraktion gegen
lokale Testseiten im Instagram-Format (Zeilenumbrüche, Entities, gekürzt/ungekürzt), Fake-Supervisor mit den Antworten
aus Abschnitt 4 (fehlerfrei, erfundene Portionen, „Auflerdin“, weggelassene Zeilen, kein JSON, Zeitüberschreitung, kein
Token), lokale Rezeptseite.

### Phase 3 – Umrechnen und Kochmodus (`feat/kochmodus`)
Portionen-Stepper mit Rundung (Unit-Tests für die Rundung), Kochmodus, Wake Lock je nach Ergebnis aus Phase 0.

### Phase 4 – Rezept aus Screenshot (`feat/rezept-bild`, erst nach Phase 1–3)
Für Rezepte im Bild (Rezeptkarte im Karussell, Text im Video). Screenshot hochladen → `ai_task` mit Anhang → derselbe
Entwurf und dieselbe Prüfansicht (Abgleich mit der Quelle entfällt, dafür Bild daneben). Hängt an Phase 0, Punkt 7.

## 9. Risiken

- **Instagram ändert die Auslieferung:** Dann liefert der Link keine Caption mehr, und „Text einfügen“ wird zum Hauptweg.
  Am Add-on-Protokoll erkennbar (Zeile `[preview]` bzw. eine neue Zeile für den Import).
- **LLM lässt Zeilen weg** (im Test 1 von 3 Caption-Rezepten). Nur die Prüfansicht mit Originaltext fängt das ab. Wer
  ungeprüft speichert, verliert Zutaten.
- **Abhängigkeit vom HA-KI-Dienst:** Kosten pro Aufruf (gering), Ausfall oder Modellwechsel in HA ändern das Ergebnis.
  `raw` bleibt immer erhalten.
- **Jedes dritte Instagram-Rezept** liegt im Bild. Bis Phase 4 bleibt dafür nur die Handeingabe.
- **Struktur ohne Nutzer:** Die strukturierten Felder zahlen sich erst mit Umrechnen und Einkaufsliste aus. Wird die
  Einkaufsliste nie gebaut, war `section`/`amount_max`/Einheitenliste teilweise Vorratsarbeit.
- **Handeingabe auf dem Handy** mit drei Feldern pro Zutat ist mühsam. Falls das im Alltag stört: eine Zeile tippen und die
  App zerlegt sie, als spätere Verbesserung.

## 10. Anpassungen an `AGENTS.md` (mit Phase 1/2)

- „Bewusst nicht gebaut“: „Zutaten“ streichen, „Einkaufsliste“ und „Nährwerte“ bleiben bzw. kommen dazu.
- Datenmodell um `dish_ingredient`, `servings`, `instructions` ergänzen, Einheitenregel (kein „Stück“).
- Instagram-Absatz: Caption aus `og:title` mit dem Bot-User-Agent, Kürzungserkennung, Nutzungsbedingungen, User-Agent
  nicht ändern.
- Sicherheit: `ha-ai.ts` als weitere bewusste Ausnahme neben `ha-notify.ts`/`ha-discovery.ts`, LLM-Ausgabe gilt als
  Nutzereingabe und wird gegen die Quelle abgeglichen.

## 11. Offene Punkte

- Phase 0, Punkte 2 (Rezeptseiten), 4–7.
- Soll eine bestimmte AI-Task-Entität wählbar sein (Add-on-Option) oder reicht die bevorzugte? Vorschlag: bevorzugte (YAGNI).
- `servings_quote` ist im Prompt, aber noch nicht in einem Testlauf geprüft.

## Anhang: Prompt (Stand Test, plus `servings_quote`, ohne `missing`)

```
Zerlege das folgende Rezept (meist eine Instagram-Caption) in strukturierte Daten.
Regeln:
- Nur übernehmen, was im Text steht. Nichts erfinden, nichts ergänzen.
- servings nur, wenn eine Portionszahl im Text steht. servings_quote ist dann die exakte Textstelle, sonst beides leer.
- Einheit nur aus dieser Liste: g, kg, ml, l, EL, TL, Prise, Zehe, Bund, Dose, Packung, Becher, Scheibe, Handvoll.
  Gezählte Dinge ohne Einheit ("1 Zwiebel"): unit = null. Passt sonst keine Einheit, unit = null und den Rest in note.
- Zahlwörter in Zahlen umwandeln ("Eine Zehe" -> 1). Spannen ("1-2") als amount und amount_max.
- Ignorieren: Hashtags (auch ohne #), Emojis, Werbung, Nährwerte, Hinweise zum Video.
- ingredients ist ein JSON-Array von Objekten
  {"section": string|null, "amount": number|null, "amount_max": number|null,
   "unit": string|null, "name": string, "note": string|null, "raw": string}.
  "raw" ist die Originalzeile unverändert, "section" die Zwischenüberschrift unverändert.
  Jede Zutatenzeile übernehmen, auch "Salz & Pfeffer".
- instructions: ein Schritt pro Zeile, Wortlaut möglichst erhalten. Lücken nicht füllen.
```
