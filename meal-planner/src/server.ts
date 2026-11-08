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
import { aiEntities, mcpSettings, readAddonOptions } from "./options.ts";
import { createHaTokenVerifier, DEFAULT_HA_WS_URL } from "./auth/ha-token.ts";
import { fetchHaExternalUrl } from "./auth/ha-url.ts";
import { createMcpEndpoint } from "./mcp.ts";
import { createMcpListener } from "./mcp-listener.ts";
import { createPreviewService } from "./preview.ts";
import { createRepo } from "./repo.ts";
import { installShutdownHandlers } from "./shutdown.ts";

// The add-on's options (Supervisor writes /data/options.json); changing one needs a restart of the add-on.
// `log_level` beats LOG_LEVEL, else info.
const log = logger("server");
const options = readAddonOptions(process.env.OPTIONS_PATH ?? "/data/options.json");
const { level: logLevel, invalid: invalidLevel } = resolveLogLevel(options, process.env.LOG_LEVEL);
const aiEntity = aiEntities(options);
const mcp = mcpSettings(options);
setLogLevel(logLevel);
if (invalidLevel) log.warn("invalid_log_level", { value: invalidLevel, using: logLevel });
for (const name of mcp.invalid) log.warn("invalid_option", { option: name });
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
  mcp_host: mcp.appUrl ? new URL(mcp.appUrl).host : undefined,
  tz: process.env.TZ,
  node: process.version,
});

// In the HA add-on this is /data/meal-planner.db (and /data/images next to it).
const dbPath = process.env.DB_PATH ?? "./data/meal-planner.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const repo = createRepo(db);
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
const servers = [serve({ fetch: app.fetch, port }, (i) => log.info("listening", { port: i.port }))];

// Second, read-only listener for the Home Assistant integration (token-protected, one route).
// Only started where HA_API_PORT is set (the Dockerfile does); the token sits next to the database.
const haPort = process.env.HA_API_PORT ? Number(process.env.HA_API_PORT) : null;
if (haPort) {
  const apiToken = loadOrCreateToken(join(dirname(dbPath), "ha-token"));
  const haServer = serve({ fetch: createHaApi(repo, apiToken).fetch, port: haPort }, (i) => {
    log.info("ha_api_listening", { port: i.port });
    if (supervisorToken) void announceToHomeAssistant({ supervisorToken, port: i.port, apiToken });
  });
  servers.push(haServer);
}

// Third, optional listener: the MCP server for AI assistants, reached from outside through the user's reverse proxy.
// Needs the port (the Dockerfile sets MCP_PORT), the option `mcp_app_url` and the public URL of Home Assistant (option
// `mcp_ha_url`, else Home Assistant's own external URL). Without any of them it does not start at all.
const mcpPort = process.env.MCP_PORT ? Number(process.env.MCP_PORT) : null;
if (mcpPort && mcp.appUrl) {
  const appUrl = mcp.appUrl;
  void (async () => {
    const haUrl = mcp.haUrl ?? (await fetchHaExternalUrl(supervisorToken));
    if (!haUrl) {
      log.warn("mcp_disabled", { reason: "no public Home Assistant URL (option mcp_ha_url or external URL in Home Assistant)" });
      return;
    }
    const listener = createMcpListener({
      appUrl,
      haUrl,
      verifier: createHaTokenVerifier({ wsUrl: process.env.HA_WS_URL ?? DEFAULT_HA_WS_URL }),
      mcp: createMcpEndpoint({ repo, notify: haNotify, version }),
    });
    servers.push(serve({ fetch: listener.fetch, port: mcpPort }, (i) => log.info("mcp_listening", { port: i.port, ha_host: new URL(haUrl).host })));
  })();
}

// SIGTERM from `docker stop` / the Supervisor: stop accepting requests, close the database, exit 0 (not "error").
installShutdownHandlers({ servers, cleanup: () => db.close() });
