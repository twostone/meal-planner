import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveFrontend } from "../src/static.ts";

function frontend() {
  const root = mkdtempSync(join(tmpdir(), "meal-planner-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  writeFileSync(join(root, "assets", "index-abc123.js"), "");
  return new Hono().use("/*", serveFrontend(root));
}

test("static: index.html is revalidated, so an update never leaves old asset names behind", async () => {
  const app = frontend();
  for (const path of ["/", "/index.html", "/favicon.svg"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("Cache-Control"), "no-cache", path);
  }
});

test("static: hashed assets are cached for good", async () => {
  const res = await frontend().request("/assets/index-abc123.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});

test("static: a missing file gets no cache header", async () => {
  const res = await frontend().request("/assets/index-old.js");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Cache-Control"), null);
});
