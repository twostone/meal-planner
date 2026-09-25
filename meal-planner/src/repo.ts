import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export type Dish = { id: number; title: string; url: string | null; note: string | null; created_at: string };
export type Plan = { id: number; start_date: string; end_date: string; created_at: string };
export type Entry = { id: number; plan_id: number; dish_id: number; position: number; done: boolean; dish: Dish };

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export function createRepo(db: DatabaseSync) {
  const one = <T>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const all = <T>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];

  function getDish(id: number): Dish {
    const d = one<Dish>("SELECT * FROM dish WHERE id = ?", id);
    if (!d) throw new NotFoundError("dish");
    return d;
  }

  function getEntry(id: number): Entry {
    const r = one<any>(
      `SELECT e.id, e.plan_id, e.dish_id, e.position, e.done FROM plan_entry e WHERE e.id = ?`,
      id,
    );
    if (!r) throw new NotFoundError("entry");
    return { ...r, done: !!r.done, dish: getDish(r.dish_id) };
  }

  const self = {
    listDishes(q?: string): Dish[] {
      if (!q?.trim()) return all<Dish>("SELECT * FROM dish ORDER BY title COLLATE NOCASE");
      const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
      return all<Dish>("SELECT * FROM dish WHERE title LIKE ? ESCAPE '\\' ORDER BY title COLLATE NOCASE", like);
    },

    getDish,

    createDish(input: { title: string; url?: string | null; note?: string | null }): Dish {
      try {
        const r = db
          .prepare("INSERT INTO dish (title, url, note) VALUES (?, ?, ?)")
          .run(input.title.trim(), input.url ?? null, input.note ?? null);
        return getDish(Number(r.lastInsertRowid));
      } catch (e: any) {
        if (String(e?.message).includes("UNIQUE")) throw new ConflictError("dish title exists");
        throw e;
      }
    },

    updateDish(id: number, patch: { title?: string; url?: string | null; note?: string | null }): Dish {
      const cur = getDish(id);
      const next = {
        title: patch.title?.trim() ?? cur.title,
        url: patch.url === undefined ? cur.url : patch.url,
        note: patch.note === undefined ? cur.note : patch.note,
      };
      try {
        db.prepare("UPDATE dish SET title = ?, url = ?, note = ? WHERE id = ?").run(next.title, next.url, next.note, id);
      } catch (e: any) {
        if (String(e?.message).includes("UNIQUE")) throw new ConflictError("dish title exists");
        throw e;
      }
      return getDish(id);
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

    createPlan(input: { start_date: string; end_date: string }): Plan {
      const r = db.prepare("INSERT INTO plan (start_date, end_date) VALUES (?, ?)").run(input.start_date, input.end_date);
      return one<Plan>("SELECT * FROM plan WHERE id = ?", Number(r.lastInsertRowid))!;
    },

    getPlan(id: number): Plan & { entries: Entry[] } {
      const p = one<Plan>("SELECT * FROM plan WHERE id = ?", id);
      if (!p) throw new NotFoundError("plan");
      const rows = all<any>(
        `SELECT e.id, e.plan_id, e.dish_id, e.position, e.done,
                d.title AS d_title, d.url AS d_url, d.note AS d_note, d.created_at AS d_created
         FROM plan_entry e JOIN dish d ON d.id = e.dish_id
         WHERE e.plan_id = ? ORDER BY e.position`,
        id,
      );
      const entries: Entry[] = rows.map((r) => ({
        id: r.id,
        plan_id: r.plan_id,
        dish_id: r.dish_id,
        position: r.position,
        done: !!r.done,
        dish: { id: r.dish_id, title: r.d_title, url: r.d_url, note: r.d_note, created_at: r.d_created },
      }));
      return { ...p, entries };
    },

    deletePlan(id: number): void {
      if (db.prepare("DELETE FROM plan WHERE id = ?").run(id).changes === 0) throw new NotFoundError("plan");
    },

    // Adds a dish to a plan. Either an existing dish_id, or a title (reuses a
    // dish with the same title, case-insensitive, otherwise creates it).
    addEntry(
      planId: number,
      input: { dish_id: number } | { title: string; url?: string | null; note?: string | null },
    ): Entry {
      return transaction(db, () => {
        if (!one("SELECT 1 FROM plan WHERE id = ?", planId)) throw new NotFoundError("plan");
        let dishId: number;
        if ("dish_id" in input) {
          dishId = getDish(input.dish_id).id;
        } else {
          const existing = one<Dish>("SELECT * FROM dish WHERE title = ? COLLATE NOCASE", input.title.trim());
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
            dishId = self.createDish(input).id;
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

    updateEntry(id: number, patch: { done?: boolean; position?: number }): Entry {
      return transaction(db, () => {
        const cur = getEntry(id);
        if (patch.done !== undefined) db.prepare("UPDATE plan_entry SET done = ? WHERE id = ?").run(patch.done ? 1 : 0, id);
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
