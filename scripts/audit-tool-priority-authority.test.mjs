import assert from "node:assert/strict";
import test from "node:test";

import { auditToolPriorityAuthority } from "./audit-tool-priority-authority.mjs";

const runtimeItem = (id, priority, rollTicks = undefined) => ({
  id,
  tier: id.split("_")[0],
  tool: { skill: "mining", priority, rollTicks },
});
const legacyTool = (itemId, priority, rollTicks = undefined) => ({
  itemId,
  skill: "mining",
  priority,
  rollTicks,
  levelRequired: 1,
});

test("accepts one coherent lower-is-better authority", () => {
  const report = auditToolPriorityAuthority(
    [runtimeItem("bronze_pickaxe", 2, 8), runtimeItem("iron_pickaxe", 1, 7)],
    [legacyTool("bronze_pickaxe", 2, 8), legacyTool("iron_pickaxe", 1, 7)],
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.bestBySkill[0].runtimeBestShared, "iron_pickaxe");
  assert.equal(report.bestBySkill[0].legacyBestShared, "iron_pickaxe");
});

test("fails closed when shared tools reverse their authored ordering", () => {
  const report = auditToolPriorityAuthority(
    [runtimeItem("bronze_pickaxe", 1, 8), runtimeItem("rune_pickaxe", 6, 3)],
    [legacyTool("bronze_pickaxe", 8, 8), legacyTool("rune_pickaxe", 3, 3)],
  );
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("ordering_mismatch"));
  assert.ok(report.blockers.includes("best-tool-mismatch"));
  assert.equal(report.orderingConflicts.length, 1);
  assert.equal(report.bestBySkill[0].runtimeBestShared, "bronze_pickaxe");
  assert.equal(report.bestBySkill[0].legacyBestShared, "rune_pickaxe");
});

test("fails closed when either source contains a tool absent from the other", () => {
  const report = auditToolPriorityAuthority(
    [runtimeItem("bronze_pickaxe", 1)],
    [legacyTool("bronze_pickaxe", 1), legacyTool("crystal_pickaxe", 0)],
  );
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("source_membership_mismatch"));
  assert.deepEqual(report.legacyOnly, ["crystal_pickaxe"]);
});
