import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aiEntities, readAddonOptions } from "../src/options.ts";

test("readAddonOptions: the parsed file, {} without a file, for broken JSON or a non-object", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "options-"));
  try {
    const file = path.join(dir, "options.json");
    await writeFile(file, JSON.stringify({ log_level: "debug", ai_entity_recipe: "ai_task.x" }));
    assert.deepEqual(readAddonOptions(file), { log_level: "debug", ai_entity_recipe: "ai_task.x" });
    assert.deepEqual(readAddonOptions(path.join(dir, "missing.json")), {});
    await writeFile(file, "{ not json");
    assert.deepEqual(readAddonOptions(file), {});
    await writeFile(file, "[1]");
    assert.deepEqual(readAddonOptions(file), {});
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("aiEntities: trimmed ids, unset or empty -> null (Home Assistant's preferred entity)", () => {
  assert.deepEqual(aiEntities({}), { recipe: null, titles: null });
  assert.deepEqual(aiEntities({ ai_entity_recipe: " ai_task.a ", ai_entity_titles: "ai_task.b" }), { recipe: "ai_task.a", titles: "ai_task.b" });
  assert.deepEqual(aiEntities({ ai_entity_recipe: "", ai_entity_titles: 3 }), { recipe: null, titles: null });
});
