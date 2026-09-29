export const SUPERVISOR_URL = "http://supervisor";

type Opts = {
  supervisorUrl?: string;
  supervisorToken: string;
  port: number;
  apiToken: string;
  retries?: number; // attempts after the first one
  delayMs?: number; // first backoff, doubles each time
};

const call = (url: string, token: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5000),
  });

// Tells Home Assistant (via the Supervisor's discovery) where to fetch the state and with which token.
// Sent on every start; the Supervisor de-duplicates identical messages. Core may still be starting, so
// this retries with backoff. It never throws: a failed announcement only means the integration has to
// be set up by hand (host, port, token).
export async function announceToHomeAssistant(o: Opts): Promise<boolean> {
  const base = o.supervisorUrl ?? SUPERVISOR_URL;
  const retries = o.retries ?? 6;
  let delay = o.delayMs ?? 5000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const info = await call(`${base}/addons/self/info`, o.supervisorToken);
      if (!info.ok) throw new Error(`addon info responded ${info.status}`);
      const host = ((await info.json()) as { data?: { hostname?: string } }).data?.hostname;
      if (!host) throw new Error("addon info has no hostname");
      const res = await call(`${base}/discovery`, o.supervisorToken, {
        method: "POST",
        body: JSON.stringify({ service: "meal_planner", config: { host, port: o.port, token: o.apiToken } }),
      });
      if (!res.ok) throw new Error(`discovery responded ${res.status}`);
      return true;
    } catch (e) {
      console.error("[ha-discovery] failed:", e instanceof Error ? e.message : e);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }
  return false;
}
