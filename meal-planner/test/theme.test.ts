import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTheme } from "../web/src/theme.ts";

// A stored value from an older or tampered localStorage must never break the page: anything unknown means "auto".
test("parseTheme keeps light and dark and falls back to auto", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme(null), "auto");
  assert.equal(parseTheme("auto"), "auto");
  assert.equal(parseTheme("blue"), "auto");
});
