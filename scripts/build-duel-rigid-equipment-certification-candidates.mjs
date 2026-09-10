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

import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";
import { validateDuelEquipmentPresentationAuthority } from "./verify-duel-rigid-equipment-certifications.mjs";

const DEFAULT_MANIFEST = "scripts/duel-rigid-equipment-certifications.json";
const DEFAULT_OUTPUT_ROOT =
  "packages/server/world/assets/models/candidates/semantic-grip-certification";
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertExactObject(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the frozen source certificate`);
  }
}

function resolveWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`${label} must remain inside the workspace`);
  }
  return resolved;
}

function resolveCandidateRoot(workspaceRoot, relativePath) {
  const resolved = resolveWorkspacePath(
    workspaceRoot,
    relativePath,
    "Candidate output root",
  );
  const modelsRoot = path.resolve(
    workspaceRoot,
    "packages/server/world/assets/models",
  );
  const segments = path
    .relative(modelsRoot, resolved)
    .split(path.sep)
    .filter(Boolean);
  if (
    !resolved.startsWith(`${modelsRoot}${path.sep}`) ||
    !segments.includes("candidates")
  ) {
    throw new Error(
      "Candidate output root must remain under the model candidates tree",
    );
  }
  return resolved;
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

export function buildDuelRigidEquipmentCertificationCandidates({
  workspaceRoot,
  manifest,
  manifestBytes,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  write = false,
}) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 2) {
    throw new Error("Certification manifest must use schemaVersion 2");
  }
  if (
    typeof manifest.avatarId !== "string" ||
    !SAFE_ID_PATTERN.test(manifest.avatarId) ||
    typeof manifest.legacyAvatarId !== "string" ||
    manifest.legacyAvatarId.length === 0 ||
    !Array.isArray(manifest.certifications) ||
    manifest.certifications.length === 0
  ) {
    throw new Error("Certification manifest identity or equipment is invalid");
  }
  const candidateRoot = resolveCandidateRoot(workspaceRoot, outputRoot);
  const itemIds = new Set();
  const outputs = [];

  for (const [index, certification] of manifest.certifications.entries()) {
    const label = `certifications[${index}]`;
    if (
      !isRecord(certification) ||
      typeof certification.itemId !== "string" ||
      !SAFE_ID_PATTERN.test(certification.itemId) ||
      itemIds.has(certification.itemId) ||
      (certification.slot !== "weapon" && certification.slot !== "shield") ||
      typeof certification.path !== "string" ||
      typeof certification.sha256 !== "string" ||
      !SHA256_PATTERN.test(certification.sha256)
    ) {
      throw new Error(`${label} is not a complete unique certification`);
    }
    itemIds.add(certification.itemId);
    const presentationAuthority = validateDuelEquipmentPresentationAuthority(
      certification,
      label,
    );
    const sourcePath = resolveWorkspacePath(
      workspaceRoot,
      certification.path,
      `${label}.path`,
    );
    const modelsRoot = path.resolve(
      workspaceRoot,
      "packages/server/world/assets/models",
    );
    if (!sourcePath.startsWith(`${modelsRoot}${path.sep}`)) {
      throw new Error(`${label}.path must remain under the model asset tree`);
    }
    const sourceBytes = readFileSync(sourcePath);
    if (sha256(sourceBytes) !== certification.sha256) {
      throw new Error(`${certification.itemId} source SHA-256 drifted`);
    }
    const { output, report } = certifyRigidDuelEquipmentGlb(sourceBytes, {
      itemId: certification.itemId,
      avatarId: manifest.avatarId,
      legacyAvatarId: manifest.legacyAvatarId,
      slot: certification.slot,
      gripContact: presentationAuthority.gripContact,
    });
    if (
      report.structuralDocumentSha256 !== certification.structuralDocumentSha256
    ) {
      throw new Error(
        `${certification.itemId} structural source certificate drifted`,
      );
    }
    assertExactObject(
      report.nonJsonChunksSha256,
      certification.nonJsonChunksSha256,
      `${certification.itemId} non-JSON chunks`,
    );
    const candidatePath = path.join(
      candidateRoot,
      `${certification.itemId}.glb`,
    );
    const candidateMatches =
      existsSync(candidatePath) && readFileSync(candidatePath).equals(output);
    if (write) {
      if (!candidateMatches) writeAtomic(candidatePath, output);
    } else if (!candidateMatches) {
      throw new Error(
        `${certification.itemId} semantic-grip candidate is missing or stale`,
      );
    }
    outputs.push({
      itemId: certification.itemId,
      sourcePath: certification.path,
      candidatePath: path
        .relative(workspaceRoot, candidatePath)
        .split(path.sep)
        .join("/"),
      sourceSha256: certification.sha256,
      candidateSha256: report.outputSha256,
      structuralDocumentSha256: report.structuralDocumentSha256,
      nonJsonChunksSha256: report.nonJsonChunksSha256,
      metadataChanged: report.changed,
      actionSemantic: presentationAuthority.actionSemantic,
      actionAxisSymmetry: presentationAuthority.actionAxisSymmetry,
      gripContact: presentationAuthority.gripContact,
    });
  }

  return {
    ok: true,
    schemaVersion: 1,
    manifestSha256: sha256(
      manifestBytes ?? Buffer.from(JSON.stringify(manifest)),
    ),
    avatarId: manifest.avatarId,
    candidateCount: outputs.length,
    outputRoot,
    outputs,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--check") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (["--manifest", "--output-root", "--report"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (Boolean(options.write) === Boolean(options.check)) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifestPath = resolveWorkspacePath(
    workspaceRoot,
    options.manifest ?? DEFAULT_MANIFEST,
    "Manifest",
  );
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const report = buildDuelRigidEquipmentCertificationCandidates({
    workspaceRoot,
    manifest,
    manifestBytes,
    outputRoot: options["output-root"] ?? DEFAULT_OUTPUT_ROOT,
    write: Boolean(options.write),
  });
  if (options.report) {
    const reportPath = resolveWorkspacePath(
      workspaceRoot,
      options.report,
      "Report",
    );
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
