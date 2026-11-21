import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

function setup() {
  const db = openDb(":memory:");
  const repo = createRepo(db);
  const app = createApp(repo);
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, repo };
}
const ing = (name: string, note: string | null = null) => ({ section: null, amount: null, amount_max: null, unit: null, name, note });
const recipe = (...ingredients: ReturnType<typeof ing>[]) => ({ servings: null, instructions: null, ingredients });

// Suppe uses Salz twice (two spellings), Pasta uses salz and Pfeffer.
async function withRecipes() {
  const s = setup();
  const suppe = s.repo.createDish({ title: "Suppe" });
  const pasta = s.repo.createDish({ title: "Pasta" });
  s.repo.setRecipe(suppe.id, recipe(ing("Salz"), ing("Zwiebel"), ing("Salz ", "grob")));
  s.repo.setRecipe(pasta.id, recipe(ing("salz"), ing("Pfeffer", "schwarz")));
  return { ...s, suppe, pasta };
}

test("catalog lists every used name once, counts dishes, sorted by name", async () => {
  const { call } = await withRecipes();
  const res = await call("GET", "/api/ingredients");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, [
    { key: "pfeffer", name: "Pfeffer", dishes: 1, pantry: false },
    { key: "salz", name: "Salz", dishes: 2, pantry: false },
    { key: "zwiebel", name: "Zwiebel", dishes: 1, pantry: false },
  ]);
});

test("pantry: set and reset; a used name loses its catalog row on reset", async () => {
  const { call, repo } = await withRecipes();
  const set = await call("PATCH", "/api/ingredients", { key: "salz", pantry: true });
  assert.deepEqual(set.json, { key: "salz", name: "Salz", dishes: 2, pantry: true });
  assert.deepEqual([...repo.pantryKeys()], ["salz"]);
  const reset = await call("POST", "/api/ingredients/reset", { key: "salz" });
  assert.deepEqual(reset.json, { key: "salz", name: "Salz", dishes: 2, pantry: false });
  assert.deepEqual([...repo.pantryKeys()], []);
  assert.equal((await call("PATCH", "/api/ingredients", { key: "safran", pantry: true })).status, 404);
  assert.equal((await call("PATCH", "/api/ingredients", { key: "salz" })).status, 400);
});

test("names added by hand: listed with no dishes, spelling wins, conflicts refused, deletable while unused", async () => {
  const { call, repo, suppe } = await withRecipes();
  const created = await call("POST", "/api/ingredients", { name: "  Zucker  " });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { key: "zucker", name: "Zucker", dishes: 0, pantry: false });
  assert.equal((await call("POST", "/api/ingredients", { name: "SALZ" })).status, 409);
  assert.equal((await call("POST", "/api/ingredients", { name: "zucker" })).status, 409);
  assert.equal((await call("POST", "/api/ingredients", { name: " " })).status, 400);

  // Reset keeps a name added by hand; only delete removes it.
  await call("PATCH", "/api/ingredients", { key: "zucker", pantry: true });
  assert.deepEqual((await call("POST", "/api/ingredients/reset", { key: "zucker" })).json, { key: "zucker", name: "Zucker", dishes: 0, pantry: false });

  // Once a recipe uses it, the catalog spelling still wins, the dish counts, and deleting is refused.
  repo.setRecipe(suppe.id, recipe(ing("zucker")));
  const zucker = (await call("GET", "/api/ingredients")).json.find((i: { key: string }) => i.key === "zucker");
  assert.deepEqual(zucker, { key: "zucker", name: "Zucker", dishes: 1, pantry: false });
  assert.equal((await call("POST", "/api/ingredients/delete", { key: "zucker" })).status, 409);

  repo.setRecipe(suppe.id, recipe());
  assert.equal((await call("POST", "/api/ingredients/delete", { key: "zucker" })).status, 204);
  assert.equal((await call("POST", "/api/ingredients/delete", { key: "zucker" })).status, 404);
  assert.equal(repo.listIngredients().some((i) => i.key === "zucker"), false);
});

test("a name no longer used keeps its setting and shows with no dishes", async () => {
  const { call, repo, pasta } = await withRecipes();
  await call("PATCH", "/api/ingredients", { key: "pfeffer", pantry: true });
  repo.setRecipe(pasta.id, recipe());
  assert.deepEqual(repo.listIngredients().find((i) => i.key === "pfeffer"), { key: "pfeffer", name: "Pfeffer", dishes: 0, pantry: true });
});

test("names for the AI and the search box: catalog spelling wins, names added by hand come after the used ones", async () => {
  const { call, repo } = await withRecipes();
  await call("POST", "/api/ingredients", { name: "Ahornsirup" });
  repo.setIngredient("zwiebel", { pantry: true });
  assert.deepEqual(repo.listIngredientNames(10), ["Salz", "Pfeffer", "Zwiebel", "Ahornsirup"]);
  assert.deepEqual(repo.listIngredientNames(2), ["Salz", "Pfeffer"]);
});

test("migration from v11 adds the ingredient table and keeps recipes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v11.db");
    const first = openDb(file);
    const dish = createRepo(first).createDish({ title: "Suppe" });
    createRepo(first).setRecipe(dish.id, recipe(ing("Salz")));
    first.exec("DROP TABLE ingredient");
    first.exec("PRAGMA user_version = 11");
    first.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 12);
    const repo = createRepo(db);
    assert.deepEqual(repo.listIngredients(), [{ key: "salz", name: "Salz", dishes: 1, pantry: false }]);
    assert.equal(repo.setIngredient("salz", { pantry: true }).pantry, true);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("split: preview names the dishes and suggests parts; splitting rewrites every recipe and drops ingredient ticks only", async () => {
  const { call, repo } = setup();
  const pasta = repo.createDish({ title: "Pasta" });
  const suppe = repo.createDish({ title: "Suppe" });
  repo.setRecipe(pasta.id, { servings: 2, instructions: "Kochen\nWürzen", ingredients: [ing("Nudeln"), ing("Salz & Pfeffer")] });
  repo.setRecipe(suppe.id, recipe(ing("Salz"), ing("Salz & Pfeffer")));
  repo.setIngredient("salz & pfeffer", { pantry: true });
  const plan = repo.createPlan({ start_date: "2026-11-21", end_date: "2026-11-27" });
  const entry = repo.addEntry(plan.id, { dish_id: pasta.id });
  repo.setCheck(entry.id, "ingredient", 0, true);
  repo.setCheck(entry.id, "step", 1, true);

  const preview = await call("POST", "/api/ingredients/split/preview", { key: "salz & pfeffer" });
  assert.deepEqual(preview.json, { name: "Salz & Pfeffer", dishes: [{ id: pasta.id, title: "Pasta" }, { id: suppe.id, title: "Suppe" }], parts: ["Salz", "Pfeffer"] });

  const split = await call("POST", "/api/ingredients/split", { key: "salz & pfeffer", parts: [{ name: "Salz", note: null }, { name: "Pfeffer", note: "schwarz" }] });
  assert.deepEqual(split.json, { dishes: 2 });
  assert.deepEqual(repo.getRecipe(pasta.id).ingredients.map((i) => [i.name, i.note, i.raw]), [
    ["Nudeln", null, "Nudeln"],
    ["Salz", null, "Salz & Pfeffer"],
    ["Pfeffer", "schwarz", "Salz & Pfeffer"],
  ]);
  assert.deepEqual(repo.getRecipe(suppe.id).ingredients.map((i) => i.name), ["Salz", "Pfeffer"]);
  assert.equal(repo.getRecipe(pasta.id).instructions, "Kochen\nWürzen");
  assert.deepEqual(repo.getChecks(plan.id).entries[0]!.checks, { ingredients: [], steps: [1] });
  // The collective name and its catalog row are gone; Salz and Pfeffer count their dishes.
  assert.deepEqual(repo.listIngredients().map((i) => [i.name, i.dishes]), [["Nudeln", 1], ["Pfeffer", 2], ["Salz", 2]]);
  assert.deepEqual([...repo.pantryKeys()], []);
});

test("split: refused for unknown names, fewer than two parts, or a part named like the line", async () => {
  const { call, repo } = setup();
  repo.setRecipe(repo.createDish({ title: "Suppe" }).id, recipe(ing("Salz & Pfeffer")));
  const body = (parts: { name: string; note: string | null }[], key = "salz & pfeffer") => ({ key, parts });
  assert.equal((await call("POST", "/api/ingredients/split", body([{ name: "A", note: null }, { name: "B", note: null }], "safran"))).status, 404);
  assert.equal((await call("POST", "/api/ingredients/split/preview", { key: "safran" })).status, 404);
  assert.equal((await call("POST", "/api/ingredients/split", body([{ name: "Salz", note: null }]))).status, 400);
  assert.equal((await call("POST", "/api/ingredients/split", body([{ name: "Salz", note: null }, { name: "salz &  pfeffer", note: null }]))).status, 400);
  assert.equal((await call("POST", "/api/ingredients/split", body([{ name: " ", note: null }, { name: "Pfeffer", note: null }]))).status, 400);
  assert.deepEqual(repo.listIngredients().map((i) => i.name), ["Salz & Pfeffer"]);
});
