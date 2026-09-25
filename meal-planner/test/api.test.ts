import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

function setup() {
  const app = createApp(createRepo(openDb(":memory:")));
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return call;
}

const plan = { start_date: "2026-09-26", end_date: "2026-10-01" };

test("plan: create, validate dates, list, get, delete", async () => {
  const call = setup();
  assert.equal((await call("POST", "/api/plans", { start_date: "2026-10-01", end_date: "2026-09-26" })).status, 400);
  assert.equal((await call("POST", "/api/plans", { start_date: "26.09.2026", end_date: "2026-10-01" })).status, 400);
  const created = await call("POST", "/api/plans", plan);
  assert.equal(created.status, 201);
  const list = await call("GET", "/api/plans");
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].entry_count, 0);
  assert.deepEqual((await call("GET", `/api/plans/${created.json.id}`)).json.entries, []);
  assert.equal((await call("DELETE", `/api/plans/${created.json.id}`)).status, 204);
  assert.equal((await call("GET", `/api/plans/${created.json.id}`)).status, 404);
});

test("entry by title creates catalog dish and reuses it case-insensitively", async () => {
  const call = setup();
  const p1 = (await call("POST", "/api/plans", plan)).json;
  const p2 = (await call("POST", "/api/plans", { start_date: "2026-10-03", end_date: "2026-10-08" })).json;

  const e1 = await call("POST", `/api/plans/${p1.id}/entries`, { title: "Linsensuppe", url: "https://example.com/r" });
  assert.equal(e1.status, 201);
  const e2 = await call("POST", `/api/plans/${p2.id}/entries`, { title: "linsensuppe" });
  assert.equal(e2.json.dish_id, e1.json.dish_id);
  assert.equal(e2.json.dish.url, "https://example.com/r");
  assert.equal((await call("GET", "/api/dishes")).json.length, 1);
  // same dish twice in one plan is rejected
  assert.equal((await call("POST", `/api/plans/${p1.id}/entries`, { title: "LINSENSUPPE" })).status, 409);
});

test("entry by dish_id, unknown ids", async () => {
  const call = setup();
  const p = (await call("POST", "/api/plans", plan)).json;
  const d = (await call("POST", "/api/dishes", { title: "Pizza" })).json;
  assert.equal((await call("POST", `/api/plans/${p.id}/entries`, { dish_id: d.id })).status, 201);
  assert.equal((await call("POST", `/api/plans/${p.id}/entries`, { dish_id: 999 })).status, 404);
  assert.equal((await call("POST", `/api/plans/999/entries`, { dish_id: d.id })).status, 404);
});

test("done toggle and reordering", async () => {
  const call = setup();
  const p = (await call("POST", "/api/plans", plan)).json;
  const ids: number[] = [];
  for (const t of ["A", "B", "C"]) ids.push((await call("POST", `/api/plans/${p.id}/entries`, { title: t })).json.id);

  assert.equal((await call("PATCH", `/api/entries/${ids[0]}`, { done: true })).json.done, true);
  await call("PATCH", `/api/entries/${ids[2]}`, { position: 0 });
  const titles = (await call("GET", `/api/plans/${p.id}`)).json.entries.map((e: any) => e.dish.title);
  assert.deepEqual(titles, ["C", "A", "B"]);
  await call("PATCH", `/api/entries/${ids[2]}`, { position: 99 }); // clamped to end
  const after = (await call("GET", `/api/plans/${p.id}`)).json.entries.map((e: any) => e.dish.title);
  assert.deepEqual(after, ["A", "B", "C"]);
  const summary = (await call("GET", "/api/plans")).json[0];
  assert.equal(summary.entry_count, 3);
  assert.equal(summary.done_count, 1);
});

test("dish: url validation, duplicate title, search, delete guarded by usage", async () => {
  const call = setup();
  assert.equal((await call("POST", "/api/dishes", { title: "X", url: "javascript:alert(1)" })).status, 400);
  assert.equal((await call("POST", "/api/dishes", { title: "   " })).status, 400);
  const d = await call("POST", "/api/dishes", { title: "Käsespätzle", url: "https://instagram.com/reel/abc" });
  assert.equal(d.status, 201);
  assert.equal((await call("POST", "/api/dishes", { title: "käsespätzle" })).status, 409);
  await call("POST", "/api/dishes", { title: "100% Salat_1" });
  assert.equal((await call("GET", "/api/dishes?q=100%25")).json.length, 1); // % is literal, not a wildcard
  assert.equal((await call("GET", "/api/dishes?q=spätzle")).json.length, 1);
  assert.equal((await call("PATCH", `/api/dishes/${d.json.id}`, { url: "" })).json.url, null);

  const p = (await call("POST", "/api/plans", plan)).json;
  await call("POST", `/api/plans/${p.id}/entries`, { dish_id: d.json.id });
  assert.equal((await call("DELETE", `/api/dishes/${d.json.id}`)).status, 409);
  await call("DELETE", `/api/plans/${p.id}`); // entries cascade
  assert.equal((await call("DELETE", `/api/dishes/${d.json.id}`)).status, 204);
});

test("/api/me reads ingress headers", async () => {
  const call = setup();
  assert.equal((await call("GET", "/api/me")).json.user, null);
  const me = await call("GET", "/api/me", undefined, { "X-Remote-User-Id": "abc", "X-Remote-User-Display-Name": "Niklas" });
  assert.equal(me.json.user.id, "abc");
  assert.equal(me.json.user.display_name, "Niklas");
});
