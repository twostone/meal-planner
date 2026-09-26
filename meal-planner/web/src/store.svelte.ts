import * as api from "./api";
import { today } from "./dates";
import type { Dish, DishInput, Entry, PlanDetail, PlanSummary } from "./types";

export type SheetState =
  | { kind: "none" }
  | {
      kind: "dish";
      dishId: number | null; // null = create a new dish
      entryId: number | null; // set when opened from the list (enables "remove from list")
      addToPlan: boolean; // create mode: also put the new dish into the current plan
      prefill: { title: string; url: string; tags: string[] };
    }
  | { kind: "periods" };

export const app = $state({
  ready: false,
  view: "list" as "list" | "catalog",
  plans: [] as PlanSummary[],
  plan: null as PlanDetail | null,
  dishes: [] as Dish[],
  error: "",
  sheet: { kind: "none" } as SheetState,
});

// The plan containing today, else the next upcoming one, else the newest.
function pickInitial(plans: PlanSummary[]): number | null {
  const t = today();
  const current = plans.find((p) => p.start_date <= t && t <= p.end_date);
  if (current) return current.id;
  const upcoming = plans.filter((p) => p.start_date > t).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  return (upcoming ?? plans[0])?.id ?? null; // plans arrive newest-first
}

// Runs an action, shows its error message instead of throwing. Returns success.
async function guard(fn: () => Promise<void>): Promise<boolean> {
  try {
    app.error = "";
    await fn();
    return true;
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
    return false;
  }
}

const refreshPlans = async () => void (app.plans = await api.listPlans());
const refreshDishes = async () => void (app.dishes = await api.listDishes());
const loadPlan = async (id: number) => void (app.plan = await api.getPlan(id));
const reload = () =>
  Promise.all([refreshPlans(), refreshDishes(), app.plan ? loadPlan(app.plan.id) : Promise.resolve()]).then(() => {});

export async function init() {
  await guard(async () => {
    await Promise.all([refreshPlans(), refreshDishes()]);
    const id = pickInitial(app.plans);
    if (id !== null) await loadPlan(id);
  });
  app.ready = true;
}

// Back button: an open sheet owns one history entry, so "back" (Android button or gesture) closes the sheet
// instead of leaving the app for the previous Home Assistant page. The app runs in an iframe, where the
// iframe's entries share the tab's history, so the entry is popped first. The URL is not changed.
let sheetEntry = false;

function pushSheetEntry() {
  if (sheetEntry) return;
  history.pushState({ sheet: true }, "");
  sheetEntry = true;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (!sheetEntry) return;
    sheetEntry = false; // the entry is already gone, so closing must not go back again
    app.sheet = { kind: "none" };
  });
}

export function closeSheet() {
  app.sheet = { kind: "none" };
  if (sheetEntry) {
    sheetEntry = false;
    history.back(); // remove our entry; the resulting popstate finds nothing left to do
  }
}
export const dismissError = () => void (app.error = "");

export function openDishSheet(opts: {
  dishId?: number | null;
  entryId?: number | null;
  addToPlan?: boolean;
  title?: string;
  url?: string;
  tags?: string[];
}) {
  app.error = "";
  pushSheetEntry();
  app.sheet = {
    kind: "dish",
    dishId: opts.dishId ?? null,
    entryId: opts.entryId ?? null,
    addToPlan: opts.addToPlan ?? false,
    prefill: { title: opts.title ?? "", url: opts.url ?? "", tags: opts.tags ?? [] },
  };
}

export function openPeriods() {
  app.error = "";
  pushSheetEntry();
  app.sheet = { kind: "periods" };
}

export const selectPlan = (id: number) =>
  guard(async () => {
    await loadPlan(id);
    closeSheet();
  });

export const createPlan = (start_date: string, end_date: string) =>
  guard(async () => {
    const p = await api.createPlan({ start_date, end_date });
    await refreshPlans();
    await loadPlan(p.id);
    closeSheet();
  });

export const deletePlan = (id: number) =>
  guard(async () => {
    await api.deletePlan(id);
    await refreshPlans();
    if (app.plan?.id === id) {
      app.plan = null;
      const next = pickInitial(app.plans);
      if (next !== null) await loadPlan(next);
    }
  });

export const addDishToPlan = (dishId: number) =>
  guard(async () => {
    if (!app.plan) throw new Error("Bitte zuerst einen Zeitraum anlegen.");
    await api.addEntry(app.plan.id, { dish_id: dishId });
    await reload();
  });

export const addByTitle = (title: string) =>
  guard(async () => {
    if (!app.plan) throw new Error("Bitte zuerst einen Zeitraum anlegen.");
    await api.addEntry(app.plan.id, { title });
    await reload();
  });

export async function toggleDone(entry: Entry) {
  const next = !entry.done;
  entry.done = next; // optimistic
  const ok = await guard(async () => {
    await api.setDone(entry.id, next);
    await refreshPlans();
  });
  if (!ok) entry.done = !next;
}

export const removeEntry = (id: number) =>
  guard(async () => {
    await api.deleteEntry(id);
    await reload();
    closeSheet();
  });

// entry: the list note, when the sheet was opened from a list entry and the note changed.
export const saveDish = (
  dishId: number | null,
  input: DishInput,
  addToPlan: boolean,
  entry?: { id: number; note: string | null },
) =>
  guard(async () => {
    if (dishId === null) {
      const d = await api.createDish(input);
      if (addToPlan && app.plan) await api.addEntry(app.plan.id, { dish_id: d.id });
    } else {
      await api.updateDish(dishId, input);
      if (entry) await api.setEntryNote(entry.id, entry.note);
    }
    await reload();
    closeSheet();
  });

export const deleteDish = (id: number) =>
  guard(async () => {
    await api.deleteDish(id);
    await reload();
    closeSheet();
  });
