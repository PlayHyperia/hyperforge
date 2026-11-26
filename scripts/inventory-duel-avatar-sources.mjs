#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import validator from "gltf-validator";

import { parseGlbJson, summarizeVrmDocument } from "./audit-avatar-lods.mjs";
import { DUEL_AVATAR_CANDIDATES } from "./build-duel-avatar-candidates.mjs";

const GENERATED_DIRECTORY = "avatars/duel-candidates/";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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

function toAssetPath(assetsRoot, filePath) {
  return path.relative(assetsRoot, filePath).split(path.sep).join("/");
}

function findVrmFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findVrmFiles(filePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".vrm")
      ? [filePath]
      : [];
  });
}

function displayName(asset) {
  const base = path.posix.basename(asset, path.posix.extname(asset));
  return base
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function sourceCategory(asset) {
  if (asset.startsWith("avatars/")) return "selectable avatar";
  if (asset.startsWith("models/mobs/")) return "mob identity";
  if (asset.startsWith("models/npcs/")) return "NPC identity";
  return "uncategorized identity";
}

function embeddedRightsCompatible(license) {
  return (
    license.commercialUsage === "corporation" &&
    (license.modification === "allowModification" ||
      license.modification === "allowModificationRedistribution") &&
    license.allowRedistribution === true
  );
}

export async function buildDuelAvatarSourceInventory({
  assetsRoot,
  outputPath,
  check = false,
}) {
  const normalizedAssetsRoot = path.resolve(assetsRoot);
  const selectedSources = new Set(
    DUEL_AVATAR_CANDIDATES.map((candidate) => candidate.source),
  );
  const sourceFiles = findVrmFiles(normalizedAssetsRoot)
    .map((filePath) => ({
      filePath,
      asset: toAssetPath(normalizedAssetsRoot, filePath),
    }))
    .filter(({ asset }) => !asset.startsWith(GENERATED_DIRECTORY))
    .sort((a, b) => a.asset.localeCompare(b.asset));

  const candidates = [];
  for (const { filePath, asset } of sourceFiles) {
    const buffer = readFileSync(filePath);
    const document = parseGlbJson(buffer, asset);
    const summary = summarizeVrmDocument(document, buffer);
    const validation = await validator.validateBytes(new Uint8Array(buffer), {
      uri: asset,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 100,
    });
    candidates.push({
      id: asset.replace(/\.vrm$/iu, "").replaceAll("/", "--"),
      name: displayName(asset),
      archetype: `${sourceCategory(asset)}${selectedSources.has(asset) ? " · selected technical candidate" : ""}`,
      source: asset,
      selectedTechnicalCandidate: selectedSources.has(asset),
      sourceSha256: sha256(buffer),
      sourceBytes: buffer.length,
      sourceTriangles: summary.triangles,
      sourceVertices: summary.vertices,
      primitiveCount: summary.primitiveCount,
      skinCount: summary.skinCount,
      jointCounts: summary.jointCounts,
      vrmSpecVersion: summary.vrmSpecVersion,
      missingRequiredBones: summary.missingRequiredBones,
      textureDimensions: summary.textureDimensions,
      unknownTextureDimensionCount: summary.unknownTextureDimensionCount,
      embeddedRightsCompatible: embeddedRightsCompatible(summary.license),
      embeddedRights: summary.license,
      validator: {
        errors: validation.issues.numErrors,
        warnings: validation.issues.numWarnings,
        infos: validation.issues.numInfos,
        messages: validation.issues.messages.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          pointer: issue.pointer,
        })),
      },
      lods: [
        {
          lod: "source",
          asset,
          bytes: buffer.length,
          triangles: summary.triangles,
          vertices: summary.vertices,
        },
      ],
    });
  }

  const inventory = {
    schemaVersion: 1,
    title: "Hyperia available VRM source inventory",
    subtitle:
      "Front-view comparison · source masters only · selection is not commercial-rights clearance",
    purpose:
      "Reproducible technical and visual inventory for choosing duel-avatar source candidates",
    exclusions: [GENERATED_DIRECTORY],
    selectedSourceAssets: [...selectedSources].sort(),
    candidates,
    totals: {
      sources: candidates.length,
      selectedTechnicalCandidates: candidates.filter(
        (candidate) => candidate.selectedTechnicalCandidate,
      ).length,
      bytes: candidates.reduce(
        (total, candidate) => total + candidate.sourceBytes,
        0,
      ),
      validatorErrors: candidates.reduce(
        (total, candidate) => total + candidate.validator.errors,
        0,
      ),
      validatorErrorCodes: candidates
        .flatMap((candidate) => candidate.validator.messages)
        .filter((issue) => issue.severity === 0)
        .reduce((counts, issue) => {
          counts[issue.code] = (counts[issue.code] ?? 0) + 1;
          return counts;
        }, {}),
      missingRequiredBones: candidates.reduce(
        (total, candidate) => total + candidate.missingRequiredBones.length,
        0,
      ),
      embeddedRightsCompatible: candidates.filter(
        (candidate) => candidate.embeddedRightsCompatible,
      ).length,
    },
  };

  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (check) {
    if (!existsSync(outputPath)) {
      throw new Error(`VRM source inventory is missing: ${outputPath}`);
    }
    if (readFileSync(outputPath, "utf8") !== serialized) {
      throw new Error(`VRM source inventory is stale: ${outputPath}`);
    }
  } else {
    writeAtomic(outputPath, serialized);
  }
  return inventory;
}

function parseCliArgs(argv) {
  const options = { check: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
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
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const outputPath = path.join(
    workspaceRoot,
    "artifacts/duel-avatar-candidates/source-inventory.json",
  );
  const inventory = await buildDuelAvatarSourceInventory({
    assetsRoot,
    outputPath,
    check: options.check,
  });
  console.log(
    `${options.check ? "Verified" : "Inventoried"} ${inventory.totals.sources} VRM sources: ${inventory.totals.validatorErrors} validator errors, ${inventory.totals.missingRequiredBones} missing required bones, ${inventory.totals.embeddedRightsCompatible} embedded launch-compatible rights records.`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
