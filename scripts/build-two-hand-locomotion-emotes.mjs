#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import validator from "gltf-validator";
import { Quaternion, Vector3 } from "three";

export const TWO_HAND_STANCE_SAMPLE_RATIO = 0.4;

export const TWO_HAND_UPPER_BODY_BONES = Object.freeze([
  "mixamorig:LeftShoulder",
  "mixamorig:LeftArm",
  "mixamorig:LeftForeArm",
  "mixamorig:LeftHand",
  "mixamorig:RightShoulder",
  "mixamorig:RightArm",
  "mixamorig:RightForeArm",
  "mixamorig:RightHand",
]);

const TWO_HAND_FINGER_BONES = Object.freeze(
  ["Left", "Right"].flatMap((side) =>
    ["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap((finger) =>
      [1, 2, 3].map((segment) => `mixamorig:${side}Hand${finger}${segment}`),
    ),
  ),
);

export const TWO_HAND_CONTROLLED_GUARD_BONES = Object.freeze([
  "mixamorig:Hips",
  "mixamorig:Spine",
  "mixamorig:Spine1",
  "mixamorig:Spine2",
  "mixamorig:Neck",
  "mixamorig:Head",
  ...TWO_HAND_UPPER_BODY_BONES,
  ...TWO_HAND_FINGER_BONES,
]);
const TWO_HAND_CONTROLLED_GUARD_STRENGTH_BY_BONE = Object.freeze(
  Object.fromEntries(
    TWO_HAND_CONTROLLED_GUARD_BONES.map((boneName) => [boneName, 1]),
  ),
);

export const TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES = Object.freeze([
  "mixamorig:RightUpLeg",
  "mixamorig:RightLeg",
  "mixamorig:RightFoot",
  "mixamorig:RightToeBase",
  "mixamorig:RightToe_End",
  "mixamorig:LeftUpLeg",
  "mixamorig:LeftLeg",
  "mixamorig:LeftFoot",
  "mixamorig:LeftToeBase",
  "mixamorig:LeftToe_End",
]);

const STANCE_ASSET = "emotes/emote-2h-idle.glb";
const HIGH_GUARD_STANCE_ASSET = "emotes/emote-2h-slash.glb";
const HIGH_GUARD_STANCE_SAMPLE_RATIO = 0.35;
const FORWARD_GUARD_STANCE_SAMPLE_RATIO = 0.3;

export const TWO_HAND_CARRY_PROFILES = Object.freeze([
  {
    id: "natural",
    name: "Natural guarded carry",
    strengthByBone: Object.freeze({
      "mixamorig:LeftShoulder": 0.65,
      "mixamorig:LeftArm": 0.88,
      "mixamorig:LeftForeArm": 0.96,
      "mixamorig:LeftHand": 0.99,
      "mixamorig:RightShoulder": 0.65,
      "mixamorig:RightArm": 0.88,
      "mixamorig:RightForeArm": 0.96,
      "mixamorig:RightHand": 0.99,
    }),
  },
  {
    id: "stable",
    name: "Stable guarded carry",
    strengthByBone: Object.freeze({
      "mixamorig:LeftShoulder": 0.8,
      "mixamorig:LeftArm": 0.94,
      "mixamorig:LeftForeArm": 0.98,
      "mixamorig:LeftHand": 1,
      "mixamorig:RightShoulder": 0.8,
      "mixamorig:RightArm": 0.94,
      "mixamorig:RightForeArm": 0.98,
      "mixamorig:RightHand": 1,
    }),
  },
  {
    id: "high-guard",
    name: "High guarded carry",
    stanceAsset: HIGH_GUARD_STANCE_ASSET,
    stanceSampleRatio: HIGH_GUARD_STANCE_SAMPLE_RATIO,
    strengthByBone: Object.freeze(
      Object.fromEntries(
        TWO_HAND_UPPER_BODY_BONES.map((boneName) => [boneName, 1]),
      ),
    ),
  },
  {
    id: "forward-guard",
    name: "Forward guarded carry",
    stanceAsset: HIGH_GUARD_STANCE_ASSET,
    stanceSampleRatio: FORWARD_GUARD_STANCE_SAMPLE_RATIO,
    strengthByBone: Object.freeze(
      Object.fromEntries(
        TWO_HAND_UPPER_BODY_BONES.map((boneName) => [boneName, 1]),
      ),
    ),
  },
  {
    id: "locked",
    name: "Locked legacy carry",
    strengthByBone: Object.freeze(
      Object.fromEntries(
        TWO_HAND_UPPER_BODY_BONES.map((boneName) => [boneName, 1]),
      ),
    ),
  },
  {
    id: "controlled-guard",
    name: "Controlled two-hand guard",
    stanceAsset: HIGH_GUARD_STANCE_ASSET,
    stanceSampleRatio: HIGH_GUARD_STANCE_SAMPLE_RATIO,
    boneNames: TWO_HAND_CONTROLLED_GUARD_BONES,
    strengthByBone: TWO_HAND_CONTROLLED_GUARD_STRENGTH_BY_BONE,
  },
]);

const TWO_HAND_LOCOMOTION_BASES = Object.freeze([
  {
    id: "walk",
    baseAsset: "emotes/emote-walk.glb",
  },
  {
    id: "run",
    baseAsset: "emotes/emote-run.glb",
  },
]);

export const TWO_HAND_LOCOMOTION_CANDIDATES = Object.freeze(
  TWO_HAND_CARRY_PROFILES.flatMap((profile) =>
    [
      ...(profile.id === "high-guard" ||
      profile.id === "forward-guard" ||
      profile.id === "controlled-guard"
        ? [{ id: "idle", baseAsset: STANCE_ASSET }]
        : []),
      ...TWO_HAND_LOCOMOTION_BASES,
    ].map((locomotion) => ({
      id: `two-hand-${profile.id}-${locomotion.id}`,
      profileId: profile.id,
      profileName: profile.name,
      strengthByBone: profile.strengthByBone,
      boneNames: profile.boneNames ?? TWO_HAND_UPPER_BODY_BONES,
      stanceAsset: profile.stanceAsset ?? STANCE_ASSET,
      stanceSampleRatio:
        profile.stanceSampleRatio ?? TWO_HAND_STANCE_SAMPLE_RATIO,
      locomotionId: locomotion.id,
      baseAsset: locomotion.baseAsset,
      outputAsset:
        profile.id === "locked"
          ? `emotes/candidates/emote-2h-${locomotion.id}-steve-candidate.glb`
          : `emotes/candidates/emote-2h-${locomotion.id}-steve-${profile.id}-candidate.glb`,
      outputClipName: `Hyperia_Two_Hand_${profile.id}_${locomotion.id}`,
    })),
  ),
);

const REPORT_PATH =
  "artifacts/duel-launch-avatar-bakeoff/two-hand-locomotion-candidate-report.json";
const PROFILE_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-carry-profile-comparison.json";
const STABLE_COMBAT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-stable-combat-multiview.json";
const STABLE_DETAIL_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-stable-detail-review.json";
const SOURCE_COMPARISON_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-motion-source-comparison.json";
const HIGH_GUARD_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-high-guard-locomotion-review.json";
const FORWARD_GUARD_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-forward-guard-locomotion-review.json";
const CURRENT_ATTACK_DENSE_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-current-attack-dense-review.json";
const WOODCUTTING_ATTACK_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-woodcutting-attack-review.json";
const TORSO_CUT_REPORT_PATH =
  "artifacts/duel-avatar-candidates/two-hand-torso-cut-candidate-report.json";
const TORSO_CUT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-torso-cut-review.json";
const CONTROLLED_TORSO_CUT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-torso-cut-controlled-20-review.json";
const GROUNDED_TORSO_CUT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-grounded-cut-controlled-20-review.json";
const PLANTED_TORSO_CUT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-planted-cut-controlled-20-review.json";
const PLANTED_SWEEP_TORSO_CUT_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-planted-cut-controlled-45-review.json";
const PLANTED_TRANSITION_REPORT_PATH =
  "artifacts/duel-avatar-candidates/two-hand-planted-transition-report.json";
const CONTROLLED_GUARD_REVIEW_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/two-hand-controlled-guard-locomotion-review.json";
const PROFILE_REVIEW_SAMPLE_RATIOS = Object.freeze([0.2, 0.5, 0.8]);
const EXACT_REVIEW_CAMERA_ANGLES = Object.freeze([
  { id: "front", yaw: 0 },
  { id: "profile-left", yaw: -90 },
  { id: "rear", yaw: 180 },
  { id: "profile-right", yaw: 90 },
]);
const TWO_HAND_ATTACK_REVIEW_PHASES = Object.freeze([
  { id: "ready", name: "Ready", sampleRatio: 0.1 },
  { id: "wind-up", name: "Wind-up", sampleRatio: 0.2 },
  { id: "accelerate", name: "Accelerate", sampleRatio: 0.35 },
  { id: "impact", name: "Impact", sampleRatio: 0.5 },
  { id: "follow-through", name: "Follow-through", sampleRatio: 0.65 },
  { id: "recover", name: "Recover", sampleRatio: 0.8 },
  { id: "guard", name: "Return to guard", sampleRatio: 0.95 },
]);
const TWO_HAND_HIT_REACTION_REVIEW_PHASES = Object.freeze([
  { id: "peak-left", name: "Hit peak left", side: -1, elapsedSeconds: 0.0504 },
  { id: "peak-right", name: "Hit peak right", side: 1, elapsedSeconds: 0.0504 },
  {
    id: "recovery-left",
    name: "Hit recovery left",
    side: -1,
    elapsedSeconds: 0.18,
  },
  {
    id: "recovery-right",
    name: "Hit recovery right",
    side: 1,
    elapsedSeconds: 0.18,
  },
]);
const TWO_HAND_MOTION_SOURCES = Object.freeze([
  {
    id: "current",
    name: "Current production source",
    idleAsset: "packages/server/world/assets/emotes/emote-2h-idle.glb",
    attackAsset: "packages/server/world/assets/emotes/emote-2h-slash.glb",
  },
  {
    id: "kaykit",
    name: "Retained KayKit source",
    idleAsset:
      "artifacts/duel-launch-avatar-bakeoff/motions/kaykit-two-hand-idle.glb",
    attackAsset:
      "artifacts/duel-launch-avatar-bakeoff/motions/kaykit-two-hand-slash.glb",
  },
]);
const TWO_HAND_PRODUCT_CLEARANCE = Object.freeze({
  minimumFloorClearanceMetres: 0.1,
  minimumBodySurfaceDistanceMetres: 0.08,
  maximumProjectedBodyOverlapRatio: 0.08,
});
const TWO_HAND_PRODUCT_GROUNDING = Object.freeze({
  minimumBoundsYMetres: -0.02,
  maximumBoundsYMetres: 0.18,
});
const TWO_HAND_TRANSITION_THRESHOLDS = Object.freeze({
  maximumRotationDeltaDegrees: 0.001,
  maximumLinearDelta: 0.0001,
});
export const TWO_HAND_TORSO_CUT_CANDIDATES = Object.freeze([
  {
    id: "controlled-20",
    name: "Controlled torso cut 20°",
    maximumTwistDegrees: 20,
    outputAsset:
      "emotes/candidates/emote-2h-torso-cut-steve-controlled-20-candidate.glb",
    outputClipName: "Hyperia_Two_Hand_Torso_Cut_Controlled_20",
  },
  {
    id: "controlled-35",
    name: "Controlled torso cut 35°",
    maximumTwistDegrees: 35,
    outputAsset:
      "emotes/candidates/emote-2h-torso-cut-steve-controlled-35-candidate.glb",
    outputClipName: "Hyperia_Two_Hand_Torso_Cut_Controlled_35",
  },
  {
    id: "grounded-20",
    name: "Grounded controlled cut 20°",
    maximumTwistDegrees: 20,
    lowerBodyAsset: "emotes/emote_sword_swing.glb",
    outputAsset:
      "emotes/candidates/emote-2h-grounded-cut-steve-controlled-20-candidate.glb",
    outputClipName: "Hyperia_Two_Hand_Grounded_Cut_Controlled_20",
  },
  {
    id: "planted-20",
    name: "Planted controlled cut 20°",
    maximumTwistDegrees: 20,
    lowerBodyAsset: "emotes/emote-2h-idle.glb",
    targetDurationSeconds: 1.3,
    outputAsset:
      "emotes/candidates/emote-2h-planted-cut-steve-controlled-20-candidate.glb",
    outputClipName: "Hyperia_Two_Hand_Planted_Cut_Controlled_20",
  },
  {
    id: "planted-45",
    name: "Planted controlled sweep 45°",
    maximumTwistDegrees: 45,
    minimumWindupRatio: -0.15,
    lowerBodyAsset: "emotes/emote-2h-idle.glb",
    targetDurationSeconds: 1.3,
    outputAsset:
      "emotes/candidates/emote-2h-planted-cut-steve-controlled-45-candidate.glb",
    outputClipName: "Hyperia_Two_Hand_Planted_Cut_Controlled_45",
  },
]);
const TWO_HAND_DENSE_SAMPLE_RATIOS = Object.freeze(
  Array.from({ length: 19 }, (_value, index) => (index + 1) * 0.05),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function findRotationChannel(animation, boneName, label) {
  const channels = animation
    .listChannels()
    .filter(
      (channel) =>
        channel.getTargetNode()?.getName() === boneName &&
        channel.getTargetPath() === "rotation",
    );
  if (channels.length !== 1) {
    throw new Error(
      `${label} must contain exactly one rotation channel for ${boneName}`,
    );
  }
  return channels[0];
}

function animationDurationSeconds(animation, label) {
  let duration = 0;
  for (const sampler of animation.listSamplers()) {
    const times = sampler.getInput()?.getArray();
    if (times?.length) duration = Math.max(duration, times[times.length - 1]);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${label} has no positive animation duration`);
  }
  return duration;
}

function sampleQuaternion(channel, timeSeconds, label) {
  const sampler = channel.getSampler();
  const input = sampler?.getInput();
  const output = sampler?.getOutput();
  const times = input?.getArray();
  const values = output?.getArray();
  if (
    !sampler ||
    (sampler.getInterpolation() !== "LINEAR" &&
      sampler.getInterpolation() !== "STEP") ||
    !times ||
    !values ||
    times.length < 1 ||
    values.length !== times.length * 4
  ) {
    throw new Error(`${label} must use one linear quaternion per keyframe`);
  }
  if (timeSeconds <= times[0]) {
    return new Quaternion().fromArray(values, 0).normalize();
  }
  const lastIndex = times.length - 1;
  if (timeSeconds >= times[lastIndex]) {
    return new Quaternion().fromArray(values, lastIndex * 4).normalize();
  }
  let upperIndex = 1;
  while (upperIndex < times.length && times[upperIndex] < timeSeconds) {
    upperIndex += 1;
  }
  const lowerIndex = upperIndex - 1;
  const span = times[upperIndex] - times[lowerIndex];
  const alpha = span > 0 ? (timeSeconds - times[lowerIndex]) / span : 0;
  const lower = new Quaternion().fromArray(values, lowerIndex * 4).normalize();
  const upper = new Quaternion().fromArray(values, upperIndex * 4).normalize();
  return lower.slerp(upper, alpha).normalize();
}

function sampleLinearTuple(channel, timeSeconds, componentCount, label) {
  const sampler = channel.getSampler();
  const input = sampler?.getInput();
  const output = sampler?.getOutput();
  const times = input?.getArray();
  const values = output?.getArray();
  if (
    !sampler ||
    (sampler.getInterpolation() !== "LINEAR" &&
      sampler.getInterpolation() !== "STEP") ||
    !times ||
    !values ||
    times.length < 1 ||
    values.length !== times.length * componentCount
  ) {
    throw new Error(
      `${label} must use one linear ${componentCount}-component value per keyframe`,
    );
  }
  let lowerIndex = 0;
  let upperIndex = 0;
  let alpha = 0;
  if (timeSeconds >= times[times.length - 1]) {
    lowerIndex = times.length - 1;
    upperIndex = lowerIndex;
  } else if (timeSeconds > times[0]) {
    upperIndex = 1;
    while (upperIndex < times.length && times[upperIndex] < timeSeconds) {
      upperIndex += 1;
    }
    lowerIndex = upperIndex - 1;
    const span = times[upperIndex] - times[lowerIndex];
    alpha =
      sampler.getInterpolation() === "LINEAR" && span > 0
        ? (timeSeconds - times[lowerIndex]) / span
        : 0;
  }
  return Array.from({ length: componentCount }, (_value, component) => {
    const lower = values[lowerIndex * componentCount + component];
    const upper = values[upperIndex * componentCount + component];
    return lower + (upper - lower) * alpha;
  });
}

function parentWorldRotation(node) {
  const parent = node.getParentNode();
  return parent
    ? new Quaternion().fromArray(parent.getWorldRotation()).normalize()
    : new Quaternion();
}

/**
 * Convert one source-rig local key into the normalized quaternion emitted by
 * createEmoteFactory. This mirrors the production retargeting equation.
 */
function toNormalizedQuaternion(node, localRotation) {
  const parentRest = parentWorldRotation(node);
  const restWorldInverse = new Quaternion()
    .fromArray(node.getWorldRotation())
    .normalize()
    .invert();
  return localRotation
    .clone()
    .premultiply(parentRest)
    .multiply(restWorldInverse)
    .normalize();
}

/** Solve baseParent * q * inverse(baseWorld) = normalizedRotation. */
function fromNormalizedQuaternion(node, normalizedRotation) {
  const parentRestInverse = parentWorldRotation(node).invert();
  const restWorld = new Quaternion()
    .fromArray(node.getWorldRotation())
    .normalize();
  return normalizedRotation
    .clone()
    .premultiply(parentRestInverse)
    .multiply(restWorld)
    .normalize();
}

function quaternionDeltaDegrees(first, second) {
  return (
    (2 * Math.acos(Math.min(1, Math.abs(first.dot(second)))) * 180) / Math.PI
  );
}

function rounded(value) {
  return Number(value.toFixed(9));
}

function replaceUpperBodyRotations({
  baseDocument,
  stanceDocument,
  outputClipName,
  strengthByBone,
  boneNames = TWO_HAND_UPPER_BODY_BONES,
  stanceAsset = STANCE_ASSET,
  stanceSampleRatio = TWO_HAND_STANCE_SAMPLE_RATIO,
}) {
  const baseAnimation = baseDocument.getRoot().listAnimations()[0];
  const stanceAnimation = stanceDocument.getRoot().listAnimations()[0];
  if (
    !baseAnimation ||
    baseDocument.getRoot().listAnimations().length !== 1 ||
    !stanceAnimation ||
    stanceDocument.getRoot().listAnimations().length !== 1
  ) {
    throw new Error("Locomotion sources must contain exactly one animation");
  }
  const stanceDuration = animationDurationSeconds(stanceAnimation, stanceAsset);
  const stanceSampleSeconds = stanceDuration * stanceSampleRatio;
  const baseNodes = new Map(
    baseDocument
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const stanceNodes = new Map(
    stanceDocument
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const overrides = [];

  for (const boneName of boneNames) {
    const baseNode = baseNodes.get(boneName);
    const stanceNode = stanceNodes.get(boneName);
    if (!baseNode || !stanceNode) {
      throw new Error(`Locomotion source is missing ${boneName}`);
    }
    const baseChannel = findRotationChannel(
      baseAnimation,
      boneName,
      "base locomotion",
    );
    const stanceChannel = findRotationChannel(
      stanceAnimation,
      boneName,
      stanceAsset,
    );
    const stanceLocal = sampleQuaternion(
      stanceChannel,
      stanceSampleSeconds,
      `${stanceAsset}:${boneName}`,
    );
    const normalizedRotation = toNormalizedQuaternion(stanceNode, stanceLocal);
    const sampler = baseChannel.getSampler();
    const times = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput();
    const sourceValues = output?.getArray();
    const strength = strengthByBone[boneName];
    if (
      !sampler ||
      (sampler.getInterpolation() !== "LINEAR" &&
        sampler.getInterpolation() !== "STEP") ||
      !times ||
      !output ||
      !sourceValues ||
      times.length < 2 ||
      sourceValues.length !== times.length * 4 ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    ) {
      throw new Error(`Base locomotion has no loopable ${boneName} sampler`);
    }
    const values = new Float32Array(sourceValues.length);
    let maximumSourceDeviationDegrees = 0;
    let maximumRetainedMotionDegrees = 0;
    let previousComposed = null;
    let firstComposed = null;
    let lastComposed = null;
    for (let index = 0; index < times.length; index += 1) {
      const sourceLocal = new Quaternion()
        .fromArray(sourceValues, index * 4)
        .normalize();
      const sourceNormalized = toNormalizedQuaternion(baseNode, sourceLocal);
      const composed = sourceNormalized
        .clone()
        .slerp(normalizedRotation, strength)
        .normalize();
      fromNormalizedQuaternion(baseNode, composed).toArray(values, index * 4);
      maximumSourceDeviationDegrees = Math.max(
        maximumSourceDeviationDegrees,
        quaternionDeltaDegrees(sourceNormalized, composed),
      );
      if (previousComposed) {
        maximumRetainedMotionDegrees = Math.max(
          maximumRetainedMotionDegrees,
          quaternionDeltaDegrees(previousComposed, composed),
        );
      }
      firstComposed ??= composed.clone();
      lastComposed = composed.clone();
      previousComposed = composed;
    }
    // The source walk clip has a small first/last arm mismatch. Competitive
    // locomotion loops continuously, so close the authored seam explicitly
    // instead of exposing a visible hand/weapon snap once per cycle.
    values.set(values.subarray(0, 4), values.length - 4);
    lastComposed = firstComposed.clone();
    output.setArray(values);
    overrides.push({
      boneName,
      blendStrength: strength,
      keyframeCount: times.length,
      normalizedQuaternion: normalizedRotation.toArray().map(Number),
      maximumSourceDeviationDegrees: rounded(maximumSourceDeviationDegrees),
      maximumRetainedMotionDegrees: rounded(maximumRetainedMotionDegrees),
      outputLoopSeamDegrees: rounded(
        quaternionDeltaDegrees(firstComposed, lastComposed),
      ),
      outputLoopSeamExact:
        values[0] === values[values.length - 4] &&
        values[1] === values[values.length - 3] &&
        values[2] === values[values.length - 2] &&
        values[3] === values[values.length - 1],
    });
  }
  baseAnimation.setName(outputClipName);
  return {
    durationSeconds: animationDurationSeconds(baseAnimation, outputClipName),
    channelCount: baseAnimation.listChannels().length,
    stanceSampleSeconds,
    overrides,
  };
}

function authorControlledGuardIdleSway(document) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Controlled-guard idle must contain one animation");
  }
  const durationSeconds = animationDurationSeconds(
    animation,
    "controlled-guard idle",
  );
  const maximumSwayDegrees = 5;
  const weightByBone = new Map([
    ["mixamorig:Spine", 0.5],
    ["mixamorig:Spine1", 0.3],
    ["mixamorig:Spine2", 0.2],
  ]);
  const twistAxis = new Vector3(0, 1, 0);
  const bones = [];
  for (const [boneName, weight] of weightByBone) {
    const channel = findRotationChannel(
      animation,
      boneName,
      "controlled-guard idle",
    );
    const sampler = channel.getSampler();
    const times = sampler.getInput()?.getArray();
    const output = sampler.getOutput();
    const sourceValues = output?.getArray();
    if (
      !times ||
      !output ||
      !sourceValues ||
      times.length < 2 ||
      sourceValues.length !== times.length * 4
    ) {
      throw new Error(`Controlled-guard idle has no loopable ${boneName}`);
    }
    const values = new Float32Array(sourceValues.length);
    for (let index = 0; index < times.length; index += 1) {
      const ratio = durationSeconds > 0 ? times[index] / durationSeconds : 0;
      const endpoint = index === 0 || index === times.length - 1;
      const swayDegrees = endpoint
        ? 0
        : Math.sin(ratio * Math.PI * 2) * maximumSwayDegrees * weight;
      const composed = new Quaternion()
        .fromArray(sourceValues, index * 4)
        .normalize()
        .multiply(
          new Quaternion().setFromAxisAngle(
            twistAxis,
            (swayDegrees * Math.PI) / 180,
          ),
        )
        .normalize();
      composed.toArray(values, index * 4);
    }
    values.set(values.subarray(0, 4), values.length - 4);
    output.setArray(values);
    bones.push({
      boneName,
      maximumSwayDegrees: maximumSwayDegrees * weight,
      loopSeamExact:
        values[0] === values[values.length - 4] &&
        values[1] === values[values.length - 3] &&
        values[2] === values[values.length - 2] &&
        values[3] === values[values.length - 1],
    });
  }
  return { maximumSwayDegrees, bones };
}

async function validateCandidate(bytes, outputAsset) {
  const validation = await validator.validateBytes(new Uint8Array(bytes), {
    uri: outputAsset,
    format: "glb",
    writeTimestamp: false,
    maxIssues: 1_000,
  });
  const unsupported = validation.issues.messages.filter(
    (message) =>
      message.severity < 2 ||
      (message.severity === 2 &&
        message.code !== "NODE_EMPTY" &&
        message.code !== "UNUSED_OBJECT"),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${outputAsset} failed glTF validation: ${unsupported
        .slice(0, 5)
        .map((message) => message.code)
        .join(", ")}`,
    );
  }
  return {
    errors: validation.issues.numErrors,
    warnings: validation.issues.numWarnings,
    infos: validation.issues.numInfos,
    hints: validation.issues.numHints,
    infoCodes: [
      ...new Set(
        validation.issues.messages
          .filter((message) => message.severity === 2)
          .map((message) => message.code),
      ),
    ].sort(),
  };
}

export async function buildTwoHandLocomotionCandidates(workspaceRoot) {
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const defaultStanceBytes = readFileSync(path.join(assetsRoot, STANCE_ASSET));
  const stanceSources = new Map();
  const outputs = [];
  for (const candidate of TWO_HAND_LOCOMOTION_CANDIDATES) {
    const basePath = path.join(assetsRoot, candidate.baseAsset);
    const stancePath = path.join(assetsRoot, candidate.stanceAsset);
    const baseBytes = readFileSync(basePath);
    const stanceBytes = readFileSync(stancePath);
    stanceSources.set(candidate.stanceAsset, {
      asset: candidate.stanceAsset,
      sha256: sha256(stanceBytes),
      sampleRatio: candidate.stanceSampleRatio,
    });
    const io = new NodeIO();
    const baseDocument = await io.readBinary(new Uint8Array(baseBytes));
    const stanceDocument = await io.readBinary(new Uint8Array(stanceBytes));
    const composition = replaceUpperBodyRotations({
      baseDocument,
      stanceDocument,
      outputClipName: candidate.outputClipName,
      strengthByBone: candidate.strengthByBone,
      boneNames: candidate.boneNames,
      stanceAsset: candidate.stanceAsset,
      stanceSampleRatio: candidate.stanceSampleRatio,
    });
    const controlledGuardIdleSway =
      candidate.profileId === "controlled-guard" &&
      candidate.locomotionId === "idle"
        ? authorControlledGuardIdleSway(baseDocument)
        : null;
    const controlledGuardLinearization =
      candidate.profileId === "controlled-guard"
        ? linearizeSteppedAnimation(baseDocument)
        : null;
    const controlledGuardTimeline =
      candidate.profileId === "controlled-guard"
        ? normalizeLoopStartTime(baseDocument)
        : null;
    const controlledGuardLowerBodySmoothing =
      candidate.profileId === "controlled-guard" &&
      (candidate.locomotionId === "walk" || candidate.locomotionId === "run")
        ? smoothLoopRotationChannels(
            baseDocument,
            TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES,
            candidate.locomotionId === "run" ? 3 : 2,
          )
        : null;
    const controlledGuardLoopSeam =
      candidate.profileId === "controlled-guard"
        ? closeAnimationLoopSeams(baseDocument)
        : null;
    const bytes = Buffer.from(await io.writeBinary(baseDocument));
    outputs.push({
      ...candidate,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      baseSha256: sha256(baseBytes),
      stanceSha256: sha256(stanceBytes),
      validation: await validateCandidate(bytes, candidate.outputAsset),
      ...composition,
      durationSeconds:
        controlledGuardTimeline?.durationSecondsAfterNormalization ??
        composition.durationSeconds,
      controlledGuardIdleSway,
      controlledGuardLinearization,
      controlledGuardTimeline,
      controlledGuardLowerBodySmoothing,
      controlledGuardLoopSeam,
    });
  }
  return {
    schemaVersion: 1,
    activationStatus: "isolated-candidate",
    approvedForRuntimeActivation: false,
    stance: {
      asset: STANCE_ASSET,
      sha256: sha256(defaultStanceBytes),
      sampleRatio: TWO_HAND_STANCE_SAMPLE_RATIO,
    },
    stanceSources: [...stanceSources.values()],
    upperBodyBones: [...TWO_HAND_UPPER_BODY_BONES],
    profiles: TWO_HAND_CARRY_PROFILES.map((profile) => ({
      id: profile.id,
      name: profile.name,
      stanceAsset: profile.stanceAsset ?? STANCE_ASSET,
      stanceSampleRatio:
        profile.stanceSampleRatio ?? TWO_HAND_STANCE_SAMPLE_RATIO,
      strengthByBone: { ...profile.strengthByBone },
      boneNames: [...(profile.boneNames ?? TWO_HAND_UPPER_BODY_BONES)],
    })),
    outputs,
  };
}

function controlledTorsoTwistDegrees(
  sampleRatio,
  maximumTwistDegrees,
  minimumWindupRatio = -0.35,
) {
  if (
    !Number.isFinite(minimumWindupRatio) ||
    minimumWindupRatio < -0.5 ||
    minimumWindupRatio > 0
  ) {
    throw new Error("Controlled torso cut has an invalid wind-up ratio");
  }
  const phases = [
    [0, 0],
    [0.15, minimumWindupRatio],
    [0.35, minimumWindupRatio],
    [0.55, 0.8],
    [0.72, 1],
    [0.88, 0.4],
    [1, 0],
  ];
  for (let index = 1; index < phases.length; index += 1) {
    const [upperRatio, upperValue] = phases[index];
    if (sampleRatio <= upperRatio) {
      const [lowerRatio, lowerValue] = phases[index - 1];
      const alpha =
        upperRatio > lowerRatio
          ? (sampleRatio - lowerRatio) / (upperRatio - lowerRatio)
          : 0;
      return (
        (lowerValue + (upperValue - lowerValue) * alpha) * maximumTwistDegrees
      );
    }
  }
  return phases[phases.length - 1][1] * maximumTwistDegrees;
}

function authorControlledTorsoCut({
  document,
  maximumTwistDegrees,
  minimumWindupRatio,
  outputClipName,
}) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Two-hand torso cut source must contain one animation");
  }
  const durationSeconds = animationDurationSeconds(
    animation,
    "emotes/emote-2h-slash.glb",
  );
  const referenceSeconds = durationSeconds * 0.35;
  const twistAxis = new Vector3(0, 1, 0);
  const torsoTwistWeightByBone = new Map([
    ["mixamorig:Spine", 0.5],
    ["mixamorig:Spine1", 0.3],
    ["mixamorig:Spine2", 0.2],
  ]);
  let maximumObservedTwistDegrees = 0;

  for (const channel of animation.listChannels()) {
    const sampler = channel.getSampler();
    const input = sampler?.getInput();
    const output = sampler?.getOutput();
    const times = input?.getArray();
    const sourceValues = output?.getArray();
    const targetPath = channel.getTargetPath();
    const boneName = channel.getTargetNode()?.getName();
    const componentCount = targetPath === "rotation" ? 4 : 3;
    if (
      !sampler ||
      (sampler.getInterpolation() !== "LINEAR" &&
        sampler.getInterpolation() !== "STEP") ||
      !times ||
      !output ||
      !sourceValues ||
      times.length < 1 ||
      sourceValues.length !== times.length * componentCount
    ) {
      throw new Error(
        `Two-hand torso cut source has an unsupported ${boneName}:${targetPath} sampler`,
      );
    }
    const values = new Float32Array(sourceValues.length);
    if (TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES.includes(boneName)) {
      values.set(sourceValues);
    } else if (targetPath === "rotation") {
      const reference = sampleQuaternion(
        channel,
        referenceSeconds,
        `${boneName}:rotation`,
      );
      for (let index = 0; index < times.length; index += 1) {
        const sampleRatio =
          durationSeconds > 0 ? times[index] / durationSeconds : 0;
        const totalTwistDegrees = controlledTorsoTwistDegrees(
          sampleRatio,
          maximumTwistDegrees,
          minimumWindupRatio,
        );
        const twistDegrees =
          totalTwistDegrees * (torsoTwistWeightByBone.get(boneName) ?? 0);
        const composed = reference.clone();
        if (twistDegrees !== 0) {
          composed.multiply(
            new Quaternion().setFromAxisAngle(
              twistAxis,
              (twistDegrees * Math.PI) / 180,
            ),
          );
        }
        composed.normalize().toArray(values, index * 4);
        maximumObservedTwistDegrees = Math.max(
          maximumObservedTwistDegrees,
          Math.abs(totalTwistDegrees),
        );
      }
    } else {
      const reference = sampleLinearTuple(
        channel,
        referenceSeconds,
        componentCount,
        `${boneName}:${targetPath}`,
      );
      for (let index = 0; index < times.length; index += 1) {
        values.set(reference, index * componentCount);
      }
    }
    output.setArray(values);
  }
  animation.setName(outputClipName);
  return {
    durationSeconds,
    channelCount: animation.listChannels().length,
    referenceSampleRatio: 0.35,
    dynamicLowerBodyBones: [...TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES],
    maximumObservedTwistDegrees: rounded(maximumObservedTwistDegrees),
  };
}

function authorGroundedControlledTorsoCut({
  document,
  maximumTwistDegrees,
  minimumWindupRatio,
  outputClipName,
}) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Grounded two-hand cut must contain one animation");
  }
  const durationSeconds = animationDurationSeconds(animation, outputClipName);
  const twistAxis = new Vector3(0, 1, 0);
  const weightByBone = new Map([
    ["mixamorig:Spine", 0.5],
    ["mixamorig:Spine1", 0.3],
    ["mixamorig:Spine2", 0.2],
  ]);
  let maximumObservedTwistDegrees = 0;
  const twistBones = [];
  for (const [boneName, weight] of weightByBone) {
    const channel = findRotationChannel(
      animation,
      boneName,
      "grounded two-hand cut",
    );
    const sampler = channel.getSampler();
    const times = sampler.getInput()?.getArray();
    const output = sampler.getOutput();
    const sourceValues = output?.getArray();
    if (
      !times ||
      !output ||
      !sourceValues ||
      times.length < 2 ||
      sourceValues.length !== times.length * 4
    ) {
      throw new Error(`Grounded two-hand cut has no ${boneName} rotation`);
    }
    const values = new Float32Array(sourceValues.length);
    for (let index = 0; index < times.length; index += 1) {
      const sampleRatio =
        durationSeconds > 0 ? times[index] / durationSeconds : 0;
      const endpoint = index === 0 || index === times.length - 1;
      const totalTwistDegrees = endpoint
        ? 0
        : controlledTorsoTwistDegrees(
            sampleRatio,
            maximumTwistDegrees,
            minimumWindupRatio,
          );
      const twistDegrees = totalTwistDegrees * weight;
      new Quaternion()
        .fromArray(sourceValues, index * 4)
        .normalize()
        .multiply(
          new Quaternion().setFromAxisAngle(
            twistAxis,
            (twistDegrees * Math.PI) / 180,
          ),
        )
        .normalize()
        .toArray(values, index * 4);
      maximumObservedTwistDegrees = Math.max(
        maximumObservedTwistDegrees,
        Math.abs(totalTwistDegrees),
      );
    }
    output.setArray(values);
    twistBones.push({ boneName, weight });
  }
  animation.setName(outputClipName);
  return {
    durationSeconds,
    channelCount: animation.listChannels().length,
    referenceSampleRatio: HIGH_GUARD_STANCE_SAMPLE_RATIO,
    dynamicLowerBodyBones: [...TWO_HAND_ATTACK_DYNAMIC_LOWER_BODY_BONES],
    maximumObservedTwistDegrees: rounded(maximumObservedTwistDegrees),
    minimumWindupRatio: minimumWindupRatio ?? -0.35,
    twistBones,
  };
}

function retimeAnimation(document, targetDurationSeconds) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Retimed motion must contain one animation");
  }
  const sourceDurationSeconds = animationDurationSeconds(
    animation,
    "retimed motion",
  );
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    throw new Error("Retimed motion requires a positive target duration");
  }
  const timeScale = targetDurationSeconds / sourceDurationSeconds;
  const inputs = new Set();
  for (const sampler of animation.listSamplers()) {
    const input = sampler.getInput();
    const sourceTimes = input?.getArray();
    if (!input || !sourceTimes || sourceTimes.length < 2) {
      throw new Error("Retimed motion has an invalid sampler input");
    }
    if (inputs.has(input)) continue;
    inputs.add(input);
    const times = new Float32Array(sourceTimes.length);
    for (let index = 0; index < sourceTimes.length; index += 1) {
      times[index] = sourceTimes[index] * timeScale;
    }
    input.setArray(times);
  }
  return {
    sourceDurationSeconds,
    targetDurationSeconds,
    timeScale: rounded(timeScale),
    samplerInputCount: inputs.size,
  };
}

function linearizeSteppedAnimation(document) {
  const samplers = new Set();
  let convertedSamplerCount = 0;
  for (const animation of document.getRoot().listAnimations()) {
    for (const sampler of animation.listSamplers()) {
      if (samplers.has(sampler)) continue;
      samplers.add(sampler);
      const interpolation = sampler.getInterpolation();
      if (interpolation === "STEP") {
        sampler.setInterpolation("LINEAR");
        convertedSamplerCount += 1;
      } else if (interpolation !== "LINEAR") {
        throw new Error(
          `Controlled-guard locomotion has unsupported ${interpolation} interpolation`,
        );
      }
    }
  }
  return {
    samplerCount: samplers.size,
    convertedSamplerCount,
    remainingStepSamplerCount: 0,
  };
}

function normalizeLoopStartTime(document) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Normalized loop must contain one animation");
  }
  const inputs = [
    ...new Set(
      animation
        .listSamplers()
        .map((sampler) => sampler.getInput())
        .filter(Boolean),
    ),
  ];
  if (inputs.length === 0) {
    throw new Error("Normalized loop has no sampler inputs");
  }
  const starts = inputs.map((input) => input.getArray()?.[0]);
  if (
    starts.some((value) => !Number.isFinite(value)) ||
    Math.max(...starts) - Math.min(...starts) > 0.000001
  ) {
    throw new Error("Normalized loop sampler inputs disagree on start time");
  }
  const originalStartSeconds = Math.min(...starts);
  const durationSecondsBeforeNormalization = animationDurationSeconds(
    animation,
    "loop before timeline normalization",
  );
  for (const input of inputs) {
    const sourceTimes = input.getArray();
    if (!sourceTimes || sourceTimes.length < 2) {
      throw new Error("Normalized loop has an invalid sampler input");
    }
    const times = new Float32Array(sourceTimes.length);
    for (let index = 0; index < sourceTimes.length; index += 1) {
      times[index] = sourceTimes[index] - originalStartSeconds;
    }
    times[0] = 0;
    input.setArray(times);
  }
  return {
    inputAccessorCount: inputs.length,
    originalStartSeconds: rounded(originalStartSeconds),
    normalizedStartSeconds: 0,
    durationSecondsBeforeNormalization,
    durationSecondsAfterNormalization: animationDurationSeconds(
      animation,
      "loop after timeline normalization",
    ),
  };
}

function smoothLoopRotationChannels(document, boneNames, passCount) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Smoothed loop must contain one animation");
  }
  if (!Number.isInteger(passCount) || passCount < 1 || passCount > 4) {
    throw new Error("Smoothed loop requires one to four passes");
  }
  const requestedBones = new Set(boneNames);
  const channels = animation
    .listChannels()
    .filter(
      (channel) =>
        channel.getTargetPath() === "rotation" &&
        requestedBones.has(channel.getTargetNode()?.getName()),
    );
  const foundBoneNames = new Set(
    channels.map((channel) => channel.getTargetNode()?.getName()),
  );
  const missingBoneNames = [...requestedBones].filter(
    (boneName) => !foundBoneNames.has(boneName),
  );
  if (
    channels.length < 8 ||
    missingBoneNames.some((boneName) => !boneName.endsWith("Toe_End"))
  ) {
    throw new Error(
      `Smoothed loop found ${channels.length}/${requestedBones.size} lower-body rotations`,
    );
  }
  let maximumAdjustmentDegrees = 0;
  const smoothedBoneNames = [];
  const skippedStaticBoneNames = [];
  for (const channel of channels) {
    const sampler = channel.getSampler();
    const output = sampler.getOutput();
    let values = output?.getArray();
    if (
      sampler.getInterpolation() !== "LINEAR" ||
      !output ||
      !values ||
      values.length < 8 ||
      values.length % 4 !== 0
    ) {
      throw new Error(
        `Smoothed loop has an invalid ${channel.getTargetNode()?.getName()} rotation`,
      );
    }
    if (values.length < 12) {
      skippedStaticBoneNames.push(channel.getTargetNode().getName());
      continue;
    }
    smoothedBoneNames.push(channel.getTargetNode().getName());
    const keyframeCount = values.length / 4;
    const cycleKeyframeCount = keyframeCount - 1;
    for (let pass = 0; pass < passCount; pass += 1) {
      const source = new Float32Array(values);
      const smoothed = new Float32Array(source.length);
      for (let index = 0; index < cycleKeyframeCount; index += 1) {
        const previousIndex =
          (index - 1 + cycleKeyframeCount) % cycleKeyframeCount;
        const nextIndex = (index + 1) % cycleKeyframeCount;
        const current = new Quaternion()
          .fromArray(source, index * 4)
          .normalize();
        const previous = new Quaternion()
          .fromArray(source, previousIndex * 4)
          .normalize();
        const next = new Quaternion()
          .fromArray(source, nextIndex * 4)
          .normalize();
        if (current.dot(previous) < 0) {
          previous.set(-previous.x, -previous.y, -previous.z, -previous.w);
        }
        if (current.dot(next) < 0) {
          next.set(-next.x, -next.y, -next.z, -next.w);
        }
        const averaged = new Quaternion(
          previous.x * 0.25 + current.x * 0.5 + next.x * 0.25,
          previous.y * 0.25 + current.y * 0.5 + next.y * 0.25,
          previous.z * 0.25 + current.z * 0.5 + next.z * 0.25,
          previous.w * 0.25 + current.w * 0.5 + next.w * 0.25,
        ).normalize();
        maximumAdjustmentDegrees = Math.max(
          maximumAdjustmentDegrees,
          quaternionDeltaDegrees(current, averaged),
        );
        averaged.toArray(smoothed, index * 4);
      }
      smoothed.set(smoothed.subarray(0, 4), smoothed.length - 4);
      output.setArray(smoothed);
      values = smoothed;
    }
  }
  return {
    evaluatedChannelCount: channels.length,
    smoothedChannelCount: smoothedBoneNames.length,
    passCount,
    maximumAdjustmentDegrees: rounded(maximumAdjustmentDegrees),
    boneNames: smoothedBoneNames,
    missingBoneNames,
    skippedStaticBoneNames,
  };
}

function closeAnimationLoopSeams(document) {
  const animation = document.getRoot().listAnimations()[0];
  if (!animation || document.getRoot().listAnimations().length !== 1) {
    throw new Error("Seam-closed motion must contain one animation");
  }
  let maximumRotationSeamDegrees = 0;
  let maximumLinearSeam = 0;
  let closedChannelCount = 0;
  for (const channel of animation.listChannels()) {
    const output = channel.getSampler().getOutput();
    const values = output?.getArray();
    const componentCount = channel.getTargetPath() === "rotation" ? 4 : 3;
    if (!output || !values || values.length < componentCount * 2) {
      throw new Error("Seam-closed motion has an invalid channel output");
    }
    const lastOffset = values.length - componentCount;
    if (channel.getTargetPath() === "rotation") {
      maximumRotationSeamDegrees = Math.max(
        maximumRotationSeamDegrees,
        quaternionDeltaDegrees(
          new Quaternion().fromArray(values, 0).normalize(),
          new Quaternion().fromArray(values, lastOffset).normalize(),
        ),
      );
    } else {
      maximumLinearSeam = Math.max(
        maximumLinearSeam,
        Math.hypot(
          ...Array.from(
            { length: componentCount },
            (_value, component) =>
              values[component] - values[lastOffset + component],
          ),
        ),
      );
    }
    values.set(values.subarray(0, componentCount), lastOffset);
    output.setArray(values);
    closedChannelCount += 1;
  }
  return {
    closedChannelCount,
    maximumRotationSeamDegreesBeforeClosure: rounded(
      maximumRotationSeamDegrees,
    ),
    maximumLinearSeamBeforeClosure: rounded(maximumLinearSeam),
    exactAfterClosure: true,
  };
}

export async function buildTwoHandTorsoCutCandidates(workspaceRoot) {
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const sourceAsset = "emotes/emote-2h-slash.glb";
  const sourceBytes = readFileSync(path.join(assetsRoot, sourceAsset));
  const outputs = [];
  for (const candidate of TWO_HAND_TORSO_CUT_CANDIDATES) {
    const io = new NodeIO();
    let document;
    let composition;
    let lowerBodySha256 = null;
    if (candidate.lowerBodyAsset) {
      const lowerBodyBytes = readFileSync(
        path.join(assetsRoot, candidate.lowerBodyAsset),
      );
      document = await io.readBinary(new Uint8Array(lowerBodyBytes));
      const retiming = candidate.targetDurationSeconds
        ? retimeAnimation(document, candidate.targetDurationSeconds)
        : null;
      const stanceDocument = await io.readBinary(new Uint8Array(sourceBytes));
      const overlay = replaceUpperBodyRotations({
        baseDocument: document,
        stanceDocument,
        outputClipName: candidate.outputClipName,
        strengthByBone: TWO_HAND_CONTROLLED_GUARD_STRENGTH_BY_BONE,
        boneNames: TWO_HAND_CONTROLLED_GUARD_BONES,
        stanceAsset: sourceAsset,
        stanceSampleRatio: HIGH_GUARD_STANCE_SAMPLE_RATIO,
      });
      composition = {
        ...overlay,
        ...authorGroundedControlledTorsoCut({
          document,
          maximumTwistDegrees: candidate.maximumTwistDegrees,
          minimumWindupRatio: candidate.minimumWindupRatio,
          outputClipName: candidate.outputClipName,
        }),
        retiming,
      };
      if (candidate.targetDurationSeconds) {
        composition.loopSeam = closeAnimationLoopSeams(document);
      }
      lowerBodySha256 = sha256(lowerBodyBytes);
    } else {
      document = await io.readBinary(new Uint8Array(sourceBytes));
      composition = authorControlledTorsoCut({
        document,
        maximumTwistDegrees: candidate.maximumTwistDegrees,
        minimumWindupRatio: candidate.minimumWindupRatio,
        outputClipName: candidate.outputClipName,
      });
    }
    const bytes = Buffer.from(await io.writeBinary(document));
    outputs.push({
      ...candidate,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      sourceAsset,
      sourceSha256: sha256(sourceBytes),
      lowerBodySha256,
      validation: await validateCandidate(bytes, candidate.outputAsset),
      ...composition,
    });
  }
  return {
    schemaVersion: 1,
    activationStatus: "isolated-candidate",
    approvedForRuntimeActivation: false,
    sourceAsset,
    sourceSha256: sha256(sourceBytes),
    outputs,
  };
}

function serializableReport(report) {
  return {
    ...report,
    outputs: report.outputs.map(({ bytes: _bytes, ...output }) => output),
  };
}

function animationChannelMap(animation, label) {
  const channels = new Map();
  for (const channel of animation.listChannels()) {
    const nodeName = channel.getTargetNode()?.getName();
    const targetPath = channel.getTargetPath();
    if (!nodeName || !targetPath) {
      throw new Error(`${label} contains an untargeted animation channel`);
    }
    const key = `${nodeName}:${targetPath}`;
    if (channels.has(key)) {
      throw new Error(`${label} contains duplicate animation channel ${key}`);
    }
    channels.set(key, channel);
  }
  return channels;
}

function channelEndpoint(channel, endpoint, label) {
  const sampler = channel.getSampler();
  const output = sampler?.getOutput();
  const values = output?.getArray();
  const elementSize = output?.getElementSize();
  if (
    !sampler ||
    !output ||
    !values ||
    !elementSize ||
    values.length < elementSize ||
    values.length % elementSize !== 0 ||
    (sampler.getInterpolation() !== "LINEAR" &&
      sampler.getInterpolation() !== "STEP")
  ) {
    throw new Error(`${label} has an unsupported animation channel`);
  }
  const offset = endpoint === "start" ? 0 : values.length - elementSize;
  return Array.from(values.subarray(offset, offset + elementSize));
}

function compareAnimationEndpoints({ id, from, fromEndpoint, to, toEndpoint }) {
  const fromChannels = animationChannelMap(from.animation, from.asset);
  const toChannels = animationChannelMap(to.animation, to.asset);
  const sharedKeys = [...fromChannels.keys()]
    .filter((key) => toChannels.has(key))
    .sort();
  const missingFromDestination = [...fromChannels.keys()]
    .filter((key) => !toChannels.has(key))
    .sort();
  const missingFromSource = [...toChannels.keys()]
    .filter((key) => !fromChannels.has(key))
    .sort();
  const rotationDeltas = [];
  const linearDeltas = [];
  for (const key of sharedKeys) {
    const fromChannel = fromChannels.get(key);
    const toChannel = toChannels.get(key);
    const targetPath = fromChannel.getTargetPath();
    if (targetPath !== toChannel.getTargetPath()) {
      throw new Error(`${id} disagrees on the target path for ${key}`);
    }
    const fromValue = channelEndpoint(
      fromChannel,
      fromEndpoint,
      `${from.asset}:${key}`,
    );
    const toValue = channelEndpoint(
      toChannel,
      toEndpoint,
      `${to.asset}:${key}`,
    );
    if (fromValue.length !== toValue.length) {
      throw new Error(`${id} disagrees on the element size for ${key}`);
    }
    if (targetPath === "rotation") {
      if (fromValue.length !== 4) {
        throw new Error(`${id} has a non-quaternion rotation at ${key}`);
      }
      rotationDeltas.push({
        channel: key,
        deltaDegrees: rounded(
          quaternionDeltaDegrees(
            new Quaternion().fromArray(fromValue).normalize(),
            new Quaternion().fromArray(toValue).normalize(),
          ),
        ),
      });
    } else {
      linearDeltas.push({
        channel: key,
        delta: rounded(
          Math.hypot(
            ...fromValue.map((value, index) => value - toValue[index]),
          ),
        ),
      });
    }
  }
  rotationDeltas.sort(
    (first, second) =>
      second.deltaDegrees - first.deltaDegrees ||
      first.channel.localeCompare(second.channel),
  );
  linearDeltas.sort(
    (first, second) =>
      second.delta - first.delta || first.channel.localeCompare(second.channel),
  );
  const maximumRotationDeltaDegrees = rotationDeltas[0]?.deltaDegrees ?? 0;
  const maximumLinearDelta = linearDeltas[0]?.delta ?? 0;
  const gripCriticalRotationChannels = sharedKeys.filter((key) => {
    const separator = key.lastIndexOf(":");
    const boneName = key.slice(0, separator);
    const targetPath = key.slice(separator + 1);
    return (
      targetPath === "rotation" &&
      (TWO_HAND_FINGER_BONES.includes(boneName) ||
        boneName === "mixamorig:LeftForeArm" ||
        boneName === "mixamorig:LeftHand" ||
        boneName === "mixamorig:RightForeArm" ||
        boneName === "mixamorig:RightHand")
    );
  });
  return {
    id,
    from: { asset: from.asset, endpoint: fromEndpoint },
    to: { asset: to.asset, endpoint: toEndpoint },
    sharedChannelCount: sharedKeys.length,
    rotationChannelCount: rotationDeltas.length,
    linearChannelCount: linearDeltas.length,
    gripCriticalRotationChannelCount: gripCriticalRotationChannels.length,
    missingFromDestination,
    missingFromSource,
    maximumRotationDeltaDegrees,
    maximumLinearDelta,
    worstRotationChannels: rotationDeltas.slice(0, 5),
    worstLinearChannels: linearDeltas.slice(0, 5),
    passed:
      missingFromDestination.length === 0 &&
      missingFromSource.length === 0 &&
      maximumRotationDeltaDegrees <=
        TWO_HAND_TRANSITION_THRESHOLDS.maximumRotationDeltaDegrees &&
      maximumLinearDelta <= TWO_HAND_TRANSITION_THRESHOLDS.maximumLinearDelta,
  };
}

export async function twoHandPlantedTransitionReportFor(
  locomotionOutputs,
  torsoCutOutputs,
) {
  const guard = locomotionOutputs.filter(
    (output) =>
      output.profileId === "controlled-guard" && output.locomotionId === "idle",
  );
  const attack = torsoCutOutputs.filter((output) => output.id === "planted-45");
  if (guard.length !== 1 || attack.length !== 1) {
    throw new Error(
      "Planted transition report requires exactly one controlled guard idle and planted cut",
    );
  }
  const io = new NodeIO();
  const [guardDocument, attackDocument] = await Promise.all([
    io.readBinary(new Uint8Array(guard[0].bytes)),
    io.readBinary(new Uint8Array(attack[0].bytes)),
  ]);
  const guardAnimations = guardDocument.getRoot().listAnimations();
  const attackAnimations = attackDocument.getRoot().listAnimations();
  if (guardAnimations.length !== 1 || attackAnimations.length !== 1) {
    throw new Error("Transition candidates must each contain one animation");
  }
  const guardMotion = {
    asset: guard[0].outputAsset,
    animation: guardAnimations[0],
  };
  const attackMotion = {
    asset: attack[0].outputAsset,
    animation: attackAnimations[0],
  };
  const transitions = [
    compareAnimationEndpoints({
      id: "guard-to-attack",
      from: guardMotion,
      fromEndpoint: "start",
      to: attackMotion,
      toEndpoint: "start",
    }),
    compareAnimationEndpoints({
      id: "attack-to-guard",
      from: attackMotion,
      fromEndpoint: "end",
      to: guardMotion,
      toEndpoint: "start",
    }),
  ];
  return {
    schemaVersion: 1,
    activationStatus: "isolated-candidate",
    approvedForRuntimeActivation: false,
    thresholds: { ...TWO_HAND_TRANSITION_THRESHOLDS },
    guard: {
      asset: guard[0].outputAsset,
      sha256: guard[0].sha256,
      durationSeconds: guard[0].durationSeconds,
    },
    attack: {
      asset: attack[0].outputAsset,
      sha256: attack[0].sha256,
      durationSeconds: attack[0].durationSeconds,
    },
    transitions,
    passed: transitions.every((transition) => transition.passed),
  };
}

export function twoHandLocomotionProfileReviewManifestFor(outputs) {
  const byProfileAndLocomotion = new Map(
    outputs.map((output) => [
      `${output.profileId}:${output.locomotionId}`,
      output,
    ]),
  );
  return {
    schemaVersion: 1,
    title: "Two-hand carry profile comparison (inactive)",
    framing: "avatar-and-equipment",
    motions: TWO_HAND_CARRY_PROFILES.flatMap((profile) =>
      TWO_HAND_LOCOMOTION_BASES.flatMap((locomotion) => {
        const output = byProfileAndLocomotion.get(
          `${profile.id}:${locomotion.id}`,
        );
        if (!output) {
          throw new Error(
            `${profile.id} is missing the ${locomotion.id} output`,
          );
        }
        return PROFILE_REVIEW_SAMPLE_RATIOS.map((sampleRatio) => {
          const phase = Math.round(sampleRatio * 100);
          return {
            id: `${profile.id}-${locomotion.id}-${phase}`,
            name: `${profile.name} · ${locomotion.id} ${phase}%`,
            asset: output.outputAsset,
            sampleRatio,
            heldEquipmentEmote: locomotion.id,
          };
        });
      }),
    ),
  };
}

export function twoHandStableCombatReviewManifestFor(outputs) {
  const stableOutputs = new Map(
    outputs
      .filter((output) => output.profileId === "stable")
      .map((output) => [output.locomotionId, output]),
  );
  const locomotionPoses = [
    {
      id: "idle",
      name: "Guard idle",
      asset: "emotes/emote-2h-idle.glb",
      sampleRatio: TWO_HAND_STANCE_SAMPLE_RATIO,
    },
    { id: "walk-20", name: "Walk 20%", locomotionId: "walk", sampleRatio: 0.2 },
    { id: "walk-70", name: "Walk 70%", locomotionId: "walk", sampleRatio: 0.7 },
    { id: "run-20", name: "Run 20%", locomotionId: "run", sampleRatio: 0.2 },
    { id: "run-70", name: "Run 70%", locomotionId: "run", sampleRatio: 0.7 },
  ].flatMap((pose) => {
    const output = pose.locomotionId
      ? stableOutputs.get(pose.locomotionId)
      : null;
    const asset = pose.asset ?? output?.outputAsset;
    if (!asset) throw new Error(`Stable profile is missing ${pose.id}`);
    return EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
      id: `stable-${pose.id}-${camera.id}`,
      name: `${pose.name} · ${camera.id}`,
      asset,
      sampleRatio: pose.sampleRatio,
      heldEquipmentEmote: pose.locomotionId ?? "idle",
      cameraYawDegrees: camera.yaw,
      cameraPitchDegrees: 8,
    }));
  });
  const attackPoses = TWO_HAND_ATTACK_REVIEW_PHASES.flatMap((phase) =>
    EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
      id: `stable-attack-${phase.id}-${camera.id}`,
      name: `${phase.name} · ${camera.id}`,
      asset: "emotes/emote-2h-slash.glb",
      sampleRatio: phase.sampleRatio,
      heldEquipmentEmote: "2h-slash",
      cameraYawDegrees: camera.yaw,
      cameraPitchDegrees: 8,
    })),
  );
  const hitReactionPoses = TWO_HAND_HIT_REACTION_REVIEW_PHASES.flatMap(
    (phase) =>
      EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `stable-hit-${phase.id}-${camera.id}`,
        name: `${phase.name} · ${camera.id}`,
        asset: "emotes/emote-2h-idle.glb",
        sampleRatio: TWO_HAND_STANCE_SAMPLE_RATIO,
        heldEquipmentEmote: "idle",
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        hitReaction: {
          intensity: 1,
          side: phase.side,
          elapsedSeconds: phase.elapsedSeconds,
        },
      })),
  );
  return {
    schemaVersion: 1,
    title: "Two-hand stable carry exact-angle combat review (inactive)",
    framing: "avatar-and-equipment",
    motions: [...locomotionPoses, ...attackPoses, ...hitReactionPoses],
  };
}

export function twoHandStableDetailReviewManifestFor(outputs) {
  const stableOutputs = new Map(
    outputs
      .filter((output) => output.profileId === "stable")
      .map((output) => [output.locomotionId, output]),
  );
  const walk = stableOutputs.get("walk");
  const run = stableOutputs.get("run");
  if (!walk || !run) throw new Error("Stable profile is incomplete");
  const poses = [
    {
      id: "idle",
      name: "Guard idle",
      asset: "emotes/emote-2h-idle.glb",
      sampleRatio: TWO_HAND_STANCE_SAMPLE_RATIO,
    },
    {
      id: "walk",
      name: "Guard walk",
      asset: walk.outputAsset,
      sampleRatio: 0.2,
    },
    { id: "run", name: "Guard run", asset: run.outputAsset, sampleRatio: 0.2 },
  ];
  const locomotion = poses.flatMap((pose) =>
    [
      { id: "front", yaw: 0 },
      { id: "profile-left", yaw: -90 },
    ].map((camera) => ({
      id: `stable-detail-${pose.id}-${camera.id}`,
      name: `${pose.name} · ${camera.id}`,
      asset: pose.asset,
      sampleRatio: pose.sampleRatio,
      heldEquipmentEmote: pose.id,
      cameraYawDegrees: camera.yaw,
      cameraPitchDegrees: 5,
    })),
  );
  const attack = [
    {
      id: "wind-up",
      name: "Wind-up",
      sampleRatio: 0.2,
      cameras: EXACT_REVIEW_CAMERA_ANGLES.slice(0, 2),
    },
    {
      id: "impact",
      name: "Impact",
      sampleRatio: 0.5,
      cameras: EXACT_REVIEW_CAMERA_ANGLES,
    },
  ].flatMap((phase) =>
    phase.cameras.map((camera) => ({
      id: `stable-detail-${phase.id}-${camera.id}`,
      name: `${phase.name} · ${camera.id}`,
      asset: "emotes/emote-2h-slash.glb",
      sampleRatio: phase.sampleRatio,
      heldEquipmentEmote: "2h-slash",
      cameraYawDegrees: camera.yaw,
      cameraPitchDegrees: 5,
    })),
  );
  return {
    schemaVersion: 1,
    title:
      "Two-hand stable handle, blade-direction, and grip detail (inactive)",
    framing: "avatar-and-equipment",
    motions: [...locomotion, ...attack],
  };
}

export function twoHandMotionSourceComparisonManifestFor() {
  return {
    schemaVersion: 1,
    title: "Two-hand retained motion-source product comparison (inactive)",
    framing: "avatar-and-equipment",
    motions: TWO_HAND_MOTION_SOURCES.flatMap((source) => {
      const idle = EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `${source.id}-idle-${camera.id}`,
        name: `${source.name} · guard idle · ${camera.id}`,
        asset: source.idleAsset,
        sampleRatio: TWO_HAND_STANCE_SAMPLE_RATIO,
        heldEquipmentEmote: "idle",
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        avatarGrounding: { ...TWO_HAND_PRODUCT_GROUNDING },
        equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
      }));
      const attack = TWO_HAND_ATTACK_REVIEW_PHASES.flatMap((phase) =>
        EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
          id: `${source.id}-attack-${phase.id}-${camera.id}`,
          name: `${source.name} · ${phase.name} · ${camera.id}`,
          asset: source.attackAsset,
          sampleRatio: phase.sampleRatio,
          heldEquipmentEmote: "2h-slash",
          cameraYawDegrees: camera.yaw,
          cameraPitchDegrees: 8,
          avatarGrounding: { ...TWO_HAND_PRODUCT_GROUNDING },
          equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
        })),
      );
      return [...idle, ...attack];
    }),
  };
}

export function twoHandHighGuardReviewManifestFor(outputs) {
  const highGuardOutputs = new Map(
    outputs
      .filter((output) => output.profileId === "high-guard")
      .map((output) => [output.locomotionId, output]),
  );
  const poses = [
    { id: "idle", name: "High guard idle", sampleRatio: 0.4 },
    { id: "walk-20", name: "High guard walk 20%", sampleRatio: 0.2 },
    { id: "walk-50", name: "High guard walk 50%", sampleRatio: 0.5 },
    { id: "walk-80", name: "High guard walk 80%", sampleRatio: 0.8 },
    { id: "run-20", name: "High guard run 20%", sampleRatio: 0.2 },
    { id: "run-50", name: "High guard run 50%", sampleRatio: 0.5 },
    { id: "run-80", name: "High guard run 80%", sampleRatio: 0.8 },
  ];
  return {
    schemaVersion: 1,
    title: "Two-hand high-guard locomotion product review (inactive)",
    framing: "avatar-and-equipment",
    motions: poses.flatMap((pose) => {
      const locomotionId = pose.id.split("-")[0];
      const output = highGuardOutputs.get(locomotionId);
      if (!output) throw new Error(`High-guard output is missing ${pose.id}`);
      return EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `high-guard-${pose.id}-${camera.id}`,
        name: `${pose.name} · ${camera.id}`,
        asset: output.outputAsset,
        sampleRatio: pose.sampleRatio,
        heldEquipmentEmote: locomotionId,
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        avatarGrounding: { ...TWO_HAND_PRODUCT_GROUNDING },
        equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
      }));
    }),
  };
}

export function twoHandForwardGuardReviewManifestFor(outputs) {
  const forwardGuardOutputs = new Map(
    outputs
      .filter((output) => output.profileId === "forward-guard")
      .map((output) => [output.locomotionId, output]),
  );
  const poses = [
    { id: "idle", name: "Forward guard idle", sampleRatio: 0.4 },
    { id: "walk-20", name: "Forward guard walk 20%", sampleRatio: 0.2 },
    { id: "walk-50", name: "Forward guard walk 50%", sampleRatio: 0.5 },
    { id: "walk-80", name: "Forward guard walk 80%", sampleRatio: 0.8 },
    { id: "run-20", name: "Forward guard run 20%", sampleRatio: 0.2 },
    { id: "run-50", name: "Forward guard run 50%", sampleRatio: 0.5 },
    { id: "run-80", name: "Forward guard run 80%", sampleRatio: 0.8 },
  ];
  return {
    schemaVersion: 1,
    title: "Two-hand forward-guard locomotion product review (inactive)",
    framing: "avatar-and-equipment",
    motions: poses.flatMap((pose) => {
      const locomotionId = pose.id.split("-")[0];
      const output = forwardGuardOutputs.get(locomotionId);
      if (!output)
        throw new Error(`Forward-guard output is missing ${pose.id}`);
      return EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `forward-guard-${pose.id}-${camera.id}`,
        name: `${pose.name} · ${camera.id}`,
        asset: output.outputAsset,
        sampleRatio: pose.sampleRatio,
        heldEquipmentEmote: locomotionId,
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        equipmentClearance: {
          ...TWO_HAND_PRODUCT_CLEARANCE,
          maximumProjectedBodyOverlapRatio: 0.15,
        },
      }));
    }),
  };
}

export function twoHandControlledGuardReviewManifestFor(outputs) {
  const controlledGuardOutputs = new Map(
    outputs
      .filter((output) => output.profileId === "controlled-guard")
      .map((output) => [output.locomotionId, output]),
  );
  const poses = [
    { id: "idle", name: "Controlled guard idle", sampleRatio: 0.4 },
    { id: "walk-20", name: "Controlled guard walk 20%", sampleRatio: 0.2 },
    { id: "walk-50", name: "Controlled guard walk 50%", sampleRatio: 0.5 },
    { id: "walk-80", name: "Controlled guard walk 80%", sampleRatio: 0.8 },
    { id: "run-20", name: "Controlled guard run 20%", sampleRatio: 0.2 },
    { id: "run-50", name: "Controlled guard run 50%", sampleRatio: 0.5 },
    { id: "run-80", name: "Controlled guard run 80%", sampleRatio: 0.8 },
  ];
  return {
    schemaVersion: 1,
    title: "Two-hand controlled-guard locomotion review (inactive)",
    framing: "avatar-and-equipment",
    motions: poses.flatMap((pose) => {
      const locomotionId = pose.id.split("-")[0];
      const output = controlledGuardOutputs.get(locomotionId);
      if (!output) {
        throw new Error(`Controlled-guard output is missing ${pose.id}`);
      }
      return EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `controlled-guard-${pose.id}-${camera.id}`,
        name: `${pose.name} · ${camera.id}`,
        asset: output.outputAsset,
        sampleRatio: pose.sampleRatio,
        heldEquipmentEmote: locomotionId,
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        avatarGrounding: { ...TWO_HAND_PRODUCT_GROUNDING },
        equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
      }));
    }),
  };
}

export function twoHandCurrentAttackDenseReviewManifestFor() {
  return {
    schemaVersion: 1,
    title: "Two-hand current attack dense product sweep (inactive)",
    framing: "avatar-and-equipment",
    motions: TWO_HAND_DENSE_SAMPLE_RATIOS.flatMap((sampleRatio) => {
      const phase = String(Math.round(sampleRatio * 100)).padStart(2, "0");
      return EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `current-dense-${phase}-${camera.id}`,
        name: `Current attack ${phase}% · ${camera.id}`,
        asset: "packages/server/world/assets/emotes/emote-2h-slash.glb",
        sampleRatio,
        heldEquipmentEmote: "2h-slash",
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
      }));
    }),
  };
}

export function twoHandWoodcuttingAttackReviewManifestFor() {
  return {
    schemaVersion: 1,
    title: "Two-hand woodcutting-source choreography review (inactive)",
    framing: "avatar-and-equipment",
    motions: TWO_HAND_ATTACK_REVIEW_PHASES.flatMap((phase) =>
      EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
        id: `woodcutting-attack-${phase.id}-${camera.id}`,
        name: `Woodcutting source · ${phase.name} · ${camera.id}`,
        asset:
          "packages/server/world/assets/emotes/emote-steve-woodcutting.glb",
        sampleRatio: phase.sampleRatio,
        heldEquipmentEmote: "2h-slash",
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
        equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
      })),
    ),
  };
}

export function twoHandTorsoCutReviewManifestFor(outputs) {
  return {
    schemaVersion: 1,
    title: "Two-hand controlled torso-cut product review (inactive)",
    framing: "avatar-and-equipment",
    motions: outputs.flatMap((output) =>
      TWO_HAND_ATTACK_REVIEW_PHASES.flatMap((phase) =>
        EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
          id: `${output.id}-${phase.id}-${camera.id}`,
          name: `${output.name} · ${phase.name} · ${camera.id}`,
          asset: output.outputAsset,
          sampleRatio: phase.sampleRatio,
          heldEquipmentEmote: "2h-slash",
          cameraYawDegrees: camera.yaw,
          cameraPitchDegrees: 8,
          avatarGrounding: { ...TWO_HAND_PRODUCT_GROUNDING },
          equipmentClearance: { ...TWO_HAND_PRODUCT_CLEARANCE },
        })),
      ),
    ),
  };
}

export function twoHandControlledTorsoCutReviewManifestFor(outputs) {
  const selected = outputs.filter((output) => output.id === "controlled-20");
  if (selected.length !== 1) {
    throw new Error("Controlled 20° torso-cut output is missing or duplicated");
  }
  return {
    ...twoHandTorsoCutReviewManifestFor(selected),
    title: "Two-hand controlled 20° torso-cut acceptance review (inactive)",
  };
}

export function twoHandGroundedTorsoCutReviewManifestFor(outputs) {
  const selected = outputs.filter((output) => output.id === "grounded-20");
  if (selected.length !== 1) {
    throw new Error("Grounded 20° torso-cut output is missing or duplicated");
  }
  return {
    ...twoHandTorsoCutReviewManifestFor(selected),
    title: "Two-hand grounded 20° cut acceptance review (inactive)",
  };
}

export function twoHandPlantedTorsoCutReviewManifestFor(outputs) {
  const selected = outputs.filter((output) => output.id === "planted-20");
  if (selected.length !== 1) {
    throw new Error("Planted 20° torso-cut output is missing or duplicated");
  }
  return {
    ...twoHandTorsoCutReviewManifestFor(selected),
    title: "Two-hand planted 20° cut acceptance review (inactive)",
  };
}

export function twoHandPlantedSweepTorsoCutReviewManifestFor(outputs) {
  const selected = outputs.filter((output) => output.id === "planted-45");
  if (selected.length !== 1) {
    throw new Error("Planted 45° torso-cut output is missing or duplicated");
  }
  return {
    ...twoHandTorsoCutReviewManifestFor(selected),
    title: "Two-hand planted 45° sweep acceptance review (inactive)",
  };
}

async function run({ check }) {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await buildTwoHandLocomotionCandidates(workspaceRoot);
  const torsoCutReport = await buildTwoHandTorsoCutCandidates(workspaceRoot);
  const plantedTransitionReport = await twoHandPlantedTransitionReportFor(
    report.outputs,
    torsoCutReport.outputs,
  );
  for (const output of report.outputs) {
    const outputPath = path.join(
      workspaceRoot,
      "packages/server/world/assets",
      output.outputAsset,
    );
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(output.bytes)
      ) {
        throw new Error(`${output.outputAsset} is missing or stale`);
      }
    } else {
      writeAtomic(outputPath, output.bytes);
    }
  }
  for (const output of torsoCutReport.outputs) {
    const outputPath = path.join(
      workspaceRoot,
      "packages/server/world/assets",
      output.outputAsset,
    );
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(output.bytes)
      ) {
        throw new Error(`${output.outputAsset} is missing or stale`);
      }
    } else {
      writeAtomic(outputPath, output.bytes);
    }
  }
  const reportPath = path.join(workspaceRoot, REPORT_PATH);
  const serialized = `${JSON.stringify(serializableReport(report), null, 2)}\n`;
  if (check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error(`${REPORT_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  const torsoCutReportPath = path.join(workspaceRoot, TORSO_CUT_REPORT_PATH);
  const serializedTorsoCutReport = `${JSON.stringify(
    serializableReport(torsoCutReport),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(torsoCutReportPath) ||
      readFileSync(torsoCutReportPath, "utf8") !== serializedTorsoCutReport
    ) {
      throw new Error(`${TORSO_CUT_REPORT_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(torsoCutReportPath, serializedTorsoCutReport);
  }
  const plantedTransitionReportPath = path.join(
    workspaceRoot,
    PLANTED_TRANSITION_REPORT_PATH,
  );
  const serializedPlantedTransitionReport = `${JSON.stringify(
    plantedTransitionReport,
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(plantedTransitionReportPath) ||
      readFileSync(plantedTransitionReportPath, "utf8") !==
        serializedPlantedTransitionReport
    ) {
      throw new Error(`${PLANTED_TRANSITION_REPORT_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(plantedTransitionReportPath, serializedPlantedTransitionReport);
  }
  const profileReviewManifestPath = path.join(
    workspaceRoot,
    PROFILE_REVIEW_MANIFEST_PATH,
  );
  const serializedProfileReviewManifest = `${JSON.stringify(
    twoHandLocomotionProfileReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(profileReviewManifestPath) ||
      readFileSync(profileReviewManifestPath, "utf8") !==
        serializedProfileReviewManifest
    ) {
      throw new Error(`${PROFILE_REVIEW_MANIFEST_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(profileReviewManifestPath, serializedProfileReviewManifest);
  }
  const stableCombatReviewManifestPath = path.join(
    workspaceRoot,
    STABLE_COMBAT_REVIEW_MANIFEST_PATH,
  );
  const serializedStableCombatReviewManifest = `${JSON.stringify(
    twoHandStableCombatReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(stableCombatReviewManifestPath) ||
      readFileSync(stableCombatReviewManifestPath, "utf8") !==
        serializedStableCombatReviewManifest
    ) {
      throw new Error(
        `${STABLE_COMBAT_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      stableCombatReviewManifestPath,
      serializedStableCombatReviewManifest,
    );
  }
  const stableDetailReviewManifestPath = path.join(
    workspaceRoot,
    STABLE_DETAIL_REVIEW_MANIFEST_PATH,
  );
  const serializedStableDetailReviewManifest = `${JSON.stringify(
    twoHandStableDetailReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(stableDetailReviewManifestPath) ||
      readFileSync(stableDetailReviewManifestPath, "utf8") !==
        serializedStableDetailReviewManifest
    ) {
      throw new Error(
        `${STABLE_DETAIL_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      stableDetailReviewManifestPath,
      serializedStableDetailReviewManifest,
    );
  }
  const sourceComparisonReviewManifestPath = path.join(
    workspaceRoot,
    SOURCE_COMPARISON_REVIEW_MANIFEST_PATH,
  );
  const serializedSourceComparisonReviewManifest = `${JSON.stringify(
    twoHandMotionSourceComparisonManifestFor(),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(sourceComparisonReviewManifestPath) ||
      readFileSync(sourceComparisonReviewManifestPath, "utf8") !==
        serializedSourceComparisonReviewManifest
    ) {
      throw new Error(
        `${SOURCE_COMPARISON_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      sourceComparisonReviewManifestPath,
      serializedSourceComparisonReviewManifest,
    );
  }
  const highGuardReviewManifestPath = path.join(
    workspaceRoot,
    HIGH_GUARD_REVIEW_MANIFEST_PATH,
  );
  const serializedHighGuardReviewManifest = `${JSON.stringify(
    twoHandHighGuardReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(highGuardReviewManifestPath) ||
      readFileSync(highGuardReviewManifestPath, "utf8") !==
        serializedHighGuardReviewManifest
    ) {
      throw new Error(`${HIGH_GUARD_REVIEW_MANIFEST_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(highGuardReviewManifestPath, serializedHighGuardReviewManifest);
  }
  const forwardGuardReviewManifestPath = path.join(
    workspaceRoot,
    FORWARD_GUARD_REVIEW_MANIFEST_PATH,
  );
  const serializedForwardGuardReviewManifest = `${JSON.stringify(
    twoHandForwardGuardReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(forwardGuardReviewManifestPath) ||
      readFileSync(forwardGuardReviewManifestPath, "utf8") !==
        serializedForwardGuardReviewManifest
    ) {
      throw new Error(
        `${FORWARD_GUARD_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      forwardGuardReviewManifestPath,
      serializedForwardGuardReviewManifest,
    );
  }
  const controlledGuardReviewManifestPath = path.join(
    workspaceRoot,
    CONTROLLED_GUARD_REVIEW_MANIFEST_PATH,
  );
  const serializedControlledGuardReviewManifest = `${JSON.stringify(
    twoHandControlledGuardReviewManifestFor(report.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(controlledGuardReviewManifestPath) ||
      readFileSync(controlledGuardReviewManifestPath, "utf8") !==
        serializedControlledGuardReviewManifest
    ) {
      throw new Error(
        `${CONTROLLED_GUARD_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      controlledGuardReviewManifestPath,
      serializedControlledGuardReviewManifest,
    );
  }
  const currentAttackDenseReviewManifestPath = path.join(
    workspaceRoot,
    CURRENT_ATTACK_DENSE_REVIEW_MANIFEST_PATH,
  );
  const serializedCurrentAttackDenseReviewManifest = `${JSON.stringify(
    twoHandCurrentAttackDenseReviewManifestFor(),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(currentAttackDenseReviewManifestPath) ||
      readFileSync(currentAttackDenseReviewManifestPath, "utf8") !==
        serializedCurrentAttackDenseReviewManifest
    ) {
      throw new Error(
        `${CURRENT_ATTACK_DENSE_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      currentAttackDenseReviewManifestPath,
      serializedCurrentAttackDenseReviewManifest,
    );
  }
  const woodcuttingAttackReviewManifestPath = path.join(
    workspaceRoot,
    WOODCUTTING_ATTACK_REVIEW_MANIFEST_PATH,
  );
  const serializedWoodcuttingAttackReviewManifest = `${JSON.stringify(
    twoHandWoodcuttingAttackReviewManifestFor(),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(woodcuttingAttackReviewManifestPath) ||
      readFileSync(woodcuttingAttackReviewManifestPath, "utf8") !==
        serializedWoodcuttingAttackReviewManifest
    ) {
      throw new Error(
        `${WOODCUTTING_ATTACK_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      woodcuttingAttackReviewManifestPath,
      serializedWoodcuttingAttackReviewManifest,
    );
  }
  const torsoCutReviewManifestPath = path.join(
    workspaceRoot,
    TORSO_CUT_REVIEW_MANIFEST_PATH,
  );
  const serializedTorsoCutReviewManifest = `${JSON.stringify(
    twoHandTorsoCutReviewManifestFor(torsoCutReport.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(torsoCutReviewManifestPath) ||
      readFileSync(torsoCutReviewManifestPath, "utf8") !==
        serializedTorsoCutReviewManifest
    ) {
      throw new Error(`${TORSO_CUT_REVIEW_MANIFEST_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(torsoCutReviewManifestPath, serializedTorsoCutReviewManifest);
  }
  const controlledTorsoCutReviewManifestPath = path.join(
    workspaceRoot,
    CONTROLLED_TORSO_CUT_REVIEW_MANIFEST_PATH,
  );
  const serializedControlledTorsoCutReviewManifest = `${JSON.stringify(
    twoHandControlledTorsoCutReviewManifestFor(torsoCutReport.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(controlledTorsoCutReviewManifestPath) ||
      readFileSync(controlledTorsoCutReviewManifestPath, "utf8") !==
        serializedControlledTorsoCutReviewManifest
    ) {
      throw new Error(
        `${CONTROLLED_TORSO_CUT_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      controlledTorsoCutReviewManifestPath,
      serializedControlledTorsoCutReviewManifest,
    );
  }
  const groundedTorsoCutReviewManifestPath = path.join(
    workspaceRoot,
    GROUNDED_TORSO_CUT_REVIEW_MANIFEST_PATH,
  );
  const serializedGroundedTorsoCutReviewManifest = `${JSON.stringify(
    twoHandGroundedTorsoCutReviewManifestFor(torsoCutReport.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(groundedTorsoCutReviewManifestPath) ||
      readFileSync(groundedTorsoCutReviewManifestPath, "utf8") !==
        serializedGroundedTorsoCutReviewManifest
    ) {
      throw new Error(
        `${GROUNDED_TORSO_CUT_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      groundedTorsoCutReviewManifestPath,
      serializedGroundedTorsoCutReviewManifest,
    );
  }
  const plantedTorsoCutReviewManifestPath = path.join(
    workspaceRoot,
    PLANTED_TORSO_CUT_REVIEW_MANIFEST_PATH,
  );
  const serializedPlantedTorsoCutReviewManifest = `${JSON.stringify(
    twoHandPlantedTorsoCutReviewManifestFor(torsoCutReport.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(plantedTorsoCutReviewManifestPath) ||
      readFileSync(plantedTorsoCutReviewManifestPath, "utf8") !==
        serializedPlantedTorsoCutReviewManifest
    ) {
      throw new Error(
        `${PLANTED_TORSO_CUT_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      plantedTorsoCutReviewManifestPath,
      serializedPlantedTorsoCutReviewManifest,
    );
  }
  const plantedSweepTorsoCutReviewManifestPath = path.join(
    workspaceRoot,
    PLANTED_SWEEP_TORSO_CUT_REVIEW_MANIFEST_PATH,
  );
  const serializedPlantedSweepTorsoCutReviewManifest = `${JSON.stringify(
    twoHandPlantedSweepTorsoCutReviewManifestFor(torsoCutReport.outputs),
    null,
    2,
  )}\n`;
  if (check) {
    if (
      !existsSync(plantedSweepTorsoCutReviewManifestPath) ||
      readFileSync(plantedSweepTorsoCutReviewManifestPath, "utf8") !==
        serializedPlantedSweepTorsoCutReviewManifest
    ) {
      throw new Error(
        `${PLANTED_SWEEP_TORSO_CUT_REVIEW_MANIFEST_PATH} is missing or stale`,
      );
    }
  } else {
    writeAtomic(
      plantedSweepTorsoCutReviewManifestPath,
      serializedPlantedSweepTorsoCutReviewManifest,
    );
  }
  console.log(
    `${check ? "Verified" : "Built"} ${report.outputs.length} isolated two-hand locomotion candidates and ${torsoCutReport.outputs.length} isolated torso-cut candidates`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.size !== 1 || (!args.has("--write") && !args.has("--check"))) {
    console.error(
      "Usage: node scripts/build-two-hand-locomotion-emotes.mjs --write|--check",
    );
    process.exitCode = 1;
  } else {
    run({ check: args.has("--check") }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
