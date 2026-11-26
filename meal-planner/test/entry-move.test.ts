import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { HaEventInput } from "../src/ha-notify.ts";
import { createRepo } from "../src/repo.ts";

const TODAY = "2026-10-05";

function setup() {
  const events: HaEventInput[] = [];
  const app = createApp(createRepo(openDb(":memory:")), { notify: async (e) => void events.push(e), today: () => TODAY });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, events };
}

type Call = ReturnType<typeof setup>["call"];

async function plans(call: Call) {
  const past = (await call("POST", "/api/plans", { start_date: "2026-09-19", end_date: "2026-09-25" })).json;
  const current = (await call("POST", "/api/plans", { start_date: "2026-10-03", end_date: "2026-10-09" })).json;
  const next = (await call("POST", "/api/plans", { start_date: "2026-10-10", end_date: "2026-10-16" })).json;
  return { past, current, next };
}

const add = async (call: Call, planId: number, title: string) =>
  (await call("POST", `/api/plans/${planId}/entries`, { title })).json;
const titles = async (call: Call, planId: number) =>
  (await call("GET", `/api/plans/${planId}`)).json.entries.map((e: any) => e.dish.title);

test("move: the entry leaves its plan and goes to the end of the target, with its note", async () => {
  const { call } = setup();
  const { current, next } = await plans(call);
  const pasta = await add(call, current.id, "Pasta");
  await add(call, next.id, "Curry");
  await call("PATCH", `/api/entries/${pasta.id}`, { note: "doppelte Menge" });
  const r = await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: next.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { moved: 1, merged: 0 });
  assert.deepEqual(await titles(call, current.id), []);
  const target = (await call("GET", `/api/plans/${next.id}`)).json.entries;
  assert.deepEqual(target.map((e: any) => [e.dish.title, e.note]), [["Curry", null], ["Pasta", "doppelte Menge"]]);
});

test("move: the cook mode ticks stay behind", async () => {
  const { call } = setup();
  const { current, next } = await plans(call);
  const pasta = await add(call, current.id, "Pasta");
  await call("PUT", `/api/dishes/${pasta.dish_id}/recipe`, {
    servings: 2, instructions: "Kochen", ingredients: [{ section: null, amount: 200, amount_max: null, unit: "g", name: "Nudeln", note: null }],
  });
  assert.equal((await call("PUT", `/api/entries/${pasta.id}/checks`, { kind: "step", idx: 0, checked: true })).status, 200);
  await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: next.id });
  const checks = (await call("GET", `/api/plans/${next.id}/checks`)).json.entries;
  assert.deepEqual(checks[0].checks, { ingredients: [], steps: [] });
});

test("move: a dish already in the target is merged; the note only fills an empty one", async () => {
  const { call } = setup();
  const { current, next } = await plans(call);
  const a = await add(call, current.id, "Pasta");
  const b = await add(call, current.id, "Curry");
  await add(call, next.id, "Pasta");
  const curryNext = await add(call, next.id, "Curry");
  await call("PATCH", `/api/entries/${a.id}`, { note: "alt Pasta" });
  await call("PATCH", `/api/entries/${b.id}`, { note: "alt Curry" });
  await call("PATCH", `/api/entries/${curryNext.id}`, { note: "neu Curry" });
  assert.deepEqual((await call("POST", `/api/entries/${a.id}/move`, { plan_id: next.id })).json, { moved: 0, merged: 1 });
  assert.deepEqual((await call("POST", `/api/entries/${b.id}/move`, { plan_id: next.id })).json, { moved: 0, merged: 1 });
  assert.deepEqual(await titles(call, current.id), []);
  const target = (await call("GET", `/api/plans/${next.id}`)).json.entries;
  assert.deepEqual(target.map((e: any) => [e.dish.title, e.note]), [["Pasta", "alt Pasta"], ["Curry", "neu Curry"]]);
});

test("move is refused: same plan, past plan, done entry, unknown plan or entry", async () => {
  const { call } = setup();
  const { past, current, next } = await plans(call);
  const pasta = await add(call, current.id, "Pasta");
  assert.equal((await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: current.id })).status, 400);
  assert.equal((await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: past.id })).status, 400);
  assert.equal((await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: 999 })).status, 404);
  assert.equal((await call("POST", `/api/entries/999/move`, { plan_id: current.id })).status, 404);
  await call("PATCH", `/api/entries/${pasta.id}`, { done: true });
  const done = await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: next.id });
  assert.equal(done.status, 409);
  assert.deepEqual(await titles(call, current.id), ["Pasta"]);
});

test("a plan ending today is still a valid target", async () => {
  const { call } = setup();
  const ending = (await call("POST", "/api/plans", { start_date: "2026-09-30", end_date: TODAY })).json;
  const later = (await call("POST", "/api/plans", { start_date: "2026-10-10", end_date: "2026-10-16" })).json;
  const pasta = await add(call, later.id, "Pasta");
  assert.equal((await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: ending.id })).status, 200);
});

test("move-open: moves all open entries, keeps the done ones, merges duplicates", async () => {
  const { call } = setup();
  const { past, next } = await plans(call);
  await add(call, past.id, "Pasta");
  const curry = await add(call, past.id, "Curry");
  await add(call, past.id, "Suppe");
  await add(call, next.id, "Suppe");
  await call("PATCH", `/api/entries/${curry.id}`, { done: true });
  const r = await call("POST", `/api/plans/${past.id}/move-open`, { plan_id: next.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { moved: 1, merged: 1 });
  assert.deepEqual(await titles(call, past.id), ["Curry"]);
  assert.deepEqual(await titles(call, next.id), ["Suppe", "Pasta"]);
});

test("move-open with nothing open moves nothing; the same rules for the target apply", async () => {
  const { call } = setup();
  const { past, current } = await plans(call);
  assert.deepEqual((await call("POST", `/api/plans/${current.id}/move-open`, { plan_id: current.id })).status, 400);
  assert.deepEqual((await call("POST", `/api/plans/${current.id}/move-open`, { plan_id: past.id })).status, 400);
  assert.deepEqual((await call("POST", `/api/plans/999/move-open`, { plan_id: current.id })).status, 404);
  assert.deepEqual((await call("POST", `/api/plans/${past.id}/move-open`, { plan_id: current.id })).json, { moved: 0, merged: 0 });
});

test("move fires entry_removed for the old plan and entry_added for the new one (merged: only removed)", async () => {
  const { call, events } = setup();
  const { current, next } = await plans(call);
  const pasta = await add(call, current.id, "Pasta");
  const curry = await add(call, current.id, "Curry");
  await add(call, next.id, "Curry");
  events.length = 0;
  await call("POST", `/api/entries/${pasta.id}/move`, { plan_id: next.id });
  await call("POST", `/api/entries/${curry.id}/move`, { plan_id: next.id });
  assert.deepEqual(
    events.map((e: any) => [e.type, e.plan.id, e.entry.title]),
    [
      ["entry_removed", current.id, "Pasta"],
      ["entry_added", next.id, "Pasta"],
      ["entry_removed", current.id, "Curry"],
    ],
  );
});
