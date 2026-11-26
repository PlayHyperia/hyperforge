#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
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
import { Quaternion } from "three";

export const BOW_CARRY_REFERENCE = Object.freeze({
  asset: "emotes/emote-idle.glb",
  sampleRatio: 0.35,
});

export const BOW_CARRY_ARM_BONES = Object.freeze([
  "mixamorig:LeftShoulder",
  "mixamorig:LeftArm",
  "mixamorig:LeftForeArm",
  "mixamorig:LeftHand",
  "mixamorig:RightShoulder",
  "mixamorig:RightArm",
  "mixamorig:RightForeArm",
  "mixamorig:RightHand",
]);

export const BOW_CARRY_BLEND_CANDIDATES = Object.freeze([
  {
    id: "natural",
    strengthByBone: Object.freeze({
      "mixamorig:LeftShoulder": 0.65,
      "mixamorig:LeftArm": 0.75,
      "mixamorig:LeftForeArm": 0.9,
      "mixamorig:LeftHand": 0.95,
      "mixamorig:RightShoulder": 0.1,
      "mixamorig:RightArm": 0.1,
      "mixamorig:RightForeArm": 0.1,
      "mixamorig:RightHand": 0.1,
    }),
  },
  { id: "relaxed", strength: 0.75 },
  { id: "balanced", strength: 0.875 },
  { id: "locked", strength: 1 },
]);

const BASE_LOCOMOTION = Object.freeze([
  {
    id: "idle",
    asset: "emotes/emote-idle.glb",
    sampleRatio: 0.35,
  },
  {
    id: "walk",
    asset: "emotes/emote-walk.glb",
    sampleRatio: 0.45,
  },
  {
    id: "run",
    asset: "emotes/emote-run.glb",
    sampleRatio: 0.45,
  },
]);

const REPORT_PATH =
  "artifacts/duel-avatar-candidates/bow-carry-locomotion-candidate-build-report.json";
const MOTION_MANIFEST_PATH =
  "artifacts/duel-avatar-candidates/bow-carry-locomotion-candidate-matrix.json";
const PHASE_SWEEP_SAMPLE_RATIOS = Object.freeze([0.05, 0.25, 0.45, 0.65, 0.85]);
const BOW_ATTACK_REVIEW_PHASES = Object.freeze([
  { id: "raise", sampleRatio: 0.1, name: "Raise 10%" },
  { id: "nock", sampleRatio: 0.2, name: "Nock 20%" },
  { id: "draw", sampleRatio: 0.35, name: "Draw 35%" },
  { id: "full-draw", sampleRatio: 0.55, name: "Full draw 55%" },
  { id: "release", sampleRatio: 0.7, name: "Release 70%" },
  {
    id: "follow-through",
    sampleRatio: 0.85,
    name: "Follow-through 85%",
  },
  { id: "recover", sampleRatio: 0.98, name: "Recovery 98%" },
]);
const BOW_EXACT_REVIEW_CAMERA_ANGLES = Object.freeze([
  { id: "front", yaw: 0 },
  { id: "profile-left", yaw: -90 },
  { id: "rear", yaw: 180 },
  { id: "profile-right", yaw: 90 },
]);
const BOW_HIT_REACTION_REVIEW_PHASES = Object.freeze([
  {
    id: "peak-left",
    name: "Hit peak left",
    side: -1,
    elapsedSeconds: 0.0504,
  },
  {
    id: "peak-right",
    name: "Hit peak right",
    side: 1,
    elapsedSeconds: 0.0504,
  },
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
  const times = sampler?.getInput()?.getArray();
  const values = sampler?.getOutput()?.getArray();
  if (
    !sampler ||
    sampler.getInterpolation() !== "LINEAR" ||
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
  return new Quaternion()
    .fromArray(values, lowerIndex * 4)
    .normalize()
    .slerp(
      new Quaternion().fromArray(values, upperIndex * 4).normalize(),
      alpha,
    )
    .normalize();
}

function parentWorldRotation(node) {
  const parent = node.getParentNode();
  return parent
    ? new Quaternion().fromArray(parent.getWorldRotation()).normalize()
    : new Quaternion();
}

function toNormalizedQuaternion(node, localRotation) {
  return localRotation
    .clone()
    .premultiply(parentWorldRotation(node))
    .multiply(
      new Quaternion().fromArray(node.getWorldRotation()).normalize().invert(),
    )
    .normalize();
}

function fromNormalizedQuaternion(node, normalizedRotation) {
  return normalizedRotation
    .clone()
    .premultiply(parentWorldRotation(node).invert())
    .multiply(new Quaternion().fromArray(node.getWorldRotation()).normalize())
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

function applyCarryPose({ document, targets, strength, outputClipName }) {
  const animations = document.getRoot().listAnimations();
  if (animations.length !== 1) {
    throw new Error("Locomotion source must contain exactly one animation");
  }
  const animation = animations[0];
  const nodes = new Map(
    document
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const overrides = [];

  for (const boneName of BOW_CARRY_ARM_BONES) {
    const node = nodes.get(boneName);
    const target = targets.get(boneName);
    if (!node || !target) {
      throw new Error(`Bow carry composition is missing ${boneName}`);
    }
    const channel = findRotationChannel(animation, boneName, "base locomotion");
    const sampler = channel.getSampler();
    const times = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput();
    const sourceValues = output?.getArray();
    if (
      !sampler ||
      sampler.getInterpolation() !== "LINEAR" ||
      !times ||
      !output ||
      !sourceValues ||
      sourceValues.length !== times.length * 4
    ) {
      throw new Error(`Base locomotion has invalid ${boneName} keys`);
    }

    const values = new Float32Array(sourceValues.length);
    const boneStrength =
      typeof strength === "number" ? strength : strength[boneName];
    if (
      !Number.isFinite(boneStrength) ||
      boneStrength < 0 ||
      boneStrength > 1
    ) {
      throw new Error(`Bow carry strength is invalid for ${boneName}`);
    }
    let maximumSourceDeviationDegrees = 0;
    let maximumRetainedMotionDegrees = 0;
    let previousNormalized = null;
    for (let index = 0; index < times.length; index += 1) {
      const sourceLocal = new Quaternion()
        .fromArray(sourceValues, index * 4)
        .normalize();
      const sourceNormalized = toNormalizedQuaternion(node, sourceLocal);
      const composedNormalized = sourceNormalized
        .clone()
        .slerp(target, boneStrength)
        .normalize();
      fromNormalizedQuaternion(node, composedNormalized).toArray(
        values,
        index * 4,
      );
      maximumSourceDeviationDegrees = Math.max(
        maximumSourceDeviationDegrees,
        quaternionDeltaDegrees(sourceNormalized, composedNormalized),
      );
      if (previousNormalized) {
        maximumRetainedMotionDegrees = Math.max(
          maximumRetainedMotionDegrees,
          quaternionDeltaDegrees(previousNormalized, composedNormalized),
        );
      }
      previousNormalized = composedNormalized;
    }
    output.setArray(values);
    overrides.push({
      boneName,
      blendStrength: boneStrength,
      keyframeCount: times.length,
      maximumSourceDeviationDegrees: rounded(maximumSourceDeviationDegrees),
      maximumRetainedMotionDegrees: rounded(maximumRetainedMotionDegrees),
    });
  }

  animation.setName(outputClipName);
  return {
    durationSeconds: animationDurationSeconds(animation, outputClipName),
    channelCount: animation.listChannels().length,
    overrides,
  };
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

function serializableReport(report) {
  return {
    ...report,
    outputs: report.outputs.map(({ bytes: _bytes, ...output }) => output),
  };
}

function motionManifestFor(outputs) {
  return {
    schemaVersion: 1,
    title: "Bow carry locomotion candidate matrix (inactive)",
    framing: "avatar-and-equipment",
    motions: outputs.map((output) => ({
      id: `${output.candidateId}-${output.locomotionId}`,
      name: `${output.candidateName} · ${output.locomotionName}`,
      asset: output.outputAsset,
      sampleRatio: output.sampleRatio,
      heldEquipmentEmote: output.locomotionId,
    })),
  };
}

function motionPhaseSweepManifestFor(outputs, candidate) {
  const candidateOutputs = new Map(
    outputs
      .filter((output) => output.candidateId === candidate.id)
      .map((output) => [output.locomotionId, output]),
  );
  const idle = candidateOutputs.get("idle");
  if (!idle) throw new Error(`${candidate.id} is missing idle output`);
  const motions = [
    {
      id: `${candidate.id}-idle`,
      name: `${idle.candidateName} · Idle`,
      asset: idle.outputAsset,
      sampleRatio: idle.sampleRatio,
      heldEquipmentEmote: "idle",
    },
  ];
  for (const locomotionId of ["walk", "run"]) {
    const output = candidateOutputs.get(locomotionId);
    if (!output) {
      throw new Error(`${candidate.id} is missing ${locomotionId} output`);
    }
    for (const sampleRatio of PHASE_SWEEP_SAMPLE_RATIOS) {
      const phase = Math.round(sampleRatio * 100)
        .toString()
        .padStart(2, "0");
      motions.push({
        id: `${candidate.id}-${locomotionId}-${phase}`,
        name: `${output.candidateName} · ${output.locomotionName} ${phase}%`,
        asset: output.outputAsset,
        sampleRatio,
        heldEquipmentEmote: locomotionId,
      });
    }
  }
  return {
    schemaVersion: 1,
    title: `Bow carry ${candidate.id} full-cycle phase sweep (inactive)`,
    framing: "avatar-and-equipment",
    motions,
  };
}

export function candidateMultiviewManifestFor(outputs, candidateId) {
  const representativePoses = [
    { locomotionId: "idle", sampleRatio: 0.35, name: "Idle" },
    { locomotionId: "walk", sampleRatio: 0.45, name: "Walk 45%" },
    { locomotionId: "run", sampleRatio: 0.25, name: "Run 25%" },
    { locomotionId: "run", sampleRatio: 0.65, name: "Run 65%" },
  ];
  const cameraAngles = [
    { id: "rear-left", yaw: -105 },
    { id: "front-left", yaw: -35 },
    { id: "front-right", yaw: 35 },
    { id: "rear-right", yaw: 105 },
  ];
  const candidateOutputs = new Map(
    outputs
      .filter((output) => output.candidateId === candidateId)
      .map((output) => [output.locomotionId, output]),
  );
  return {
    schemaVersion: 1,
    title: `Bow carry ${candidateId} multi-angle review (inactive)`,
    framing: "avatar-and-equipment",
    motions: representativePoses.flatMap((pose) => {
      const output = candidateOutputs.get(pose.locomotionId);
      if (!output) {
        throw new Error(
          `${candidateId} is missing ${pose.locomotionId} output`,
        );
      }
      return cameraAngles.map((camera) => ({
        id: `${candidateId}-${pose.locomotionId}-${Math.round(
          pose.sampleRatio * 100,
        )}-${camera.id}`,
        name: `${pose.name} · ${camera.id}`,
        asset: output.outputAsset,
        sampleRatio: pose.sampleRatio,
        heldEquipmentEmote: pose.locomotionId,
        cameraYawDegrees: camera.yaw,
        cameraPitchDegrees: 8,
      }));
    }),
  };
}

export function candidateCombatSequenceManifestFor(outputs, candidateId) {
  const candidateOutputs = new Map(
    outputs
      .filter((output) => output.candidateId === candidateId)
      .map((output) => [output.locomotionId, output]),
  );
  const locomotion = [
    { id: "idle", sampleRatio: 0.35, name: "Carry idle" },
    { id: "walk", sampleRatio: 0.45, name: "Carry walk" },
    { id: "run", sampleRatio: 0.25, name: "Carry run 25%" },
    { id: "run", sampleRatio: 0.65, name: "Carry run 65%" },
  ].map((pose, index) => {
    const output = candidateOutputs.get(pose.id);
    if (!output) {
      throw new Error(`${candidateId} is missing ${pose.id} output`);
    }
    return {
      id: `${candidateId}-carry-${pose.id}-${index}`,
      name: pose.name,
      asset: output.outputAsset,
      sampleRatio: pose.sampleRatio,
      heldEquipmentEmote: pose.id,
    };
  });
  const attackPhases = BOW_ATTACK_REVIEW_PHASES.map((phase) => ({
    id: `${candidateId}-attack-${phase.id}`,
    name: phase.name,
    asset: "emotes/emote-range.glb",
    sampleRatio: phase.sampleRatio,
    heldEquipmentEmote: "range",
  }));
  const fullDrawAngles = [
    { id: "rear-left", yaw: -105 },
    { id: "front-left", yaw: -35 },
    { id: "front-right", yaw: 35 },
    { id: "rear-right", yaw: 105 },
  ].map((camera) => ({
    id: `${candidateId}-full-draw-${camera.id}`,
    name: `Full draw · ${camera.id}`,
    asset: "emotes/emote-range.glb",
    sampleRatio: 0.55,
    heldEquipmentEmote: "range",
    cameraYawDegrees: camera.yaw,
    cameraPitchDegrees: 8,
  }));
  return {
    schemaVersion: 1,
    title: `Bow carry ${candidateId} into full ranged cycle (inactive)`,
    framing: "avatar-and-equipment",
    motions: [...locomotion, ...attackPhases, ...fullDrawAngles],
  };
}

export function candidateCombatMultiviewManifestFor(outputs, candidateId) {
  const idle = outputs.find(
    (output) =>
      output.candidateId === candidateId && output.locomotionId === "idle",
  );
  if (!idle) throw new Error(`${candidateId} is missing idle output`);

  const attackMotions = BOW_ATTACK_REVIEW_PHASES.flatMap((phase) =>
    BOW_EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
      id: `${candidateId}-attack-${phase.id}-${camera.id}`,
      name: `${phase.name} · ${camera.id}`,
      asset: "emotes/emote-range.glb",
      sampleRatio: phase.sampleRatio,
      heldEquipmentEmote: "range",
      cameraYawDegrees: camera.yaw,
      cameraPitchDegrees: 8,
    })),
  );
  const hitReactionMotions = BOW_HIT_REACTION_REVIEW_PHASES.flatMap((phase) =>
    BOW_EXACT_REVIEW_CAMERA_ANGLES.map((camera) => ({
      id: `${candidateId}-hit-${phase.id}-${camera.id}`,
      name: `${phase.name} · ${camera.id}`,
      asset: idle.outputAsset,
      sampleRatio: idle.sampleRatio,
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
    title: `Bow combat ${candidateId} exact-angle attack and hit-reaction review (inactive)`,
    framing: "avatar-and-equipment",
    motions: [...attackMotions, ...hitReactionMotions],
  };
}

export async function buildBowDuelLocomotionCandidates(workspaceRoot) {
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const referenceBytes = readFileSync(
    path.join(assetsRoot, BOW_CARRY_REFERENCE.asset),
  );
  const referenceDocument = await new NodeIO().readBinary(
    new Uint8Array(referenceBytes),
  );
  const referenceAnimations = referenceDocument.getRoot().listAnimations();
  if (referenceAnimations.length !== 1) {
    throw new Error("Bow carry reference must contain exactly one animation");
  }
  const referenceAnimation = referenceAnimations[0];
  const referenceNodes = new Map(
    referenceDocument
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const referenceSampleSeconds =
    animationDurationSeconds(referenceAnimation, BOW_CARRY_REFERENCE.asset) *
    BOW_CARRY_REFERENCE.sampleRatio;
  const targets = new Map();
  for (const boneName of BOW_CARRY_ARM_BONES) {
    const node = referenceNodes.get(boneName);
    if (!node) {
      throw new Error(`${BOW_CARRY_REFERENCE.asset} is missing ${boneName}`);
    }
    targets.set(
      boneName,
      toNormalizedQuaternion(
        node,
        sampleQuaternion(
          findRotationChannel(
            referenceAnimation,
            boneName,
            BOW_CARRY_REFERENCE.asset,
          ),
          referenceSampleSeconds,
          `${BOW_CARRY_REFERENCE.asset}:${boneName}`,
        ),
      ),
    );
  }

  const outputs = [];
  for (const candidate of BOW_CARRY_BLEND_CANDIDATES) {
    for (const locomotion of BASE_LOCOMOTION) {
      const baseBytes = readFileSync(path.join(assetsRoot, locomotion.asset));
      const document = await new NodeIO().readBinary(new Uint8Array(baseBytes));
      const outputAsset = `emotes/candidates/bow-carry-${candidate.id}-${locomotion.id}-steve.glb`;
      const strength = candidate.strengthByBone ?? candidate.strength;
      const composition = applyCarryPose({
        document,
        targets,
        strength,
        outputClipName: `Hyperia_Bow_Carry_${candidate.id}_${locomotion.id}`,
      });
      const bytes = Buffer.from(await new NodeIO().writeBinary(document));
      outputs.push({
        candidateId: candidate.id,
        candidateName:
          typeof strength === "number"
            ? `${candidate.id} ${(strength * 100).toFixed(1)}%`
            : `${candidate.id} asymmetric bow-arm carry`,
        blendStrength: typeof strength === "number" ? strength : null,
        blendStrengthByBone:
          typeof strength === "number" ? null : { ...strength },
        locomotionId: locomotion.id,
        locomotionName: locomotion.id[0].toUpperCase() + locomotion.id.slice(1),
        baseAsset: locomotion.asset,
        baseSha256: sha256(baseBytes),
        outputAsset,
        sampleRatio: locomotion.sampleRatio,
        bytes,
        byteLength: bytes.length,
        sha256: sha256(bytes),
        validation: await validateCandidate(bytes, outputAsset),
        ...composition,
      });
    }
  }

  return {
    schemaVersion: 1,
    activationStatus: "inactive-candidate",
    approvedForRuntimeActivation: false,
    reference: {
      ...BOW_CARRY_REFERENCE,
      sha256: sha256(referenceBytes),
      sampleSeconds: referenceSampleSeconds,
    },
    armBones: [...BOW_CARRY_ARM_BONES],
    candidates: BOW_CARRY_BLEND_CANDIDATES.map((candidate) => ({
      ...candidate,
    })),
    outputs,
  };
}

async function run() {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await buildBowDuelLocomotionCandidates(workspaceRoot);
  for (const output of report.outputs) {
    writeAtomic(
      path.join(
        workspaceRoot,
        "packages/server/world/assets",
        output.outputAsset,
      ),
      output.bytes,
    );
  }
  writeAtomic(
    path.join(workspaceRoot, REPORT_PATH),
    `${JSON.stringify(serializableReport(report), null, 2)}\n`,
  );
  writeAtomic(
    path.join(workspaceRoot, MOTION_MANIFEST_PATH),
    `${JSON.stringify(motionManifestFor(report.outputs), null, 2)}\n`,
  );
  for (const candidate of BOW_CARRY_BLEND_CANDIDATES) {
    writeAtomic(
      path.join(
        workspaceRoot,
        `artifacts/duel-avatar-candidates/bow-carry-${candidate.id}-phase-sweep.json`,
      ),
      `${JSON.stringify(
        motionPhaseSweepManifestFor(report.outputs, candidate),
        null,
        2,
      )}\n`,
    );
    writeAtomic(
      path.join(
        workspaceRoot,
        `artifacts/duel-avatar-candidates/bow-carry-${candidate.id}-combat-sequence.json`,
      ),
      `${JSON.stringify(
        candidateCombatSequenceManifestFor(report.outputs, candidate.id),
        null,
        2,
      )}\n`,
    );
    writeAtomic(
      path.join(
        workspaceRoot,
        `artifacts/duel-avatar-candidates/bow-carry-${candidate.id}-combat-multiview.json`,
      ),
      `${JSON.stringify(
        candidateCombatMultiviewManifestFor(report.outputs, candidate.id),
        null,
        2,
      )}\n`,
    );
  }
  for (const candidate of BOW_CARRY_BLEND_CANDIDATES) {
    writeAtomic(
      path.join(
        workspaceRoot,
        `artifacts/duel-avatar-candidates/bow-carry-${candidate.id}-multiview.json`,
      ),
      `${JSON.stringify(
        candidateMultiviewManifestFor(report.outputs, candidate.id),
        null,
        2,
      )}\n`,
    );
  }
  console.log(
    `Built ${report.outputs.length} inactive bow locomotion candidates`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error(
      "Usage: node scripts/build-bow-duel-locomotion-candidates.mjs",
    );
    process.exitCode = 1;
  } else {
    run().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
