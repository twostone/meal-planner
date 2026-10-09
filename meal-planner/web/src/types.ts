export type Dish = {
  id: number;
  title: string;
  url: string | null;
  note: string | null;
  image: string | null; // file name in the server's image store
  created_at: string;
  tags: string[];
};
export type PlanSummary = {
  id: number;
  start_date: string;
  end_date: string;
  title: string | null; // optional name; null = shown as its date range
  created_at: string;
  entry_count: number;
  done_count: number;
};
export type Entry = {
  id: number;
  plan_id: number;
  dish_id: number;
  position: number;
  done: boolean;
  note: string | null; // only for this dish in this plan
  dish: Dish;
};
export type PlanDetail = {
  id: number;
  start_date: string;
  end_date: string;
  title: string | null;
  created_at: string;
  entries: Entry[];
};
export type DishInput = {
  title: string;
  url: string | null;
  note: string | null;
  image: string | null;
  tags: string[];
  source_text?: string | null; // only when a new dish is created from a link preview
  source_truncated?: boolean;
};
export type Preview = {
  title: string | null;
  image: string | null;
  titleSuggestions: string[];
  sourceText: string | null;
  sourceTruncated: boolean;
  reason: string | null;
};
export type Ingredient = {
  section: string | null;
  amount: number | null;
  amount_max: number | null; // only for ranges ("1-2")
  unit: string | null;
  name: string;
  note: string | null;
  raw: string; // original line
};
export type Recipe = {
  servings: number | null;
  instructions: string | null;
  ingredients: Ingredient[];
  source_text: string | null; // the recipe as found at the link, unchanged
  source_truncated: boolean; // the caption may have been cut off
};
// Same list as UNITS in the server's repo.ts. Counted things ("1 Zwiebel") have no unit.
export const UNITS = ["g", "kg", "ml", "l", "EL", "TL", "Prise", "Zehe", "Bund", "Dose", "Packung", "Becher", "Scheibe", "Handvoll"];
