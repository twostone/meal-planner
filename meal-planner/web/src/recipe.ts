// Structural type instead of importing ./types: the backend's tsc (nodenext) also compiles this file via its test.
type Ingredient = {
  section: string | null;
  amount: number | null;
  amount_max: number | null;
  unit: string | null;
  name: string;
  note: string | null;
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

// "2 EL Olivenöl" for the recipe view
export const ingredientText = (i: Ingredient) => [fmtAmount(i), i.unit, i.name].filter(Boolean).join(" ");

export function groupBySection(list: Ingredient[]): { section: string | null; items: Ingredient[] }[] {
  const out: { section: string | null; items: Ingredient[] }[] = [];
  for (const i of list) {
    const last = out[out.length - 1];
    if (last && last.section === i.section) last.items.push(i);
    else out.push({ section: i.section, items: [i] });
  }
  return out;
}
