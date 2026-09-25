import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectImageType, IMAGE_NAME, ImageStore } from "../src/images.ts";
import { FetchError } from "../src/net-guard.ts";
import { createPreviewService, decodeEntities, parsePreview } from "../src/preview.ts";
import type { Fetched } from "../src/safe-fetch.ts";

const base = new URL("https://example.com/rezept/1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

test("decodeEntities: named, decimal and hex entities; unknown ones stay", () => {
  assert.equal(decodeEntities("Shakshuka &amp; Fladenbrot &#8211; K&auml;se &#x2713; &foo;"), "Shakshuka & Fladenbrot – Käse ✓ &foo;");
});

test("parsePreview: schema.org recipe name beats the og:title with site suffix; og:image is resolved and unescaped", () => {
  const html = `<html><head><title>Käsespätzle Rezept | Chefkoch</title>
    <meta property="og:title" content="Käsespätzle Rezept | Chefkoch">
    <meta property="og:site_name" content="Chefkoch">
    <meta property="og:image" content="/img/spaetzle.jpg?w=1200&amp;h=630">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Recipe","name":"Käsespätzle","image":["https://cdn.example.com/1x1.jpg"]}]}</script>
    </head></html>`;
  assert.deepEqual(parsePreview(html, base), { title: "Käsespätzle", imageUrl: "https://example.com/img/spaetzle.jpg?w=1200&h=630" });
});

test("parsePreview: og tags only, site name stripped, entities decoded, single quotes and '>' inside values", () => {
  const html = `<meta property="og:title" content="Shakshuka &amp; Fladenbrot – Blog Name"><meta property='og:site_name' content='Blog Name'>
    <meta property="og:image" content="https://img.example.com/a.png">`;
  assert.deepEqual(parsePreview(html, base), { title: "Shakshuka & Fladenbrot", imageUrl: "https://img.example.com/a.png" });
  assert.equal(parsePreview(`<meta name='twitter:title' content='A > B'>`, base).title, "A > B");
});

test("parsePreview: falls back to <title>, recipe ImageObject, and ignores broken JSON-LD", () => {
  assert.deepEqual(parsePreview("<title>\n  Linsensuppe </title>", base), { title: "Linsensuppe", imageUrl: null });
  const html = `<script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">[{"@type":["Thing","Recipe"],"name":"Pasta","image":{"@type":"ImageObject","url":"//cdn.example.com/p.webp"}}]</script>`;
  assert.deepEqual(parsePreview(html, base), { title: "Pasta", imageUrl: "https://cdn.example.com/p.webp" });
});

test("parsePreview: login and bot-check pages give no title; non-http image URLs are dropped", () => {
  for (const t of ["Instagram", "Login • Instagram", "Just a moment...", "403 Forbidden", "Attention Required! | Cloudflare"]) {
    assert.equal(parsePreview(`<title>${t}</title>`, base).title, null, t);
  }
  for (const img of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd"]) {
    assert.equal(parsePreview(`<meta property="og:image" content="${img}">`, base).imageUrl, null, img);
  }
});

test("detectImageType: goes by the bytes, refuses SVG and HTML", () => {
  assert.equal(detectImageType(PNG)?.ext, "png");
  assert.equal(detectImageType(JPG)?.ext, "jpg");
  assert.equal(detectImageType(Buffer.from("GIF89a" + "\0".repeat(20), "latin1"))?.ext, "gif");
  assert.equal(detectImageType(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(8)]))?.ext, "webp");
  assert.equal(detectImageType(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), Buffer.alloc(8)]))?.ext, "avif");
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(detectImageType(Buffer.from("<!doctype html><html></html>")), null);
});

async function tmpStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-img-"));
  return { store: new ImageStore(path.join(dir, "images")), dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test("ImageStore: content-addressed, no path tricks, sweep keeps referenced and fresh files", async () => {
  const { store, dir, done } = await tmpStore();
  try {
    const a = await store.save(PNG);
    assert.match(a, IMAGE_NAME);
    assert.equal(await store.save(PNG), a, "same bytes, same name");
    const b = await store.save(JPG);
    assert.equal((await store.read(a))?.mime, "image/png");
    for (const bad of ["../x.png", "..%2Fx.png", "0123456789abcdef.svg", "0123456789abcdef.png", "a.png", ""]) {
      assert.equal(await store.read(bad), null, bad);
    }
    await assert.rejects(store.save(Buffer.from("<svg></svg>" + " ".repeat(20))), /not a supported image/);

    // both are fresh: nothing is removed even though nobody references them
    assert.equal(await store.sweep([]), 0);
    // make both old; only the referenced one survives
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const n of [a, b]) await utimes(path.join(store.dir, n), old, old);
    await writeFile(path.join(store.dir, "notes.txt"), "not ours"); // foreign files are left alone
    assert.equal(await store.sweep([a]), 1);
    assert.deepEqual((await readdir(store.dir)).sort(), [a, "notes.txt"].sort());
    assert.equal(await store.exists(b), false);
    assert.equal(await store.sweep([a]), 0);
  } finally {
    await done();
  }
  void dir;
});

// --- preview service with a fake fetcher (no network) ---

type Page = Partial<Fetched> | FetchError;
const fakeFetcher = (pages: Record<string, Page>) => async (input: string | URL): Promise<Fetched> => {
  const key = String(input);
  const page = pages[key];
  if (!page) throw new FetchError("status", "404");
  if (page instanceof FetchError) throw page;
  return { url: new URL(key), contentType: "text/html", charset: null, body: Buffer.alloc(0), ...page };
};
const html = (s: string): Partial<Fetched> => ({ body: Buffer.from(s) });
const service = (pages: Record<string, Page>, store: ImageStore) =>
  createPreviewService({ images: store, fetcher: fakeFetcher(pages) as never, log: () => {} });

test("preview service: title and image are found, the image is stored under its hash", async () => {
  const { store, done } = await tmpStore();
  try {
    const r = await service(
      {
        "https://example.com/r": html(`<meta property="og:title" content="Shakshuka"><meta property="og:image" content="/a.png">`),
        "https://example.com/a.png": { contentType: "image/png", body: PNG },
      },
      store,
    )("https://example.com/r");
    assert.equal(r.title, "Shakshuka");
    assert.match(r.image!, IMAGE_NAME);
    assert.equal(r.reason, null);
    assert.equal(await store.exists(r.image!), true);
  } finally {
    await done();
  }
});

test("preview service: failures degrade to what is available and never throw", async () => {
  const { store, done } = await tmpStore();
  try {
    const page = html(`<meta property="og:title" content="Curry"><meta property="og:image" content="/x.png">`);
    // image download fails -> title only
    let r = await service({ "https://example.com/r": page }, store)("https://example.com/r");
    assert.deepEqual({ t: r.title, i: r.image, why: r.reason }, { t: "Curry", i: null, why: null });
    // image is really HTML (e.g. an error page) -> not stored
    r = await service({ "https://example.com/r": page, "https://example.com/x.png": html("<html>oops</html>") }, store)("https://example.com/r");
    assert.equal(r.image, null);
    assert.deepEqual(await readdir(store.dir).catch(() => []), []);
    // page blocked / not html / nothing useful
    r = await service({ "https://10.0.0.1/": new FetchError("blocked", "address") }, store)("https://10.0.0.1/");
    assert.deepEqual({ t: r.title, i: r.image, why: r.reason }, { t: null, i: null, why: "blocked" });
    r = await service({ "https://example.com/p": { contentType: "application/pdf", body: Buffer.from("%PDF") } }, store)("https://example.com/p");
    assert.equal(r.reason, "type");
    r = await service({ "https://example.com/e": html("<html><body>hi</body></html>") }, store)("https://example.com/e");
    assert.equal(r.reason, "no_metadata");
    r = await service({}, store)("not a url");
    assert.notEqual(r.reason, null);
  } finally {
    await done();
  }
});

test("preview service: honours the page's charset (ISO-8859-1 umlauts)", async () => {
  const { store, done } = await tmpStore();
  try {
    const r = await service(
      { "https://example.com/l": { charset: "iso-8859-1", body: Buffer.from("<title>Grüne Soße</title>", "latin1") } },
      store,
    )("https://example.com/l");
    assert.equal(r.title, "Grüne Soße");
    const meta = await service(
      { "https://example.com/m": { body: Buffer.from('<meta charset="windows-1252"><title>Käse</title>', "latin1") } },
      store,
    )("https://example.com/m");
    assert.equal(meta.title, "Käse");
  } finally {
    await done();
  }
});
