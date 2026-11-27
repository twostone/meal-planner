import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../web/src/app.css", import.meta.url), "utf8");

// A token defined as itself ("--shadow: var(--shadow)") is invalid, so every rule using it silently loses the value:
// after #98 the light theme had no shadows and no dimmed backdrop behind sheets.
test("no color token refers to itself", () => {
  const selfRefs = [...css.matchAll(/--([\w-]+):\s*var\(--\1\)/g)].map((m) => m[0]);
  assert.deepEqual(selfRefs, []);
});
