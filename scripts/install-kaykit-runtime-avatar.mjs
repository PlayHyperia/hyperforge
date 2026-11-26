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

const DESTINATIONS = Object.freeze({
  lod0: "duel-kaykit-knight.vrm",
  lod1: "duel-kaykit-knight_lod1.vrm",
  lod2: "duel-kaykit-knight_lod2.vrm",
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function writeAtomic(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function installKayKitRuntimeAvatar({
  candidateDir,
  destinationDir,
  check,
}) {
  if (typeof check !== "boolean") throw new Error("check must be boolean");
  const reportPath = path.join(candidateDir, "kaykit-knight-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (
    report?.candidateId !== "kaykit-knight" ||
    report?.validator?.errors !== 0 ||
    !Array.isArray(report?.lods) ||
    report.lods.length !== 3
  ) {
    throw new Error("KayKit candidate report is not runtime-installable");
  }

  const installed = [];
  for (const [lodId, destinationName] of Object.entries(DESTINATIONS)) {
    const lod = report.lods.find((candidate) => candidate?.id === lodId);
    if (
      !lod ||
      typeof lod.file !== "string" ||
      path.basename(lod.file) !== lod.file ||
      typeof lod.sha256 !== "string" ||
      !SHA256_PATTERN.test(lod.sha256) ||
      !Number.isSafeInteger(lod.bytes) ||
      lod.bytes <= 0 ||
      lod.validatorErrors !== 0
    ) {
      throw new Error(`KayKit ${lodId} report authority is invalid`);
    }
    const sourcePath = path.join(candidateDir, lod.file);
    const source = readFileSync(sourcePath);
    if (source.length !== lod.bytes || sha256(source) !== lod.sha256) {
      throw new Error(`KayKit ${lodId} candidate bytes drifted`);
    }
    const destinationPath = path.join(destinationDir, destinationName);
    if (check) {
      if (
        !existsSync(destinationPath) ||
        !readFileSync(destinationPath).equals(source)
      ) {
        throw new Error(`KayKit runtime ${lodId} is missing or stale`);
      }
    } else {
      writeAtomic(destinationPath, source);
    }
    installed.push({
      lod: lodId,
      file: destinationName,
      bytes: source.length,
      sha256: lod.sha256,
    });
  }
  return installed;
}

function parseArguments(argv) {
  const options = { check: false, write: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--write") options.write = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check === options.write) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const installed = installKayKitRuntimeAvatar({
    candidateDir: path.join(
      workspaceRoot,
      "artifacts/duel-launch-avatar-bakeoff",
    ),
    destinationDir: path.join(
      workspaceRoot,
      "packages/server/world/assets/avatars/duel-candidates",
    ),
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Installed"} ${installed.length} KayKit runtime avatar LODs\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
