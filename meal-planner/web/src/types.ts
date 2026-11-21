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
  recipe?: RecipeInput; // only when a new dish is created; saved together with it
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
  name: string; // singular base form ("Zwiebel")
  plural: string | null; // "Zwiebeln"; null = none ("Mehl")
  note: string | null; // variety, relevant for shopping ("rot")
  prep: string | null; // preparation ("gewürfelt")
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
// What PUT …/recipe (and a new dish) takes; raw null = built by the server from amount, unit and name.
export type RecipeInput = Pick<Recipe, "servings" | "instructions"> & { ingredients: (Omit<Ingredient, "raw"> & { raw: string | null })[] };
export type RecipeDraft = Pick<Recipe, "servings" | "instructions"> & { ingredients: (Ingredient & { verified: boolean })[] };
// image: an AI task in Home Assistant can generate images ("Bild erzeugen").
export type AiStatus = { ai: boolean; reason: string | null; image: boolean };
export type Checks = { ingredients: number[]; steps: number[] }; // ticked in cook mode (positions)
export type CookEntry = {
  entry_id: number;
  dish_id: number;
  title: string;
  url: string | null;
  note: string | null; // note of the list entry
  done: boolean;
  recipe: Recipe;
  checks: Checks;
};
export type CheckState = { entry_id: number; done: boolean; checks: Checks };
// A to-do list in Home Assistant (e.g. Bring). description: it keeps a description ("Spezifikation") per item.
export type TodoList = { entity_id: string; name: string; description: boolean };
export type ShoppingStatus = { lists: TodoList[]; selected: string | null; reason: string | null };
export type ShoppingEntry = { entry_id: number; title: string; done: boolean; selected: boolean; has_recipe: boolean };
// key: unique per name and note (two items may share a name, e.g. "Nüsse" for Macadamia and for Walnuss).
// pantry: always at home (ingredient catalog), so the sheet starts with it unticked in a section of its own.
export type ShoppingItem = { key: string; name: string; note: string | null; spec: string | null; sources: string[]; on_list: boolean; pantry: boolean };
export type ShoppingList = { entries: ShoppingEntry[]; items: ShoppingItem[]; list_error: boolean };
export type SendResult = { added: number; failed: number; reason: string | null };

// Making the ingredients of one recipe uniform (see RecipeSheet).
export type IngredientChange = {
  pos: number; // position of the line in the recipe
  from: { name: string; note: string | null };
  to: { name: string; plural: string | null; note: string | null; prep: string | null };
  unit: string | null; // English unit taken out of the note; the server converts amount and unit
};

// An entry of the ingredient catalog (key = the name in lower case with single spaces, as the server groups names).
// pantry = marked itself; category_pantry = its category is always at home (then it is too, without exception).
export type CatalogIngredient = { key: string; name: string; dishes: number; pantry: boolean; category: string | null; category_pantry: boolean };
// A dish that uses an ingredient, with the matching recipe lines as written ("2 EL Olivenöl").
export type IngredientDish = { id: number; title: string; lines: string[] };
export type IngredientCategory = { key: string; name: string; pantry: boolean; ingredients: number };
// What renaming an ingredient touches; target is set when the new name is a known ingredient (then they are merged).
export type RenamePreview = {
  source: { name: string; plural: string | null; pantry: boolean };
  target: { name: string; plural: string | null; pantry: boolean; dishes: number } | null;
  dishes: { id: number; title: string }[];
  notes: string[];
};
