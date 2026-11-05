import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { gracefulShutdown } from "../src/shutdown.ts";

function listening() {
  const server = createServer((_req, res) => res.end("ok"));
  return new Promise<typeof server>((resolve) => server.listen(0, () => resolve(server)));
}

test("closes servers, runs cleanup once and exits 0", async () => {
  const server = await listening();
  const exits: number[] = [];
  let cleanups = 0;
  const shutdown = gracefulShutdown({ servers: [server], cleanup: () => void cleanups++, exit: (c) => void exits.push(c) });
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM")]); // a second signal must not run it twice
  assert.equal(server.listening, false);
  assert.equal(cleanups, 1);
  assert.deepEqual(exits, [0]);
});

test("a failing cleanup exits 1", async () => {
  const server = await listening();
  const exits: number[] = [];
  const shutdown = gracefulShutdown({
    servers: [server],
    cleanup: () => {
      throw new Error("boom");
    },
    exit: (c) => void exits.push(c),
  });
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [1]);
});

test("an open keep-alive connection does not block the shutdown", async () => {
  const server = await listening();
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "keep-alive" } });
  await res.text();
  const exits: number[] = [];
  await gracefulShutdown({ servers: [server], exit: (c) => void exits.push(c) })("SIGTERM");
  assert.deepEqual(exits, [0]);
});
