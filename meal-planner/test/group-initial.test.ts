import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByInitial } from "../web/src/util.ts";

const names = (groups: { letter: string; items: string[] }[]) => groups.map((g) => [g.letter, g.items]);

// localeCompare("de") sorts umlauts between the base letters (Obst, Öl, Orange): grouping by the raw first letter gave
// O, Ö, O, a duplicate key that made Svelte's keyed {#each} throw and the whole list stay empty.
test("umlauts go to their base letter, every letter once, sorted as in German", () => {
  const groups = groupByInitial(["Orange", "Öl", "Obst", "Äpfel", "Apfel", "7-Kräuter", "ei"], (n) => n);
  assert.deepEqual(names(groups), [
    ["#", ["7-Kräuter"]],
    ["A", ["Apfel", "Äpfel"]],
    ["E", ["ei"]],
    ["O", ["Obst", "Öl", "Orange"]],
  ]);
  assert.equal(new Set(groups.map((g) => g.letter)).size, groups.length);
});

test("works on objects and leaves the input untouched", () => {
  const dishes = [{ title: "Ölkuchen" }, { title: "Ofengemüse" }];
  const groups = groupByInitial(dishes, (d) => d.title);
  assert.deepEqual(groups.map((g) => [g.letter, g.items.map((d) => d.title)]), [["O", ["Ofengemüse", "Ölkuchen"]]]);
  assert.deepEqual(dishes.map((d) => d.title), ["Ölkuchen", "Ofengemüse"]);
  assert.deepEqual(groupByInitial([], (n: string) => n), []);
});
