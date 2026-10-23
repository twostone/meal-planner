import { clip } from "./text.ts";

// Calls to Home Assistant's REST API through the Supervisor's Core proxy (needs `homeassistant_api: true`), shared by
// ha-ai.ts and ha-todo.ts. Deliberately plain fetch and not fetchLimited: the target is fixed in code and never user
// input, and it lies in the internal network that net-guard.ts rightly blocks for recipe links.

export const SUPERVISOR_CORE_URL = "http://supervisor/core/api/";
// Core itself in the Supervisor network, for the one path outside /api/ (the signed URL of a generated image, see
// ha-ai.ts). Same reasoning as above: fixed in code, internal network.
export const CORE_DIRECT_URL = "http://homeassistant:8123";
const ERROR_BODY_MAX = 300;
const ERROR_BODY_WAIT_MS = 2000;

export async function request(path: string, init: RequestInit, token: string, baseUrl: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// The reason Home Assistant gives for an error ("Data should be valid JSON.", a validation message) for the log line,
// or undefined when there is none (the field is then left out). At most 300 characters and never waiting longer than
// 2 s: it is only a hint.
export async function errorBody(res: Response): Promise<string | undefined> {
  try {
    const wait = new Promise<string>((done) => setTimeout(() => done(""), ERROR_BODY_WAIT_MS).unref());
    const text = (await Promise.race([res.text(), wait])).replace(/\s+/g, " ").trim();
    return text ? clip(text, ERROR_BODY_MAX) : undefined;
  } catch {
    return undefined;
  }
}

export const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
