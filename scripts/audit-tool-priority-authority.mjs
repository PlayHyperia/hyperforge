#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_RUNTIME =
  "packages/server/world/assets/manifests/items/tools.json";
const DEFAULT_LEGACY = "packages/server/world/assets/manifests/tools.json";
const DEFAULT_REPORT =
  "artifacts/agent-preparation/tool-priority-authority-audit.json";

function normalizeRuntime(items) {
  return items
    .filter((item) => item?.tool)
    .map((item) => ({
      itemId: item.id,
      skill: item.tool.skill,
      priority: item.tool.priority,
      rollTicks: item.tool.rollTicks ?? null,
      levelAuthority:
        item.requirements?.skills?.[item.tool.skill] ??
        (item.tier ? `derived:${item.tier}` : "default:1"),
    }));
}

function normalizeLegacy(tools) {
  return tools.map((tool) => ({
    itemId: tool.itemId,
    skill: tool.skill,
    priority: tool.priority,
    rollTicks: tool.rollTicks ?? null,
    levelAuthority: tool.levelRequired,
  }));
}

function validateEntries(entries, source) {
  const issues = [];
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry.itemId !== "string" || entry.itemId.length === 0) {
      issues.push(`${source}: itemId must be a nonempty string`);
      continue;
    }
    if (ids.has(entry.itemId)) {
      issues.push(`${source}: duplicate itemId ${entry.itemId}`);
    }
    ids.add(entry.itemId);
    if (typeof entry.skill !== "string" || entry.skill.length === 0) {
      issues.push(`${source}: ${entry.itemId} has no skill`);
    }
    if (!Number.isFinite(entry.priority)) {
      issues.push(`${source}: ${entry.itemId} has a nonnumeric priority`);
    }
    if (entry.rollTicks !== null && !Number.isFinite(entry.rollTicks)) {
      issues.push(`${source}: ${entry.itemId} has invalid rollTicks`);
    }
  }
  return issues;
}

function best(entries) {
  return [...entries].sort(
    (left, right) =>
      left.priority - right.priority || left.itemId.localeCompare(right.itemId),
  )[0]?.itemId;
}

export function auditToolPriorityAuthority(runtimeItems, legacyTools) {
  const runtime = normalizeRuntime(runtimeItems);
  const legacy = normalizeLegacy(legacyTools);
  const validationIssues = [
    ...validateEntries(runtime, "runtime-items"),
    ...validateEntries(legacy, "legacy-tools"),
  ];
  const runtimeById = new Map(runtime.map((entry) => [entry.itemId, entry]));
  const legacyById = new Map(legacy.map((entry) => [entry.itemId, entry]));
  const sharedIds = [...runtimeById.keys()]
    .filter((itemId) => legacyById.has(itemId))
    .sort();
  const runtimeOnly = [...runtimeById.keys()]
    .filter((itemId) => !legacyById.has(itemId))
    .sort();
  const legacyOnly = [...legacyById.keys()]
    .filter((itemId) => !runtimeById.has(itemId))
    .sort();
  const fieldConflicts = sharedIds.flatMap((itemId) => {
    const runtimeEntry = runtimeById.get(itemId);
    const legacyEntry = legacyById.get(itemId);
    const conflicts = [];
    for (const field of ["skill", "priority", "rollTicks"]) {
      if (runtimeEntry[field] !== legacyEntry[field]) {
        conflicts.push({
          itemId,
          field,
          runtime: runtimeEntry[field],
          legacy: legacyEntry[field],
        });
      }
    }
    return conflicts;
  });

  const orderingConflicts = [];
  const skills = [
    ...new Set(sharedIds.map((id) => runtimeById.get(id).skill)),
  ].sort();
  const bestBySkill = [];
  for (const skill of skills) {
    const ids = sharedIds.filter(
      (id) =>
        runtimeById.get(id).skill === skill &&
        legacyById.get(id).skill === skill,
    );
    const runtimeEntries = ids.map((id) => runtimeById.get(id));
    const legacyEntries = ids.map((id) => legacyById.get(id));
    bestBySkill.push({
      skill,
      runtimeBestShared: best(runtimeEntries),
      legacyBestShared: best(legacyEntries),
      runtimeBestAll: best(runtime.filter((entry) => entry.skill === skill)),
      legacyBestAll: best(legacy.filter((entry) => entry.skill === skill)),
    });
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < ids.length;
        rightIndex += 1
      ) {
        const leftId = ids[leftIndex];
        const rightId = ids[rightIndex];
        const runtimeOrder = Math.sign(
          runtimeById.get(leftId).priority - runtimeById.get(rightId).priority,
        );
        const legacyOrder = Math.sign(
          legacyById.get(leftId).priority - legacyById.get(rightId).priority,
        );
        if (runtimeOrder !== legacyOrder) {
          orderingConflicts.push({
            skill,
            leftId,
            rightId,
            runtimeOrder,
            legacyOrder,
          });
        }
      }
    }
  }

  const blockers = [];
  if (validationIssues.length > 0) blockers.push("invalid_entries");
  if (runtimeOnly.length > 0 || legacyOnly.length > 0) {
    blockers.push("source_membership_mismatch");
  }
  if (fieldConflicts.length > 0) blockers.push("field_mismatch");
  if (orderingConflicts.length > 0) blockers.push("ordering_mismatch");
  if (
    bestBySkill.some(
      (entry) => entry.runtimeBestShared !== entry.legacyBestShared,
    )
  ) {
    blockers.push("best-tool-mismatch");
  }

  return {
    ok: blockers.length === 0,
    contract: {
      runtimeAuthority: DEFAULT_RUNTIME,
      runtimeSelection: "lower numeric priority is better",
      legacyAuthority: DEFAULT_LEGACY,
      policy:
        "conflicts fail closed; this audit does not choose progression balance",
    },
    counts: {
      runtime: runtime.length,
      legacy: legacy.length,
      shared: sharedIds.length,
      runtimeOnly: runtimeOnly.length,
      legacyOnly: legacyOnly.length,
      fieldConflicts: fieldConflicts.length,
      orderingConflicts: orderingConflicts.length,
    },
    blockers,
    validationIssues,
    runtimeOnly,
    legacyOnly,
    bestBySkill,
    fieldConflicts,
    orderingConflicts,
  };
}

async function main() {
  const values = parseArgs({
    options: {
      runtime: { type: "string", default: DEFAULT_RUNTIME },
      legacy: { type: "string", default: DEFAULT_LEGACY },
      report: { type: "string", default: DEFAULT_REPORT },
      check: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
  const runtimePath = path.resolve(values.runtime);
  const legacyPath = path.resolve(values.legacy);
  const reportPath = path.resolve(values.report);
  const [runtimeItems, legacyTools] = await Promise.all([
    fs.readFile(runtimePath, "utf8").then(JSON.parse),
    fs.readFile(legacyPath, "utf8").then(JSON.parse),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    runtimePath,
    legacyPath,
    ...auditToolPriorityAuthority(runtimeItems, legacyTools),
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (values.check && !report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
