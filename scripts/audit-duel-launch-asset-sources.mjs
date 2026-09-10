#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import validator from "gltf-validator";

import { parseGlbJson, summarizeVrmDocument } from "./audit-avatar-lods.mjs";
import { readZipArchive } from "./lib/read-zip-archive.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function primitiveTriangleCount(primitive, accessors) {
  if ((primitive.mode ?? 4) !== 4) return null;
  const accessorIndex = Number.isInteger(primitive.indices)
    ? primitive.indices
    : primitive.attributes?.POSITION;
  const count = accessors?.[accessorIndex]?.count;
  return Number.isInteger(count) && count >= 0 ? Math.floor(count / 3) : null;
}

function summarizeGltfJson(document) {
  const primitives = (document.meshes ?? []).flatMap(
    (mesh) => mesh.primitives ?? [],
  );
  const positionAccessors = new Set(
    primitives
      .map((primitive) => primitive.attributes?.POSITION)
      .filter(Number.isInteger),
  );
  return {
    triangles: primitives.reduce(
      (total, primitive) =>
        total + (primitiveTriangleCount(primitive, document.accessors) ?? 0),
      0,
    ),
    vertices: [...positionAccessors].reduce(
      (total, accessorIndex) =>
        total + (document.accessors?.[accessorIndex]?.count ?? 0),
      0,
    ),
    primitiveCount: primitives.length,
    skinCount: document.skins?.length ?? 0,
    jointCount: Math.max(
      0,
      ...(document.skins ?? []).map((skin) => skin.joints?.length ?? 0),
    ),
    animationCount: document.animations?.length ?? 0,
    animationNames: (document.animations ?? []).map(
      (animation, index) => animation.name ?? `animation-${index}`,
    ),
    textureCount: document.images?.length ?? 0,
  };
}

function archiveResourceEntry(modelEntry, uri) {
  if (
    typeof uri !== "string" ||
    !uri ||
    /^(?:data|https?):/iu.test(uri) ||
    uri.startsWith("/") ||
    uri.includes("\\")
  ) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.startsWith("/")) return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(modelEntry), decoded),
  );
  if (resolved === ".." || resolved.startsWith("../")) return null;
  return resolved;
}

function missingGltfResources(document, modelEntry, entries) {
  const uris = [
    ...(document.buffers ?? []).map((buffer) => buffer.uri),
    ...(document.images ?? []).map((image) => image.uri),
  ].filter((uri) => typeof uri === "string" && !uri.startsWith("data:"));
  return uniqueSorted(
    uris.flatMap((uri) => {
      const entry = archiveResourceEntry(modelEntry, uri);
      return entry && !entries.has(entry) ? [path.posix.basename(uri)] : [];
    }),
  );
}

function auditInspectionRepairs(
  inspection,
  document,
  archive,
  packId,
  failures,
) {
  const reports = [];
  for (const repair of inspection.repairs ?? []) {
    const label = `${packId}:${inspection.entry}:${repair.missingUri}`;
    const matchingImages = (document.images ?? []).filter(
      (image) =>
        image.name === repair.imageName && image.uri === repair.missingUri,
    );
    if (matchingImages.length !== 1) {
      failures.push(
        `${label} expected exactly one locked broken image reference, received ${matchingImages.length}`,
      );
    }
    const missingEntry = archiveResourceEntry(
      inspection.entry,
      repair.missingUri,
    );
    if (missingEntry && archive.entries.has(missingEntry)) {
      failures.push(`${label} is no longer missing and must be re-audited`);
    }
    const resolvedReplacement = archiveResourceEntry(
      inspection.entry,
      repair.replacementUri,
    );
    if (resolvedReplacement !== repair.replacementEntry) {
      failures.push(`${label} replacement path does not resolve to its lock`);
    }
    const replacement = archive.entries.get(repair.replacementEntry);
    const replacementBytes = replacement?.directory
      ? null
      : (replacement?.data.length ?? null);
    const replacementSha256 = replacement?.directory
      ? null
      : replacement
        ? sha256(replacement.data)
        : null;
    if (
      replacementBytes !== repair.replacementBytes ||
      replacementSha256 !== repair.replacementSha256
    ) {
      failures.push(`${label} replacement bytes do not match their lock`);
    }
    reports.push({
      imageName: repair.imageName,
      missingUri: repair.missingUri,
      replacementUri: repair.replacementUri,
      replacementEntry: repair.replacementEntry,
      replacementBytes,
      replacementSha256,
    });
  }
  return reports;
}

function compareExpected(actual, expected, label, failures) {
  for (const [key, expectedValue] of Object.entries(expected ?? {})) {
    const actualValue = actual[key];
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      failures.push(
        `${label}.${key} expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

function validateLock(lock) {
  if (
    !isRecord(lock) ||
    lock.schemaVersion !== 1 ||
    !Array.isArray(lock.packs)
  ) {
    throw new Error(
      "Asset-source lock must use schemaVersion 1 with a packs array",
    );
  }
  const ids = new Set();
  for (const pack of lock.packs) {
    if (!isRecord(pack) || typeof pack.id !== "string" || !pack.id) {
      throw new Error("Every asset-source pack requires a stable id");
    }
    if (ids.has(pack.id))
      throw new Error(`Duplicate asset-source id: ${pack.id}`);
    ids.add(pack.id);
    for (const [label, url] of [
      ["sourcePage", pack.sourcePage],
      ["purchasePage", pack.purchasePage],
      ["license.url", pack.license?.url],
      ["nonAiEvidence.url", pack.nonAiEvidence?.url],
    ]) {
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error(`${pack.id}.${label} must be an HTTPS URL`);
      }
    }
    if (pack.nonAiEvidence?.statement !== "No generative AI was used") {
      throw new Error(`${pack.id} lacks the exact non-AI evidence statement`);
    }
    if (
      pack.license?.spdx !== "CC0-1.0" ||
      pack.license?.commercialUse !== true ||
      pack.license?.modification !== true ||
      pack.license?.redistribution !== true ||
      pack.license?.attributionRequired !== false
    ) {
      throw new Error(`${pack.id} is not locked to the required CC0 rights`);
    }
    if (
      typeof pack.archive?.file !== "string" ||
      path.basename(pack.archive.file) !== pack.archive.file ||
      !SHA256_PATTERN.test(pack.archive?.sha256 ?? "") ||
      !Number.isSafeInteger(pack.archive?.bytes) ||
      !Number.isSafeInteger(pack.archive?.entries)
    ) {
      throw new Error(`${pack.id} has an invalid archive lock`);
    }
    if (!SHA256_PATTERN.test(pack.license?.embeddedSha256 ?? "")) {
      throw new Error(`${pack.id} has an invalid embedded license lock`);
    }
    if (!Array.isArray(pack.inspections) || pack.inspections.length === 0) {
      throw new Error(`${pack.id} requires at least one technical inspection`);
    }
    for (const inspection of pack.inspections) {
      if (
        !isRecord(inspection) ||
        typeof inspection.entry !== "string" ||
        !inspection.entry ||
        (inspection.format !== "glb" && inspection.format !== "gltf") ||
        !SHA256_PATTERN.test(inspection.sha256 ?? "") ||
        !isRecord(inspection.expected)
      ) {
        throw new Error(`${pack.id} has an invalid technical inspection lock`);
      }
      const missingResources = inspection.expected.missingResources;
      if (
        (!Array.isArray(missingResources) || missingResources.length === 0) &&
        inspection.expected.validatorErrors !== 0
      ) {
        throw new Error(
          `${pack.id}:${inspection.entry} must lock zero validator errors`,
        );
      }
      for (const repair of inspection.repairs ?? []) {
        if (
          !isRecord(repair) ||
          typeof repair.imageName !== "string" ||
          typeof repair.missingUri !== "string" ||
          typeof repair.replacementUri !== "string" ||
          typeof repair.replacementEntry !== "string" ||
          !Number.isSafeInteger(repair.replacementBytes) ||
          repair.replacementBytes <= 0 ||
          !SHA256_PATTERN.test(repair.replacementSha256 ?? "") ||
          !missingResources?.includes(path.posix.basename(repair.missingUri))
        ) {
          throw new Error(`${pack.id} has an invalid source-repair lock`);
        }
      }
    }
  }
}

async function inspectEntry(inspection, archive, packId, failures) {
  const entry = archive.entries.get(inspection.entry);
  if (!entry || entry.directory) {
    failures.push(`${packId} is missing inspection entry ${inspection.entry}`);
    return null;
  }
  const digest = sha256(entry.data);
  if (digest !== inspection.sha256) {
    failures.push(
      `${packId} inspection digest drift for ${inspection.entry}: ${digest}`,
    );
    return null;
  }

  let document;
  let summary;
  let repairs = [];
  if (inspection.format === "glb") {
    document = parseGlbJson(entry.data, inspection.entry);
    const vrmSummary = summarizeVrmDocument(document, entry.data);
    const validation = await validator.validateBytes(
      new Uint8Array(entry.data),
      {
        uri: path.posix.basename(inspection.entry),
        format: "glb",
        writeTimestamp: false,
        maxIssues: 1_000,
      },
    );
    summary = {
      ...summarizeGltfJson(document),
      rigFingerprint: vrmSummary.rigFingerprint,
      validatorErrors: validation.issues.numErrors,
      validatorWarnings: validation.issues.numWarnings,
      validatorWarningCodes: uniqueSorted(
        validation.issues.messages
          .filter((issue) => issue.severity === 1)
          .map((issue) => issue.code),
      ),
      missingResources: [],
    };
  } else if (inspection.format === "gltf") {
    document = JSON.parse(entry.data.toString("utf8"));
    repairs = auditInspectionRepairs(
      inspection,
      document,
      archive,
      packId,
      failures,
    );
    const missingResources = missingGltfResources(
      document,
      inspection.entry,
      archive.entries,
    );
    let validation = null;
    if (missingResources.length === 0) {
      validation = await validator.validateString(entry.data.toString("utf8"), {
        uri: path.posix.basename(inspection.entry),
        writeTimestamp: false,
        maxIssues: 1_000,
        externalResourceFunction: async (uri) => {
          const resourceEntry = archiveResourceEntry(inspection.entry, uri);
          const resource = resourceEntry
            ? archive.entries.get(resourceEntry)
            : null;
          if (!resource || resource.directory) {
            throw new Error(`missing external resource ${uri}`);
          }
          return new Uint8Array(resource.data);
        },
      });
    }
    summary = {
      ...summarizeGltfJson(document),
      rigFingerprint: null,
      validatorErrors: validation?.issues.numErrors ?? null,
      validatorWarnings: validation?.issues.numWarnings ?? null,
      validatorWarningCodes: validation
        ? uniqueSorted(
            validation.issues.messages
              .filter((issue) => issue.severity === 1)
              .map((issue) => issue.code),
          )
        : [],
      missingResources,
    };
  } else {
    failures.push(
      `${packId} has unsupported inspection format ${inspection.format}`,
    );
    return null;
  }
  compareExpected(
    summary,
    inspection.expected,
    `${packId}:${inspection.entry}`,
    failures,
  );
  return { entry: inspection.entry, sha256: digest, repairs, ...summary };
}

export async function auditDuelLaunchAssetSources({ lock, downloadsDir }) {
  validateLock(lock);
  const failures = [];
  const packReports = [];
  for (const pack of lock.packs) {
    const archivePath = path.resolve(downloadsDir, pack.archive.file);
    const packFailures = [];
    const report = {
      id: pack.id,
      kind: pack.kind,
      disposition: pack.disposition,
      sourcePage: pack.sourcePage,
      nonAiEvidence: pack.nonAiEvidence,
      license: {
        spdx: pack.license.spdx,
        commercialUse: pack.license.commercialUse,
        modification: pack.license.modification,
        redistribution: pack.license.redistribution,
        attributionRequired: pack.license.attributionRequired,
      },
      archive: {
        file: pack.archive.file,
        version: pack.archive.version,
        bytes: null,
        sha256: null,
        entries: null,
      },
      inspections: [],
      aggregate: null,
      passed: false,
    };
    try {
      if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
        throw new Error(`missing locked archive ${archivePath}`);
      }
      const archiveBytes = readFileSync(archivePath);
      report.archive.bytes = archiveBytes.length;
      report.archive.sha256 = sha256(archiveBytes);
      if (report.archive.bytes !== pack.archive.bytes) {
        packFailures.push(
          `${pack.id} archive bytes expected ${pack.archive.bytes}, received ${report.archive.bytes}`,
        );
      }
      if (report.archive.sha256 !== pack.archive.sha256) {
        packFailures.push(`${pack.id} archive SHA-256 drift`);
      }
      const archive = readZipArchive(archiveBytes, pack.id);
      report.archive.entries = archive.entryCount;
      if (archive.entryCount !== pack.archive.entries) {
        packFailures.push(
          `${pack.id} archive entries expected ${pack.archive.entries}, received ${archive.entryCount}`,
        );
      }
      for (const requiredEntry of pack.requiredEntries ?? []) {
        if (!archive.entries.has(requiredEntry)) {
          packFailures.push(
            `${pack.id} is missing required entry ${requiredEntry}`,
          );
        }
      }
      const licenseEntry = archive.entries.get(pack.license.embeddedEntry);
      if (!licenseEntry || licenseEntry.directory) {
        packFailures.push(`${pack.id} is missing its embedded license`);
      } else {
        if (sha256(licenseEntry.data) !== pack.license.embeddedSha256) {
          packFailures.push(`${pack.id} embedded license SHA-256 drift`);
        }
        const text = licenseEntry.data.toString("utf8");
        for (const requiredText of pack.license.requiredText ?? []) {
          if (!text.includes(requiredText)) {
            packFailures.push(
              `${pack.id} embedded license is missing ${JSON.stringify(requiredText)}`,
            );
          }
        }
      }

      const inspected = [];
      for (const inspection of pack.inspections) {
        const result = await inspectEntry(
          inspection,
          archive,
          pack.id,
          packFailures,
        );
        if (result) inspected.push(result);
      }
      report.inspections = inspected;
      const animationNames = inspected.flatMap(
        (inspection) => inspection.animationNames,
      );
      const fingerprints = uniqueSorted(
        inspected
          .map((inspection) => inspection.rigFingerprint)
          .filter(Boolean),
      );
      report.aggregate = {
        animationCount: animationNames.length,
        uniqueAnimationCount: new Set(animationNames).size,
        rigFingerprint: fingerprints.length === 1 ? fingerprints[0] : null,
        rigFingerprintCount: fingerprints.length,
        rigFingerprints: fingerprints,
      };
      compareExpected(
        report.aggregate,
        pack.expectedAggregate,
        `${pack.id}.aggregate`,
        packFailures,
      );
      const clipNames = new Set(animationNames);
      for (const requiredClip of pack.requiredClips ?? []) {
        if (!clipNames.has(requiredClip)) {
          packFailures.push(
            `${pack.id} is missing required clip ${requiredClip}`,
          );
        }
      }
    } catch (error) {
      packFailures.push(
        `${pack.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    report.passed = packFailures.length === 0;
    packReports.push(report);
    failures.push(...packFailures);
  }
  return {
    schemaVersion: 1,
    passed: failures.length === 0,
    lockSha256: sha256(Buffer.from(`${JSON.stringify(lock, null, 2)}\n`)),
    downloadsDir: path.resolve(downloadsDir),
    packs: packReports,
    totals: {
      packs: packReports.length,
      passedPacks: packReports.filter((pack) => pack.passed).length,
      lockedBytes: packReports.reduce(
        (total, pack) => total + (pack.archive.bytes ?? 0),
        0,
      ),
      inspectedFiles: packReports.reduce(
        (total, pack) => total + pack.inspections.length,
        0,
      ),
    },
    failures,
  };
}

function parseCliArgs(argv) {
  const options = { downloadsDir: null, lockPath: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--downloads-dir") {
      options.downloadsDir = argv[++index];
    } else if (argument === "--lock") options.lockPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const lockPath = path.resolve(
    options.lockPath ??
      path.join(workspaceRoot, "scripts/duel-launch-asset-sources.json"),
  );
  const downloadsDir = path.resolve(
    options.downloadsDir ??
      process.env.HYPERIA_DUEL_ASSET_DOWNLOADS_DIR ??
      path.join(workspaceRoot, "artifacts/duel-launch-assets/downloads"),
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const report = await auditDuelLaunchAssetSources({ lock, downloadsDir });
  if (options.json || !report.passed) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Duel launch source audit passed: ${report.totals.passedPacks}/${report.totals.packs} exact archives, ${report.totals.inspectedFiles} inspected files, ${report.totals.lockedBytes} locked bytes.`,
    );
  }
  if (!report.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
