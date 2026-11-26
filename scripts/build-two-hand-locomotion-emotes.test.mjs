import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTwoHandLocomotionCandidates,
  buildTwoHandTorsoCutCandidates,
  TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES,
  TWO_HAND_CARRY_PROFILES,
  TWO_HAND_CONTROLLED_GUARD_BONES,
  TWO_HAND_LOCOMOTION_CANDIDATES,
  TWO_HAND_STANCE_SAMPLE_RATIO,
  TWO_HAND_TORSO_CUT_CANDIDATES,
  TWO_HAND_UPPER_BODY_BONES,
  twoHandLocomotionProfileReviewManifestFor,
  twoHandCurrentAttackDenseReviewManifestFor,
  twoHandControlledTorsoCutReviewManifestFor,
  twoHandControlledGuardReviewManifestFor,
  twoHandForwardGuardReviewManifestFor,
  twoHandGroundedTorsoCutReviewManifestFor,
  twoHandHighGuardReviewManifestFor,
  twoHandMotionSourceComparisonManifestFor,
  twoHandPlantedTorsoCutReviewManifestFor,
  twoHandPlantedSweepTorsoCutReviewManifestFor,
  twoHandPlantedTransitionReportFor,
  twoHandStableCombatReviewManifestFor,
  twoHandStableDetailReviewManifestFor,
  twoHandTorsoCutReviewManifestFor,
  twoHandWoodcuttingAttackReviewManifestFor,
} from "./build-two-hand-locomotion-emotes.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("builds deterministic isolated two-hand locomotion candidates", async () => {
  const first = await buildTwoHandLocomotionCandidates(workspaceRoot);
  const second = await buildTwoHandLocomotionCandidates(workspaceRoot);

  assert.equal(first.approvedForRuntimeActivation, false);
  assert.equal(first.activationStatus, "isolated-candidate");
  assert.equal(first.stance.sampleRatio, TWO_HAND_STANCE_SAMPLE_RATIO);
  assert.equal(first.stanceSources.length, 2);
  assert.deepEqual(first.upperBodyBones, [...TWO_HAND_UPPER_BODY_BONES]);
  assert.deepEqual(
    first.profiles.map((profile) => profile.id),
    TWO_HAND_CARRY_PROFILES.map((profile) => profile.id),
  );
  assert.equal(first.outputs.length, TWO_HAND_LOCOMOTION_CANDIDATES.length);
  assert.deepEqual(
    first.outputs.map((output) => output.sha256),
    second.outputs.map((output) => output.sha256),
  );
  for (const output of first.outputs) {
    assert.ok(output.byteLength > 1_000);
    assert.ok(output.durationSeconds > 0);
    assert.ok(output.channelCount > TWO_HAND_UPPER_BODY_BONES.length);
    assert.equal(output.validation.errors, 0);
    assert.equal(output.validation.warnings, 0);
    assert.equal(output.validation.hints, 0);
    assert.deepEqual(
      output.overrides.map((override) => override.boneName),
      output.boneNames,
    );
    assert.ok(
      output.overrides.every(
        (override) =>
          override.keyframeCount >= 2 &&
          override.blendStrength >= 0 &&
          override.blendStrength <= 1 &&
          override.outputLoopSeamDegrees <= 0.1,
      ),
    );
  }
  for (const profile of TWO_HAND_CARRY_PROFILES) {
    const profileOutputs = first.outputs.filter(
      (output) => output.profileId === profile.id,
    );
    assert.deepEqual(
      profileOutputs.map((output) => output.locomotionId).sort(),
      profile.id === "high-guard" ||
        profile.id === "forward-guard" ||
        profile.id === "controlled-guard"
        ? ["idle", "run", "walk"]
        : ["run", "walk"],
    );
    for (const output of profileOutputs) {
      assert.deepEqual(output.strengthByBone, profile.strengthByBone);
      if (
        profile.id === "locked" ||
        profile.id === "high-guard" ||
        profile.id === "forward-guard" ||
        profile.id === "controlled-guard"
      ) {
        assert.ok(
          output.overrides.every((override) => override.outputLoopSeamExact),
        );
      } else {
        assert.ok(
          output.overrides.some(
            (override) =>
              override.maximumRetainedMotionDegrees >
              (output.locomotionId === "idle" ? 0.01 : 0.1),
          ),
        );
      }
    }
  }

  const reviewManifest = twoHandLocomotionProfileReviewManifestFor(
    first.outputs,
  );
  assert.equal(reviewManifest.schemaVersion, 1);
  assert.equal(reviewManifest.framing, "avatar-and-equipment");
  assert.equal(reviewManifest.motions.length, 36);
  assert.deepEqual(
    [...new Set(reviewManifest.motions.map((motion) => motion.sampleRatio))],
    [0.2, 0.5, 0.8],
  );
  assert.deepEqual(
    [...new Set(reviewManifest.motions.map((motion) => motion.asset))].sort(),
    first.outputs
      .filter((output) => output.locomotionId !== "idle")
      .map((output) => output.outputAsset)
      .sort(),
  );

  const combatManifest = twoHandStableCombatReviewManifestFor(first.outputs);
  assert.equal(combatManifest.schemaVersion, 1);
  assert.equal(combatManifest.framing, "avatar-and-equipment");
  assert.equal(combatManifest.motions.length, 64);
  assert.equal(
    combatManifest.motions.filter((motion) => motion.id.includes("-attack-"))
      .length,
    28,
  );
  assert.equal(
    combatManifest.motions.filter((motion) => motion.hitReaction).length,
    16,
  );
  assert.deepEqual(
    [
      ...new Set(
        combatManifest.motions.map((motion) => motion.cameraYawDegrees),
      ),
    ],
    [0, -90, 180, 90],
  );
  assert.ok(
    combatManifest.motions
      .filter((motion) => motion.id.includes("stable-walk"))
      .every((motion) => motion.asset.includes("-stable-candidate.glb")),
  );

  const denseReview = twoHandCurrentAttackDenseReviewManifestFor();
  assert.equal(denseReview.schemaVersion, 1);
  assert.equal(denseReview.framing, "avatar-and-equipment");
  assert.equal(denseReview.motions.length, 76);
  assert.deepEqual(
    [...new Set(denseReview.motions.map((motion) => motion.sampleRatio))],
    Array.from({ length: 19 }, (_value, index) => (index + 1) * 0.05),
  );

  const woodcuttingReview = twoHandWoodcuttingAttackReviewManifestFor();
  assert.equal(woodcuttingReview.schemaVersion, 1);
  assert.equal(woodcuttingReview.framing, "avatar-and-equipment");
  assert.equal(woodcuttingReview.motions.length, 28);
  assert.deepEqual(
    [
      ...new Set(
        woodcuttingReview.motions.map((motion) => motion.cameraYawDegrees),
      ),
    ],
    [0, -90, 180, 90],
  );
  assert.ok(
    woodcuttingReview.motions.every(
      (motion) =>
        motion.asset ===
          "packages/server/world/assets/emotes/emote-steve-woodcutting.glb" &&
        motion.heldEquipmentEmote === "2h-slash" &&
        motion.equipmentClearance.minimumFloorClearanceMetres === 0.1 &&
        motion.equipmentClearance.minimumBodySurfaceDistanceMetres === 0.08 &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.08,
    ),
  );

  const highGuardReview = twoHandHighGuardReviewManifestFor(first.outputs);
  assert.equal(highGuardReview.schemaVersion, 1);
  assert.equal(highGuardReview.framing, "avatar-and-equipment");
  assert.equal(highGuardReview.motions.length, 28);
  assert.deepEqual(
    [
      ...new Set(
        highGuardReview.motions.map((motion) => motion.cameraYawDegrees),
      ),
    ],
    [0, -90, 180, 90],
  );

  const forwardGuardReview = twoHandForwardGuardReviewManifestFor(
    first.outputs,
  );
  assert.equal(forwardGuardReview.schemaVersion, 1);
  assert.equal(forwardGuardReview.framing, "avatar-and-equipment");
  assert.equal(forwardGuardReview.motions.length, 28);
  assert.ok(
    forwardGuardReview.motions.every(
      (motion) =>
        motion.asset.includes("-forward-guard-candidate.glb") &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.15,
    ),
  );

  const controlledGuardReview = twoHandControlledGuardReviewManifestFor(
    first.outputs,
  );
  assert.equal(controlledGuardReview.schemaVersion, 1);
  assert.equal(controlledGuardReview.framing, "avatar-and-equipment");
  assert.equal(controlledGuardReview.motions.length, 28);
  assert.ok(
    controlledGuardReview.motions.every(
      (motion) =>
        motion.asset.includes("-controlled-guard-candidate.glb") &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.08,
    ),
  );
  const controlledOutputs = first.outputs.filter(
    (output) => output.profileId === "controlled-guard",
  );
  assert.equal(controlledOutputs.length, 3);
  assert.ok(
    controlledOutputs.every(
      (output) =>
        output.boneNames.length === TWO_HAND_CONTROLLED_GUARD_BONES.length &&
        output.controlledGuardLinearization.samplerCount ===
          output.channelCount &&
        output.controlledGuardLinearization.remainingStepSamplerCount === 0 &&
        output.controlledGuardTimeline.inputAccessorCount >= 1 &&
        output.controlledGuardTimeline.originalStartSeconds > 0.03 &&
        output.controlledGuardTimeline.originalStartSeconds < 0.034 &&
        output.controlledGuardTimeline.normalizedStartSeconds === 0 &&
        output.durationSeconds ===
          output.controlledGuardTimeline.durationSecondsAfterNormalization &&
        output.controlledGuardLoopSeam.closedChannelCount ===
          output.channelCount &&
        output.controlledGuardLoopSeam.exactAfterClosure === true &&
        output.boneNames.every(
          (boneName, index) =>
            boneName === TWO_HAND_CONTROLLED_GUARD_BONES[index],
        ),
    ),
  );
  assert.ok(
    controlledOutputs.some(
      (output) => output.controlledGuardLinearization.convertedSamplerCount > 0,
    ),
  );
  const controlledRun = controlledOutputs.find(
    (output) => output.locomotionId === "run",
  );
  const controlledWalk = controlledOutputs.find(
    (output) => output.locomotionId === "walk",
  );
  assert.ok(controlledRun);
  assert.ok(controlledWalk);
  for (const output of [controlledWalk, controlledRun]) {
    assert.ok(
      output.controlledGuardLowerBodySmoothing.evaluatedChannelCount >= 8,
    );
    assert.ok(
      output.controlledGuardLowerBodySmoothing.missingBoneNames.every(
        (boneName) => boneName.endsWith("Toe_End"),
      ),
    );
    assert.ok(
      output.controlledGuardLowerBodySmoothing.smoothedChannelCount >= 8,
    );
    assert.equal(
      output.controlledGuardLowerBodySmoothing.passCount,
      output.locomotionId === "run" ? 3 : 2,
    );
    assert.ok(
      output.controlledGuardLowerBodySmoothing.maximumAdjustmentDegrees > 1,
    );
  }
  assert.ok(
    highGuardReview.motions.every(
      (motion) =>
        motion.asset.includes("-high-guard-candidate.glb") &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.08,
    ),
  );

  const detailManifest = twoHandStableDetailReviewManifestFor(first.outputs);
  assert.equal(detailManifest.schemaVersion, 1);
  assert.equal(detailManifest.framing, "avatar-and-equipment");
  assert.equal(detailManifest.motions.length, 12);
  assert.equal(
    detailManifest.motions.filter((motion) => motion.id.includes("-impact-"))
      .length,
    4,
  );
  assert.equal(
    detailManifest.motions.filter((motion) => motion.id.includes("-wind-up-"))
      .length,
    2,
  );

  const sourceComparison = twoHandMotionSourceComparisonManifestFor();
  assert.equal(sourceComparison.schemaVersion, 1);
  assert.equal(sourceComparison.framing, "avatar-and-equipment");
  assert.equal(sourceComparison.motions.length, 64);
  assert.equal(
    sourceComparison.motions.filter((motion) => motion.id.includes("-attack-"))
      .length,
    56,
  );
  assert.deepEqual(
    [...new Set(sourceComparison.motions.map((motion) => motion.asset))].sort(),
    [
      "artifacts/duel-launch-avatar-bakeoff/motions/kaykit-two-hand-idle.glb",
      "artifacts/duel-launch-avatar-bakeoff/motions/kaykit-two-hand-slash.glb",
      "packages/server/world/assets/emotes/emote-2h-idle.glb",
      "packages/server/world/assets/emotes/emote-2h-slash.glb",
    ],
  );
  assert.ok(
    sourceComparison.motions.every(
      (motion) =>
        motion.equipmentClearance.minimumFloorClearanceMetres === 0.1 &&
        motion.equipmentClearance.minimumBodySurfaceDistanceMetres === 0.08 &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.08,
    ),
  );
});

test("builds deterministic isolated controlled torso-cut candidates", async () => {
  const first = await buildTwoHandTorsoCutCandidates(workspaceRoot);
  const second = await buildTwoHandTorsoCutCandidates(workspaceRoot);

  assert.equal(first.approvedForRuntimeActivation, false);
  assert.equal(first.activationStatus, "isolated-candidate");
  assert.equal(first.outputs.length, TWO_HAND_TORSO_CUT_CANDIDATES.length);
  assert.deepEqual(
    first.outputs.map((output) => output.sha256),
    second.outputs.map((output) => output.sha256),
  );
  for (const output of first.outputs) {
    assert.ok(output.byteLength > 1_000);
    assert.equal(output.referenceSampleRatio, 0.35);
    assert.deepEqual(output.dynamicLowerBodyBones, [
      ...TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES,
    ]);
    assert.ok(
      output.maximumObservedTwistDegrees <= output.maximumTwistDegrees &&
        output.maximumObservedTwistDegrees >= output.maximumTwistDegrees * 0.97,
    );
    assert.equal(output.validation.errors, 0);
    assert.equal(output.validation.warnings, 0);
    assert.equal(output.validation.hints, 0);
  }
  const planted = first.outputs.find((output) => output.id === "planted-20");
  assert.ok(planted);
  assert.ok(Math.abs(planted.durationSeconds - 1.3) <= 0.000001);
  assert.equal(planted.retiming.targetDurationSeconds, 1.3);
  assert.ok(planted.retiming.sourceDurationSeconds > 4);
  assert.ok(planted.retiming.timeScale > 0.29);
  assert.ok(planted.retiming.timeScale < 0.3);
  assert.equal(planted.loopSeam.closedChannelCount, planted.channelCount);
  assert.equal(planted.loopSeam.exactAfterClosure, true);

  const reviewManifest = twoHandTorsoCutReviewManifestFor(first.outputs);
  assert.equal(reviewManifest.schemaVersion, 1);
  assert.equal(reviewManifest.framing, "avatar-and-equipment");
  assert.equal(reviewManifest.motions.length, 140);
  assert.deepEqual(
    [...new Set(reviewManifest.motions.map((motion) => motion.asset))].sort(),
    first.outputs.map((output) => output.outputAsset).sort(),
  );
  assert.ok(
    reviewManifest.motions.every(
      (motion) =>
        motion.heldEquipmentEmote === "2h-slash" &&
        motion.equipmentClearance.minimumFloorClearanceMetres === 0.1 &&
        motion.equipmentClearance.minimumBodySurfaceDistanceMetres === 0.08 &&
        motion.equipmentClearance.maximumProjectedBodyOverlapRatio === 0.08,
    ),
  );

  const selectedReviewManifest = twoHandControlledTorsoCutReviewManifestFor(
    first.outputs,
  );
  assert.equal(selectedReviewManifest.schemaVersion, 1);
  assert.equal(selectedReviewManifest.framing, "avatar-and-equipment");
  assert.equal(selectedReviewManifest.motions.length, 28);
  assert.ok(
    selectedReviewManifest.motions.every(
      (motion) =>
        motion.id.startsWith("controlled-20-") &&
        motion.asset ===
          "emotes/candidates/emote-2h-torso-cut-steve-controlled-20-candidate.glb",
    ),
  );

  const groundedReviewManifest = twoHandGroundedTorsoCutReviewManifestFor(
    first.outputs,
  );
  assert.equal(groundedReviewManifest.schemaVersion, 1);
  assert.equal(groundedReviewManifest.framing, "avatar-and-equipment");
  assert.equal(groundedReviewManifest.motions.length, 28);
  assert.ok(
    groundedReviewManifest.motions.every(
      (motion) =>
        motion.id.startsWith("grounded-20-") &&
        motion.asset ===
          "emotes/candidates/emote-2h-grounded-cut-steve-controlled-20-candidate.glb",
    ),
  );

  const plantedReviewManifest = twoHandPlantedTorsoCutReviewManifestFor(
    first.outputs,
  );
  assert.equal(plantedReviewManifest.schemaVersion, 1);
  assert.equal(plantedReviewManifest.framing, "avatar-and-equipment");
  assert.equal(plantedReviewManifest.motions.length, 28);
  assert.ok(
    plantedReviewManifest.motions.every(
      (motion) =>
        motion.id.startsWith("planted-20-") &&
        motion.asset ===
          "emotes/candidates/emote-2h-planted-cut-steve-controlled-20-candidate.glb",
    ),
  );

  const plantedSweepReviewManifest =
    twoHandPlantedSweepTorsoCutReviewManifestFor(first.outputs);
  assert.equal(plantedSweepReviewManifest.schemaVersion, 1);
  assert.equal(plantedSweepReviewManifest.framing, "avatar-and-equipment");
  assert.equal(plantedSweepReviewManifest.motions.length, 28);
  assert.ok(
    plantedSweepReviewManifest.motions.every(
      (motion) =>
        motion.id.startsWith("planted-45-") &&
        motion.asset ===
          "emotes/candidates/emote-2h-planted-cut-steve-controlled-45-candidate.glb",
    ),
  );

  const locomotion = await buildTwoHandLocomotionCandidates(workspaceRoot);
  const transitionReport = await twoHandPlantedTransitionReportFor(
    locomotion.outputs,
    first.outputs,
  );
  assert.equal(transitionReport.approvedForRuntimeActivation, false);
  assert.equal(transitionReport.activationStatus, "isolated-candidate");
  assert.equal(transitionReport.passed, true);
  assert.equal(transitionReport.transitions.length, 2);
  for (const transition of transitionReport.transitions) {
    assert.equal(transition.sharedChannelCount, 195);
    assert.equal(transition.rotationChannelCount, 65);
    assert.equal(transition.linearChannelCount, 130);
    assert.equal(transition.gripCriticalRotationChannelCount, 34);
    assert.deepEqual(transition.missingFromDestination, []);
    assert.deepEqual(transition.missingFromSource, []);
    assert.ok(
      transition.maximumRotationDeltaDegrees <=
        transitionReport.thresholds.maximumRotationDeltaDegrees,
    );
    assert.ok(
      transition.maximumLinearDelta <=
        transitionReport.thresholds.maximumLinearDelta,
    );
  }
});
