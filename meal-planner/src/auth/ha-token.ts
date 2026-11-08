import { createHash } from "node:crypto";
import { logger } from "../log.ts";

const log = logger("ha-token");

// Validates a Home Assistant access token the only way HA offers: authenticate a WebSocket with it and ask
// `auth/current_user`. There is no REST endpoint for that. Any valid token is accepted, including long-lived access
// tokens; HA tokens carry no audience, so this cannot be narrowed to "tokens issued for this app" (documented in the README).
// Taken over from twostone/garmin-insights (same check, same caveats); no library does this for Home Assistant.

export const DEFAULT_HA_WS_URL = "ws://homeassistant:8123/api/websocket";
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 500;

// The Home Assistant user behind a token: id and display name (HA's `name`), as the bus events need them.
export type TokenUser = { id: string; name: string | null };
export type VerifiedToken = { user: TokenUser; isAdmin: boolean; /** Seconds since epoch, from the JWT. */ expiresAt: number };

/** Home Assistant could not be asked (down, timeout). Callers must fail closed: this is not "token invalid". */
export class HaUnavailableError extends Error {}

/** null = the token is not valid (or belongs to a system user). */
export type HaTokenVerifier = (token: string) => Promise<VerifiedToken | null>;

// exp claim of a JWT without verifying the signature: HA does that. Only used to cap the cache and to reject the
// obviously expired without a round trip. null when the token is not a JWT with a numeric exp.
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

type CurrentUser = { id?: unknown; name?: unknown; is_admin?: unknown; credentials?: unknown };

type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
};

export type HaTokenVerifierOptions = {
  wsUrl?: string;
  timeoutMs?: number;
  /** Tests inject a clock and a socket factory. */
  now?: () => number;
  createSocket?: (url: string) => SocketLike;
};

function askHa(token: string, url: string, timeoutMs: number, createSocket: (url: string) => SocketLike): Promise<CurrentUser | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: SocketLike | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new HaUnavailableError("timeout"))), timeoutMs);
    try {
      ws = createSocket(url);
    } catch {
      return done(() => reject(new HaUnavailableError("connect")));
    }
    ws.onerror = () => done(() => reject(new HaUnavailableError("socket")));
    ws.onclose = () => done(() => reject(new HaUnavailableError("closed")));
    ws.onmessage = (ev) => {
      let msg: { type?: string; id?: number; success?: boolean; result?: CurrentUser };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "auth_required") ws?.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (msg.type === "auth_ok") ws?.send(JSON.stringify({ id: 1, type: "auth/current_user" }));
      else if (msg.type === "auth_invalid") done(() => resolve(null));
      else if (msg.type === "result" && msg.id === 1) done(() => resolve(msg.success && msg.result ? msg.result : null));
    };
  });
}

export function createHaTokenVerifier(opts: HaTokenVerifierOptions = {}): HaTokenVerifier {
  const wsUrl = opts.wsUrl ?? DEFAULT_HA_WS_URL;
  const timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  // Keyed by a hash so the cache never holds tokens.
  const cache = new Map<string, { until: number; value: VerifiedToken | null }>();
  const inflight = new Map<string, Promise<VerifiedToken | null>>();

  const remember = (key: string, value: VerifiedToken | null, ttl: number) => {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    cache.set(key, { until: now() + ttl, value });
  };

  async function lookup(token: string, key: string, expiresAt: number): Promise<VerifiedToken | null> {
    const raw = await askHa(token, wsUrl, timeoutMs, createSocket);
    const id = typeof raw?.id === "string" ? raw.id : null;
    // System users (Supervisor, other apps) have no login credentials; real users, also behind a long-lived token, do.
    const isSystem = !Array.isArray(raw?.credentials) || raw.credentials.length === 0;
    if (!raw || !id || isSystem) {
      if (raw && id) log.warn("system_user_refused");
      remember(key, null, NEGATIVE_TTL_MS);
      return null;
    }
    const value: VerifiedToken = {
      user: { id, name: typeof raw.name === "string" ? raw.name : null },
      isAdmin: raw.is_admin === true,
      expiresAt,
    };
    remember(key, value, Math.min(POSITIVE_TTL_MS, expiresAt * 1000 - now()));
    return value;
  }

  return async (token) => {
    const expiresAt = jwtExpiry(token);
    if (expiresAt === null || expiresAt * 1000 <= now()) return null;
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    let pending = inflight.get(key);
    if (!pending) {
      pending = lookup(token, key, expiresAt).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (e) {
      if (e instanceof HaUnavailableError) log.warn("ha_unavailable", { reason: e.message });
      throw e;
    }
  };
}
