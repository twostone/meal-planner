import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, foreignUnit } from "../src/units.ts";

test("foreignUnit: knows the English spellings, nothing else", () => {
  assert.equal(foreignUnit("cup"), "cup");
  assert.equal(foreignUnit(" Cups "), "cup");
  assert.equal(foreignUnit("Tablespoons"), "tbsp");
  assert.equal(foreignUnit("fl  oz"), "fl oz");
  assert.equal(foreignUnit("lbs"), "lb");
  assert.equal(foreignUnit("EL"), null);
  assert.equal(foreignUnit("Stück"), null);
});

test("convert: a cup of a dry ingredient becomes grams, anything else millilitres", () => {
  assert.deepEqual(convert(1, null, "cup", "Weizenmehl"), { amount: 120, amount_max: null, unit: "g" });
  assert.deepEqual(convert(0.5, null, "cup", "zucker"), { amount: 100, amount_max: null, unit: "g" }, "case and rounding to 5");
  assert.deepEqual(convert(1, null, "cup", "Milch"), { amount: 235, amount_max: null, unit: "ml" });
  assert.deepEqual(convert(1, 2, "cup", "Mehl"), { amount: 120, amount_max: 240, unit: "g" }, "ranges convert both ends");
});

test("convert: below 20 whole numbers (at least 1), spoons map to EL/TL unchanged", () => {
  assert.deepEqual(convert(0.5, null, "oz", "Hefe"), { amount: 14, amount_max: null, unit: "g" });
  assert.deepEqual(convert(0.01, null, "fl oz", "Vanille"), { amount: 1, amount_max: null, unit: "ml" });
  assert.deepEqual(convert(1, null, "lb", "Hackfleisch"), { amount: 455, amount_max: null, unit: "g" });
  assert.deepEqual(convert(2, null, "tbsp", "Öl"), { amount: 2, amount_max: null, unit: "EL" });
  assert.deepEqual(convert(0.5, 1, "tsp", "Salz"), { amount: 0.5, amount_max: 1, unit: "TL" });
  assert.deepEqual(convert(null, null, "cup", "Mehl"), { amount: null, amount_max: null, unit: "g" }, "no amount: only the unit");
});
