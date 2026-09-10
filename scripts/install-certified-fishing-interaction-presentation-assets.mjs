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

import { parseGlbJson } from "./audit-avatar-lods.mjs";

const ASSET_PREFIX = "asset://";
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

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

function readLockedFile(workspaceRoot, definition, label) {
  if (
    !isRecord(definition) ||
    typeof definition.path !== "string" ||
    !SHA256.test(definition.sha256)
  ) {
    throw new Error(`${label} lock is invalid`);
  }
  const filePath = safeRelativePath(workspaceRoot, definition.path, label);
  const bytes = readFileSync(filePath);
  if (sha256(bytes) !== definition.sha256) {
    throw new Error(`${label} drifted from its SHA-256 lock`);
  }
  return { path: filePath, bytes };
}

function readLockedJson(workspaceRoot, definition, label) {
  const file = readLockedFile(workspaceRoot, definition, label);
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

function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function validateDefinition(definition, assetsRoot) {
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    !SAFE_ID.test(definition.activationGroupId) ||
    !SAFE_ID.test(definition.avatarId) ||
    !isRecord(definition.itemsManifest) ||
    !isRecord(definition.runtimeManifest) ||
    !isRecord(definition.reports) ||
    !Array.isArray(definition.motions) ||
    definition.motions.length !== 3 ||
    !Array.isArray(definition.items) ||
    definition.items.length !== 3
  ) {
    throw new Error("Fishing-interaction activation definition is invalid");
  }
  for (const [label, authority] of [
    ["items manifest", definition.itemsManifest],
    ["runtime manifest", definition.runtimeManifest],
  ]) {
    if (
      typeof authority.path !== "string" ||
      !SHA256.test(authority.baselineSha256)
    ) {
      throw new Error(`${label} authority is invalid`);
    }
    safeRelativePath(assetsRoot, authority.path, label);
  }
  const motionIds = new Set();
  for (const motion of definition.motions) {
    if (
      !isRecord(motion) ||
      !SAFE_ID.test(motion.id) ||
      motionIds.has(motion.id) ||
      typeof motion.destinationPath !== "string"
    ) {
      throw new Error("Fishing-interaction motion definition is invalid");
    }
    motionIds.add(motion.id);
    safeRelativePath(assetsRoot, motion.destinationPath, "motion destination");
  }
  const expectedItemIds = [
    "fly_fishing_rod",
    "small_fishing_net",
    "lobster_pot",
  ];
  if (
    definition.items.some(
      (item, index) =>
        !isRecord(item) ||
        item.itemId !== expectedItemIds[index] ||
        !SAFE_ID.test(item.bodyEmoteKey) ||
        typeof item.equipmentDestinationPath !== "string" ||
        !SAFE_ID.test(item.motionId),
    )
  ) {
    throw new Error("Fishing-interaction item definition is invalid");
  }
  for (const item of definition.items) {
    safeRelativePath(
      assetsRoot,
      item.equipmentDestinationPath,
      `${item.itemId} equipment destination`,
    );
    if (item.world) {
      if (
        !isRecord(item.world) ||
        typeof item.world.sourcePath !== "string" ||
        !SHA256.test(item.world.sha256) ||
        typeof item.world.destinationPath !== "string" ||
        !isRecord(item.review) ||
        !SHA256.test(item.review.reportSha256) ||
        !SHA256.test(item.review.contactSheetSha256) ||
        !Number.isSafeInteger(item.review.sampleCount)
      ) {
        throw new Error(`${item.itemId} world authority is invalid`);
      }
      safeRelativePath(
        assetsRoot,
        item.world.destinationPath,
        `${item.itemId} world destination`,
      );
    }
  }
}

function readCurrentManifest(assetsRoot, authority, label) {
  const manifestPath = safeRelativePath(assetsRoot, authority.path, label);
  const bytes = readFileSync(manifestPath);
  return {
    path: manifestPath,
    bytes,
    sha256: sha256(bytes),
    json: JSON.parse(bytes.toString("utf8")),
  };
}

function validateBrowserReview(workspaceRoot, item, fitOutput) {
  if (!item.review) return;
  const report = readLockedJson(
    workspaceRoot,
    { path: item.review.reportPath, sha256: item.review.reportSha256 },
    `${item.itemId} browser review`,
  ).json;
  readLockedFile(
    workspaceRoot,
    {
      path: item.review.contactSheetPath,
      sha256: item.review.contactSheetSha256,
    },
    `${item.itemId} contact sheet`,
  );
  if (
    !Array.isArray(report.motions) ||
    report.motions.length !== item.review.sampleCount ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length !== 0 ||
    report.motions.some(
      (sample) =>
        !Array.isArray(sample.failures) ||
        sample.failures.length !== 0 ||
        sample.equipment?.itemId !== item.itemId ||
        sample.equipment?.asset !== fitOutput.outputPath ||
        sample.equipment?.metadataValid !== true ||
        sample.equipment?.attached !== true ||
        sample.equipment?.visible !== true ||
        sample.equipment?.rightHandNearestSurfaceDistance > 0.000001,
    )
  ) {
    throw new Error(`${item.itemId} browser review is not clean`);
  }
}

function validateWorldModel(workspaceRoot, item) {
  if (!item.world) return null;
  const source = readLockedFile(
    workspaceRoot,
    { path: item.world.sourcePath, sha256: item.world.sha256 },
    `${item.itemId} world model`,
  );
  const document = parseGlbJson(source.bytes, item.world.sourcePath);
  const authority = document.nodes
    ?.map((node) => node.extras?.hyperia?.fishingWorld)
    .find(Boolean);
  if (
    authority?.schemaVersion !== 1 ||
    authority.itemId !== item.itemId ||
    !Array.isArray(authority.placement?.positionOffset) ||
    authority.placement.positionOffset.length !== 3 ||
    !Array.isArray(authority.placement?.rotationEulerDegrees) ||
    authority.placement.rotationEulerDegrees.length !== 3 ||
    !Number.isFinite(authority.placement?.scale) ||
    authority.placement.scale <= 0
  ) {
    throw new Error(`${item.itemId} world placement metadata is invalid`);
  }
  return {
    itemId: item.itemId,
    sourcePath: item.world.sourcePath,
    destinationPath: item.world.destinationPath,
    assetUrl: `${ASSET_PREFIX}${item.world.destinationPath}`,
    sha256: item.world.sha256,
    bytes: source.bytes,
  };
}

export function buildCertifiedFishingInteractionActivation({
  workspaceRoot,
  assetsRoot,
  definition,
}) {
  validateDefinition(definition, assetsRoot);
  const motionReport = readLockedJson(
    workspaceRoot,
    definition.reports.motions,
    "fishing-interaction motion report",
  ).json;
  const fitReport = readLockedJson(
    workspaceRoot,
    definition.reports.fits,
    "fishing-interaction fit report",
  ).json;
  if (
    motionReport.schemaVersion !== 1 ||
    motionReport.provenance?.license !== "CC0-1.0" ||
    motionReport.approvedForRuntimeActivation !== false ||
    !Array.isArray(motionReport.outputs) ||
    motionReport.outputs.length !== 3 ||
    fitReport.schemaVersion !== 1 ||
    fitReport.avatar?.id !== definition.avatarId ||
    fitReport.browserVerification?.loaded !== true ||
    fitReport.browserVerification?.hasContent !== true ||
    fitReport.browserVerification?.hasErrorOverlay !== false ||
    fitReport.browserVerification?.consoleErrors?.length !== 0 ||
    !Array.isArray(fitReport.outputs) ||
    fitReport.outputs.length !== 3
  ) {
    throw new Error("Fishing-interaction certification reports are invalid");
  }

  const motions = definition.motions.map((authority) => {
    const output = motionReport.outputs.find(
      (candidate) => candidate.id === authority.id,
    );
    if (
      !output ||
      !SHA256.test(output.sha256) ||
      output.durationSeconds !== 1.2 ||
      output.presentationTiming?.durationSeconds !== 1.2 ||
      output.validator?.errors !== 0 ||
      output.validator?.warnings !== 0 ||
      output.validator?.hints !== 0
    ) {
      throw new Error(`${authority.id} motion is not certified`);
    }
    const source = readLockedFile(
      workspaceRoot,
      { path: output.path, sha256: output.sha256 },
      `${authority.id} motion`,
    );
    return {
      id: authority.id,
      sourcePath: output.path,
      destinationPath: authority.destinationPath,
      assetUrl: `${ASSET_PREFIX}${authority.destinationPath}`,
      sha256: output.sha256,
      durationSeconds: output.durationSeconds,
      presentationTiming: structuredClone(output.presentationTiming),
      bytes: source.bytes,
    };
  });
  const motionById = new Map(motions.map((motion) => [motion.id, motion]));

  const equipment = definition.items.map((item) => {
    const output = fitReport.outputs.find(
      (candidate) => candidate.itemId === item.itemId,
    );
    if (
      !output ||
      !SHA256.test(output.outputSha256) ||
      output.attachmentBone !== "rightHand" ||
      output.fittedWorldPositionErrorMetres > 0.000001 ||
      output.fittedWorldRotationErrorDegrees > 0.001 ||
      output.validator?.errors !== 0 ||
      output.validator?.warnings !== 0 ||
      output.validator?.infos !== 0 ||
      output.validator?.hints !== 0
    ) {
      throw new Error(`${item.itemId} fit is not certified`);
    }
    validateBrowserReview(workspaceRoot, item, output);
    const source = readLockedFile(
      workspaceRoot,
      { path: output.outputPath, sha256: output.outputSha256 },
      `${item.itemId} fitted equipment`,
    );
    return {
      itemId: item.itemId,
      sourcePath: output.outputPath,
      destinationPath: item.equipmentDestinationPath,
      assetUrl: `${ASSET_PREFIX}${item.equipmentDestinationPath}`,
      sha256: output.outputSha256,
      bytes: source.bytes,
    };
  });
  const equipmentById = new Map(
    equipment.map((entry) => [entry.itemId, entry]),
  );
  const worldModels = definition.items
    .map((item) => validateWorldModel(workspaceRoot, item))
    .filter(Boolean);
  const worldById = new Map(worldModels.map((entry) => [entry.itemId, entry]));

  const itemsManifest = readCurrentManifest(
    assetsRoot,
    definition.itemsManifest,
    "items manifest",
  );
  const runtimeManifest = readCurrentManifest(
    assetsRoot,
    definition.runtimeManifest,
    "runtime manifest",
  );
  if (!Array.isArray(itemsManifest.json)) {
    throw new Error("Tools manifest must be an array");
  }
  if (
    runtimeManifest.json?.schemaVersion !== 1 ||
    !Array.isArray(runtimeManifest.json.activations)
  ) {
    throw new Error("Runtime activation manifest is invalid");
  }

  const expectedItems = structuredClone(itemsManifest.json);
  for (const item of definition.items) {
    const manifestItem = expectedItems.find(
      (candidate) => candidate?.id === item.itemId,
    );
    if (!manifestItem)
      throw new Error(`Tools manifest is missing ${item.itemId}`);
    const fitted = equipmentById.get(item.itemId);
    const existingFits = manifestItem.gatheringModelPathsByAvatar;
    if (
      existingFits !== null &&
      existingFits !== undefined &&
      (!isRecord(existingFits) ||
        (existingFits[definition.avatarId] !== undefined &&
          existingFits[definition.avatarId] !== fitted.assetUrl))
    ) {
      throw new Error(`${item.itemId} fitted path authority drifted`);
    }
    manifestItem.gatheringModelPathsByAvatar = {
      ...(isRecord(existingFits) ? existingFits : {}),
      [definition.avatarId]: fitted.assetUrl,
    };
    const world = worldById.get(item.itemId);
    if (world) {
      if (
        manifestItem.modelPath !== null &&
        manifestItem.modelPath !== undefined &&
        manifestItem.modelPath !== world.assetUrl
      ) {
        throw new Error(`${item.itemId} world model authority drifted`);
      }
      manifestItem.modelPath = world.assetUrl;
    }
  }
  const expectedItemsBytes = serialize(expectedItems);
  if (
    itemsManifest.sha256 !== definition.itemsManifest.baselineSha256 &&
    !itemsManifest.bytes.equals(expectedItemsBytes)
  ) {
    throw new Error(
      "Tools manifest drifted from baseline and activation state",
    );
  }

  const activations = definition.items.map((item) => {
    const fitted = equipmentById.get(item.itemId);
    const deployMotion =
      item.motionId === "existing_fishing_cast"
        ? item.motion
        : motionById.get(item.motionId);
    const retrievalMotion = item.retrievalMotionId
      ? motionById.get(item.retrievalMotionId)
      : null;
    if (
      !fitted ||
      !deployMotion ||
      !SHA256.test(deployMotion.sha256) ||
      (item.retrievalMotionId && !retrievalMotion)
    ) {
      throw new Error(`${item.itemId} runtime motion authority is incomplete`);
    }
    if (item.motionId === "existing_fishing_cast") {
      const relativePath = deployMotion.assetUrl.slice(ASSET_PREFIX.length);
      const installedPath = safeRelativePath(
        assetsRoot,
        relativePath,
        "existing fishing motion",
      );
      if (
        !existsSync(installedPath) ||
        sha256(readFileSync(installedPath)) !== deployMotion.sha256
      ) {
        throw new Error("Existing fishing-cast motion is missing or stale");
      }
    }
    return {
      activationId: `steve-${item.itemId.replaceAll("_", "-")}-v1`,
      activationGroupId: definition.activationGroupId,
      state: "active",
      avatarId: definition.avatarId,
      itemId: item.itemId,
      slot: "gatheringtool",
      bodyEmoteKey: item.bodyEmoteKey,
      equipment: { assetUrl: fitted.assetUrl, sha256: fitted.sha256 },
      motion: {
        assetUrl: deployMotion.assetUrl,
        sha256: deployMotion.sha256,
        durationSeconds: deployMotion.durationSeconds,
        ...(deployMotion.loopSeamExact === true
          ? { loopSeamExact: true }
          : { presentationTiming: deployMotion.presentationTiming }),
      },
      ...(retrievalMotion
        ? {
            retrievalMotion: {
              assetUrl: retrievalMotion.assetUrl,
              sha256: retrievalMotion.sha256,
              durationSeconds: retrievalMotion.durationSeconds,
              presentationTiming: retrievalMotion.presentationTiming,
            },
          }
        : {}),
      ...(worldById.has(item.itemId)
        ? {
            worldModel: {
              assetUrl: worldById.get(item.itemId).assetUrl,
              sha256: worldById.get(item.itemId).sha256,
            },
          }
        : {}),
      rollback: {
        gatheringModelPathsByAvatar: {},
        ...(worldById.has(item.itemId) ? { modelPath: null } : {}),
        removeInstalledAssets: true,
      },
    };
  });
  const ownedIds = new Set(activations.map((entry) => entry.activationId));
  const duplicates = runtimeManifest.json.activations.filter((entry) =>
    ownedIds.has(entry?.activationId),
  );
  if (
    new Set(duplicates.map((entry) => entry.activationId)).size !==
    duplicates.length
  ) {
    throw new Error("Runtime manifest has duplicate fishing activations");
  }
  const preserved = runtimeManifest.json.activations.filter(
    (entry) => !ownedIds.has(entry?.activationId),
  );
  const expectedRuntimeBytes = serialize({
    schemaVersion: 1,
    activations: [...preserved, ...activations],
  });
  if (
    runtimeManifest.sha256 !== definition.runtimeManifest.baselineSha256 &&
    !runtimeManifest.bytes.equals(expectedRuntimeBytes)
  ) {
    throw new Error(
      "Runtime manifest drifted from baseline and activation state",
    );
  }

  return {
    assets: [...equipment, ...worldModels, ...motions],
    activations,
    itemsManifest: { ...itemsManifest, expectedBytes: expectedItemsBytes },
    runtimeManifest: {
      ...runtimeManifest,
      expectedBytes: expectedRuntimeBytes,
    },
  };
}

export function installCertifiedFishingInteractionPresentationAssets({
  workspaceRoot,
  assetsRoot,
  definition,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  const activation = buildCertifiedFishingInteractionActivation({
    workspaceRoot,
    assetsRoot,
    definition,
  });
  const destinations = activation.assets.map((asset) => ({
    ...asset,
    path: safeRelativePath(
      assetsRoot,
      asset.destinationPath,
      "runtime asset destination",
    ),
  }));
  if (check) {
    for (const destination of destinations) {
      if (
        !existsSync(destination.path) ||
        sha256(readFileSync(destination.path)) !== destination.sha256
      ) {
        throw new Error(`${destination.destinationPath} is missing or stale`);
      }
    }
    if (
      !activation.itemsManifest.bytes.equals(
        activation.itemsManifest.expectedBytes,
      )
    ) {
      throw new Error(`${definition.itemsManifest.path} is missing or stale`);
    }
    if (
      !activation.runtimeManifest.bytes.equals(
        activation.runtimeManifest.expectedBytes,
      )
    ) {
      throw new Error(`${definition.runtimeManifest.path} is missing or stale`);
    }
  } else {
    for (const destination of destinations) {
      writeAtomic(destination.path, destination.bytes);
    }
    writeAtomic(
      activation.itemsManifest.path,
      activation.itemsManifest.expectedBytes,
    );
    writeAtomic(
      activation.runtimeManifest.path,
      activation.runtimeManifest.expectedBytes,
    );
  }
  return {
    activationGroupId: definition.activationGroupId,
    activationCount: activation.activations.length,
    installed: destinations.map((destination) => ({
      path: destination.destinationPath,
      bytes: destination.bytes.length,
      sha256: destination.sha256,
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
        "scripts/certified-fishing-interaction-presentation-asset-install.json",
      ),
      "utf8",
    ),
  );
  const result = installCertifiedFishingInteractionPresentationAssets({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    definition,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${result.installed.length} certified fishing-interaction assets across ${result.activationCount} activations\n`,
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
