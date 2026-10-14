import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setLogSink } from "../src/log.ts";
import { createHaTodo, TodoError } from "../src/ha-todo.ts";

// A fake Supervisor core proxy on 127.0.0.1 (never the real network).
type Seen = { method: string; url: string; auth: string | undefined; body: any };
async function fakeSupervisor(handler: (req: Seen) => { status?: number; json?: unknown; hang?: boolean }) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: text ? JSON.parse(text) : null };
    seen.push(s);
    const r = handler(s);
    if (r.hang) return;
    res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/core/api/`;
  return { base, seen, close: () => server.closeAllConnections() ?? server.close() };
}

async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    await fn();
  } finally {
    setLogSink(null);
  }
  return lines;
}

const BRING = { entity_id: "todo.essen", name: "Essen", description: true };

test("status: disabled without token; lists only usable todo entities, sorted, with the description feature", async () => {
  assert.deepEqual(await createHaTodo(null).status(), { lists: [], reason: "disabled" });
  let states: unknown[] = [{ entity_id: "light.kitchen", state: "on" }];
  const f = await fakeSupervisor(() => ({ json: states }));
  try {
    const todo = createHaTodo("tok", f.base);
    assert.deepEqual(await todo.status(), { lists: [], reason: "no_list" });
    states = [
      { entity_id: "todo.essen", state: "4", attributes: { friendly_name: "Essen", supported_features: 1 | 2 | 4 | 64 } },
      { entity_id: "todo.shopping_list", state: "0", attributes: { friendly_name: "Einkaufsliste", supported_features: 1 | 2 | 4 | 8 } },
      { entity_id: "todo.kaputt", state: "unavailable", attributes: { supported_features: 65 } },
      { entity_id: "todo.nur_lesen", state: "3", attributes: { friendly_name: "Kalender", supported_features: 0 } },
      { entity_id: "todo.ohne_name", state: "0", attributes: { supported_features: 1 } },
    ];
    assert.deepEqual(await todo.status(), {
      lists: [
        { entity_id: "todo.shopping_list", name: "Einkaufsliste", description: false },
        BRING,
        { entity_id: "todo.ohne_name", name: "todo.ohne_name", description: false },
      ],
      reason: null,
    });
    assert.equal(f.seen[0]!.auth, "Bearer tok");
    assert.equal(f.seen[0]!.url, "/core/api/states");
  } finally {
    f.close();
  }
  assert.deepEqual(await createHaTodo("tok", "http://127.0.0.1:1/core/api/").status(), { lists: [], reason: "unreachable" });
});

test("openItems: asks for needs_action items and reads summary and description (empty = null)", async () => {
  const f = await fakeSupervisor(() => ({
    json: {
      changed_states: [],
      service_response: { "todo.essen": { items: [{ summary: "Milch", uid: "1", status: "needs_action", description: "" }, { summary: "Eier", uid: "2", status: "needs_action", description: "10" }] } },
    },
  }));
  try {
    assert.deepEqual(await createHaTodo("tok", f.base).openItems("todo.essen"), [
      { summary: "Milch", description: null },
      { summary: "Eier", description: "10" },
    ]);
    const s = f.seen[0]!;
    assert.equal(s.method, "POST");
    assert.equal(s.url, "/core/api/services/todo/get_items?return_response");
    assert.deepEqual(s.body, { entity_id: "todo.essen", status: ["needs_action"] });
  } finally {
    f.close();
  }
});

test("openItems: an answer without items is a bad response", async () => {
  const f = await fakeSupervisor(() => ({ json: { service_response: {} } }));
  try {
    await assert.rejects(createHaTodo("tok", f.base).openItems("todo.essen"), (e) => e instanceof TodoError && e.reason === "bad_response");
  } finally {
    f.close();
  }
});

test("add: description where supported, else the amount in the name, never an empty description", async () => {
  const f = await fakeSupervisor(() => ({ json: [] }));
  try {
    const todo = createHaTodo("tok", f.base);
    await todo.add(BRING, "Möhren", "350 g");
    await todo.add({ ...BRING, description: false }, "Möhren", "350 g");
    await todo.add({ ...BRING, description: false }, "Salz", null);
    await todo.add(BRING, "Salz", null);
    assert.equal(f.seen[0]!.url, "/core/api/services/todo/add_item");
    assert.deepEqual(
      f.seen.map((s) => s.body),
      [
        { entity_id: "todo.essen", item: "Möhren", description: "350 g" },
        { entity_id: "todo.essen", item: "Möhren (350 g)" },
        { entity_id: "todo.essen", item: "Salz" },
        { entity_id: "todo.essen", item: "Salz" },
      ],
    );
  } finally {
    f.close();
  }
});

test("add: errors and timeouts become TodoError, item names never reach the log", async () => {
  let reply: { status?: number; hang?: boolean } = { status: 400 };
  // Home Assistant's message repeats the item name, like Bring's "todo_save_item_failed" does.
  const f = await fakeSupervisor((s) => ({ ...reply, json: { message: `Failed to save item ${s.body.item}` } }));
  try {
    const todo = createHaTodo("tok", f.base, 200);
    const lines = await captureLog(async () => {
      await assert.rejects(todo.add(BRING, "Geheimzutat", "1 g"), (e) => e instanceof TodoError && e.reason === "unreachable");
      reply = { hang: true };
      await assert.rejects(todo.add(BRING, "Geheimzutat", "1 g"), (e) => e instanceof TodoError && e.reason === "timeout");
    });
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => !l.includes("Geheimzutat")));
  } finally {
    f.close();
  }
  await assert.rejects(createHaTodo(null).add(BRING, "x", null), (e) => e instanceof TodoError && e.reason === "disabled");
});
