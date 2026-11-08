import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { openDb } from "../src/db.ts";
import type { HaEventInput } from "../src/ha-notify.ts";
import { buildMcpServer, createMcpEndpoint } from "../src/mcp.ts";
import { createMcpListener } from "../src/mcp-listener.ts";
import { HaUnavailableError, type HaTokenVerifier } from "../src/auth/ha-token.ts";
import { createRepo } from "../src/repo.ts";

const TODAY = "2026-11-04";
const USER = { id: "u1", name: null, display_name: "Anna" };
const APP = "https://essen.example.test";
const HA = "https://ha.example.test";

function setup() {
  const repo = createRepo(openDb(":memory:"));
  const events: HaEventInput[] = [];
  const deps = { repo, notify: async (e: HaEventInput) => void events.push(e), today: () => TODAY };
  return { repo, events, deps };
}

async function connect(deps: ReturnType<typeof setup>["deps"]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(deps, USER).connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}
type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as unknown as ToolResult;
// Events are fired without waiting; let them land.
const settle = () => new Promise((r) => setImmediate(r));

const READ_TOOLS = ["get_plan", "get_recipe", "list_plans", "search_dishes"];
const WRITE_TOOLS = ["add_to_plan", "create_dish", "create_plan", "remove_from_plan", "set_recipe", "update_dish", "update_plan", "update_plan_entry"];

test("tools: curated list, described inputs, structured outputs, read-only hints", async () => {
  const c = await connect(setup().deps);
  const tools = (await c.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const t of tools) {
    assert.ok(t.description, t.name);
    assert.ok(t.outputSchema, `${t.name} has an output schema`);
    assert.equal(t.annotations?.readOnlyHint, READ_TOOLS.includes(t.name), t.name);
  }
  for (const name of ["remove_from_plan", "set_recipe"]) assert.equal(tools.find((t) => t.name === name)?.annotations?.destructiveHint, true, name);
});

test("plans: create (with name), overlap refused, current plan by date, rename fires plan_updated", async () => {
  const { events, deps } = setup();
  const c = await connect(deps);
  const created = await call(c, "create_plan", { start_date: "2026-11-01", end_date: "2026-11-07", title: "Herbst" });
  assert.equal(created.isError, undefined);
  const plan = created.structuredContent!.plan;
  assert.deepEqual(plan, { id: plan.id, title: "Herbst", start_date: "2026-11-01", end_date: "2026-11-07" });
  assert.deepEqual(JSON.parse(created.content[0]!.text), created.structuredContent);

  const overlap = await call(c, "create_plan", { start_date: "2026-11-07", end_date: "2026-11-10" });
  assert.equal(overlap.isError, true);
  assert.match(overlap.content[0]!.text, /plan overlaps/);
  assert.equal((await call(c, "create_plan", { start_date: "2026-11-10", end_date: "2026-11-01" })).isError, true);

  const list = (await call(c, "list_plans")).structuredContent!;
  assert.equal(list.today, TODAY);
  assert.deepEqual(list.plans.map((p: any) => [p.id, p.current]), [[plan.id, true]]);
  assert.equal((await call(c, "get_plan")).structuredContent!.plan.id, plan.id);

  await call(c, "update_plan", { plan_id: plan.id, title: "" });
  await call(c, "update_plan", { plan_id: plan.id, title: null }); // unchanged: no event
  await settle();
  assert.deepEqual(events.map((e) => e.type), ["plan_created", "plan_updated", "plan_updated"]);
  assert.deepEqual(events[0]!.user, USER);
  assert.equal(events[2]!.plan.title, null);
  assert.equal(events[2]!.previous?.title, "Herbst");
});

test("get_plan without a current plan: the next one, else a message", async () => {
  const { repo, deps } = setup();
  const c = await connect(deps);
  const none = await call(c, "get_plan");
  assert.equal(none.isError, true);
  assert.match(none.content[0]!.text, /list_plans/);
  const next = repo.createPlan({ start_date: "2026-11-10", end_date: "2026-11-16" });
  assert.equal((await call(c, "get_plan")).structuredContent!.plan.id, next.id);
  assert.match((await call(c, "get_plan", { plan_id: 999 })).content[0]!.text, /plan not found/);
});

test("entries: add by title (new dish) and by id, done, note, remove; events like the UI", async () => {
  const { repo, events, deps } = setup();
  const c = await connect(deps);
  const plan = repo.createPlan({ start_date: "2026-11-01", end_date: "2026-11-07" });
  const pasta = repo.createDish({ title: "Pasta" });

  const added = await call(c, "add_to_plan", { plan_id: plan.id, title: "Linsensuppe", url: "https://example.test/suppe", tags: ["Suppe"], entry_note: "für Montag" });
  assert.equal(added.isError, undefined);
  const entry = added.structuredContent!.entry;
  assert.equal(entry.title, "Linsensuppe");
  assert.equal(entry.note, "für Montag");
  assert.deepEqual(entry.tags, ["Suppe"]);
  assert.equal((await call(c, "add_to_plan", { plan_id: plan.id, dish_id: pasta.id })).isError, undefined);
  assert.match((await call(c, "add_to_plan", { plan_id: plan.id, dish_id: pasta.id })).content[0]!.text, /already in plan/);
  assert.match((await call(c, "add_to_plan", { plan_id: plan.id })).content[0]!.text, /either dish_id or title/);
  // Same validation as the API: only http(s) links.
  const bad = await call(c, "add_to_plan", { plan_id: plan.id, title: "X", url: "javascript:alert(1)" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /url/);

  const done = await call(c, "update_plan_entry", { entry_id: entry.entry_id, done: true });
  assert.equal(done.structuredContent!.entry.done, true);
  await call(c, "update_plan_entry", { entry_id: entry.entry_id, done: true }); // no change: no event
  await call(c, "update_plan_entry", { entry_id: entry.entry_id, note: "" });
  assert.equal(repo.getEntry(entry.entry_id).note, null);
  assert.equal((await call(c, "remove_from_plan", { entry_id: entry.entry_id })).structuredContent!.removed, true);
  assert.equal(repo.getPlan(plan.id).entries.length, 1);
  assert.ok(repo.listDishes("Linsensuppe").length, "the dish stays in the catalog");

  await settle();
  assert.deepEqual(events.map((e) => e.type), ["entry_added", "entry_added", "entry_done", "entry_removed"]);
  assert.deepEqual(events[0]!.entry, { id: entry.entry_id, dish_id: entry.dish_id, title: "Linsensuppe" });
  assert.deepEqual(events[0]!.user, USER);
});

test("catalog: create, update, search by title, ingredient and tag", async () => {
  const { deps } = setup();
  const c = await connect(deps);
  const dish = (await call(c, "create_dish", { title: "Zucchini-Pfanne", tags: ["Vegetarisch"] })).structuredContent!.dish;
  assert.match((await call(c, "create_dish", { title: "zucchini-pfanne" })).content[0]!.text, /exists/);
  await call(c, "create_dish", { title: "Gulasch" });
  const updated = (await call(c, "update_dish", { dish_id: dish.id, note: "mit Feta", tags: ["Schnell", "Vegetarisch"] })).structuredContent!.dish;
  assert.equal(updated.note, "mit Feta");
  assert.deepEqual(updated.tags, ["Schnell", "Vegetarisch"]);
  await call(c, "set_recipe", { dish_id: dish.id, ingredients: [{ amount: 2, name: "Zucchini" }] });

  const titles = async (args: Record<string, unknown>) => (await call(c, "search_dishes", args)).structuredContent!.dishes.map((d: any) => d.title);
  assert.deepEqual(await titles({ query: "pfanne" }), ["Zucchini-Pfanne"]);
  assert.deepEqual(await titles({ ingredient: "zucchini" }), ["Zucchini-Pfanne"]);
  assert.deepEqual(await titles({ tag: "schnell" }), ["Zucchini-Pfanne"]);
  assert.equal((await titles({})).length, 2);
  assert.deepEqual((await call(c, "search_dishes")).structuredContent!.tags, ["Schnell", "Vegetarisch"]);
});

test("recipe: set replaces everything, get returns steps and ingredients, source only on request", async () => {
  const { repo, deps } = setup();
  const c = await connect(deps);
  const dish = repo.createDish({ title: "Chili", source_text: "Originaltext" });
  const set = await call(c, "set_recipe", {
    dish_id: dish.id,
    servings: 4,
    steps: ["Zwiebeln würfeln", " ", "Alles kochen"],
    ingredients: [
      { amount: 2, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt" },
      { amount: 500, unit: "g", name: "Hackfleisch" },
      { section: "Topping", name: "Koriander" },
    ],
  });
  assert.equal(set.isError, undefined);
  assert.deepEqual(set.structuredContent!.steps, ["Zwiebeln würfeln", "Alles kochen"]);
  assert.equal(repo.getRecipe(dish.id).ingredients[1]!.raw, "500 g Hackfleisch");

  const got = (await call(c, "get_recipe", { dish_id: dish.id })).structuredContent!;
  assert.equal(got.servings, 4);
  assert.equal(got.ingredients.length, 3);
  assert.deepEqual(got.ingredients[0], { section: null, amount: 2, amount_max: null, unit: null, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt" });
  assert.equal(got.source_text, undefined);
  assert.equal((await call(c, "get_recipe", { dish_id: dish.id, include_source: true })).structuredContent!.source_text, "Originaltext");

  assert.equal((await call(c, "set_recipe", { dish_id: dish.id, servings: 0 })).isError, true);
  assert.equal((await call(c, "set_recipe", { dish_id: dish.id, ingredients: [{ amount: 2, unit: "cup", name: "Mehl" }] })).isError, true);
  assert.equal(repo.getRecipe(dish.id).servings, 4, "a refused recipe changes nothing");
  await call(c, "set_recipe", { dish_id: dish.id });
  assert.equal(repo.getRecipe(dish.id).ingredients.length, 0);
});

// ---- The listener: OAuth metadata, token check, nothing else exposed ----

const verifierFor = (tokens: Record<string, { id: string; name: string | null }>): HaTokenVerifier => async (token) => {
  if (token === "down") throw new HaUnavailableError("timeout");
  const user = tokens[token];
  return user ? { user, isAdmin: false, expiresAt: Math.floor(Date.now() / 1000) + 600 } : null;
};

function listener(deps = setup().deps) {
  return createMcpListener({ appUrl: APP, haUrl: HA, verifier: verifierFor({ good: { id: "u1", name: "Anna" } }), mcp: createMcpEndpoint(deps) });
}

test("listener: protected-resource metadata points to Home Assistant, open CORS", async () => {
  const app = listener();
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await app.request(path, { headers: { Origin: "https://claude.ai" } });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await res.json(), { resource: `${APP}/mcp`, authorization_servers: [HA], bearer_methods_supported: ["header"], resource_name: "Essensplanung" });
  }
});

test("listener: /mcp needs a valid Home Assistant token; 401 points to the metadata, HA down is 5xx", async () => {
  const app = listener();
  const post = (headers: Record<string, string> = {}) =>
    app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: "{}" });
  const anonymous = await post();
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate")?.includes(`resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`), true);
  assert.equal((await post({ Authorization: "Bearer wrong" })).status, 401);
  assert.ok((await post({ Authorization: "Bearer down" })).status >= 500);
});

test("listener: the Ingress API, the frontend and images are not reachable, forged user headers count for nothing", async () => {
  const app = listener();
  const headers = { Authorization: "Bearer good", "X-Remote-User-Id": "admin" };
  for (const path of ["/", "/api/plans", "/api/me", "/api/images/x.jpg", "/ha/state", "/index.html"]) {
    assert.equal((await app.request(path, { headers })).status, 404, path);
  }
  assert.equal((await app.request("/mcp", { method: "POST", headers: { "X-Remote-User-Id": "admin" } })).status, 401);
});

test("listener: an MCP client with a token works end to end and acts as the token's user", async () => {
  const { repo, events, deps } = setup();
  const app = listener(deps);
  const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    fetch: ((url: string | URL, init?: RequestInit) => app.request(String(url), init)) as typeof fetch,
    requestInit: { headers: { Authorization: "Bearer good" } },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  const plan = repo.createPlan({ start_date: "2026-11-01", end_date: "2026-11-07" });
  assert.equal((await call(client, "add_to_plan", { plan_id: plan.id, title: "Pizza" })).isError, undefined);
  await settle();
  assert.deepEqual(events[0]!.user, { id: "u1", name: null, display_name: "Anna" });
  await client.close();
});
