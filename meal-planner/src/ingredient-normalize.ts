import type { Ingredient } from "./repo.ts";
import { parseJsonArray, pluralOf, str } from "./recipe-draft.ts";
import { foreignUnit, type Foreign } from "./units.ts";

// Making the ingredients of one saved recipe uniform (button in the recipe view): the model suggests base form, plural,
// variety (note) and preparation (prep) for every line; this module turns its answer into changes the user reviews.
// Its answer is untrusted input, like a recipe draft. No network, no database.

export type StoredIngredient = Pick<Ingredient, "name" | "plural" | "note" | "prep">;
// What the model gets: the line numbered by its position, an English unit already taken out of the note.
export type AiItem = { i: number; name: string; plural: string | null; note: string | null; prep: string | null };
export type Change = {
  pos: number; // position of the line in the recipe
  from: { name: string; note: string | null }; // the stored values; apply only touches the line if it still has them
  to: { name: string; plural: string | null; note: string | null; prep: string | null };
  unit: Foreign | null; // the note started with this unit: apply converts amount and unit of the line
};

// Recipes recognized before the conversion (recipe-draft.ts) kept an unknown unit as the start of the note:
// "cups, gesiebt" -> cup and "gesiebt". Only that exact form counts.
export function splitUnitNote(note: string | null): { unit: Foreign | null; note: string | null } {
  if (!note) return { unit: null, note };
  const comma = note.indexOf(",");
  const head = comma < 0 ? note : note.slice(0, comma);
  const unit = foreignUnit(head);
  if (!unit) return { unit: null, note };
  const rest = comma < 0 ? "" : note.slice(comma + 1).trim();
  return { unit, note: rest || null };
}

export const aiItems = (lines: StoredIngredient[]): AiItem[] =>
  lines.map((l, i) => ({ i, name: l.name, plural: l.plural, note: splitUnitNote(l.note).note, prep: l.prep }));

// The model's `items` field -> changes. Unknown or repeated numbers and malformed items are dropped; a suggestion
// without any difference is no change. A unit in the note is a change even when the model suggests nothing. A
// preparation the model drops stays: it was in the input, losing it would lose information.
export function buildChanges(lines: StoredIngredient[], items: unknown): Change[] {
  const suggested = new Map<number, Change["to"]>();
  for (const item of parseJsonArray(items, "items")) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const i = o.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= lines.length || suggested.has(i)) continue;
    const name = str(o.name, 80);
    if (!name) continue;
    suggested.set(i, { name, plural: pluralOf(name, o.plural), note: str(o.note, 200), prep: str(o.prep, 200) ?? lines[i]!.prep });
  }
  const changes: Change[] = [];
  lines.forEach((line, pos) => {
    const { unit, note } = splitUnitNote(line.note);
    const to = suggested.get(pos) ?? { name: line.name, plural: line.plural, note, prep: line.prep };
    const differs = to.name !== line.name || to.plural !== line.plural || to.note !== line.note || to.prep !== line.prep;
    if (unit || differs) changes.push({ pos, from: { name: line.name, note: line.note }, to, unit });
  });
  return changes;
}
