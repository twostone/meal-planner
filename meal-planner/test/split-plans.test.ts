import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_PAST_PLANS, splitPlans } from "../web/src/util.ts";

const TODAY = "2026-11-27";
// Newest first, as GET /api/plans sends them: one future, the current one, then five finished weeks.
const plans = [
  { id: 7, end_date: "2026-12-11" },
  { id: 6, end_date: "2026-12-04" },
  { id: 5, end_date: "2026-11-27" }, // ends today: still current
  { id: 4, end_date: "2026-11-20" },
  { id: 3, end_date: "2026-11-13" },
  { id: 2, end_date: "2026-11-06" },
  { id: 1, end_date: "2026-10-30" },
];
const ids = (ps: { id: number }[]) => ps.map((p) => p.id);

test("current and future lists stay, only the most recent finished ones join them", () => {
  const { recent, older } = splitPlans(plans, TODAY, 5);
  assert.equal(RECENT_PAST_PLANS, 2);
  assert.deepEqual(ids(recent), [7, 6, 5, 4, 3]);
  assert.deepEqual(ids(older), [2, 1]);
});

test("the selected list stays visible even when it is old, and the order is kept", () => {
  const { recent, older } = splitPlans(plans, TODAY, 1);
  assert.deepEqual(ids(recent), [7, 6, 5, 4, 3, 1]);
  assert.deepEqual(ids(older), [2]);
});

test("few lists: nothing is hidden", () => {
  assert.deepEqual(ids(splitPlans(plans.slice(0, 4), TODAY, null).older), []);
  assert.deepEqual(splitPlans([], TODAY, null), { recent: [], older: [] });
});
