import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtAmount, groupBySection, ingredientText, parseAmount, stepLines } from "../web/src/recipe.ts";

test("parseAmount: comma, dot, range, empty, garbage", () => {
  assert.deepEqual(parseAmount("1,5"), { amount: 1.5, amount_max: null });
  assert.deepEqual(parseAmount(" 2.25 "), { amount: 2.25, amount_max: null });
  assert.deepEqual(parseAmount("1-2"), { amount: 1, amount_max: 2 });
  assert.deepEqual(parseAmount("1 – 2,5"), { amount: 1, amount_max: 2.5 });
  assert.deepEqual(parseAmount(""), { amount: null, amount_max: null });
  for (const bad of ["abc", "2-1", "1,", "-3", "1/2"]) assert.equal(parseAmount(bad), undefined, bad);
});

test("fmtAmount and ingredientText use the German comma", () => {
  const i = { section: null, amount: 1.5, amount_max: null, unit: "l", name: "Wasser", note: null, raw: "" };
  assert.equal(fmtAmount(i), "1,5");
  assert.equal(ingredientText(i), "1,5 l Wasser");
  assert.equal(ingredientText({ ...i, amount: 1, amount_max: 2, unit: "Zehe", name: "Knoblauch" }), "1–2 Zehe Knoblauch");
  assert.equal(ingredientText({ ...i, amount: null, unit: null, name: "Salz" }), "Salz");
});

test("groupBySection groups neighbours with the same section", () => {
  const mk = (section: string | null, name: string) => ({ section, amount: null, amount_max: null, unit: null, name, note: null, raw: name });
  const g = groupBySection([mk(null, "a"), mk(null, "b"), mk("Dip", "c"), mk(null, "d")]);
  assert.deepEqual(g.map((x) => [x.section, x.items.map((i) => i.name)]), [[null, ["a", "b"]], ["Dip", ["c"]], [null, ["d"]]]);
});

test("stepLines: non-empty trimmed lines (the server splits the same way)", () => {
  assert.deepEqual(stepLines("Schneiden.\n\n  Kochen.\nServieren.\n"), ["Schneiden.", "Kochen.", "Servieren."]);
  assert.deepEqual(stepLines(null), []);
});
