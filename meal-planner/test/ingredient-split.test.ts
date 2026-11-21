import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, suggestParts } from "../src/ingredient-split.ts";
import type { Ingredient } from "../src/repo.ts";

const line = (name: string, extra: Partial<Ingredient> = {}): Ingredient => ({
  section: null,
  amount: null,
  amount_max: null,
  unit: null,
  name,
  plural: null,
  note: null,
  prep: null,
  raw: name,
  ...extra,
});
const names = (lines: Ingredient[]) => lines.map((l) => [l.section, l.name, l.note]);

test("suggestParts: splits at comma, ampersand, plus and 'und', not at 'oder'", () => {
  assert.deepEqual(suggestParts("Salz & Pfeffer"), ["Salz", "Pfeffer"]);
  assert.deepEqual(suggestParts("Salz und Pfeffer"), ["Salz", "Pfeffer"]);
  assert.deepEqual(suggestParts("Salz, Pfeffer, Vegeta, Chili & Paprika edelsüß"), ["Salz", "Pfeffer", "Vegeta", "Chili", "Paprika edelsüß"]);
  assert.deepEqual(suggestParts("Salz + Pfeffer + salz"), ["Salz", "Pfeffer"]);
  assert.deepEqual(suggestParts("Butter oder Margarine"), ["Butter oder Margarine"]);
  assert.deepEqual(suggestParts("Rundkorn-Reis"), ["Rundkorn-Reis"]); // "und" only as a word
});

test("splitLines: parts take the place of the line, without amount, keeping section and raw", () => {
  const lines = [
    line("Nudeln", { amount: 500, unit: "g", raw: "500 g Nudeln" }),
    line("Salz & Pfeffer", { amount: 1, unit: "TL", section: "Sauce", prep: "frisch", raw: "1 TL Salz & Pfeffer" }),
    line("Zwiebel"),
  ];
  const out = splitLines(lines, "salz & pfeffer", [{ name: "Salz", note: null }, { name: "Pfeffer", note: "schwarz" }]);
  assert.deepEqual(names(out), [
    [null, "Nudeln", null],
    ["Sauce", "Salz", null],
    ["Sauce", "Pfeffer", "schwarz"],
    [null, "Zwiebel", null],
  ]);
  for (const part of out.slice(1, 3)) {
    assert.deepEqual([part.amount, part.amount_max, part.unit, part.plural, part.prep, part.raw], [null, null, null, null, null, "1 TL Salz & Pfeffer"]);
  }
  assert.deepEqual(out[0], lines[0]);
});

test("splitLines: a part the recipe already has (same name, variety and section) is left out, others stay", () => {
  const lines = [line("salz"), line("Pfeffer", { note: "rosa" }), line("Salz und Pfeffer"), line("Salz", { section: "Dip" })];
  const out = splitLines(lines, "salz und pfeffer", [{ name: "Salz", note: null }, { name: "Pfeffer", note: null }]);
  assert.deepEqual(names(out), [
    [null, "salz", null],
    [null, "Pfeffer", "rosa"],
    [null, "Pfeffer", null],
    ["Dip", "Salz", null],
  ]);
});

test("splitLines: lines of other names are untouched", () => {
  const lines = [line("Salz"), line("Pfeffer")];
  assert.deepEqual(splitLines(lines, "salz & pfeffer", [{ name: "A", note: null }, { name: "B", note: null }]), lines);
});
