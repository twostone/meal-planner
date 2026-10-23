import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { AiError, type RecipeAi } from "../src/ha-ai.ts";
import { IMAGE_NAME, ImageStore, MAX_IMAGE_BYTES } from "../src/images.ts";
import { createRepo } from "../src/repo.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

async function setup(image?: RecipeAi["image"]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-upload-"));
  const images = new ImageStore(path.join(dir, "images"));
  const ai: RecipeAi | undefined = image && {
    status: async () => ({ ai: true, reason: null, image: true }),
    generate: async () => ({}),
    titles: async () => "",
    normalize: async () => "[]",
    image,
  };
  const app = createApp(createRepo(openDb(":memory:")), { images, ai });
  const send = async (p: string, body: BodyInit, type: string) => {
    const res = await app.request(p, { method: "POST", headers: { "Content-Type": type }, body });
    const text = await res.text();
    return { status: res.status, json: (text.startsWith("{") ? JSON.parse(text) : null) as any };
  };
  const json = (p: string, body: unknown) => send(p, JSON.stringify(body), "application/json");
  const put = (p: string, body: unknown) => app.request(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { send, json, put, images, done: () => rm(dir, { recursive: true, force: true }) };
}

test("POST /api/images: stores a photo under its hash name, the dish can then use it", async () => {
  const { send, json, images, done } = await setup();
  try {
    for (const [data, ext] of [[PNG, "png"], [JPEG, "jpg"]] as const) {
      const r = await send("/api/images", new Uint8Array(data), `image/${ext}`);
      assert.equal(r.status, 201);
      assert.match(r.json.image, IMAGE_NAME);
      assert.ok(r.json.image.endsWith(`.${ext}`));
      assert.ok(await images.exists(r.json.image));
    }
    const name = (await send("/api/images", new Uint8Array(PNG), "image/png")).json.image;
    assert.equal((await json("/api/dishes", { title: "Eigenes", image: name })).json.image, name);
  } finally {
    await done();
  }
});

test("POST /api/images: SVG, text and empty bodies are refused (type from the bytes), too large is 413", async () => {
  const { send, done } = await setup();
  try {
    assert.equal((await send("/api/images", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")).status, 400);
    assert.equal((await send("/api/images", "hello world, not an image", "image/png")).status, 400, "the content type is not trusted");
    assert.equal((await send("/api/images", "", "image/png")).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    assert.equal((await send("/api/images", new Uint8Array(big), "image/png")).status, 413);
  } finally {
    await done();
  }
});

test("POST /api/images/generate: passes title and the recipe's ingredient names, stores the result", async () => {
  const seen: { title: string; ingredients: string[] }[] = [];
  const { json, put, images, done } = await setup(async (input) => {
    seen.push(input);
    return PNG;
  });
  try {
    const r = await json("/api/images/generate", { title: "Neues Gericht" });
    assert.equal(r.status, 200);
    assert.match(r.json.image, IMAGE_NAME);
    assert.ok(await images.exists(r.json.image));
    assert.deepEqual(seen[0], { title: "Neues Gericht", ingredients: [] }, "a new dish has no recipe yet");

    const dish = (await json("/api/dishes", { title: "Linsen-Dal" })).json;
    const ing = (name: string) => ({ section: null, amount: 1, amount_max: null, unit: null, name, note: null, raw: name });
    assert.equal((await put(`/api/dishes/${dish.id}/recipe`, { servings: 2, instructions: "", ingredients: [ing("Linse"), ing("Zwiebel")] })).status, 200);
    await json("/api/images/generate", { title: "Dal", dish_id: dish.id });
    assert.deepEqual(seen[1], { title: "Dal", ingredients: ["Linse", "Zwiebel"] }, "the title from the sheet wins over the saved one");
    assert.equal((await json("/api/images/generate", { title: " " })).status, 400);
    assert.equal((await json("/api/images/generate", { title: "X", dish_id: 999 })).status, 404);
  } finally {
    await done();
  }
});

test("POST /api/images/generate: AI errors and non-images are 502, a second one at a time is 429", async () => {
  let mode: "fail" | "svg" | "wait" = "fail";
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { json, done } = await setup(async () => {
    if (mode === "fail") throw new AiError("timeout");
    if (mode === "svg") return Buffer.from("<svg/>");
    await gate;
    return PNG;
  });
  try {
    assert.deepEqual((await json("/api/images/generate", { title: "X" })), { status: 502, json: { error: "ai failed", reason: "timeout" } });
    mode = "svg";
    assert.equal((await json("/api/images/generate", { title: "X" })).status, 502);
    mode = "wait";
    const first = json("/api/images/generate", { title: "X" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await json("/api/images/generate", { title: "Y" })).status, 429);
    release();
    assert.equal((await first).status, 200);
  } finally {
    await done();
  }
});

test("POST /api/images/generate: without AI the route does not exist", async () => {
  const { json, done } = await setup();
  try {
    assert.equal((await json("/api/images/generate", { title: "X" })).status, 404);
  } finally {
    await done();
  }
});
