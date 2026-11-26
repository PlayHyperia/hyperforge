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

const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ASSET_PREFIX = "asset://";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
  return { bytes, path: filePath };
}

function readLockedJson(workspaceRoot, definition, label) {
  const file = readLockedFile(workspaceRoot, definition, label);
  return { ...file, json: JSON.parse(file.bytes.toString("utf8")) };
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

function validateConfig(definition, assetsRoot) {
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    !SAFE_ID.test(definition.activationGroupId) ||
    !SAFE_ID.test(definition.avatarId) ||
    typeof definition.avatarAsset !== "string" ||
    !isRecord(definition.itemsManifest) ||
    !isRecord(definition.runtimeManifest) ||
    !isRecord(definition.reports) ||
    !Array.isArray(definition.families) ||
    definition.families.length !== 3 ||
    typeof definition.equipmentDestinationDirectory !== "string"
  ) {
    throw new Error("Certified preparation activation definition is invalid");
  }
  for (const [label, manifest] of [
    ["items manifest", definition.itemsManifest],
    ["runtime manifest", definition.runtimeManifest],
  ]) {
    if (
      typeof manifest.path !== "string" ||
      !SHA256.test(manifest.baselineSha256)
    ) {
      throw new Error(`${label} authority is invalid`);
    }
    safeRelativePath(assetsRoot, manifest.path, label);
  }
  safeRelativePath(
    assetsRoot,
    `${definition.equipmentDestinationDirectory}/placeholder.glb`,
    "equipment destination directory",
  );
  const familyIds = new Set();
  const itemIds = new Set();
  for (const family of definition.families) {
    if (
      !isRecord(family) ||
      !SAFE_ID.test(family.id) ||
      !SAFE_ID.test(family.bodyEmoteKey) ||
      !SAFE_ID.test(family.motionId) ||
      !SAFE_ID.test(family.reviewItemId) ||
      !Array.isArray(family.itemIds) ||
      family.itemIds.length < 1 ||
      family.itemIds.some((id) => !SAFE_ID.test(id)) ||
      typeof family.motionDestinationPath !== "string" ||
      typeof family.rollbackBodyEmotePath !== "string" ||
      !family.rollbackBodyEmotePath.startsWith(ASSET_PREFIX)
    ) {
      throw new Error("Certified preparation family definition is invalid");
    }
    if (familyIds.has(family.id)) throw new Error("Duplicate family ID");
    familyIds.add(family.id);
    safeRelativePath(
      assetsRoot,
      family.motionDestinationPath,
      `${family.id} motion destination`,
    );
    for (const itemId of family.itemIds) {
      if (itemIds.has(itemId)) throw new Error(`Duplicate item ID: ${itemId}`);
      itemIds.add(itemId);
    }
    if (!family.itemIds.includes(family.reviewItemId)) {
      throw new Error(`${family.id} review item is not in the family`);
    }
  }
  if (itemIds.size !== 13) {
    throw new Error(
      "Certified preparation scope must contain exactly 13 items",
    );
  }
}

function validateEvidence(workspaceRoot, definition) {
  const tierReportFile = readLockedJson(
    workspaceRoot,
    definition.reports.toolTiers,
    "tool tier report",
  );
  const fitReportFile = readLockedJson(
    workspaceRoot,
    definition.reports.activeFits,
    "active fit report",
  );
  const motionReportFile = readLockedJson(
    workspaceRoot,
    definition.reports.motions,
    "motion candidate report",
  );
  const tierReport = tierReportFile.json;
  const fitReport = fitReportFile.json;
  const motionReport = motionReportFile.json;
  if (
    tierReport.schemaVersion !== 1 ||
    tierReport.avatarId !== definition.avatarId ||
    tierReport.sourcePack?.license?.spdx !== "CC0-1.0" ||
    tierReport.summary?.requiredRuntimeItemCount !== 12 ||
    tierReport.summary?.certifiedCandidateCount !== 12 ||
    tierReport.summary?.gltfFindingCount !== 0 ||
    tierReport.summary?.readyForProductReview !== true ||
    tierReport.activeRuntimePathsChanged !== false ||
    !Array.isArray(tierReport.outputs) ||
    tierReport.outputs.length !== 12
  ) {
    throw new Error("Tool tier report does not certify the activation scope");
  }
  if (
    fitReport.schemaVersion !== 1 ||
    fitReport.avatar?.id !== definition.avatarId ||
    fitReport.browserVerification?.loaded !== true ||
    fitReport.browserVerification?.hasContent !== true ||
    fitReport.browserVerification?.hasErrorOverlay !== false ||
    !Array.isArray(fitReport.browserVerification?.consoleErrors) ||
    fitReport.browserVerification.consoleErrors.length !== 0 ||
    !Array.isArray(fitReport.outputs)
  ) {
    throw new Error("Active fit report does not certify the activation scope");
  }
  if (
    motionReport.schemaVersion !== 1 ||
    motionReport.provenance?.license !== "CC0-1.0" ||
    !Array.isArray(motionReport.outputs) ||
    motionReport.outputs.length !== 3
  ) {
    throw new Error("Motion report does not certify the activation scope");
  }

  const tierById = new Map(
    tierReport.outputs.map((output) => [output.itemId, output]),
  );
  const fitById = new Map(
    fitReport.outputs.map((output) => [output.itemId, output]),
  );
  const motionById = new Map(
    motionReport.outputs.map((output) => [output.id, output]),
  );
  const equipment = [];
  const motions = [];
  const reviews = [];

  for (const family of definition.families) {
    const motion = motionById.get(family.motionId);
    if (
      !isRecord(motion) ||
      typeof motion.path !== "string" ||
      !SHA256.test(motion.sha256) ||
      !Number.isFinite(motion.durationSeconds) ||
      motion.durationSeconds <= 0 ||
      motion.loopSeamExact !== true ||
      motion.validator?.errors !== 0 ||
      motion.validator?.warnings !== 0 ||
      motion.validator?.hints !== 0 ||
      !Array.isArray(motion.validator?.infoCodes) ||
      motion.validator.infoCodes.some((code) => code !== "NODE_EMPTY")
    ) {
      throw new Error(`${family.id} motion is not technically certified`);
    }
    const motionSource = readLockedFile(
      workspaceRoot,
      { path: motion.path, sha256: motion.sha256 },
      `${family.id} motion source`,
    );
    const runtimeMotion = {
      id: family.motionId,
      bodyEmoteKey: family.bodyEmoteKey,
      sourcePath: motion.path,
      destinationPath: family.motionDestinationPath,
      assetUrl: `${ASSET_PREFIX}${family.motionDestinationPath}`,
      sha256: motion.sha256,
      bytes: motionSource.bytes,
      durationSeconds: motion.durationSeconds,
      loopSeamExact: true,
    };
    motions.push(runtimeMotion);

    for (const itemId of family.itemIds) {
      const output =
        itemId === "fishing_rod" ? fitById.get(itemId) : tierById.get(itemId);
      const outputPath = output?.outputPath;
      const outputSha256 = output?.outputSha256;
      if (
        !isRecord(output) ||
        typeof outputPath !== "string" ||
        !SHA256.test(outputSha256) ||
        output.validator?.errors !== 0 ||
        output.validator?.warnings !== 0 ||
        output.validator?.infos !== 0 ||
        output.validator?.hints !== 0
      ) {
        throw new Error(`${itemId} equipment is not technically certified`);
      }
      if (
        itemId !== "fishing_rod" &&
        (output.fitAuthority?.itemId !== itemId ||
          output.fitAuthority?.slot !== "gatheringtool" ||
          !output.fitAuthority?.compatibleAvatarIds?.includes(
            definition.avatarId,
          ))
      ) {
        throw new Error(`${itemId} fit authority is invalid`);
      }
      const source = readLockedFile(
        workspaceRoot,
        { path: outputPath, sha256: outputSha256 },
        `${itemId} equipment source`,
      );
      const destinationPath = `${definition.equipmentDestinationDirectory}/${itemId.replaceAll("_", "-")}-steve-fitted.glb`;
      equipment.push({
        itemId,
        familyId: family.id,
        sourcePath: outputPath,
        destinationPath,
        assetUrl: `${ASSET_PREFIX}${destinationPath}`,
        sha256: outputSha256,
        bytes: source.bytes,
      });
    }

    const reviewReportFile = readLockedJson(
      workspaceRoot,
      family.reviewReport,
      `${family.id} browser review report`,
    );
    readLockedFile(
      workspaceRoot,
      family.contactSheet,
      `${family.id} contact sheet`,
    );
    const review = reviewReportFile.json;
    const reviewEquipment = equipment.find(
      (entry) => entry.itemId === family.reviewItemId,
    );
    if (
      review.avatarAsset !== definition.avatarAsset ||
      !Array.isArray(review.motions) ||
      review.motions.length !== 5 ||
      !Array.isArray(review.failures) ||
      review.failures.length !== 0 ||
      !Array.isArray(review.browserErrors) ||
      review.browserErrors.length !== 0 ||
      review.motions.some(
        (sample) =>
          sample.asset !== motion.path ||
          !Array.isArray(sample.failures) ||
          sample.failures.length !== 0 ||
          sample.equipment?.itemId !== family.reviewItemId ||
          sample.equipment?.asset !== reviewEquipment?.sourcePath ||
          sample.equipment?.metadataValid !== true ||
          sample.equipment?.attached !== true ||
          sample.equipment?.visible !== true,
      )
    ) {
      throw new Error(`${family.id} browser review is not clean`);
    }
    reviews.push({ familyId: family.id, sampleCount: review.motions.length });
  }
  return { equipment, motions, reviews };
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function readCurrentManifest(assetsRoot, authority, label) {
  const manifestPath = safeRelativePath(assetsRoot, authority.path, label);
  const bytes = readFileSync(manifestPath);
  return {
    path: manifestPath,
    bytes,
    sha256: sha256(bytes),
    json: JSON.parse(bytes),
  };
}

export function buildCertifiedPreparationActivation({
  workspaceRoot,
  assetsRoot,
  definition,
}) {
  validateConfig(definition, assetsRoot);
  const evidence = validateEvidence(workspaceRoot, definition);
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
  const equipmentById = new Map(
    evidence.equipment.map((entry) => [entry.itemId, entry]),
  );
  const expectedItems = structuredClone(itemsManifest.json);
  for (const [itemId, equipment] of equipmentById) {
    const item = expectedItems.find((candidate) => candidate?.id === itemId);
    if (!item) throw new Error(`Tools manifest is missing ${itemId}`);
    const existing = item.gatheringModelPathsByAvatar;
    if (
      existing !== undefined &&
      (!isRecord(existing) ||
        Object.keys(existing).some(
          (avatarId) => avatarId !== definition.avatarId,
        ) ||
        (existing[definition.avatarId] !== undefined &&
          existing[definition.avatarId] !== equipment.assetUrl))
    ) {
      throw new Error(`${itemId} has drifted gathering presentation authority`);
    }
    item.gatheringModelPathsByAvatar = {
      ...(isRecord(existing) ? existing : {}),
      [definition.avatarId]: equipment.assetUrl,
    };
  }
  const expectedItemsBytes = serialize(expectedItems);
  if (
    itemsManifest.sha256 !== definition.itemsManifest.baselineSha256 &&
    !itemsManifest.bytes.equals(expectedItemsBytes)
  ) {
    throw new Error(
      "Tools manifest drifted from both baseline and installed authority",
    );
  }

  const preservedIds = definition.runtimeManifest.preserveActivationIds;
  const optionalPreservedIds =
    definition.runtimeManifest.optionalPreserveActivationIds;
  if (
    !Array.isArray(preservedIds) ||
    preservedIds.length < 1 ||
    preservedIds.some((id) => !SAFE_ID.test(id)) ||
    !Array.isArray(optionalPreservedIds) ||
    optionalPreservedIds.some((id) => !SAFE_ID.test(id)) ||
    new Set([...preservedIds, ...optionalPreservedIds]).size !==
      preservedIds.length + optionalPreservedIds.length
  ) {
    throw new Error("Preserved activation authority is invalid");
  }
  const newActivationIds = new Set(
    evidence.equipment.map(
      (entry) => `steve-${entry.itemId.replaceAll("_", "-")}-v1`,
    ),
  );
  const preservedIdSet = new Set([...preservedIds, ...optionalPreservedIds]);
  const presentRequiredIds = new Set(
    runtimeManifest.json.activations
      .filter((activation) => preservedIds.includes(activation?.activationId))
      .map((activation) => activation.activationId),
  );
  if (presentRequiredIds.size !== preservedIds.length) {
    throw new Error("A required existing activation is missing");
  }
  const unexpected = runtimeManifest.json.activations.filter(
    (activation) =>
      !preservedIdSet.has(activation?.activationId) &&
      !newActivationIds.has(activation?.activationId),
  );
  if (unexpected.length > 0) {
    throw new Error("Runtime manifest contains an unowned activation");
  }
  const familyById = new Map(
    definition.families.map((family) => [family.id, family]),
  );
  const motionByFamilyId = new Map(
    evidence.motions.map((motion) => [motion.id, motion]),
  );
  const activations = evidence.equipment.map((equipment) => {
    const family = familyById.get(equipment.familyId);
    const motion = motionByFamilyId.get(family.motionId);
    return {
      activationId: `steve-${equipment.itemId.replaceAll("_", "-")}-v1`,
      activationGroupId: definition.activationGroupId,
      state: "active",
      avatarId: definition.avatarId,
      itemId: equipment.itemId,
      slot: "gatheringtool",
      bodyEmoteKey: family.bodyEmoteKey,
      equipment: { assetUrl: equipment.assetUrl, sha256: equipment.sha256 },
      motion: {
        assetUrl: motion.assetUrl,
        sha256: motion.sha256,
        durationSeconds: motion.durationSeconds,
        loopSeamExact: motion.loopSeamExact,
      },
      rollback: {
        gatheringModelPathsByAvatar: {},
        bodyEmotePath: family.rollbackBodyEmotePath,
        removeInstalledAssets: true,
      },
    };
  });
  const activationById = new Map(
    activations.map((activation) => [activation.activationId, activation]),
  );
  const retainedActivationIds = new Set();
  const orderedActivations = runtimeManifest.json.activations.map(
    (activation) => {
      const replacement = activationById.get(activation?.activationId);
      if (!replacement) return activation;
      retainedActivationIds.add(replacement.activationId);
      return replacement;
    },
  );
  for (const activation of activations) {
    if (!retainedActivationIds.has(activation.activationId)) {
      orderedActivations.push(activation);
    }
  }
  const expectedRuntime = {
    schemaVersion: 1,
    activations: orderedActivations,
  };
  const expectedRuntimeBytes = serialize(expectedRuntime);
  if (
    runtimeManifest.sha256 !== definition.runtimeManifest.baselineSha256 &&
    !runtimeManifest.bytes.equals(expectedRuntimeBytes)
  ) {
    throw new Error(
      "Runtime activation manifest drifted from both baseline and installed authority",
    );
  }
  return {
    evidence,
    itemsManifest: { ...itemsManifest, expectedBytes: expectedItemsBytes },
    runtimeManifest: {
      ...runtimeManifest,
      expectedBytes: expectedRuntimeBytes,
    },
    activations,
  };
}

export function installCertifiedPreparationPresentationAssets({
  workspaceRoot,
  assetsRoot,
  definition,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  const activation = buildCertifiedPreparationActivation({
    workspaceRoot,
    assetsRoot,
    definition,
  });
  const destinations = [
    ...activation.evidence.equipment,
    ...activation.evidence.motions,
  ].map((entry) => ({
    ...entry,
    path: safeRelativePath(
      assetsRoot,
      entry.destinationPath,
      "runtime destination",
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
    // Immutable payloads are installed before either manifest. The public
    // activation marker is written last and therefore cannot point at a
    // missing payload or an item path that has not been published yet.
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
        "scripts/certified-preparation-presentation-asset-install.json",
      ),
      "utf8",
    ),
  );
  const result = installCertifiedPreparationPresentationAssets({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    definition,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${result.installed.length} certified preparation assets across ${result.activationCount} activations\n`,
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
