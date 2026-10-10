import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb, SCHEMA_V1 } from "../src/db.ts";
import type { HaEventInput } from "../src/ha-notify.ts";
import { createRepo } from "../src/repo.ts";

const USER = { "X-Remote-User-Id": "u1", "X-Remote-User-Name": "anna", "X-Remote-User-Display-Name": "Anna" };

function setup() {
  const events: HaEventInput[] = [];
  const db = openDb(":memory:");
  const app = createApp(createRepo(db), { notify: async (ev) => void events.push(ev) });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const plan = async (start_date: string, end_date: string) =>
    (await call("POST", "/api/plans", { start_date, end_date })).json;
  return { call, plan, db, events, updated: () => events.filter((e) => e.type === "plan_updated") };
}

test("new plans have no name", async () => {
  const { plan } = setup();
  assert.equal((await plan("2026-10-03", "2026-10-09")).title, null);
});

test("PATCH changes name and period together; GET and the list show the result", async () => {
  const { call, plan } = setup();
  const p = await plan("2026-10-03", "2026-10-09");
  const r = await call("PATCH", `/api/plans/${p.id}`, { title: "  Woche 41  ", start_date: "2026-10-04", end_date: "2026-10-10" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.title, r.json.start_date, r.json.end_date], ["Woche 41", "2026-10-04", "2026-10-10"]);
  const got = (await call("GET", `/api/plans/${p.id}`)).json;
  assert.deepEqual([got.title, got.start_date, got.end_date], ["Woche 41", "2026-10-04", "2026-10-10"]);
  assert.equal((await call("GET", "/api/plans")).json[0].title, "Woche 41");
});

test("PATCH: the name alone keeps the period; \"\" or null clears the name", async () => {
  const { call, plan } = setup();
  const p = await plan("2026-10-03", "2026-10-09");
  const named = (await call("PATCH", `/api/plans/${p.id}`, { title: "Gäste" })).json;
  assert.deepEqual([named.title, named.start_date, named.end_date], ["Gäste", "2026-10-03", "2026-10-09"]);
  const dates = (await call("PATCH", `/api/plans/${p.id}`, { start_date: "2026-10-03", end_date: "2026-10-08" })).json;
  assert.deepEqual([dates.title, dates.end_date], ["Gäste", "2026-10-08"]);
  assert.equal((await call("PATCH", `/api/plans/${p.id}`, { title: "" })).json.title, null);
  await call("PATCH", `/api/plans/${p.id}`, { title: "x" });
  assert.equal((await call("PATCH", `/api/plans/${p.id}`, { title: null })).json.title, null);
});

test("PATCH validation: end before start, only one date, bad date, blank or too long name are 400", async () => {
  const { call, plan } = setup();
  const p = await plan("2026-10-03", "2026-10-09");
  const patch = (body: unknown) => call("PATCH", `/api/plans/${p.id}`, body).then((r) => r.status);
  assert.equal(await patch({ start_date: "2026-10-10", end_date: "2026-10-09" }), 400);
  assert.equal(await patch({ start_date: "2026-10-03" }), 400);
  assert.equal(await patch({ end_date: "2026-10-20" }), 400);
  assert.equal(await patch({ start_date: "2026-13-01", end_date: "2026-13-02" }), 400);
  assert.equal(await patch({ title: "   " }), 400);
  assert.equal(await patch({ title: "x".repeat(101) }), 400);
  const got = (await call("GET", `/api/plans/${p.id}`)).json;
  assert.deepEqual([got.title, got.start_date, got.end_date], [null, "2026-10-03", "2026-10-09"]);
});

test("PATCH of an unknown plan is 404", async () => {
  const { call } = setup();
  assert.equal((await call("PATCH", "/api/plans/999", { title: "x" })).status, 404);
});

test("a new period that overlaps another plan is refused with 409 and changes nothing", async () => {
  const { call, plan } = setup();
  const a = await plan("2026-10-03", "2026-10-09");
  const b = await plan("2026-10-10", "2026-10-16");
  const clash = await call("PATCH", `/api/plans/${b.id}`, { title: "neu", start_date: "2026-10-09", end_date: "2026-10-16" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, "plan overlaps");
  // fully containing the other plan counts too
  assert.equal((await call("PATCH", `/api/plans/${b.id}`, { start_date: "2026-10-01", end_date: "2026-10-20" })).status, 409);
  const got = (await call("GET", `/api/plans/${b.id}`)).json;
  assert.deepEqual([got.title, got.start_date, got.end_date], [null, "2026-10-10", "2026-10-16"]);
  assert.equal(a.start_date, "2026-10-03");
});

test("touching without overlap is fine, and a plan never collides with its own old period", async () => {
  const { call, plan } = setup();
  await plan("2026-10-03", "2026-10-09");
  const b = await plan("2026-10-11", "2026-10-16");
  assert.equal((await call("PATCH", `/api/plans/${b.id}`, { start_date: "2026-10-10", end_date: "2026-10-16" })).status, 200);
  assert.equal((await call("PATCH", `/api/plans/${b.id}`, { start_date: "2026-10-12", end_date: "2026-10-14" })).status, 200);
});

test("renaming a plan that already overlaps another (created before this check existed) still works", async () => {
  const { call, plan, db } = setup();
  await plan("2026-10-03", "2026-10-09");
  // plans created before POST checked overlaps: insert directly, createPlan would refuse this now
  db.prepare("INSERT INTO plan (start_date, end_date) VALUES (?, ?)").run("2026-10-05", "2026-10-12");
  const b = (await call("GET", "/api/plans")).json.find((x: any) => x.start_date === "2026-10-05");
  assert.equal((await call("PATCH", `/api/plans/${b.id}`, { title: "Doppelt" })).status, 200);
  assert.equal((await call("PATCH", `/api/plans/${b.id}`, { start_date: "2026-10-05", end_date: "2026-10-13" })).status, 409);
});

test("plan_updated carries the new plan, the previous values and the user", async () => {
  const { call, plan, updated } = setup();
  const p = await plan("2026-10-03", "2026-10-09");
  await call("PATCH", `/api/plans/${p.id}`, { title: "Woche 41", start_date: "2026-10-04", end_date: "2026-10-10" }, USER);
  assert.deepEqual(updated(), [
    {
      type: "plan_updated",
      plan: { id: p.id, start_date: "2026-10-04", end_date: "2026-10-10", title: "Woche 41" },
      previous: { start_date: "2026-10-03", end_date: "2026-10-09", title: null },
      user: { id: "u1", name: "anna", display_name: "Anna" },
    },
  ]);
});

test("no plan_updated without a change, on validation errors, on 404 or on an overlap", async () => {
  const { call, plan, updated } = setup();
  const a = await plan("2026-10-03", "2026-10-09");
  const b = await plan("2026-10-10", "2026-10-16");
  await call("PATCH", `/api/plans/${a.id}`, { start_date: "2026-10-03", end_date: "2026-10-09" }); // unchanged
  await call("PATCH", `/api/plans/${a.id}`, {}); // nothing to change
  await call("PATCH", `/api/plans/${a.id}`, { start_date: "2026-10-10", end_date: "2026-10-09" }); // 400
  await call("PATCH", "/api/plans/999", { title: "x" }); // 404
  await call("PATCH", `/api/plans/${b.id}`, { start_date: "2026-10-09", end_date: "2026-10-16" }); // 409
  assert.equal(updated().length, 0);
  await call("PATCH", `/api/plans/${a.id}`, { title: "jetzt" });
  assert.equal(updated().length, 1);
});

test("without user headers the user of plan_updated is null", async () => {
  const { call, plan, updated } = setup();
  const p = await plan("2026-10-03", "2026-10-09");
  await call("PATCH", `/api/plans/${p.id}`, { title: "x" });
  assert.equal(updated()[0]!.user, null);
});

test("migration v4 -> v5 keeps plans and entries and adds the name column", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v4.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_V1);
    old.exec("ALTER TABLE dish ADD COLUMN image TEXT");
    old.exec(`CREATE TABLE dish_tag (
      dish_id INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
      tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0),
      PRIMARY KEY (dish_id, tag)
    ) STRICT; CREATE INDEX dish_tag_tag ON dish_tag(tag);`);
    old.exec("ALTER TABLE plan_entry ADD COLUMN note TEXT");
    old.exec("PRAGMA user_version = 4");
    old.exec("INSERT INTO dish (title) VALUES ('Linsensuppe')");
    old.exec("INSERT INTO plan (start_date, end_date) VALUES ('2026-09-26', '2026-10-01')");
    old.exec("INSERT INTO plan_entry (plan_id, dish_id, position, done) VALUES (1, 1, 0, 1)");
    old.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
    const repo = createRepo(db);
    const p = repo.getPlan(1);
    assert.deepEqual([p.title, p.start_date, p.entries.length], [null, "2026-09-26", 1]);
    assert.equal(repo.updatePlan(1, { title: "Alt" }).plan.title, "Alt");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creating a plan whose period overlaps another is refused with 409, creates nothing and sends no event", async () => {
  const { call, plan, events } = setup();
  await plan("2026-10-03", "2026-10-09");
  events.length = 0;
  for (const [start_date, end_date] of [
    ["2026-10-03", "2026-10-09"], // identical
    ["2026-10-09", "2026-10-15"], // shares the last day
    ["2026-09-28", "2026-10-03"], // shares the first day
    ["2026-10-05", "2026-10-06"], // inside
    ["2026-10-01", "2026-10-20"], // contains
  ]) {
    const res = await call("POST", "/api/plans", { start_date, end_date });
    assert.equal(res.status, 409, `${start_date}..${end_date}`);
    assert.equal(res.json.error, "plan overlaps");
  }
  assert.equal((await call("GET", "/api/plans")).json.length, 1);
  assert.deepEqual(events, []);
});

test("creating a plan that only touches or sits next to another is fine", async () => {
  const { call, plan } = setup();
  await plan("2026-10-03", "2026-10-09");
  assert.equal((await call("POST", "/api/plans", { start_date: "2026-10-10", end_date: "2026-10-16" })).status, 201);
  assert.equal((await call("POST", "/api/plans", { start_date: "2026-09-26", end_date: "2026-10-02" })).status, 201);
});
