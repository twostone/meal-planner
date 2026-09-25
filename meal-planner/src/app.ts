import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
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

const dishBody = z.object({ title, url: optional(url), note: optional(note) });
const dishPatch = z.object({ title: title.optional(), url: optional(url), note: optional(note) });
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
};

export function createApp(repo: Repo, opts: AppOptions = {}) {
  const app = new Hono();

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
  app.post("/api/dishes", zValidator("json", dishBody), (c) => c.json(repo.createDish(c.req.valid("json")), 201));
  app.patch("/api/dishes/:id", zValidator("param", z.object({ id })), zValidator("json", dishPatch), (c) =>
    c.json(repo.updateDish(c.req.valid("param").id, c.req.valid("json"))),
  );
  app.delete("/api/dishes/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deleteDish(c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.get("/api/plans", (c) => c.json(repo.listPlans()));
  app.post("/api/plans", zValidator("json", planBody), (c) => c.json(repo.createPlan(c.req.valid("json")), 201));
  app.get("/api/plans/:id", zValidator("param", z.object({ id })), (c) => c.json(repo.getPlan(c.req.valid("param").id)));
  app.delete("/api/plans/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deletePlan(c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.post("/api/plans/:id/entries", zValidator("param", z.object({ id })), zValidator("json", entryBody), (c) =>
    c.json(repo.addEntry(c.req.valid("param").id, c.req.valid("json") as any), 201),
  );
  app.patch("/api/entries/:id", zValidator("param", z.object({ id })), zValidator("json", entryPatch), (c) =>
    c.json(repo.updateEntry(c.req.valid("param").id, c.req.valid("json"))),
  );
  app.delete("/api/entries/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deleteEntry(c.req.valid("param").id);
    return c.body(null, 204);
  });

  return app;
}
