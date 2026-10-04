# Plan: Rezepte mit Zutaten und Zubereitung

_Stand: 03.10.2026. Grundlage: `AGENTS.md`, `src/preview.ts` und `src/safe-fetch.ts` auf `main`, HA-Doku zu `ai_task` und
zur REST-API, curl-Tests gegen Instagram (Abschnitt 3). `db.ts` und `repo.ts` wurden für diesen Plan nicht im Detail
gelesen._

## 1. Ziel und Entscheidungen (vom Nutzer)

Bisher speichert die App pro Gericht nur Titel, Link, Bild, Notiz und Kategorien. Künftig soll das ganze Rezept in der
App liegen.

- **Zweck:** Nachschlagen beim Kochen (unabhängig davon, ob Link oder Instagram-Post noch existiert), Suche nach Zutat,
  Portionen umrechnen, später Einkaufsliste.
- **Zutaten gleich strukturiert** (Menge, Einheit, Zutat), nicht als Freitext.
- **Einkaufsliste kommt nicht in diese Stufe.** Diese Stufe legt nur das Datenmodell an, auf das sie später aufbaut.
- **Quellen:** überwiegend Instagram, daneben Rezeptseiten.
- **Erfassung:** **aus dem Link** (Instagram-Caption oder schema.org-Rezept) als Hauptweg, **„Text einfügen“** als
  Rückfall, Handeingabe immer möglich.
- **Zerlegung per LLM** über die HA-Action **`ai_task.generate_data`**. Eingerichtet ist ein Cloud-LLM. Die App braucht
  keinen eigenen API-Key.
- **Prüfansicht immer vor dem Speichern.** Ohne LLM (nicht eingerichtet, Fehler, Zeitüberschreitung) bleibt die Handeingabe.
- **Zubereitungsschritte** und ein **Kochmodus** gehören dazu. Wake Lock wird vorher am Handy getestet.

## 2. Datenmodell (Migration, an `MIGRATIONS` anhängen)

```sql
ALTER TABLE dish ADD COLUMN servings INTEGER;        -- Basis für das Umrechnen, NULL = unbekannt
ALTER TABLE dish ADD COLUMN instructions TEXT;       -- Schritte, ein Schritt pro Zeile

CREATE TABLE dish_ingredient (
  id        INTEGER PRIMARY KEY,
  dish_id   INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL,          -- Reihenfolge wie im Rezept
  section   TEXT,                      -- z. B. "Für die Soße", NULL = ohne Abschnitt
  amount    REAL,                      -- NULL bei "etwas", "nach Geschmack"
  amount_max REAL,                     -- nur bei Spannen ("1–2 Zehen")
  unit      TEXT,                      -- normierte Einheit, siehe unten, NULL = Stück ohne Einheit
  name      TEXT NOT NULL,             -- "Zwiebel" (für Suche und spätere Einkaufsliste)
  note      TEXT,                      -- "fein gewürfelt", "rote"
  raw       TEXT NOT NULL              -- Originalzeile, wird nie verändert
);
CREATE INDEX dish_ingredient_dish ON dish_ingredient(dish_id, pos);
```

Begründungen:

- **`raw` immer speichern.** Ist die Struktur falsch, bleibt die Originalzeile sichtbar, und eine spätere bessere Zerlegung
  kann neu laufen. Das ist der Schutz gegen schlechte LLM-Ausgaben.
- **Schritte als Text, nicht als Tabelle.** Schritte werden nur angezeigt und nicht ausgewertet (YAGNI).
- **Rezept gehört zum Gericht** (`dish`), nicht zum Listeneintrag, und gilt also überall, wie `dish.note`.
- **Ersetzen statt Einzelupdate:** Beim Speichern ersetzt die App alle Zutaten eines Gerichts in einer Transaktion
  (wie `setTags`).
- **Einheiten:** feste Liste normierter Einheiten (`g`, `kg`, `ml`, `l`, `EL`, `TL`, `Prise`, `Stück`, `Zehe`, `Bund`,
  `Dose`, `Packung`, `Becher`, `Scheibe`, `Handvoll`). Was nicht passt, wandert mit in `note`, `unit` bleibt dann `NULL`.
  Das LLM bekommt die Liste vorgegeben. Die Normierung ist die Voraussetzung für die spätere Einkaufsliste.
- **Keine Nährwerte** (stehen oft in Captions, werden ignoriert; YAGNI, nur auf ausdrücklichen Wunsch).
- Grenzen: höchstens 60 Zutaten, `name` höchstens 80 Zeichen, `raw`/`note` höchstens 200, `instructions` höchstens 10 000
  Zeichen, `servings` 1–50.

## 3. Quelle Instagram: Caption aus dem Link (getestet 03.10.2026)

**Befund (curl, vom Heimnetz):**

| User-Agent | Antwort | Caption |
|---|---|---|
| Browser (Chrome Android) | ~629 KB JavaScript-Hülle, `<title>Instagram</title>`, keine og:-Tags | nein |
| Browser, Seite `/embed/captioned/` | dieselbe Hülle | nein |
| `facebookexternalhit/1.1` | Hülle, keine og:-Tags | nein |
| **`Mozilla/5.0 (compatible; EssensplanungBot/1.0)`** (der der App) | ~155 KB, vorgerendert, og:-Tags | **ja, vollständig** |

- Die Caption steht mit echten Zeilenumbrüchen in `og:title` (`<Name> auf Instagram: "<Caption>"`), `og:description` und
  `description` (beide mit Präfix „11K likes, 81 comments - <user> am <Datum>: "…"`). `og:title` ist die bessere Quelle
  (ohne Likes-Präfix). Die Caption ist der Text zwischen dem ersten `: "` und dem letzten `"`, nach `decodeEntities`.
- Vollständig geprüft bei 4 Reels/Posts von 4 Accounts mit 502, 692, 1 258 und 1 438 Zeichen, Pfade `/reel/`, `/reels/`
  und `/p/`. **Nicht geprüft: Captions über 1 500 Zeichen** (Instagram erlaubt 2 200).
- **Kürzung erkennen statt weiter testen:** Endet `og:title` nicht mit `"`, gilt die Caption als möglicherweise gekürzt.
  Die Prüfansicht zeigt dann „Caption evtl. gekürzt, ggf. Text einfügen“.
- **Nicht stabil:** Das ist undokumentiertes Verhalten für Link-Vorschauen. Instagram kann es jederzeit ändern, deshalb
  bleibt „Text einfügen“ als Rückfall. Den User-Agent nicht in einen Browser-UA ändern (dann kommt nichts mehr).
- **Nutzungsbedingungen:** Die App liest schon heute den Titel aus derselben Seite. Die Caption als Rezept zu speichern
  geht einen Schritt weiter. Für einen privaten Haushalt bewusst akzeptiert, in `AGENTS.md` neben dem oEmbed-Absatz
  festhalten.
- Kein eigener Abruf: Die Caption kommt aus derselben Seite, die `preview.ts` schon lädt (`fetchLimited`, 1,5 MB Limit
  reicht bei 155 KB).

**Typische Stolpersteine** (aus den getesteten Captions, Testfälle für Phase 0 und für Tests mit Fake-Supervisor):

- Zutaten mit `-`, `•` oder ohne Zeichen, Mengen als Wort („Eine Zehe“), Portionen im Fließtext („Für zwei Portionen“).
- Zutat nur in den Schritten („Salz“), Schritte lückenhaft oder mit Verweis aufs Video („so wie im Video zubereiten“).
- Rauschen: Hashtags (auch ohne `#` als Großbuchstaben-Zeilen), Emojis, Werbung („folge mir @…“), Buchstaben-Trenner,
  Nährwerte, Hinweise für Kinder zwischen den Schritten.
- Folge: Das LLM soll fehlende Zutaten aus den Schritten **nicht** ergänzen, sondern höchstens markieren, und Lücken nicht
  erfinden. Die Prüfansicht zeigt den Originaltext daneben.

## 4. LLM-Anbindung über Home Assistant

- **Aufruf:** `POST http://supervisor/core/api/services/ai_task/generate_data?return_response` mit `SUPERVISOR_TOKEN`
  (`homeassistant_api: true` ist schon gesetzt). Laut REST-Doku liefert `?return_response` die Antwort unter
  `service_response`. Ohne `entity_id` nimmt HA die bevorzugte AI-Task-Entität.
- **Ausgabe per `structure`:** Felder `servings`, `ingredients`, `instructions`. Die Doku zeigt nur `text`-Selektoren.
  **Ob verschachtelte Listen (Liste von Objekten) gehen, ist nicht dokumentiert** → Phase 0. Rückfall: ein `text`-Feld,
  das JSON enthält, das die App selbst prüft.
- **Neues Modul `ha-ai.ts`**, nach dem Muster von `ha-notify.ts`: festes Ziel `http://supervisor`, einfaches `fetch`, kein
  Nutzer-Input in der URL. Das ist dieselbe bewusste Ausnahme von der SSRF-Regel und in `AGENTS.md` zu ergänzen.
- **LLM-Ausgabe ist nicht vertrauenswürdig:** Die App prüft sie mit Schema, Grenzen und Einheitenliste. Unbekannte Einheit
  wird zu `NULL` plus `note`. Nichts davon wird ungeprüft gespeichert, sondern geht nur als Entwurf in die Prüfansicht.
  Prompt-Injection über die Caption kann damit nur den Entwurf verfälschen, den der Nutzer sieht. Das LLM hat keine Tools.
- **Zeitlimit** 45 s, danach Fehler mit dem Hinweis „Von Hand eintragen“. Kein automatisches Wiederholen.
- **Datenschutz:** Caption bzw. Text gehen an das in HA eingerichtete Cloud-LLM. Bewusste Entscheidung, in README und UI
  kurz vermerken („Text wird an den KI-Dienst von Home Assistant geschickt“).
- **Ohne `SUPERVISOR_TOKEN`** (Entwicklung, Tests) ist die Funktion aus. Tests laufen gegen einen lokalen Fake-Supervisor.

## 5. API

| Route | Zweck |
|---|---|
| `GET /api/dishes/:id/recipe` | `{servings, ingredients[], instructions}` |
| `PUT /api/dishes/:id/recipe` | ersetzt das ganze Rezept (Transaktion). Leeres Rezept = löschen |
| `POST /api/recipe/import {url}` | Seite über `fetchLimited` laden (wie `preview.ts`, gemeinsame Analyse). Quelle in dieser Reihenfolge: schema.org-Rezept (`recipeIngredient`, `recipeInstructions` inkl. `HowToStep`/`HowToSection`, `recipeYield`), sonst Instagram-Caption aus `og:title` (Abschnitt 3). Text → LLM → **Entwurf** mit `source` und `maybeTruncated`. Ohne Quelle: `{reason: "no recipe"}`, die UI bietet „Text einfügen“ an |
| `POST /api/recipe/parse {text}` | eingefügter Text → LLM → Entwurf (nicht gespeichert). Text höchstens 10 000 Zeichen |
| `GET /api/recipe/status` | `{ai: true/false}`, damit die UI die LLM-Knöpfe nur zeigt, wenn es geht |
| `GET /api/dishes?ingredient=zucchini` | Suche über `dish_ingredient.name` (`LIKE`, ohne Groß-/Kleinschreibung) |

Kein HA-Event für Rezept-Änderungen (Katalog-Änderungen feuern bewusst nichts).

## 6. UI

- **Bearbeiten-Blatt des Gerichts:** neuer Bereich „Rezept“ mit Knopf „Rezept ansehen“ bzw. „Rezept hinzufügen“. Die Zeile
  in der Liste bleibt unverändert schlank (höchstens ein kleines Symbol, wenn ein Rezept da ist).
- **Rezept-Ansicht** (eigene Ansicht, kein Blatt, sonst wird es zu eng): Portionen-Stepper, Zutaten nach Abschnitt, Schritte,
  Knöpfe „Kochmodus“ und „Bearbeiten“.
- **Erfassen:** „Aus Link übernehmen“ (Standard, wenn ein Link da ist), „Text einfügen“ und „Von Hand“. Die ersten beiden
  führen in die Prüfansicht.
- **Prüfansicht / Editor** (ein und dieselbe Ansicht): Jede Zutat ist eine Zeile mit Menge, Einheit (Auswahl) und Zutat, dazu
  die Originalzeile klein darunter. Zeile löschen, Zeile hinzufügen, Schritte als Textfeld, Originaltext aufklappbar,
  Hinweis bei möglicherweise gekürzter Caption. Erst „Speichern“ schreibt. Auf 360 px ist eine Zeile mit drei Feldern eng
  → im Browser bei 390 px prüfen, notfalls Menge+Einheit über der Zutat.
- **Umrechnen:** `amount × (gewählte / servings)`, Rundung je Einheit (g/ml auf 5, Stück/Zehe auf ½, EL/TL auf ½). Ohne
  `amount` wird nichts gerechnet. Ohne `servings` ist der Stepper aus. Nur Anzeige, die gespeicherten Werte bleiben.
- **Kochmodus:** große Schrift, Zutaten abhakbar (nur im Speicher, nicht gespeichert), Schritte einzeln oder als Liste,
  Bildschirm bleibt an (Wake Lock, falls Phase 0 grün, sonst stiller Rückfall).
- **Katalog:** Suchfeld findet auch Zutaten („zucchini“ zeigt alle Gerichte mit Zucchini).

## 7. Phasen (je ein PR)

### Phase 0 – Unverifiziertes klären
1. ~~Liefert der Link die Instagram-Caption?~~ **Erledigt:** ja, mit dem Bot-User-Agent der App, vollständig bis
   1 438 Zeichen (Abschnitt 3).
2. `ai_task.generate_data` in den Entwickler-Werkzeugen mit den 4 getesteten Captions: Qualität, Dauer, Umgang mit den
   Stolpersteinen aus Abschnitt 3. Dazu 2 Rezeptseiten.
3. `structure` mit Liste von Objekten möglich? Sonst JSON in einem `text`-Feld.
4. `ai_task` über den Supervisor-Proxy mit `?return_response`: Kommt `service_response` an? Reicht `homeassistant_api`?
5. Wake Lock (`navigator.wakeLock.request("screen")`) in der Companion-App im Ingress-iframe. Erwartung: Der iframe hat
   denselben Origin, deshalb erlaubt die Permissions-Policy (Standard `self`) es. Unklar ist, ob die WebView die API kennt.
6. schema.org auf echten Seiten (Chefkoch & Co.): Kommt `recipeIngredient` durch oder blockt Cloudflare?

### Phase 1 – Datenmodell, API und Handeingabe (`feat/rezepte`)
Migration, `repo.ts` (`getRecipe`, `setRecipe`), `GET/PUT …/recipe`, Rezept-Ansicht, Editor ohne LLM, Zutatensuche.
Tests inkl. Migration gegen eine Datenbank im alten Stand, Schema-Version in den bestehenden Tests anheben.

### Phase 2 – LLM und Import (`feat/rezept-import`)
`ha-ai.ts`, Caption-Extraktion (gemeinsam mit `preview.ts`), `POST /api/recipe/import`, `/parse`, `/status`, Prüfansicht
mit Entwurf. Tests: Caption-Extraktion gegen lokale Testseiten im Instagram-Format (mit Zeilenumbrüchen, Entities,
gekürzt/ungekürzt), Fake-Supervisor (gute Antwort, Müll, Zeitüberschreitung, kein Token), lokale Rezeptseite.

### Phase 3 – Umrechnen und Kochmodus (`feat/kochmodus`)
Portionen-Stepper mit Rundung (Unit-Tests für die Rundung), Kochmodus, Wake Lock je nach Ergebnis aus Phase 0.

## 8. Risiken

- **Instagram ändert die Auslieferung:** Dann liefert der Link keine Caption mehr, und „Text einfügen“ wird zum Hauptweg.
  Am Add-on-Protokoll erkennbar (Zeile `[preview]` bzw. eine neue Zeile für den Import).
- **LLM-Qualität:** Lückenhafte Captions bleiben lückenhaft. Das LLM darf nichts erfinden, die Prüfansicht muss Lücken
  sichtbar machen.
- **Abhängigkeit vom HA-KI-Dienst:** Kosten pro Aufruf (gering, aber vorhanden), Ausfall oder Modellwechsel in HA ändern das
  Ergebnis. `raw` bleibt immer erhalten.
- **Struktur ohne Nutzer:** Die strukturierten Felder zahlen sich erst mit Umrechnen und Einkaufsliste aus. Wird die
  Einkaufsliste nie gebaut, war `section`/`amount_max`/Einheitenliste teilweise Vorratsarbeit.
- **Handeingabe auf dem Handy** mit drei Feldern pro Zutat ist mühsam. Falls das im Alltag stört: eine Zeile tippen und die
  App zerlegt sie, als spätere Verbesserung.

## 9. Anpassungen an `AGENTS.md` (mit Phase 1/2)

- „Bewusst nicht gebaut“: „Zutaten“ streichen, „Einkaufsliste“ bleibt.
- Datenmodell um `dish_ingredient`, `servings`, `instructions` ergänzen.
- Instagram-Absatz: Caption aus `og:title` mit dem Bot-User-Agent, Kürzungserkennung, Nutzungsbedingungen, User-Agent
  nicht ändern.
- Sicherheit: `ha-ai.ts` als weitere bewusste Ausnahme neben `ha-notify.ts`/`ha-discovery.ts`, LLM-Ausgabe gilt als
  Nutzereingabe.

## 10. Offene Punkte

- Ergebnisse aus Phase 0 (Punkte 2–6).
- Soll eine bestimmte AI-Task-Entität wählbar sein (Add-on-Option) oder reicht die bevorzugte? Vorschlag: bevorzugte (YAGNI).
