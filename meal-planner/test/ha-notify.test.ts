import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createHaNotify } from "../src/ha-notify.ts";
import { createRepo } from "../src/repo.ts";

type Got = { url: string; auth: string | undefined; body: any };

async function withSupervisor(fn: (base: string, received: () => Got[]) => Promise<void>) {
  const received: Got[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(data || "null") });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/core/api/events/`, () => received);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// notify() is fire-and-forget relative to the HTTP request, so events can land slightly after the response.
async function waitFor(fn: () => boolean, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for event");
}

const USER = { "X-Remote-User-Id": "u1", "X-Remote-User-Name": "anna", "X-Remote-User-Display-Name": "Anna" };

function setup(token: string | null, baseUrl?: string) {
  const repo = createRepo(openDb(":memory:"));
  const app = createApp(repo, { notify: createHaNotify(token, baseUrl) });
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

const PLAN = { start_date: "2020-01-01", end_date: "2020-01-07" };

test("plan_created: typed event, Bearer token, plan and user, no entry", async () => {
  await withSupervisor(async (base, received) => {
    const call = setup("tok", base);
    const plan = (await call("POST", "/api/plans", PLAN, USER)).json;
    await waitFor(() => received().length === 1);
    const ev = received()[0]!;
    assert.equal(ev.url, "/core/api/events/meal_planner_plan_created");
    assert.equal(ev.auth, "Bearer tok");
    assert.deepEqual(ev.body, {
      plan: { id: plan.id, start_date: "2020-01-01", end_date: "2020-01-07" },
      user: { id: "u1", name: "anna", display_name: "Anna" },
    });
  });
});

test("entry events: added, done, undone, removed carry plan, entry and user; other patches fire nothing", async () => {
  await withSupervisor(async (base, received) => {
    const call = setup("tok", base);
    const plan = (await call("POST", "/api/plans", PLAN)).json;
    const entry = (await call("POST", `/api/plans/${plan.id}/entries`, { title: "Linsensuppe" }, USER)).json;
    await call("PATCH", `/api/entries/${entry.id}`, { done: true }, USER);
    await call("PATCH", `/api/entries/${entry.id}`, { done: true }, USER); // unchanged -> no event
    await call("PATCH", `/api/entries/${entry.id}`, { note: "mit Brot" }, USER); // not done -> no event
    await call("PATCH", `/api/entries/${entry.id}`, { done: false }, USER);
    await call("DELETE", `/api/entries/${entry.id}`, undefined, USER);
    await waitFor(() => received().length === 5);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      received().map((e) => e.url.split("meal_planner_")[1]),
      ["plan_created", "entry_added", "entry_done", "entry_undone", "entry_removed"],
    );
    const removed = received()[4]!.body;
    assert.deepEqual(removed.entry, { id: entry.id, dish_id: entry.dish_id, title: "Linsensuppe" });
    assert.equal(removed.plan.id, plan.id);
    assert.equal(removed.user.display_name, "Anna");
  });
});

test("without user headers the user is null", async () => {
  await withSupervisor(async (base, received) => {
    const call = setup("tok", base);
    await call("POST", "/api/plans", PLAN);
    await waitFor(() => received().length === 1);
    assert.equal(received()[0]!.body.user, null);
  });
});

test("deleting a plan fires no event", async () => {
  await withSupervisor(async (base, received) => {
    const call = setup("tok", base);
    const plan = (await call("POST", "/api/plans", PLAN)).json;
    await call("DELETE", `/api/plans/${plan.id}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received().length, 1); // only plan_created
  });
});

test("no supervisor token -> nothing is ever sent", async () => {
  await withSupervisor(async (base, received) => {
    const call = setup(null, base);
    await call("POST", "/api/plans", PLAN);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received().length, 0);
  });
});

test("an unreachable supervisor does not delay or fail the triggering request", async () => {
  const server = http.createServer(() => {}); // never responds
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const call = setup("tok", `http://127.0.0.1:${(server.address() as AddressInfo).port}/core/api/events/`);
    const t0 = Date.now();
    const res = await call("POST", "/api/plans", PLAN);
    assert.equal(res.status, 201);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("deleting or patching an unknown entry is still a 404", async () => {
  const call = setup(null);
  assert.equal((await call("DELETE", "/api/entries/999")).status, 404);
  assert.equal((await call("PATCH", "/api/entries/999", { done: true })).status, 404);
});
