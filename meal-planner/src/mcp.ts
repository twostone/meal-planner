import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod";
import { dishBody, dishPatch, entryPatch, planBody, planPatch, recipeBody } from "./app.ts";
import { entryEvent, planUpdatedEvent, type HaEventInput, type HaUser } from "./ha-notify.ts";
import { localToday } from "./ha-state.ts";
import { logger } from "./log.ts";
import { MAX_INGREDIENTS } from "./recipe-draft.ts";
import { ConflictError, NotFoundError, stepLines, UNITS, type Dish, type Entry, type Plan, type Repo } from "./repo.ts";

const log = logger("mcp");

// The MCP tools: a curated set on top of repo.ts, no SQL. Inputs are plain and described for the model, then checked
// against the same zod schemas as the Ingress API (app.ts), so limits live in one place. Changes fire the same Home
// Assistant events as the UI. Deliberately absent: deleting plans or dishes, images, AI features, the shopping list.

export type McpDeps = {
  repo: Repo;
  notify?: (event: HaEventInput) => Promise<void>;
  version?: string;
  /** Tests fix the date; otherwise today in the container's timezone. */
  today?: () => string;
};

const INSTRUCTIONS =
  "Meal planning of one household (shared by everyone in it). A plan is a period (start_date to end_date, YYYY-MM-DD, " +
  "inclusive) holding dishes without a day assignment; plans never overlap. The catalog holds every dish ever planned, " +
  "with link, note, categories (tags) and an optional recipe. Dish titles are unique (case-insensitive). Texts are " +
  "usually German; keep the user's language when writing. Units of ingredients: " + UNITS.join(", ") + "; counted " +
  "things have no unit.";

const MAX_LIST = 100;
const DEFAULT_PLANS = 20;

const result = <T extends object>(output: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(output) }],
  structuredContent: output as Record<string, unknown>,
});
const failure = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// Turns the errors a tool can expect into a message for the model; anything else is a bug and goes to the log.
async function guarded<T>(run: () => T | Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof NotFoundError) return failure(`${e.message} not found`);
    if (e instanceof ConflictError) return failure(e.message);
    if (e instanceof z.ZodError) return failure(e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    log.error("tool_failed", { err: e, stack: e instanceof Error ? e.stack : undefined });
    return failure("internal error");
  }
}

// ---- Output shapes (compact, English keys) ----

const dishOut = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string().nullable(),
  note: z.string().nullable().describe("note on the dish, valid everywhere"),
  tags: z.array(z.string()).describe("categories"),
});
const dishView = (d: Dish): z.infer<typeof dishOut> => ({ id: d.id, title: d.title, url: d.url, note: d.note, tags: d.tags });

const planOut = z.object({
  id: z.number(),
  title: z.string().nullable().describe("name of the plan; null = known by its dates"),
  start_date: z.string(),
  end_date: z.string(),
});
const planView = (p: Plan): z.infer<typeof planOut> => ({ id: p.id, title: p.title, start_date: p.start_date, end_date: p.end_date });

const entryOut = z.object({
  entry_id: z.number(),
  dish_id: z.number(),
  title: z.string(),
  done: z.boolean(),
  note: z.string().nullable().describe("note for this dish in this plan only"),
  dish_note: z.string().nullable(),
  tags: z.array(z.string()),
  url: z.string().nullable(),
});
const entryView = (e: Entry): z.infer<typeof entryOut> => ({
  entry_id: e.id,
  dish_id: e.dish_id,
  title: e.dish.title,
  done: e.done,
  note: e.note,
  dish_note: e.dish.note,
  tags: e.dish.tags,
  url: e.dish.url,
});

const ingredientOut = z.object({
  section: z.string().nullable(),
  amount: z.number().nullable(),
  amount_max: z.number().nullable(),
  unit: z.string().nullable(),
  name: z.string(),
  plural: z.string().nullable(),
  note: z.string().nullable(),
  prep: z.string().nullable(),
});
const recipeOut = z.object({
  dish_id: z.number(),
  title: z.string(),
  servings: z.number().nullable(),
  steps: z.array(z.string()),
  ingredients: z.array(ingredientOut),
  source_text: z.string().nullable().optional().describe("the recipe as found at the link, unchanged (only on request)"),
});

// ---- Inputs ----

const optionalText = (what: string) => z.string().nullable().optional().describe(`${what}; "" or null clears it, omit to keep it`);
const ingredientIn = z.object({
  section: z.string().nullable().optional().describe('heading in the recipe, e.g. "Für den Dip"'),
  amount: z.number().nullable().optional().describe("null = no amount (\"nach Geschmack\")"),
  amount_max: z.number().nullable().optional().describe('upper end of a range ("1-2"), needs amount'),
  unit: z.enum(UNITS).nullable().optional().describe("null for counted things (\"2 Zwiebeln\") or without amount"),
  name: z.string().describe('base form in the singular, without variety or preparation: "Zwiebel"'),
  plural: z.string().nullable().optional().describe('"Zwiebeln"; null when there is none'),
  note: z.string().nullable().optional().describe('variety, relevant for shopping: "rot", "TK"'),
  prep: z.string().nullable().optional().describe('preparation, irrelevant for shopping: "gewürfelt"'),
});

export function registerTools(server: McpServer, deps: McpDeps, user: HaUser | null): void {
  const { repo } = deps;
  const today = () => (deps.today ?? localToday)();
  // Fire and forget like in app.ts: a failed event never fails the tool.
  const notify = (event: HaEventInput | null) => {
    if (event && deps.notify) void deps.notify(event).catch(() => {});
  };

  server.registerTool(
    "list_plans",
    {
      title: "List plans",
      description: "Lists the plans (meal periods), newest first, with how many dishes they hold and how many are done. Marks the plan that contains today.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(MAX_LIST).default(DEFAULT_PLANS) }),
      outputSchema: z.object({
        today: z.string(),
        plans: z.array(planOut.extend({ entry_count: z.number(), done_count: z.number(), current: z.boolean() })),
      }),
      annotations: readOnly,
    },
    async ({ limit }) =>
      guarded(() => {
        const day = today();
        const plans = repo.listPlans().slice(0, limit);
        return result({
          today: day,
          plans: plans.map((p) => ({ ...planView(p), entry_count: p.entry_count, done_count: p.done_count, current: p.start_date <= day && day <= p.end_date })),
        });
      }),
  );

  server.registerTool(
    "get_plan",
    {
      title: "Get plan",
      description: "The dishes of one plan in list order, with done state and notes. Without plan_id: the plan containing today, else the next upcoming one.",
      inputSchema: z.object({ plan_id: z.number().int().positive().optional() }),
      outputSchema: z.object({ plan: planOut.extend({ entries: z.array(entryOut) }) }),
      annotations: readOnly,
    },
    async ({ plan_id }) =>
      guarded(() => {
        const plan = plan_id ? repo.getPlan(plan_id) : (repo.getPlanOn(today()) ?? repo.getNextPlan(today()));
        if (!plan) return failure("no current or upcoming plan; use list_plans or create_plan");
        return result({ plan: { ...planView(plan), entries: plan.entries.map(entryView) } });
      }),
  );

  server.registerTool(
    "search_dishes",
    {
      title: "Search dishes",
      description:
        "Searches the catalog of all dishes. query matches the title, ingredient matches ingredient names of saved recipes (plural tolerated), tag filters by one category. All optional; together they must all match.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        ingredient: z.string().max(80).optional(),
        tag: z.string().max(30).optional(),
        limit: z.number().int().min(1).max(MAX_LIST).default(50),
      }),
      outputSchema: z.object({ total: z.number(), dishes: z.array(dishOut), tags: z.array(z.string()).describe("all categories in use") }),
      annotations: readOnly,
    },
    async ({ query, ingredient, tag, limit }) =>
      guarded(() => {
        const all = repo.listDishes(query?.trim() || undefined, ingredient?.trim() || undefined);
        const wanted = tag?.trim().toLocaleLowerCase("de");
        const found = wanted ? all.filter((d) => d.tags.some((t) => t.toLocaleLowerCase("de") === wanted)) : all;
        const tags = [...new Set(repo.listDishes().flatMap((d) => d.tags))].sort((a, b) => a.localeCompare(b, "de"));
        return result({ total: found.length, dishes: found.slice(0, limit).map(dishView), tags });
      }),
  );

  server.registerTool(
    "get_recipe",
    {
      title: "Get recipe",
      description: "The recipe of a dish: servings, steps and ingredients. With include_source also the original text from the link (can be long).",
      inputSchema: z.object({ dish_id: z.number().int().positive(), include_source: z.boolean().default(false) }),
      outputSchema: recipeOut,
      annotations: readOnly,
    },
    async ({ dish_id, include_source }) =>
      guarded(() => {
        const dish = repo.getDish(dish_id);
        const r = repo.getRecipe(dish_id);
        return result({
          dish_id,
          title: dish.title,
          servings: r.servings,
          steps: stepLines(r.instructions),
          ingredients: r.ingredients.map(({ raw: _raw, ...i }) => i),
          ...(include_source ? { source_text: r.source_text } : {}),
        });
      }),
  );

  server.registerTool(
    "create_plan",
    {
      title: "Create plan",
      description: "Creates a plan for a period. It must not share a day with another plan (touching is fine).",
      inputSchema: z.object({
        start_date: z.string().describe("first day, YYYY-MM-DD"),
        end_date: z.string().describe("last day, YYYY-MM-DD"),
        title: z.string().optional().describe("optional name"),
      }),
      outputSchema: z.object({ plan: planOut }),
      annotations: write,
    },
    async (input) =>
      guarded(() => {
        const dates = planBody.parse({ start_date: input.start_date, end_date: input.end_date });
        const title = input.title?.trim() ? planPatch.parse({ title: input.title }).title : undefined;
        let plan = repo.createPlan(dates);
        notify({ type: "plan_created", plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date }, user });
        // The plan table takes the name only through updatePlan; that is a change of its own and reported like one.
        if (title) {
          const updated = repo.updatePlan(plan.id, { title });
          notify(planUpdatedEvent(updated.before, updated.plan, user));
          plan = updated.plan;
        }
        return result({ plan: planView(plan) });
      }),
  );

  server.registerTool(
    "update_plan",
    {
      title: "Update plan",
      description: "Renames a plan and/or moves its period (both dates together). The new period must not overlap another plan.",
      inputSchema: z.object({
        plan_id: z.number().int().positive(),
        title: optionalText("name"),
        start_date: z.string().optional().describe("YYYY-MM-DD, only with end_date"),
        end_date: z.string().optional().describe("YYYY-MM-DD, only with start_date"),
      }),
      outputSchema: z.object({ plan: planOut }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ plan_id, ...input }) =>
      guarded(() => {
        const { before, plan } = repo.updatePlan(plan_id, planPatch.parse(input));
        notify(planUpdatedEvent(before, plan, user));
        return result({ plan: planView(plan) });
      }),
  );

  server.registerTool(
    "add_to_plan",
    {
      title: "Add dish to plan",
      description:
        "Adds a dish to a plan: an existing one by dish_id, or by title (reuses a catalog dish with that title, otherwise creates it with url/note/tags). A dish can be in a plan only once.",
      inputSchema: z.object({
        plan_id: z.number().int().positive(),
        dish_id: z.number().int().positive().optional(),
        title: z.string().optional().describe("instead of dish_id"),
        url: z.string().optional().describe("recipe link (http/https), only for a new dish"),
        note: z.string().optional().describe("note on the dish, only for a new dish"),
        tags: z.array(z.string()).optional().describe("categories, only for a new dish"),
        entry_note: z.string().optional().describe("note for this dish in this plan only"),
      }),
      outputSchema: z.object({ entry: entryOut }),
      annotations: write,
    },
    async (input) =>
      guarded(() => {
        if ((input.dish_id === undefined) === (input.title === undefined)) return failure("give either dish_id or title");
        const dish = input.dish_id !== undefined ? { dish_id: input.dish_id } : dishBody.parse({ title: input.title, url: input.url, note: input.note, tags: input.tags });
        const entryNote = input.entry_note?.trim() ? entryPatch.parse({ note: input.entry_note }).note : undefined;
        let entry = repo.addEntry(input.plan_id, dish);
        notify(entryEvent("entry_added", repo.getPlan(entry.plan_id), entry, user));
        if (entryNote) entry = repo.updateEntry(entry.id, { note: entryNote });
        return result({ entry: entryView(entry) });
      }),
  );

  server.registerTool(
    "update_plan_entry",
    {
      title: "Update plan entry",
      description: "Marks a dish of a plan as done (cooked) or not, and/or sets its note for this plan.",
      inputSchema: z.object({ entry_id: z.number().int().positive(), done: z.boolean().optional(), note: optionalText("note for this plan") }),
      outputSchema: z.object({ entry: entryOut }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ entry_id, ...input }) =>
      guarded(() => {
        const patch = entryPatch.parse(input);
        const before = repo.getEntry(entry_id);
        const entry = repo.updateEntry(entry_id, { done: patch.done, note: patch.note });
        if (entry.done !== before.done) notify(entryEvent(entry.done ? "entry_done" : "entry_undone", repo.getPlan(entry.plan_id), entry, user));
        return result({ entry: entryView(entry) });
      }),
  );

  server.registerTool(
    "remove_from_plan",
    {
      title: "Remove dish from plan",
      description: "Removes a dish from a plan (the entry and its note). The dish stays in the catalog.",
      inputSchema: z.object({ entry_id: z.number().int().positive() }),
      outputSchema: z.object({ removed: z.boolean() }),
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    async ({ entry_id }) =>
      guarded(() => {
        const before = repo.getEntry(entry_id);
        repo.deleteEntry(entry_id);
        notify(entryEvent("entry_removed", repo.getPlan(before.plan_id), before, user));
        return result({ removed: true });
      }),
  );

  server.registerTool(
    "create_dish",
    {
      title: "Create dish",
      description: "Adds a dish to the catalog without planning it. The title must not exist yet (case-insensitive).",
      inputSchema: z.object({
        title: z.string(),
        url: z.string().optional().describe("recipe link (http/https)"),
        note: z.string().optional(),
        tags: z.array(z.string()).optional().describe("categories, reuse existing ones (see search_dishes)"),
      }),
      outputSchema: z.object({ dish: dishOut }),
      annotations: write,
    },
    async (input) => guarded(() => result({ dish: dishView(repo.createDish(dishBody.parse(input))) })),
  );

  server.registerTool(
    "update_dish",
    {
      title: "Update dish",
      description: "Changes title, link, note or categories of a catalog dish. tags replaces all categories.",
      inputSchema: z.object({
        dish_id: z.number().int().positive(),
        title: z.string().optional(),
        url: optionalText("recipe link (http/https)"),
        note: optionalText("note on the dish"),
        tags: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ dish: dishOut }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ dish_id, ...input }) => guarded(() => result({ dish: dishView(repo.updateDish(dish_id, dishPatch.parse(input))) })),
  );

  server.registerTool(
    "set_recipe",
    {
      title: "Set recipe",
      description:
        `Replaces the whole recipe of a dish (servings, steps, up to ${MAX_INGREDIENTS} ingredients); empty lists delete it. ` +
        "Read it first with get_recipe when changing only a part. Clears the cook-mode ticks of this dish.",
      inputSchema: z.object({
        dish_id: z.number().int().positive(),
        servings: z.number().int().nullable().optional().describe("1-50"),
        steps: z.array(z.string()).default([]).describe("one step per item"),
        ingredients: z.array(ingredientIn).default([]),
      }),
      outputSchema: recipeOut,
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    async ({ dish_id, servings, steps, ingredients }) =>
      guarded(() => {
        const body = recipeBody.parse({
          servings: servings ?? null,
          instructions: steps.map((s) => s.trim()).filter(Boolean).join("\n"),
          ingredients: ingredients.map((i) => ({
            section: i.section ?? null,
            amount: i.amount ?? null,
            amount_max: i.amount_max ?? null,
            unit: i.unit ?? null,
            name: i.name,
            plural: i.plural ?? null,
            note: i.note ?? null,
            prep: i.prep ?? null,
          })),
        });
        const dish = repo.getDish(dish_id);
        const r = repo.setRecipe(dish_id, body);
        return result({
          dish_id,
          title: dish.title,
          servings: r.servings,
          steps: stepLines(r.instructions),
          ingredients: r.ingredients.map(({ raw: _raw, ...i }) => i),
        });
      }),
  );
}

/** One server per request, bound to the Home Assistant user of the verified token; tool arguments cannot change it. */
export function buildMcpServer(deps: McpDeps, user: HaUser | null): McpServer {
  const server = new McpServer({ name: "meal-planner", version: deps.version ?? "0.0.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, deps, user);
  return server;
}

// The user as the bus events carry it. HA's current_user only knows the display name, not the login name.
export const eventUser = (u: { id: string; name: string | null }): HaUser => ({ id: u.id, name: null, display_name: u.name });

// Streamable HTTP, stateless: every request builds its own server for the user in `authInfo` (set by the MCP listener
// after the Home Assistant token check). Nothing is kept between requests.
export function createMcpEndpoint(deps: McpDeps) {
  const handler = createMcpHandler(
    (ctx) => {
      const user = ctx.authInfo?.extra?.user as { id: string; name: string | null } | undefined;
      if (!user) throw new Error("MCP request without an authenticated user"); // the listener never lets that through
      return buildMcpServer(deps, eventUser(user));
    },
    { onerror: (err) => log.warn("handler_error", { err }) },
  );
  return (request: Request, authInfo: AuthInfo): Promise<Response> => handler.fetch(request, { authInfo });
}
