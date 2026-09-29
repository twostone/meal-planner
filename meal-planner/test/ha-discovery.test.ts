import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { announceToHomeAssistant } from "../src/ha-discovery.ts";

async function withSupervisor(
  handler: (req: http.IncomingMessage, body: string, n: number) => { status: number; json?: unknown },
  fn: (base: string, calls: { url: string; auth?: string; body: string }[]) => Promise<void>,
) {
  const calls: { url: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      calls.push({ url: req.url!, auth: req.headers.authorization, body: data });
      const r = handler(req, data, calls.length);
      res.writeHead(r.status, { "Content-Type": "application/json" }).end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("announces hostname, port and token as the meal_planner service", async () => {
  await withSupervisor(
    (req) => (req.url === "/addons/self/info" ? { status: 200, json: { data: { hostname: "abc-essensplanung" } } } : { status: 200 }),
    async (base, calls) => {
      const ok = await announceToHomeAssistant({ supervisorUrl: base, supervisorToken: "sv", port: 8100, apiToken: "tk", delayMs: 1 });
      assert.equal(ok, true);
      assert.deepEqual(calls.map((c) => c.url), ["/addons/self/info", "/discovery"]);
      assert.ok(calls.every((c) => c.auth === "Bearer sv"));
      assert.deepEqual(JSON.parse(calls[1]!.body), {
        service: "meal_planner",
        config: { host: "abc-essensplanung", port: 8100, token: "tk" },
      });
    },
  );
});

test("retries while the supervisor refuses, then succeeds", async () => {
  await withSupervisor(
    (req, _b, n) =>
      req.url === "/addons/self/info"
        ? { status: 200, json: { data: { hostname: "h" } } }
        : { status: n < 4 ? 500 : 200 },
    async (base) => {
      const ok = await announceToHomeAssistant({ supervisorUrl: base, supervisorToken: "sv", port: 1, apiToken: "t", retries: 3, delayMs: 1 });
      assert.equal(ok, true);
    },
  );
});

test("gives up quietly (no throw) after the retries", async () => {
  await withSupervisor(
    () => ({ status: 403 }),
    async (base, calls) => {
      const ok = await announceToHomeAssistant({ supervisorUrl: base, supervisorToken: "sv", port: 1, apiToken: "t", retries: 2, delayMs: 1 });
      assert.equal(ok, false);
      assert.equal(calls.length, 3);
    },
  );
});
