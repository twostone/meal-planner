import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createRepo } from "./repo.ts";

// In the HA add-on this will be /data/meal-planner.db.
const dbPath = process.env.DB_PATH ?? "./data/meal-planner.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const app = createApp(createRepo(openDb(dbPath)), { allowedIp: process.env.INGRESS_ONLY_IP });
// API routes are registered first; anything else is the built frontend (npm run build).
app.use("/*", serveStatic({ root: "./dist" }));
const port = Number(process.env.PORT ?? 8099);
serve({ fetch: app.fetch, port }, (i) => console.log(`meal-planner listening on :${i.port}`));
