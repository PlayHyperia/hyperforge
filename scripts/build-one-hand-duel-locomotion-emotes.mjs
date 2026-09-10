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
import { Quaternion } from "three";

export const ONE_HAND_GUARD_SAMPLE_RATIO = 0.2;
export const ONE_HAND_GUARD_BLEND_STRENGTH = 0.85;

export const ONE_HAND_WEAPON_ARM_BONES = Object.freeze([
  "mixamorig:RightShoulder",
  "mixamorig:RightArm",
  "mixamorig:RightForeArm",
  "mixamorig:RightHand",
]);

export const ONE_HAND_DUEL_LOCOMOTION_OUTPUTS = Object.freeze([
  {
    id: "one-hand-idle",
    baseAsset: "emotes/emote-idle.glb",
    outputAsset: "emotes/emote-one-hand-idle-steve.glb",
    outputClipName: "Hyperia_One_Hand_Duel_Idle",
  },
  {
    id: "one-hand-walk",
    baseAsset: "emotes/emote-walk.glb",
    outputAsset: "emotes/emote-one-hand-walk-steve.glb",
    outputClipName: "Hyperia_One_Hand_Duel_Walk",
  },
  {
    id: "one-hand-run",
    baseAsset: "emotes/emote-run.glb",
    outputAsset: "emotes/emote-one-hand-run-steve.glb",
    outputClipName: "Hyperia_One_Hand_Duel_Run",
  },
]);

const REFERENCE_ASSET = "emotes/emote_sword_swing.glb";
const REPORT_PATH =
  "artifacts/duel-avatar-candidates/one-hand-duel-locomotion-build-report.json";

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

/** Mirrors the normalized quaternion emitted by createEmoteFactory. */
function toNormalizedQuaternion(node, localRotation) {
  return localRotation
    .clone()
    .premultiply(parentWorldRotation(node))
    .multiply(
      new Quaternion().fromArray(node.getWorldRotation()).normalize().invert(),
    )
    .normalize();
}

/** Solve baseParent * q * inverse(baseWorld) = normalizedRotation. */
function fromNormalizedQuaternion(node, normalizedRotation) {
  return normalizedRotation
    .clone()
    .premultiply(parentWorldRotation(node).invert())
    .multiply(new Quaternion().fromArray(node.getWorldRotation()).normalize())
    .normalize();
}

function maximumQuaternionDeltaDegrees(a, b) {
  return (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
}

function stableAuditMetric(value) {
  return Number(value.toFixed(9));
}

function applyOneHandGuard({ baseDocument, referenceTargets, outputClipName }) {
  const animation = baseDocument.getRoot().listAnimations()[0];
  if (!animation || baseDocument.getRoot().listAnimations().length !== 1) {
    throw new Error("Locomotion source must contain exactly one animation");
  }
  const nodes = new Map(
    baseDocument
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const overrides = [];

  for (const boneName of ONE_HAND_WEAPON_ARM_BONES) {
    const node = nodes.get(boneName);
    const target = referenceTargets.get(boneName);
    if (!node || !target) {
      throw new Error(`Locomotion composition is missing ${boneName}`);
    }
    const rotationChannel = findRotationChannel(
      animation,
      boneName,
      "base locomotion",
    );
    const sampler = rotationChannel.getSampler();
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
    let previousNormalized = null;
    let maximumRetainedMotionDegrees = 0;
    for (let index = 0; index < times.length; index += 1) {
      const baseLocal = new Quaternion()
        .fromArray(sourceValues, index * 4)
        .normalize();
      const normalized = toNormalizedQuaternion(node, baseLocal)
        .slerp(target, ONE_HAND_GUARD_BLEND_STRENGTH)
        .normalize();
      fromNormalizedQuaternion(node, normalized).toArray(values, index * 4);
      if (previousNormalized) {
        maximumRetainedMotionDegrees = Math.max(
          maximumRetainedMotionDegrees,
          maximumQuaternionDeltaDegrees(previousNormalized, normalized),
        );
      }
      previousNormalized = normalized;
    }
    output.setArray(values);
    overrides.push({
      boneName,
      keyframeCount: times.length,
      maximumRetainedMotionDegrees: stableAuditMetric(
        maximumRetainedMotionDegrees,
      ),
      outputLoopSeamExact:
        values[0] === values[values.length - 4] &&
        values[1] === values[values.length - 3] &&
        values[2] === values[values.length - 2] &&
        values[3] === values[values.length - 1],
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

export async function buildOneHandDuelLocomotionEmotes(workspaceRoot) {
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const referenceBytes = readFileSync(path.join(assetsRoot, REFERENCE_ASSET));
  const referenceDocument = await new NodeIO().readBinary(
    new Uint8Array(referenceBytes),
  );
  const referenceAnimation = referenceDocument.getRoot().listAnimations()[0];
  if (
    !referenceAnimation ||
    referenceDocument.getRoot().listAnimations().length !== 1
  ) {
    throw new Error("One-hand guard reference must contain one animation");
  }
  const referenceNodes = new Map(
    referenceDocument
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );
  const referenceSampleSeconds =
    animationDurationSeconds(referenceAnimation, REFERENCE_ASSET) *
    ONE_HAND_GUARD_SAMPLE_RATIO;
  const referenceTargets = new Map();
  for (const boneName of ONE_HAND_WEAPON_ARM_BONES) {
    const node = referenceNodes.get(boneName);
    if (!node) throw new Error(`${REFERENCE_ASSET} is missing ${boneName}`);
    referenceTargets.set(
      boneName,
      toNormalizedQuaternion(
        node,
        sampleQuaternion(
          findRotationChannel(referenceAnimation, boneName, REFERENCE_ASSET),
          referenceSampleSeconds,
          `${REFERENCE_ASSET}:${boneName}`,
        ),
      ),
    );
  }

  const outputs = [];
  for (const definition of ONE_HAND_DUEL_LOCOMOTION_OUTPUTS) {
    const baseBytes = readFileSync(path.join(assetsRoot, definition.baseAsset));
    const document = await new NodeIO().readBinary(new Uint8Array(baseBytes));
    const composition = applyOneHandGuard({
      baseDocument: document,
      referenceTargets,
      outputClipName: definition.outputClipName,
    });
    const bytes = Buffer.from(await new NodeIO().writeBinary(document));
    outputs.push({
      ...definition,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      baseSha256: sha256(baseBytes),
      validation: await validateCandidate(bytes, definition.outputAsset),
      ...composition,
    });
  }

  return {
    schemaVersion: 1,
    activationStatus: "reviewed-production",
    approvedForRuntimeActivation: true,
    reference: {
      asset: REFERENCE_ASSET,
      sha256: sha256(referenceBytes),
      sampleRatio: ONE_HAND_GUARD_SAMPLE_RATIO,
      sampleSeconds: referenceSampleSeconds,
    },
    blendStrength: ONE_HAND_GUARD_BLEND_STRENGTH,
    weaponArmBones: [...ONE_HAND_WEAPON_ARM_BONES],
    outputs,
  };
}

function serializableReport(report) {
  return {
    ...report,
    outputs: report.outputs.map(({ bytes: _bytes, ...output }) => output),
  };
}

async function run({ check }) {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await buildOneHandDuelLocomotionEmotes(workspaceRoot);
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
  console.log(
    `${check ? "Verified" : "Built"} ${report.outputs.length} production one-hand duel locomotion clips`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.size !== 1 || (!args.has("--write") && !args.has("--check"))) {
    console.error(
      "Usage: node scripts/build-one-hand-duel-locomotion-emotes.mjs --write|--check",
    );
    process.exitCode = 1;
  } else {
    run({ check: args.has("--check") }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
