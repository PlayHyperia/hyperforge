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

const ASSET_PREFIX = "asset://";
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_MAGIC = 0x46546c67;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_MOTION_IDS = ["idle", "walk", "run"];
const EXPECTED_WEAPON_IDS = ["shortbow", "magic_shortbow"];
const EXPECTED_ATTACK_PHASE_IDS = [
  "raise",
  "nock",
  "draw",
  "full-draw",
  "release",
  "follow-through",
  "recover",
];
const EXPECTED_EXACT_CAMERA_YAWS = [0, -90, 180, 90];
const EXPECTED_STRENGTH_BY_BONE = {
  "mixamorig:LeftShoulder": 0.65,
  "mixamorig:LeftArm": 0.75,
  "mixamorig:LeftForeArm": 0.9,
  "mixamorig:LeftHand": 0.95,
  "mixamorig:RightShoulder": 0.1,
  "mixamorig:RightArm": 0.1,
  "mixamorig:RightForeArm": 0.1,
  "mixamorig:RightHand": 0.1,
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function safeRelativePath(root, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its root`);
  }
  return resolved;
}

function readLockedFile(workspaceRoot, relativePath, expectedSha256, label) {
  if (!SHA256.test(expectedSha256)) {
    throw new Error(`${label} has an invalid SHA-256 lock`);
  }
  const filePath = safeRelativePath(workspaceRoot, relativePath, label);
  const bytes = readFileSync(filePath);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} drifted from SHA-256 ${expectedSha256}; received ${actualSha256}`,
    );
  }
  return { bytes, filePath };
}

function readLockedJson(workspaceRoot, relativePath, expectedSha256, label) {
  const file = readLockedFile(
    workspaceRoot,
    relativePath,
    expectedSha256,
    label,
  );
  return { ...file, json: JSON.parse(file.bytes.toString("utf8")) };
}

function writeAtomic(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function glbGeometrySha256(bytes, label) {
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== GLB_MAGIC ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  ) {
    throw new Error(`${label} is not a valid GLB 2.0 container`);
  }
  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`${label} has a truncated GLB chunk header`);
    }
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkLength;
    if (chunkEnd > bytes.length) {
      throw new Error(`${label} has a truncated GLB chunk payload`);
    }
    if (chunkType !== GLB_JSON_CHUNK) {
      chunks.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  if (offset !== bytes.length || chunks.length === 0) {
    throw new Error(`${label} does not contain locked binary geometry`);
  }
  return sha256(Buffer.concat(chunks));
}

function validateDefinition(definition, assetsRoot) {
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    definition.activationId !== "steve-bow-duel-natural-v1" ||
    definition.avatarId !== "steve" ||
    definition.candidateId !== "natural" ||
    !isRecord(definition.candidateReport) ||
    !Array.isArray(definition.weaponItemIds) ||
    JSON.stringify(definition.weaponItemIds) !==
      JSON.stringify(EXPECTED_WEAPON_IDS) ||
    !Array.isArray(definition.motions) ||
    definition.motions.length !== EXPECTED_MOTION_IDS.length ||
    !Array.isArray(definition.equipment) ||
    definition.equipment.length !== EXPECTED_WEAPON_IDS.length ||
    !isRecord(definition.evidence) ||
    !isRecord(definition.evidence.fitReport) ||
    !Array.isArray(definition.evidence.browserReviews) ||
    definition.evidence.browserReviews.length !== 7 ||
    !isRecord(definition.evidence.liveStream)
  ) {
    throw new Error("Certified bow-duel presentation definition is invalid");
  }

  for (const [index, motion] of definition.motions.entries()) {
    const id = EXPECTED_MOTION_IDS[index];
    const assetPathFromUrl = motion.assetUrl
      ?.slice(ASSET_PREFIX.length)
      .split("?", 1)[0];
    if (
      !isRecord(motion) ||
      motion.id !== id ||
      !SHA256.test(motion.sha256) ||
      motion.assetUrl !==
        `${ASSET_PREFIX}${motion.destinationPath}${
          motion.playbackSpeed === 1 ? "" : `?s=${motion.playbackSpeed}`
        }` ||
      assetPathFromUrl !== motion.destinationPath ||
      ![1, 1.3, 1.4].includes(motion.playbackSpeed) ||
      motion.sourceAssetPath.includes("..") ||
      !motion.sourceAssetPath.startsWith("emotes/candidates/") ||
      motion.destinationPath.includes("candidates")
    ) {
      throw new Error(`${id} certified motion definition is invalid`);
    }
    safeRelativePath(assetsRoot, motion.destinationPath, `${id} destination`);
  }

  for (const [index, equipment] of definition.equipment.entries()) {
    const itemId = EXPECTED_WEAPON_IDS[index];
    if (
      !isRecord(equipment) ||
      equipment.itemId !== itemId ||
      !SHA256.test(equipment.reviewSha256) ||
      !SHA256.test(equipment.activeSha256) ||
      !SHA256.test(equipment.geometrySha256)
    ) {
      throw new Error(`${itemId} equipment authority is invalid`);
    }
  }

  for (const review of definition.evidence.browserReviews) {
    if (
      !isRecord(review) ||
      !SAFE_ID.test(review.id) ||
      !EXPECTED_WEAPON_IDS.includes(review.itemId) ||
      !SHA256.test(review.reportSha256) ||
      !SHA256.test(review.contactSheetSha256) ||
      !Number.isSafeInteger(review.sampleCount) ||
      review.sampleCount <= 0 ||
      (review.requiredMotionIds !== undefined &&
        (!Array.isArray(review.requiredMotionIds) ||
          review.requiredMotionIds.length === 0 ||
          review.requiredMotionIds.some(
            (motionId) => !EXPECTED_MOTION_IDS.includes(motionId),
          ))) ||
      (review.attackSampleCount !== undefined &&
        (!Number.isSafeInteger(review.attackSampleCount) ||
          review.attackSampleCount <= 0)) ||
      (review.hitReactionSampleCount !== undefined &&
        (!Number.isSafeInteger(review.hitReactionSampleCount) ||
          review.hitReactionSampleCount <= 0)) ||
      (review.hitReactionSampleCount !== undefined &&
        review.attackSampleCount === undefined)
    ) {
      throw new Error("Bow browser-review authority is invalid");
    }
  }
}

function validateCandidateReport(workspaceRoot, definition) {
  const report = readLockedJson(
    workspaceRoot,
    definition.candidateReport.path,
    definition.candidateReport.sha256,
    "bow locomotion candidate report",
  ).json;
  const candidate = report.candidates?.find(
    (entry) => entry?.id === definition.candidateId,
  );
  if (
    report.schemaVersion !== 1 ||
    report.activationStatus !== "inactive-candidate" ||
    report.approvedForRuntimeActivation !== false ||
    !isRecord(candidate) ||
    JSON.stringify(candidate.strengthByBone) !==
      JSON.stringify(EXPECTED_STRENGTH_BY_BONE)
  ) {
    throw new Error("Bow candidate report does not preserve review isolation");
  }
  const selected = report.outputs?.filter(
    (output) => output?.candidateId === definition.candidateId,
  );
  if (!Array.isArray(selected) || selected.length !== 3) {
    throw new Error(
      "Bow candidate report does not contain the exact motion set",
    );
  }
  for (const motion of definition.motions) {
    const output = selected.find(
      (candidateOutput) => candidateOutput?.locomotionId === motion.id,
    );
    if (
      !isRecord(output) ||
      output.outputAsset !== motion.sourceAssetPath ||
      output.sha256 !== motion.sha256 ||
      !Number.isFinite(output.durationSeconds) ||
      output.durationSeconds <= 0 ||
      output.validation?.errors !== 0 ||
      output.validation?.warnings !== 0 ||
      output.validation?.hints !== 0 ||
      !Array.isArray(output.validation?.infoCodes) ||
      output.validation.infoCodes.some((code) => code !== "UNUSED_OBJECT")
    ) {
      throw new Error(`${motion.id} candidate is not technically certified`);
    }
  }
}

function validateEquipment(workspaceRoot, assetsRoot, definition) {
  const fitReport = readLockedJson(
    workspaceRoot,
    definition.evidence.fitReport.path,
    definition.evidence.fitReport.sha256,
    "stable bow fit report",
  ).json;
  if (
    fitReport.browserVerification?.loaded !== true ||
    fitReport.browserVerification?.hasContent !== true ||
    fitReport.browserVerification?.hasErrorOverlay !== false ||
    fitReport.browserVerification?.consoleErrors?.length !== 0
  ) {
    throw new Error("Stable bow fit report is not browser-clean");
  }
  const equipmentById = new Map(
    definition.equipment.map((equipment) => [equipment.itemId, equipment]),
  );
  for (const equipment of definition.equipment) {
    const review = readLockedFile(
      assetsRoot,
      equipment.reviewPath,
      equipment.reviewSha256,
      `${equipment.itemId} review equipment`,
    );
    const active = readLockedFile(
      assetsRoot,
      equipment.activePath,
      equipment.activeSha256,
      `${equipment.itemId} active equipment`,
    );
    if (
      glbGeometrySha256(
        review.bytes,
        `${equipment.itemId} review equipment`,
      ) !== equipment.geometrySha256 ||
      glbGeometrySha256(
        active.bytes,
        `${equipment.itemId} active equipment`,
      ) !== equipment.geometrySha256
    ) {
      throw new Error(
        `${equipment.itemId} active geometry does not match reviewed geometry`,
      );
    }
    const fit = fitReport.outputs?.find(
      (output) => output?.itemId === equipment.itemId,
    );
    if (
      !isRecord(fit) ||
      fit.outputPath !== equipment.reviewPath ||
      fit.outputSha256 !== equipment.reviewSha256 ||
      fit.validator?.errors !== 0 ||
      fit.validator?.warnings !== 0 ||
      fit.validator?.infos !== 0 ||
      fit.validator?.hints !== 0
    ) {
      throw new Error(`${equipment.itemId} fit is not technically certified`);
    }
  }
  return equipmentById;
}

function validateBrowserReviews(workspaceRoot, definition, equipmentById) {
  const motionBySourceAsset = new Map(
    definition.motions.map((motion) => [motion.sourceAssetPath, motion]),
  );
  for (const review of definition.evidence.browserReviews) {
    const report = readLockedJson(
      workspaceRoot,
      review.reportPath,
      review.reportSha256,
      `${review.id} report`,
    ).json;
    readLockedFile(
      workspaceRoot,
      review.contactSheetPath,
      review.contactSheetSha256,
      `${review.id} contact sheet`,
    );
    const equipment = equipmentById.get(review.itemId);
    if (
      !Array.isArray(report.motions) ||
      report.motions.length !== review.sampleCount ||
      !Array.isArray(report.failures) ||
      report.failures.length !== 0 ||
      !Array.isArray(report.browserErrors) ||
      report.browserErrors.length !== 0
    ) {
      throw new Error(`${review.id} browser review is not clean`);
    }
    const reviewedNaturalMotionIds = new Set();
    for (const sample of report.motions) {
      const naturalMotion = motionBySourceAsset.get(sample?.asset);
      if (naturalMotion) reviewedNaturalMotionIds.add(naturalMotion.id);
      if (
        (!naturalMotion && sample?.asset !== "emotes/emote-range.glb") ||
        !Array.isArray(sample?.failures) ||
        sample.failures.length !== 0 ||
        sample.equipment?.itemId !== review.itemId ||
        sample.equipment?.asset !== equipment.reviewPath ||
        sample.equipment?.metadataValid !== true ||
        sample.equipment?.attached !== true ||
        sample.equipment?.visible !== true ||
        sample.equipment?.dynamicBowStringActive !== true ||
        sample.equipment?.stableHeldPoseActive !== true ||
        !sample.equipment?.gripZoneContacts?.some(
          (contact) => contact?.id === "primary" && contact.intersects === true,
        )
      ) {
        throw new Error(`${review.id} contains an uncertified visual sample`);
      }
    }
    const requiredMotionIds = review.requiredMotionIds ?? EXPECTED_MOTION_IDS;
    if (
      requiredMotionIds.some(
        (motionId) => !reviewedNaturalMotionIds.has(motionId),
      )
    ) {
      throw new Error(
        `${review.id} does not cover all natural locomotion clips`,
      );
    }
    if (review.hitReactionSampleCount !== undefined) {
      const attackSamples = report.motions.filter(
        (sample) => sample?.heldEquipmentEmote === "range",
      );
      const hitReactionSamples = report.motions.filter(
        (sample) => sample?.hitReaction,
      );
      if (
        attackSamples.length !== review.attackSampleCount ||
        hitReactionSamples.length !== review.hitReactionSampleCount ||
        JSON.stringify([
          ...new Set(report.motions.map((sample) => sample.cameraYawDegrees)),
        ]) !== JSON.stringify(EXPECTED_EXACT_CAMERA_YAWS) ||
        hitReactionSamples.some(
          (sample) =>
            sample.hitReaction.availableBoneCount < 5 ||
            sample.hitReaction.triggerCount !== 1 ||
            sample.hitReaction.active !== true ||
            sample.hitReaction.currentWeight <= 0,
        ) ||
        EXPECTED_ATTACK_PHASE_IDS.some(
          (phaseId) =>
            attackSamples.filter((sample) =>
              sample.id.includes(`-attack-${phaseId}-`),
            ).length !== EXPECTED_EXACT_CAMERA_YAWS.length,
        )
      ) {
        throw new Error(
          `${review.id} does not cover the exact attack/hit-reaction matrix`,
        );
      }
    }
  }
}

function validateLiveStreamEvidence(workspaceRoot, liveStream) {
  const video = readLockedFile(
    workspaceRoot,
    liveStream.videoPath,
    liveStream.videoSha256,
    "live HLS duel video",
  );
  const state = readLockedJson(
    workspaceRoot,
    liveStream.statePath,
    liveStream.stateSha256,
    "live HLS duel state",
  ).json;
  const capture = readLockedJson(
    workspaceRoot,
    liveStream.captureStatusPath,
    liveStream.captureStatusSha256,
    "live HLS capture status",
  ).json;
  const observations = state.cycle?.actionObservations;
  if (
    video.bytes.length < 1_000_000 ||
    state.type !== "STREAMING_STATE_UPDATE" ||
    state.cycle?.phase !== "FIGHTING" ||
    !Array.isArray(observations) ||
    !observations.some(
      (entry) =>
        entry?.combatRole === "ranged" &&
        entry?.action === "movement" &&
        entry?.outcome === "accepted",
    ) ||
    !observations.some(
      (entry) =>
        entry?.action === "role_switch" && entry?.outcome === "committed",
    ) ||
    capture.rendererHealth?.ready !== true ||
    capture.rendererHealth?.degradedReason !== null ||
    capture.rendererPerformance?.uptimeMs < liveStream.minimumUptimeMs ||
    capture.rendererPerformance?.overall?.frames < liveStream.minimumFrames ||
    capture.rendererPerformance?.byPhase?.FIGHTING?.frameIntervalMs?.p95 >
      liveStream.maximumFightingFrameIntervalP95Ms ||
    capture.rendererPerformance?.byPhase?.FIGHTING?.frameWorkMs?.p95 >
      liveStream.maximumFightingFrameWorkP95Ms ||
    capture.rendererPerformance?.viewport?.width !== 1280 ||
    capture.rendererPerformance?.viewport?.height !== 720
  ) {
    throw new Error("Live HLS duel evidence does not satisfy its locked gate");
  }
}

function validateRuntimeSource(workspaceRoot, definition) {
  const runtimeSource = readFileSync(
    path.join(workspaceRoot, "packages/shared/src/data/playerEmotes.ts"),
    "utf8",
  );
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const motion of definition.motions) {
    const key = `BOW_DUEL_${motion.id.toUpperCase()}`;
    const declaration = new RegExp(
      `${key}:\\s*${escapeRegExp(JSON.stringify(motion.assetUrl))}`,
      "u",
    );
    if (!declaration.test(runtimeSource)) {
      throw new Error(`${key} does not select its canonical certified asset`);
    }
  }
  if (
    /BOW_DUEL_(?:IDLE|WALK|RUN):[\s\S]{0,160}emotes\/candidates\//u.test(
      runtimeSource,
    )
  ) {
    throw new Error(
      "Active bow-duel emotes must not reference candidate paths",
    );
  }
}

function validateEvidence(workspaceRoot, assetsRoot, definition) {
  validateCandidateReport(workspaceRoot, definition);
  const equipmentById = validateEquipment(
    workspaceRoot,
    assetsRoot,
    definition,
  );
  validateBrowserReviews(workspaceRoot, definition, equipmentById);
  validateLiveStreamEvidence(workspaceRoot, definition.evidence.liveStream);
  validateRuntimeSource(workspaceRoot, definition);
}

export function installCertifiedBowDuelPresentationAssets({
  workspaceRoot,
  assetsRoot,
  definition,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  validateDefinition(definition, assetsRoot);
  validateEvidence(workspaceRoot, assetsRoot, definition);

  const destinations = definition.motions.map((motion) => {
    const source = readLockedFile(
      workspaceRoot,
      motion.sourcePath,
      motion.sha256,
      `${motion.id} motion source`,
    );
    return {
      id: motion.id,
      path: safeRelativePath(
        assetsRoot,
        motion.destinationPath,
        `${motion.id} motion destination`,
      ),
      relativePath: motion.destinationPath,
      bytes: source.bytes,
    };
  });

  if (check) {
    for (const destination of destinations) {
      if (
        !existsSync(destination.path) ||
        !readFileSync(destination.path).equals(destination.bytes)
      ) {
        throw new Error(`${destination.relativePath} is missing or stale`);
      }
    }
  } else {
    for (const destination of destinations) {
      writeAtomic(destination.path, destination.bytes);
    }
  }

  return {
    activationId: definition.activationId,
    installed: destinations.map((destination) => ({
      id: destination.id,
      path: destination.relativePath,
      bytes: destination.bytes.length,
      sha256: sha256(destination.bytes),
    })),
  };
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return { check: argv[0] === "--check" };
}

function main(options) {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const definition = JSON.parse(
    readFileSync(
      path.join(
        workspaceRoot,
        "scripts/certified-bow-duel-presentation-asset-install.json",
      ),
      "utf8",
    ),
  );
  const result = installCertifiedBowDuelPresentationAssets({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    definition,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${result.installed.length} certified bow-duel presentation assets for ${result.activationId}\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
