import { logger } from "../log.ts";
import { errorBody, request, SUPERVISOR_CORE_URL } from "../ha-core.ts";
import { parsePublicUrl } from "../options.ts";

const log = logger("ha-url");
const LOOKUP_TIMEOUT_MS = 5_000;

// Public URL of Home Assistant from Settings -> System -> Network (`external_url` of GET /api/config, through the
// Supervisor's Core proxy). null when there is none (e.g. only Home Assistant Cloud), no token, or HA is unreachable.
// Never throws: without it the MCP listener just stays off.
export async function fetchHaExternalUrl(token: string | null, baseUrl = SUPERVISOR_CORE_URL): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await request("config", {}, token, baseUrl, LOOKUP_TIMEOUT_MS);
    if (!res.ok) {
      log.warn("ha_config_failed", { status: res.status, body: await errorBody(res) });
      return null;
    }
    return parsePublicUrl(((await res.json()) as { external_url?: unknown }).external_url);
  } catch (err) {
    log.warn("ha_config_failed", { reason: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}
