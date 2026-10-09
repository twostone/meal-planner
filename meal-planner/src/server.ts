import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createHaApi, loadOrCreateToken } from "./ha-api.ts";
import { announceToHomeAssistant } from "./ha-discovery.ts";
import { createHaAi } from "./ha-ai.ts";
import { createHaNotify } from "./ha-notify.ts";
import { ImageStore } from "./images.ts";
import { createPreviewService } from "./preview.ts";
import { createRepo } from "./repo.ts";

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
  ai: createHaAi(supervisorToken),
});
// API routes are registered first; anything else is the built frontend (npm run build).
app.use("/*", serveStatic({ root: "./dist" }));
const port = Number(process.env.PORT ?? 8099);
serve({ fetch: app.fetch, port }, (i) => console.log(`meal-planner listening on :${i.port}`));

// Second, read-only listener for the Home Assistant integration (token-protected, one route).
// Only started where HA_API_PORT is set (the Dockerfile does); the token sits next to the database.
const haPort = process.env.HA_API_PORT ? Number(process.env.HA_API_PORT) : null;
if (haPort) {
  const apiToken = loadOrCreateToken(join(dirname(dbPath), "ha-token"));
  serve({ fetch: createHaApi(repo, apiToken).fetch, port: haPort }, (i) => {
    console.log(`meal-planner HA state on :${i.port}`);
    if (supervisorToken) void announceToHomeAssistant({ supervisorToken, port: i.port, apiToken });
  });
}
