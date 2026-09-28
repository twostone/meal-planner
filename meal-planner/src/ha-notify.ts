import type { Repo } from "./repo.ts";

export type HaEvent = "plan_created" | "entry_added" | null;

// Flattened per-entry shape for the HA payload: the companion integration/card renders this
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
  entry_count: number;
  done_count: number;
  entries: HaEntry[];
};

const TIMEOUT_MS = 5000;

// Pushes the current plan to a Home Assistant webhook so a companion HA integration can show it
// on a dashboard and fire events for "new plan" / "new entry". Deliberately plain fetch, not
// fetchLimited/net-guard: that module exists to sandbox user-supplied recipe links against this
// add-on's own LAN (SSRF protection). The webhook URL here is admin-configured (from the add-on's
// options, never user input) and is expected to point at Home Assistant itself, i.e. onto the LAN
// that fetchLimited would refuse to reach. Never route this through fetchLimited.
export function createHaNotify(repo: Repo, webhookUrl: string | null) {
  // Chains pushes so concurrent mutations still reach HA in the order they happened, even though
  // each call is fire-and-forget relative to the HTTP request that triggered it.
  let chain: Promise<unknown> = Promise.resolve();

  return function notify(event: HaEvent): Promise<void> {
    if (!webhookUrl) return Promise.resolve();
    const payload = { event, plan: snapshot(repo) };
    chain = chain
      .then(() => post(webhookUrl, payload))
      .catch((e) => console.error("[ha-notify] push failed:", e instanceof Error ? e.message : e));
    return Promise.resolve();
  };
}

// Always the *current* plan (repo.getCurrentPlan()), independent of which plan the triggering
// mutation actually touched — e.g. creating a future plan still pushes today's plan as `plan`.
function snapshot(repo: Repo): HaPlan | null {
  const plan = repo.getCurrentPlan();
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
    entry_count: entries.length,
    done_count: entries.filter((e) => e.done).length,
    entries,
  };
}

async function post(url: string, body: unknown): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`ha webhook responded ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}
