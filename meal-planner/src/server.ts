import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { ImageStore } from "./images.ts";
import { createPreviewService } from "./preview.ts";
import { createRepo } from "./repo.ts";

// In the HA add-on this is /data/meal-planner.db (and /data/images next to it).
const dbPath = process.env.DB_PATH ?? "./data/meal-planner.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const repo = createRepo(openDb(dbPath));
const images = new ImageStore(process.env.IMAGE_DIR ?? join(dbPath === ":memory:" ? "." : dirname(dbPath), "images"));
void images.sweep(repo.listImages()); // drop leftovers from previews that were never saved

const app = createApp(repo, {
  allowedIp: process.env.INGRESS_ONLY_IP,
  images,
  preview: createPreviewService({ images }),
});
// API routes are registered first; anything else is the built frontend (npm run build).
app.use("/*", serveStatic({ root: "./dist" }));
const port = Number(process.env.PORT ?? 8099);
serve({ fetch: app.fetch, port }, (i) => console.log(`meal-planner listening on :${i.port}`));
