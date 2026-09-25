export type Dish = { id: number; title: string; url: string | null; note: string | null; created_at: string };
export type PlanSummary = {
  id: number;
  start_date: string;
  end_date: string;
  created_at: string;
  entry_count: number;
  done_count: number;
};
export type Entry = { id: number; plan_id: number; dish_id: number; position: number; done: boolean; dish: Dish };
export type PlanDetail = { id: number; start_date: string; end_date: string; created_at: string; entries: Entry[] };
export type DishInput = { title: string; url: string | null; note: string | null };
