import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

function setup() {
  const app = createApp(createRepo(openDb(":memory:")));
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
const ing = (name: string) => ({ section: null, amount: 1, amount_max: null, unit: null, name, note: null });
async function dish(call: ReturnType<typeof setup>, title: string, names: string[]) {
  const d = (await call("POST", "/api/dishes", { title })).json;
  if (names.length) await call("PUT", `/api/dishes/${d.id}/recipe`, { servings: null, instructions: null, ingredients: names.map(ing) });
  return d.id as number;
}
const titles = async (call: ReturnType<typeof setup>, qs: string) => (await call("GET", `/api/dishes?${qs}`)).json.map((d: any) => d.title);

test("?ingredient= finds dishes by the name of an ingredient, case-insensitive and by substring", async () => {
  const call = setup();
  await dish(call, "Nudelpfanne", ["Zucchini", "Nudeln"]);
  await dish(call, "Gemüsesuppe", ["Möhren", "Zucchini"]);
  await dish(call, "Pizza", ["Mehl"]);
  await dish(call, "Ohne Rezept", []);
  assert.deepEqual(await titles(call, "ingredient=zucchini"), ["Gemüsesuppe", "Nudelpfanne"]);
  assert.deepEqual(await titles(call, "ingredient=ZUCCH"), ["Gemüsesuppe", "Nudelpfanne"]);
  assert.deepEqual(await titles(call, "ingredient=m%C3%96hr"), ["Gemüsesuppe"], "umlauts fold case too");
  assert.deepEqual(await titles(call, "ingredient=tomate"), []);
});

test("?ingredient= and ?q= must both match; blank values change nothing; a dish is listed once", async () => {
  const call = setup();
  await dish(call, "Nudelpfanne", ["Zucchini", "Zucchini (gelb)"]);
  await dish(call, "Gemüsesuppe", ["Zucchini"]);
  assert.deepEqual(await titles(call, "ingredient=zucchini&q=suppe"), ["Gemüsesuppe"]);
  assert.deepEqual(await titles(call, "ingredient=zucchini"), ["Gemüsesuppe", "Nudelpfanne"]);
  assert.equal((await titles(call, "ingredient=%20")).length, 2);
  assert.equal((await titles(call, "ingredient=")).length, 2);
});

test("the search sees the recipe as it is saved: replaced ingredients, deleted recipe", async () => {
  const call = setup();
  const id = await dish(call, "Curry", ["Linsen"]);
  assert.deepEqual(await titles(call, "ingredient=linsen"), ["Curry"]);
  await call("PUT", `/api/dishes/${id}/recipe`, { servings: null, instructions: null, ingredients: [ing("Kichererbsen")] });
  assert.deepEqual(await titles(call, "ingredient=linsen"), []);
  assert.deepEqual(await titles(call, "ingredient=kichererbsen"), ["Curry"]);
  await call("PUT", `/api/dishes/${id}/recipe`, { servings: null, instructions: null, ingredients: [] });
  assert.deepEqual(await titles(call, "ingredient=kichererbsen"), []);
});
