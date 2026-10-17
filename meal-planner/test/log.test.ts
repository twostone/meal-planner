import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { announceToHomeAssistant } from "../src/ha-discovery.ts";
import { ImageStore } from "../src/images.ts";
import { formatLine, logger, parseLevel, resolveLogLevel, setLogLevel, setLogSink, timestamp, type Level } from "../src/log.ts";
import { createPreviewService } from "../src/preview.ts";
import { createRepo } from "../src/repo.ts";

const lines: { level: Level; line: string }[] = [];
const capture = () => {
  lines.length = 0;
  setLogLevel("info");
  setLogSink((level, line) => lines.push({ level, line }));
};
afterEach(() => {
  setLogSink(null);
  setLogLevel("info");
});

// Reads a logfmt line back: `key=value`, values either plain or a JSON string.
function parse(line: string) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d) (DEBUG|INFO|WARN|ERROR) (\S+) (\S+)((?: [a-z_]+=(?:"(?:[^"\\]|\\.)*"|[^\s"]*))*)$/.exec(line);
  assert.ok(m, `not a log line: ${line}`);
  const fields: Record<string, string> = {};
  for (const f of m[5]!.matchAll(/ ([a-z_]+)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g)) {
    fields[f[1]!] = f[2]!.startsWith('"') ? JSON.parse(f[2]!) : f[2]!;
  }
  return { time: m[1]!, level: m[2]!, mod: m[3]!, event: m[4]!, fields };
}

test("timestamp: local time with milliseconds and the UTC offset", () => {
  const t = timestamp(new Date(2026, 9, 11, 14, 41, 3, 7)); // local time, whatever TZ is set
  assert.match(t, /^2026-10-11T14:41:03\.007[+-]\d\d:\d\d$/);
  assert.equal(new Date(t).getTime(), new Date(2026, 9, 11, 14, 41, 3, 7).getTime(), "offset matches the local zone");
});

test("formatLine: one line per message, any value can be read back", () => {
  const nasty = 'Käse "extra"\nzweite=Zeile\\ \t';
  const line = formatLine("warn", "ha-ai", "task_failed", { task: "meal_planner_title", status: 400, ok: false, body: nasty, empty: "", skipped: undefined, none: null });
  assert.ok(!line.includes("\n"));
  const p = parse(line);
  assert.deepEqual([p.level, p.mod, p.event], ["WARN", "ha-ai", "task_failed"]);
  assert.deepEqual(p.fields, { task: "meal_planner_title", status: "400", ok: "false", body: nasty, empty: "" });
  assert.match(line, / task=meal_planner_title status=400 ok=false body="/, "plain values stay unquoted");
});

test("formatLine: an Error becomes its name and message, a stack stays on one line", () => {
  const e = new TypeError("kaputt: x=1");
  const p = parse(formatLine("error", "app", "unhandled", { err: e, stack: e.stack }));
  assert.equal(p.fields.err, "TypeError: kaputt: x=1");
  assert.match(p.fields.stack!, /^TypeError: kaputt: x=1\n\s+at /, "the stack has its line breaks again after reading it back");
});

test("levels: below the threshold nothing is written", () => {
  capture();
  const log = logger("t");
  setLogLevel("warn");
  log.debug("a");
  log.info("b");
  log.warn("c");
  log.error("d");
  assert.deepEqual(lines.map((l) => [l.level, parse(l.line).event]), [["warn", "c"], ["error", "d"]]);
  setLogLevel("debug");
  log.debug("e");
  assert.equal(lines.at(-1)!.level, "debug");
});

test("parseLevel: 'warning' (the add-on option) is warn, anything else unknown is refused", () => {
  assert.equal(parseLevel("warning"), "warn");
  assert.equal(parseLevel(" DEBUG "), "debug");
  for (const bad of ["trace", "", 3, null, undefined]) assert.equal(parseLevel(bad), null);
});

test("resolveLogLevel: the option beats LOG_LEVEL, without it the variable, then info; invalid -> info", () => {
  assert.deepEqual(resolveLogLevel({ log_level: "warning" }, "debug"), { level: "warn", invalid: null });
  assert.deepEqual(resolveLogLevel({}, "debug"), { level: "debug", invalid: null });
  assert.deepEqual(resolveLogLevel({}), { level: "info", invalid: null });
  assert.deepEqual(resolveLogLevel({ log_level: "loud" }), { level: "info", invalid: "loud" });
  assert.deepEqual(resolveLogLevel({ other: 1 }, "error"), { level: "error", invalid: null }, "options without log_level use the variable");
});

// --- request log ---

const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

test("requests: failures are logged with path but without query, successes are not", async () => {
  capture();
  const repo = createRepo(openDb(":memory:"));
  const app = createApp(repo, { allowedIp: "172.30.32.2" });
  assert.equal((await app.request("/api/plans", {}, from("172.30.32.2"))).status, 200);
  assert.equal(lines.length, 0);

  assert.equal((await app.request("/api/dishes/999/recipe?token=geheim", {}, from("172.30.32.2"))).status, 404);
  assert.equal((await app.request("/api/plans?x=geheim", {}, from("10.0.0.5"))).status, 403);
  assert.equal(lines.length, 2);
  const [notFound, refused] = lines.map((l) => parse(l.line));
  assert.deepEqual([notFound!.event, notFound!.fields.method, notFound!.fields.path, notFound!.fields.status], ["request", "GET", "/api/dishes/999/recipe", "404"]);
  assert.deepEqual([refused!.fields.path, refused!.fields.status], ["/api/plans", "403"]);
  assert.ok(lines.every((l) => !l.line.includes("geheim")), "no query string in the log");
  assert.equal(lines[0]!.level, "warn");
});

test("requests: an unexpected error logs the error with its stack, then the 500", async () => {
  capture();
  const repo = createRepo(openDb(":memory:"));
  (repo as any).listPlans = () => {
    throw new Error("boom");
  };
  const res = await createApp(repo).request("/api/plans");
  assert.equal(res.status, 500);
  const events = lines.map((l) => parse(l.line));
  assert.deepEqual(events.map((e) => [e.event, e.level]), [["unhandled", "ERROR"], ["request", "ERROR"]]);
  assert.equal(events[0]!.fields.err, "Error: boom");
  assert.match(events[0]!.fields.stack!, /^Error: boom\n/);
  assert.equal(events[1]!.fields.status, "500");
});

// --- the other modules ---

test("discovery: the token never appears in a log line, failures are numbered and the last one says it gave up", async () => {
  capture();
  const server = http.createServer((_req, res) => res.writeHead(500).end("{}"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await announceToHomeAssistant({ supervisorUrl: base, supervisorToken: "SV-GEHEIM", port: 8100, apiToken: "API-GEHEIM", retries: 1, delayMs: 1 });
    assert.equal(ok, false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const events = lines.map((l) => parse(l.line));
  assert.deepEqual(events.map((e) => e.event), ["announce_failed", "announce_failed", "announce_gave_up"]);
  assert.deepEqual([events[0]!.fields.attempt, events[0]!.fields.of, events[1]!.fields.attempt], ["1", "2", "2"]);
  assert.ok(lines.every((l) => !/GEHEIM/.test(l.line)));
});

test("preview: one line per fetch with the host only, never the link", async () => {
  capture();
  const dir = await mkdtemp(path.join(os.tmpdir(), "log-"));
  try {
    const page = { url: new URL("https://example.com/r?token=geheim"), contentType: "text/html", charset: null, body: Buffer.from('<meta property="og:title" content="Shakshuka">') };
    await createPreviewService({ images: new ImageStore(dir), fetcher: (async () => page) as never })("https://example.com/r?token=geheim");
  } finally {
    await rm(dir, { recursive: true });
  }
  assert.equal(lines.length, 1);
  const p = parse(lines[0]!.line);
  assert.deepEqual([p.mod, p.event, p.fields.host, p.fields.title, p.fields.image, p.fields.source], ["preview", "fetched", "example.com", "true", "false", "false"]);
  assert.match(p.fields.ms!, /^\d+$/);
  assert.ok(!lines[0]!.line.includes("geheim"));
});
