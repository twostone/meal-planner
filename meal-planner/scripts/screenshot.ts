// Dev tool: starts the server on a throw-away database with sample data and saves phone-sized screenshots of the
// built app to screenshots/<name>.png, so a change can be looked at (by a person or by a coding agent).
// Usage (from meal-planner/, after `npm run build`):  npm run screenshot [-- [--dark] list catalog ingredients dish recipe cook shopping]
// --dark renders in dark mode and saves <name>-dark.png. CHROME_PATH points to a Chromium when Google Chrome is not installed.
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

// A list around today with three dishes (one done, one with a recipe), so every view has something to show,
// and an empty list for next week to move dishes to.
async function seed(base: string): Promise<{ pastaDishId: number }> {
  const plan = await call<Created>(base, "POST", "plans", { start_date: addDays(today(), -1), end_date: addDays(today(), 5) });
  const next = await call<Created>(base, "POST", "plans", { start_date: addDays(today(), 6), end_date: addDays(today(), 12) });
  await call(base, "PATCH", `plans/${next.id}`, { title: "Nächste Woche" });
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
      { section: null, amount: 150, amount_max: null, unit: "g", name: "Speck", note: "durchwachsen", prep: "gewürfelt" },
      { section: null, amount: 3, amount_max: null, unit: null, name: "Ei", plural: "Eier", note: null, prep: "zimmerwarm" },
      { section: null, amount: null, amount_max: null, unit: null, name: "Salz", note: null },
      { section: null, amount: null, amount_max: null, unit: null, name: "Pfeffer", note: "schwarz" },
      // An umlaut sorts between the base letters (Olivenöl, Öl, Oregano): the list must still show one group O.
      { section: null, amount: 1, amount_max: null, unit: "EL", name: "Olivenöl", note: null },
      { section: null, amount: 1, amount_max: null, unit: "EL", name: "Öl", note: null },
      { section: null, amount: null, amount_max: null, unit: null, name: "Oregano", note: null },
    ],
  });
  // A collective line as older recognized recipes have it, for splitting in the ingredient catalog.
  const soupDishId = dishes.find((d) => d.title === "Kürbissuppe mit Ingwer")!.id;
  await call(base, "PUT", `dishes/${soupDishId}/recipe`, {
    servings: 4,
    instructions: "Kürbis würfeln und kochen.\nPürieren und abschmecken.",
    ingredients: [
      { section: null, amount: 1, amount_max: null, unit: null, name: "Hokkaido-Kürbis", note: null },
      { section: null, amount: null, amount_max: null, unit: null, name: "Salz & Pfeffer", note: null, raw: "Salz & Pfeffer" },
    ],
  });
  // The ingredient catalog: salt is always at home, sugar was added by hand.
  await call(base, "PATCH", "ingredients", { key: "salz", pantry: true });
  await call(base, "POST", "ingredients", { name: "Zucker" });
  // Categories: pepper and oregano are spices, and all spices are always at home.
  await call(base, "PATCH", "ingredients", { key: "pfeffer", category: "Gewürz" });
  await call(base, "PATCH", "ingredients", { key: "oregano", category: "Gewürz" });
  await call(base, "PATCH", "ingredient-categories", { key: "gewürz", pantry: true });
  return { pastaDishId };
}

// The title button of the sample dish (the checkbox next to it has a similar accessible name).
const pastaTitle = (page: Page) => page.locator("button.title", { hasText: "Spaghetti Carbonara" });

// The local server runs without Home Assistant, so it has no shopping routes: answer them in the browser with sample
// data (lists as Bring shows them in Home Assistant), so the header button and the sheet can be looked at.
async function fakeShopping(page: Page): Promise<void> {
  const lists = [
    { entity_id: "todo.essen", name: "Essen", description: true },
    { entity_id: "todo.drogerie", name: "Drogerie", description: true },
  ];
  await page.route("**/api/shopping/status", (r) => r.fulfill({ json: { lists, selected: "todo.essen", reason: null } }));
  await page.route("**/api/plans/*/shopping?*", (r) =>
    r.fulfill({
      json: {
        entries: [
          { entry_id: 1, title: "Spaghetti Carbonara", done: false, selected: true, has_recipe: true },
          { entry_id: 2, title: "Kürbissuppe mit Ingwer", done: true, selected: false, has_recipe: true },
          { entry_id: 3, title: "Linsen-Dal", done: false, selected: true, has_recipe: false },
        ],
        items: [
          { key: "eier\0", name: "Eier", note: null, spec: "3", sources: ["Spaghetti Carbonara"], on_list: true, pantry: false },
          { key: "nüsse\0macadamia", name: "Nüsse", note: "Macadamia", spec: "Macadamia, 50 g", sources: ["Linsen-Dal"], on_list: false, pantry: false },
          { key: "nüsse\0walnuss", name: "Nüsse", note: "Walnuss", spec: "Walnuss, 50 g", sources: ["Linsen-Dal"], on_list: false, pantry: false },
          { key: "parmesan\0", name: "Parmesan", note: null, spec: "80 g", sources: ["Spaghetti Carbonara"], on_list: false, pantry: false },
          { key: "spaghetti\0", name: "Spaghetti", note: null, spec: "400 g", sources: ["Spaghetti Carbonara"], on_list: false, pantry: false },
          { key: "pfeffer\0schwarz", name: "Pfeffer", note: "schwarz", spec: "schwarz", sources: ["Spaghetti Carbonara"], on_list: false, pantry: true },
          { key: "salz\0", name: "Salz", note: null, spec: null, sources: ["Spaghetti Carbonara"], on_list: true, pantry: true },
        ],
        list_error: false,
      },
    }),
  );
}

// Without Home Assistant there is no AI: answer its route for making a recipe's ingredients uniform with samples.
async function fakeNormalize(page: Page): Promise<void> {
  await page.route("**/api/recipe/status", (r) => r.fulfill({ json: { ai: true, reason: null, image: true } }));
  await page.route("**/api/dishes/*/recipe/normalize", (r) =>
    r.fulfill({
      json: {
        changes: [
          { pos: 0, from: { name: "Spaghetti", note: null }, to: { name: "Spaghetti", plural: null, note: null, prep: null }, unit: "oz" },
          { pos: 1, from: { name: "Speck", note: "durchwachsen" }, to: { name: "Speck", plural: null, note: "durchwachsen", prep: "in Streifen" }, unit: null },
        ],
      },
    }),
  );
}

// A link whose page has a recipe text, and an AI task that turns it into a draft (no Home Assistant here).
async function fakeLinkWithRecipe(page: Page): Promise<void> {
  const sourceText = "Für 2 Personen\n500 g Kartoffeln\n2 rote Zwiebeln\n2 EL Olivenöl\n\nAlles schneiden.\nIm Ofen 40 Minuten rösten.";
  await page.route("**/api/recipe/status", (r) => r.fulfill({ json: { ai: true, reason: null, image: false } }));
  await page.route("**/api/preview", (r) =>
    r.fulfill({ json: { title: "Ofengemüse", image: null, reason: null, titleSuggestions: ["Ofengemüse"], sourceText, sourceTruncated: false } }),
  );
  await page.route("**/api/title-suggestions", (r) => r.fulfill({ json: { titles: [] } }));
  await page.route("**/api/recipe/draft", (r) =>
    r.fulfill({
      json: {
        servings: 2,
        instructions: "Alles schneiden.\nIm Ofen 40 Minuten rösten.",
        ingredients: [
          { section: null, amount: 500, amount_max: null, unit: "g", name: "Kartoffel", plural: "Kartoffeln", note: null, prep: null, raw: "500 g Kartoffeln", verified: true },
          { section: null, amount: 2, amount_max: null, unit: null, name: "Zwiebel", plural: "Zwiebeln", note: "rot", prep: null, raw: "2 rote Zwiebeln", verified: true },
          { section: null, amount: 3, amount_max: null, unit: "EL", name: "Olivenöl", plural: null, note: null, prep: null, raw: "3 EL Olivenöl", verified: false },
        ],
      },
    }),
  );
}

type Shot = { name: string; run: (page: Page) => Promise<void> };

const SHOTS: Shot[] = [
  { name: "list", run: async () => {} },
  { name: "periods", run: (page) => page.locator("button.period").click() },
  { name: "catalog", run: (page) => page.getByRole("button", { name: "Katalog" }).click() },
  { name: "ingredients", run: (page) => page.getByRole("button", { name: "Zutaten", exact: true }).click() },
  {
    // Filtered by a category: the switch for the whole category, its ingredients ticked and fixed.
    name: "ingredient-category",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.getByRole("button", { name: "Gewürz", exact: true }).click();
    },
  },
  {
    // The category field of one ingredient, with the categories in use as suggestions.
    name: "ingredient-category-edit",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: "Speck" }).click();
      await page.getByLabel("Kategorie").fill("Fleisch");
    },
  },
  {
    // An opened ingredient lists the dishes that use it as cards, with the lines as written.
    name: "ingredient-dishes",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: /^Pfeffer/ }).click();
      await page.getByRole("button", { name: /Spaghetti Carbonara/ }).waitFor();
    },
  },
  {
    // A tap on such a card opens the recipe of the dish.
    name: "ingredient-dish-recipe",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: /^Pfeffer/ }).click();
      await page.getByRole("button", { name: /Spaghetti Carbonara/ }).click();
      await page.locator("dialog").getByText("Zubereitung").first().waitFor();
    },
  },
  {
    // Splitting a collective line: the suggested parts, the dishes it touches, a variety for one part.
    name: "ingredient-split",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: "Salz & Pfeffer" }).click();
      await page.getByRole("button", { name: "Aufteilen …" }).click();
      await page.getByLabel("Sorte von Zutat 2").fill("schwarz");
    },
  },
  {
    // After splitting: the list without the collective line, Salz in two dishes, the info toast.
    name: "ingredient-split-done",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: "Salz & Pfeffer" }).click();
      await page.getByRole("button", { name: "Aufteilen …" }).click();
      const sheet = page.locator("dialog");
      await sheet.getByRole("button", { name: "In 2 Zutaten aufteilen" }).click();
      await sheet.getByRole("button", { name: /Wirklich aufteilen/ }).click();
      await page.getByRole("status").waitFor();
    },
  },
  {
    // Merging "Öl" into the known "Olivenöl": the sheet says so and asks for plural, variety and pantry.
    name: "ingredient-rename",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: /^Öl/ }).click();
      await page.getByRole("button", { name: "Umbenennen …" }).click();
      await page.getByLabel("Neuer Name").fill("Olivenöl");
      await page.getByText("Wird mit „Olivenöl“ zusammengeführt").waitFor();
    },
  },
  {
    name: "ingredient-rename-done",
    run: async (page) => {
      await page.getByRole("button", { name: "Zutaten", exact: true }).click();
      await page.locator("button.title", { hasText: /^Öl/ }).click();
      await page.getByRole("button", { name: "Umbenennen …" }).click();
      await page.getByLabel("Neuer Name").fill("Olivenöl");
      const sheet = page.locator("dialog");
      await sheet.getByText("Wird mit „Olivenöl“ zusammengeführt").waitFor();
      await sheet.getByRole("button", { name: "Zusammenführen" }).click();
      await sheet.getByRole("button", { name: /Wirklich ändern/ }).click();
      await page.getByRole("status").waitFor();
    },
  },
  {
    // The pantry section of the shopping list unfolded: unticked, but can be ticked when something runs out.
    name: "shopping-pantry",
    run: async (page) => {
      await page.getByRole("button", { name: "Einkaufen", exact: true }).click();
      await page.getByText("Haben wir immer (2)").click();
      await page.locator(".pantry-items li").last().scrollIntoViewIfNeeded();
    },
  },
  { name: "dish", run: (page) => pastaTitle(page).click() },
  {
    // With an AI task that can generate images, the sheet offers "Bild erzeugen" next to "Foto wählen".
    name: "dish-ai",
    run: async (page) => {
      await page.route("**/api/recipe/status", (r) => r.fulfill({ json: { ai: true, reason: null, image: true } }));
      await pastaTitle(page).click();
      await page.getByRole("button", { name: /Bild erzeugen/ }).waitFor();
    },
  },
  {
    name: "recipe",
    run: async (page) => {
      await pastaTitle(page).click();
      await page.getByRole("button", { name: "Rezept Zutaten und Zubereitung" }).click();
    },
  },
  {
    name: "recipe-edit",
    run: async (page) => {
      await pastaTitle(page).click();
      await page.getByRole("button", { name: "Rezept Zutaten und Zubereitung" }).click();
      await page.getByRole("button", { name: "Bearbeiten" }).click();
    },
  },
  { name: "cook", run: (page) => page.getByRole("button", { name: "Kochen", exact: true }).click() },
  {
    name: "recipe-normalize",
    run: async (page) => {
      await fakeNormalize(page);
      await pastaTitle(page).click();
      await page.getByRole("button", { name: "Rezept Zutaten und Zubereitung" }).click();
      await page.getByRole("button", { name: "Zutaten vereinheitlichen" }).click();
      await page.getByText("übernehmen").waitFor();
    },
  },
  {
    // One dish that was not cooked moves on: the target list is chosen in the dish sheet.
    name: "dish-move",
    run: async (page) => {
      await pastaTitle(page).click();
      await page.getByRole("button", { name: "In andere Liste verschieben" }).click();
    },
  },
  {
    // All open dishes of the list move on together from the period sheet.
    name: "periods-move",
    run: async (page) => {
      await page.locator("button.period").click();
      await page.getByRole("button", { name: /Offene Gerichte verschieben/ }).click();
    },
  },
  { name: "shopping", run: (page) => page.getByRole("button", { name: "Einkaufen", exact: true }).click() },
  {
    // A new name from the list's add bar opens the create sheet: recipe filled in by hand, list switch above "Speichern".
    name: "dish-new",
    run: async (page) => {
      await page.getByLabel("Gericht oder Link hinzufügen").fill("Ofengemüse");
      await page.getByRole("button", { name: /Ofengemüse“ neu anlegen/ }).click();
      await page.getByText("Rezept (optional)").click();
      await page.getByRole("button", { name: "Zutat hinzufügen" }).click();
      await page.getByLabel("Menge").fill("500");
      await page.getByLabel("Einheit").selectOption("g");
      await page.getByLabel("Zutat", { exact: true }).fill("Kartoffel");
    },
  },
  {
    // From a link with recipe text and an AI task: "Zutaten erkennen" fills the editor with a draft to check.
    name: "dish-new-ai",
    run: async (page) => {
      await fakeLinkWithRecipe(page);
      await page.getByLabel("Gericht oder Link hinzufügen").fill("https://example.org/ofengemuese");
      await page.getByRole("button", { name: "Link speichern und Gericht benennen" }).click();
      await page.getByText("Rezept (optional)").click();
      await page.getByRole("button", { name: /Zutaten erkennen/ }).click();
      await page.getByText("Entwurf der KI").waitFor();
    },
  },
  {
    // Saved from the list without a list entry: an info says where the dish went.
    name: "toast-info",
    run: async (page) => {
      await page.getByLabel("Gericht oder Link hinzufügen").fill("Ofengemüse");
      await page.getByRole("button", { name: /Ofengemüse“ neu anlegen/ }).click();
      await page.getByLabel("In diese Liste aufnehmen").uncheck();
      await page.getByRole("button", { name: "Speichern" }).click();
      await page.getByRole("status").waitFor();
    },
  },
  {
    // A failed save inside a long sheet: the toast stays visible at the top, the sheet stays open.
    name: "toast-error",
    run: async (page) => {
      await page.getByRole("button", { name: "Katalog" }).click();
      await page.getByRole("button", { name: "Neues Gericht" }).click();
      await page.getByLabel("Titel").fill("Linsen-Dal");
      await page.getByRole("button", { name: "Speichern" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
];

async function main(): Promise<void> {
  if (!existsSync("dist/index.html")) throw new Error("dist/ fehlt: zuerst `npm run build`");
  const args = process.argv.slice(2);
  const dark = args.includes("--dark");
  const wanted = args.filter((a) => a !== "--dark");
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
    const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
    try {
      for (const shot of shots) {
        // A fresh context per shot: each one starts from the list, no state carries over.
        const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: dark ? "dark" : "light" })).newPage();
        await fakeShopping(page);
        await page.goto(base);
        await pastaTitle(page).waitFor();
        await shot.run(page);
        await page.waitForTimeout(400); // sheet/transition animations
        const file = join(OUT_DIR, `${shot.name}${dark ? "-dark" : ""}.png`);
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
