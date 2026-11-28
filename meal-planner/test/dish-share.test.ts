import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo, linkKey } from "../src/repo.ts";

function setup() {
  const db = openDb(":memory:");
  const app = createApp(createRepo(db));
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, db };
}

const recipe = {
  servings: 4,
  instructions: "Zwiebel würfeln\nAnbraten",
  ingredients: [{ section: null, amount: 2, amount_max: null, unit: null, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: "gewürfelt", raw: "2 rote Zwiebeln, gewürfelt" }],
};

async function exportAll(call: ReturnType<typeof setup>["call"], notes = true) {
  const ids = (await call("GET", "/api/dishes")).json.map((d: any) => d.id);
  return call("POST", "/api/dishes/export", { ids, notes });
}

const file = (dishes: unknown[]) => ({ format: "essensplanung-dishes", version: 1, dishes });
const shared = (over: Record<string, unknown> = {}) => ({
  title: "Curry",
  url: "https://example.org/curry",
  note: "scharf",
  tags: ["Asiatisch"],
  source_text: "2 rote Zwiebeln",
  source_truncated: false,
  recipe,
  ...over,
});

test("export and import into an empty catalog carry recipe, tags, note and source text, never the image", async () => {
  const a = setup();
  const d = (
    await a.call("POST", "/api/dishes", { title: "Curry", url: "https://example.org/curry", note: "scharf", tags: ["Asiatisch"], source_text: "2 rote Zwiebeln", recipe })
  ).json;
  a.db.prepare("UPDATE dish SET image = 'abc.jpg' WHERE id = ?").run(d.id);
  await a.call("POST", "/api/dishes", { title: "Brot" });
  const exp = await exportAll(a.call);
  assert.equal(exp.status, 200);
  assert.equal(exp.json.format, "essensplanung-dishes");
  assert.equal(exp.json.version, 1);
  assert.ok(exp.json.dishes.every((x: any) => !("image" in x)));
  assert.equal(exp.json.dishes.find((x: any) => x.title === "Brot").recipe, null);

  const b = setup();
  const preview = await b.call("POST", "/api/dishes/import/preview", exp.json);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.dishes.map((x: any) => [x.title, x.exists, x.ingredients]).sort(), [["Brot", null, 0], ["Curry", null, 1]]);
  const actions = exp.json.dishes.map((_: unknown, index: number) => ({ index, action: "new" }));
  const imp = await b.call("POST", "/api/dishes/import", { file: exp.json, tags: true, actions });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.created, 2);
  assert.equal(imp.json.skipped, 0);
  const curry = (await b.call("GET", "/api/dishes?q=Curry")).json[0];
  assert.deepEqual([curry.url, curry.note, curry.tags, curry.image], ["https://example.org/curry", "scharf", ["Asiatisch"], null]);
  assert.deepEqual(imp.json.needs_image, [{ id: curry.id, url: "https://example.org/curry" }]);
  const r = (await b.call("GET", `/api/dishes/${curry.id}/recipe`)).json;
  assert.equal(r.servings, 4);
  assert.equal(r.source_text, "2 rote Zwiebeln");
  assert.deepEqual(r.ingredients, recipe.ingredients);
});

test("export without notes leaves them out", async () => {
  const a = setup();
  await a.call("POST", "/api/dishes", { title: "Curry", note: "privat" });
  assert.equal((await exportAll(a.call, false)).json.dishes[0].note, null);
});

test("linkKey ignores fragment, trailing slash, host case, tracking parameters and parameter order", () => {
  assert.equal(linkKey("https://WWW.Example.org/reel/ABC/?igsh=xyz#top"), linkKey("https://www.example.org/reel/ABC"));
  assert.equal(linkKey("https://x.de/r?id=1&utm_source=wa&fbclid=1"), linkKey("https://x.de/r?id=1"));
  assert.equal(linkKey("https://x.de/r?b=2&id=1"), linkKey("https://x.de/r?id=1&b=2"));
  assert.notEqual(linkKey("https://x.de/r?id=1"), linkKey("https://x.de/r?id=2"));
});

test("preview matches by link, without a link by title (any case), and writes nothing", async () => {
  const { call } = setup();
  const own = (await call("POST", "/api/dishes", { title: "Mein Curry", url: "https://Example.org/curry/" })).json;
  const plain = (await call("POST", "/api/dishes", { title: "BROT" })).json;
  await call("POST", "/api/dishes", { title: "Suppe", url: "https://example.org/suppe" });
  const r = await call(
    "POST",
    "/api/dishes/import/preview",
    file([shared({ url: "https://example.org/curry?igsh=abc" }), shared({ title: "Brot", url: null }), shared({ title: "Suppe", url: "https://other.org/suppe" }), shared({ title: "Neu", url: "https://example.org/neu" })]),
  );
  assert.deepEqual(
    r.json.dishes.map((d: any) => [d.exists, d.title_taken]),
    [
      [{ id: own.id, title: "Mein Curry" }, false],
      [{ id: plain.id, title: "BROT" }, false],
      [null, true], // same title, another link: another recipe
      [null, false],
    ],
  );
  assert.equal((await call("GET", "/api/dishes")).json.length, 3);
});

test("replace merges tags, keeps the own image, an own note when the file has none, plan entries; clears cook ticks", async () => {
  const { call, db } = setup();
  const own = (await call("POST", "/api/dishes", { title: "Unser Curry", url: "https://example.org/curry/", note: "meine Notiz", tags: ["Schnell"], recipe })).json;
  db.prepare("UPDATE dish SET image = 'abc.jpg' WHERE id = ?").run(own.id);
  const p = (await call("POST", "/api/plans", { start_date: "2026-11-28", end_date: "2026-12-04" })).json;
  const e = (await call("POST", `/api/plans/${p.id}/entries`, { dish_id: own.id })).json;
  assert.equal((await call("PUT", `/api/entries/${e.id}/checks`, { kind: "step", idx: 0, checked: true })).status, 200);

  const other = { ...recipe, servings: 2, ingredients: [{ ...recipe.ingredients[0], name: "Lauch", plural: null, raw: "1 Lauch" }] };
  const r = await call("POST", "/api/dishes/import", { file: file([shared({ note: null, recipe: other })]), tags: true, actions: [{ index: 0, action: "replace" }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.replaced, 1);
  assert.deepEqual(r.json.needs_image, []);
  const d = (await call("GET", "/api/dishes?q=Curry")).json[0];
  // matched by the link: the own title and link stay
  assert.deepEqual([d.title, d.note, d.image, d.url, d.tags], ["Unser Curry", "meine Notiz", "abc.jpg", "https://example.org/curry/", ["Asiatisch", "Schnell"]]);
  const rec = (await call("GET", `/api/dishes/${own.id}/recipe`)).json;
  assert.deepEqual([rec.servings, rec.ingredients[0].name], [2, "Lauch"]);
  const plan = (await call("GET", `/api/plans/${p.id}`)).json;
  assert.equal(plan.entries.length, 1);
  assert.deepEqual((await call("GET", `/api/plans/${p.id}/checks`)).json.entries[0].checks.steps, []);
});

test("tags: false imports no tags and leaves own ones on replace", async () => {
  const { call } = setup();
  await call("POST", "/api/dishes", { title: "Curry", url: "https://example.org/curry", tags: ["Schnell"] });
  const actions = [{ index: 0, action: "replace" }, { index: 1, action: "new" }];
  await call("POST", "/api/dishes/import", { file: file([shared(), shared({ title: "Neu", url: "https://example.org/neu" })]), tags: false, actions });
  const all = (await call("GET", "/api/dishes")).json;
  assert.deepEqual(all.map((d: any) => [d.title, d.tags]), [["Curry", ["Schnell"]], ["Neu", []]]);
});

test("replace without a matching dish (other link) -> 404, nothing written", async () => {
  const { call } = setup();
  await call("POST", "/api/dishes", { title: "Curry", url: "https://other.org/curry", note: "alt" });
  const r = await call("POST", "/api/dishes/import", { file: file([shared()]), tags: true, actions: [{ index: 0, action: "replace" }] });
  assert.equal(r.status, 404);
  assert.equal((await call("GET", "/api/dishes")).json[0].note, "alt");
});

test("new under another title; a taken title rolls back the whole import (409)", async () => {
  const { call } = setup();
  await call("POST", "/api/dishes", { title: "Curry" });
  const ok = await call("POST", "/api/dishes/import", { file: file([shared()]), tags: true, actions: [{ index: 0, action: "new", title: "Curry (2)" }] });
  assert.equal(ok.json.created, 1);
  const bad = await call("POST", "/api/dishes/import", {
    file: file([shared({ title: "Frisch" }), shared()]),
    tags: true,
    actions: [{ index: 0, action: "new" }, { index: 1, action: "new" }],
  });
  assert.equal(bad.status, 409);
  assert.deepEqual((await call("GET", "/api/dishes")).json.map((d: any) => d.title), ["Curry", "Curry (2)"]);
});

test("dishes without an action are skipped; no link means no image to fetch", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/dishes/import", { file: file([shared({ url: null }), shared({ title: "B" })]), tags: true, actions: [{ index: 0, action: "new" }] });
  assert.deepEqual([r.json.created, r.json.skipped, r.json.needs_image], [1, 1, []]);
});

test("many tags are accepted (no limit per dish any more)", async () => {
  const { call } = setup();
  const tags = Array.from({ length: 25 }, (_, i) => `t${i}`);
  assert.equal((await call("POST", "/api/dishes", { title: "A", tags })).json.tags.length, 25);
});

test("invalid files are refused", async () => {
  const { call } = setup();
  const preview = (body: unknown) => call("POST", "/api/dishes/import/preview", body);
  assert.deepEqual((await preview({ ...file([shared()]), version: 2 })).json, { error: "unsupported file" });
  assert.deepEqual((await preview({ ...file([shared()]), format: "x" })).json, { error: "unsupported file" });
  assert.equal((await preview(file([shared({ url: "javascript:alert(1)" })]))).json.error, "invalid file");
  assert.equal((await preview(file([shared({ recipe: { ...recipe, ingredients: [{ ...recipe.ingredients[0], unit: "Tasse" }] } })]))).status, 400);
  assert.equal((await preview(file([shared({ recipe: { ...recipe, ingredients: Array(61).fill(recipe.ingredients[0]) } })]))).status, 400);
  assert.equal((await preview(file(Array(501).fill(shared())))).status, 400);
  assert.equal((await preview(file([]))).status, 400);
  const imp = (actions: unknown[]) => call("POST", "/api/dishes/import", { file: file([shared()]), tags: true, actions });
  assert.equal((await imp([{ index: 1, action: "new" }])).status, 400);
  assert.equal((await imp([{ index: 0, action: "new" }, { index: 0, action: "new" }])).status, 400);
  assert.deepEqual((await call("POST", "/api/dishes/import", { file: { ...file([shared()]), version: 2 }, tags: true, actions: [] })).json, { error: "unsupported file" });
  assert.equal((await call("POST", "/api/dishes/export", { ids: [999], notes: true })).status, 404);
});

test("a file over the size limit is refused with 413", async () => {
  const { call } = setup();
  const big = JSON.stringify(file([shared({ source_text: "x".repeat(26 * 1024 * 1024) })]));
  assert.equal((await call("POST", "/api/dishes/import/preview", big)).status, 413);
});
