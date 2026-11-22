import type { Ingredient } from "./repo.ts";
import { nameKey } from "./shopping.ts";

// Splitting a collective line ("Salz & Pfeffer") into single ingredients, for the ingredient catalog. Pure: no database.
// Recipes recognized before the prompt asked for single ingredients hold such lines; as one name they escape the pantry
// and the shopping list ("Salz" is always at home, "Salz & Pfeffer" is not).

export type Part = { name: string; note: string | null };

// "Salz, Pfeffer & Oregano" -> Salz, Pfeffer, Oregano. "oder" names alternatives, not several ingredients: no split.
const SEPARATOR = /\s*(?:,|&|\+|\bund\b)\s*/i;

export function suggestParts(name: string): string[] {
  const parts: string[] = [];
  for (const part of name.split(SEPARATOR).map((p) => p.replace(/\s+/g, " ").trim())) {
    if (part && !parts.some((p) => nameKey(p) === nameKey(part))) parts.push(part);
  }
  return parts;
}

const sameLine = (a: Pick<Ingredient, "name" | "note" | "section">, b: Pick<Ingredient, "name" | "note" | "section">) =>
  nameKey(a.name) === nameKey(b.name) && nameKey(a.note ?? "") === nameKey(b.note ?? "") && nameKey(a.section ?? "") === nameKey(b.section ?? "");

// Replaces every line named `key` by the parts, in place. The parts get no amount: "1 TL Salz & Pfeffer" says nothing
// about how much of each. Section and the original line (raw) stay, so the recipe still shows where they came from.
// A part the recipe already has in the same section with the same variety is left out ("Salz" and "Salz & Pfeffer").
export function splitLines(lines: Ingredient[], key: string, parts: Part[]): Ingredient[] {
  const out: Ingredient[] = [];
  const kept = lines.filter((l) => nameKey(l.name) !== key);
  for (const line of lines) {
    if (nameKey(line.name) !== key) {
      out.push(line);
      continue;
    }
    for (const part of parts) {
      const candidate: Ingredient = {
        section: line.section,
        amount: null,
        amount_max: null,
        unit: null,
        name: part.name,
        plural: null,
        note: part.note,
        prep: null,
        raw: line.raw,
      };
      if (![...kept, ...out].some((l) => sameLine(l, candidate))) out.push(candidate);
    }
  }
  return out;
}
