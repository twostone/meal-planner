import type { Ingredient } from "./repo.ts";
import { clip } from "./text.ts";

// Builds the shopping list of a plan from the structured recipes: one item per ingredient name and note, amounts of
// the same unit added up. The note ("Macadamia" for "Nüsse") is never merged away: 50 g Nüsse (Macadamia) and 50 g
// Nüsse (Walnuss) stay two items, because "100 g Nüsse" would not say how much of which. No network, no database.
// Synonyms ("Knoblauchzehe" vs. "Knoblauch") stay separate items on purpose: guessing would merge different things.

export type ShoppingRecipe = { title: string; ingredients: Pick<Ingredient, "amount" | "amount_max" | "unit" | "name" | "note">[] };
export type ShoppingItem = {
  key: string; // unique per name and note: the name alone is not, two items may share it
  name: string; // spelling of the first occurrence
  note: string | null; // spelling of the first occurrence
  spec: string | null; // "Macadamia, 400 g + 1 Dose"; null = neither note nor amount ("Salz")
  sources: string[]; // titles of the dishes that need it
};

// Longest spec we hand out; the send route accepts the same (a note alone may be 200 characters, see the recipe schema).
export const MAX_SPEC_LENGTH = 200;

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
const KEY_SEPARATOR = "\u0000"; // cannot occur in a name or note, so ("a b", "") and ("a", "b") never collide

const number = new Intl.NumberFormat("de", { maximumFractionDigits: 2, useGrouping: false });
const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
export const nameKey = (name: string) => tidy(name).toLocaleLowerCase("de");

type Sum = { min: number; max: number };
type Collected = { name: string; note: string | null; sums: Map<string, Sum>; sources: string[] };

export function buildShoppingList(recipes: ShoppingRecipe[]): ShoppingItem[] {
  const groups = new Map<string, Collected & { key: string }>();
  for (const r of recipes) {
    for (const i of r.ingredients) {
      const nameOnly = nameKey(i.name);
      if (!nameOnly) continue;
      const note = i.note ? tidy(i.note) || null : null;
      const key = nameOnly + KEY_SEPARATOR + (note ? nameKey(note) : "");
      let c = groups.get(key);
      if (!c) groups.set(key, (c = { key, name: tidy(i.name), note, sums: new Map(), sources: [] }));
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
  return [...groups.values()]
    .map((c) => ({ key: c.key, name: c.name, note: c.note, spec: formatSpec(c.note, c.sums), sources: c.sources }))
    .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.note ?? "").localeCompare(b.note ?? "", "de"));
}

// "Macadamia, 400 g + 1 Dose": the note first, then the amounts of the different units.
function formatSpec(note: string | null, sums: Map<string, Sum>): string | null {
  const amounts = [...sums].map(([unit, sum]) => formatAmount(unit, sum)).join(" + ");
  const spec = [note, amounts].filter(Boolean).join(", ");
  return spec ? clip(spec, MAX_SPEC_LENGTH) : null;
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
