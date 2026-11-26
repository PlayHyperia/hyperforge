import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPreparationToolTierCandidate,
  triangleMatchesHeadSelector,
} from "./build-kaykit-preparation-tool-tiers.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const config = JSON.parse(
  readFileSync(
    path.join(workspaceRoot, "scripts/kaykit-preparation-tool-tiers.json"),
    "utf8",
  ),
);

test("classifies the hatchet and pickaxe heads without accepting their handles", () => {
  const hatchet = config.families.find((family) => family.id === "hatchet");
  const pickaxe = config.families.find((family) => family.id === "pickaxe");
  assert.equal(
    triangleMatchesHeadSelector(
      [
        [-0.4, 0.4, 0],
        [-0.2, 0.6, 0],
        [-0.3, 0.7, 0],
      ],
      hatchet.headSelector,
    ),
    true,
  );
  assert.equal(
    triangleMatchesHeadSelector(
      [
        [0, -0.2, 0],
        [0.05, 0.2, 0],
        [-0.05, 0.4, 0],
      ],
      hatchet.headSelector,
    ),
    false,
  );
  assert.equal(
    triangleMatchesHeadSelector(
      [
        [-0.7, 0.9, 0],
        [0, 1, 0],
        [0.7, 0.9, 0],
      ],
      pickaxe.headSelector,
    ),
    true,
  );
  assert.equal(
    triangleMatchesHeadSelector(
      [
        [-0.05, 0.9, 0],
        [0, 1, 0],
        [0.05, 1.1, 0],
      ],
      pickaxe.headSelector,
    ),
    false,
  );
});

test("classifies authored metal and wood regions by their non-overlapping UV bands", () => {
  const selector = { centroidUvVLessThan: 0.25 };
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  assert.equal(
    triangleMatchesHeadSelector(points, selector, [
      [0.8, 0.1],
      [0.9, 0.2],
      [0.85, 0.15],
    ]),
    true,
  );
  assert.equal(
    triangleMatchesHeadSelector(points, selector, [
      [0.8, 0.3],
      [0.9, 0.4],
      [0.85, 0.35],
    ]),
    false,
  );
  assert.throws(
    () => triangleMatchesHeadSelector(points, selector),
    /requires three finite VEC2 coordinates/u,
  );
  const greaterSelector = { centroidUvVGreaterThan: 0.25 };
  assert.equal(
    triangleMatchesHeadSelector(points, greaterSelector, [
      [0.8, 0.3],
      [0.9, 0.4],
      [0.85, 0.35],
    ]),
    true,
  );
  assert.equal(
    triangleMatchesHeadSelector(points, greaterSelector, [
      [0.8, 0.1],
      [0.9, 0.2],
      [0.85, 0.15],
    ]),
    false,
  );
});

test("builds deterministic exact-item candidates and preserves the source bytes", () => {
  for (const family of config.families) {
    const source = readFileSync(path.join(workspaceRoot, family.sourcePath));
    const sourceBefore = Buffer.from(source);
    const tier = config.tiers[0];
    const definition = {
      source,
      avatarId: config.avatarId,
      familyId: family.id,
      tierId: tier.id,
      priority: tier.priority,
      itemId: `${tier.id}_${family.id}`,
      sourceCandidateItemId: family.sourceCandidateItemId,
      sourceSha256: family.sourceSha256,
      headSelector: family.headSelector,
      headMaterial: tier.headMaterial,
    };
    const first = buildPreparationToolTierCandidate(definition);
    const second = buildPreparationToolTierCandidate(definition);
    assert.deepEqual(first.output, second.output);
    assert.deepEqual(source, sourceBefore);
    assert.equal(first.report.itemId, `${tier.id}_${family.id}`);
    assert.equal(first.report.fitAuthority.itemId, `${tier.id}_${family.id}`);
    assert.deepEqual(first.report.fitAuthority.compatibleAvatarIds, [
      "kaykit-knight",
    ]);
    assert.equal(first.report.primitiveCount, 2);
    assert.equal(first.report.materialCount, 2);
    assert.equal(
      first.report.handleTriangleCount + first.report.headTriangleCount,
      first.report.triangleCount,
    );
    assert.ok(first.report.handleTriangleCount > 0);
    assert.ok(first.report.headTriangleCount > 0);
    assert.equal(first.report.activeRuntimePath, false);
  }
});

test("fails closed on source drift and incomplete selectors", () => {
  const family = config.families[0];
  const tier = config.tiers[0];
  const source = readFileSync(path.join(workspaceRoot, family.sourcePath));
  const definition = {
    source,
    avatarId: config.avatarId,
    familyId: family.id,
    tierId: tier.id,
    priority: tier.priority,
    itemId: `${tier.id}_${family.id}`,
    sourceCandidateItemId: family.sourceCandidateItemId,
    sourceSha256: "0".repeat(64),
    headSelector: family.headSelector,
    headMaterial: tier.headMaterial,
  };
  assert.throws(
    () => buildPreparationToolTierCandidate(definition),
    /definition is invalid/u,
  );
  assert.throws(
    () =>
      triangleMatchesHeadSelector(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        { centroidAxis: "x" },
      ),
    /exactly one centroid threshold/u,
  );
});
