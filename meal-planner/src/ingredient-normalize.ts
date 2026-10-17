import { parseJsonArray, str } from "./recipe-draft.ts";
import { foreignUnit, type Foreign } from "./units.ts";

// Making the stored ingredients uniform (the button in the catalog): the model suggests a base-form name, variety
// (note) and preparation (prep) for every distinct (name, note) pair; this module turns its answer into changes the
// user reviews. Its answer is untrusted input, like a recipe draft. No network, no database.

export type Pair = { name: string; note: string | null };
// What the model gets: the pair with an English unit already taken out of the note, numbered.
export type AiPair = { i: number; name: string; note: string | null };
export type Change = {
  from: Pair; // the stored values; apply only touches rows that still have them
  to: { name: string; note: string | null; prep: string | null };
  unit: Foreign | null; // the note started with this unit: apply converts amount and unit of each row
};

// Pairs per preview call: small enough for the AI task's time limit, the client sends block after block.
export const MAX_PAIRS_PER_BLOCK = 80;

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

// The model's `items` field -> changes. Unknown or repeated numbers and malformed items are dropped; an item without
// any difference to its pair is no change. A unit in the note is a change even when the model suggests nothing.
export function buildChanges(pairs: Pair[], items: unknown): Change[] {
  const split = pairs.map((p) => splitUnitNote(p.note));
  const suggested = new Map<number, Change["to"]>();
  for (const item of parseJsonArray(items, "items")) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const i = o.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= pairs.length || suggested.has(i)) continue;
    const name = str(o.name, 80);
    if (!name) continue;
    suggested.set(i, { name, note: str(o.note, 200), prep: str(o.prep, 200) });
  }
  const changes: Change[] = [];
  pairs.forEach((from, i) => {
    const { unit, note } = split[i]!;
    const to = suggested.get(i) ?? { name: from.name, note, prep: null };
    if (unit || to.name !== from.name || to.note !== from.note || to.prep !== null) changes.push({ from, to, unit });
  });
  return changes;
}

// The numbered pairs for the prompt, with the unit taken out of the note.
export const aiPairs = (pairs: Pair[]): AiPair[] => pairs.map((p, i) => ({ i, name: p.name, note: splitUnitNote(p.note).note }));
