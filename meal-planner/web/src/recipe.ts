// Structural type instead of importing ./types: the backend's tsc (nodenext) also compiles this file via its test.
type Ingredient = {
  section: string | null;
  amount: number | null;
  amount_max: number | null;
  unit: string | null;
  name: string;
  plural?: string | null;
  note: string | null;
  prep?: string | null;
};

// 1.5 -> "1,5" (German decimal comma, no trailing zeros)
export const fmtNum = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");

export const fmtAmount = (i: Pick<Ingredient, "amount" | "amount_max">) =>
  i.amount === null ? "" : fmtNum(i.amount) + (i.amount_max === null ? "" : `–${fmtNum(i.amount_max)}`);

// "1,5" -> {1.5, null}, "1-2" -> {1, 2}, "" -> {null, null}. Anything else: undefined.
export function parseAmount(v: string): { amount: number | null; amount_max: number | null } | undefined {
  const t = v.trim();
  if (!t) return { amount: null, amount_max: null };
  const m = /^(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?$/.exec(t);
  if (!m) return undefined;
  const a = Number(m[1]!.replace(",", "."));
  const b = m[2] === undefined ? null : Number(m[2].replace(",", "."));
  if (b !== null && b < a) return undefined;
  return { amount: a, amount_max: b };
}

// The name as it reads after the amount: the plural for more than one ("3 Zwiebeln"), for a range and after a unit
// ("200 g Zwiebeln", "1 Dose Tomaten"); the singular for one, for none and without an amount ("1 Zwiebel", "Salz").
export function displayName(i: Pick<Ingredient, "amount" | "amount_max" | "unit" | "name" | "plural">): string {
  const many = i.amount !== null && (i.unit !== null || i.amount > 1 || i.amount_max !== null);
  return (many && i.plural) || i.name;
}

// "2 EL Olivenöl" for the recipe view
export const ingredientText = (i: Ingredient) => [fmtAmount(i), i.unit, displayName(i)].filter(Boolean).join(" ");

// ", rot, gewürfelt" after the ingredient: variety (note), then preparation (prep). "" without either.
export const ingredientExtra = (i: Pick<Ingredient, "note" | "prep">) => [i.note, i.prep].filter(Boolean).join(", ");

export function groupBySection(list: Ingredient[]): { section: string | null; items: Ingredient[] }[] {
  const out: { section: string | null; items: Ingredient[] }[] = [];
  for (const i of list) {
    const last = out[out.length - 1];
    if (last && last.section === i.section) last.items.push(i);
    else out.push({ section: i.section, items: [i] });
  }
  return out;
}

const STEP_HEADING = /^##\s*/;

// The steps of a recipe in sections: a line "## Heading" starts one and is no step. idx counts the steps across all
// sections, the same way the server does (stepLines in repo.ts), so the steps ticked in cook mode agree on both sides.
export function stepGroups(instructions: string | null): { section: string | null; steps: { text: string; idx: number }[] }[] {
  const out: { section: string | null; steps: { text: string; idx: number }[] }[] = [];
  let idx = 0;
  for (const line of (instructions ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (STEP_HEADING.test(line)) out.push({ section: line.replace(STEP_HEADING, "") || null, steps: [] });
    else {
      if (out.length === 0) out.push({ section: null, steps: [] });
      out.at(-1)!.steps.push({ text: line, idx: idx++ });
    }
  }
  return out;
}

export const stepLines = (instructions: string | null): string[] => stepGroups(instructions).flatMap((g) => g.steps.map((s) => s.text));
