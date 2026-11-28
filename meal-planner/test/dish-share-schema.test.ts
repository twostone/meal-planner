import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shareFileJsonSchema } from "../src/app.ts";

test("docs/dish-export.schema.json matches the share file schema (run npm run schema after changing it)", () => {
  const checkedIn = readFileSync(new URL("../../docs/dish-export.schema.json", import.meta.url), "utf8");
  assert.equal(checkedIn, shareFileJsonSchema());
});
