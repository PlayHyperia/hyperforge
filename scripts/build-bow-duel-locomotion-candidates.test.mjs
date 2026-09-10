import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BOW_CARRY_ARM_BONES,
  BOW_CARRY_BLEND_CANDIDATES,
  BOW_CARRY_REFERENCE,
  buildBowDuelLocomotionCandidates,
  candidateCombatMultiviewManifestFor,
  candidateCombatSequenceManifestFor,
  candidateMultiviewManifestFor,
} from "./build-bow-duel-locomotion-candidates.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("builds deterministic inactive bow locomotion candidates", async () => {
  const first = await buildBowDuelLocomotionCandidates(workspaceRoot);
  const replay = await buildBowDuelLocomotionCandidates(workspaceRoot);

  assert.equal(first.activationStatus, "inactive-candidate");
  assert.equal(first.approvedForRuntimeActivation, false);
  assert.equal(first.reference.asset, BOW_CARRY_REFERENCE.asset);
  assert.equal(first.reference.sampleRatio, BOW_CARRY_REFERENCE.sampleRatio);
  assert.deepEqual(first.armBones, [...BOW_CARRY_ARM_BONES]);
  assert.deepEqual(first.candidates, BOW_CARRY_BLEND_CANDIDATES);
  assert.equal(first.outputs.length, BOW_CARRY_BLEND_CANDIDATES.length * 3);
  assert.deepEqual(
    replay.outputs.map((output) => output.bytes),
    first.outputs.map((output) => output.bytes),
  );
  assert.deepEqual(
    replay.outputs.map(({ bytes: _bytes, ...output }) => output),
    first.outputs.map(({ bytes: _bytes, ...output }) => output),
  );

  for (const output of first.outputs) {
    assert.match(output.outputAsset, /^emotes\/candidates\/bow-carry-/u);
    assert.ok(!output.outputAsset.includes(".."));
    assert.ok(output.byteLength > 0);
    assert.match(output.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(output.validation.errors, 0);
    assert.equal(output.validation.warnings, 0);
    assert.equal(output.overrides.length, BOW_CARRY_ARM_BONES.length);
    assert.ok(output.overrides.every((override) => override.keyframeCount > 0));
  }

  const naturalWalk = first.outputs.find(
    (output) =>
      output.candidateId === "natural" && output.locomotionId === "walk",
  );
  assert.ok(naturalWalk);
  assert.equal(naturalWalk.blendStrength, null);
  assert.equal(naturalWalk.blendStrengthByBone["mixamorig:LeftHand"], 0.95);
  assert.equal(naturalWalk.blendStrengthByBone["mixamorig:RightArm"], 0.1);
  assert.equal(
    naturalWalk.overrides.find(
      (override) => override.boneName === "mixamorig:LeftHand",
    ).blendStrength,
    0.95,
  );

  for (const candidate of BOW_CARRY_BLEND_CANDIDATES) {
    const candidateIdle = first.outputs.find(
      (output) =>
        output.candidateId === candidate.id && output.locomotionId === "idle",
    );
    assert.ok(candidateIdle);
    const manifest = candidateMultiviewManifestFor(first.outputs, candidate.id);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.framing, "avatar-and-equipment");
    assert.equal(manifest.motions.length, 16);
    assert.ok(
      manifest.motions.every(
        (motion) =>
          motion.id.startsWith(`${candidate.id}-`) &&
          Number.isFinite(motion.cameraYawDegrees) &&
          motion.cameraPitchDegrees === 8,
      ),
    );

    const combatSequence = candidateCombatSequenceManifestFor(
      first.outputs,
      candidate.id,
    );
    assert.equal(combatSequence.schemaVersion, 1);
    assert.equal(combatSequence.framing, "avatar-and-equipment");
    assert.equal(combatSequence.motions.length, 15);
    assert.equal(
      combatSequence.motions.filter(
        (motion) => motion.heldEquipmentEmote === "range",
      ).length,
      11,
    );
    assert.ok(
      combatSequence.motions.every((motion) =>
        motion.id.startsWith(`${candidate.id}-`),
      ),
    );

    const combatMultiview = candidateCombatMultiviewManifestFor(
      first.outputs,
      candidate.id,
    );
    assert.equal(combatMultiview.schemaVersion, 1);
    assert.equal(combatMultiview.framing, "avatar-and-equipment");
    assert.equal(combatMultiview.motions.length, 44);
    assert.equal(
      combatMultiview.motions.filter(
        (motion) => motion.heldEquipmentEmote === "range",
      ).length,
      28,
    );
    assert.equal(
      combatMultiview.motions.filter((motion) => motion.hitReaction).length,
      16,
    );
    assert.deepEqual(
      [
        ...new Set(
          combatMultiview.motions.map((motion) => motion.cameraYawDegrees),
        ),
      ],
      [0, -90, 180, 90],
    );
    assert.ok(
      combatMultiview.motions
        .filter((motion) => motion.hitReaction)
        .every(
          (motion) =>
            motion.asset === candidateIdle.outputAsset &&
            [0.0504, 0.18].includes(motion.hitReaction.elapsedSeconds) &&
            [-1, 1].includes(motion.hitReaction.side),
        ),
    );
  }
});
