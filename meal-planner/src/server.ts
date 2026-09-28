import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
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

// No bashio/s6 in this image (see Dockerfile), so the Supervisor's add-on options are read
// straight from /data/options.json rather than via env vars it would otherwise export.
function readHaWebhookUrl(): string | null {
  try {
    const raw = JSON.parse(readFileSync("/data/options.json", "utf8"));
    const url = typeof raw.ha_webhook_url === "string" ? raw.ha_webhook_url.trim() : "";
    return url || null;
  } catch {
    return null; // outside the add-on (dev, tests): no options file -> feature off
  }
}
const haNotify = createHaNotify(repo, readHaWebhookUrl());

const app = createApp(repo, {
  allowedIp: process.env.INGRESS_ONLY_IP,
  images,
  preview: createPreviewService({ images }),
  notify: haNotify,
});
// API routes are registered first; anything else is the built frontend (npm run build).
app.use("/*", serveStatic({ root: "./dist" }));
const port = Number(process.env.PORT ?? 8099);
serve({ fetch: app.fetch, port }, (i) => {
  console.log(`meal-planner listening on :${i.port}`);
  void haNotify(null); // prime HA with the current state on every (re)start, not just on the next mutation
});
