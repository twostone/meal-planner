import type { Entry, Plan, Repo } from "./repo.ts";

// Flattened per-entry shape for the HA state: the companion integration/card renders this
// directly (as one sensor's attributes), so dish fields are inlined rather than nested under
// `dish` the way repo.ts's Entry type has them.
export type HaEntry = {
  id: number;
  dish_id: number;
  title: string;
  note: string | null;
  tags: string[];
  image: string | null;
  url: string | null;
  done: boolean;
};
export type HaPlan = {
  id: number;
  start_date: string;
  end_date: string;
  title: string | null; // optional name of the plan; null = none set
  entry_count: number;
  done_count: number;
  entries: HaEntry[];
};
export type HaState = { current: HaPlan | null; next: HaPlan | null; generated_at: string };

// Today in the container's timezone (TZ), not UTC: plans are calendar dates and must flip at local midnight.
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function snapshot(plan: (Plan & { entries: Entry[] }) | null): HaPlan | null {
  if (!plan) return null;
  const entries: HaEntry[] = plan.entries.map((e) => ({
    id: e.id,
    dish_id: e.dish_id,
    title: e.dish.title,
    note: e.note,
    tags: e.dish.tags,
    image: e.dish.image,
    url: e.dish.url,
    done: e.done,
  }));
  return {
    id: plan.id,
    start_date: plan.start_date,
    end_date: plan.end_date,
    title: plan.title,
    entry_count: entries.length,
    done_count: entries.filter((e) => e.done).length,
    entries,
  };
}

// "Current" and "next" are derived from the date on every call, so nothing has to run at midnight.
export function haState(repo: Repo, now = new Date()): HaState {
  const today = localToday(now);
  return {
    current: snapshot(repo.getPlanOn(today)),
    next: snapshot(repo.getNextPlan(today)),
    generated_at: now.toISOString(),
  };
}
