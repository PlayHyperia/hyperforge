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
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_MOTION_IDS = ["idle", "walk", "run", "slash"];
const EXPECTED_PLAYBACK_SPEEDS = [1, 1.3, 1.4, 1];
const EXPECTED_LOOPS = [true, true, true, false];
const EXPECTED_WEBGPU_REVIEW_IDS = ["full-resolution", "lod1", "lod2"];
const EXPECTED_EXACT_CAMERA_YAWS = [0, -90, 180, 90];
const EXPECTED_EXACT_PHASES = [
  "ready",
  "wind-up",
  "accelerate",
  "impact",
  "follow-through",
  "recover",
  "guard",
];

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

function readLockedJson(workspaceRoot, definition, label) {
  const file = readLockedFile(
    workspaceRoot,
    definition.path,
    definition.sha256,
    label,
  );
  return JSON.parse(file.bytes.toString("utf8"));
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

function validateDefinition(definition, assetsRoot) {
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    definition.activationId !== "steve-bronze-2h-duel-controlled-v1" ||
    definition.avatarId !== "steve" ||
    definition.itemId !== "bronze_2h_sword" ||
    !isRecord(definition.equipment) ||
    !Array.isArray(definition.motions) ||
    definition.motions.length !== EXPECTED_MOTION_IDS.length ||
    !isRecord(definition.evidence) ||
    !Array.isArray(definition.evidence.webGPUReviews) ||
    definition.evidence.webGPUReviews.length !==
      EXPECTED_WEBGPU_REVIEW_IDS.length ||
    !Array.isArray(definition.evidence.runtimeWebGPUReviews) ||
    definition.evidence.runtimeWebGPUReviews.length !==
      EXPECTED_WEBGPU_REVIEW_IDS.length
  ) {
    throw new Error("Certified two-hand presentation definition is invalid");
  }
  if (
    !SHA256.test(definition.equipment.sha256) ||
    definition.equipment.assetUrl !==
      `${ASSET_PREFIX}${definition.equipment.destinationPath}` ||
    !definition.equipment.sourceAssetPath.includes("/candidates/") ||
    definition.equipment.destinationPath.includes("candidates")
  ) {
    throw new Error("Certified two-hand equipment definition is invalid");
  }
  safeRelativePath(
    assetsRoot,
    definition.equipment.destinationPath,
    "equipment destination",
  );
  for (const [index, motion] of definition.motions.entries()) {
    const id = EXPECTED_MOTION_IDS[index];
    const query = motion.loop
      ? motion.playbackSpeed === 1
        ? ""
        : `?s=${motion.playbackSpeed}`
      : "?l=0";
    if (
      !isRecord(motion) ||
      motion.id !== id ||
      motion.playbackSpeed !== EXPECTED_PLAYBACK_SPEEDS[index] ||
      motion.loop !== EXPECTED_LOOPS[index] ||
      !SHA256.test(motion.sha256) ||
      motion.assetUrl !== `${ASSET_PREFIX}${motion.destinationPath}${query}` ||
      !motion.sourceAssetPath.includes("emotes/candidates/") ||
      motion.destinationPath.includes("candidates")
    ) {
      throw new Error(`${id} certified motion definition is invalid`);
    }
    safeRelativePath(assetsRoot, motion.destinationPath, `${id} destination`);
  }
  for (const reviews of [
    definition.evidence.webGPUReviews,
    definition.evidence.runtimeWebGPUReviews,
  ]) {
    if (
      JSON.stringify(reviews.map((review) => review.id)) !==
      JSON.stringify(EXPECTED_WEBGPU_REVIEW_IDS)
    ) {
      throw new Error("Certified WebGPU review set is invalid");
    }
    for (const review of reviews) {
      if (
        !isRecord(review) ||
        typeof review.avatarAsset !== "string" ||
        !SHA256.test(review.avatarSha256)
      ) {
        throw new Error(`${review?.id ?? "unknown"} avatar lock is invalid`);
      }
    }
  }
}

function validateCandidateReports(workspaceRoot, definition) {
  const locomotion = readLockedJson(
    workspaceRoot,
    definition.evidence.locomotionReport,
    "two-hand locomotion report",
  );
  const attack = readLockedJson(
    workspaceRoot,
    definition.evidence.attackReport,
    "two-hand attack report",
  );
  const transition = readLockedJson(
    workspaceRoot,
    definition.evidence.transitionReport,
    "two-hand transition report",
  );
  for (const report of [locomotion, attack, transition]) {
    if (
      report.schemaVersion !== 1 ||
      report.activationStatus !== "isolated-candidate" ||
      report.approvedForRuntimeActivation !== false
    ) {
      throw new Error("Two-hand evidence does not preserve review isolation");
    }
  }
  for (const motion of definition.motions.slice(0, 3)) {
    const output = locomotion.outputs?.find(
      (entry) =>
        entry?.profileId === "controlled-guard" &&
        entry?.locomotionId === motion.id,
    );
    if (
      !isRecord(output) ||
      output.outputAsset !== motion.sourceAssetPath ||
      output.sha256 !== motion.sha256 ||
      output.validation?.errors !== 0 ||
      output.validation?.warnings !== 0 ||
      output.validation?.hints !== 0 ||
      output.controlledGuardLoopSeam?.exactAfterClosure !== true
    ) {
      throw new Error(`${motion.id} locomotion candidate is not certified`);
    }
  }
  const slash = definition.motions[3];
  const attackOutput = attack.outputs?.find(
    (entry) => entry?.id === "planted-45",
  );
  if (
    !isRecord(attackOutput) ||
    attackOutput.outputAsset !== slash.sourceAssetPath ||
    attackOutput.sha256 !== slash.sha256 ||
    attackOutput.validation?.errors !== 0 ||
    attackOutput.validation?.warnings !== 0 ||
    attackOutput.validation?.hints !== 0 ||
    Math.abs(attackOutput.durationSeconds - 1.3) > 0.000001
  ) {
    throw new Error("Two-hand slash candidate is not certified");
  }
  if (
    !Array.isArray(transition.transitions) ||
    transition.transitions.length !== 2 ||
    transition.transitions.some(
      (entry) =>
        entry?.passed !== true ||
        entry.sharedChannelCount !== 195 ||
        entry.gripCriticalRotationChannelCount !== 34 ||
        entry.maximumRotationDeltaDegrees >
          transition.thresholds.maximumRotationDeltaDegrees ||
        entry.maximumLinearDelta > transition.thresholds.maximumLinearDelta,
    )
  ) {
    throw new Error("Two-hand guard/slash transitions are not certified");
  }
}

function validateGeometricReview(workspaceRoot, definition) {
  const evidence = definition.evidence.geometricReview;
  const report = readLockedFile(
    workspaceRoot,
    evidence.reportPath,
    evidence.reportSha256,
    "two-hand geometric report",
  );
  readLockedFile(
    workspaceRoot,
    evidence.contactSheetPath,
    evidence.contactSheetSha256,
    "two-hand geometric contact sheet",
  );
  const json = JSON.parse(report.bytes.toString("utf8"));
  if (
    !Array.isArray(json.motions) ||
    json.motions.length !== 28 ||
    !Array.isArray(json.failures) ||
    json.failures.length !== 0 ||
    !Array.isArray(json.browserErrors) ||
    json.browserErrors.length !== 0 ||
    json.motions.some(
      (sample) =>
        sample.asset !== definition.motions[3].sourceAssetPath ||
        sample.equipment?.asset !== definition.equipment.sourceAssetPath ||
        sample.equipment?.metadataValid !== true ||
        sample.equipment?.attached !== true ||
        sample.equipment?.twoHandGripActive !== true ||
        sample.equipment?.gripZoneContacts?.filter(
          (contact) => contact?.intersects === true,
        ).length !== 2 ||
        !Array.isArray(sample.failures) ||
        sample.failures.length !== 0,
    )
  ) {
    throw new Error("Two-hand exact-angle geometric review is not clean");
  }
}

function validateWebGPUReviews(workspaceRoot, definition, reviews, runtime) {
  const equipmentAsset = runtime
    ? definition.equipment.destinationPath
    : definition.equipment.sourceAssetPath;
  const assetHashes = new Map([
    [equipmentAsset, definition.equipment.sha256],
    ...definition.motions.map((motion) => [
      runtime ? motion.destinationPath : motion.sourceAssetPath,
      motion.sha256,
    ]),
  ]);
  for (const review of reviews) {
    const avatar = readLockedFile(
      workspaceRoot,
      path.posix.join(
        "packages/server/world/assets",
        review.avatarAsset,
      ),
      review.avatarSha256,
      `${review.id} avatar`,
    );
    const reportFile = readLockedFile(
      workspaceRoot,
      review.reportPath,
      review.reportSha256,
      `${review.id} WebGPU report`,
    );
    const video = readLockedFile(
      workspaceRoot,
      review.videoPath,
      review.videoSha256,
      `${review.id} WebGPU video`,
    );
    const contactSheet = readLockedFile(
      workspaceRoot,
      review.contactSheetPath,
      review.contactSheetSha256,
      `${review.id} WebGPU contact sheet`,
    );
    const report = JSON.parse(reportFile.bytes.toString("utf8"));
    if (
      video.bytes.length < 1_000_000 ||
      contactSheet.bytes.length < 100_000 ||
      report.schemaVersion !== 1 ||
      report.activationStatus !==
        (runtime ? "reviewed-production" : "isolated-candidate") ||
      report.approvedForRuntimeActivation !== runtime ||
      report.avatar?.asset !== review.avatarAsset ||
      report.avatar?.sha256 !== review.avatarSha256 ||
      report.equipment?.asset !== equipmentAsset ||
      report.equipment?.sha256 !== definition.equipment.sha256 ||
      report.equipment?.validation?.valid !== true ||
      report.renderer?.backend !== "webgpu" ||
      report.renderer?.architecture !== "metal-3" ||
      report.evaluation?.passed !== true ||
      report.evaluation?.checks?.some((check) => check?.passed !== true) ||
      report.browserErrors?.length !== 0 ||
      report.exactAngleReview?.rendererBackend !== "webgpu" ||
      report.exactAngleReview?.sampleCount !== 28 ||
      JSON.stringify(
        report.exactAngleReview.cameraAngles?.map((entry) => entry.yawDegrees),
      ) !== JSON.stringify(EXPECTED_EXACT_CAMERA_YAWS) ||
      JSON.stringify(
        report.exactAngleReview.phases?.map((entry) => entry.id),
      ) !== JSON.stringify(EXPECTED_EXACT_PHASES) ||
      report.exactAngleReview.contactSheet?.sha256 !==
        review.contactSheetSha256 ||
      report.video?.sha256 !== review.videoSha256 ||
      report.runtimePerformance?.frameIntervalMs?.p95 > 20 ||
      report.runtimePerformance?.frameIntervalMs?.maximum > 100 ||
      report.deterministicTelemetry?.maximumGripAxisDeviationDegrees > 0.01 ||
      report.inputs?.[review.avatarAsset] !== review.avatarSha256 ||
      avatar.bytes.length < 100_000 ||
      [...assetHashes].some(
        ([asset, expectedSha256]) => report.inputs?.[asset] !== expectedSha256,
      )
    ) {
      throw new Error(`${review.id} WebGPU review is not certified`);
    }
  }
}

function validateRuntimeSelections(workspaceRoot, definition) {
  const runtimeSource = readFileSync(
    path.join(workspaceRoot, "packages/shared/src/data/playerEmotes.ts"),
    "utf8",
  );
  for (const motion of definition.motions) {
    const key = `TWO_HAND_DUEL_${motion.id.toUpperCase()}`;
    if (!runtimeSource.includes(`${key}: ${JSON.stringify(motion.assetUrl)}`)) {
      throw new Error(`${key} does not select its certified asset`);
    }
  }
  if (
    /TWO_HAND_DUEL_\w+:[\s\S]{0,160}emotes\/candidates\//u.test(runtimeSource)
  ) {
    throw new Error("Active two-hand duel emotes reference candidate paths");
  }
  const weaponsManifest = JSON.parse(
    readFileSync(
      path.join(
        workspaceRoot,
        "packages/server/world/assets/manifests/items/weapons.json",
      ),
      "utf8",
    ),
  );
  const weapon = weaponsManifest.find((item) => item?.id === definition.itemId);
  if (weapon?.equippedModelPath !== definition.equipment.assetUrl) {
    throw new Error("Bronze two-hand sword does not select its certified fit");
  }
}

function validateEvidence(workspaceRoot, definition) {
  validateCandidateReports(workspaceRoot, definition);
  validateGeometricReview(workspaceRoot, definition);
  validateWebGPUReviews(
    workspaceRoot,
    definition,
    definition.evidence.webGPUReviews,
    false,
  );
  validateWebGPUReviews(
    workspaceRoot,
    definition,
    definition.evidence.runtimeWebGPUReviews,
    true,
  );
  validateRuntimeSelections(workspaceRoot, definition);
}

export function installCertifiedTwoHandDuelPresentationAssets({
  workspaceRoot,
  assetsRoot,
  definition,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  validateDefinition(definition, assetsRoot);
  validateEvidence(workspaceRoot, definition);
  const sources = [definition.equipment, ...definition.motions];
  const destinations = sources.map((source) => {
    const locked = readLockedFile(
      workspaceRoot,
      source.sourcePath,
      source.sha256,
      `${source.id ?? "equipment"} source`,
    );
    return {
      id: source.id ?? "equipment",
      path: safeRelativePath(
        assetsRoot,
        source.destinationPath,
        `${source.id ?? "equipment"} destination`,
      ),
      relativePath: source.destinationPath,
      bytes: locked.bytes,
      sha256: source.sha256,
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
    installed: destinations.map(({ id, relativePath, bytes, sha256 }) => ({
      id,
      path: relativePath,
      byteLength: bytes.length,
      sha256,
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
        "scripts/certified-two-hand-duel-presentation-asset-install.json",
      ),
      "utf8",
    ),
  );
  const result = installCertifiedTwoHandDuelPresentationAssets({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    definition,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${result.installed.length} certified two-hand duel presentation assets for ${result.activationId}\n`,
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
