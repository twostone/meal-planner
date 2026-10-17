import { nameKey } from "./shopping.ts";

// Converts units from English recipes ("1 cup Mehl") into the units of the app (UNITS in repo.ts), so the shopping
// list can add them up. No network, no database. Own table instead of a library: easy-cook needs the densities
// supplied anyway, @jclind/ingredient-unit-converter only knows English ingredients (checked 17.10.2026).

// US customary units. "cup" is ambiguous (US 237 ml, metric 250 ml, UK 284 ml); most English recipes on Instagram use US.
const ML_PER_CUP = 236.588;
const ML_PER_FL_OZ = 29.574;
const G_PER_OZ = 28.35;
const G_PER_LB = 453.592;

// The English units the recipe prompt allows (ha-ai.ts); recipe-draft.ts converts them.
export const FOREIGN_UNITS = ["cup", "tbsp", "tsp", "oz", "fl oz", "lb"] as const;
type Foreign = (typeof FOREIGN_UNITS)[number];
const FOREIGN_BY_SPELLING: Record<string, Foreign> = {
  cup: "cup",
  cups: "cup",
  tbsp: "tbsp",
  tbs: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  "fl oz": "fl oz",
  "fl. oz": "fl oz",
  "fl. oz.": "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  oz: "oz",
  "oz.": "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  "lb.": "lb",
  pound: "lb",
  pounds: "lb",
};

// Grams per US cup of dry ingredients, keyed by the normalized name (nameKey) in its base form. Source: King Arthur
// Baking, ingredient weight chart (read 17.10.2026). Densities vary with how the cup is filled (flour about ±20 %).
// An ingredient not listed here is converted to ml: unusual for shopping, but not wrong.
const CUP_GRAMS: Record<string, number> = {
  mehl: 120,
  weizenmehl: 120,
  dinkelmehl: 120,
  vollkornmehl: 113,
  roggenmehl: 106,
  mandelmehl: 96,
  zucker: 198,
  "brauner zucker": 213,
  rohrzucker: 213,
  puderzucker: 113,
  haferflocke: 89,
  haferflocken: 89,
  reis: 198,
  kakaopulver: 84,
  kakao: 84,
  speisestärke: 112,
  stärke: 112,
  kokosraspel: 85,
  paniermehl: 112,
  semmelbrösel: 112,
  butter: 226,
  parmesan: 100,
  rosine: 149,
  rosinen: 149,
  honig: 336,
  erdnussbutter: 270,
};

// Below this, grams and millilitres are rounded to whole numbers, above to steps of ROUND_STEP.
const ROUND_FINE_BELOW = 20;
const ROUND_STEP = 5;

export const foreignUnit = (unit: string): Foreign | null => FOREIGN_BY_SPELLING[unit.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;

function round(n: number): number {
  if (n < ROUND_FINE_BELOW) return Math.max(1, Math.round(n));
  return Math.round(n / ROUND_STEP) * ROUND_STEP;
}

export type Converted = { amount: number | null; amount_max: number | null; unit: string };

// "1 cup Mehl" -> 120 g, "1 cup Milch" -> 235 ml, "2 tbsp" -> 2 EL. `unit` must be a foreign unit (see foreignUnit).
// Without an amount only the unit changes.
export function convert(amount: number | null, amountMax: number | null, unit: Foreign, name: string): Converted {
  if (unit === "tbsp") return { amount, amount_max: amountMax, unit: "EL" };
  if (unit === "tsp") return { amount, amount_max: amountMax, unit: "TL" };
  let factor: number;
  let target: string;
  if (unit === "cup") {
    const grams = CUP_GRAMS[nameKey(name)];
    [factor, target] = grams ? [grams, "g"] : [ML_PER_CUP, "ml"];
  } else if (unit === "fl oz") [factor, target] = [ML_PER_FL_OZ, "ml"];
  else if (unit === "oz") [factor, target] = [G_PER_OZ, "g"];
  else [factor, target] = [G_PER_LB, "g"];
  const scale = (n: number | null) => (n === null || n === 0 ? n : round(n * factor));
  return { amount: scale(amount), amount_max: scale(amountMax), unit: target };
}
