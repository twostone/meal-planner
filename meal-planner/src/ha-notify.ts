import { logger } from "./log.ts";
import type { Entry, Plan } from "./repo.ts";

const log = logger("ha-notify");

export type HaEventType = "plan_created" | "plan_updated" | "entry_added" | "entry_removed" | "entry_done" | "entry_undone";
// Any field is null when Ingress did not send it (unknown session, or unset on the HA user).
export type HaUser = { id: string; name: string | null; display_name: string | null };
export type HaEventInput = {
  type: HaEventType;
  // plan_updated also carries the (new) title; the other plan events do not.
  plan: { id: number; start_date: string; end_date: string; title?: string | null };
  // plan_updated only: what the plan looked like before the change.
  previous?: { start_date: string; end_date: string; title: string | null };
  entry?: { id: number; dish_id: number; title: string };
  user: HaUser | null;
};

export type EntryEventType = "entry_added" | "entry_removed" | "entry_done" | "entry_undone";

// The event payloads, shared by the Ingress API (app.ts) and the MCP tools (mcp.ts) so both report changes alike.
export function entryEvent(type: EntryEventType, plan: Plan, e: Entry, user: HaUser | null): HaEventInput {
  return { type, plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date }, entry: { id: e.id, dish_id: e.dish_id, title: e.dish.title }, user };
}

// Only a real change is an event: saving unchanged must not wake any automation. null = nothing changed.
export function planUpdatedEvent(before: Plan, plan: Plan, user: HaUser | null): HaEventInput | null {
  if (plan.title === before.title && plan.start_date === before.start_date && plan.end_date === before.end_date) return null;
  return {
    type: "plan_updated",
    plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date, title: plan.title },
    previous: { start_date: before.start_date, end_date: before.end_date, title: before.title },
    user,
  };
}

export const SUPERVISOR_EVENTS_URL = "http://supervisor/core/api/events/";
const TIMEOUT_MS = 5000;

// Fires a Home Assistant bus event through the Supervisor's Core proxy (needs `homeassistant_api: true`).
// Deliberately plain fetch, not fetchLimited/net-guard: that module sandboxes user-supplied recipe links
// against this add-on's own LAN (SSRF protection). The target here is the Supervisor, fixed in code, never
// user input. Never route this through fetchLimited.
// `token` null (dev, tests) -> disabled. `baseUrl` is only overridden by tests.
export function createHaNotify(token: string | null, baseUrl = SUPERVISOR_EVENTS_URL) {
  // Chains events so concurrent mutations still reach HA in the order they happened, even though
  // each call is fire-and-forget relative to the HTTP request that triggered it.
  let chain: Promise<unknown> = Promise.resolve();

  return function notify(ev: HaEventInput): Promise<void> {
    if (!token) return Promise.resolve();
    const { type, ...data } = ev;
    chain = chain
      .then(async () => {
        await post(`${baseUrl}meal_planner_${type}`, token, data);
        log.debug("event_sent", { type });
      })
      .catch((e) => log.warn("event_failed", { type, err: e }));
    return Promise.resolve();
  };
}

async function post(url: string, token: string, body: unknown): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`supervisor responded ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}
