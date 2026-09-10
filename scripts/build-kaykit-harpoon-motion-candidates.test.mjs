import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseGlbJson } from "./audit-avatar-lods.mjs";
import {
  buildKayKitHarpoonMotionCandidates,
  HARPOON_WATER_STRIKE_CLIPS,
  warpNormalizedAnimationTime,
} from "./build-kaykit-harpoon-motion-candidates.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("extracts exact deterministic CC0 water-strike motion candidates", async () => {
  const first = await buildKayKitHarpoonMotionCandidates(WORKSPACE_ROOT);
  const second = await buildKayKitHarpoonMotionCandidates(WORKSPACE_ROOT);
  assert.equal(first.activationStatus, "not-activated");
  assert.equal(first.approvedForRuntimeActivation, false);
  assert.equal(first.provenance.license, "CC0-1.0");
  assert.deepEqual(
    first.outputs.map((output) => output.sha256),
    second.outputs.map((output) => output.sha256),
  );
  assert.deepEqual(
    first.outputs.map((output) => output.clip),
    HARPOON_WATER_STRIKE_CLIPS.map((candidate) => candidate.clip),
  );

  for (const output of first.outputs) {
    const document = parseGlbJson(output.bytes, output.outputFile);
    assert.equal(document.animations?.length, 1);
    assert.equal(document.animations?.[0]?.name, output.outputClip);
    assert.ok(output.durationSeconds > 0);
    assert.ok(output.channelCount >= 50);
    assert.equal(output.validator.errors, 0);
  }
  const shifted = first.outputs.find((output) => output.id === "water-strike");
  assert.equal(shifted?.shiftStartFrame, 17);
  assert.equal(shifted?.targetDurationSeconds, 1.2);
  assert.ok(Math.abs((shifted?.durationSeconds ?? 0) - 1.2) < 1e-6);
  assert.equal(shifted?.loopSeamExact, true);
  assert.deepEqual(shifted?.validator, {
    errors: 0,
    warnings: 0,
    infos: 5,
    hints: 0,
    infoCodes: ["NODE_EMPTY"],
  });

  const steve = first.outputs.find(
    (output) => output.id === "steve-water-strike",
  );
  assert.equal(steve?.outputClip, "Hyperia_Steve_Harpoon_Water_Strike");
  assert.ok(Math.abs((steve?.durationSeconds ?? 0) - 1.2) < 1e-6);
  assert.deepEqual(steve?.timeWarpControlPoints, [
    [0, 0],
    [0.4, 0.2],
    [0.775, 0.5],
    [0.82, 0.9],
    [1, 1],
  ]);
  assert.deepEqual(steve?.validator, shifted?.validator);
});

test("warps source keyframe time monotonically while preserving endpoints", () => {
  const points = [
    [0, 0],
    [0.4, 0.2],
    [0.775, 0.5],
    [0.82, 0.9],
    [1, 1],
  ];
  assert.equal(warpNormalizedAnimationTime(0, points), 0);
  assert.equal(warpNormalizedAnimationTime(0.4, points), 0.2);
  assert.equal(warpNormalizedAnimationTime(0.775, points), 0.5);
  assert.equal(warpNormalizedAnimationTime(0.82, points), 0.9);
  assert.equal(warpNormalizedAnimationTime(1, points), 1);
  assert.ok(
    warpNormalizedAnimationTime(0.6, points) >
      warpNormalizedAnimationTime(0.5, points),
  );
  assert.throws(
    () =>
      warpNormalizedAnimationTime(0.5, [
        [0, 0],
        [0.5, 0.6],
        [0.5, 0.8],
        [1, 1],
      ]),
    /strictly increasing/u,
  );
  assert.throws(
    () =>
      warpNormalizedAnimationTime(0.5, [
        [0.1, 0],
        [1, 1],
      ]),
    /preserve both clip endpoints/u,
  );
});

test("keeps candidate paths isolated from active world assets", async () => {
  const report = await buildKayKitHarpoonMotionCandidates(WORKSPACE_ROOT);
  for (const output of report.outputs) {
    assert.match(
      output.path,
      /^artifacts\/duel-launch-avatar-bakeoff\/motions\/harpoon-water-strike-candidates\//u,
    );
    assert.ok(!output.path.includes("packages/server/world"));
  }
});
