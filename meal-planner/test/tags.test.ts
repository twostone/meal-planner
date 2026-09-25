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

test("dishes have no tags by default and can be created with tags", async () => {
  const call = setup();
  assert.deepEqual((await call("POST", "/api/dishes", { title: "Pizza" })).json.tags, []);
  const d = await call("POST", "/api/dishes", { title: "Nüsse", tags: ["Snack", "Vegan"] });
  assert.equal(d.status, 201);
  assert.deepEqual(d.json.tags, ["Snack", "Vegan"]);
  assert.deepEqual((await call("GET", "/api/dishes")).json.map((x: any) => x.tags), [["Snack", "Vegan"], []]);
});

test("tags are trimmed, deduplicated case-insensitively and reuse the first spelling", async () => {
  const call = setup();
  await call("POST", "/api/dishes", { title: "A", tags: ["Snack"] });
  const b = await call("POST", "/api/dishes", { title: "B", tags: ["  snack ", "SNACK", "Schnell   und  gut"] });
  assert.deepEqual(b.json.tags, ["Schnell und gut", "Snack"]);
});

test("update: tags replace, undefined keeps, [] clears", async () => {
  const call = setup();
  const d = (await call("POST", "/api/dishes", { title: "A", tags: ["x", "y"] })).json;
  assert.deepEqual((await call("PATCH", `/api/dishes/${d.id}`, { note: "n" })).json.tags, ["x", "y"]);
  assert.deepEqual((await call("PATCH", `/api/dishes/${d.id}`, { tags: ["z"] })).json.tags, ["z"]);
  assert.deepEqual((await call("PATCH", `/api/dishes/${d.id}`, { tags: [] })).json.tags, []);
});

test("a failed update (duplicate title) does not change the tags", async () => {
  const call = setup();
  await call("POST", "/api/dishes", { title: "A" });
  const b = (await call("POST", "/api/dishes", { title: "B", tags: ["x"] })).json;
  assert.equal((await call("PATCH", `/api/dishes/${b.id}`, { title: "a", tags: ["y"] })).status, 409);
  assert.deepEqual((await call("GET", `/api/dishes?q=B`)).json[0].tags, ["x"]);
});

test("tags show up on plan entries, also for dishes created by title", async () => {
  const call = setup();
  const p = (await call("POST", "/api/plans", { start_date: "2026-09-26", end_date: "2026-10-01" })).json;
  const e = await call("POST", `/api/plans/${p.id}/entries`, { title: "Chips", tags: ["Snack"] });
  assert.deepEqual(e.json.dish.tags, ["Snack"]);
  assert.deepEqual((await call("GET", `/api/plans/${p.id}`)).json.entries[0].dish.tags, ["Snack"]);
});

test("tag validation: too long, too many, empty", async () => {
  const call = setup();
  assert.equal((await call("POST", "/api/dishes", { title: "A", tags: ["x".repeat(31)] })).status, 400);
  assert.equal((await call("POST", "/api/dishes", { title: "A", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status, 400);
  assert.equal((await call("POST", "/api/dishes", { title: "A", tags: ["  "] })).status, 400);
  assert.equal((await call("POST", "/api/dishes", { title: "A", tags: "Snack" })).status, 400);
});

test("deleting a dish removes its tags", async () => {
  const db = openDb(":memory:");
  const repo = createRepo(db);
  const d = repo.createDish({ title: "A", tags: ["x"] });
  repo.deleteDish(d.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dish_tag").get() as { n: number }).n, 0);
});

test("migration v2 -> v3 keeps dishes and adds tags", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v2.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_V1);
    old.exec("ALTER TABLE dish ADD COLUMN image TEXT");
    old.exec("PRAGMA user_version = 2");
    old.prepare("INSERT INTO dish (title) VALUES (?)").run("Linsensuppe");
    old.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    const repo = createRepo(db);
    assert.deepEqual(repo.listDishes().map((d) => [d.title, d.tags]), [["Linsensuppe", []]]);
    assert.deepEqual(repo.updateDish(1, { tags: ["Suppe"] }).tags, ["Suppe"]);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
