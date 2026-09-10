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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_VERSION = "v22.23.2";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9_-]+$/u;
const JSON_CHUNK_TYPE = 0x4e4f534a;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function assertUnitVector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain three finite numbers`);
  }
  const length = Math.hypot(...value);
  if (Math.abs(length - 1) > 0.00001) {
    throw new Error(`${label} must be normalized; length ${length}`);
  }
}

function normalize(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain three finite numbers`);
  }
  const length = Math.hypot(...value);
  if (length <= 1e-8) throw new Error(`${label} must be non-zero`);
  return value.map((entry) => entry / length);
}

export function rotateVectorByQuaternion(vector, quaternion) {
  const [vx, vy, vz] = normalize(vector, "source axis");
  if (
    !Array.isArray(quaternion) ||
    quaternion.length !== 4 ||
    quaternion.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error("orientation quaternion must contain four finite numbers");
  }
  const length = Math.hypot(...quaternion);
  if (Math.abs(length - 1) > 0.00001) {
    throw new Error(
      `orientation quaternion is not normalized; length ${length}`,
    );
  }
  const [qx, qy, qz, qw] = quaternion.map((entry) => entry / length);
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return normalize(
    [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ],
    "rotated axis",
  );
}

export function angularDeviationDegrees(left, right, bidirectional = false) {
  const a = normalize(left, "left axis");
  const b = normalize(right, "right axis");
  const dot = Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, entry, index) => sum + entry * b[index], 0),
    ),
  );
  const effectiveDot = bidirectional ? Math.abs(dot) : dot;
  return (Math.acos(effectiveDot) * 180) / Math.PI;
}

function parseGlb(input, label) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 28 ||
    input.readUInt32LE(0) !== 0x46546c67 ||
    input.readUInt32LE(4) !== 2 ||
    input.readUInt32LE(8) !== input.length
  ) {
    throw new Error(`${label} is not a complete GLB v2 file`);
  }
  const jsonLength = input.readUInt32LE(12);
  if (
    input.readUInt32LE(16) !== JSON_CHUNK_TYPE ||
    jsonLength % 4 !== 0 ||
    20 + jsonLength + 8 > input.length
  ) {
    throw new Error(`${label} has invalid GLB JSON framing`);
  }
  const document = JSON.parse(
    input
      .subarray(20, 20 + jsonLength)
      .toString("utf8")
      .replace(/[\0\x20]+$/u, ""),
  );
  const binaryHeader = 20 + jsonLength;
  const binaryLength = input.readUInt32LE(binaryHeader);
  if (
    input.readUInt32LE(binaryHeader + 4) !== 0x004e4942 ||
    binaryHeader + 8 + binaryLength !== input.length
  ) {
    throw new Error(`${label} must contain one embedded binary chunk`);
  }
  return {
    document,
    binary: input.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength),
  };
}

function positionSignature(parsed, label) {
  const chunks = [];
  for (const mesh of parsed.document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor =
        parsed.document.accessors?.[primitive.attributes?.POSITION];
      const view = parsed.document.bufferViews?.[accessor?.bufferView];
      if (
        !isRecord(accessor) ||
        !isRecord(view) ||
        view.buffer !== 0 ||
        accessor.componentType !== 5126 ||
        accessor.type !== "VEC3" ||
        !Number.isInteger(accessor.count) ||
        accessor.count < 1 ||
        accessor.sparse !== undefined
      ) {
        throw new Error(`${label} has an unsupported POSITION accessor`);
      }
      const stride = view.byteStride ?? 12;
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let index = 0; index < accessor.count; index += 1) {
        const offset = start + index * stride;
        if (offset + 12 > parsed.binary.length) {
          throw new Error(
            `${label} POSITION accessor exceeds its binary chunk`,
          );
        }
        chunks.push(parsed.binary.subarray(offset, offset + 12));
      }
    }
  }
  if (chunks.length < 1) throw new Error(`${label} contains no mesh positions`);
  return sha256(Buffer.concat(chunks));
}

function inspectEquipmentAsset(input, itemId) {
  const parsed = parseGlb(input, itemId);
  const scene = parsed.document.scenes?.[parsed.document.scene ?? 0];
  const wrapper = parsed.document.nodes?.[scene?.nodes?.[0]];
  const content = parsed.document.nodes?.[wrapper?.children?.[0]];
  const metadata = scene?.extras?.hyperia ?? wrapper?.extras?.hyperia;
  if (
    wrapper?.name !== "EquipmentWrapper" ||
    !Array.isArray(wrapper.matrix) ||
    wrapper.matrix.length !== 16 ||
    wrapper.matrix.some((entry) => !Number.isFinite(entry)) ||
    content?.name !== "EquipmentContent" ||
    !Array.isArray(content.scale) ||
    content.scale.length !== 3 ||
    !isRecord(metadata) ||
    metadata.duelFit?.itemId !== itemId ||
    metadata.duelFit?.slot !== "gatheringtool" ||
    !metadata.duelFit?.compatibleAvatarIds?.includes("steve")
  ) {
    throw new Error(`${itemId} fitted equipment authority is invalid`);
  }
  return {
    wrapperMatrix: wrapper.matrix,
    contentScale: content.scale,
    positionSignature: positionSignature(parsed, itemId),
    fitReference: metadata.fitReference,
    twoHandGrip: metadata.twoHandGrip ?? null,
    weaponType: metadata.weaponType,
  };
}

function pngDimensions(input, label) {
  const signature = "89504e470d0a1a0a";
  if (
    !Buffer.isBuffer(input) ||
    input.length < 24 ||
    input.subarray(0, 8).toString("hex") !== signature ||
    input.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error(`${label} is not a complete PNG`);
  }
  return { width: input.readUInt32BE(16), height: input.readUInt32BE(20) };
}

function activationAssetPath(assetUrl, label) {
  if (typeof assetUrl !== "string" || !assetUrl.startsWith("asset://")) {
    throw new Error(`${label} must use an asset:// URL`);
  }
  const relative = assetUrl.slice("asset://".length);
  if (!relative || path.posix.normalize(relative) !== relative) {
    throw new Error(`${label} contains an unsafe asset URL`);
  }
  return `packages/server/world/assets/${relative}`;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return { write: argv[0] === "--write" };
}

export function validateOrientationAuthority(authority) {
  if (
    !isRecord(authority) ||
    authority.schemaVersion !== 1 ||
    !isRecord(authority.avatar) ||
    authority.avatar.id !== "steve" ||
    !SHA256.test(authority.avatar.sha256) ||
    typeof authority.activationManifest !== "string" ||
    !Number.isFinite(authority.maximumOrientationDeviationDegrees) ||
    authority.maximumOrientationDeviationDegrees <= 0 ||
    authority.maximumOrientationDeviationDegrees > 0.1 ||
    !Number.isFinite(authority.maximumTwoHandAxisDeviationDegrees) ||
    authority.maximumTwoHandAxisDeviationDegrees <= 0 ||
    authority.maximumTwoHandAxisDeviationDegrees > 0.01 ||
    !Array.isArray(authority.visualReviewAngles) ||
    authority.visualReviewAngles.length !== 4 ||
    !Array.isArray(authority.families) ||
    authority.families.length !== 7
  ) {
    throw new Error("Active preparation orientation authority is invalid");
  }
  const visualReviewAngleIds = new Set();
  for (const angle of authority.visualReviewAngles) {
    if (
      !isRecord(angle) ||
      !SAFE_ID.test(angle.id) ||
      visualReviewAngleIds.has(angle.id) ||
      !Number.isFinite(angle.yawDegrees) ||
      Math.abs(angle.yawDegrees) > 180 ||
      !Number.isFinite(angle.pitchDegrees) ||
      Math.abs(angle.pitchDegrees) > 60
    ) {
      throw new Error("Visual-review camera authority is invalid");
    }
    visualReviewAngleIds.add(angle.id);
  }
  const itemIds = new Set();
  for (const family of authority.families) {
    if (
      !isRecord(family) ||
      !SAFE_ID.test(family.id) ||
      !["one-hand", "two-hand"].includes(family.grip) ||
      !["directed", "bidirectional"].includes(family.actionAxisSymmetry) ||
      !Array.isArray(family.itemIds) ||
      family.itemIds.length < 1 ||
      !Array.isArray(family.phases) ||
      family.phases.length < 1 ||
      !SAFE_ID.test(family.visualReviewPhaseId) ||
      (family.requireMetadataHandleAxis !== undefined &&
        typeof family.requireMetadataHandleAxis !== "boolean") ||
      !Number.isFinite(family.maximumPrimaryHandSurfaceDistanceMetres) ||
      family.maximumPrimaryHandSurfaceDistanceMetres <= 0
    ) {
      throw new Error("Orientation family definition is invalid");
    }
    normalize(family.sourceHandleAxis, `${family.id}.sourceHandleAxis`);
    normalize(family.sourceActionAxis, `${family.id}.sourceActionAxis`);
    for (const itemId of family.itemIds) {
      if (!SAFE_ID.test(itemId) || itemIds.has(itemId)) {
        throw new Error(`Invalid or duplicate orientation item ID ${itemId}`);
      }
      itemIds.add(itemId);
    }
    const phaseIds = new Set();
    for (const phase of family.phases) {
      if (
        !isRecord(phase) ||
        !SAFE_ID.test(phase.id) ||
        phaseIds.has(phase.id) ||
        !Number.isFinite(phase.sampleRatio) ||
        phase.sampleRatio < 0 ||
        phase.sampleRatio > 1 ||
        (phase.runtimeMotionRole !== undefined &&
          !["deploy", "retrieve"].includes(phase.runtimeMotionRole))
      ) {
        throw new Error(`${family.id} orientation phase is invalid`);
      }
      phaseIds.add(phase.id);
      assertUnitVector(
        phase.expectedHandleAxis,
        `${phase.id}.expectedHandleAxis`,
      );
      assertUnitVector(
        phase.expectedActionAxis,
        `${phase.id}.expectedActionAxis`,
      );
      if (
        phase.secondaryHandContactRequired === true &&
        (!Number.isFinite(family.maximumSecondaryHandSurfaceDistanceMetres) ||
          family.maximumSecondaryHandSurfaceDistanceMetres <= 0)
      ) {
        throw new Error(`${family.id} has no secondary-hand contact threshold`);
      }
    }
    if (!phaseIds.has(family.visualReviewPhaseId)) {
      throw new Error(`${family.id} visual-review phase is not authoritative`);
    }
  }
  if (itemIds.size !== 17) {
    throw new Error(
      `Orientation authority must cover 17 active items, found ${itemIds.size}`,
    );
  }
  return authority;
}

function verifyFamilyGeometry(family, inspectedAssets) {
  const reference = inspectedAssets.get(family.itemIds[0]);
  for (const itemId of family.itemIds) {
    const inspected = inspectedAssets.get(itemId);
    if (
      JSON.stringify(inspected.wrapperMatrix) !==
        JSON.stringify(reference.wrapperMatrix) ||
      JSON.stringify(inspected.contentScale) !==
        JSON.stringify(reference.contentScale) ||
      inspected.positionSignature !== reference.positionSignature ||
      JSON.stringify(inspected.fitReference) !==
        JSON.stringify(reference.fitReference)
    ) {
      throw new Error(
        `${itemId} geometry or fitted orientation differs from ${family.itemIds[0]}`,
      );
    }
    if (
      family.requireMetadataHandleAxis !== false &&
      JSON.stringify(
        inspected.fitReference?.alignHandleToSecondaryHand?.sourceHandleAxis,
      ) !== JSON.stringify(family.sourceHandleAxis)
    ) {
      throw new Error(`${itemId} source handle-axis authority drifted`);
    }
    if (family.grip === "two-hand") {
      if (
        inspected.twoHandGrip?.wrapperNodeName !== "EquipmentWrapper" ||
        inspected.twoHandGrip?.secondaryBoneName !== "leftHand" ||
        JSON.stringify(inspected.twoHandGrip?.sourceHandleAxis) !==
          JSON.stringify(family.sourceHandleAxis)
      ) {
        throw new Error(`${itemId} runtime two-hand authority drifted`);
      }
    } else if (inspected.twoHandGrip !== null) {
      throw new Error(`${itemId} unexpectedly declares a two-hand controller`);
    }
  }
  return {
    referenceItemId: family.itemIds[0],
    exactWrapperMatrix: reference.wrapperMatrix,
    exactContentScale: reference.contentScale,
    exactPositionSignature: reference.positionSignature,
    exactFitReference: reference.fitReference,
    equivalentItemCount: family.itemIds.length,
  };
}

function validateMotionReport({
  report,
  family,
  itemId,
  equipmentPath,
  equipmentSha256,
  motionInputs,
  authority,
}) {
  if (
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length !== 0 ||
    !Array.isArray(report.motions) ||
    report.motions.length !== family.phases.length ||
    report.inputs?.[equipmentPath] !== equipmentSha256 ||
    [...motionInputs.values()].some(
      (motion) => report.inputs?.[motion.path] !== motion.sha256,
    ) ||
    report.inputs?.[authority.avatar.asset] !== authority.avatar.sha256
  ) {
    throw new Error(
      `${itemId} browser evidence inputs or clean-pass state drifted`,
    );
  }
  let maximumHandleDeviation = 0;
  let maximumActionDeviation = 0;
  let maximumTwoHandDeviation = 0;
  let maximumPrimaryDistance = 0;
  let maximumRequiredSecondaryDistance = 0;
  const phases = [];
  for (const [index, phaseAuthority] of family.phases.entries()) {
    const motion = report.motions[index];
    const equipment = motion?.equipment;
    const runtimeMotionRole = phaseAuthority.runtimeMotionRole ?? "deploy";
    const runtimeMotion = motionInputs.get(runtimeMotionRole);
    const ratio = motion.sampleSeconds / motion.durationSeconds;
    if (
      !runtimeMotion ||
      motion.id !== phaseAuthority.id ||
      motion.asset !== runtimeMotion.path ||
      Math.abs(ratio - phaseAuthority.sampleRatio) > 0.000001 ||
      !Array.isArray(motion.failures) ||
      motion.failures.length !== 0 ||
      equipment?.itemId !== itemId ||
      equipment?.asset !== equipmentPath ||
      equipment?.metadataValid !== true ||
      equipment?.attached !== true ||
      equipment?.visible !== true ||
      equipment?.attachmentBone !== "rightHand" ||
      !isRecord(equipment.orientation) ||
      equipment.orientation.wrapperNodeName !== "EquipmentWrapper"
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} browser evidence drifted`,
      );
    }
    const quaternion = equipment.orientation.wrapperAvatarLocalQuaternion;
    const handleAxis = rotateVectorByQuaternion(
      family.sourceHandleAxis,
      quaternion,
    );
    const actionAxis = rotateVectorByQuaternion(
      family.sourceActionAxis,
      quaternion,
    );
    const handleDeviation = angularDeviationDegrees(
      handleAxis,
      phaseAuthority.expectedHandleAxis,
    );
    const actionDeviation = angularDeviationDegrees(
      actionAxis,
      phaseAuthority.expectedActionAxis,
      family.actionAxisSymmetry === "bidirectional",
    );
    if (
      handleDeviation > authority.maximumOrientationDeviationDegrees ||
      actionDeviation > authority.maximumOrientationDeviationDegrees
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} orientation drifted (${handleDeviation}° handle, ${actionDeviation}° action)`,
      );
    }
    const primaryDistance = equipment.rightHandNearestSurfaceDistance;
    const secondaryDistance = equipment.leftHandNearestSurfaceDistance;
    if (
      !Number.isFinite(primaryDistance) ||
      primaryDistance > family.maximumPrimaryHandSurfaceDistanceMetres
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} primary-hand contact drifted`,
      );
    }
    if (
      phaseAuthority.secondaryHandContactRequired === true &&
      (!Number.isFinite(secondaryDistance) ||
        secondaryDistance > family.maximumSecondaryHandSurfaceDistanceMetres)
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} secondary-hand contact drifted`,
      );
    }
    const twoHandDeviation =
      equipment.orientation.metadataHandleToSecondaryDeviationDegrees;
    if (family.grip === "two-hand") {
      if (
        equipment.twoHandGripActive !== true ||
        !Number.isFinite(twoHandDeviation) ||
        twoHandDeviation > authority.maximumTwoHandAxisDeviationDegrees
      ) {
        throw new Error(`${itemId} ${phaseAuthority.id} two-hand axis drifted`);
      }
    } else if (
      equipment.twoHandGripActive !== false ||
      twoHandDeviation !== null
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} has an unexpected two-hand controller`,
      );
    }
    if (
      Number.isFinite(phaseAuthority.actionYMinimum) &&
      actionAxis[1] < phaseAuthority.actionYMinimum
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} action tip is not high enough`,
      );
    }
    if (
      Number.isFinite(phaseAuthority.actionYMaximum) &&
      actionAxis[1] > phaseAuthority.actionYMaximum
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} action tip is not low enough`,
      );
    }
    if (
      Number.isFinite(phaseAuthority.absoluteActionYMinimum) &&
      Math.abs(actionAxis[1]) < phaseAuthority.absoluteActionYMinimum
    ) {
      throw new Error(
        `${itemId} ${phaseAuthority.id} bidirectional impact axis is too horizontal`,
      );
    }
    maximumHandleDeviation = Math.max(maximumHandleDeviation, handleDeviation);
    maximumActionDeviation = Math.max(maximumActionDeviation, actionDeviation);
    maximumTwoHandDeviation = Math.max(
      maximumTwoHandDeviation,
      Number.isFinite(twoHandDeviation) ? twoHandDeviation : 0,
    );
    maximumPrimaryDistance = Math.max(maximumPrimaryDistance, primaryDistance);
    if (phaseAuthority.secondaryHandContactRequired === true) {
      maximumRequiredSecondaryDistance = Math.max(
        maximumRequiredSecondaryDistance,
        secondaryDistance,
      );
    }
    phases.push({
      id: phaseAuthority.id,
      sampleRatio: phaseAuthority.sampleRatio,
      runtimeMotionRole,
      handleAxis: handleAxis.map((entry) => Number(entry.toFixed(6))),
      actionAxis: actionAxis.map((entry) => Number(entry.toFixed(6))),
      handleDeviationDegrees: Number(handleDeviation.toFixed(6)),
      actionDeviationDegrees: Number(actionDeviation.toFixed(6)),
      primaryHandSurfaceDistanceMetres: primaryDistance,
      secondaryHandSurfaceDistanceMetres: secondaryDistance,
      secondaryHandContactRequired:
        phaseAuthority.secondaryHandContactRequired === true,
      twoHandAxisDeviationDegrees: Number.isFinite(twoHandDeviation)
        ? twoHandDeviation
        : null,
    });
  }
  return {
    phaseCount: phases.length,
    maximumHandleDeviationDegrees: Number(maximumHandleDeviation.toFixed(6)),
    maximumActionDeviationDegrees: Number(maximumActionDeviation.toFixed(6)),
    maximumTwoHandAxisDeviationDegrees: Number(
      maximumTwoHandDeviation.toFixed(6),
    ),
    maximumPrimaryHandSurfaceDistanceMetres: maximumPrimaryDistance,
    maximumRequiredSecondaryHandSurfaceDistanceMetres:
      maximumRequiredSecondaryDistance,
    phases,
  };
}

function validateVisualReviewReport({
  report,
  family,
  itemId,
  phaseAuthority,
  equipmentPath,
  equipmentSha256,
  motionInput,
  authority,
}) {
  if (
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length !== 0 ||
    report.framing !== "avatar-and-equipment" ||
    !Array.isArray(report.motions) ||
    report.motions.length !== authority.visualReviewAngles.length ||
    report.inputs?.[equipmentPath] !== equipmentSha256 ||
    report.inputs?.[motionInput.path] !== motionInput.sha256 ||
    report.inputs?.[authority.avatar.asset] !== authority.avatar.sha256
  ) {
    throw new Error(
      `${itemId} multi-angle evidence inputs or clean-pass state drifted`,
    );
  }
  const views = [];
  for (const [index, angle] of authority.visualReviewAngles.entries()) {
    const motion = report.motions[index];
    const equipment = motion?.equipment;
    const ratio = motion.sampleSeconds / motion.durationSeconds;
    if (
      motion.id !== `orientation-${angle.id}` ||
      motion.asset !== motionInput.path ||
      motion.cameraYawDegrees !== angle.yawDegrees ||
      motion.cameraPitchDegrees !== angle.pitchDegrees ||
      Math.abs(ratio - phaseAuthority.sampleRatio) > 0.000001 ||
      !Array.isArray(motion.failures) ||
      motion.failures.length !== 0 ||
      equipment?.itemId !== itemId ||
      equipment?.asset !== equipmentPath ||
      equipment?.metadataValid !== true ||
      equipment?.attached !== true ||
      equipment?.visible !== true ||
      equipment?.attachmentBone !== "rightHand" ||
      !isRecord(equipment.orientation)
    ) {
      throw new Error(`${itemId} ${angle.id} multi-angle evidence drifted`);
    }
    const handleAxis = rotateVectorByQuaternion(
      family.sourceHandleAxis,
      equipment.orientation.wrapperAvatarLocalQuaternion,
    );
    const actionAxis = rotateVectorByQuaternion(
      family.sourceActionAxis,
      equipment.orientation.wrapperAvatarLocalQuaternion,
    );
    const handleDeviation = angularDeviationDegrees(
      handleAxis,
      phaseAuthority.expectedHandleAxis,
    );
    const actionDeviation = angularDeviationDegrees(
      actionAxis,
      phaseAuthority.expectedActionAxis,
      family.actionAxisSymmetry === "bidirectional",
    );
    if (
      handleDeviation > authority.maximumOrientationDeviationDegrees ||
      actionDeviation > authority.maximumOrientationDeviationDegrees ||
      equipment.rightHandNearestSurfaceDistance >
        family.maximumPrimaryHandSurfaceDistanceMetres
    ) {
      throw new Error(
        `${itemId} ${angle.id} multi-angle orientation/contact drifted`,
      );
    }
    if (
      phaseAuthority.secondaryHandContactRequired === true &&
      equipment.leftHandNearestSurfaceDistance >
        family.maximumSecondaryHandSurfaceDistanceMetres
    ) {
      throw new Error(
        `${itemId} ${angle.id} multi-angle secondary contact drifted`,
      );
    }
    if (family.grip === "two-hand") {
      const twoHandDeviation =
        equipment.orientation.metadataHandleToSecondaryDeviationDegrees;
      if (
        equipment.twoHandGripActive !== true ||
        !Number.isFinite(twoHandDeviation) ||
        twoHandDeviation > authority.maximumTwoHandAxisDeviationDegrees
      ) {
        throw new Error(
          `${itemId} ${angle.id} multi-angle two-hand axis drifted`,
        );
      }
    }
    views.push({
      id: angle.id,
      yawDegrees: angle.yawDegrees,
      pitchDegrees: angle.pitchDegrees,
      handleAxis: handleAxis.map((entry) => Number(entry.toFixed(6))),
      actionAxis: actionAxis.map((entry) => Number(entry.toFixed(6))),
      handleDeviationDegrees: Number(handleDeviation.toFixed(6)),
      actionDeviationDegrees: Number(actionDeviation.toFixed(6)),
      primaryHandSurfaceDistanceMetres:
        equipment.rightHandNearestSurfaceDistance,
      secondaryHandSurfaceDistanceMetres:
        equipment.leftHandNearestSurfaceDistance,
    });
  }
  return { phaseId: phaseAuthority.id, views };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.version !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Held-item orientation audit requires Node.js ${EXPECTED_NODE_VERSION}; found ${process.version}`,
    );
  }
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const authorityPath = path.join(
    workspaceRoot,
    "scripts/active-preparation-orientation-authority.json",
  );
  const authorityBytes = readFileSync(authorityPath);
  const authority = validateOrientationAuthority(
    JSON.parse(authorityBytes.toString("utf8")),
  );
  const avatarPath = safeWorkspacePath(
    workspaceRoot,
    authority.avatar.asset,
    "avatar.asset",
  );
  if (sha256(readFileSync(avatarPath)) !== authority.avatar.sha256) {
    throw new Error("Orientation authority avatar hash drifted");
  }
  const activationManifestPath = safeWorkspacePath(
    workspaceRoot,
    authority.activationManifest,
    "activationManifest",
  );
  const activationManifestBytes = readFileSync(activationManifestPath);
  const activationManifest = JSON.parse(
    activationManifestBytes.toString("utf8"),
  );
  const expectedItemIds = authority.families.flatMap(
    (family) => family.itemIds,
  );
  const activations = new Map(
    (activationManifest.activations ?? [])
      .filter(
        (activation) =>
          activation.state === "active" &&
          activation.avatarId === "steve" &&
          activation.slot === "gatheringtool",
      )
      .map((activation) => [activation.itemId, activation]),
  );
  if (
    activations.size !== expectedItemIds.length ||
    expectedItemIds.some((itemId) => !activations.has(itemId))
  ) {
    throw new Error(
      "Active Steve preparation set differs from the 17-item orientation authority",
    );
  }

  const outputDirectory = path.join(
    workspaceRoot,
    "artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation",
  );
  mkdirSync(outputDirectory, { recursive: true });
  const inspectedAssets = new Map();
  const runtimeInputs = new Map();
  for (const family of authority.families) {
    for (const itemId of family.itemIds) {
      const activation = activations.get(itemId);
      const equipmentPath = activationAssetPath(
        activation.equipment?.assetUrl,
        `${itemId}.equipment.assetUrl`,
      );
      const equipmentFile = safeWorkspacePath(
        workspaceRoot,
        equipmentPath,
        `${itemId}.equipment`,
      );
      const bytes = readFileSync(equipmentFile);
      if (
        !SHA256.test(activation.equipment?.sha256) ||
        sha256(bytes) !== activation.equipment.sha256
      ) {
        throw new Error(`${itemId} active equipment hash drifted`);
      }
      inspectedAssets.set(itemId, inspectEquipmentAsset(bytes, itemId));
      runtimeInputs.set(itemId, {
        activation,
        equipmentPath,
        equipmentSha256: activation.equipment.sha256,
      });
    }
  }
  const familyGeometry = Object.fromEntries(
    authority.families.map((family) => [
      family.id,
      verifyFamilyGeometry(family, inspectedAssets),
    ]),
  );

  const captures = [];
  const visualReviews = [];
  for (const family of authority.families) {
    const familyActivations = family.itemIds.map((itemId) =>
      activations.get(itemId),
    );
    const requiredMotionRoles = new Set(
      family.phases.map((phase) => phase.runtimeMotionRole ?? "deploy"),
    );
    const motionInputs = new Map();
    for (const role of requiredMotionRoles) {
      const authorityKey = role === "retrieve" ? "retrievalMotion" : "motion";
      const motionUrls = new Set(
        familyActivations.map(
          (activation) => activation[authorityKey]?.assetUrl,
        ),
      );
      const motionHashes = new Set(
        familyActivations.map((activation) => activation[authorityKey]?.sha256),
      );
      if (motionUrls.size !== 1 || motionHashes.size !== 1) {
        throw new Error(
          `${family.id} activations do not share one certified ${role} motion`,
        );
      }
      const motionPath = activationAssetPath(
        familyActivations[0][authorityKey]?.assetUrl,
        `${family.id}.${authorityKey}.assetUrl`,
      );
      const motionFile = safeWorkspacePath(
        workspaceRoot,
        motionPath,
        `${family.id}.${authorityKey}`,
      );
      const motionSha256 = familyActivations[0][authorityKey]?.sha256;
      if (
        !SHA256.test(motionSha256) ||
        sha256(readFileSync(motionFile)) !== motionSha256
      ) {
        throw new Error(`${family.id} active ${role} motion hash drifted`);
      }
      motionInputs.set(role, { path: motionPath, sha256: motionSha256 });
    }
    const sourceMotionManifestPath = safeWorkspacePath(
      workspaceRoot,
      family.motionManifest,
      `${family.id}.motionManifest`,
    );
    const sourceMotionManifest = JSON.parse(
      readFileSync(sourceMotionManifestPath, "utf8"),
    );
    if (
      !Array.isArray(sourceMotionManifest.motions) ||
      sourceMotionManifest.motions.length !== family.phases.length ||
      sourceMotionManifest.motions.some(
        (motion, index) =>
          motion.id !== family.phases[index].id ||
          motion.sampleRatio !== family.phases[index].sampleRatio,
      )
    ) {
      throw new Error(`${family.id} source motion phases drifted`);
    }
    const runtimeMotionManifest = {
      ...sourceMotionManifest,
      motions: sourceMotionManifest.motions.map((motion, index) => ({
        ...motion,
        asset: motionInputs.get(
          family.phases[index].runtimeMotionRole ?? "deploy",
        ).path,
      })),
    };
    const runtimeMotionManifestRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${family.id}-runtime-motions.json`;
    const runtimeMotionManifestPath = path.join(
      workspaceRoot,
      runtimeMotionManifestRelative,
    );
    const runtimeMotionManifestSerialized = `${JSON.stringify(runtimeMotionManifest, null, 2)}\n`;
    if (options.write) {
      writeAtomic(runtimeMotionManifestPath, runtimeMotionManifestSerialized);
    } else if (
      !existsSync(runtimeMotionManifestPath) ||
      readFileSync(runtimeMotionManifestPath, "utf8") !==
        runtimeMotionManifestSerialized
    ) {
      throw new Error(`${family.id} runtime motion manifest is stale`);
    }

    for (const itemId of family.itemIds) {
      const runtimeInput = runtimeInputs.get(itemId);
      const imageRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${itemId}-contact-sheet.png`;
      const reportRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${itemId}-motion-report.json`;
      const imagePath = path.join(workspaceRoot, imageRelative);
      const reportPath = path.join(workspaceRoot, reportRelative);
      if (options.write) {
        const result = spawnSync(
          process.execPath,
          [
            "scripts/capture-duel-avatar-motion.mjs",
            "--assets-root",
            ".",
            "--avatar",
            authority.avatar.asset,
            "--motions",
            runtimeMotionManifestRelative,
            "--equipment",
            runtimeInput.equipmentPath,
            "--item-id",
            itemId,
            "--equipment-slot",
            "gatheringtool",
            "--avatar-id",
            "steve",
            "--grip",
            family.grip,
            "--title",
            `${itemId} active held-item orientation certificate`,
            "--output",
            imageRelative,
            "--report",
            reportRelative,
          ],
          {
            cwd: workspaceRoot,
            encoding: "utf8",
            env: process.env,
            timeout: 180_000,
          },
        );
        if (result.status !== 0) {
          throw new Error(
            `${itemId} orientation capture failed: ${(result.stderr || result.stdout || "no output").trim()}`,
          );
        }
      }
      if (!existsSync(imagePath) || !existsSync(reportPath)) {
        throw new Error(`${itemId} held-item orientation evidence is missing`);
      }
      const imageBytes = readFileSync(imagePath);
      const reportBytes = readFileSync(reportPath);
      const dimensions = pngDimensions(imageBytes, `${itemId} contact sheet`);
      if (dimensions.width !== 1600 || dimensions.height < 1200) {
        throw new Error(`${itemId} contact-sheet dimensions are invalid`);
      }
      const motionEvidence = validateMotionReport({
        report: JSON.parse(reportBytes.toString("utf8")),
        family,
        itemId,
        equipmentPath: runtimeInput.equipmentPath,
        equipmentSha256: runtimeInput.equipmentSha256,
        motionInputs,
        authority,
      });
      captures.push({
        itemId,
        family: family.id,
        actionSemantic: family.actionSemantic,
        equipment: {
          path: runtimeInput.equipmentPath,
          sha256: runtimeInput.equipmentSha256,
        },
        motions: [...motionInputs.entries()].map(([role, motion]) => ({
          role,
          ...motion,
        })),
        image: {
          path: imageRelative,
          sha256: sha256(imageBytes),
          bytes: imageBytes.length,
          ...dimensions,
        },
        browserReport: {
          path: reportRelative,
          sha256: sha256(reportBytes),
        },
        motionEvidence,
      });
    }

    const visualReviewItemId = family.itemIds.at(-1);
    const visualReviewInput = runtimeInputs.get(visualReviewItemId);
    const visualReviewPhaseAuthority = family.phases.find(
      (phase) => phase.id === family.visualReviewPhaseId,
    );
    const visualReviewSourceMotion = sourceMotionManifest.motions.find(
      (motion) => motion.id === family.visualReviewPhaseId,
    );
    if (!visualReviewPhaseAuthority || !visualReviewSourceMotion) {
      throw new Error(`${family.id} visual-review phase is missing`);
    }
    const visualReviewMotionInput = motionInputs.get(
      visualReviewPhaseAuthority.runtimeMotionRole ?? "deploy",
    );
    if (!visualReviewMotionInput) {
      throw new Error(`${family.id} visual-review motion authority is missing`);
    }
    const visualReviewManifest = {
      schemaVersion: 1,
      title: `${family.id} exact multi-angle held-item review`,
      framing: "avatar-and-equipment",
      ...(sourceMotionManifest.environment
        ? { environment: sourceMotionManifest.environment }
        : {}),
      motions: authority.visualReviewAngles.map((angle) => ({
        ...visualReviewSourceMotion,
        id: `orientation-${angle.id}`,
        name: `${family.id} ${angle.id}`,
        asset: visualReviewMotionInput.path,
        cameraYawDegrees: angle.yawDegrees,
        cameraPitchDegrees: angle.pitchDegrees,
      })),
    };
    const visualReviewManifestRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${family.id}-multi-angle-motions.json`;
    const visualReviewManifestPath = path.join(
      workspaceRoot,
      visualReviewManifestRelative,
    );
    const visualReviewManifestSerialized = `${JSON.stringify(visualReviewManifest, null, 2)}\n`;
    if (options.write) {
      writeAtomic(visualReviewManifestPath, visualReviewManifestSerialized);
    } else if (
      !existsSync(visualReviewManifestPath) ||
      readFileSync(visualReviewManifestPath, "utf8") !==
        visualReviewManifestSerialized
    ) {
      throw new Error(`${family.id} multi-angle manifest is stale`);
    }
    const visualReviewImageRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${family.id}-multi-angle-contact-sheet.png`;
    const visualReviewReportRelative = `artifacts/duel-launch-avatar-bakeoff/active-held-item-orientation/${family.id}-multi-angle-motion-report.json`;
    const visualReviewImagePath = path.join(
      workspaceRoot,
      visualReviewImageRelative,
    );
    const visualReviewReportPath = path.join(
      workspaceRoot,
      visualReviewReportRelative,
    );
    if (options.write) {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/capture-duel-avatar-motion.mjs",
          "--assets-root",
          ".",
          "--avatar",
          authority.avatar.asset,
          "--motions",
          visualReviewManifestRelative,
          "--equipment",
          visualReviewInput.equipmentPath,
          "--item-id",
          visualReviewItemId,
          "--equipment-slot",
          "gatheringtool",
          "--avatar-id",
          "steve",
          "--grip",
          family.grip,
          "--title",
          `${family.id} exact multi-angle held-item review`,
          "--output",
          visualReviewImageRelative,
          "--report",
          visualReviewReportRelative,
        ],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: process.env,
          timeout: 180_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `${family.id} multi-angle capture failed: ${(result.stderr || result.stdout || "no output").trim()}`,
        );
      }
    }
    if (
      !existsSync(visualReviewImagePath) ||
      !existsSync(visualReviewReportPath)
    ) {
      throw new Error(`${family.id} multi-angle evidence is missing`);
    }
    const visualReviewImageBytes = readFileSync(visualReviewImagePath);
    const visualReviewReportBytes = readFileSync(visualReviewReportPath);
    const visualReviewDimensions = pngDimensions(
      visualReviewImageBytes,
      `${family.id} multi-angle contact sheet`,
    );
    if (
      visualReviewDimensions.width !== 1600 ||
      visualReviewDimensions.height < 1200
    ) {
      throw new Error(
        `${family.id} multi-angle contact-sheet dimensions are invalid`,
      );
    }
    const visualReviewEvidence = validateVisualReviewReport({
      report: JSON.parse(visualReviewReportBytes.toString("utf8")),
      family,
      itemId: visualReviewItemId,
      phaseAuthority: visualReviewPhaseAuthority,
      equipmentPath: visualReviewInput.equipmentPath,
      equipmentSha256: visualReviewInput.equipmentSha256,
      motionInput: visualReviewMotionInput,
      authority,
    });
    visualReviews.push({
      family: family.id,
      itemId: visualReviewItemId,
      image: {
        path: visualReviewImageRelative,
        sha256: sha256(visualReviewImageBytes),
        bytes: visualReviewImageBytes.length,
        ...visualReviewDimensions,
      },
      browserReport: {
        path: visualReviewReportRelative,
        sha256: sha256(visualReviewReportBytes),
      },
      evidence: visualReviewEvidence,
    });
  }

  const report = {
    schemaVersion: 1,
    exportedAt: authority.exportedAt,
    status: "active_runtime_orientation_and_contact_certified",
    authority: {
      path: path
        .relative(workspaceRoot, authorityPath)
        .split(path.sep)
        .join("/"),
      sha256: sha256(authorityBytes),
    },
    activationManifest: {
      path: authority.activationManifest,
      sha256: sha256(activationManifestBytes),
    },
    implementation: Object.fromEntries(
      [
        "scripts/audit-active-preparation-orientation.mjs",
        "scripts/duel-avatar-motion-browser.ts",
        "scripts/capture-duel-avatar-motion.mjs",
        "scripts/lib/nearest-mesh-surface-distance.ts",
      ].map((relativePath) => [
        relativePath,
        sha256(
          readFileSync(
            safeWorkspacePath(workspaceRoot, relativePath, "implementation"),
          ),
        ),
      ]),
    ),
    runtime: {
      node: process.version,
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    summary: {
      activeItemCount: captures.length,
      familyCount: authority.families.length,
      phaseObservationCount: captures.reduce(
        (sum, capture) => sum + capture.motionEvidence.phaseCount,
        0,
      ),
      multiAngleVisualObservationCount: visualReviews.reduce(
        (sum, review) => sum + review.evidence.views.length,
        0,
      ),
      exactFamilyGeometryCount: authority.families.reduce(
        (sum, family) => sum + family.itemIds.length,
        0,
      ),
      orientationFailureCount: 0,
      primaryContactFailureCount: 0,
      requiredSecondaryContactFailureCount: 0,
      browserErrorCount: 0,
      everyActiveItemCertified: captures.length === 17,
      everyFamilyReviewedFromFourAngles:
        visualReviews.length === authority.families.length &&
        visualReviews.every(
          (review) =>
            review.evidence.views.length ===
            authority.visualReviewAngles.length,
        ),
    },
    familyGeometry,
    captures,
    visualReviews,
  };
  const reportPath = path.join(
    outputDirectory,
    "active-preparation-orientation-report.json",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.write) {
    writeAtomic(reportPath, serialized);
  } else if (
    !existsSync(reportPath) ||
    readFileSync(reportPath, "utf8") !== serialized
  ) {
    throw new Error("Active held-item orientation report is stale");
  }
  process.stdout.write(
    `${options.write ? "Captured" : "Verified"} ${captures.length} active held items across ${report.summary.phaseObservationCount} rendered phases plus ${report.summary.multiAngleVisualObservationCount} locked camera-angle reviews with exact orientation and contact authority\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
