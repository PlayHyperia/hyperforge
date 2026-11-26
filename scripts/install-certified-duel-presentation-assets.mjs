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
const RUNTIME_MANIFEST_PATH = "manifests/duel-presentation-assets.json";

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

function readLockedFile(workspaceRoot, relativePath, expectedSha256, label) {
  if (!SHA256.test(expectedSha256)) {
    throw new Error(`${label} has an invalid SHA-256 lock`);
  }
  const filePath = safeRelativePath(workspaceRoot, relativePath, label);
  const bytes = readFileSync(filePath);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`${label} drifted from its SHA-256 lock`);
  }
  return { bytes, filePath };
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

function validateAssetPair(definition, workspaceRoot, assetsRoot) {
  if (
    !isRecord(definition) ||
    definition.schemaVersion !== 1 ||
    !SAFE_ID.test(definition.activationId) ||
    !SAFE_ID.test(definition.avatarId) ||
    !SAFE_ID.test(definition.itemId) ||
    definition.slot !== "gatheringtool" ||
    !SAFE_ID.test(definition.bodyEmoteKey) ||
    !isRecord(definition.equipment) ||
    !isRecord(definition.motion) ||
    !isRecord(definition.rollback)
  ) {
    throw new Error("Certified presentation activation definition is invalid");
  }
  for (const [label, asset] of [
    ["equipment", definition.equipment],
    ["motion", definition.motion],
  ]) {
    if (
      typeof asset.assetUrl !== "string" ||
      asset.assetUrl !== `${ASSET_PREFIX}${asset.destinationPath}` ||
      !SHA256.test(asset.sourceSha256)
    ) {
      throw new Error(`${label} runtime destination authority is invalid`);
    }
    safeRelativePath(
      assetsRoot,
      asset.destinationPath,
      `${label}.destinationPath`,
    );
  }
  if (
    definition.motion.durationSeconds !== 1.2 ||
    definition.motion.strikeSeconds !== 0.6 ||
    definition.motion.recoverySeconds !== 0.6 ||
    definition.rollback.equippedModelPath !== null ||
    !isRecord(definition.rollback.equippedModelPathsByAvatar) ||
    Object.keys(definition.rollback.equippedModelPathsByAvatar).length !== 0 ||
    definition.rollback.bodyEmotePath !== null ||
    definition.rollback.removeInstalledAssets !== true
  ) {
    throw new Error(
      "Certified presentation rollback/timing authority is invalid",
    );
  }

  const equipment = readLockedFile(
    workspaceRoot,
    definition.equipment.sourcePath,
    definition.equipment.sourceSha256,
    "equipment source",
  );
  const motion = readLockedFile(
    workspaceRoot,
    definition.motion.sourcePath,
    definition.motion.sourceSha256,
    "motion source",
  );
  const fitReportFile = readLockedFile(
    workspaceRoot,
    definition.equipment.fitReportPath,
    definition.equipment.fitReportSha256,
    "equipment fit report",
  );
  const candidateReportFile = readLockedFile(
    workspaceRoot,
    definition.motion.candidateReportPath,
    definition.motion.candidateReportSha256,
    "motion candidate report",
  );
  const browserReportFile = readLockedFile(
    workspaceRoot,
    definition.motion.browserReportPath,
    definition.motion.browserReportSha256,
    "motion browser report",
  );
  readLockedFile(
    workspaceRoot,
    definition.motion.contactSheetPath,
    definition.motion.contactSheetSha256,
    "motion contact sheet",
  );

  const fitReport = JSON.parse(fitReportFile.bytes.toString("utf8"));
  const fit = fitReport.outputs?.find(
    (output) => output?.itemId === definition.itemId,
  );
  if (
    fitReport.avatar?.id !== definition.avatarId ||
    fitReport.browserVerification?.loaded !== true ||
    fitReport.browserVerification?.hasErrorOverlay !== false ||
    !fit ||
    fit.outputPath !== definition.equipment.sourcePath ||
    fit.outputSha256 !== definition.equipment.sourceSha256 ||
    fit.validator?.errors !== 0 ||
    fit.validator?.warnings !== 0 ||
    fit.validator?.infos !== 0 ||
    fit.validator?.hints !== 0
  ) {
    throw new Error("Equipment fit report does not certify the locked output");
  }

  const candidateReport = JSON.parse(
    candidateReportFile.bytes.toString("utf8"),
  );
  const candidate = candidateReport.outputs?.find(
    (output) => output?.path === definition.motion.sourcePath,
  );
  if (
    candidateReport.provenance?.license !== "CC0-1.0" ||
    !candidate ||
    candidate.sha256 !== definition.motion.sourceSha256 ||
    Math.abs(candidate.durationSeconds - definition.motion.durationSeconds) >
      0.000001 ||
    candidate.loopSeamExact !== true ||
    candidate.validator?.errors !== 0 ||
    candidate.validator?.warnings !== 0 ||
    candidate.validator?.hints !== 0 ||
    !Array.isArray(candidate.validator?.infoCodes) ||
    candidate.validator.infoCodes.some((code) => code !== "NODE_EMPTY")
  ) {
    throw new Error(
      "Motion candidate report does not certify the locked output",
    );
  }

  const browserReport = JSON.parse(browserReportFile.bytes.toString("utf8"));
  if (
    browserReport.avatarAsset !==
      "packages/server/world/assets/avatars/duel-candidates/duel-steve.vrm" ||
    !Array.isArray(browserReport.motions) ||
    browserReport.motions.length !== 11 ||
    !Array.isArray(browserReport.failures) ||
    browserReport.failures.length !== 0 ||
    browserReport.motions.some(
      (sample) =>
        sample.asset !== definition.motion.sourcePath ||
        !Array.isArray(sample.failures) ||
        sample.failures.length !== 0,
    )
  ) {
    throw new Error(
      "Motion browser report does not certify every locked phase",
    );
  }
  return { equipment: equipment.bytes, motion: motion.bytes };
}

export function buildCertifiedDuelPresentationRuntimeManifest(definition) {
  return {
    schemaVersion: 1,
    activations: [
      {
        activationId: definition.activationId,
        state: "active",
        avatarId: definition.avatarId,
        itemId: definition.itemId,
        slot: definition.slot,
        bodyEmoteKey: definition.bodyEmoteKey,
        equipment: {
          assetUrl: definition.equipment.assetUrl,
          sha256: definition.equipment.sourceSha256,
        },
        motion: {
          assetUrl: definition.motion.assetUrl,
          sha256: definition.motion.sourceSha256,
          durationSeconds: definition.motion.durationSeconds,
          strikeSeconds: definition.motion.strikeSeconds,
          recoverySeconds: definition.motion.recoverySeconds,
        },
        rollback: definition.rollback,
      },
    ],
  };
}

function mergeCertifiedActivationWithRuntimeManifest(
  definition,
  runtimeManifestPath,
) {
  const certified = buildCertifiedDuelPresentationRuntimeManifest(definition);
  if (!existsSync(runtimeManifestPath)) return certified;
  const current = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
  if (current?.schemaVersion !== 1 || !Array.isArray(current.activations)) {
    throw new Error(`${RUNTIME_MANIFEST_PATH} is invalid`);
  }
  const matching = current.activations.filter(
    (activation) => activation?.activationId === definition.activationId,
  );
  if (matching.length > 1) {
    throw new Error(`${RUNTIME_MANIFEST_PATH} contains duplicate activation`);
  }
  const nextActivation = certified.activations[0];
  return {
    schemaVersion: 1,
    activations:
      matching.length === 1
        ? current.activations.map((activation) =>
            activation?.activationId === definition.activationId
              ? nextActivation
              : activation,
          )
        : [nextActivation, ...current.activations],
  };
}

export function installCertifiedDuelPresentationAssets({
  workspaceRoot,
  assetsRoot,
  definition,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  const sources = validateAssetPair(definition, workspaceRoot, assetsRoot);
  const destinations = [
    [definition.equipment.destinationPath, sources.equipment],
    [definition.motion.destinationPath, sources.motion],
  ].map(([relativePath, bytes]) => ({
    relativePath,
    path: safeRelativePath(assetsRoot, relativePath, "runtime destination"),
    bytes,
  }));
  const runtimeManifestPath = safeRelativePath(
    assetsRoot,
    RUNTIME_MANIFEST_PATH,
    "runtime manifest",
  );
  const runtimeManifest = `${JSON.stringify(
    mergeCertifiedActivationWithRuntimeManifest(
      definition,
      runtimeManifestPath,
    ),
    null,
    2,
  )}\n`;

  if (check) {
    for (const destination of destinations) {
      if (
        !existsSync(destination.path) ||
        !readFileSync(destination.path).equals(destination.bytes)
      ) {
        throw new Error(`${destination.relativePath} is missing or stale`);
      }
    }
    if (
      !existsSync(runtimeManifestPath) ||
      readFileSync(runtimeManifestPath, "utf8") !== runtimeManifest
    ) {
      throw new Error(`${RUNTIME_MANIFEST_PATH} is missing or stale`);
    }
  } else {
    // Install immutable payloads first. The activation manifest is the commit
    // marker and is written last, so a partial install cannot look complete.
    for (const destination of destinations) {
      writeAtomic(destination.path, destination.bytes);
    }
    writeAtomic(runtimeManifestPath, runtimeManifest);
  }
  return {
    activationId: definition.activationId,
    manifestPath: RUNTIME_MANIFEST_PATH,
    installed: destinations.map((destination) => ({
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
        "scripts/certified-duel-presentation-asset-install.json",
      ),
      "utf8",
    ),
  );
  const result = installCertifiedDuelPresentationAssets({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    definition,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${result.installed.length} certified duel-presentation assets for ${result.activationId}\n`,
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
