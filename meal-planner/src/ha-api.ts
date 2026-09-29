import { Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { haState } from "./ha-state.ts";
import type { Repo } from "./repo.ts";

// The token lives in /data (survives updates). To rotate it: delete the file and restart the add-on;
// the new token reaches the integration through the discovery message.
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(path, t + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

// Second listener, read-only, for the Home Assistant integration: exactly one route, Bearer token.
// Not behind the Ingress guard (Core is not the Supervisor's Ingress proxy), and it never reads the
// X-Remote-User-* headers or fires events: there is no user here. Everything else is a plain 404.
export function createHaApi(repo: Repo, token: string, now: () => Date = () => new Date()) {
  const app = new Hono();
  const expected = digest(token);
  app.get("/ha/state", (c) => {
    const given = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? "";
    // Compare fixed-length digests so the comparison is constant-time whatever the input length.
    if (!timingSafeEqual(digest(given), expected)) return c.json({ error: "unauthorized" }, 401);
    return c.json(haState(repo, now()));
  });
  return app;
}
