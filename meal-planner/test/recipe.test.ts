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
  const db = openDb(":memory:");
  const app = createApp(createRepo(db));
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, db };
}

const ing = (over: object = {}) => ({
  section: null,
  amount: 2,
  amount_max: null,
  unit: "EL",
  name: "Olivenöl",
  note: null,
  ...over,
});
const recipe = (over: object = {}) => ({ servings: 4, instructions: "Erhitzen.\nServieren.", ingredients: [ing()], ...over });

test("a dish without recipe has an empty one", async () => {
  const { call } = setup();
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  assert.deepEqual((await call("GET", `/api/dishes/${d.id}/recipe`)).json, { servings: null, instructions: null, ingredients: [], source_text: null, source_truncated: false });
});

test("recipe columns never show up in the catalog or in plan entries", async () => {
  const { call } = setup();
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  await call("PUT", `/api/dishes/${d.id}/recipe`, recipe());
  const p = (await call("POST", "/api/plans", { start_date: "2026-10-01", end_date: "2026-10-07" })).json;
  await call("POST", `/api/plans/${p.id}/entries`, { dish_id: d.id });
  assert.equal("instructions" in (await call("GET", "/api/dishes")).json[0], false);
  assert.equal("servings" in (await call("GET", `/api/plans/${p.id}`)).json.entries[0].dish, false);
});

test("PUT replaces the recipe, keeps order and builds raw when missing", async () => {
  const { call } = setup();
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  const r = await call("PUT", `/api/dishes/${d.id}/recipe`, recipe({
    ingredients: [
      ing({ section: "Brühe", amount: 1.5, unit: "l", name: "Wasser" }),
      ing({ amount: 1, amount_max: 2, unit: "Zehe", name: "Knoblauch", raw: "1-2 Zehen Knoblauch, fein" }),
      ing({ amount: null, unit: null, name: "Salz", note: "nach Geschmack" }),
    ],
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.ingredients.map((i: any) => i.raw), ["1,5 l Wasser", "1-2 Zehen Knoblauch, fein", "Salz"]);
  assert.equal(r.json.ingredients[0].section, "Brühe");
  const r2 = await call("PUT", `/api/dishes/${d.id}/recipe`, recipe({ ingredients: [ing({ name: "Butter", unit: "g", amount: 20 })] }));
  assert.deepEqual(r2.json.ingredients.map((i: any) => i.name), ["Butter"]);
  assert.deepEqual((await call("GET", `/api/dishes/${d.id}/recipe`)).json, r2.json);
});

test("an empty recipe clears it, empty strings become null", async () => {
  const { call, db } = setup();
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  await call("PUT", `/api/dishes/${d.id}/recipe`, recipe());
  const r = await call("PUT", `/api/dishes/${d.id}/recipe`, { servings: null, instructions: "", ingredients: [] });
  assert.deepEqual(r.json, { servings: null, instructions: null, ingredients: [], source_text: null, source_truncated: false });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dish_ingredient").get() as { n: number }).n, 0);
});

test("limits and units are validated, a rejected PUT changes nothing", async () => {
  const { call } = setup();
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  await call("PUT", `/api/dishes/${d.id}/recipe`, recipe());
  const url = `/api/dishes/${d.id}/recipe`;
  const bad = [
    recipe({ servings: 0 }),
    recipe({ servings: 51 }),
    recipe({ servings: 2.5 }),
    recipe({ instructions: "x".repeat(10001) }),
    recipe({ ingredients: Array.from({ length: 61 }, () => ing()) }),
    recipe({ ingredients: [ing({ unit: "Stück" })] }),
    recipe({ ingredients: [ing({ name: " " })] }),
    recipe({ ingredients: [ing({ name: "x".repeat(81) })] }),
    recipe({ ingredients: [ing({ note: "x".repeat(201) })] }),
    recipe({ ingredients: [ing({ amount: -1 })] }),
    recipe({ ingredients: [ing({ amount: 3, amount_max: 2 })] }),
    recipe({ ingredients: [ing({ amount: null, amount_max: 2 })] }),
  ];
  for (const b of bad) assert.equal((await call("PUT", url, b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await call("PUT", url, recipe({ ingredients: Array.from({ length: 60 }, () => ing()) }))).status, 200);
  assert.equal((await call("PUT", url, bad[5])).status, 400);
  assert.equal((await call("GET", url)).json.ingredients.length, 60);
});

test("unknown dish: 404; deleting a dish removes its ingredients", async () => {
  const { call, db } = setup();
  assert.equal((await call("GET", "/api/dishes/99/recipe")).status, 404);
  assert.equal((await call("PUT", "/api/dishes/99/recipe", recipe())).status, 404);
  const d = (await call("POST", "/api/dishes", { title: "Suppe" })).json;
  await call("PUT", `/api/dishes/${d.id}/recipe`, recipe());
  await call("DELETE", `/api/dishes/${d.id}`);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dish_ingredient").get() as { n: number }).n, 0);
});

test("migration v5 keeps dishes and adds the recipe tables", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v5.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_V1);
    old.exec("ALTER TABLE dish ADD COLUMN image TEXT");
    old.exec(
      "CREATE TABLE dish_tag (dish_id INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE, tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0), PRIMARY KEY (dish_id, tag)) STRICT",
    );
    old.exec("ALTER TABLE plan_entry ADD COLUMN note TEXT");
    old.exec("ALTER TABLE plan ADD COLUMN title TEXT");
    old.exec("PRAGMA user_version = 5");
    old.prepare("INSERT INTO dish (title) VALUES (?)").run("Linsensuppe");
    old.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
    const repo = createRepo(db);
    assert.deepEqual(repo.listDishes().map((d) => d.title), ["Linsensuppe"]);
    assert.deepEqual(repo.getRecipe(1), { servings: null, instructions: null, ingredients: [], source_text: null, source_truncated: false });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
