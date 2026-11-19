// State and checks of the recipe editor, shared by the recipe sheet and the create sheet (RecipeEditor.svelte).
import { fmtAmount, parseAmount } from "./recipe";
import type { Recipe, RecipeDraft, RecipeInput } from "./types";

export type RecipeRow = {
  key: number;
  section: string;
  amount: string;
  unit: string;
  name: string;
  plural: string;
  note: string;
  prep: string;
  raw: string | null;
  sig: string;
  verified: boolean;
};
// draft: the values come from the AI and still need checking against the original text.
export type RecipeForm = { servings: string; instructions: string; rows: RecipeRow[]; draft: boolean };

export const MAX_INGREDIENTS = 60; // as in the server's repo.ts
const MAX_SERVINGS = 50;

let nextKey = 0;

// The signature says whether a row was touched: only an untouched row keeps its original line (raw).
export const sigOf = (r: Pick<RecipeRow, "amount" | "unit" | "name">) => [r.amount, r.unit, r.name].join("|");

// A line the AI changed or made up is marked until the user touches it.
export const isSuspicious = (r: RecipeRow) => !r.verified && r.sig === sigOf(r);

export function formFrom(r: Pick<Recipe, "servings" | "instructions" | "ingredients"> | RecipeDraft | null, draft = false): RecipeForm {
  return {
    servings: r?.servings == null ? "" : String(r.servings),
    instructions: r?.instructions ?? "",
    rows: (r?.ingredients ?? []).map((i) => {
      const row = { section: i.section ?? "", amount: fmtAmount(i), unit: i.unit ?? "", name: i.name, plural: i.plural ?? "", note: i.note ?? "", prep: i.prep ?? "" };
      return { key: nextKey++, ...row, raw: i.raw, sig: sigOf(row), verified: !("verified" in i) || i.verified === true };
    }),
    draft,
  };
}

// A new ingredient starts in the section of the previous one.
export function addRow(form: RecipeForm) {
  form.rows.push({ key: nextKey++, section: form.rows.at(-1)?.section ?? "", amount: "", unit: "", name: "", plural: "", note: "", prep: "", raw: null, sig: "", verified: true });
}

const isEmptyRow = (r: RecipeRow) => !r.name.trim() && !r.amount.trim() && !r.unit && !r.note.trim() && !r.prep.trim();

// Something typed or loaded that a new draft would replace.
export const hasInput = (form: RecipeForm) => !!form.servings.trim() || !!form.instructions.trim() || form.rows.some((r) => !isEmptyRow(r));

export const isEmptyInput = (r: RecipeInput) => r.servings === null && !r.instructions && r.ingredients.length === 0;

// Checks the form like the server would and turns it into what the API takes; empty rows are left out.
export function collectRecipe(form: RecipeForm): { recipe: RecipeInput } | { problem: string } {
  const sv = form.servings.trim() === "" ? null : Number(form.servings);
  if (sv !== null && (!Number.isInteger(sv) || sv < 1 || sv > MAX_SERVINGS)) return { problem: `Portionen: eine ganze Zahl von 1 bis ${MAX_SERVINGS}.` };
  const ingredients: RecipeInput["ingredients"] = [];
  for (const [n, r] of form.rows.entries()) {
    if (isEmptyRow(r)) continue;
    const a = parseAmount(r.amount);
    if (!a) return { problem: `Zutat ${n + 1}: Menge wie „1,5“ oder „1-2“ eintragen.` };
    if (!r.name.trim()) return { problem: `Zutat ${n + 1}: Bitte eine Zutat eintragen.` };
    ingredients.push({
      section: r.section.trim() || null,
      ...a,
      unit: r.unit || null,
      name: r.name.trim(),
      plural: r.plural.trim() || null,
      note: r.note.trim() || null,
      prep: r.prep.trim() || null,
      raw: r.raw !== null && r.sig === sigOf(r) ? r.raw : null,
    });
  }
  return { recipe: { servings: sv, instructions: form.instructions.trim() || null, ingredients } };
}
