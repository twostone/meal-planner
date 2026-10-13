// Dev tool: starts the server on a throw-away database with sample data and saves phone-sized screenshots of the
// built app to screenshots/<name>.png, so a change can be looked at (by a person or by a coding agent).
// Usage (from meal-planner/, after `npm run build`):  npm run screenshot [-- list catalog dish recipe cook]
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { addDays, today } from "../web/src/dates.ts";

const VIEWPORT = { width: 390, height: 844 }; // the phone width AGENTS.md asks UI changes to be checked at
const OUT_DIR = "screenshots";
const SERVER_START_TIMEOUT_MS = 15_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await fetch(`${base}/api/plans`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Created = { id: number };

// A list around today with three dishes (one done, one with a recipe), so every view has something to show.
async function seed(base: string): Promise<{ pastaDishId: number }> {
  const plan = await call<Created>(base, "POST", "plans", { start_date: addDays(today(), -1), end_date: addDays(today(), 5) });
  const pasta = await call<Created>(base, "POST", `plans/${plan.id}/entries`, { title: "Spaghetti Carbonara", tags: ["Pasta"] });
  const soup = await call<Created>(base, "POST", `plans/${plan.id}/entries`, { title: "Kürbissuppe mit Ingwer", tags: ["Suppe", "Vegetarisch"] });
  await call(base, "POST", `plans/${plan.id}/entries`, { title: "Linsen-Dal", tags: ["Vegetarisch"] });
  await call(base, "PATCH", `entries/${soup.id}`, { done: true });
  await call(base, "PATCH", `entries/${pasta.id}`, { note: "Mit viel Pfeffer" });
  const dishes = await call<{ id: number; title: string }[]>(base, "GET", "dishes");
  const pastaDishId = dishes.find((d) => d.title === "Spaghetti Carbonara")!.id;
  await call(base, "PUT", `dishes/${pastaDishId}/recipe`, {
    servings: 4,
    instructions: "Wasser salzen und die Spaghetti kochen.\nSpeck in einer Pfanne auslassen.\nEier mit Käse verrühren und alles mischen.",
    ingredients: [
      { section: null, amount: 400, amount_max: null, unit: "g", name: "Spaghetti", note: null },
      { section: null, amount: 150, amount_max: null, unit: "g", name: "Speck", note: null },
      { section: null, amount: 3, amount_max: null, unit: null, name: "Eier", note: null },
    ],
  });
  return { pastaDishId };
}

// The title button of the sample dish (the checkbox next to it has a similar accessible name).
const pastaTitle = (page: Page) => page.locator("button.title", { hasText: "Spaghetti Carbonara" });

type Shot = { name: string; run: (page: Page) => Promise<void> };

const SHOTS: Shot[] = [
  { name: "list", run: async () => {} },
  { name: "catalog", run: (page) => page.getByRole("button", { name: "Katalog" }).click() },
  { name: "dish", run: (page) => pastaTitle(page).click() },
  {
    name: "recipe",
    run: async (page) => {
      await pastaTitle(page).click();
      await page.getByRole("button", { name: "Rezept Zutaten und Zubereitung" }).click();
    },
  },
  { name: "cook", run: (page) => page.getByRole("button", { name: "Kochen", exact: true }).click() },
];

async function main(): Promise<void> {
  if (!existsSync("dist/index.html")) throw new Error("dist/ fehlt: zuerst `npm run build`");
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !SHOTS.some((s) => s.name === w));
  if (unknown.length) throw new Error(`unknown screenshot(s): ${unknown.join(", ")} (available: ${SHOTS.map((s) => s.name).join(", ")})`);
  const shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS;

  const dataDir = mkdtempSync(join(tmpdir(), "meal-planner-shots-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // INGRESS_ONLY_IP empty switches the ingress guard off (as in the CI smoke test); only for this local, throw-away server.
  const server: ChildProcess = spawn("node", ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dataDir, "shots.db"), INGRESS_ONLY_IP: "", LOG_LEVEL: "error" },
    stdio: "inherit",
  });
  try {
    await waitForServer(base);
    await seed(base);
    mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      for (const shot of shots) {
        // A fresh context per shot: each one starts from the list, no state carries over.
        const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })).newPage();
        await page.goto(base);
        await pastaTitle(page).waitFor();
        await shot.run(page);
        await page.waitForTimeout(400); // sheet/transition animations
        const file = join(OUT_DIR, `${shot.name}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
