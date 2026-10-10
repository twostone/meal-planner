import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo, stepLines } from "../src/repo.ts";

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
    return { status: res.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
  };
  return { call, db };
}
const ing = (name: string) => ({ section: null, amount: null, amount_max: null, unit: null, name, note: null });

// A plan with two dishes: "Suppe" (2 ingredients, 3 steps) and "Salat" (no recipe).
async function plan() {
  const { call, db } = setup();
  const p = (await call("POST", "/api/plans", { start_date: "2026-10-10", end_date: "2026-10-16" })).json;
  const suppe = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Suppe", url: "https://example.com/s" })).json;
  const salat = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Salat" })).json;
  await call("PUT", `/api/dishes/${suppe.dish_id}/recipe`, {
    servings: 4,
    instructions: "Schneiden.\n\n  Kochen.\nServieren.\n",
    ingredients: [ing("Möhre"), ing("Zwiebel")],
  });
  await call("PATCH", `/api/entries/${suppe.id}`, { note: "doppelte Portion" });
  return { call, db, plan: p, suppe, salat };
}
const put = (call: Awaited<ReturnType<typeof plan>>["call"], entry: number, kind: string, idx: number, checked: boolean) =>
  call("PUT", `/api/entries/${entry}/checks`, { kind, idx, checked });

test("stepLines: non-empty trimmed lines", () => {
  assert.deepEqual(stepLines("Schneiden.\n\n  Kochen.\nServieren.\n"), ["Schneiden.", "Kochen.", "Servieren."]);
  assert.deepEqual(stepLines(null), []);
});

test("GET cook: every entry of the plan in list order with its recipe, note and ticks", async () => {
  const { call, plan: p, suppe, salat } = await plan();
  const r = await call("GET", `/api/plans/${p.id}/cook`);
  assert.equal(r.status, 200);
  assert.equal(r.json.plan_id, p.id);
  assert.deepEqual(r.json.entries.map((e: any) => [e.entry_id, e.title, e.done, e.note]), [[suppe.id, "Suppe", false, "doppelte Portion"], [salat.id, "Salat", false, null]]);
  assert.equal(r.json.entries[0].url, "https://example.com/s");
  assert.deepEqual(r.json.entries[0].recipe.ingredients.map((i: any) => i.name), ["Möhre", "Zwiebel"]);
  assert.equal(r.json.entries[0].recipe.servings, 4);
  assert.deepEqual(r.json.entries[1].recipe.ingredients, []);
  assert.deepEqual(r.json.entries[0].checks, { ingredients: [], steps: [] });
  assert.equal((await call("GET", "/api/plans/99/cook")).status, 404);
});

test("PUT checks: sets and removes ticks, idempotent, sorted", async () => {
  const { call, plan: p, suppe } = await plan();
  assert.deepEqual((await put(call, suppe.id, "ingredient", 1, true)).json, { ingredients: [1], steps: [] });
  assert.deepEqual((await put(call, suppe.id, "ingredient", 1, true)).json, { ingredients: [1], steps: [] }, "setting twice changes nothing");
  assert.deepEqual((await put(call, suppe.id, "step", 2, true)).json, { ingredients: [1], steps: [2] });
  assert.deepEqual((await put(call, suppe.id, "ingredient", 0, true)).json, { ingredients: [0, 1], steps: [2] });
  assert.deepEqual((await put(call, suppe.id, "ingredient", 1, false)).json, { ingredients: [0], steps: [2] });
  assert.deepEqual((await put(call, suppe.id, "ingredient", 1, false)).json, { ingredients: [0], steps: [2] }, "removing twice changes nothing");
  const cook = (await call("GET", `/api/plans/${p.id}/cook`)).json;
  assert.deepEqual(cook.entries[0].checks, { ingredients: [0], steps: [2] });
});

test("PUT checks: a new tick must point at an existing ingredient or step; unknown entry 404; bad body 400", async () => {
  const { call, suppe, salat } = await plan();
  assert.equal((await put(call, suppe.id, "ingredient", 2, true)).status, 400);
  assert.equal((await put(call, suppe.id, "step", 3, true)).status, 400);
  assert.equal((await put(call, salat.id, "step", 0, true)).status, 400, "a dish without recipe has nothing to tick");
  assert.equal((await put(call, suppe.id, "step", 2, true)).status, 200);
  assert.equal((await put(call, suppe.id, "step", 9, false)).status, 200, "removing a tick that does not exist is fine");
  assert.equal((await put(call, 99, "step", 0, true)).status, 404);
  for (const bad of [{ kind: "x", idx: 0, checked: true }, { kind: "step", idx: -1, checked: true }, { kind: "step", idx: 1.5, checked: true }, { kind: "step", idx: 0 }]) {
    assert.equal((await call("PUT", `/api/entries/${suppe.id}/checks`, bad)).status, 400, JSON.stringify(bad));
  }
});

test("GET checks: done flag and ticks of every entry; ticks are per entry and per plan", async () => {
  const { call, plan: p, suppe, salat } = await plan();
  await put(call, suppe.id, "step", 0, true);
  await call("PATCH", `/api/entries/${salat.id}`, { done: true });
  const r = await call("GET", `/api/plans/${p.id}/checks`);
  assert.deepEqual(r.json, {
    entries: [
      { entry_id: suppe.id, done: false, checks: { ingredients: [], steps: [0] } },
      { entry_id: salat.id, done: true, checks: { ingredients: [], steps: [] } },
    ],
  });
  // the same dish in another plan starts clean
  const p2 = (await call("POST", "/api/plans", { start_date: "2026-10-17", end_date: "2026-10-23" })).json;
  const again = (await call("POST", `/api/plans/${p2.id}/entries`, { dish_id: suppe.dish_id })).json;
  assert.deepEqual((await call("GET", `/api/plans/${p2.id}/checks`)).json.entries[0], { entry_id: again.id, done: false, checks: { ingredients: [], steps: [] } });
  assert.equal((await call("GET", "/api/plans/99/checks")).status, 404);
});

test("changing the recipe removes the ticks of that dish in every plan, other dishes keep theirs", async () => {
  const { call, plan: p, suppe } = await plan();
  const other = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Curry" })).json;
  await call("PUT", `/api/dishes/${other.dish_id}/recipe`, { servings: null, instructions: "Kochen.", ingredients: [] });
  await put(call, suppe.id, "ingredient", 0, true);
  await put(call, other.id, "step", 0, true);
  await call("PUT", `/api/dishes/${suppe.dish_id}/recipe`, { servings: 2, instructions: "Neu.", ingredients: [ing("Lauch")] });
  const r = (await call("GET", `/api/plans/${p.id}/checks`)).json.entries;
  assert.deepEqual(r.find((e: any) => e.entry_id === suppe.id).checks, { ingredients: [], steps: [] });
  assert.deepEqual(r.find((e: any) => e.entry_id === other.id).checks, { ingredients: [], steps: [0] });
});

test("ticks go away with their entry; marking an entry done keeps them", async () => {
  const { call, db, plan: p, suppe } = await plan();
  await put(call, suppe.id, "step", 1, true);
  await call("PATCH", `/api/entries/${suppe.id}`, { done: true });
  assert.deepEqual((await call("GET", `/api/plans/${p.id}/checks`)).json.entries[0], { entry_id: suppe.id, done: true, checks: { ingredients: [], steps: [1] } });
  await call("DELETE", `/api/entries/${suppe.id}`);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cook_check").get() as { n: number }).n, 0);
});

test("migration v7 keeps entries and adds the ticks table", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v7.db");
    const first = openDb(file);
    const repo = createRepo(first);
    const plan = repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
    repo.addEntry(plan.id, { title: "Suppe" });
    first.exec("DROP TABLE cook_check");
    first.exec("PRAGMA user_version = 7");
    first.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
    const r = createRepo(db);
    assert.deepEqual(r.getChecks(plan.id).entries.map((e) => e.checks), [{ ingredients: [], steps: [] }]);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
