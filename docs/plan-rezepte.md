# Plan: Rezepte mit Zutaten und Zubereitung

_Stand: 03.10.2026. Grundlage: `AGENTS.md` auf `main`, HA-Doku zu `ai_task` und zur REST-API. Code von `db.ts`, `repo.ts`
und `preview.ts` wurde für diesen Plan nicht im Detail gelesen._

## 1. Ziel und Entscheidungen (vom Nutzer)

Bisher speichert die App pro Gericht nur Titel, Link, Bild, Notiz und Kategorien. Künftig soll das ganze Rezept in der
App liegen.

- **Zweck:** Nachschlagen beim Kochen (unabhängig davon, ob Link oder Instagram-Post noch existiert), Suche nach Zutat,
  Portionen umrechnen, später Einkaufsliste.
- **Zutaten gleich strukturiert** (Menge, Einheit, Zutat), nicht als Freitext.
- **Einkaufsliste kommt nicht in diese Stufe.** Diese Stufe legt nur das Datenmodell an, auf das sie später aufbaut.
- **Erfassung:** Import aus Rezeptseiten (schema.org) und „Text einfügen“ (vor allem Instagram-Captions). Die Gerichte
  kommen **überwiegend von Instagram**, der Text-Weg ist also der Hauptweg.
- **Zerlegung per LLM**, und zwar über die HA-Action **`ai_task.generate_data`**. Eingerichtet ist ein Cloud-LLM. Die App
  braucht damit keinen eigenen API-Key.
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
- **Schritte als Text, nicht als Tabelle.** Schritte werden nur angezeigt und nicht ausgewertet (YAGNI). Aufzählungen im
  Kochmodus entstehen aus den Zeilen.
- **Rezept gehört zum Gericht** (`dish`), nicht zum Listeneintrag, und gilt also überall, wie `dish.note`.
- **Ersetzen statt Einzelupdate:** Beim Speichern ersetzt die App alle Zutaten eines Gerichts in einer Transaktion
  (wie `setTags`). Keine Zeilen-IDs im UI nötig.
- **Einheiten:** feste Liste normierter Einheiten (`g`, `kg`, `ml`, `l`, `EL`, `TL`, `Prise`, `Stück`, `Zehe`, `Bund`,
  `Dose`, `Packung`, `Becher`, `Scheibe`, `Handvoll`). Was nicht passt, wandert mit in `note`, `unit` bleibt dann `NULL`.
  Das LLM bekommt die Liste vorgegeben. Die Normierung ist die Voraussetzung für die spätere Einkaufsliste.
- Grenzen: höchstens 60 Zutaten, `name` höchstens 80 Zeichen, `raw`/`note` höchstens 200, `instructions` höchstens 10 000
  Zeichen, `servings` 1–50.

## 3. LLM-Anbindung über Home Assistant

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
- **Datenschutz:** Der eingefügte Text geht an das in HA eingerichtete Cloud-LLM. Das ist eine bewusste Entscheidung,
  in README und UI kurz vermerken („Text wird an den KI-Dienst von Home Assistant geschickt“).
- **Ohne `SUPERVISOR_TOKEN`** (Entwicklung, Tests) ist die Funktion aus. Tests laufen gegen einen lokalen Fake-Supervisor.

## 4. API

| Route | Zweck |
|---|---|
| `GET /api/dishes/:id/recipe` | `{servings, ingredients[], instructions}` |
| `PUT /api/dishes/:id/recipe` | ersetzt das ganze Rezept (Transaktion). Leeres Rezept = löschen |
| `POST /api/recipe/parse {text}` | Text → LLM → **Entwurf** (wird nicht gespeichert). Text höchstens 10 000 Zeichen |
| `POST /api/recipe/import {url}` | Seite über `fetchLimited` laden, schema.org `recipeIngredient`, `recipeInstructions` (inkl. `HowToStep`/`HowToSection`) und `recipeYield` lesen, die Zutatenzeilen durchs LLM strukturieren → Entwurf. Ohne schema.org-Rezept: `{reason: "no recipe"}`, die UI bietet „Text einfügen“ an |
| `GET /api/recipe/status` | `{ai: true/false}`, damit die UI die LLM-Knöpfe nur zeigt, wenn es geht |
| `GET /api/dishes?ingredient=zucchini` | Suche über `dish_ingredient.name` (`LIKE`, ohne Groß-/Kleinschreibung) |

Kein HA-Event für Rezept-Änderungen (Katalog-Änderungen feuern bewusst nichts).

## 5. UI

- **Bearbeiten-Blatt des Gerichts:** neuer Bereich „Rezept“ mit Knopf „Rezept ansehen“ bzw. „Rezept hinzufügen“. Die Zeile
  in der Liste bleibt unverändert schlank (höchstens ein kleines Symbol, wenn ein Rezept da ist).
- **Rezept-Ansicht** (eigene Ansicht, kein Blatt, sonst wird es zu eng): Portionen-Stepper, Zutaten nach Abschnitt, Schritte,
  Knöpfe „Kochmodus“ und „Bearbeiten“.
- **Erfassen:** drei Wege mit Einstieg „Aus Link übernehmen“ (nur wenn ein Link da ist), „Text einfügen“ und „Von Hand“.
  Die ersten beiden führen in die Prüfansicht.
- **Prüfansicht / Editor** (ein und dieselbe Ansicht): Jede Zutat ist eine Zeile mit Menge, Einheit (Auswahl) und Zutat, dazu
  die Originalzeile klein darunter. Zeile löschen, Zeile hinzufügen, Schritte als Textfeld. Erst „Speichern“ schreibt.
  Auf 360 px ist eine Zeile mit drei Feldern eng → im Browser bei 390 px prüfen, notfalls Menge+Einheit über der Zutat.
- **Umrechnen:** `amount × (gewählte / servings)`, Rundung je Einheit (g/ml auf 5, Stück/Zehe auf ½, EL/TL auf ½). Ohne
  `amount` wird nichts gerechnet. Ohne `servings` ist der Stepper aus. Nur Anzeige, die gespeicherten Werte bleiben.
- **Kochmodus:** große Schrift, Zutaten abhakbar (nur im Speicher, nicht gespeichert), Schritte einzeln oder als Liste,
  Bildschirm bleibt an (Wake Lock, falls Phase 0 grün, sonst stiller Rückfall).
- **Katalog:** Suchfeld findet auch Zutaten („zucchini“ zeigt alle Gerichte mit Zucchini).

## 6. Phasen (je ein PR)

### Phase 0 – Unverifiziertes am echten System klären (Wegwerf-Version oder Entwickler-Werkzeuge in HA)
1. `ai_task.generate_data` über den Supervisor-Proxy mit `?return_response`: Kommt `service_response` an? Welche Rolle braucht
   das Add-on (reicht `homeassistant_api`)?
2. `structure` mit Liste von Objekten (z. B. `object`-Selektor, `multiple`) möglich? Sonst JSON in einem `text`-Feld.
3. Qualität und Dauer mit **5 echten Instagram-Captions** und 2 Rezeptseiten (Entwickler-Werkzeuge → Aktionen genügt dafür).
4. Wake Lock (`navigator.wakeLock.request("screen")`) in der Companion-App (Android/iOS) im Ingress-iframe. Erwartung: Der
   iframe hat denselben Origin, deshalb erlaubt die Permissions-Policy (Standard `self`) es. Unklar ist, ob die WebView die
   API kennt.
5. schema.org auf echten Seiten (Chefkoch & Co.): Kommt `recipeIngredient` durch oder blockt Cloudflare?

### Phase 1 – Datenmodell, API und Handeingabe (`feat/rezepte`)
Migration, `repo.ts` (`getRecipe`, `setRecipe`), `GET/PUT …/recipe`, Rezept-Ansicht, Editor ohne LLM, Zutatensuche.
Tests inkl. Migration gegen eine Datenbank im alten Stand, Schema-Version in den bestehenden Tests anheben.

### Phase 2 – LLM und Import (`feat/rezept-import`)
`ha-ai.ts`, `POST /api/recipe/parse`, `/import`, `/status`, Prüfansicht mit Entwurf. Tests gegen einen Fake-Supervisor
(gute Antwort, Müll, Zeitüberschreitung, kein Token) und gegen eine lokale Rezeptseite.

### Phase 3 – Umrechnen und Kochmodus (`feat/kochmodus`)
Portionen-Stepper mit Rundung (Unit-Tests für die Rundung), Kochmodus, Wake Lock je nach Ergebnis aus Phase 0.

## 7. Risiken

- **LLM-Qualität bei Captions:** Zutaten stehen oft im Fließtext oder nur im Video. Dann liefert auch das LLM wenig, und es
  bleibt die Handeingabe. Phase 0, Punkt 3 zeigt, wie oft das passiert.
- **Abhängigkeit vom HA-KI-Dienst:** Kosten pro Aufruf (gering, aber vorhanden), Ausfall oder Modellwechsel in HA ändern das
  Ergebnis. `raw` bleibt immer erhalten.
- **Struktur ohne Nutzer:** Die strukturierten Felder zahlen sich erst mit Umrechnen und Einkaufsliste aus. Wird die
  Einkaufsliste nie gebaut, war `section`/`amount_max`/Einheitenliste teilweise Vorratsarbeit.
- **Handeingabe auf dem Handy** mit drei Feldern pro Zutat ist mühsam. Falls das im Alltag stört: eine Zeile tippen und die
  App zerlegt sie (per LLM oder einfacher Regel), als spätere Verbesserung.

## 8. Anpassungen an `AGENTS.md` (mit Phase 1/2)

- „Bewusst nicht gebaut“: „Zutaten“ streichen, „Einkaufsliste“ bleibt.
- Datenmodell um `dish_ingredient`, `servings`, `instructions` ergänzen.
- Sicherheit: `ha-ai.ts` als zweite bewusste Ausnahme neben `ha-notify.ts`/`ha-discovery.ts`, LLM-Ausgabe gilt als
  Nutzereingabe.

## 9. Offene Punkte

- Ergebnisse aus Phase 0.
- Soll eine bestimmte AI-Task-Entität wählbar sein (Add-on-Option) oder reicht die bevorzugte? Vorschlag: bevorzugte (YAGNI).
- Bild aus der Caption/dem Video ist nicht Teil dieses Plans (Vorschaubild gibt es bereits).
