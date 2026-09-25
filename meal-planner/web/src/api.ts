import type { Dish, DishInput, Entry, PlanDetail, PlanSummary, Preview } from "./types";

// All URLs are resolved against the document URL (never "/api/..."), so the app
// keeps working under the HA ingress prefix.
const MESSAGES: Record<string, string> = {
  "dish title exists": "Ein Gericht mit diesem Titel gibt es schon.",
  "dish already in plan": "Steht schon in der Liste.",
  "dish is used in a plan": "Das Gericht steht noch in einer Liste und kann nicht gelöscht werden.",
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
export const createDish = (d: DishInput) => request<Dish>("POST", "api/dishes", d);
export const updateDish = (id: number, d: DishInput) => request<Dish>("PATCH", `api/dishes/${id}`, d);
export const deleteDish = (id: number) => request<void>("DELETE", `api/dishes/${id}`);

export const listPlans = () => request<PlanSummary[]>("GET", "api/plans");
export const getPlan = (id: number) => request<PlanDetail>("GET", `api/plans/${id}`);
export const createPlan = (p: { start_date: string; end_date: string }) => request<PlanSummary>("POST", "api/plans", p);
export const deletePlan = (id: number) => request<void>("DELETE", `api/plans/${id}`);

export const addEntry = (planId: number, e: { dish_id: number } | { title: string }) =>
  request<Entry>("POST", `api/plans/${planId}/entries`, e);
export const setDone = (id: number, done: boolean) => request<Entry>("PATCH", `api/entries/${id}`, { done });
export const deleteEntry = (id: number) => request<void>("DELETE", `api/entries/${id}`);

// The server fetches the page (never the browser: CORS, and the link must not be opened from the phone).
export const previewUrl = (url: string) => request<Preview>("POST", "api/preview", { url });
// Relative like every other URL, so it works under the ingress prefix.
export const imageSrc = (name: string) => `api/images/${name}`;
