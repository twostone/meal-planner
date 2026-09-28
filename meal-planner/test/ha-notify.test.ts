import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createHaNotify } from "../src/ha-notify.ts";
import { createRepo } from "../src/repo.ts";

async function withWebhook(fn: (base: string, received: () => any[]) => Promise<void>) {
  const received: any[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push(JSON.parse(data || "null"));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => received);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// notify() is fire-and-forget relative to the HTTP request, so pushes can land slightly after
// the response does.
async function waitFor(fn: () => boolean, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for webhook push");
}

function setup(webhookUrl: string | null) {
  const repo = createRepo(openDb(":memory:"));
  const app = createApp(repo, { notify: createHaNotify(repo, webhookUrl) });
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

test("POST /api/plans pushes event: plan_created with the current plan", async () => {
  await withWebhook(async (base, received) => {
    const call = setup(base);
    await call("POST", "/api/plans", { start_date: "2020-01-01", end_date: "2020-01-07" });
    await waitFor(() => received().length === 1);
    assert.equal(received()[0].event, "plan_created");
    assert.equal(received()[0].plan.start_date, "2020-01-01");
    assert.deepEqual(received()[0].plan.entries, []);
  });
});

test("POST /api/plans/:id/entries pushes event: entry_added with the flattened new entry", async () => {
  await withWebhook(async (base, received) => {
    const call = setup(base);
    const plan = (await call("POST", "/api/plans", { start_date: "2020-01-01", end_date: "2020-01-07" })).json;
    await waitFor(() => received().length === 1);
    await call("POST", `/api/plans/${plan.id}/entries`, { title: "Linsensuppe", tags: ["Suppe"] });
    await waitFor(() => received().length === 2);
    const push = received()[1];
    assert.equal(push.event, "entry_added");
    assert.equal(push.plan.entry_count, 1);
    assert.equal(push.plan.done_count, 0);
    assert.deepEqual(push.plan.entries, [
      {
        id: push.plan.entries[0].id,
        dish_id: push.plan.entries[0].dish_id,
        title: "Linsensuppe",
        note: null,
        tags: ["Suppe"],
        image: null,
        url: null,
        done: false,
      },
    ]);
  });
});

test("PATCH/DELETE entry and DELETE plan push event: null (state only, no HA bus event)", async () => {
  await withWebhook(async (base, received) => {
    const call = setup(base);
    const plan = (await call("POST", "/api/plans", { start_date: "2020-01-01", end_date: "2020-01-07" })).json;
    const entry = (await call("POST", `/api/plans/${plan.id}/entries`, { title: "Linsensuppe" })).json;
    await waitFor(() => received().length === 2);

    await call("PATCH", `/api/entries/${entry.id}`, { done: true });
    await waitFor(() => received().length === 3);
    assert.equal(received()[2].event, null);
    assert.equal(received()[2].plan.done_count, 1);

    await call("DELETE", `/api/entries/${entry.id}`);
    await waitFor(() => received().length === 4);
    assert.equal(received()[3].event, null);
    assert.equal(received()[3].plan.entry_count, 0);

    await call("DELETE", `/api/plans/${plan.id}`);
    await waitFor(() => received().length === 5);
    assert.equal(received()[4].event, null);
    assert.equal(received()[4].plan, null); // no plans left at all
  });
});

test("no webhook URL configured -> nothing is ever sent", async () => {
  await withWebhook(async (_base, received) => {
    const call = setup(null);
    await call("POST", "/api/plans", { start_date: "2020-01-01", end_date: "2020-01-07" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received().length, 0);
  });
});

test("an unreachable webhook does not delay or fail the triggering request", async () => {
  const server = http.createServer(() => {}); // never responds
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = setup(base);
    const t0 = Date.now();
    const res = await call("POST", "/api/plans", { start_date: "2020-01-01", end_date: "2020-01-07" });
    assert.equal(res.status, 201);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("repo.getCurrentPlan(): none, the one containing today, nearest upcoming, else newest", () => {
  const repo = createRepo(openDb(":memory:"));
  assert.equal(repo.getCurrentPlan(), null);

  const today = new Date().toISOString().slice(0, 10);
  const past = repo.createPlan({ start_date: "2000-01-01", end_date: "2000-01-07" });
  assert.equal(repo.getCurrentPlan()!.id, past.id); // only plan so far -> newest

  const future1 = repo.createPlan({ start_date: "2999-02-01", end_date: "2999-02-07" });
  const future2 = repo.createPlan({ start_date: "2999-01-01", end_date: "2999-01-07" });
  assert.equal(repo.getCurrentPlan()!.id, future2.id); // nearest upcoming, not the newest by id

  const current = repo.createPlan({ start_date: today, end_date: today });
  assert.equal(repo.getCurrentPlan()!.id, current.id); // a plan spanning today wins over upcoming

  void future1;
});
