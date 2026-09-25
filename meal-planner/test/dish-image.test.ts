import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb, SCHEMA_V1 } from "../src/db.ts";
import { IMAGE_NAME, ImageStore } from "../src/images.ts";
import type { PreviewResult } from "../src/preview.ts";
import { createRepo } from "../src/repo.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function setup(preview?: (url: string) => Promise<PreviewResult>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-api-"));
  const images = new ImageStore(path.join(dir, "images"));
  const app = createApp(createRepo(openDb(":memory:")), { images, preview });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.request(p, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, json: type.includes("json") ? await res.json() : null, raw: res };
  };
  return { call, images, done: () => rm(dir, { recursive: true, force: true }) };
}

test("dish image: saved with the dish, served with safe headers, cleared again", async () => {
  const { call, images, done } = await setup();
  try {
    const name = await images.save(PNG);
    const created = await call("POST", "/api/dishes", { title: "Shakshuka", image: name });
    assert.equal(created.status, 201);
    assert.equal(created.json.image, name);

    const img = await call("GET", `/api/images/${name}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.match(img.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(img.headers.get("cache-control") ?? "", /immutable/);
    assert.deepEqual(Buffer.from(await img.raw.arrayBuffer()), PNG);

    // shows up in the plan entries as well
    const plan = (await call("POST", "/api/plans", { start_date: "2026-10-03", end_date: "2026-10-09" })).json;
    await call("POST", `/api/plans/${plan.id}/entries`, { dish_id: created.json.id });
    assert.equal((await call("GET", `/api/plans/${plan.id}`)).json.entries[0].dish.image, name);

    // PATCH without image keeps it; null and "" clear it
    assert.equal((await call("PATCH", `/api/dishes/${created.json.id}`, { note: "scharf" })).json.image, name);
    assert.equal((await call("PATCH", `/api/dishes/${created.json.id}`, { image: null })).json.image, null);
    await call("PATCH", `/api/dishes/${created.json.id}`, { image: name });
    assert.equal((await call("PATCH", `/api/dishes/${created.json.id}`, { image: "" })).json.image, null);
  } finally {
    await done();
  }
});

test("dish image: only names from the image store are accepted", async () => {
  const { call, done } = await setup();
  try {
    for (const image of ["0123456789abcdef.png", "../../etc/passwd", "/etc/passwd", "x.png", "0123456789abcdef.svg"]) {
      assert.equal((await call("POST", "/api/dishes", { title: "X", image })).status, 400, image);
    }
    const dish = (await call("POST", "/api/dishes", { title: "Y" })).json;
    assert.equal((await call("PATCH", `/api/dishes/${dish.id}`, { image: "0123456789abcdef.png" })).status, 400);
    assert.equal((await call("POST", "/api/plans", { start_date: "2026-10-03", end_date: "2026-10-09" })).status, 201);
    assert.equal((await call("POST", "/api/plans/1/entries", { title: "Z", image: "0123456789abcdef.png" })).status, 400);
  } finally {
    await done();
  }
});

test("GET /api/images: unknown, malformed and traversal names are 404", async () => {
  const { call, done } = await setup();
  try {
    for (const n of ["0123456789abcdef.png", "..%2F..%2Fetc%2Fpasswd", "x", "0123456789abcdef.svg"]) {
      assert.equal((await call("GET", `/api/images/${n}`)).status, 404, n);
    }
  } finally {
    await done();
  }
});

test("POST /api/preview: validates the URL and passes the result through", async () => {
  const seen: string[] = [];
  const { call, done } = await setup(async (url) => {
    seen.push(url);
    return { title: "Curry", image: "0123456789abcdef.png", reason: null };
  });
  try {
    assert.equal((await call("POST", "/api/preview", { url: "javascript:alert(1)" })).status, 400);
    assert.equal((await call("POST", "/api/preview", { url: "file:///etc/passwd" })).status, 400);
    assert.equal((await call("POST", "/api/preview", {})).status, 400);
    const ok = await call("POST", "/api/preview", { url: " https://example.com/r " });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { title: "Curry", image: "0123456789abcdef.png", reason: null });
    assert.deepEqual(seen, ["https://example.com/r"]);
  } finally {
    await done();
  }
});

test("POST /api/preview: at most four run in parallel, the fifth gets 429", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { call, done } = await setup(async () => {
    await gate;
    return { title: null, image: null, reason: "no_metadata" };
  });
  try {
    const running = Array.from({ length: 4 }, () => call("POST", "/api/preview", { url: "https://example.com/" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call("POST", "/api/preview", { url: "https://example.com/" })).status, 429);
    release();
    assert.deepEqual((await Promise.all(running)).map((r) => r.status), [200, 200, 200, 200]);
    assert.equal((await call("POST", "/api/preview", { url: "https://example.com/" })).status, 200, "slots are free again");
  } finally {
    await done();
  }
});

test("without an image store the preview and image routes do not exist, and images are refused", async () => {
  const app = createApp(createRepo(openDb(":memory:")));
  assert.equal((await app.request("/api/images/0123456789abcdef.png")).status, 404);
  const res = await app.request("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }) });
  assert.equal(res.status, 404);
  const dish = await app.request("/api/dishes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "A", image: "0123456789abcdef.png" }) });
  assert.equal(dish.status, 400);
});

test("migration v1 -> v2 keeps existing dishes and adds the image column", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-mig-"));
  try {
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_V1);
    old.exec("PRAGMA user_version = 1");
    old.prepare("INSERT INTO dish (title, url) VALUES (?, ?)").run("Linsensuppe", "https://example.com/l");
    old.close();

    const db = openDb(file);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const dishes = createRepo(db).listDishes();
    assert.deepEqual(dishes.map((d) => [d.title, d.url, d.image]), [["Linsensuppe", "https://example.com/l", null]]);
    db.close();
    openDb(file).close(); // a second start does nothing and does not fail
    assert.match("0123456789abcdef.png", IMAGE_NAME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
