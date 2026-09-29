import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";

test("getPlanOn: the plan containing the day, else null (no fallback)", () => {
  const repo = createRepo(openDb(":memory:"));
  assert.equal(repo.getPlanOn("2026-09-30"), null);
  const a = repo.createPlan({ start_date: "2026-09-26", end_date: "2026-10-02" });
  assert.equal(repo.getPlanOn("2026-09-26")!.id, a.id); // boundaries are inclusive
  assert.equal(repo.getPlanOn("2026-10-02")!.id, a.id);
  assert.equal(repo.getPlanOn("2026-10-03"), null);
  assert.equal(repo.getPlanOn("2026-09-25"), null);
});

test("getNextPlan: earliest plan starting after the day, not the newest by id", () => {
  const repo = createRepo(openDb(":memory:"));
  assert.equal(repo.getNextPlan("2026-09-30"), null);
  repo.createPlan({ start_date: "2026-10-10", end_date: "2026-10-16" });
  const near = repo.createPlan({ start_date: "2026-10-03", end_date: "2026-10-09" });
  assert.equal(repo.getNextPlan("2026-09-30")!.id, near.id);
  assert.equal(repo.getNextPlan("2026-10-03")!.start_date, "2026-10-10"); // starting today is current, not next
});
