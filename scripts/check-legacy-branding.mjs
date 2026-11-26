#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const repositories = [
  { label: "workspace", directory: workspaceRoot },
  {
    label: "assets",
    directory: path.join(workspaceRoot, "packages/server/world/assets"),
  },
];

const prohibitedTextTerms = [
  ["hyper", "scape"].join(""),
  ["rune", "scape"].join(""),
  ["OS", "RS"].join(""),
];
const prohibitedBinaryTerms = prohibitedTextTerms.slice(0, 2);
const binaryPathspecs = ["*.glb", "*.vrm", "*.wasm"];
const canonicalWordmarkSha256 =
  "aa3b2999ad78bec6985257541eba485b581c22af38867298fd7809367012b753";
const canonicalWordmarks = [
  "packages/client/public/images/hyperia-wordmark.svg",
  "packages/website/public/images/hyperia-wordmark.svg",
];
const retiredWebsiteBrandAssets = [
  "packages/website/public/images/logo.png",
  "packages/website/public/images/wordmark.png",
];

function run(command, args, directory) {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function lines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findTextMatches(repository) {
  const args = ["grep", "-I", "-l", "-i"];
  for (const term of prohibitedTextTerms) {
    args.push("-e", term);
  }
  args.push("--", ".");

  const result = run("git", args, repository.directory);
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `Text scan failed in ${repository.label}: ${result.stderr.trim()}`,
    );
  }

  return lines(result.stdout);
}

function listBinaryFiles(repository) {
  const result = run(
    "git",
    ["ls-files", "-z", "--", ...binaryPathspecs],
    repository.directory,
  );
  if (result.status !== 0) {
    throw new Error(
      `Binary inventory failed in ${repository.label}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout.split("\0").filter(Boolean);
}

function findBinaryMatches(repository, files) {
  if (files.length === 0) return [];

  const args = ["-a", "-l", "-i"];
  for (const term of prohibitedBinaryTerms) {
    args.push("-e", term);
  }
  args.push("--", ...files);

  const result = run("rg", args, repository.directory);
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `Binary scan failed in ${repository.label}: ${result.stderr.trim()}`,
    );
  }

  return lines(result.stdout);
}

function findWorkingTreeMatches(repository) {
  const args = [
    "-a",
    "-l",
    "-i",
    "--hidden",
    "--glob",
    "!**/.git",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/node_modules",
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!**/*.dataless-backup-*",
    "--glob",
    "!**/*.dataless-backup-*/**",
  ];
  for (const term of prohibitedBinaryTerms) {
    args.push("-e", term);
  }
  args.push("--", ".");

  const result = run("rg", args, repository.directory);
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `Working-tree scan failed in ${repository.label}: ${result.stderr.trim()}`,
    );
  }

  return lines(result.stdout);
}

const violations = [];
let scannedBinaryFiles = 0;

for (const relativePath of canonicalWordmarks) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    violations.push({
      repository: "workspace",
      file: relativePath,
      kind: "missing-canonical-wordmark",
    });
    continue;
  }
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(absolutePath))
    .digest("hex");
  if (sha256 !== canonicalWordmarkSha256) {
    violations.push({
      repository: "workspace",
      file: relativePath,
      kind: "unverified-canonical-wordmark",
      expectedSha256: canonicalWordmarkSha256,
      actualSha256: sha256,
    });
  }
}

for (const relativePath of retiredWebsiteBrandAssets) {
  if (fs.existsSync(path.resolve(workspaceRoot, relativePath))) {
    violations.push({
      repository: "workspace",
      file: relativePath,
      kind: "retired-raster-wordmark",
    });
  }
}

for (const repository of repositories) {
  for (const file of findTextMatches(repository)) {
    violations.push({ repository: repository.label, file, kind: "text" });
  }

  const binaryFiles = listBinaryFiles(repository);
  scannedBinaryFiles += binaryFiles.length;
  for (const file of findBinaryMatches(repository, binaryFiles)) {
    violations.push({ repository: repository.label, file, kind: "binary" });
  }
  for (const file of findWorkingTreeMatches(repository)) {
    violations.push({
      repository: repository.label,
      file,
      kind: "working-tree",
    });
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    repositories: repositories.length,
    prohibitedTextTerms: prohibitedTextTerms.length,
    prohibitedBinaryTerms: prohibitedBinaryTerms.length,
    scannedBinaryFiles,
    workingTreeFullTermScan: true,
    canonicalWordmarkSha256,
    canonicalWordmarks: canonicalWordmarks.length,
    retiredWebsiteRasterWordmarks: true,
  }),
);
