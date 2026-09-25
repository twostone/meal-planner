import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { IMAGE_NAME, type ImageStore } from "./images.ts";
import type { PreviewResult } from "./preview.ts";
import { ConflictError, NotFoundError, type Repo } from "./repo.ts";

const title = z.string().trim().min(1).max(200);
// Only http(s): links are rendered as <a href>, so javascript: etc. must never get in.
const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "must be an http(s) URL");
const note = z.string().trim().max(1000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)), "invalid date");
const id = z.coerce.number().int().positive();

// Empty string clears the optional field.
const optional = <T extends z.ZodType<string>>(s: T) =>
  z.union([s, z.literal("").transform(() => null), z.null()]).optional();

// Only names produced by the image store (content hash + extension) are accepted, never paths.
const image = z.string().regex(IMAGE_NAME);

const dishBody = z.object({ title, url: optional(url), note: optional(note), image: optional(image) });
const dishPatch = z.object({ title: title.optional(), url: optional(url), note: optional(note), image: optional(image) });
const planBody = z
  .object({ start_date: date, end_date: date })
  .refine((v) => v.end_date >= v.start_date, { message: "end_date before start_date", path: ["end_date"] });
const entryBody = z.union([z.object({ dish_id: id }), dishBody]);
const entryPatch = z.object({ done: z.boolean().optional(), position: z.number().int().min(0).optional() });

export type AppOptions = {
  // If set, only connections from this IP are served. HA ingress always connects from
  // 172.30.32.2 (Supervisor); everything else on the network must be refused, otherwise
  // the X-Remote-User-* headers could be forged by other containers.
  allowedIp?: string;
  // Both are optional so the API can run (and be tested) without link previews.
  images?: ImageStore;
  preview?: (url: string) => Promise<PreviewResult>;
};

const MAX_PARALLEL_PREVIEWS = 4;

export function createApp(repo: Repo, opts: AppOptions = {}) {
  const app = new Hono();

  // Removes image files no dish uses any more (fire and forget, never blocks a request).
  const sweep = () => {
    if (opts.images) void opts.images.sweep(repo.listImages()).catch(() => {});
  };
  const imageMissing = async (name: string | null | undefined) =>
    !!name && !(await opts.images?.exists(name));

  if (opts.allowedIp) {
    app.use("*", async (c, next) => {
      let addr: string | undefined;
      try {
        addr = getConnInfo(c).remote.address?.replace(/^::ffff:/, "");
      } catch {
        // no connection info available -> fail closed
      }
      if (addr !== opts.allowedIp) return c.text("Forbidden", 403);
      await next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: `${err.message} not found` }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // HA ingress passes the logged-in HA user in these headers (Supervisor PR #4152).
  // Purely informational: the list is shared, so nothing depends on it.
  app.get("/api/me", (c) => {
    const uid = c.req.header("X-Remote-User-Id");
    return c.json({
      user: uid
        ? {
            id: uid,
            name: c.req.header("X-Remote-User-Name") ?? null,
            display_name: c.req.header("X-Remote-User-Display-Name") ?? null,
          }
        : null,
    });
  });

  app.get("/api/dishes", (c) => c.json(repo.listDishes(c.req.query("q"))));
  app.post("/api/dishes", zValidator("json", dishBody), async (c) => {
    const body = c.req.valid("json");
    if (await imageMissing(body.image)) return c.json({ error: "unknown image" }, 400);
    const dish = repo.createDish(body);
    sweep();
    return c.json(dish, 201);
  });
  app.patch("/api/dishes/:id", zValidator("param", z.object({ id })), zValidator("json", dishPatch), async (c) => {
    const body = c.req.valid("json");
    if (await imageMissing(body.image)) return c.json({ error: "unknown image" }, 400);
    const dish = repo.updateDish(c.req.valid("param").id, body);
    sweep();
    return c.json(dish);
  });
  app.delete("/api/dishes/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deleteDish(c.req.valid("param").id);
    sweep();
    return c.body(null, 204);
  });

  if (opts.images) {
    const images = opts.images;
    app.get("/api/images/:name", async (c) => {
      const img = await images.read(c.req.param("name"));
      if (!img) return c.json({ error: "image not found" }, 404);
      return c.body(new Uint8Array(img.data), 200, {
        "Content-Type": img.mime,
        // The name is a content hash, so the file behind it never changes.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      });
    });
  }

  if (opts.preview) {
    const preview = opts.preview;
    let running = 0;
    app.post("/api/preview", zValidator("json", z.object({ url })), async (c) => {
      if (running >= MAX_PARALLEL_PREVIEWS) return c.json({ error: "busy" }, 429);
      running++;
      try {
        return c.json(await preview(c.req.valid("json").url));
      } finally {
        running--;
        sweep();
      }
    });
  }

  app.get("/api/plans", (c) => c.json(repo.listPlans()));
  app.post("/api/plans", zValidator("json", planBody), (c) => c.json(repo.createPlan(c.req.valid("json")), 201));
  app.get("/api/plans/:id", zValidator("param", z.object({ id })), (c) => c.json(repo.getPlan(c.req.valid("param").id)));
  app.delete("/api/plans/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deletePlan(c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.post("/api/plans/:id/entries", zValidator("param", z.object({ id })), zValidator("json", entryBody), async (c) => {
    const body = c.req.valid("json");
    if ("image" in body && (await imageMissing(body.image))) return c.json({ error: "unknown image" }, 400);
    return c.json(repo.addEntry(c.req.valid("param").id, body as any), 201);
  });
  app.patch("/api/entries/:id", zValidator("param", z.object({ id })), zValidator("json", entryPatch), (c) =>
    c.json(repo.updateEntry(c.req.valid("param").id, c.req.valid("json"))),
  );
  app.delete("/api/entries/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deleteEntry(c.req.valid("param").id);
    return c.body(null, 204);
  });

  return app;
}
