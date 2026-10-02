import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { haState } from "../src/ha-state.ts";
import { createRepo } from "../src/repo.ts";

test("HA state: the name of a plan is part of current and next, null without a name", () => {
  const repo = createRepo(openDb(":memory:"));
  const cur = repo.createPlan({ start_date: "2026-09-26", end_date: "2026-10-02" });
  const nxt = repo.createPlan({ start_date: "2026-10-03", end_date: "2026-10-09" });
  repo.updatePlan(cur.id, { title: "Geburtstagswoche" });
  const s = haState(repo, new Date(2026, 8, 30, 12, 0, 0)); // 30.09.2026 local
  assert.equal(s.current?.id, cur.id);
  assert.equal(s.current?.title, "Geburtstagswoche");
  assert.equal(s.next?.id, nxt.id);
  assert.equal(s.next?.title, null);
});
