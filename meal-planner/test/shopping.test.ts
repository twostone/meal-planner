import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShoppingList, type ShoppingRecipe } from "../src/shopping.ts";

const ing = (amount: number | null, unit: string | null, name: string, amount_max: number | null = null) => ({ amount, amount_max, unit, name });
const recipe = (title: string, ...ingredients: ShoppingRecipe["ingredients"]): ShoppingRecipe => ({ title, ingredients });

test("same name and unit is added up, across recipes and case", () => {
  const list = buildShoppingList([
    recipe("Suppe", ing(2, null, "Zwiebel"), ing(200, "g", "Möhren")),
    recipe("Pasta", ing(1, null, "zwiebel"), ing(150, "g", "Möhren")),
  ]);
  assert.deepEqual(list, [
    { name: "Möhren", spec: "350 g", sources: ["Suppe", "Pasta"] },
    { name: "Zwiebel", spec: "3", sources: ["Suppe", "Pasta"] },
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
  assert.deepEqual(salz, { name: "Salz", spec: "1 Prise", sources: ["A", "B", "C"] });
  assert.deepEqual(tomaten, { name: "Tomaten", spec: "400 g + 1 Dose", sources: ["A", "B"] });
  assert.deepEqual(buildShoppingList([recipe("A", ing(null, null, "Pfeffer"))]), [{ name: "Pfeffer", spec: null, sources: ["A"] }]);
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
  assert.deepEqual(list, [{ name: "rote Zwiebel", spec: "2", sources: ["A", "B"] }]);
});
