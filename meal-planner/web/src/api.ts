import type { Dish, DishInput, Entry, PlanDetail, AiStatus, CheckState, CookEntry, PlanSummary, Preview, Recipe, RecipeDraft } from "./types";

// All URLs are resolved against the document URL (never "/api/..."), so the app
// keeps working under the HA ingress prefix.
const MESSAGES: Record<string, string> = {
  "dish title exists": "Ein Gericht mit diesem Titel gibt es schon.",
  "dish already in plan": "Steht schon in der Liste.",
  "dish is used in a plan": "Das Gericht steht noch in einer Liste und kann nicht gelöscht werden.",
  "plan overlaps": "Der Zeitraum überschneidet sich mit einer anderen Liste.",
  "ai failed": "Die Zutaten konnten nicht erkannt werden. Bitte von Hand eintragen.",
  busy: "Gerade beschäftigt. Bitte gleich noch einmal versuchen.",
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(path, document.baseURI), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Server nicht erreichbar.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (typeof data?.error === "string" && MESSAGES[data.error]) throw new Error(MESSAGES[data.error]!);
    if (res.status === 400) throw new Error("Eingabe ungültig. Bitte Titel, Link und Datum prüfen.");
    if (res.status === 404) throw new Error("Eintrag nicht gefunden. Bitte neu laden.");
    throw new Error("Unerwarteter Fehler.");
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listDishes = () => request<Dish[]>("GET", "api/dishes");
// Dishes with an ingredient whose name contains `text` (case-insensitive).
export const listDishesWithIngredient = (text: string) =>
  request<Dish[]>("GET", `api/dishes?ingredient=${encodeURIComponent(text)}`);
export const createDish = (d: DishInput) => request<Dish>("POST", "api/dishes", d);
export const updateDish = (id: number, d: DishInput) => request<Dish>("PATCH", `api/dishes/${id}`, d);
export const deleteDish = (id: number) => request<void>("DELETE", `api/dishes/${id}`);

export const getRecipe = (dishId: number) => request<Recipe>("GET", `api/dishes/${dishId}/recipe`);
// Replaces the whole recipe. An empty one (no servings, steps or ingredients) removes it.
export const putRecipe = (dishId: number, r: Pick<Recipe, "servings" | "instructions"> & { ingredients: (Omit<Recipe["ingredients"][number], "raw"> & { raw?: string | null })[] }) =>
  request<Recipe>("PUT", `api/dishes/${dishId}/recipe`, r);

// "Get the recipe from the link": the server fetches the dish's link again. Nothing found -> { reason }.
export const fetchSource = (dishId: number) => request<Recipe | { reason: string }>("POST", `api/dishes/${dishId}/source`);

// Is an AI task entity set up in Home Assistant? Decides whether "Zutaten erkennen" is offered.
export const getRecipeStatus = () => request<AiStatus>("GET", "api/recipe/status");
// Splits the saved original text into a draft (nothing is stored). Takes a few seconds.
export const draftRecipe = (dishId: number) => request<RecipeDraft>("POST", `api/dishes/${dishId}/recipe/draft`);

// Cook mode: all recipes of a plan once, then only the ticks and done flags (polled).
export const getCook = (planId: number) => request<{ plan_id: number; entries: CookEntry[] }>("GET", `api/plans/${planId}/cook`);
export const getChecks = (planId: number) => request<{ entries: CheckState[] }>("GET", `api/plans/${planId}/checks`);
// Sets or removes a tick (never toggles, so two phones cannot undo each other).
export const putCheck = (entryId: number, kind: "ingredient" | "step", idx: number, checked: boolean) =>
  request<unknown>("PUT", `api/entries/${entryId}/checks`, { kind, idx, checked });

export const listPlans = () => request<PlanSummary[]>("GET", "api/plans");
export const getPlan = (id: number) => request<PlanDetail>("GET", `api/plans/${id}`);
export const createPlan = (p: { start_date: string; end_date: string }) => request<PlanSummary>("POST", "api/plans", p);
// title null clears the name. The period is always sent as a whole (both dates).
export const updatePlan = (id: number, p: { title: string | null; start_date: string; end_date: string }) =>
  request<unknown>("PATCH", `api/plans/${id}`, p);
export const deletePlan = (id: number) => request<void>("DELETE", `api/plans/${id}`);

export const addEntry = (planId: number, e: { dish_id: number } | { title: string }) =>
  request<Entry>("POST", `api/plans/${planId}/entries`, e);
export const setDone = (id: number, done: boolean) => request<Entry>("PATCH", `api/entries/${id}`, { done });
// null clears the note. It belongs to this list entry only (the dish note is separate).
export const setEntryNote = (id: number, note: string | null) => request<Entry>("PATCH", `api/entries/${id}`, { note });
export const deleteEntry = (id: number) => request<void>("DELETE", `api/entries/${id}`);

// The server fetches the page (never the browser: CORS, and the link must not be opened from the phone).
export const previewUrl = (url: string) => request<Preview>("POST", "api/preview", { url });
// Up to two title candidates from the AI for a link preview (takes a few seconds, 502 when the AI fails).
// The browser language tells the server which language the titles should be in.
export const suggestTitles = (b: { title: string; text: string }) =>
  request<{ titles: string[] }>("POST", "api/title-suggestions", { ...b, lang: navigator.language });
// Relative like every other URL, so it works under the ingress prefix.
export const imageSrc = (name: string) => `api/images/${name}`;
