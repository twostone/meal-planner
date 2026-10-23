import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { AiError, type RecipeAi } from "../src/ha-ai.ts";
import { aiPairs, buildChanges, splitUnitNote } from "../src/ingredient-normalize.ts";
import { createRepo, type RecipeInput } from "../src/repo.ts";

test("splitUnitNote: an English unit at the start of the note (as old drafts stored it) is taken out", () => {
  assert.deepEqual(splitUnitNote("cups, gesiebt"), { unit: "cup", note: "gesiebt" });
  assert.deepEqual(splitUnitNote("cup"), { unit: "cup", note: null });
  assert.deepEqual(splitUnitNote("fl oz"), { unit: "fl oz", note: null });
  assert.deepEqual(splitUnitNote("rot, gewürfelt"), { unit: null, note: "rot, gewürfelt" });
  assert.deepEqual(splitUnitNote("cup gesiebt"), { unit: null, note: "cup gesiebt" }, "only the form recipe-draft.ts wrote");
  assert.deepEqual(splitUnitNote(null), { unit: null, note: null });
});

test("buildChanges: checks the model's answer like user input and keeps only real changes", () => {
  const pairs = [
    { name: "rote Zwiebeln", note: "gewürfelt" },
    { name: "Mehl", note: "cups, gesiebt" },
    { name: "Salz", note: null },
    { name: "Ei", note: null },
  ];
  assert.deepEqual(aiPairs(pairs)[1], { i: 1, name: "Mehl", note: "gesiebt" });
  const items = JSON.stringify([
    { i: 0, name: "Zwiebel", note: "rot", prep: "gewürfelt" },
    { i: 0, name: "Doppelt", note: null, prep: null },
    { i: 2, name: "Salz", note: null, prep: null },
    { i: 3, name: "", note: null },
    { i: 9, name: "Unbekannt" },
    { i: "1", name: "Text statt Zahl" },
    "kein Objekt",
  ]);
  assert.deepEqual(buildChanges(pairs, items), [
    { from: pairs[0], to: { name: "Zwiebel", note: "rot", prep: "gewürfelt" }, unit: null },
    { from: pairs[1], to: { name: "Mehl", note: "gesiebt", prep: null }, unit: "cup" },
  ]);
  assert.equal(buildChanges(pairs, JSON.stringify([{ i: 0, name: "x".repeat(100), prep: "y".repeat(300) }]))[0]!.to.name.length, 80);
  assert.throws(() => buildChanges(pairs, "kein JSON"));
});

// --- API with a fake AI ---

const ing = (name: string, note: string | null, over: object = {}) => ({ section: null, amount: 2, amount_max: null, unit: null, name, note, ...over });

function setup(normalize: RecipeAi["normalize"] = async () => "[]") {
  const db = openDb(":memory:");
  const repo = createRepo(db);
  const ai: RecipeAi = { status: async () => ({ ai: true, reason: null, image: false }), generate: async () => ({}), titles: async () => "", normalize, image: async () => Buffer.alloc(0) };
  const app = createApp(repo, { ai });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const dish = (title: string, ingredients: RecipeInput["ingredients"]) => {
    const d = repo.createDish({ title });
    repo.setRecipe(d.id, { servings: null, instructions: null, ingredients });
    return d.id;
  };
  return { call, repo, db, dish };
}

test("GET /api/ingredients/pairs: each (name, note) once with the number of dishes; without AI there is no route", async () => {
  const { call, dish } = setup();
  dish("A", [ing("Zwiebel", "rot"), ing("Zwiebel", null), ing("Zwiebel", "rot")]);
  dish("B", [ing("Zwiebel", "rot")]);
  assert.deepEqual((await call("GET", "/api/ingredients/pairs")).json, [
    { name: "Zwiebel", note: null, dishes: 1 },
    { name: "Zwiebel", note: "rot", dishes: 2 },
  ]);
  const plain = createApp(createRepo(openDb(":memory:")));
  assert.equal((await plain.request("/api/ingredients/pairs")).status, 404);
});

test("preview: sends the numbered pairs (unit taken out of the note), returns changes and stores nothing", async () => {
  const seen: unknown[] = [];
  const { call, repo, dish } = setup(async (pairs) => {
    seen.push(pairs);
    return JSON.stringify([{ i: 0, name: "Zwiebel", note: "rot", prep: "gewürfelt" }]);
  });
  const id = dish("A", [ing("rote Zwiebeln", "gewürfelt"), ing("Mehl", "cup")]);
  const r = await call("POST", "/api/ingredients/normalize/preview", { pairs: [{ name: "rote Zwiebeln", note: "gewürfelt" }, { name: "Mehl", note: "cup" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [[{ i: 0, name: "rote Zwiebeln", note: "gewürfelt" }, { i: 1, name: "Mehl", note: null }]]);
  assert.deepEqual(r.json.changes.map((c: any) => [c.to.name, c.to.note, c.to.prep, c.unit]), [["Zwiebel", "rot", "gewürfelt", null], ["Mehl", null, null, "cup"]]);
  assert.deepEqual(repo.getRecipe(id).ingredients.map((i) => i.name), ["rote Zwiebeln", "Mehl"]);
});

test("preview: AI failure 502, a bad answer 502, too many pairs 400, one at a time 429", async () => {
  let release!: () => void;
  let mode: "fail" | "bad" | "hang" = "fail";
  const { call } = setup(async () => {
    if (mode === "fail") throw new AiError("timeout");
    if (mode === "bad") return "kein JSON";
    await new Promise<void>((r) => (release = r));
    return "[]";
  });
  const body = { pairs: [{ name: "Salz", note: null }] };
  assert.equal((await call("POST", "/api/ingredients/normalize/preview", body)).status, 502);
  mode = "bad";
  assert.equal((await call("POST", "/api/ingredients/normalize/preview", body)).status, 502);
  const many = { pairs: Array.from({ length: 81 }, (_, i) => ({ name: `Z${i}`, note: null })) };
  assert.equal((await call("POST", "/api/ingredients/normalize/preview", many)).status, 400);
  mode = "hang";
  const first = call("POST", "/api/ingredients/normalize/preview", body);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await call("POST", "/api/ingredients/normalize/preview", body)).status, 429);
  release();
  assert.equal((await first).status, 200);
});

test("apply: changes only rows with the old values, keeps pos, raw and the ticks of cook mode, converts units", async () => {
  const { call, repo, dish } = setup();
  const a = dish("A", [ing("Zwiebeln", null, { raw: "2 Zwiebeln" }), ing("Mehl", "cups, gesiebt", { amount: 1, amount_max: 2 }), ing("Salz", null)]);
  const b = dish("B", [ing("Zwiebeln", "rot"), ing("Zwiebeln", null, { prep: "in Ringen" })]);
  const plan = repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
  const entry = repo.addEntry(plan.id, { dish_id: a });
  repo.setCheck(entry.id, "ingredient", 1, true);

  const r = await call("POST", "/api/ingredients/normalize/apply", {
    changes: [
      { from: { name: "Zwiebeln", note: null }, to: { name: "Zwiebel", note: null, prep: null }, unit: null },
      { from: { name: "Mehl", note: "cups, gesiebt" }, to: { name: "Mehl", note: null, prep: "gesiebt" }, unit: "cup" },
      { from: { name: "Gibt es nicht mehr", note: null }, to: { name: "X", note: null, prep: null }, unit: null },
    ],
  });
  assert.deepEqual(r.json, { changed: 3 });
  const view = (id: number) => repo.getRecipe(id).ingredients.map((i) => [i.amount, i.amount_max, i.unit, i.name, i.note, i.prep, i.raw]);
  assert.deepEqual(view(a), [
    [2, null, null, "Zwiebel", null, null, "2 Zwiebeln"],
    [120, 240, "g", "Mehl", null, "gesiebt", "1-2 Mehl"],
    [2, null, null, "Salz", null, null, "2 Salz"],
  ]);
  assert.deepEqual(view(b).map((r) => [r[3], r[4], r[5]]), [["Zwiebeln", "rot", null], ["Zwiebel", null, "in Ringen"]], "other note untouched, stored prep kept");
  assert.deepEqual(repo.getChecks(plan.id).entries[0]!.checks.ingredients, [1]);
});

test("apply: validates the changes like any input", async () => {
  const { call } = setup();
  const change = { from: { name: "A", note: null }, to: { name: "B", note: null, prep: null }, unit: null };
  assert.equal((await call("POST", "/api/ingredients/normalize/apply", { changes: [] })).status, 400);
  assert.equal((await call("POST", "/api/ingredients/normalize/apply", { changes: [{ ...change, unit: "Glas" }] })).status, 400);
  assert.equal((await call("POST", "/api/ingredients/normalize/apply", { changes: [{ ...change, to: { ...change.to, name: " " } }] })).status, 400);
  assert.equal((await call("POST", "/api/ingredients/normalize/apply", { changes: [{ ...change, to: { ...change.to, prep: "x".repeat(201) } }] })).status, 400);
  assert.deepEqual((await call("POST", "/api/ingredients/normalize/apply", { changes: [change] })).json, { changed: 0 });
});
