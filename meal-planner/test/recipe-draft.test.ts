import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, DraftError, normalizeForCompare } from "../src/recipe-draft.ts";

const SOURCE = `Hähnchen-Reis 🍗
Für 4 Personen

Zutaten:
• 400 g Hähnchenbrust
• 1-2 Zehen Knoblauch
• 1 Zwiebel
• Salz & Pfeffer

Außerdem:
2 EL Olivenöl
1 Bund Petersilie

1️⃣ Zwiebel schneiden
2️⃣ Alles anbraten #food`;

const ing = (over: object = {}) => ({ section: null, amount: 400, amount_max: null, unit: "g", name: "Hähnchenbrust", note: null, raw: "400 g Hähnchenbrust", ...over });
const raw = (over: object = {}) => ({
  servings: 4,
  servings_quote: "Für 4 Personen",
  ingredients: JSON.stringify([ing()]),
  instructions: "Zwiebel schneiden\nAlles anbraten",
  ...over,
});

test("a faithful answer is fully verified; bullets and spacing in the source do not matter", () => {
  const d = buildDraft(
    raw({
      ingredients: JSON.stringify([
        ing({ raw: "• 400 g Hähnchenbrust" }),
        ing({ amount: 1, amount_max: 2, unit: "Zehe", name: "Knoblauch", raw: "1-2 Zehen Knoblauch" }),
        ing({ section: "Außerdem:", amount: 2, unit: "EL", name: "Olivenöl", raw: "2 EL Olivenöl" }),
      ]),
    }),
    SOURCE,
  );
  assert.deepEqual(d.ingredients.map((i) => i.verified), [true, true, true]);
  assert.equal(d.ingredients[2]!.section, "Außerdem", "colon at the end of a section is removed");
  assert.equal(d.servings, 4);
});

test("invented servings are dropped: no quote, a quote that is not in the text, or no ingredients", () => {
  assert.equal(buildDraft(raw({ servings_quote: "" }), SOURCE).servings, null);
  assert.equal(buildDraft(raw({ servings_quote: "Für 6 Personen" }), SOURCE).servings, null);
  assert.equal(buildDraft(raw({ ingredients: "[]" }), SOURCE).servings, null);
  assert.equal(buildDraft(raw({ servings: 0 }), SOURCE).servings, null);
  assert.equal(buildDraft(raw({ servings: 2.5 }), SOURCE).servings, null);
  assert.equal(buildDraft(raw({ servings: 99 }), SOURCE).servings, null);
});

test("a distorted line or section is marked unverified, the rest stays verified", () => {
  const d = buildDraft(
    raw({ ingredients: JSON.stringify([ing(), ing({ section: "Auflerdin", name: "Olivenöl", raw: "2 EL Olivenöl" }), ing({ raw: "300 g Hähnchenbrust" })]) }),
    SOURCE,
  );
  assert.deepEqual(d.ingredients.map((i) => i.verified), [true, false, false]);
});

test("units: only the fixed list (case-insensitive); anything else goes into the note", () => {
  const d = buildDraft(
    raw({ ingredients: JSON.stringify([ing({ unit: "el" }), ing({ unit: "Stück", note: "groß" }), ing({ unit: "Messerspitze", note: null }), ing({ unit: "" })]) }),
    SOURCE,
  );
  assert.deepEqual(d.ingredients.map((i) => [i.unit, i.note]), [["EL", null], [null, "Stück, groß"], [null, "Messerspitze"], [null, null]]);
});

test("amounts: invalid or inconsistent values become null", () => {
  const d = buildDraft(
    raw({ ingredients: JSON.stringify([ing({ amount: "viel" }), ing({ amount: -3 }), ing({ amount: 3, amount_max: 2 }), ing({ amount: null, amount_max: 2 }), ing({ amount: 1, amount_max: 2 })]) }),
    SOURCE,
  );
  assert.deepEqual(d.ingredients.map((i) => [i.amount, i.amount_max]), [[null, null], [null, null], [3, null], [null, null], [1, 2]]);
});

test("entries without a name are dropped, text is limited, at most 60 ingredients", () => {
  const d = buildDraft(raw({ ingredients: JSON.stringify([ing({ name: " " }), "x", null, ing({ name: "n".repeat(200), raw: "r".repeat(500) })]) }), SOURCE);
  assert.equal(d.ingredients.length, 1);
  assert.equal(d.ingredients[0]!.name.length, 80);
  assert.equal(d.ingredients[0]!.raw.length, 200);
  assert.equal(buildDraft(raw({ ingredients: JSON.stringify(Array.from({ length: 80 }, () => ing())) }), SOURCE).ingredients.length, 60);
});

test("steps: numbering, keycap emojis and empty lines are removed", () => {
  const d = buildDraft(raw({ instructions: "1. Zwiebel schneiden\n\n2️⃣ Alles anbraten\n- Servieren\n  \n3) Essen" }), SOURCE);
  assert.equal(d.instructions, "Zwiebel schneiden\nAlles anbraten\nServieren\nEssen");
  assert.equal(buildDraft(raw({ instructions: "" }), SOURCE).instructions, null);
  assert.equal(buildDraft(raw({ instructions: undefined }), SOURCE).instructions, null);
});

test("ingredients as a code-fenced string or a real array work; garbage throws DraftError", () => {
  assert.equal(buildDraft(raw({ ingredients: "```json\n" + JSON.stringify([ing()]) + "\n```" }), SOURCE).ingredients.length, 1);
  assert.equal(buildDraft(raw({ ingredients: [ing()] }), SOURCE).ingredients.length, 1);
  assert.equal(buildDraft(raw({ ingredients: "" }), SOURCE).ingredients.length, 0);
  for (const bad of ["not json", '{"a":1}', 5, undefined]) assert.throws(() => buildDraft(raw({ ingredients: bad }), SOURCE), DraftError, String(bad));
});

test("normalizeForCompare keeps letters and case", () => {
  assert.equal(normalizeForCompare("• 2  EL\tÖl:"), "2ELÖl");
  assert.notEqual(normalizeForCompare("Außerdem"), normalizeForCompare("Auflerdin"));
});
