import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { AiError, MAX_KNOWN_NAMES, type RecipeAi } from "./ha-ai.ts";
import { TodoError, type HaTodo, type OpenTodoItem } from "./ha-todo.ts";
import type { HaEventInput, HaUser } from "./ha-notify.ts";
import { detectImageType, IMAGE_NAME, MAX_IMAGE_BYTES, type ImageStore } from "./images.ts";
import { logger } from "./log.ts";
import type { PreviewResult } from "./preview.ts";
import { buildDraft, DraftError } from "./recipe-draft.ts";
import { aiPairs, buildChanges, MAX_PAIRS_PER_BLOCK } from "./ingredient-normalize.ts";
import { FOREIGN_UNITS } from "./units.ts";
import { ConflictError, NotFoundError, UNITS, type Entry, type Repo } from "./repo.ts";
import { buildShoppingList, MAX_SPEC_LENGTH, nameKey, type ShoppingItem } from "./shopping.ts";
import { cleanAiTitles } from "./title-suggest.ts";

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
    prep: text(200).optional(), // missing (older client) = none
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
// Making stored ingredients uniform: the pairs of one preview block, and the reviewed changes to apply.
const MAX_NORMALIZE_CHANGES = 500;
const pair = z.object({ name: z.string().min(1).max(80), note: z.string().max(200).nullable() });
const normalizePreviewBody = z.object({ pairs: z.array(pair).min(1).max(MAX_PAIRS_PER_BLOCK) });
const normalizeApplyBody = z.object({
  changes: z
    .array(
      z.object({
        from: pair,
        to: z.object({ name: z.string().trim().min(1).max(80), note: text(200), prep: text(200) }),
        unit: z.enum(FOREIGN_UNITS).nullable(),
      }),
    )
    .min(1)
    .max(MAX_NORMALIZE_CHANGES),
});
// Input of the AI title suggestions: the page title and the text found at the link (or, without one, the title again).
// `lang` comes from the browser; anything that is not a plain language code ("de", "en-GB") counts as missing.
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const titleSuggestBody = z
  .object({ title: z.string().trim().max(200).optional(), text: z.string().max(10000).optional(), lang: z.string().max(35).optional() })
  .refine((v) => !!(v.title || v.text?.trim()), { message: "title or text needed" });
// The title as typed in the sheet; with dish_id the saved recipe's ingredient names go into the prompt too.
const imageGenerateBody = z.object({ title, dish_id: id.optional() });
const checkBody = z.object({ kind: z.enum(["ingredient", "step"]), idx: z.number().int().min(0).max(1000), checked: z.boolean() });
// A Home Assistant to-do entity id ("todo.essen"). Whether it exists is checked against Home Assistant before sending.
const todoEntity = z.string().regex(/^todo\.[a-z0-9_]+$/);
// entries: comma-separated entry ids of the plan; missing = all open entries, "" = none.
const shoppingQuery = z.object({ entries: z.string().regex(/^(\d+(,\d+)*)?$/).optional(), list: todoEntity.optional() });
const shoppingSend = z.object({
  list: todoEntity,
  items: z.array(z.object({ name: z.string().trim().min(1).max(80), spec: z.string().trim().max(MAX_SPEC_LENGTH).nullable() })).min(1).max(200),
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
  // Splits recipe text into ingredients and steps via Home Assistant's AI task (see ha-ai.ts). Optional:
  // without it the recipe buttons stay hidden and the status says "disabled".
  ai?: RecipeAi;
  // Sends the shopping list to a to-do list in Home Assistant, e.g. Bring (see ha-todo.ts). Optional like `ai`.
  todo?: HaTodo;
};

const log = logger("app");
// A request is only logged when it failed or took this long: cook mode polls every 4 s and would flood the log.
const SLOW_REQUEST_MS = 2000;

const MAX_PARALLEL_PREVIEWS = 4;
const MAX_PARALLEL_DRAFTS = 2;
const MAX_PARALLEL_TITLES = 2;
// Generating an image takes up to a minute and costs the most: one at a time.
const MAX_PARALLEL_IMAGES = 1;
// Making the stored ingredients uniform is a household-wide action: one preview at a time.
const MAX_PARALLEL_NORMALIZE = 1;

// Is the item already open on the to-do list? Items may share a name ("Nüsse" for Macadamia and for Walnuss), so one with a
// note only counts when an open item of that name mentions the note in its description. The amount is not compared: it
// changes with the plan, and a match must not fail on "80 g" against "100 g".
function isOnList(item: ShoppingItem, open: OpenTodoItem[]): boolean {
  const name = nameKey(item.name);
  const note = item.note ? nameKey(item.note) : null;
  return open.some((o) => nameKey(o.summary) === name && (note === null || (o.description !== null && nameKey(o.description).includes(note))));
}

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

  // First in line, so refused (403) requests show up as well. Path only, never the query string.
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = Math.round(performance.now() - t0);
    const status = c.res.status;
    if (status >= 400 || ms >= SLOW_REQUEST_MS) {
      (status >= 500 ? log.error : log.warn)("request", { method: c.req.method, path: c.req.path, status, ms });
    }
  });

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
    log.error("unhandled", { method: c.req.method, path: c.req.path, err, stack: err instanceof Error ? err.stack : undefined });
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

  app.get("/api/dishes", (c) => c.json(repo.listDishes(c.req.query("q"), c.req.query("ingredient"))));
  // Suggestions for the search box of the catalog.
  app.get("/api/ingredients/names", (c) => c.json(repo.listIngredientNames(MAX_KNOWN_NAMES)));
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

  app.get("/api/recipe/status", async (c) => c.json(opts.ai ? await opts.ai.status() : { ai: false, reason: "disabled", image: false }));
  if (opts.ai) {
    const ai = opts.ai;
    let drafting = 0;
    // Draft only: nothing is stored. The user reviews it (with the source text next to it) and saves via PUT …/recipe.
    app.post("/api/dishes/:id/recipe/draft", zValidator("param", z.object({ id })), async (c) => {
      const { source_text } = repo.getRecipe(c.req.valid("param").id);
      if (!source_text) return c.json({ error: "dish has no source text" }, 400);
      if (drafting >= MAX_PARALLEL_DRAFTS) return c.json({ error: "busy" }, 429);
      drafting++;
      try {
        return c.json(buildDraft(await ai.generate(source_text, repo.listIngredientNames(MAX_KNOWN_NAMES)), source_text));
      } catch (e) {
        if (e instanceof AiError || e instanceof DraftError) {
          const reason = e instanceof AiError ? e.reason : "bad_response";
          log.warn("draft_failed", { reason, detail: e instanceof DraftError ? e.message : undefined });
          return c.json({ error: "ai failed", reason }, 502);
        }
        throw e;
      } finally {
        drafting--;
      }
    });

    // Up to two title candidates from the AI, shown next to the rule-based ones. Nothing is stored. Every failure is a
    // plain 502: the sheet just shows no AI suggestions.
    let suggesting = 0;
    app.post("/api/title-suggestions", zValidator("json", titleSuggestBody), async (c) => {
      const body = c.req.valid("json");
      if (suggesting >= MAX_PARALLEL_TITLES) return c.json({ error: "busy" }, 429);
      suggesting++;
      try {
        const title = body.title ?? "";
        const raw = await ai.titles({
          title,
          text: body.text?.trim() || title,
          lang: body.lang && LANG.test(body.lang) ? body.lang : "de",
        });
        return c.json({ titles: cleanAiTitles(raw) });
      } catch (e) {
        if (e instanceof AiError) {
          log.warn("titles_failed", { reason: e.reason });
          return c.json({ error: "ai failed", reason: e.reason }, 502);
        }
        throw e;
      } finally {
        suggesting--;
      }
    });

    // Making the stored ingredients uniform (button in the catalog). The client loads the pairs, sends them block by
    // block to the preview (nothing is stored) and applies what the user kept.
    app.get("/api/ingredients/pairs", (c) => c.json(repo.listIngredientPairs()));
    let normalizing = 0;
    app.post("/api/ingredients/normalize/preview", zValidator("json", normalizePreviewBody), async (c) => {
      const { pairs } = c.req.valid("json");
      if (normalizing >= MAX_PARALLEL_NORMALIZE) return c.json({ error: "busy" }, 429);
      normalizing++;
      try {
        return c.json({ changes: buildChanges(pairs, await ai.normalize(aiPairs(pairs))) });
      } catch (e) {
        if (e instanceof AiError || e instanceof DraftError) {
          const reason = e instanceof AiError ? e.reason : "bad_response";
          log.warn("normalize_failed", { reason, pairs: pairs.length });
          return c.json({ error: "ai failed", reason }, 502);
        }
        throw e;
      } finally {
        normalizing--;
      }
    });
    app.post("/api/ingredients/normalize/apply", zValidator("json", normalizeApplyBody), (c) => {
      const { changes } = c.req.valid("json");
      const changed = repo.normalizeIngredients(changes);
      log.info("ingredients_normalized", { changes: changes.length, rows: changed });
      return c.json({ changed });
    });
  }

  app.get("/api/shopping/status", async (c) => {
    if (!opts.todo) return c.json({ lists: [], selected: null, reason: "disabled" });
    const status = await opts.todo.status();
    const remembered = repo.getSetting("shopping_list_entity");
    return c.json({ ...status, selected: status.lists.some((l) => l.entity_id === remembered) ? remembered : null });
  });
  if (opts.todo) {
    const todo = opts.todo;
    // The shopping list of a plan: the chosen entries (default: the open ones), their ingredients summed up per name,
    // and which items are already on the to-do list. Reading the to-do list may fail: the list is shown anyway.
    app.get("/api/plans/:id/shopping", zValidator("param", z.object({ id })), zValidator("query", shoppingQuery), async (c) => {
      const { entries: chosen, list } = c.req.valid("query");
      const ids = chosen === undefined ? null : new Set(chosen.split(",").filter(Boolean).map(Number));
      const entries = repo.getPlanIngredients(c.req.valid("param").id).map((e) => ({ ...e, selected: ids ? ids.has(e.entry_id) : !e.done }));
      const items = buildShoppingList(entries.filter((e) => e.selected));
      let open: OpenTodoItem[] = [];
      let listError = false;
      if (list && items.length) {
        try {
          open = await todo.openItems(list);
        } catch (e) {
          if (!(e instanceof TodoError)) throw e;
          listError = true;
        }
      }
      return c.json({
        entries: entries.map((e) => ({ entry_id: e.entry_id, title: e.title, done: e.done, selected: e.selected, has_recipe: e.ingredients.length > 0 })),
        items: items.map((i) => ({ ...i, on_list: isOnList(i, open) })),
        list_error: listError,
      });
    });

    // Adds the chosen items one by one (the todo service takes one item per call) and stops at the first failure: the
    // rest would most likely fail the same way. Nothing is remembered about what was sent, only which list was used.
    let sending = false;
    app.post("/api/shopping/send", zValidator("json", shoppingSend), async (c) => {
      const body = c.req.valid("json");
      if (sending) return c.json({ error: "busy" }, 429);
      sending = true;
      const t0 = performance.now();
      try {
        const status = await todo.status();
        const list = status.lists.find((l) => l.entity_id === body.list);
        if (!list) return status.reason === "unreachable" ? c.json({ error: "todo failed", reason: "unreachable" }, 502) : c.json({ error: "unknown list" }, 400);
        repo.setSetting("shopping_list_entity", list.entity_id);
        let added = 0;
        let reason: string | null = null;
        for (const item of body.items) {
          try {
            await todo.add(list, item.name, item.spec || null);
            added++;
          } catch (e) {
            if (!(e instanceof TodoError)) throw e;
            reason = e.reason;
            break;
          }
        }
        const ms = Math.round(performance.now() - t0);
        (reason ? log.warn : log.info)("shopping_sent", { list: list.entity_id, items: body.items.length, added, reason: reason ?? undefined, ms });
        return c.json({ added, failed: body.items.length - added, reason });
      } finally {
        sending = false;
      }
    });
  }

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

    // An own photo (shrunk by the browser) as the raw body. Only stored: the dish gets it via its `image` field when
    // the sheet is saved, an unsaved one is swept like an unused preview image.
    app.post(
      "/api/images",
      bodyLimit({ maxSize: MAX_IMAGE_BYTES, onError: (c) => c.json({ error: "image too large" }, 413) }),
      async (c) => {
        const data = Buffer.from(await c.req.arrayBuffer());
        if (!detectImageType(data)) return c.json({ error: "not a supported image" }, 400);
        const name = await images.save(data);
        sweep();
        return c.json({ image: name }, 201);
      },
    );

    if (opts.ai) {
      const ai = opts.ai;
      let drawing = 0;
      // A photo of the dish from Home Assistant's AI task. Title from the sheet (a new dish has no id yet), the
      // ingredient names from the saved recipe. Only stored as a file, like an upload.
      app.post("/api/images/generate", zValidator("json", imageGenerateBody), async (c) => {
        const body = c.req.valid("json");
        if (drawing >= MAX_PARALLEL_IMAGES) return c.json({ error: "busy" }, 429);
        drawing++;
        try {
          const ingredients = body.dish_id ? repo.getRecipe(body.dish_id).ingredients.map((i) => i.name) : [];
          const data = await ai.image({ title: body.title, ingredients });
          if (!detectImageType(data)) {
            log.warn("image_failed", { reason: "bad_response", detail: "not a supported image" });
            return c.json({ error: "ai failed", reason: "bad_response" }, 502);
          }
          const name = await images.save(data);
          sweep();
          return c.json({ image: name });
        } catch (e) {
          if (e instanceof AiError) {
            log.warn("image_failed", { reason: e.reason });
            return c.json({ error: "ai failed", reason: e.reason }, 502);
          }
          throw e;
        } finally {
          drawing--;
        }
      });
    }
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
  // Cook mode: all recipes of the plan once, then only the ticks (polled, see CookView).
  app.get("/api/plans/:id/cook", zValidator("param", z.object({ id })), (c) => c.json(repo.getCook(c.req.valid("param").id)));
  app.get("/api/plans/:id/checks", zValidator("param", z.object({ id })), (c) => c.json(repo.getChecks(c.req.valid("param").id)));
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
  // Sets or removes one tick of cook mode (no toggle: see repo.setCheck). Fires no HA event.
  app.put("/api/entries/:id/checks", zValidator("param", z.object({ id })), zValidator("json", checkBody), (c) => {
    const { kind, idx, checked } = c.req.valid("json");
    try {
      return c.json(repo.setCheck(c.req.valid("param").id, kind, idx, checked));
    } catch (e) {
      if (e instanceof RangeError) return c.json({ error: "no such ingredient or step" }, 400);
      throw e;
    }
  });
  app.delete("/api/entries/:id", zValidator("param", z.object({ id })), (c) => {
    const before = repo.getEntry(c.req.valid("param").id);
    repo.deleteEntry(before.id);
    entryEvent("entry_removed", before, haUser(c));
    return c.body(null, 204);
  });

  return app;
}
