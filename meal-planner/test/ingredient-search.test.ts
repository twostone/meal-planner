import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createRepo, matchesIngredient, MAX_PLURAL_SUFFIX } from "../src/repo.ts";

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

test("?ingredient= finds the singular base form from a plural, but no other word that only shares letters", async () => {
  const call = setup();
  await dish(call, "Suppe", ["Zwiebel", "Tomate"]);
  await dish(call, "Kuchen", ["Ei", "Mehl"]);
  await dish(call, "Risotto", ["Reis"]);
  assert.deepEqual(await titles(call, "ingredient=zwiebeln"), ["Suppe"]);
  assert.deepEqual(await titles(call, "ingredient=Tomaten"), ["Suppe"]);
  assert.deepEqual(await titles(call, "ingredient=eier"), ["Kuchen"]);
  assert.deepEqual(await titles(call, "ingredient=mais"), [], "Ei is not the start of mais");
  assert.deepEqual(await titles(call, "ingredient=reise"), ["Risotto"], "one letter more is still a plural ending");
  assert.deepEqual(await titles(call, "ingredient=reisnudeln"), [], "more than two letters more: another word");
  assert.deepEqual(await titles(call, "ingredient=eis"), ["Kuchen", "Risotto"], "accepted: Ei matches eis (prefix), Reis contains eis");
});

test("matchesIngredient: substring or plural ending of at most MAX_PLURAL_SUFFIX letters", () => {
  assert.equal(matchesIngredient("zwiebel", "zwiebeln"), true);
  assert.equal(matchesIngredient("tomate", "tomaten"), true);
  assert.equal(matchesIngredient("ei", "eier"), true);
  assert.equal(matchesIngredient("eis", "reis"), false);
  assert.equal(matchesIngredient("ei", "mais"), false);
  assert.equal(matchesIngredient("zucchini", "zucch"), true);
  assert.equal(matchesIngredient("ei", "e".padEnd(2 + MAX_PLURAL_SUFFIX + 1, "x")), false);
  assert.equal(matchesIngredient("", "ab"), false);
});

test("GET /api/ingredients/names: each name once (case and spaces do not matter), most used first", async () => {
  const call = setup();
  assert.deepEqual((await call("GET", "/api/ingredients/names")).json, []);
  await dish(call, "A", ["Zwiebel", "Möhre"]);
  await dish(call, "B", ["zwiebel ", "Apfel"]);
  await dish(call, "C", ["Zwiebel", "Möhre"]);
  assert.deepEqual((await call("GET", "/api/ingredients/names")).json, ["Zwiebel", "Möhre", "Apfel"]);
});

test("?ingredient= also finds the stored plural, umlaut plurals included", async () => {
  const call = setup();
  const d = (await call("POST", "/api/dishes", { title: "Kuchen" })).json;
  await call("PUT", `/api/dishes/${d.id}/recipe`, { servings: null, instructions: null, ingredients: [{ ...ing("Apfel"), plural: "Äpfel" }] });
  assert.deepEqual(await titles(call, "ingredient=%C3%A4pfel"), ["Kuchen"]);
  assert.deepEqual(await titles(call, "ingredient=apfel"), ["Kuchen"]);
});
