import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { AiError, createHaAi, PROMPT, type RecipeAi } from "../src/ha-ai.ts";
import { createRepo } from "../src/repo.ts";

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

test("status: disabled without token, no_entity without ai_task entity, ok with one", async () => {
  assert.deepEqual(await createHaAi(null).status(), { ai: false, reason: "disabled" });
  let states: unknown[] = [{ entity_id: "light.kitchen", state: "on" }, { entity_id: "ai_task.x", state: "unavailable" }];
  const f = await fakeSupervisor(() => ({ json: states }));
  try {
    const ai = createHaAi("tok", f.base);
    assert.deepEqual(await ai.status(), { ai: false, reason: "no_entity" });
    states = [{ entity_id: "ai_task.openai_ai_task", state: "2026-10-01T10:00:00+00:00" }];
    assert.deepEqual(await ai.status(), { ai: true, reason: null });
    assert.equal(f.seen[0]!.auth, "Bearer tok");
    assert.equal(f.seen[0]!.url, "/core/api/states");
  } finally {
    f.close();
  }
  assert.deepEqual(await createHaAi("tok", "http://127.0.0.1:1/core/api/").status(), { ai: false, reason: "unreachable" });
});

test("generate: posts the task with token and returns service_response.data", async () => {
  const f = await fakeSupervisor(() => ({ json: { changed_states: [], service_response: { data: { ingredients: "[]", instructions: "x" } } } }));
  try {
    const out = await createHaAi("tok", f.base).generate("2 Eier");
    assert.deepEqual(out, { ingredients: "[]", instructions: "x" });
    const s = f.seen[0]!;
    assert.equal(s.method, "POST");
    assert.equal(s.url, "/core/api/services/ai_task/generate_data?return_response");
    assert.equal(s.auth, "Bearer tok");
    assert.ok(s.body.instructions.startsWith(PROMPT) && s.body.instructions.endsWith("2 Eier"));
    assert.deepEqual(Object.keys(s.body.structure), ["servings", "servings_quote", "ingredients", "instructions"]);
    assert.equal("entity_id" in s.body, false, "the preferred AI task entity is used");
  } finally {
    f.close();
  }
});

test("generate: a response layer keyed by entity id is accepted", async () => {
  const f = await fakeSupervisor(() => ({ json: { service_response: { "ai_task.x": { data: { ingredients: "[]" } } } } }));
  try {
    assert.deepEqual(await createHaAi("tok", f.base).generate("t"), { ingredients: "[]" });
  } finally {
    f.close();
  }
});

test("generate: errors map to AiError reasons (disabled, unreachable, bad_response, timeout)", async () => {
  await assert.rejects(createHaAi(null).generate("t"), (e: AiError) => e.reason === "disabled");
  await assert.rejects(createHaAi("t", "http://127.0.0.1:1/core/api/").generate("t"), (e: AiError) => e.reason === "unreachable");
  let mode: "500" | "empty" | "hang" = "500";
  const f = await fakeSupervisor(() => (mode === "500" ? { status: 500 } : mode === "empty" ? { json: { service_response: {} } } : { hang: true }));
  try {
    const ai = createHaAi("t", f.base, 100);
    await assert.rejects(ai.generate("t"), (e: AiError) => e.reason === "unreachable");
    mode = "empty";
    await assert.rejects(ai.generate("t"), (e: AiError) => e.reason === "bad_response");
    mode = "hang";
    await assert.rejects(ai.generate("t"), (e: AiError) => e.reason === "timeout");
  } finally {
    f.close();
  }
});

// --- API with a fake AI ---

function setup(ai?: RecipeAi) {
  const app = createApp(createRepo(openDb(":memory:")), { ai });
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
  };
}
const fakeAi = (generate: RecipeAi["generate"], ai = true): RecipeAi => ({ status: async () => (ai ? { ai: true, reason: null } : { ai: false, reason: "no_entity" }), generate });

test("GET /api/recipe/status: disabled without AI, otherwise what the AI reports", async () => {
  assert.deepEqual((await setup()("GET", "/api/recipe/status")).json, { ai: false, reason: "disabled" });
  assert.deepEqual((await setup(fakeAi(async () => ({})))("GET", "/api/recipe/status")).json, { ai: true, reason: null });
  assert.deepEqual((await setup(fakeAi(async () => ({}), false))("GET", "/api/recipe/status")).json, { ai: false, reason: "no_entity" });
});

test("POST …/recipe/draft: builds a checked draft from the source text and stores nothing", async () => {
  const seen: string[] = [];
  const call = setup(
    fakeAi(async (text) => {
      seen.push(text);
      return { servings: 4, servings_quote: "für 4", ingredients: JSON.stringify([{ section: null, amount: 2, amount_max: null, unit: "EL", name: "Öl", note: null, raw: "2 EL Öl" }, { section: null, amount: 1, unit: null, name: "Ei", raw: "1 Ei erfunden" }]), instructions: "1. Braten" };
    }),
  );
  const id = (await call("POST", "/api/dishes", { title: "A", source_text: "Rezept für 4\n2 EL Öl\nBraten" })).json.id;
  const r = await call("POST", `/api/dishes/${id}/recipe/draft`);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ["Rezept für 4\n2 EL Öl\nBraten"]);
  assert.deepEqual(r.json.ingredients.map((i: any) => [i.name, i.verified]), [["Öl", true], ["Ei", false]]);
  assert.equal(r.json.servings, 4);
  assert.equal(r.json.instructions, "Braten");
  const stored = (await call("GET", `/api/dishes/${id}/recipe`)).json;
  assert.deepEqual([stored.servings, stored.ingredients.length, stored.instructions], [null, 0, null]);
});

test("POST …/recipe/draft: no source text 400, unknown dish 404, no AI configured 404, AI failures 502", async () => {
  let fail: unknown = new AiError("timeout");
  const call = setup(fakeAi(async () => { throw fail; }));
  const bare = (await call("POST", "/api/dishes", { title: "A" })).json.id;
  assert.equal((await call("POST", `/api/dishes/${bare}/recipe/draft`)).status, 400);
  assert.equal((await call("POST", "/api/dishes/99/recipe/draft")).status, 404);
  const id = (await call("POST", "/api/dishes", { title: "B", source_text: "Text" })).json.id;
  const timeout = await call("POST", `/api/dishes/${id}/recipe/draft`);
  assert.deepEqual([timeout.status, timeout.json.reason], [502, "timeout"]);
  fail = new AiError("unreachable");
  assert.equal((await call("POST", `/api/dishes/${id}/recipe/draft`)).json.reason, "unreachable");
  // answer that is not JSON for the ingredients
  const broken = setup(fakeAi(async () => ({ ingredients: "nope" })));
  const bid = (await broken("POST", "/api/dishes", { title: "C", source_text: "Text" })).json.id;
  const b = await broken("POST", `/api/dishes/${bid}/recipe/draft`);
  assert.deepEqual([b.status, b.json.reason], [502, "bad_response"]);
  // without an AI the route does not exist
  const none = setup();
  const nid = (await none("POST", "/api/dishes", { title: "D", source_text: "Text" })).json.id;
  assert.equal((await none("POST", `/api/dishes/${nid}/recipe/draft`)).status, 404);
});
