# Umbauplan: Zutaten vereinheitlichen

_Stand: 17.10.2026. PR 1 (Import) und PR 2 (Bestand) gebaut._

## 1. Entscheidungen (17.10.2026)

| Thema | Entscheidung |
|---|---|
| Was | Zutatennamen vereinheitlichen und fremde Einheiten umrechnen |
| Anlass | uneinheitliche Anzeige, Vorbereitung der Einkaufsliste |
| Original | strukturierte Felder werden ersetzt (`raw` bleibt wie bisher immer erhalten) |
| Name | Grundform Singular, auch wenn die Anzeige dann „3 Zwiebel“ lautet |
| Zusätze | alles aus dem Namen raus: Sorte nach `note`, Zubereitung in neues Feld `prep` (zwei Spalten, kein 1:n) |
| Umrechnung | Volumen nach ml, trockene Zutaten nach g (Dichte je Zutat) |
| Wer | KI beim Import, mit Liste der vorhandenen Namen (im Prompt-Text) |
| Bestand | auf Knopfdruck, mit Vorschau; Knopf im Katalog |
| Zutatensuche | Präfix-Regel für Plural plus Autocomplete (natives `<datalist>`), keine Fuzzy-Suche |

## 2. Ist-Zustand vor dem Umbau

- `dish_ingredient`: `amount`, `amount_max`, `unit`, `name`, `note`, `raw`. `raw` ist die Originalzeile und bleibt immer.
- Die Anzeige baut die Zeile aus Menge, Einheit und Name, nicht aus `raw`: normalisierte Namen wirken sofort sichtbar.
- Fremde Einheiten landeten in `buildDraft` in der Notiz. Aus „1 cup Mehl“ wurde Menge 1 ohne Einheit, Notiz „cup“, die
  Einkaufsliste zählte das als „1“ (Fehler, mit PR 1 behoben).
- `shopping.ts` gruppiert nach Name + Notiz und führt Synonyme bewusst nicht zusammen. Das bleibt so.
- `setRecipe` löscht die Kochmodus-Haken des Gerichts. Der Bestand-Umbau läuft deshalb nicht über `setRecipe`.

## 3. PR 1 – Zutaten beim Import vereinheitlichen (gebaut)

- Migration v10: `dish_ingredient.prep`. `note` = Sorte (kaufrelevant), `prep` = Zubereitung (für den Einkauf egal).
- `src/units.ts`: cup (US, 236,588 ml), tbsp -> EL, tsp -> TL, fl oz (29,574 ml), oz (28,35 g), lb (453,592 g);
  Dichtetabelle g/Cup nach King Arthur Baking (Ingredient Weight Chart, gelesen 17.10.2026). Runden: unter 20 ganzzahlig,
  darüber auf 5.
- Prompt: Grundform Singular, Sorte/Zubereitung getrennt, englische Einheiten unverändert, Liste der vorhandenen Namen
  (höchstens 300) im Prompt-Text.
- Editor: Felder „Sorte“ und „Zubereitung“, im Entwurf die Originalzeile unter jeder Zutat.
- Suche: `matchesIngredient` (Präfix, höchstens 2 fehlende Zeichen), `GET /api/ingredients/names` für das `<datalist>`.

## 4. PR 2 – vorhandene Zutaten vereinheitlichen (gebaut)

1. **Vorschau, schreibt nichts:** `POST /api/ingredients/normalize/preview` mit bis zu 80 eindeutigen Paaren (`name`,
   `note`). KI-Task `meal_planner_normalize` gibt je Paar `{name, note, prep}` zurück. Der Client ruft blockweise
   nacheinander auf und zeigt den Fortschritt (keine minutenlange Anfrage durch den Ingress).
2. **Einheiten im Bestand per Code:** Zeilen mit `unit = null`, deren Notiz mit einer fremden Einheit beginnt, werden über
   `units.ts` umgerechnet, der Rest der Notiz bleibt.
3. **Vorschau-Blatt:** „vorher -> nachher“ mit Anzahl Gerichte, je Änderung abwählbar. Hinweis: vorher HA-Backup anlegen.
4. **Anwenden:** eine Transaktion, Bedingung auf die alten Werte (veraltete Vorschau ändert nichts). `pos`, `raw` und die
   Kochmodus-Haken bleiben.

## 5. Phase 0

1. Prompt am echten Modell mit 3 Captions testen (eine englische mit cups): Werden Namen wiederverwendet? Trennt das Modell
   Sorte und Zubereitung sauber? **Offen.**
2. Laufzeit eines Normalisierungs-Blocks mit 80 Paaren messen (reichen 30 s?). **Offen.**
3. Dichtewerte gegen eine Quelle prüfen. **Erledigt** (King Arthur, siehe `units.ts`).
4. Zeigt die Prüfansicht `raw`? **Nein**, nur den Originaltext aufgeklappt. Mit PR 1 steht `raw` unter jeder Entwurfszeile.
5. Zutaten-Suchfeld im Katalog: **ein** gemeinsames Feld für Titel und Zutat, keine Vorschlagsliste. Daher `<datalist>`.

## 6. Risiken

- **Falsches Zusammenlegen** (Sahne/Schmand): Prüfansicht beim Import, abwählbare Vorschau beim Bestand. Rückweg nur über
  `raw` per Hand.
- **Suche:** Umlaut-Plurale („äpfel“, „nüsse“) findet die Präfix-Regel nicht, dafür das Autocomplete. Ein kurzer Name trifft
  längere Suchen mit gleichem Anfang („Ei“ trifft „eis“), hingenommen.
- **cup ist mehrdeutig:** US 237 ml, AU 250 ml, UK 284 ml. Gewählt US. Fehler bis ca. 6 % (AU), bei UK bis ca. 20 %.
- **Dichte ist ungenau:** Mehl ±20 % je nach Füllweise. Zutaten außerhalb der Tabelle werden ml.
- **Keine Bibliothek:** `easy-cook` braucht die Dichte selbst, `@jclind/ingredient-unit-converter` kennt nur englische
  Zutaten (geprüft 17.10.2026). Fuse.js für die Suche verworfen (Fehltreffer Reis/Eis, neue Abhängigkeit).

## 7. Später

- **Namensliste als Datei-Anhang** statt im Prompt-Text (`attachments` von `ai_task.generate_data`). Laut HA-Quellcode
  (`ai_task/task.py`, `google_generative_ai_conversation/entity.py`, gelesen 17.10.2026) müssen Nicht-Bilder über Media
  Source auf eine lokale Datei auflösen: Die App bräuchte `map: media:rw` (neue Berechtigung) und müsste die Datei nach
  `/media` schreiben. Die Entität braucht `SUPPORT_ATTACHMENTS`; Gemini lädt die Datei über die Files API hoch (Zusatzzeit).
  Bei 300 Namen (rund 3 000 Zeichen) lohnt sich das derzeit nicht.

## 8. Bewusst nicht gebaut (YAGNI)

Hinweise als 1:n-Tabelle, Fuzzy-Suche, Stemming-Bibliothek, Synonym-Wörterbuch, Plural in der Anzeige, Umrechnung von
EL/TL in g, Rückgängig-Funktion für den Bestand-Umbau (stattdessen HA-Backup).
