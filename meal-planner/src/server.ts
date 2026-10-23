import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createHaApi, loadOrCreateToken } from "./ha-api.ts";
import { announceToHomeAssistant } from "./ha-discovery.ts";
import { createHaAi } from "./ha-ai.ts";
import { createHaNotify } from "./ha-notify.ts";
import { createHaTodo } from "./ha-todo.ts";
import { ImageStore } from "./images.ts";
import { logger, resolveLogLevel, setLogLevel } from "./log.ts";
import { aiEntities, readAddonOptions } from "./options.ts";
import { createPreviewService } from "./preview.ts";
import { createRepo } from "./repo.ts";

// The add-on's options (Supervisor writes /data/options.json); changing one needs a restart of the add-on.
// `log_level` beats LOG_LEVEL, else info.
const log = logger("server");
const options = readAddonOptions(process.env.OPTIONS_PATH ?? "/data/options.json");
const { level: logLevel, invalid: invalidLevel } = resolveLogLevel(options, process.env.LOG_LEVEL);
const aiEntity = aiEntities(options);
setLogLevel(logLevel);
if (invalidLevel) log.warn("invalid_log_level", { value: invalidLevel, using: logLevel });
const version = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
})();
log.info("starting", {
  version,
  log_level: logLevel,
  ai_entity_recipe: aiEntity.recipe,
  ai_entity_titles: aiEntity.titles,
  ai_entity_image: aiEntity.image,
  tz: process.env.TZ,
  node: process.version,
});

// In the HA add-on this is /data/meal-planner.db (and /data/images next to it).
const dbPath = process.env.DB_PATH ?? "./data/meal-planner.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const repo = createRepo(openDb(dbPath));
const images = new ImageStore(process.env.IMAGE_DIR ?? join(dbPath === ":memory:" ? "." : dirname(dbPath), "images"));
void images.sweep(repo.listImages()); // drop leftovers from previews that were never saved

// Only inside the add-on: the Supervisor injects SUPERVISOR_TOKEN (needs homeassistant_api / discovery in config.yaml).
const supervisorToken = process.env.SUPERVISOR_TOKEN ?? null;
const haNotify = createHaNotify(supervisorToken);

const app = createApp(repo, {
  allowedIp: process.env.INGRESS_ONLY_IP,
  images,
  preview: createPreviewService({ images }),
  notify: haNotify,
  ai: createHaAi(supervisorToken, aiEntity),
  todo: createHaTodo(supervisorToken),
});
// API routes are registered first; anything else is the built frontend (npm run build).
app.use("/*", serveStatic({ root: "./dist" }));
const port = Number(process.env.PORT ?? 8099);
serve({ fetch: app.fetch, port }, (i) => log.info("listening", { port: i.port }));

// Second, read-only listener for the Home Assistant integration (token-protected, one route).
// Only started where HA_API_PORT is set (the Dockerfile does); the token sits next to the database.
const haPort = process.env.HA_API_PORT ? Number(process.env.HA_API_PORT) : null;
if (haPort) {
  const apiToken = loadOrCreateToken(join(dirname(dbPath), "ha-token"));
  serve({ fetch: createHaApi(repo, apiToken).fetch, port: haPort }, (i) => {
    log.info("ha_api_listening", { port: i.port });
    if (supervisorToken) void announceToHomeAssistant({ supervisorToken, port: i.port, apiToken });
  });
}
