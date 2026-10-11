import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, toJson } from "../src/text.ts";

test("clip: never leaves half a character at the end", () => {
  const s = "ab😀cd"; // the emoji is two UTF-16 units
  assert.equal(clip(s, 2), "ab");
  assert.equal(clip(s, 3), "ab", "cutting between the two halves drops the half");
  assert.equal(clip(s, 4), "ab😀");
  assert.equal(clip(s, 100), s);
  for (let n = 0; n <= s.length; n++) assert.ok(clip(s, n).isWellFormed(), `clip(s, ${n})`);
  assert.ok(clip(s, 3).length <= 3, "never longer than max, so the zod limits still hold");
});

test("toJson: lone surrogates become U+FFFD before serializing, everything else is unchanged", () => {
  const out = toJson({ a: "x\ud83dy", list: ["\ude02"], n: 1, ok: "Käse 😀", nested: { s: null } });
  assert.doesNotMatch(out, /\\ud[89a-f][0-9a-f]{2}/i);
  assert.deepEqual(JSON.parse(out), { a: "x�y", list: ["�"], n: 1, ok: "Käse 😀", nested: { s: null } });
  // plain JSON.stringify is the problem this avoids
  assert.match(JSON.stringify({ a: "x\ud83dy" }), /\\ud83d/);
});
