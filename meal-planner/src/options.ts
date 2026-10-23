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
