import { readFileSync } from "node:fs";

// The add-on's options as the Supervisor writes them to /data/options.json. Read once at start: a change needs a restart.
// No file (development, tests) or broken JSON -> {}, so every option falls back to its default.
export type AddonOptions = Record<string, unknown>;
export function readAddonOptions(path: string): AddonOptions {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AddonOptions) : {};
  } catch {
    return {}; // no options file outside the add-on
  }
}

// AI task entity per task (`ai_entity_recipe`, `ai_entity_titles`, `ai_entity_image`); null = Home Assistant's preferred entity.
// The format is checked by the schema in config.yaml; a wrong id shows up in the AI status as `no_entity`.
export type AiEntities = { recipe: string | null; titles: string | null; image: string | null };
export function aiEntities(options: AddonOptions): AiEntities {
  const entity = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    recipe: entity(options.ai_entity_recipe),
    titles: entity(options.ai_entity_titles),
    image: entity(options.ai_entity_image),
  };
}

// MCP server (optional): public URL of the app's MCP listener (behind the user's TLS reverse proxy) and of Home Assistant,
// which signs MCP clients in (OAuth). Unset `mcp_app_url` = no MCP listener at all.
export type McpSettings = {
  /** Public base URL of the MCP listener, no trailing slash. */
  appUrl: string | null;
  /** Public base URL of Home Assistant, no trailing slash; null = ask Home Assistant for its external URL at start. */
  haUrl: string | null;
  /** Names of options that were set but unusable; logged by the caller. */
  invalid: string[];
};

// A public base URL: http(s) only, no credentials, query or fragment. A trailing slash must not matter.
export function parsePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function mcpSettings(options: AddonOptions): McpSettings {
  const invalid: string[] = [];
  const url = (name: string) => {
    const raw = options[name];
    if (raw === undefined || raw === null || raw === "") return null;
    const parsed = parsePublicUrl(raw);
    if (!parsed) invalid.push(name);
    return parsed;
  };
  return { appUrl: url("mcp_app_url"), haUrl: url("mcp_ha_url"), invalid };
}
