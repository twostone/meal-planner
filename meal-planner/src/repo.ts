import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export type Dish = {
  id: number;
  title: string;
  url: string | null;
  note: string | null;
  image: string | null; // file name in the image store
  created_at: string;
  tags: string[]; // sorted, case-insensitively unique
};
type DishRow = Omit<Dish, "tags">;
export type Plan = {
  id: number;
  start_date: string;
  end_date: string;
  title: string | null; // optional name; null = shown as its date range
  created_at: string;
};
export type Entry = {
  id: number;
  plan_id: number;
  dish_id: number;
  position: number;
  done: boolean;
  note: string | null; // only for this dish in this plan
  dish: Dish;
};

export type DishInput = {
  title: string;
  url?: string | null;
  note?: string | null;
  image?: string | null;
  tags?: string[];
  source_text?: string | null;
  source_truncated?: boolean;
};

// The recipe columns (servings, instructions) are loaded on their own, never with the catalog.
const DISH_COLS = "id, title, url, note, image, created_at";

export const UNITS = ["g", "kg", "ml", "l", "EL", "TL", "Prise", "Zehe", "Bund", "Dose", "Packung", "Becher", "Scheibe", "Handvoll"] as const;

export type Ingredient = {
  section: string | null; // heading in the recipe, e.g. "Für den Dip"
  amount: number | null; // null = "etwas", "nach Geschmack"
  amount_max: number | null; // only for ranges ("1-2 Zehen")
  unit: string | null; // one of UNITS; null = counted without unit ("1 Zwiebel") or no amount
  name: string;
  note: string | null;
  raw: string; // original line; built from amount/unit/name when entered by hand
};
export type RecipeInput = {
  servings: number | null;
  instructions: string | null; // one step per line
  ingredients: (Omit<Ingredient, "raw"> & { raw?: string | null })[];
};
// source_text: the recipe as found at the link, unchanged; only a fetch from the link writes it, never setRecipe.
export type Recipe = Omit<RecipeInput, "ingredients"> & {
  ingredients: Ingredient[];
  source_text: string | null;
  source_truncated: boolean; // the caption may have been cut off
};

export type CheckKind = "ingredient" | "step";
export type Checks = { ingredients: number[]; steps: number[] };
export type CookEntry = {
  entry_id: number;
  dish_id: number;
  title: string;
  url: string | null;
  note: string | null; // note of the list entry
  done: boolean;
  recipe: Recipe;
  checks: Checks;
};

// The steps of a recipe: non-empty lines. The frontend splits the same way, so step numbers agree.
export const stepLines = (instructions: string | null): string[] =>
  (instructions ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export function createRepo(db: DatabaseSync) {
  const one = <T>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const all = <T>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  // True if another plan (not `excludeId`) shares at least one day with start..end (bounds inclusive).
  const overlapsOther = (excludeId: number | null, start: string, end: string) =>
    !!one("SELECT 1 FROM plan WHERE id IS NOT ? AND start_date <= ? AND ? <= end_date", excludeId, end, start);

  // Tags of all dishes in one query (the catalog of a household is small).
  function tagMap(): Map<number, string[]> {
    const m = new Map<number, string[]>();
    for (const r of all<{ dish_id: number; tag: string }>("SELECT dish_id, tag FROM dish_tag ORDER BY tag COLLATE NOCASE")) {
      const list = m.get(r.dish_id);
      if (list) list.push(r.tag);
      else m.set(r.dish_id, [r.tag]);
    }
    return m;
  }

  function withTags(rows: DishRow[]): Dish[] {
    const tags = tagMap();
    return rows.map((d) => ({ ...d, tags: tags.get(d.id) ?? [] }));
  }

  function getDish(id: number): Dish {
    const d = one<DishRow>(`SELECT ${DISH_COLS} FROM dish WHERE id = ?`, id);
    if (!d) throw new NotFoundError("dish");
    return withTags([d])[0]!;
  }

  // Replaces the tags of a dish. A tag that already exists (in any case) keeps its existing spelling,
  // so "snack" and "Snack" never end up as two different filters.
  function setTags(dishId: number, tags: string[]): void {
    db.prepare("DELETE FROM dish_tag WHERE dish_id = ?").run(dishId);
    for (const raw of tags) {
      const t = raw.trim().replace(/\s+/g, " ");
      if (!t) continue;
      const known = one<{ tag: string }>("SELECT tag FROM dish_tag WHERE tag = ? LIMIT 1", t)?.tag ?? t;
      db.prepare("INSERT OR IGNORE INTO dish_tag (dish_id, tag) VALUES (?, ?)").run(dishId, known);
    }
  }

  // Ticks of all entries of a plan, sorted by number.
  function checkMap(planId: number): Map<number, Checks> {
    const m = new Map<number, Checks>();
    for (const r of all<{ entry_id: number; kind: CheckKind; idx: number }>(
      `SELECT c.entry_id, c.kind, c.idx FROM cook_check c JOIN plan_entry e ON e.id = c.entry_id
       WHERE e.plan_id = ? ORDER BY c.idx`,
      planId,
    )) {
      let c = m.get(r.entry_id);
      if (!c) m.set(r.entry_id, (c = { ingredients: [], steps: [] }));
      (r.kind === "ingredient" ? c.ingredients : c.steps).push(r.idx);
    }
    return m;
  }

  function getEntry(id: number): Entry {
    const r = one<any>(
      `SELECT e.id, e.plan_id, e.dish_id, e.position, e.done, e.note FROM plan_entry e WHERE e.id = ?`,
      id,
    );
    if (!r) throw new NotFoundError("entry");
    return { ...r, done: !!r.done, dish: getDish(r.dish_id) };
  }

  // No transaction of its own: also used inside addEntry's.
  function insertDish(input: DishInput): Dish {
    let id: number;
    try {
      const r = db
        .prepare("INSERT INTO dish (title, url, note, image, source_text, source_truncated) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          input.title.trim(),
          input.url ?? null,
          input.note ?? null,
          input.image ?? null,
          input.source_text ?? null,
          input.source_text && input.source_truncated ? 1 : 0,
        );
      id = Number(r.lastInsertRowid);
    } catch (e: any) {
      if (String(e?.message).includes("UNIQUE")) throw new ConflictError("dish title exists");
      throw e;
    }
    if (input.tags?.length) setTags(id, input.tags);
    return getDish(id);
  }

  const num = (n: number) => String(n).replace(".", ",");
  const rawLine = (i: Omit<Ingredient, "raw">) =>
    [i.amount === null ? "" : num(i.amount) + (i.amount_max === null ? "" : `-${num(i.amount_max)}`), i.unit, i.name]
      .filter(Boolean)
      .join(" ");

  const self = {
    getRecipe(dishId: number): Recipe {
      const d = one<{ servings: number | null; instructions: string | null; source_text: string | null; source_truncated: number }>(
        "SELECT servings, instructions, source_text, source_truncated FROM dish WHERE id = ?",
        dishId,
      );
      if (!d) throw new NotFoundError("dish");
      const ingredients = all<Ingredient>(
        "SELECT section, amount, amount_max, unit, name, note, raw FROM dish_ingredient WHERE dish_id = ? ORDER BY pos",
        dishId,
      );
      return {
        servings: d.servings,
        instructions: d.instructions,
        ingredients,
        source_text: d.source_text,
        source_truncated: !!d.source_text && !!d.source_truncated,
      };
    },

    // Replaces the text found at the link (null removes it). Does not touch the structured recipe.
    setSource(dishId: number, text: string | null, truncated: boolean): void {
      const r = db
        .prepare("UPDATE dish SET source_text = ?, source_truncated = ? WHERE id = ?")
        .run(text, text && truncated ? 1 : 0, dishId);
      if (r.changes === 0) throw new NotFoundError("dish");
    },

    // Replaces the whole recipe (like setTags). An empty recipe removes it.
    setRecipe(dishId: number, recipe: RecipeInput): Recipe {
      return transaction(db, () => {
        getDish(dishId);
        // The ticks of cook mode point at ingredient/step numbers, which change with the recipe.
        db.prepare("DELETE FROM cook_check WHERE entry_id IN (SELECT id FROM plan_entry WHERE dish_id = ?)").run(dishId);
        db.prepare("UPDATE dish SET servings = ?, instructions = ? WHERE id = ?").run(recipe.servings, recipe.instructions, dishId);
        db.prepare("DELETE FROM dish_ingredient WHERE dish_id = ?").run(dishId);
        const ins = db.prepare(
          "INSERT INTO dish_ingredient (dish_id, pos, section, amount, amount_max, unit, name, note, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        recipe.ingredients.forEach((i, pos) =>
          ins.run(dishId, pos, i.section, i.amount, i.amount_max, i.unit, i.name, i.note, i.raw?.trim() || rawLine(i)),
        );
        return self.getRecipe(dishId);
      });
    },

    // q: substring of the title. ingredient: substring of the name of an ingredient of the dish's recipe.
    // Both given -> both must match. Ingredient names are compared in JS: SQLite's LIKE only folds ASCII,
    // and "Möhre" must find "möhre" (the catalog of a household is small).
    listDishes(q?: string, ingredient?: string): Dish[] {
      const needle = ingredient?.trim().toLocaleLowerCase("de");
      let rows: DishRow[];
      if (!q?.trim()) {
        rows = all<DishRow>(`SELECT ${DISH_COLS} FROM dish ORDER BY title COLLATE NOCASE`);
      } else {
        const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
        rows = all<DishRow>(`SELECT ${DISH_COLS} FROM dish WHERE title LIKE ? ESCAPE '\\' ORDER BY title COLLATE NOCASE`, like);
      }
      if (needle) {
        const ids = new Set(
          all<{ dish_id: number; name: string }>("SELECT DISTINCT dish_id, name FROM dish_ingredient")
            .filter((r) => r.name.toLocaleLowerCase("de").includes(needle))
            .map((r) => r.dish_id),
        );
        rows = rows.filter((d) => ids.has(d.id));
      }
      return withTags(rows);
    },

    getDish,
    getEntry,

    createDish(input: DishInput): Dish {
      return transaction(db, () => insertDish(input));
    },

    updateDish(id: number, patch: Partial<DishInput>): Dish {
      return transaction(db, () => {
        const cur = getDish(id);
        const next = {
          title: patch.title?.trim() ?? cur.title,
          url: patch.url === undefined ? cur.url : patch.url,
          note: patch.note === undefined ? cur.note : patch.note,
          image: patch.image === undefined ? cur.image : patch.image,
        };
        if (patch.source_text !== undefined) self.setSource(id, patch.source_text, patch.source_truncated ?? false);
        try {
          db.prepare("UPDATE dish SET title = ?, url = ?, note = ?, image = ? WHERE id = ?").run(
            next.title,
            next.url,
            next.note,
            next.image,
            id,
          );
        } catch (e: any) {
          if (String(e?.message).includes("UNIQUE")) throw new ConflictError("dish title exists");
          throw e;
        }
        if (patch.tags !== undefined) setTags(id, patch.tags);
        return getDish(id);
      });
    },

    // Image files any dish still points to (everything else in the store is garbage).
    listImages(): string[] {
      return all<{ image: string }>("SELECT DISTINCT image FROM dish WHERE image IS NOT NULL").map((r) => r.image);
    },

    deleteDish(id: number): void {
      getDish(id);
      try {
        db.prepare("DELETE FROM dish WHERE id = ?").run(id);
      } catch (e: any) {
        if (String(e?.message).includes("FOREIGN KEY")) throw new ConflictError("dish is used in a plan");
        throw e;
      }
    },

    listPlans(): (Plan & { entry_count: number; done_count: number })[] {
      return all(
        `SELECT p.*, COUNT(e.id) AS entry_count, COALESCE(SUM(e.done), 0) AS done_count
         FROM plan p LEFT JOIN plan_entry e ON e.plan_id = p.id
         GROUP BY p.id ORDER BY p.start_date DESC, p.id DESC`,
      );
    },

    // A new plan must not overlap another one (inclusive dates), same rule as in updatePlan.
    createPlan(input: { start_date: string; end_date: string }): Plan {
      return transaction(db, () => {
        if (overlapsOther(null, input.start_date, input.end_date)) throw new ConflictError("plan overlaps");
        const r = db.prepare("INSERT INTO plan (start_date, end_date) VALUES (?, ?)").run(input.start_date, input.end_date);
        return one<Plan>("SELECT * FROM plan WHERE id = ?", Number(r.lastInsertRowid))!;
      });
    },

    // Changes name and/or period of a plan. `before` is returned so the caller can tell what changed.
    // A new period must not overlap another plan (inclusive dates). The check only runs when the dates
    // change, so a plan that already overlaps (created before createPlan checked) can still be renamed.
    updatePlan(
      id: number,
      patch: { title?: string | null; start_date?: string; end_date?: string },
    ): { before: Plan; plan: Plan } {
      return transaction(db, () => {
        const before = one<Plan>("SELECT * FROM plan WHERE id = ?", id);
        if (!before) throw new NotFoundError("plan");
        const next = {
          title: patch.title === undefined ? before.title : patch.title,
          start_date: patch.start_date ?? before.start_date,
          end_date: patch.end_date ?? before.end_date,
        };
        if (next.start_date !== before.start_date || next.end_date !== before.end_date) {
          if (overlapsOther(id, next.start_date, next.end_date)) throw new ConflictError("plan overlaps");
        }
        db.prepare("UPDATE plan SET title = ?, start_date = ?, end_date = ? WHERE id = ?").run(
          next.title,
          next.start_date,
          next.end_date,
          id,
        );
        return { before, plan: one<Plan>("SELECT * FROM plan WHERE id = ?", id)! };
      });
    },

    getPlan(id: number): Plan & { entries: Entry[] } {
      const p = one<Plan>("SELECT * FROM plan WHERE id = ?", id);
      if (!p) throw new NotFoundError("plan");
      const rows = all<any>(
        `SELECT e.id, e.plan_id, e.dish_id, e.position, e.done, e.note,
                d.title AS d_title, d.url AS d_url, d.note AS d_note, d.image AS d_image, d.created_at AS d_created
         FROM plan_entry e JOIN dish d ON d.id = e.dish_id
         WHERE e.plan_id = ? ORDER BY e.position`,
        id,
      );
      const tags = tagMap();
      const entries: Entry[] = rows.map((r) => ({
        id: r.id,
        plan_id: r.plan_id,
        dish_id: r.dish_id,
        position: r.position,
        done: !!r.done,
        note: r.note,
        dish: {
          id: r.dish_id,
          title: r.d_title,
          url: r.d_url,
          note: r.d_note,
          image: r.d_image,
          created_at: r.d_created,
          tags: tags.get(r.dish_id) ?? [],
        },
      }));
      return { ...p, entries };
    },

    // Everything cook mode needs in one go: the entries of the plan in list order, each with its recipe and ticks.
    getCook(planId: number): { plan_id: number; entries: CookEntry[] } {
      const plan = self.getPlan(planId);
      const ticks = checkMap(planId);
      return {
        plan_id: planId,
        entries: plan.entries.map((e) => ({
          entry_id: e.id,
          dish_id: e.dish_id,
          title: e.dish.title,
          url: e.dish.url,
          note: e.note,
          done: e.done,
          recipe: self.getRecipe(e.dish_id),
          checks: ticks.get(e.id) ?? { ingredients: [], steps: [] },
        })),
      };
    },

    // The part of cook mode that changes while cooking (polled by every phone): done flag and ticks per entry.
    getChecks(planId: number): { entries: { entry_id: number; done: boolean; checks: Checks }[] } {
      if (!one("SELECT 1 FROM plan WHERE id = ?", planId)) throw new NotFoundError("plan");
      const ticks = checkMap(planId);
      return {
        entries: all<{ id: number; done: number }>("SELECT id, done FROM plan_entry WHERE plan_id = ? ORDER BY position", planId).map((e) => ({
          entry_id: e.id,
          done: !!e.done,
          checks: ticks.get(e.id) ?? { ingredients: [], steps: [] },
        })),
      };
    },

    // Sets (checked) or removes a tick; idempotent, so two phones never undo each other. A new tick must point at
    // an existing ingredient/step.
    setCheck(entryId: number, kind: CheckKind, idx: number, checked: boolean): Checks {
      return transaction(db, () => {
        const entry = getEntry(entryId);
        if (checked) {
          const count =
            kind === "ingredient"
              ? one<{ n: number }>("SELECT COUNT(*) AS n FROM dish_ingredient WHERE dish_id = ?", entry.dish_id)!.n
              : stepLines(one<{ instructions: string | null }>("SELECT instructions FROM dish WHERE id = ?", entry.dish_id)!.instructions).length;
          if (idx >= count) throw new RangeError(`${kind} ${idx} does not exist`);
          db.prepare("INSERT OR IGNORE INTO cook_check (entry_id, kind, idx) VALUES (?, ?, ?)").run(entryId, kind, idx);
        } else {
          db.prepare("DELETE FROM cook_check WHERE entry_id = ? AND kind = ? AND idx = ?").run(entryId, kind, idx);
        }
        return checkMap(entry.plan_id).get(entryId) ?? { ingredients: [], steps: [] };
      });
    },

    deletePlan(id: number): void {
      if (db.prepare("DELETE FROM plan WHERE id = ?").run(id).changes === 0) throw new NotFoundError("plan");
    },

    // The plan containing `today` (YYYY-MM-DD), else null. Unlike the frontend's pickInitial there is no
    // fallback: in a gap between plans nothing is "current" (used for the Home Assistant state).
    getPlanOn(today: string): (Plan & { entries: Entry[] }) | null {
      const p = one<Plan>(
        "SELECT * FROM plan WHERE start_date <= ? AND ? <= end_date ORDER BY start_date DESC, id DESC LIMIT 1",
        today,
        today,
      );
      return p ? self.getPlan(p.id) : null;
    },

    // The earliest plan starting after `today`, else null.
    getNextPlan(today: string): (Plan & { entries: Entry[] }) | null {
      const p = one<Plan>("SELECT * FROM plan WHERE start_date > ? ORDER BY start_date, id LIMIT 1", today);
      return p ? self.getPlan(p.id) : null;
    },

    // Adds a dish to a plan. Either an existing dish_id, or a title (reuses a
    // dish with the same title, case-insensitive, otherwise creates it).
    addEntry(
      planId: number,
      input: { dish_id: number } | DishInput,
    ): Entry {
      return transaction(db, () => {
        if (!one("SELECT 1 FROM plan WHERE id = ?", planId)) throw new NotFoundError("plan");
        let dishId: number;
        if ("dish_id" in input) {
          dishId = getDish(input.dish_id).id;
        } else {
          const existing = one<DishRow>(`SELECT ${DISH_COLS} FROM dish WHERE title = ? COLLATE NOCASE`, input.title.trim());
          if (existing) {
            dishId = existing.id;
            // Fill in a link/note if the catalog entry has none yet.
            if ((input.url && !existing.url) || (input.note && !existing.note)) {
              db.prepare("UPDATE dish SET url = COALESCE(url, ?), note = COALESCE(note, ?) WHERE id = ?").run(
                input.url ?? null,
                input.note ?? null,
                existing.id,
              );
            }
          } else {
            dishId = insertDish(input).id;
          }
        }
        if (one("SELECT 1 FROM plan_entry WHERE plan_id = ? AND dish_id = ?", planId, dishId))
          throw new ConflictError("dish already in plan");
        const pos = one<{ m: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS m FROM plan_entry WHERE plan_id = ?", planId)!.m;
        const r = db
          .prepare("INSERT INTO plan_entry (plan_id, dish_id, position) VALUES (?, ?, ?)")
          .run(planId, dishId, pos);
        return getEntry(Number(r.lastInsertRowid));
      });
    },

    updateEntry(id: number, patch: { done?: boolean; position?: number; note?: string | null }): Entry {
      return transaction(db, () => {
        const cur = getEntry(id);
        if (patch.done !== undefined) db.prepare("UPDATE plan_entry SET done = ? WHERE id = ?").run(patch.done ? 1 : 0, id);
        if (patch.note !== undefined) db.prepare("UPDATE plan_entry SET note = ? WHERE id = ?").run(patch.note, id);
        if (patch.position !== undefined) {
          const ids = all<{ id: number }>("SELECT id FROM plan_entry WHERE plan_id = ? ORDER BY position", cur.plan_id).map((r) => r.id);
          ids.splice(ids.indexOf(id), 1);
          ids.splice(Math.min(Math.max(patch.position, 0), ids.length), 0, id);
          const upd = db.prepare("UPDATE plan_entry SET position = ? WHERE id = ?");
          ids.forEach((eid, i) => upd.run(i, eid));
        }
        return getEntry(id);
      });
    },

    deleteEntry(id: number): void {
      if (db.prepare("DELETE FROM plan_entry WHERE id = ?").run(id).changes === 0) throw new NotFoundError("entry");
    },
  };
  return self;
}

export type Repo = ReturnType<typeof createRepo>;
