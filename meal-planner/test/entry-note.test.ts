import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb, SCHEMA_V1 } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

function setup() {
  const app = createApp(createRepo(openDb(":memory:")));
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

async function twoPlansOneDish(call: ReturnType<typeof setup>) {
  const p1 = (await call("POST", "/api/plans", { start_date: "2026-09-26", end_date: "2026-10-01" })).json;
  const p2 = (await call("POST", "/api/plans", { start_date: "2026-10-03", end_date: "2026-10-08" })).json;
  const dish = (await call("POST", "/api/dishes", { title: "Lasagne", note: "Rezept von Oma" })).json;
  const e1 = (await call("POST", `/api/plans/${p1.id}/entries`, { dish_id: dish.id })).json;
  const e2 = (await call("POST", `/api/plans/${p2.id}/entries`, { dish_id: dish.id })).json;
  return { p1, p2, dish, e1, e2 };
}

test("entries have no note by default", async () => {
  const call = setup();
  const { e1 } = await twoPlansOneDish(call);
  assert.equal(e1.note, null);
});

test("the note belongs to one entry only: the same dish in another plan is unaffected", async () => {
  const call = setup();
  const { p1, p2, dish, e1 } = await twoPlansOneDish(call);
  const r = await call("PATCH", `/api/entries/${e1.id}`, { note: "  doppelte Portion  " });
  assert.equal(r.status, 200);
  assert.equal(r.json.note, "doppelte Portion");
  assert.equal((await call("GET", `/api/plans/${p1.id}`)).json.entries[0].note, "doppelte Portion");
  assert.equal((await call("GET", `/api/plans/${p2.id}`)).json.entries[0].note, null);
  // the note of the dish itself is a different field and stays as it was
  assert.equal((await call("GET", "/api/dishes")).json[0].note, "Rezept von Oma");
  assert.equal(dish.note, "Rezept von Oma");
});

test("PATCH: note is kept when only done changes, and cleared by \"\" or null", async () => {
  const call = setup();
  const { e1 } = await twoPlansOneDish(call);
  await call("PATCH", `/api/entries/${e1.id}`, { note: "ohne Käse" });
  assert.equal((await call("PATCH", `/api/entries/${e1.id}`, { done: true })).json.note, "ohne Käse");
  assert.equal((await call("PATCH", `/api/entries/${e1.id}`, { note: "" })).json.note, null);
  await call("PATCH", `/api/entries/${e1.id}`, { note: "x" });
  assert.equal((await call("PATCH", `/api/entries/${e1.id}`, { note: null })).json.note, null);
});

test("note validation: too long is rejected, unknown entry is 404", async () => {
  const call = setup();
  const { e1 } = await twoPlansOneDish(call);
  assert.equal((await call("PATCH", `/api/entries/${e1.id}`, { note: "x".repeat(1001) })).status, 400);
  assert.equal((await call("PATCH", `/api/entries/999`, { note: "x" })).status, 404);
});

test("a new entry for the same dish starts without the old note (removing and re-adding)", async () => {
  const call = setup();
  const { p1, dish, e1 } = await twoPlansOneDish(call);
  await call("PATCH", `/api/entries/${e1.id}`, { note: "nur diesmal" });
  await call("DELETE", `/api/entries/${e1.id}`);
  const again = await call("POST", `/api/plans/${p1.id}/entries`, { dish_id: dish.id });
  assert.equal(again.json.note, null);
});

test("migration v3 -> v4 keeps entries and adds the note column", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v3.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_V1);
    old.exec("ALTER TABLE dish ADD COLUMN image TEXT");
    old.exec(`CREATE TABLE dish_tag (
      dish_id INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
      tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0),
      PRIMARY KEY (dish_id, tag)
    ) STRICT; CREATE INDEX dish_tag_tag ON dish_tag(tag);`);
    old.exec("PRAGMA user_version = 3");
    old.exec("INSERT INTO dish (title) VALUES ('Linsensuppe')");
    old.exec("INSERT INTO plan (start_date, end_date) VALUES ('2026-09-26', '2026-10-01')");
    old.exec("INSERT INTO plan_entry (plan_id, dish_id, position, done) VALUES (1, 1, 0, 1)");
    old.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    const repo = createRepo(db);
    const [entry] = repo.getPlan(1).entries;
    assert.deepEqual([entry!.dish.title, entry!.done, entry!.note], ["Linsensuppe", true, null]);
    assert.equal(repo.updateEntry(entry!.id, { note: "ok" }).note, "ok");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
