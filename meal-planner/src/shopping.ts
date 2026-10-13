import type { Ingredient } from "./repo.ts";

// Builds the shopping list of a plan from the structured recipes: one item per ingredient name, amounts of the same
// unit added up. No network, no database. Synonyms ("Knoblauchzehe" vs. "Knoblauch") stay separate items on purpose:
// guessing would merge things that are not the same.

export type ShoppingRecipe = { title: string; ingredients: Pick<Ingredient, "amount" | "amount_max" | "unit" | "name">[] };
export type ShoppingItem = {
  name: string; // spelling of the first occurrence
  spec: string | null; // "400 g + 1 Dose"; null = no amount anywhere ("Salz")
  sources: string[]; // titles of the dishes that need it
};

const GRAMS_PER_KG = 1000;
const ML_PER_L = 1000;
// Weights and volumes are added up in the smaller unit and shown in the larger one from this amount on.
const BASE_UNIT: Record<string, { base: string; factor: number }> = {
  kg: { base: "g", factor: GRAMS_PER_KG },
  l: { base: "ml", factor: ML_PER_L },
};
const LARGER_UNIT: Record<string, { unit: string; factor: number }> = {
  g: { unit: "kg", factor: GRAMS_PER_KG },
  ml: { unit: "l", factor: ML_PER_L },
};
const COUNTED = ""; // key of amounts without a unit ("2 Zwiebeln")

const number = new Intl.NumberFormat("de", { maximumFractionDigits: 2, useGrouping: false });
export const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase("de");

type Sum = { min: number; max: number };
type Collected = { name: string; sums: Map<string, Sum>; sources: string[] };

export function buildShoppingList(recipes: ShoppingRecipe[]): ShoppingItem[] {
  const byName = new Map<string, Collected>();
  for (const r of recipes) {
    for (const i of r.ingredients) {
      const key = nameKey(i.name);
      if (!key) continue;
      let c = byName.get(key);
      if (!c) byName.set(key, (c = { name: i.name.replace(/\s+/g, " ").trim(), sums: new Map(), sources: [] }));
      if (!c.sources.includes(r.title)) c.sources.push(r.title);
      if (i.amount === null) continue;
      const conv = i.unit ? BASE_UNIT[i.unit] : undefined;
      const unit = conv?.base ?? i.unit ?? COUNTED;
      const factor = conv?.factor ?? 1;
      const sum = c.sums.get(unit) ?? { min: 0, max: 0 };
      sum.min += i.amount * factor;
      sum.max += (i.amount_max ?? i.amount) * factor;
      c.sums.set(unit, sum);
    }
  }
  return [...byName.values()]
    .map((c) => ({ name: c.name, spec: formatSpec(c.sums), sources: c.sources }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function formatSpec(sums: Map<string, Sum>): string | null {
  const parts = [...sums].map(([unit, sum]) => formatAmount(unit, sum));
  return parts.length ? parts.join(" + ") : null;
}

// "1,5 kg", "2–3 Zehe", "2"
function formatAmount(unit: string, { min, max }: Sum): string {
  const larger = LARGER_UNIT[unit];
  if (larger && min >= larger.factor) {
    unit = larger.unit;
    min /= larger.factor;
    max /= larger.factor;
  }
  const amount = max > min ? `${number.format(min)}–${number.format(max)}` : number.format(min);
  return unit === COUNTED ? amount : `${amount} ${unit}`;
}
