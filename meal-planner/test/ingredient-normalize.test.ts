import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { AiError, type RecipeAi } from "../src/ha-ai.ts";
import { aiItems, buildChanges, splitUnitNote } from "../src/ingredient-normalize.ts";
import { createRepo, type RecipeInput } from "../src/repo.ts";

test("splitUnitNote: an English unit at the start of the note (as old drafts stored it) is taken out", () => {
  assert.deepEqual(splitUnitNote("cups, gesiebt"), { unit: "cup", note: "gesiebt" });
  assert.deepEqual(splitUnitNote("cup"), { unit: "cup", note: null });
  assert.deepEqual(splitUnitNote("fl oz"), { unit: "fl oz", note: null });
  assert.deepEqual(splitUnitNote("rot, gewürfelt"), { unit: null, note: "rot, gewürfelt" });
  assert.deepEqual(splitUnitNote("cup gesiebt"), { unit: null, note: "cup gesiebt" }, "only the form recipe-draft.ts wrote");
  assert.deepEqual(splitUnitNote(null), { unit: null, note: null });
});

const line = (name: string, note: string | null = null, over: object = {}) => ({ name, plural: null, note, prep: null, ...over });

test("buildChanges: checks the model's answer like user input and keeps only real changes", () => {
  const lines = [line("rote Zwiebeln", "gewürfelt"), line("Mehl", "cups, gesiebt"), line("Salz"), line("Ei", null, { prep: "zimmerwarm" })];
  assert.deepEqual(aiItems(lines)[1], { i: 1, name: "Mehl", plural: null, note: "gesiebt", prep: null });
  const items = JSON.stringify([
    { i: 0, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt" },
    { i: 0, name: "Doppelt" },
    { i: 2, name: "Salz", plural: "Salz", note: null, prep: null },
    { i: 3, name: "Ei", plural: "Eier", note: null, prep: null },
    { i: 9, name: "Unbekannt" },
    { i: "1", name: "Text statt Zahl" },
    "kein Objekt",
  ]);
  assert.deepEqual(buildChanges(lines, items), [
    { pos: 0, from: { name: "rote Zwiebeln", note: "gewürfelt" }, to: { name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt" }, unit: null },
    { pos: 1, from: { name: "Mehl", note: "cups, gesiebt" }, to: { name: "Mehl", plural: null, note: "gesiebt", prep: null }, unit: "cup" },
    { pos: 3, from: { name: "Ei", note: null }, to: { name: "Ei", plural: "Eier", note: null, prep: "zimmerwarm" }, unit: null },
  ], "Salz/Salz is no plural, a dropped preparation stays");
  assert.equal(buildChanges(lines, JSON.stringify([{ i: 0, name: "x".repeat(100) }]))[0]!.to.name.length, 80);
  assert.throws(() => buildChanges(lines, "kein JSON"));
});

// --- API with a fake AI ---

const ing = (name: string, note: string | null, over: object = {}) => ({ section: null, amount: 2, amount_max: null, unit: null, name, note, ...over });

function setup(normalize: RecipeAi["normalize"] = async () => "[]") {
  const repo = createRepo(openDb(":memory:"));
  const ai: RecipeAi = { status: async () => ({ ai: true, reason: null }), generate: async () => ({}), titles: async () => "", normalize };
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
  return { call, repo, dish };
}

test("POST …/recipe/normalize: sends the dish's lines and the known names, returns changes, stores nothing", async () => {
  const seen: unknown[][] = [];
  const { call, repo, dish } = setup(async (items, names) => {
    seen.push([items, names]);
    return JSON.stringify([{ i: 0, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt" }]);
  });
  dish("Andere", [ing("Ei", null)]);
  const id = dish("A", [ing("rote Zwiebeln", "gewürfelt"), ing("Mehl", "cup")]);
  const r = await call("POST", `/api/dishes/${id}/recipe/normalize`);
  assert.equal(r.status, 200);
  assert.deepEqual(seen[0]![0], [
    { i: 0, name: "rote Zwiebeln", plural: null, note: "gewürfelt", prep: null },
    { i: 1, name: "Mehl", plural: null, note: null, prep: null },
  ]);
  assert.ok((seen[0]![1] as string[]).includes("Ei"));
  assert.deepEqual(r.json.changes.map((c: any) => [c.pos, c.to.name, c.to.plural, c.unit]), [[0, "Zwiebel", "Zwiebeln", null], [1, "Mehl", null, "cup"]]);
  assert.deepEqual(repo.getRecipe(id).ingredients.map((i) => i.name), ["rote Zwiebeln", "Mehl"]);
});

test("POST …/recipe/normalize: no ingredients 400, unknown dish 404, AI failure and bad answer 502, without AI no route", async () => {
  let mode: "fail" | "bad" = "fail";
  const { call, dish } = setup(async () => {
    if (mode === "fail") throw new AiError("timeout");
    return "kein JSON";
  });
  const id = dish("A", [ing("Salz", null)]);
  assert.equal((await call("POST", `/api/dishes/${dish("Leer", [])}/recipe/normalize`)).status, 400);
  assert.equal((await call("POST", "/api/dishes/999/recipe/normalize")).status, 404);
  assert.equal((await call("POST", `/api/dishes/${id}/recipe/normalize`)).status, 502);
  mode = "bad";
  assert.equal((await call("POST", `/api/dishes/${id}/recipe/normalize`)).status, 502);
  const plain = createApp(createRepo(openDb(":memory:")));
  assert.equal((await plain.request(`/api/dishes/${id}/recipe/normalize`, { method: "POST" })).status, 404);
});

test("POST …/normalize/apply: changes only lines with the old values, keeps pos, raw and the ticks, converts units", async () => {
  const { call, repo, dish } = setup();
  const a = dish("A", [ing("Zwiebeln", null, { raw: "2 Zwiebeln" }), ing("Mehl", "cups, gesiebt", { amount: 1, amount_max: 2 }), ing("Salz", null)]);
  const b = dish("B", [ing("Zwiebeln", null)]);
  const plan = repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
  const entry = repo.addEntry(plan.id, { dish_id: a });
  repo.setCheck(entry.id, "ingredient", 1, true);

  const r = await call("POST", `/api/dishes/${a}/recipe/normalize/apply`, {
    changes: [
      { pos: 0, from: { name: "Zwiebeln", note: null }, to: { name: "Zwiebel", plural: "Zwiebeln", note: null, prep: null }, unit: null },
      { pos: 1, from: { name: "Mehl", note: "cups, gesiebt" }, to: { name: "Mehl", plural: null, note: null, prep: "gesiebt" }, unit: "cup" },
      { pos: 2, from: { name: "Pfeffer", note: null }, to: { name: "X", plural: null, note: null, prep: null }, unit: null },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.ingredients.map((i: any) => [i.amount, i.amount_max, i.unit, i.name, i.plural, i.note, i.prep, i.raw]), [
    [2, null, null, "Zwiebel", "Zwiebeln", null, null, "2 Zwiebeln"],
    [120, 240, "g", "Mehl", null, null, "gesiebt", "1-2 Mehl"],
    [2, null, null, "Salz", null, null, null, "2 Salz"],
  ], "the outdated third change did nothing");
  assert.deepEqual(repo.getRecipe(b).ingredients.map((i) => i.name), ["Zwiebeln"], "other recipes stay");
  assert.deepEqual(repo.getChecks(plan.id).entries[0]!.checks.ingredients, [1]);
});

test("POST …/normalize/apply: validates the changes like any input; unknown dish 404", async () => {
  const { call, dish } = setup();
  const id = dish("A", [ing("A", null)]);
  const url = `/api/dishes/${id}/recipe/normalize/apply`;
  const change = { pos: 0, from: { name: "A", note: null }, to: { name: "B", plural: null, note: null, prep: null }, unit: null };
  assert.equal((await call("POST", url, { changes: [] })).status, 400);
  assert.equal((await call("POST", url, { changes: [{ ...change, unit: "Glas" }] })).status, 400);
  assert.equal((await call("POST", url, { changes: [{ ...change, pos: 60 }] })).status, 400);
  assert.equal((await call("POST", url, { changes: [{ ...change, to: { ...change.to, name: " " } }] })).status, 400);
  assert.equal((await call("POST", url, { changes: [{ ...change, to: { ...change.to, plural: "x".repeat(81) } }] })).status, 400);
  assert.equal((await call("POST", "/api/dishes/999/recipe/normalize/apply", { changes: [change] })).status, 404);
  assert.deepEqual((await call("POST", url, { changes: [change] })).json.ingredients.map((i: any) => i.name), ["B"]);
});
