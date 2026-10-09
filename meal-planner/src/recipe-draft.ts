import { UNITS } from "./repo.ts";

// What the LLM returns (ha-ai.ts) is untrusted input: this module turns it into a draft the user reviews,
// never into stored data. Nothing here talks to the network.

export type DraftIngredient = {
  section: string | null;
  amount: number | null;
  amount_max: number | null;
  unit: string | null;
  name: string;
  note: string | null;
  raw: string;
  // raw and section are found word for word in the source text. false = the model changed or made up the line.
  verified: boolean;
};
export type RecipeDraft = { servings: number | null; instructions: string | null; ingredients: DraftIngredient[] };
// The fields of the ai_task structure (see ha-ai.ts). `ingredients` is a JSON array as text.
export type RawDraft = { servings?: unknown; servings_quote?: unknown; ingredients?: unknown; instructions?: unknown };

export class DraftError extends Error {}

const MAX_INGREDIENTS = 60;
const MAX_INSTRUCTIONS = 10_000;

// Comparison form: no whitespace, bullets, list dashes, emojis, colons. So "• 2 Eier" matches "2 Eier",
// but a changed letter ("Auflerdin") does not match. Case stays: it is a word-for-word check.
const IGNORED = /[\s​‍️⃣•·●▪◦‣⁃*✓✔→\-–—:]|\p{Extended_Pictographic}/gu;
export const normalizeForCompare = (s: string) => s.normalize("NFC").replace(IGNORED, "");

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? v : null);

const UNIT_BY_LOWER = new Map(UNITS.map((u) => [u.toLowerCase(), u]));

// "1. Zwiebel schneiden", "1️⃣ Zwiebel", "- Zwiebel" -> "Zwiebel schneiden"
const STEP_PREFIX = /^\s*(?:\d{1,2}\s*[.)]|\d️?⃣|[•\-–*])\s*/u;

function cleanInstructions(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const lines = v
    .split(/\r?\n/)
    .map((l) => l.replace(STEP_PREFIX, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = lines.join("\n").slice(0, MAX_INSTRUCTIONS).trim();
  return text || null;
}

function parseIngredients(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") throw new DraftError("ingredients missing");
  // The model sometimes wraps JSON in a code fence.
  const t = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!t) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new DraftError("ingredients are not JSON");
  }
  if (!Array.isArray(parsed)) throw new DraftError("ingredients are not a list");
  return parsed;
}

// Cleans the model's answer and checks it against the source text it was given.
export function buildDraft(raw: RawDraft, source: string): RecipeDraft {
  const src = normalizeForCompare(source);
  const found = (s: string | null) => !!s && normalizeForCompare(s).length > 0 && src.includes(normalizeForCompare(s));

  const ingredients: DraftIngredient[] = [];
  for (const item of parseIngredients(raw.ingredients)) {
    if (ingredients.length >= MAX_INGREDIENTS) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name, 80);
    if (!name) continue;
    const section = str(typeof o.section === "string" ? o.section.replace(/:\s*$/, "") : o.section, 80);
    const rawLine = str(o.raw, 200) ?? name;
    let amount = num(o.amount);
    let amountMax = num(o.amount_max);
    if (amount === null || (amountMax !== null && amountMax < amount)) amountMax = null;
    if (amount === null) amountMax = null;
    // Only units from the fixed list; any other unit goes into the note so the information is not lost.
    let unit: string | null = null;
    let note = str(o.note, 200);
    const givenUnit = typeof o.unit === "string" ? o.unit.trim() : "";
    if (givenUnit) {
      unit = UNIT_BY_LOWER.get(givenUnit.toLowerCase()) ?? null;
      if (!unit) note = str([givenUnit, note].filter(Boolean).join(", "), 200);
    }
    ingredients.push({
      section,
      amount,
      amount_max: amountMax,
      unit,
      name,
      note,
      raw: rawLine,
      verified: found(rawLine) && (section === null || found(section)),
    });
  }

  // Portions only with a quote that is really in the text; the model otherwise invents "4".
  let servings: number | null = null;
  const quote = str(raw.servings_quote, 200);
  if (ingredients.length > 0 && typeof raw.servings === "number" && Number.isInteger(raw.servings) && raw.servings >= 1 && raw.servings <= 50 && found(quote)) {
    servings = raw.servings;
  }

  return { servings, instructions: cleanInstructions(raw.instructions), ingredients };
}
