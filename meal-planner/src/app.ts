import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import type { HaEventInput, HaUser } from "./ha-notify.ts";
import { IMAGE_NAME, type ImageStore } from "./images.ts";
import type { PreviewResult } from "./preview.ts";
import { ConflictError, NotFoundError, UNITS, type Entry, type Repo } from "./repo.ts";

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

// Empty string clears the optional field. The "" branch must come first: a plain z.string() would accept "" itself.
const optional = <T extends z.ZodType<string>>(s: T) =>
  z.union([z.literal("").transform(() => null), s, z.null()]).optional();

// Only names produced by the image store (content hash + extension) are accepted, never paths.
const image = z.string().regex(IMAGE_NAME);

// Free-form categories. Duplicates (any case) are merged by the repo, so only size limits are checked here.
const tags = z.array(z.string().trim().min(1).max(30)).max(10);

// The recipe text from a link preview (see POST /api/preview). Stored unchanged, never interpreted.
const source = { source_text: optional(z.string().max(10000)), source_truncated: z.boolean().optional() };

const dishBody = z.object({ title, url: optional(url), note: optional(note), image: optional(image), tags: tags.optional(), ...source });
const dishPatch = z.object({
  title: title.optional(),
  url: optional(url),
  note: optional(note),
  image: optional(image),
  tags: tags.optional(),
  ...source,
});
const planBody = z
  .object({ start_date: date, end_date: date })
  .refine((v) => v.end_date >= v.start_date, { message: "end_date before start_date", path: ["end_date"] });
// Optional name of a plan; "" or null clears it.
const planTitle = z.string().trim().min(1).max(100);
// The period is changed as a whole: both dates or none, so the end-after-start check needs no stored values.
const planPatch = z
  .object({ title: optional(planTitle), start_date: date.optional(), end_date: date.optional() })
  .refine((v) => (v.start_date === undefined) === (v.end_date === undefined), {
    message: "start_date and end_date go together",
    path: ["end_date"],
  })
  .refine((v) => v.start_date === undefined || v.end_date! >= v.start_date, {
    message: "end_date before start_date",
    path: ["end_date"],
  });
// Text fields of a recipe: "" or null means "not set".
const text = (max: number) => z.union([z.literal("").transform(() => null), z.string().trim().max(max), z.null()]);
const ingredient = z
  .object({
    section: text(80),
    amount: z.number().min(0).max(100000).nullable(),
    amount_max: z.number().min(0).max(100000).nullable(),
    unit: z.enum(UNITS).nullable(),
    name: z.string().trim().min(1).max(80),
    note: text(200),
    raw: z.string().trim().max(200).nullish(), // built from amount/unit/name when missing
  })
  .refine((v) => v.amount_max === null || (v.amount !== null && v.amount_max >= v.amount), {
    message: "amount_max needs an amount and must not be smaller",
    path: ["amount_max"],
  });
const recipeBody = z.object({
  servings: z.number().int().min(1).max(50).nullable(),
  instructions: text(10000),
  ingredients: z.array(ingredient).max(60),
});
const entryBody = z.union([z.object({ dish_id: id }), dishBody]);
// note: only for this entry (dish in one plan); "" or null clears it
const entryPatch = z.object({
  done: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
  note: optional(note),
});

export type AppOptions = {
  // If set, only connections from this IP are served. HA ingress always connects from
  // 172.30.32.2 (Supervisor); everything else on the network must be refused, otherwise
  // the X-Remote-User-* headers could be forged by other containers.
  allowedIp?: string;
  // Both are optional so the API can run (and be tested) without link previews.
  images?: ImageStore;
  preview?: (url: string) => Promise<PreviewResult>;
  // Fires a Home Assistant bus event after a mutation (see ha-notify.ts). Optional so the API
  // runs without it outside the add-on.
  notify?: (event: HaEventInput) => Promise<void>;
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
  // Fire and forget, like sweep(): a failed/slow event to HA must never delay or fail the request.
  const notifyHa = (event: HaEventInput) => {
    if (opts.notify) void opts.notify(event).catch(() => {});
  };
  const entryEvent = (type: "entry_added" | "entry_removed" | "entry_done" | "entry_undone", e: Entry, user: HaUser | null) => {
    if (!opts.notify) return;
    const { id, start_date, end_date } = repo.getPlan(e.plan_id);
    notifyHa({ type, plan: { id, start_date, end_date }, entry: { id: e.id, dish_id: e.dish_id, title: e.dish.title }, user });
  };

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
  // Purely informational: the list is shared, so nothing depends on it. Trustworthy only because
  // the Ingress guard above lets nobody else in.
  const haUser = (c: Context): HaUser | null => {
    const id = c.req.header("X-Remote-User-Id");
    return id
      ? {
          id,
          name: c.req.header("X-Remote-User-Name") ?? null,
          display_name: c.req.header("X-Remote-User-Display-Name") ?? null,
        }
      : null;
  };
  app.get("/api/me", (c) => c.json({ user: haUser(c) }));

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

  app.get("/api/dishes/:id/recipe", zValidator("param", z.object({ id })), (c) =>
    c.json(repo.getRecipe(c.req.valid("param").id)),
  );
  app.put("/api/dishes/:id/recipe", zValidator("param", z.object({ id })), zValidator("json", recipeBody), (c) =>
    c.json(repo.setRecipe(c.req.valid("param").id, c.req.valid("json"))),
  );

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
    // null = too many at once
    const limited = async (u: string): Promise<PreviewResult | null> => {
      if (running >= MAX_PARALLEL_PREVIEWS) return null;
      running++;
      try {
        return await preview(u);
      } finally {
        running--;
        sweep();
      }
    };
    app.post("/api/preview", zValidator("json", z.object({ url })), async (c) => {
      const r = await limited(c.req.valid("json").url);
      return r ? c.json(r) : c.json({ error: "busy" }, 429);
    });
    // "Get the recipe from the link": fetches the dish's link again and replaces source_text.
    // Nothing found -> { reason } and nothing changes.
    app.post("/api/dishes/:id/source", zValidator("param", z.object({ id })), async (c) => {
      const dish = repo.getDish(c.req.valid("param").id);
      if (!dish.url) return c.json({ error: "dish has no link" }, 400);
      const r = await limited(dish.url);
      if (!r) return c.json({ error: "busy" }, 429);
      if (!r.sourceText) return c.json({ reason: r.reason && r.reason !== "no_metadata" ? r.reason : "no recipe" });
      repo.setSource(dish.id, r.sourceText, r.sourceTruncated);
      return c.json(repo.getRecipe(dish.id));
    });
  }

  app.get("/api/plans", (c) => c.json(repo.listPlans()));
  app.post("/api/plans", zValidator("json", planBody), (c) => {
    const plan = repo.createPlan(c.req.valid("json"));
    notifyHa({ type: "plan_created", plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date }, user: haUser(c) });
    return c.json(plan, 201);
  });
  app.get("/api/plans/:id", zValidator("param", z.object({ id })), (c) => c.json(repo.getPlan(c.req.valid("param").id)));
  app.patch("/api/plans/:id", zValidator("param", z.object({ id })), zValidator("json", planPatch), (c) => {
    const { before, plan } = repo.updatePlan(c.req.valid("param").id, c.req.valid("json"));
    // Only a real change is an event: saving the sheet unchanged must not wake any automation.
    if (plan.title !== before.title || plan.start_date !== before.start_date || plan.end_date !== before.end_date) {
      notifyHa({
        type: "plan_updated",
        plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date, title: plan.title },
        previous: { start_date: before.start_date, end_date: before.end_date, title: before.title },
        user: haUser(c),
      });
    }
    return c.json(plan);
  });
  app.delete("/api/plans/:id", zValidator("param", z.object({ id })), (c) => {
    repo.deletePlan(c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.post("/api/plans/:id/entries", zValidator("param", z.object({ id })), zValidator("json", entryBody), async (c) => {
    const body = c.req.valid("json");
    if ("image" in body && (await imageMissing(body.image))) return c.json({ error: "unknown image" }, 400);
    const entry = repo.addEntry(c.req.valid("param").id, body as any);
    entryEvent("entry_added", entry, haUser(c));
    return c.json(entry, 201);
  });
  app.patch("/api/entries/:id", zValidator("param", z.object({ id })), zValidator("json", entryPatch), (c) => {
    const id = c.req.valid("param").id;
    const before = repo.getEntry(id);
    const entry = repo.updateEntry(id, c.req.valid("json"));
    if (entry.done !== before.done) entryEvent(entry.done ? "entry_done" : "entry_undone", entry, haUser(c));
    return c.json(entry);
  });
  app.delete("/api/entries/:id", zValidator("param", z.object({ id })), (c) => {
    const before = repo.getEntry(c.req.valid("param").id);
    repo.deleteEntry(before.id);
    entryEvent("entry_removed", before, haUser(c));
    return c.body(null, 204);
  });

  return app;
}
