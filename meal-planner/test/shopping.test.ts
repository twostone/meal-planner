import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";
import { buildShoppingList, MAX_SPEC_LENGTH, type ShoppingRecipe } from "../src/shopping.ts";

const ing = (amount: number | null, unit: string | null, name: string, amount_max: number | null = null, note: string | null = null) => ({
  amount,
  amount_max,
  unit,
  name,
  note,
});
const recipe = (title: string, ...ingredients: ShoppingRecipe["ingredients"]): ShoppingRecipe => ({ title, ingredients });
// name, note, spec, sources of every item: the part of the result the tests care about
const view = (list: ReturnType<typeof buildShoppingList>) => list.map((i) => [i.name, i.note, i.spec, i.sources]);

test("same name and unit is added up, across recipes and case", () => {
  const list = buildShoppingList([
    recipe("Suppe", ing(2, null, "Zwiebel"), ing(200, "g", "Möhren")),
    recipe("Pasta", ing(1, null, "zwiebel"), ing(150, "g", "Möhren")),
  ]);
  assert.deepEqual(view(list), [
    ["Möhren", null, "350 g", ["Suppe", "Pasta"]],
    ["Zwiebel", null, "3", ["Suppe", "Pasta"]],
  ]);
});

test("g and kg (ml and l) are added up and shown in kg from 1000 g on", () => {
  const list = buildShoppingList([
    recipe("A", ing(500, "g", "Mehl"), ing(0.5, "l", "Milch")),
    recipe("B", ing(1, "kg", "Mehl"), ing(250, "ml", "Milch")),
  ]);
  assert.deepEqual(
    list.map((i) => [i.name, i.spec]),
    [
      ["Mehl", "1,5 kg"],
      ["Milch", "750 ml"],
    ],
  );
});

test("different units stay separate parts, without amount adds nothing", () => {
  const [salz, tomaten] = buildShoppingList([
    recipe("A", ing(400, "g", "Tomaten"), ing(null, null, "Salz")),
    recipe("B", ing(1, "Dose", "Tomaten"), ing(1, "Prise", "salz")),
    recipe("C", ing(null, null, "Salz")),
  ]);
  assert.deepEqual(view([salz!, tomaten!]), [
    ["Salz", null, "1 Prise", ["A", "B", "C"]],
    ["Tomaten", null, "400 g + 1 Dose", ["A", "B"]],
  ]);
  assert.deepEqual(view(buildShoppingList([recipe("A", ing(null, null, "Pfeffer"))])), [["Pfeffer", null, null, ["A"]]]);
});

test("ranges add up their upper bound, plain amounts count for both", () => {
  const [k] = buildShoppingList([recipe("A", ing(1, "Zehe", "Knoblauch", 2)), recipe("B", ing(2, "Zehe", "Knoblauch"))]);
  assert.equal(k!.spec, "3–4 Zehe");
});

test("German decimals, no float noise, sorted by German collation", () => {
  const list = buildShoppingList([recipe("A", ing(0.1, "l", "Sahne"), ing(0.2, "l", "Sahne"), ing(1, null, "Äpfel"), ing(1, null, "Birne"), ing(1.25, "EL", "Öl"))]);
  assert.deepEqual(
    list.map((i) => [i.name, i.spec]),
    [
      ["Äpfel", "1"],
      ["Birne", "1"],
      ["Öl", "1,25 EL"],
      ["Sahne", "300 ml"],
    ],
  );
});

test("whitespace in names is normalised, the first spelling is kept", () => {
  const list = buildShoppingList([recipe("A", ing(1, null, "  rote  Zwiebel ")), recipe("B", ing(1, null, "Rote Zwiebel"))]);
  assert.deepEqual(view(list), [["rote Zwiebel", null, "2", ["A", "B"]]]);
});

test("a note goes into the spec, and different notes are different items that are not added up", () => {
  const list = buildShoppingList([
    recipe("Bowl", ing(50, "g", "Nüsse", null, "Macadamia")),
    recipe("Müsli", ing(50, "g", "Nüsse", null, "Walnuss")),
  ]);
  assert.deepEqual(view(list), [
    ["Nüsse", "Macadamia", "Macadamia, 50 g", ["Bowl"]],
    ["Nüsse", "Walnuss", "Walnuss, 50 g", ["Müsli"]],
  ]);
  assert.equal(new Set(list.map((i) => i.key)).size, 2, "the name is shared, so the key has to tell them apart");
});

test("the same note in another spelling is added up and the first spelling is kept", () => {
  const list = buildShoppingList([
    recipe("A", ing(500, "g", "Nüsse", null, "Macadamia")),
    recipe("B", ing(600, "g", "nüsse", null, "  macadamia ")),
  ]);
  assert.deepEqual(view(list), [["Nüsse", "Macadamia", "Macadamia, 1,1 kg", ["A", "B"]]]);
});

test("an ingredient without note stays apart from the same one with a note", () => {
  const list = buildShoppingList([
    recipe("A", ing(30, "g", "Nüsse")),
    recipe("B", ing(50, "g", "Nüsse", null, "Macadamia")),
    recipe("C", ing(2, null, "Zwiebel")),
    recipe("D", ing(1, null, "Zwiebel", null, "groß")),
  ]);
  assert.deepEqual(
    list.map((i) => [i.name, i.spec]),
    [
      ["Nüsse", "30 g"],
      ["Nüsse", "Macadamia, 50 g"],
      ["Zwiebel", "2"],
      ["Zwiebel", "groß, 1"],
    ],
    "sorted by name, then note; the one without note comes first",
  );
});

test("a note without amount is the whole spec; a blank note counts as none", () => {
  const list = buildShoppingList([
    recipe("A", ing(null, null, "Salz", null, "nach Geschmack"), ing(null, null, "Pfeffer", null, "   ")),
    recipe("B", ing(500, "g", "Hack", null, "gemischt"), ing(1, "kg", "Hack", null, "gemischt"), ing(2, "Dose", "Hack", null, "gemischt")),
  ]);
  assert.deepEqual(
    list.map((i) => [i.name, i.note, i.spec]),
    [
      ["Hack", "gemischt", "gemischt, 1,5 kg + 2 Dose"],
      ["Pfeffer", null, null],
      ["Salz", "nach Geschmack", "nach Geschmack"],
    ],
  );
});

test("a long note is cut to the spec limit without leaving half a character", () => {
  const note = "x".repeat(MAX_SPEC_LENGTH - 3) + "😀😀";
  const [item] = buildShoppingList([recipe("A", ing(5, "g", "Mandeln", null, note))]);
  assert.ok(item!.spec!.length <= MAX_SPEC_LENGTH);
  assert.equal(item!.spec!.toWellFormed(), item!.spec, "no lone surrogate");
  assert.equal(item!.note, note, "only the spec is cut, the note itself is kept");
});

test("the preparation (prep) does not split items: same name and note with different prep is one item", () => {
  const repo = createRepo(openDb(":memory:"));
  const plan = repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
  for (const [title, prep] of [["Salat", "in Ringen"], ["Suppe", "gewürfelt"]] as const) {
    const entry = repo.addEntry(plan.id, { title });
    repo.setRecipe(entry.dish_id, { servings: null, instructions: null, ingredients: [{ section: null, amount: 1, amount_max: null, unit: null, name: "Zwiebel", note: "rot", prep }] });
  }
  assert.deepEqual(view(buildShoppingList(repo.getPlanIngredients(plan.id))), [["Zwiebel", "rot", "rot, 2", ["Salat", "Suppe"]]]);
});

test("items are grouped by the singular and named with the first plural given", () => {
  const list = buildShoppingList([
    recipe("Suppe", { ...ing(2, null, "Zwiebel"), plural: null }),
    recipe("Salat", { ...ing(1, null, "zwiebel"), plural: "Zwiebeln" }, { ...ing(100, "g", "Mehl"), plural: null }),
  ]);
  assert.deepEqual(list.map((i) => [i.name, i.base, i.spec]), [["Mehl", "Mehl", "100 g"], ["Zwiebeln", "Zwiebel", "3"]]);
});
