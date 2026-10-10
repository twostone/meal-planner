import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { ImageStore } from "../src/images.ts";
import { createPreviewService, MAX_SOURCE_CHARS, type PreviewResult } from "../src/preview.ts";
import { createRepo } from "../src/repo.ts";
import type { Fetched } from "../src/safe-fetch.ts";

// --- extraction through the preview service (fake fetcher, no network) ---

const store = new ImageStore(path.join(os.tmpdir(), "mp-src-never-used"));
const page = (body: string) => ({ url: new URL("https://example.com/x"), contentType: "text/html", charset: null, body: Buffer.from(body) }) as Fetched;
const preview = (body: string) =>
  createPreviewService({ images: store, fetcher: (async () => page(body)) as never, log: () => {} })("https://example.com/x");
const og = (content: string) => `<meta property="og:title" content="${content}">`;

test("source: Instagram caption between the first and the last quote, line breaks and entities kept", async () => {
  const r = await preview(og("Kim auf Instagram: &quot;Linsen-Curry 🍛&#10;&#10;Zutaten:&#10;200 g Linsen&#10;1 Zwiebel&#10;&#10;Alles k&ouml;cheln. #curry&quot;"));
  assert.equal(r.sourceText, "Linsen-Curry 🍛\n\nZutaten:\n200 g Linsen\n1 Zwiebel\n\nAlles köcheln. #curry");
  assert.equal(r.sourceTruncated, false);
  assert.equal(r.reason, null);
});

test("source: a caption without the closing quote is marked as possibly truncated; English prefix works", async () => {
  const r = await preview(og("Kim on Instagram: &quot;Suppe&#10;2 Karotten&#10;Dann die Zwi"));
  assert.equal(r.sourceText, "Suppe\n2 Karotten\nDann die Zwi");
  assert.equal(r.sourceTruncated, true);
});

test("source: a plain title or a login page has no source; a caption with only hashtags neither", async () => {
  for (const html of ["<title>Linsensuppe</title>", og("Instagram"), og("Kim auf Instagram: &quot;#food #yum&quot;"), og("Kim auf Instagram: Ohne Anführungszeichen")]) {
    assert.equal((await preview(html)).sourceText, null, html);
  }
});

test("source: schema.org recipe gives ingredient lines, a blank line, then the steps (string, HowToStep, HowToSection)", async () => {
  const ld = (r: object) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Recipe", name: "Pasta", ...r })}</script>`;
  const a = await preview(
    ld({
      recipeIngredient: ["200 g  Spaghetti", "2 Eier &amp; Salz"],
      recipeInstructions: [
        { "@type": "HowToStep", text: "Nudeln kochen." },
        { "@type": "HowToSection", name: "Soße", itemListElement: [{ "@type": "HowToStep", text: "Eier verrühren." }] },
      ],
    }),
  );
  assert.equal(a.sourceText, "200 g Spaghetti\n2 Eier & Salz\n\nNudeln kochen.\nSoße:\nEier verrühren.");
  assert.equal(a.sourceTruncated, false);
  const b = await preview(ld({ recipeIngredient: ["1 Ei"], recipeInstructions: "Erst braten.<br>Dann essen." }));
  assert.equal(b.sourceText, "1 Ei\n\nErst braten.\nDann essen.");
  // a recipe without ingredients and steps: nothing to keep (the caption is the fallback)
  assert.equal((await preview(ld({}))).sourceText, null);
  assert.equal((await preview(ld({}) + og('Kim auf Instagram: &quot;Eier braten&quot;'))).sourceText, "Eier braten");
});

test("source: very long texts are cut and marked", async () => {
  const r = await preview(og(`Kim auf Instagram: &quot;${"a ".repeat(MAX_SOURCE_CHARS)}&quot;`));
  assert.equal(r.sourceText!.length, MAX_SOURCE_CHARS);
  assert.equal(r.sourceTruncated, true);
});

// --- API ---

function setup(previewFn?: (url: string) => Promise<PreviewResult>) {
  const db = openDb(":memory:");
  const app = createApp(createRepo(db), previewFn ? { preview: previewFn } : {});
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { call, db };
}
const result = (over: Partial<PreviewResult> = {}): PreviewResult => ({
  title: "T", image: null, titleSuggestions: [], sourceText: null, sourceTruncated: false, reason: null, ...over,
});

test("a dish can be created with a source text; it stays out of the catalog and comes with the recipe", async () => {
  const { call } = setup();
  const d = await call("POST", "/api/dishes", { title: "Curry", source_text: "200 g Linsen", source_truncated: true });
  assert.equal(d.status, 201);
  assert.equal("source_text" in d.json, false);
  assert.equal("source_text" in (await call("GET", "/api/dishes")).json[0], false);
  const r = (await call("GET", `/api/dishes/${d.json.id}/recipe`)).json;
  assert.deepEqual([r.source_text, r.source_truncated], ["200 g Linsen", true]);
  // truncated without a text is nothing
  const e = await call("POST", "/api/dishes", { title: "Leer", source_truncated: true });
  assert.deepEqual((await call("GET", `/api/dishes/${e.json.id}/recipe`)).json.source_truncated, false);
});

test("PATCH: source_text replaces or clears it, a missing field keeps it; PUT recipe never touches it", async () => {
  const { call } = setup();
  const id = (await call("POST", "/api/dishes", { title: "Curry", source_text: "alt" })).json.id;
  const src = async () => (await call("GET", `/api/dishes/${id}/recipe`)).json.source_text;
  await call("PATCH", `/api/dishes/${id}`, { note: "x" });
  assert.equal(await src(), "alt");
  await call("PUT", `/api/dishes/${id}/recipe`, { servings: 2, instructions: null, ingredients: [] });
  assert.equal(await src(), "alt");
  await call("PATCH", `/api/dishes/${id}`, { source_text: "neu" });
  assert.equal(await src(), "neu");
  await call("PATCH", `/api/dishes/${id}`, { source_text: "" });
  assert.equal(await src(), null);
  assert.equal((await call("POST", "/api/dishes", { title: "Zu lang", source_text: "x".repeat(10001) })).status, 400);
});

test("POST /api/dishes/:id/source fetches the link again and replaces the text", async () => {
  const seen: string[] = [];
  const { call } = setup(async (url) => {
    seen.push(url);
    return result({ sourceText: "neuer Text", sourceTruncated: true });
  });
  const id = (await call("POST", "/api/dishes", { title: "Curry", url: "https://example.com/c", source_text: "alt" })).json.id;
  const r = await call("POST", `/api/dishes/${id}/source`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.source_text, r.json.source_truncated], ["neuer Text", true]);
  assert.deepEqual(seen, ["https://example.com/c"]);
});

test("POST /api/dishes/:id/source: nothing found keeps the old text; no link and unknown dish fail", async () => {
  let next = result({ reason: "no_metadata" });
  const { call } = setup(async () => next);
  const id = (await call("POST", "/api/dishes", { title: "Curry", url: "https://example.com/c", source_text: "alt" })).json.id;
  assert.deepEqual((await call("POST", `/api/dishes/${id}/source`)).json, { reason: "no recipe" });
  next = result({ reason: "blocked" });
  assert.deepEqual((await call("POST", `/api/dishes/${id}/source`)).json, { reason: "blocked" });
  assert.equal((await call("GET", `/api/dishes/${id}/recipe`)).json.source_text, "alt");
  const bare = (await call("POST", "/api/dishes", { title: "Ohne" })).json.id;
  assert.equal((await call("POST", `/api/dishes/${bare}/source`)).status, 400);
  assert.equal((await call("POST", "/api/dishes/99/source")).status, 404);
});

test("migration v6 keeps recipes and adds the source columns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "v6.db");
    const first = openDb(file);
    createRepo(first).createDish({ title: "Linsensuppe" });
    first.exec("DROP TABLE cook_check");
    first.exec("ALTER TABLE dish DROP COLUMN source_truncated");
    first.exec("ALTER TABLE dish DROP COLUMN source_text");
    first.exec("PRAGMA user_version = 6");
    first.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
    const repo = createRepo(db);
    assert.equal(repo.getRecipe(1).source_text, null);
    repo.setSource(1, "Text", false);
    assert.equal(repo.getRecipe(1).source_text, "Text");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
