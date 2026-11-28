import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { AiError, MAX_KNOWN_NAMES, type RecipeAi } from "./ha-ai.ts";
import { TodoError, type HaTodo, type OpenTodoItem } from "./ha-todo.ts";
import { entryEvent as entryEventInput, planUpdatedEvent, type EntryEventType, type HaEventInput, type HaUser } from "./ha-notify.ts";
import { detectImageType, IMAGE_NAME, MAX_IMAGE_BYTES, type ImageStore } from "./images.ts";
import { localToday } from "./ha-state.ts";
import { logger } from "./log.ts";
import type { PreviewResult } from "./preview.ts";
import { buildDraft, DraftError, MAX_INGREDIENTS } from "./recipe-draft.ts";
import { aiItems, buildChanges } from "./ingredient-normalize.ts";
import { FOREIGN_UNITS } from "./units.ts";
import { ConflictError, InvalidInputError, NotFoundError, UNITS, type Entry, type Repo } from "./repo.ts";
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

// Free-form categories, as many as wanted. Duplicates (any case) are merged by the repo, so only their length is checked.
const tags = z.array(z.string().trim().min(1).max(30));

// The ingredient catalog addresses a name by its nameKey, in the body: names hold spaces and umlauts.
const MAX_INGREDIENT_NAME = 80; // same as dish_ingredient.name in recipeBody
const ingredientName = z.string().trim().min(1).max(MAX_INGREDIENT_NAME);
const ingredientKey = z.object({ key: z.string().min(1).max(MAX_INGREDIENT_NAME) });
// A category of ingredients ("Gewürz"): as long as a dish tag. "" or null removes it, missing keeps it.
const MAX_CATEGORY_LENGTH = 30;
const ingredientPatch = ingredientKey
  .extend({ pantry: z.boolean().optional(), category: optional(z.string().trim().min(1).max(MAX_CATEGORY_LENGTH)) })
  .refine((b) => b.pantry !== undefined || b.category !== undefined, "nothing to change");
const categoryPatch = z.object({ key: z.string().min(1).max(MAX_CATEGORY_LENGTH), pantry: z.boolean() });

// The recipe text from a link preview (see POST /api/preview). Stored unchanged, never interpreted.
const source = { source_text: optional(z.string().max(10000)), source_truncated: z.boolean().optional() };

export const dishBody = z.object({ title, url: optional(url), note: optional(note), image: optional(image), tags: tags.optional(), ...source });
export const dishPatch = z.object({
  title: title.optional(),
  url: optional(url),
  note: optional(note),
  image: optional(image),
  tags: tags.optional(),
  ...source,
});
export const planBody = z
  .object({ start_date: date, end_date: date })
  .refine((v) => v.end_date >= v.start_date, { message: "end_date before start_date", path: ["end_date"] });
// Optional name of a plan; "" or null clears it.
const planTitle = z.string().trim().min(1).max(100);
// The period is changed as a whole: both dates or none, so the end-after-start check needs no stored values.
export const planPatch = z
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

// Splitting a collective ingredient ("Salz & Pfeffer"): at least two parts, none named like the line itself (it would stay).
const MIN_SPLIT_PARTS = 2;
const MAX_SPLIT_PARTS = 10;
const ingredientSplit = ingredientKey
  .extend({ parts: z.array(z.object({ name: ingredientName, note: text(200) })).min(MIN_SPLIT_PARTS).max(MAX_SPLIT_PARTS) })
  .refine((b) => b.parts.every((p) => nameKey(p.name) !== b.key), "a part keeps the name of the line");
// Renaming or merging an ingredient: the new name and what all its lines get (plural, a variety where none is set).
const ingredientRenamePreview = ingredientKey.extend({ name: ingredientName });
const ingredientRename = ingredientRenamePreview.extend({ plural: text(80), note: text(200), pantry: z.boolean() });
const ingredient = z
  .object({
    section: text(80),
    amount: z.number().min(0).max(100000).nullable(),
    amount_max: z.number().min(0).max(100000).nullable(),
    unit: z.enum(UNITS).nullable(),
    name: z.string().trim().min(1).max(80),
    plural: text(80).optional(), // missing (older client) = none
    note: text(200),
    prep: text(200).optional(), // missing (older client) = none
    raw: z.string().trim().max(200).nullish(), // built from amount/unit/name when missing
  })
  .refine((v) => v.amount_max === null || (v.amount !== null && v.amount_max >= v.amount), {
    message: "amount_max needs an amount and must not be smaller",
    path: ["amount_max"],
  });
export const recipeBody = z.object({
  servings: z.number().int().min(1).max(50).nullable(),
  instructions: text(10000),
  ingredients: z.array(ingredient).max(MAX_INGREDIENTS),
});
// Making the ingredients of one recipe uniform: the reviewed changes to apply (at most one per line).
const normalizeApplyBody = z.object({
  changes: z
    .array(
      z.object({
        pos: z.number().int().min(0).max(MAX_INGREDIENTS - 1),
        from: z.object({ name: z.string().min(1).max(80), note: z.string().max(200).nullable() }),
        to: z.object({ name: z.string().trim().min(1).max(80), plural: text(80), note: text(200), prep: text(200) }),
        unit: z.enum(FOREIGN_UNITS).nullable(),
      }),
    )
    .min(1)
    .max(MAX_INGREDIENTS),
});
// Input of the AI title suggestions: the page title and the text found at the link (or, without one, the title again).
// `lang` comes from the browser; anything that is not a plain language code ("de", "en-GB") counts as missing.
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const titleSuggestBody = z
  .object({ title: z.string().trim().max(200).optional(), text: z.string().max(10000).optional(), lang: z.string().max(35).optional() })
  .refine((v) => !!(v.title || v.text?.trim()), { message: "title or text needed" });
// The title as typed in the sheet; with dish_id the saved recipe's ingredient names go into the prompt too.
const imageGenerateBody = z.object({ title, dish_id: id.optional() });
// The plan to move entries to; it must not be over yet (checked against today in the route).
const moveBody = z.object({ plan_id: id });
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
// A new dish from the sheet can bring its recipe along (only here: PATCH and list entries take none).
const newDishBody = dishBody.extend({ recipe: recipeBody.optional() });
// A share file of dishes between two installations. It comes from someone else's instance, so it is checked like any
// input, with the same schemas as the API. docs/dish-export.schema.json is generated from `shareFile` (npm run schema).
export const SHARE_FORMAT = "essensplanung-dishes";
export const SHARE_VERSION = 1;
const MAX_SHARED_DISHES = 500;
// Up to 500 dishes with 10 000 characters of source text and instructions each, plus their ingredients.
const MAX_SHARE_BYTES = 25 * 1024 * 1024;
const sharedDish = dishBody.omit({ image: true }).extend({ recipe: recipeBody.nullable().optional() });
export const shareFile = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION),
  exported_at: z.string().max(40).optional(),
  dishes: z.array(sharedDish).min(1).max(MAX_SHARED_DISHES),
});
// The share file as JSON Schema for other tools (docs/dish-export.schema.json). Rules zod checks in code (http(s) links,
// amount_max >= amount) are not in it: the app stays the strict check.
export const shareFileJsonSchema = () =>
  JSON.stringify(
    {
      ...z.toJSONSchema(shareFile, { io: "input" }),
      title: "Essensplanung: geteilte Gerichte",
      description: "Datei zum Austausch von Gerichten zwischen zwei Installationen der App Essensplanung.",
    },
    null,
    2,
  ) + "\n";
const exportBody = z.object({ ids: z.array(id).min(1).max(MAX_SHARED_DISHES), notes: z.boolean() });
// index: position in file.dishes; dishes without an action are skipped. "new" may give another title.
const importBody = z.object({
  file: shareFile,
  tags: z.boolean(),
  actions: z
    .array(z.object({ index: z.number().int().min(0), action: z.enum(["new", "replace"]), title: title.optional() }))
    .max(MAX_SHARED_DISHES),
});
// Text to make a recipe draft from: the source text of the link or the dish, possibly edited in the sheet.
const draftBody = z.object({ text: z.string().trim().min(1).max(10000) });
// note: only for this entry (dish in one plan); "" or null clears it
export const entryPatch = z.object({
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
  // Tests fix the date; otherwise today in the container's timezone (decides which plans are still a move target).
  today?: () => string;
};

const log = logger("app");
// A request is only logged when it failed or took this long: cook mode polls every 4 s and would flood the log.
const SLOW_REQUEST_MS = 2000;

const MAX_PARALLEL_PREVIEWS = 4;
const MAX_PARALLEL_DRAFTS = 2;
const MAX_PARALLEL_TITLES = 2;
// Generating an image takes up to a minute and costs the most: one at a time.
const MAX_PARALLEL_IMAGES = 1;
const MAX_PARALLEL_NORMALIZE = 2;

// Is the item already open on the to-do list? Items may share a name ("Nüsse" for Macadamia and for Walnuss), so one with a
// note only counts when an open item of that name mentions the note in its description. The amount is not compared: it
// changes with the plan, and a match must not fail on "80 g" against "100 g".
// An item sent before the plural existed carries the singular, so both forms count.
function isOnList(item: ShoppingItem, open: OpenTodoItem[]): boolean {
  const names = new Set([nameKey(item.name), nameKey(item.base)]);
  const note = item.note ? nameKey(item.note) : null;
  return open.some((o) => names.has(nameKey(o.summary)) && (note === null || (o.description !== null && nameKey(o.description).includes(note))));
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
  const today = () => (opts.today ?? localToday)();
  const notifyHa = (event: HaEventInput) => {
    if (opts.notify) void opts.notify(event).catch(() => {});
  };
  const entryEvent = (type: EntryEventType, e: Entry, user: HaUser | null) => {
    if (opts.notify) notifyHa(entryEventInput(type, repo.getPlan(e.plan_id), e, user));
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
    if (err instanceof InvalidInputError) return c.json({ error: err.message }, 400);
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

  // The ingredient catalog: what the household knows about an ingredient, e.g. that salt is always at home.
  app.get("/api/ingredients", (c) => c.json(repo.listIngredients()));
  app.post("/api/ingredients", zValidator("json", z.object({ name: ingredientName })), (c) =>
    c.json(repo.createIngredient(c.req.valid("json").name), 201),
  );
  app.patch("/api/ingredients", zValidator("json", ingredientPatch), (c) => {
    const { key, ...input } = c.req.valid("json");
    return c.json(repo.setIngredient(key, input));
  });
  // Jump from an ingredient to the recipes that use it.
  app.post("/api/ingredients/dishes", zValidator("json", ingredientKey), (c) => c.json(repo.ingredientDishes(c.req.valid("json").key)));
  app.post("/api/ingredients/reset", zValidator("json", ingredientKey), (c) => c.json(repo.resetIngredient(c.req.valid("json").key)));
  // Categories of ingredients; a whole category can be always at home.
  app.get("/api/ingredient-categories", (c) => c.json(repo.listIngredientCategories()));
  app.patch("/api/ingredient-categories", zValidator("json", categoryPatch), (c) => {
    const { key, pantry } = c.req.valid("json");
    return c.json(repo.setCategoryPantry(key, pantry));
  });
  app.post("/api/ingredients/split/preview", zValidator("json", ingredientKey), (c) => c.json(repo.previewSplit(c.req.valid("json").key)));
  app.post("/api/ingredients/split", zValidator("json", ingredientSplit), (c) => {
    const { key, parts } = c.req.valid("json");
    const dishes = repo.splitIngredient(key, parts);
    log.info("ingredient_split", { dishes, parts: parts.length });
    return c.json({ dishes });
  });
  app.post("/api/ingredients/rename/preview", zValidator("json", ingredientRenamePreview), (c) => {
    const { key, name } = c.req.valid("json");
    return c.json(repo.previewRename(key, name));
  });
  app.post("/api/ingredients/rename", zValidator("json", ingredientRename), (c) => {
    const { key, ...input } = c.req.valid("json");
    const dishes = repo.renameIngredient(key, input);
    log.info("ingredient_renamed", { dishes });
    return c.json({ dishes });
  });
  app.post("/api/ingredients/delete", zValidator("json", ingredientKey), (c) => {
    repo.deleteIngredient(c.req.valid("json").key);
    return c.body(null, 204);
  });
  // Sharing dishes with another installation as a file (see shareFile).
  const shareLimit = bodyLimit({ maxSize: MAX_SHARE_BYTES, onError: (c) => c.json({ error: "file too large" }, 413) });
  // A file of another format or a newer version gets its own error, so the UI can ask to update the app.
  const shareCheck =
    (fileAt: (string | number)[]) =>
    (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, c: Context) => {
      if (r.success) return;
      const header = (r.error?.issues ?? []).some(
        (i) => fileAt.every((p, k) => i.path[k] === p) && ["format", "version"].includes(String(i.path[fileAt.length])),
      );
      return c.json({ error: header ? "unsupported file" : "invalid file" }, 400);
    };
  app.post("/api/dishes/export", zValidator("json", exportBody), (c) => {
    const { ids, notes } = c.req.valid("json");
    const dishes = repo.exportDishes(ids, notes);
    log.info("dishes_exported", { count: dishes.length });
    return c.json({ format: SHARE_FORMAT, version: SHARE_VERSION, exported_at: new Date().toISOString(), dishes });
  });
  app.post("/api/dishes/import/preview", shareLimit, zValidator("json", shareFile, shareCheck([])), (c) => {
    const dishes = c.req.valid("json").dishes.map((d, index) => {
      const existing = repo.findMatch({ title: d.title, url: d.url ?? null });
      return {
        index,
        title: d.title,
        ingredients: d.recipe?.ingredients.length ?? 0,
        exists: existing ? { id: existing.id, title: existing.title } : null,
        // Another recipe has this title already: it can only come in under another one.
        title_taken: !existing && !!repo.findDishByTitle(d.title),
      };
    });
    return c.json({ dishes });
  });
  app.post("/api/dishes/import", shareLimit, zValidator("json", importBody, shareCheck(["file"])), (c) => {
    const { file, tags, actions } = c.req.valid("json");
    if (actions.some((a) => a.index >= file.dishes.length)) return c.json({ error: "unknown index" }, 400);
    if (new Set(actions.map((a) => a.index)).size !== actions.length) return c.json({ error: "duplicate index" }, 400);
    const items = actions.map(({ index, action, title }) => {
      const { recipe, ...d } = file.dishes[index]!;
      const dish = {
        title: d.title,
        url: d.url ?? null,
        note: d.note ?? null,
        tags: d.tags ?? [],
        source_text: d.source_text ?? null,
        source_truncated: d.source_truncated ?? false,
        recipe: recipe ?? null,
      };
      return { dish, action, title };
    });
    const result = repo.importDishes(items, tags);
    const skipped = file.dishes.length - actions.length;
    log.info("dishes_imported", { created: result.created, replaced: result.replaced, skipped });
    return c.json({ ...result, skipped });
  });

  app.post("/api/dishes", zValidator("json", newDishBody), async (c) => {
    const { recipe, ...body } = c.req.valid("json");
    if (await imageMissing(body.image)) return c.json({ error: "unknown image" }, 400);
    const dish = repo.createDish(body, recipe);
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
    // Draft only: nothing is stored. The user reviews it (with the source text next to it) and saves it with the recipe.
    // The text comes from the sheet (the source text, possibly edited by the user), so the draft is checked against it.
    app.post("/api/recipe/draft", zValidator("json", draftBody), async (c) => {
      const { text } = c.req.valid("json");
      if (drafting >= MAX_PARALLEL_DRAFTS) return c.json({ error: "busy" }, 429);
      drafting++;
      try {
        return c.json(buildDraft(await ai.generate(text, repo.listIngredientNames(MAX_KNOWN_NAMES)), text));
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

    // Making the ingredients of one saved recipe uniform (button in the recipe view): a preview that stores nothing,
    // then the changes the user kept. Applying keeps the ticks of cook mode (see normalizeRecipe).
    let normalizing = 0;
    app.post("/api/dishes/:id/recipe/normalize", zValidator("param", z.object({ id })), async (c) => {
      const lines = repo.getRecipe(c.req.valid("param").id).ingredients;
      if (!lines.length) return c.json({ error: "recipe has no ingredients" }, 400);
      if (normalizing >= MAX_PARALLEL_NORMALIZE) return c.json({ error: "busy" }, 429);
      normalizing++;
      try {
        return c.json({ changes: buildChanges(lines, await ai.normalize(aiItems(lines), repo.listIngredientNames(MAX_KNOWN_NAMES))) });
      } catch (e) {
        if (e instanceof AiError || e instanceof DraftError) {
          const reason = e instanceof AiError ? e.reason : "bad_response";
          log.warn("normalize_failed", { reason, lines: lines.length });
          return c.json({ error: "ai failed", reason }, 502);
        }
        throw e;
      } finally {
        normalizing--;
      }
    });
    app.post("/api/dishes/:id/recipe/normalize/apply", zValidator("param", z.object({ id })), zValidator("json", normalizeApplyBody), (c) => {
      const dishId = c.req.valid("param").id;
      const { changes } = c.req.valid("json");
      const changed = repo.normalizeRecipe(dishId, changes);
      log.info("recipe_normalized", { changes: changes.length, lines: changed });
      return c.json(repo.getRecipe(dishId));
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
      const pantry = repo.pantryKeys();
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
        items: items.map((i) => ({ ...i, on_list: isOnList(i, open), pantry: pantry.has(nameKey(i.base)) })),
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
    const event = planUpdatedEvent(before, plan, haUser(c));
    if (event) notifyHa(event);
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
  // Moving dishes that were not cooked to another plan: one entry from the dish sheet, or all open entries of a plan
  // from the period sheet. HA sees a move as removed from the old plan and added to the new one.
  const moveTo = (c: Context, entryIds: number[], sourcePlanId: number, targetPlanId: number) => {
    const target = repo.getPlan(targetPlanId);
    if (target.id === sourcePlanId) return c.json({ error: "same plan" }, 400);
    if (target.end_date < today()) return c.json({ error: "plan is over" }, 400);
    const results = repo.moveEntries(entryIds, target.id);
    const user = haUser(c);
    for (const { before, merged } of results) {
      entryEvent("entry_removed", before, user);
      if (!merged) entryEvent("entry_added", repo.getEntry(before.id), user);
    }
    const merged = results.filter((r) => r.merged).length;
    return c.json({ moved: results.length - merged, merged });
  };
  app.post("/api/entries/:id/move", zValidator("param", z.object({ id })), zValidator("json", moveBody), (c) => {
    const entry = repo.getEntry(c.req.valid("param").id);
    if (entry.done) return c.json({ error: "entry is done" }, 409);
    return moveTo(c, [entry.id], entry.plan_id, c.req.valid("json").plan_id);
  });
  app.post("/api/plans/:id/move-open", zValidator("param", z.object({ id })), zValidator("json", moveBody), (c) => {
    const source = repo.getPlan(c.req.valid("param").id);
    const open = source.entries.filter((e) => !e.done).map((e) => e.id);
    return moveTo(c, open, source.id, c.req.valid("json").plan_id);
  });
  app.delete("/api/entries/:id", zValidator("param", z.object({ id })), (c) => {
    const before = repo.getEntry(c.req.valid("param").id);
    repo.deleteEntry(before.id);
    entryEvent("entry_removed", before, haUser(c));
    return c.body(null, 204);
  });

  return app;
}
