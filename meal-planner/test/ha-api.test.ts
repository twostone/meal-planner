import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createHaApi, loadOrCreateToken } from "../src/ha-api.ts";
import { localToday } from "../src/ha-state.ts";
import { createRepo } from "../src/repo.ts";

const TOKEN = "secret-token";
const NOON = new Date(2026, 8, 30, 12, 0, 0); // 30.09.2026 local

function setup() {
  const repo = createRepo(openDb(":memory:"));
  const api = createHaApi(repo, TOKEN, () => NOON);
  const get = (path: string, headers: Record<string, string> = {}) => api.request(path, { headers });
  return { repo, api, get };
}
const auth = { Authorization: `Bearer ${TOKEN}` };

test("/ha/state: 401 without or with a wrong token, 200 with the right one", async () => {
  const { get } = setup();
  assert.equal((await get("/ha/state")).status, 401);
  assert.equal((await get("/ha/state", { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await get("/ha/state", { Authorization: TOKEN })).status, 401); // not a Bearer header
  assert.equal((await get("/ha/state", auth)).status, 200);
});

test("only GET /ha/state exists: everything else is 404, the Ingress API is not exposed", async () => {
  const { api, get } = setup();
  for (const path of ["/", "/api/plans", "/api/me", "/ha", "/ha/state/x"]) {
    assert.equal((await get(path, auth)).status, 404, path);
  }
  assert.equal((await api.request("/ha/state", { method: "POST", headers: auth })).status, 404);
});

test("state: no plans -> both null", async () => {
  const { get } = setup();
  const body = await (await get("/ha/state", auth)).json();
  assert.equal(body.current, null);
  assert.equal(body.next, null);
  assert.equal(body.generated_at, NOON.toISOString());
});

test("state: current contains today, next is the earliest one starting later; a gap means current is null", async () => {
  const { repo, get } = setup();
  repo.createPlan({ start_date: "2026-09-01", end_date: "2026-09-07" }); // past
  const cur = repo.createPlan({ start_date: "2026-09-26", end_date: "2026-10-02" });
  repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
  const nxt = repo.createPlan({ start_date: "2026-10-03", end_date: "2026-10-09" });
  const e = repo.addEntry(cur.id, { title: "Linsensuppe", tags: ["Suppe"] });
  repo.updateEntry(e.id, { done: true });
  repo.addEntry(cur.id, { title: "Pasta" });

  const body = await (await get("/ha/state", auth)).json();
  assert.equal(body.current.id, cur.id);
  assert.equal(body.current.entry_count, 2);
  assert.equal(body.current.done_count, 1);
  assert.deepEqual(body.current.entries[0], {
    id: e.id, dish_id: e.dish_id, title: "Linsensuppe", note: null, tags: ["Suppe"], image: null, url: null, done: true,
  });
  assert.equal(body.next.id, nxt.id);
  assert.deepEqual(body.next.entries, []);

  // gap: only plans entirely before and after today
  const gap = setup();
  gap.repo.createPlan({ start_date: "2026-09-01", end_date: "2026-09-07" });
  const later = gap.repo.createPlan({ start_date: "2026-10-03", end_date: "2026-10-09" });
  const g = await (await gap.get("/ha/state", auth)).json();
  assert.equal(g.current, null);
  assert.equal(g.next.id, later.id);
});

test("localToday uses the local calendar date, not UTC", () => {
  assert.equal(localToday(new Date(2026, 0, 5, 0, 30)), "2026-01-05");
  assert.equal(localToday(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("the Ingress app does not serve /ha/state", async () => {
  const app = createApp(createRepo(openDb(":memory:")));
  assert.equal((await app.request("/ha/state", { headers: auth })).status, 404);
});

test("loadOrCreateToken: created once with mode 600, then reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-token-"));
  const path = join(dir, "ha-token");
  const t = loadOrCreateToken(path);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(path), t);
  assert.equal(readFileSync(path, "utf8").trim(), t);
});
