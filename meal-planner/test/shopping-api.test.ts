import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { TodoError, type HaTodo, type OpenTodoItem, type TodoList } from "../src/ha-todo.ts";
import { createRepo } from "../src/repo.ts";

const ESSEN: TodoList = { entity_id: "todo.essen", name: "Essen", description: true };

// A fake to-do list in Home Assistant: records what is added, `failAt` makes the n-th add fail.
function fakeTodo(opts: { open?: OpenTodoItem[]; failAt?: number; openFails?: boolean; unreachable?: boolean } = {}) {
  const added: { list: string; name: string; spec: string | null }[] = [];
  let release: (() => void) | null = null;
  const todo: HaTodo & { added: typeof added; hold: () => void; go: () => void } = {
    added,
    hold: () => void (release = () => {}),
    go: () => {
      const r = release;
      release = null;
      r?.();
    },
    async status() {
      return opts.unreachable ? { lists: [], reason: "unreachable" } : { lists: [ESSEN], reason: null };
    },
    async openItems() {
      if (opts.openFails) throw new TodoError("unreachable");
      return opts.open ?? [];
    },
    async add(list, name, spec) {
      if (release) await new Promise<void>((ok) => (release = ok));
      if (opts.failAt === added.length) throw new TodoError("timeout");
      added.push({ list: list.entity_id, name, spec });
    },
  };
  return todo;
}

function setup(todo?: HaTodo) {
  const db = openDb(":memory:");
  const app = createApp(createRepo(db), { todo });
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
const ing = (amount: number | null, unit: string | null, name: string, note: string | null = null) => ({ section: null, amount, amount_max: null, unit, name, note });

// Suppe and Pasta with recipes, Salat without one; Pasta is already cooked (done).
async function plan(todo?: HaTodo) {
  const { call, db } = setup(todo);
  const p = (await call("POST", "/api/plans", { start_date: "2026-10-10", end_date: "2026-10-16" })).json;
  const suppe = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Suppe" })).json;
  const pasta = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Pasta" })).json;
  const salat = (await call("POST", `/api/plans/${p.id}/entries`, { title: "Salat" })).json;
  await call("PUT", `/api/dishes/${suppe.dish_id}/recipe`, { servings: null, instructions: null, ingredients: [ing(2, null, "Zwiebel"), ing(null, null, "Salz")] });
  await call("PUT", `/api/dishes/${pasta.dish_id}/recipe`, { servings: null, instructions: null, ingredients: [ing(1, null, "Zwiebel"), ing(500, "g", "Nudeln")] });
  await call("PATCH", `/api/entries/${pasta.id}`, { done: true });
  return { call, db, plan: p, suppe, pasta, salat };
}

test("without todo: status says disabled and the shopping routes do not exist", async () => {
  const { call, plan: p } = await plan();
  assert.deepEqual((await call("GET", "/api/shopping/status")).json, { lists: [], selected: null, reason: "disabled" });
  assert.equal((await call("GET", `/api/plans/${p.id}/shopping`)).status, 404);
  assert.equal((await call("POST", "/api/shopping/send", { list: "todo.essen", items: [{ name: "x", spec: null }] })).status, 404);
});

test("shopping list: open entries by default, chosen entries on request, entries without recipe flagged", async () => {
  const { call, plan: p, suppe, pasta, salat } = await plan(fakeTodo());
  const def = (await call("GET", `/api/plans/${p.id}/shopping`)).json;
  assert.deepEqual(def.entries, [
    { entry_id: suppe.id, title: "Suppe", done: false, selected: true, has_recipe: true },
    { entry_id: pasta.id, title: "Pasta", done: true, selected: false, has_recipe: true },
    { entry_id: salat.id, title: "Salat", done: false, selected: true, has_recipe: false },
  ]);
  assert.deepEqual(def.items, [
    { key: "salz\u0000", name: "Salz", note: null, spec: null, sources: ["Suppe"], on_list: false },
    { key: "zwiebel\u0000", name: "Zwiebel", note: null, spec: "2", sources: ["Suppe"], on_list: false },
  ]);
  const both = (await call("GET", `/api/plans/${p.id}/shopping?entries=${suppe.id},${pasta.id}`)).json;
  assert.deepEqual(
    both.items.map((i: any) => [i.name, i.spec]),
    [
      ["Nudeln", "500 g"],
      ["Salz", null],
      ["Zwiebel", "3"],
    ],
  );
  assert.deepEqual((await call("GET", `/api/plans/${p.id}/shopping?entries=`)).json.items, []);
  assert.equal((await call("GET", `/api/plans/${p.id}/shopping?entries=1;2`)).status, 400);
  assert.equal((await call("GET", `/api/plans/${p.id}/shopping?list=light.x`)).status, 400);
  assert.equal((await call("GET", `/api/plans/999/shopping`)).status, 404);
});

test("shopping list: items already open on the to-do list are marked (any case); a failed read does not block", async () => {
  const { call, plan: p } = await plan(fakeTodo({ open: [{ summary: "zwiebel", description: null }, { summary: "Milch", description: null }] }));
  const r = (await call("GET", `/api/plans/${p.id}/shopping?list=todo.essen`)).json;
  assert.deepEqual(r.items.map((i: any) => [i.name, i.on_list]), [["Salz", false], ["Zwiebel", true]]);
  assert.equal(r.list_error, false);

  const failing = await plan(fakeTodo({ openFails: true }));
  const f = (await failing.call("GET", `/api/plans/${failing.plan.id}/shopping?list=todo.essen`)).json;
  assert.equal(f.list_error, true);
  assert.equal(f.items.length, 2);
});

test("send: adds items in order, remembers the list for the status", async () => {
  const todo = fakeTodo();
  const { call } = setup(todo);
  assert.equal((await call("GET", "/api/shopping/status")).json.selected, null);
  const r = await call("POST", "/api/shopping/send", { list: "todo.essen", items: [{ name: "Zwiebel", spec: "3" }, { name: "Salz", spec: "" }] });
  assert.deepEqual(r.json, { added: 2, failed: 0, reason: null });
  assert.deepEqual(todo.added, [
    { list: "todo.essen", name: "Zwiebel", spec: "3" },
    { list: "todo.essen", name: "Salz", spec: null },
  ]);
  assert.deepEqual((await call("GET", "/api/shopping/status")).json, { lists: [ESSEN], reason: null, selected: "todo.essen" });
});

test("send: stops at the first failure and reports the rest as failed", async () => {
  const todo = fakeTodo({ failAt: 1 });
  const { call } = setup(todo);
  const items = ["A", "B", "C"].map((name) => ({ name, spec: null }));
  assert.deepEqual((await call("POST", "/api/shopping/send", { list: "todo.essen", items })).json, { added: 1, failed: 2, reason: "timeout" });
  assert.deepEqual(todo.added.map((a) => a.name), ["A"]);
});

test("send: validation, unknown list, unreachable Home Assistant, one send at a time", async () => {
  const todo = fakeTodo();
  const { call } = setup(todo);
  const item = [{ name: "Milch", spec: null }];
  assert.equal((await call("POST", "/api/shopping/send", { list: "todo.essen", items: [] })).status, 400);
  assert.equal((await call("POST", "/api/shopping/send", { list: "light.kitchen", items: item })).status, 400);
  assert.equal((await call("POST", "/api/shopping/send", { list: "todo.essen", items: [{ name: "x".repeat(81), spec: null }] })).status, 400);
  assert.equal((await call("POST", "/api/shopping/send", { list: "todo.essen", items: Array(201).fill(item[0]) })).status, 400);
  const unknown = await call("POST", "/api/shopping/send", { list: "todo.andere", items: item });
  assert.deepEqual([unknown.status, unknown.json.error], [400, "unknown list"]);

  todo.hold();
  const first = call("POST", "/api/shopping/send", { list: "todo.essen", items: item });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal((await call("POST", "/api/shopping/send", { list: "todo.essen", items: item })).status, 429);
  todo.go();
  assert.equal((await first).status, 200);

  const down = setup(fakeTodo({ unreachable: true }));
  const r = await down.call("POST", "/api/shopping/send", { list: "todo.essen", items: item });
  assert.deepEqual([r.status, r.json.reason], [502, "unreachable"]);
});

test("migration v8 adds the setting table", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v8.db");
    const first = openDb(file);
    const plan = createRepo(first).createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
    first.exec("DROP TABLE setting");
    first.exec("PRAGMA user_version = 8");
    first.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    const repo = createRepo(db);
    assert.equal(repo.getPlan(plan.id).id, plan.id);
    assert.equal(repo.getSetting("shopping_list_entity"), null);
    repo.setSetting("shopping_list_entity", "todo.essen");
    repo.setSetting("shopping_list_entity", "todo.dm");
    assert.equal(repo.getSetting("shopping_list_entity"), "todo.dm");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Eine Liste mit Nüssen (Macadamia) und Nüssen (Walnuss), beide aus verschiedenen Gerichten.
async function nuts(todo: HaTodo) {
  const { call, plan: p, suppe, pasta } = await plan(todo);
  await call("PUT", `/api/dishes/${suppe.dish_id}/recipe`, { servings: null, instructions: null, ingredients: [ing(50, "g", "Nüsse", "Macadamia")] });
  await call("PUT", `/api/dishes/${pasta.dish_id}/recipe`, { servings: null, instructions: null, ingredients: [ing(50, "g", "Nüsse", "Walnuss")] });
  await call("PATCH", `/api/entries/${pasta.id}`, { done: false });
  return { call, p, url: `/api/plans/${p.id}/shopping?list=todo.essen` };
}

test("shopping list: a note makes its own item with the note in the spec, keys are unique", async () => {
  const { call, url } = await nuts(fakeTodo());
  const items = (await call("GET", url)).json.items;
  assert.deepEqual(items.map((i: any) => [i.name, i.note, i.spec, i.on_list]), [
    ["Nüsse", "Macadamia", "Macadamia, 50 g", false],
    ["Nüsse", "Walnuss", "Walnuss, 50 g", false],
  ]);
  assert.equal(new Set(items.map((i: any) => i.key)).size, 2);
});

test("on_list: an open item of the same name only counts for the note its description mentions", async () => {
  const walnuss = await nuts(fakeTodo({ open: [{ summary: "Nüsse", description: "walnuss, 20 g" }] }));
  assert.deepEqual((await walnuss.call("GET", walnuss.url)).json.items.map((i: any) => [i.note, i.on_list]), [["Macadamia", false], ["Walnuss", true]]);

  const noDescription = await nuts(fakeTodo({ open: [{ summary: "Nüsse", description: null }] }));
  assert.deepEqual((await noDescription.call("GET", noDescription.url)).json.items.map((i: any) => i.on_list), [false, false]);

  // Without a note the name alone decides, whatever the description says.
  const plain = await plan(fakeTodo({ open: [{ summary: "Zwiebel", description: "2 Stück" }] }));
  const r = (await plain.call("GET", `/api/plans/${plain.plan.id}/shopping?list=todo.essen`)).json;
  assert.deepEqual(r.items.map((i: any) => [i.name, i.on_list]), [["Salz", false], ["Zwiebel", true]]);
});

test("send: takes a spec of the full length and refuses a longer one", async () => {
  const { call } = setup(fakeTodo());
  const send = (spec: string) => call("POST", "/api/shopping/send", { list: "todo.essen", items: [{ name: "Mandeln", spec }] });
  assert.equal((await send("x".repeat(200))).status, 200);
  assert.equal((await send("x".repeat(201))).status, 400);
});
