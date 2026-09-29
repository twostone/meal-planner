export type HaEventType = "plan_created" | "entry_added" | "entry_removed" | "entry_done" | "entry_undone";
// Any field is null when Ingress did not send it (unknown session, or unset on the HA user).
export type HaUser = { id: string; name: string | null; display_name: string | null };
export type HaEventInput = {
  type: HaEventType;
  plan: { id: number; start_date: string; end_date: string };
  entry?: { id: number; dish_id: number; title: string };
  user: HaUser | null;
};

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
      .then(() => post(`${baseUrl}meal_planner_${type}`, token, data))
      .catch((e) => console.error("[ha-notify] event failed:", e instanceof Error ? e.message : e));
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
