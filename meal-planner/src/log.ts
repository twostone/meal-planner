import type { AddonOptions } from "./options.ts";

// One log line per event: `<time> <LEVEL> <module> <event> key=value …`, e.g.
//   2026-10-11T14:41:03.123+02:00 ERROR ha-ai task_failed task=meal_planner_title status=400 ms=812 body="…"
// logfmt, not JSON: the add-on log in Home Assistant is read by people, and a line still splits on spaces for grep.
// The time is local with its UTC offset (TZ), so it matches the clock and Home Assistant's own log.
// Never log: full URLs, tokens, recipe or caption text, query strings, user names (see AGENTS.md).

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = RANK.info;

// Home Assistant's option says "warning", the code says "warn". Anything else is not a level.
export function parseLevel(v: unknown): Level | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "warning") return "warn";
  return s === "debug" || s === "info" || s === "warn" || s === "error" ? s : null;
}

export function setLogLevel(level: Level): void {
  threshold = RANK[level];
}

// The add-on's `log_level` option (Supervisor writes /data/options.json), else LOG_LEVEL (development), else info.
// An invalid value falls back to info and is returned as `invalid`, so the caller can say so once logging is set up.
export function resolveLogLevel(options: AddonOptions, envLevel?: string): { level: Level; invalid: string | null } {
  const raw = options.log_level ?? envLevel;
  if (raw === undefined || raw === null || raw === "") return { level: "info", invalid: null };
  const level = parseLevel(raw);
  return level ? { level, invalid: null } : { level: "info", invalid: String(raw).slice(0, 40) };
}

// Where lines go. Tests replace it; setLogSink(null) restores stdout (debug, info) and stderr (warn, error).
type Sink = (level: Level, line: string) => void;
const stdSink: Sink = (level, line) => (RANK[level] >= RANK.warn ? process.stderr : process.stdout).write(`${line}\n`);
let sink: Sink = stdSink;
export function setLogSink(fn: Sink | null): void {
  sink = fn ?? stdSink;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function timestamp(d: Date = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// Numbers and booleans as they are. Text as it is when it has no space, quote, "=", backslash or control character,
// otherwise as a JSON string: a message is always exactly one line and can be read back.
const PLAIN = /^[^\s"=\\\u0000-\u001f]+$/;
function render(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = v instanceof Error ? `${v.name}: ${v.message}` : typeof v === "string" ? v : JSON.stringify(v);
  return PLAIN.test(s) ? s : JSON.stringify(s);
}

export function formatLine(level: Level, mod: string, event: string, fields: Fields = {}, at: Date = new Date()): string {
  let line = `${timestamp(at)} ${level.toUpperCase()} ${mod} ${event}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) line += ` ${key}=${render(value)}`;
  }
  return line;
}

export type Logger = Record<Level, (event: string, fields?: Fields) => void>;

export function logger(mod: string): Logger {
  const at = (level: Level) => (event: string, fields?: Fields) => {
    if (RANK[level] >= threshold) sink(level, formatLine(level, mod, event, fields));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
