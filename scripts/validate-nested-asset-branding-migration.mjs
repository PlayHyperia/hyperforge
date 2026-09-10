#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import validator from "gltf-validator";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultAssetsRoot = path.join(
  workspaceRoot,
  "packages/server/world/assets",
);
const defaultReportPath = path.join(
  workspaceRoot,
  "artifacts/duel-launch-branding/nested-asset-branding-migration-report.json",
);

const prohibitedTerms = [
  ["hyper", "scape"].join(""),
  ["rune", "scape"].join(""),
  ["OS", "RS"].join(""),
];
const prohibitedBinaryTerms = prohibitedTerms.slice(0, 2);
const glbExtensions = new Set([".glb", ".vrm"]);
const retiredBrandKeyPattern = new RegExp(["hyper", "scape"].join(""), "giu");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args, directory, encoding = "utf8") {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

function includesTerm(bytes, terms) {
  const lower = Buffer.from(bytes).toString("latin1").toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function parseLfsPointer(bytes) {
  const text = bytes.toString("utf8");
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
    return null;
  }
  const oid = /^oid sha256:([a-f0-9]{64})$/mu.exec(text)?.[1];
  const size = Number(/^size (\d+)$/mu.exec(text)?.[1]);
  if (!oid || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid Git LFS pointer in nested asset history");
  }
  return { oid, size };
}

function resolveGitDirectory(assetsRoot) {
  const gitDirectory = run(
    "git",
    ["rev-parse", "--git-dir"],
    assetsRoot,
  ).trim();
  return path.resolve(assetsRoot, gitDirectory);
}

export function readHeadAsset(assetsRoot, gitDirectory, relativePath) {
  const stored = run("git", ["show", `HEAD:${relativePath}`], assetsRoot, null);
  const bytes = Buffer.from(stored);
  const pointer = parseLfsPointer(bytes);
  if (!pointer) return bytes;

  const objectPath = path.join(
    gitDirectory,
    "lfs/objects",
    pointer.oid.slice(0, 2),
    pointer.oid.slice(2, 4),
    pointer.oid,
  );
  if (!existsSync(objectPath)) {
    throw new Error(
      `${relativePath} requires missing local LFS object ${pointer.oid}; hydrate the nested asset checkout before certification`,
    );
  }
  const object = readFileSync(objectPath);
  if (object.length !== pointer.size || sha256(object) !== pointer.oid) {
    throw new Error(`${relativePath} has a corrupt local LFS base object`);
  }
  return object;
}

export function parseGlb(bytes, label = "asset") {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${label} is not a GLB`);
  }
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (version !== 2 || declaredLength !== bytes.length) {
    throw new Error(`${label} has invalid GLB framing`);
  }

  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`${label} has a truncated GLB chunk header`);
    }
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length || length % 4 !== 0) {
      throw new Error(`${label} has an invalid GLB chunk`);
    }
    chunks.push({ type, bytes: bytes.subarray(start, end) });
    offset = end;
  }
  if (offset !== bytes.length || chunks[0]?.type !== 0x4e4f534a) {
    throw new Error(`${label} has no leading JSON chunk`);
  }
  const jsonText = chunks[0].bytes
    .toString("utf8")
    .replace(/[\u0000\u0020]+$/u, "");
  return { json: JSON.parse(jsonText), chunks };
}

export function compareJsonStructureIgnoringStrings(
  before,
  after,
  label = "$",
) {
  if (typeof before === "string" || typeof after === "string") {
    if (typeof before !== "string" || typeof after !== "string") {
      throw new Error(`${label} changed value type`);
    }
    return;
  }
  if (before === null || after === null) {
    if (before !== after) throw new Error(`${label} changed nullability`);
    return;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      throw new Error(`${label} changed value type`);
    }
    if (before.length !== after.length) {
      throw new Error(`${label} changed array length`);
    }
    before.forEach((value, index) =>
      compareJsonStructureIgnoringStrings(
        value,
        after[index],
        `${label}[${index}]`,
      ),
    );
    return;
  }
  if (typeof before === "object" || typeof after === "object") {
    if (typeof before !== "object" || typeof after !== "object") {
      throw new Error(`${label} changed value type`);
    }
    const canonicalizeKey = (key) =>
      key.replaceAll(retiredBrandKeyPattern, (match) =>
        match === match.toUpperCase()
          ? "HYPERIA"
          : match[0] === match[0].toUpperCase()
            ? "Hyperia"
            : "hyperia",
      );
    const beforeEntries = Object.entries(before).map(([key, value]) => [
      canonicalizeKey(key),
      value,
    ]);
    const afterEntries = Object.entries(after).map(([key, value]) => [
      canonicalizeKey(key),
      value,
    ]);
    const beforeMap = new Map(beforeEntries);
    const afterMap = new Map(afterEntries);
    if (
      beforeMap.size !== beforeEntries.length ||
      afterMap.size !== afterEntries.length
    ) {
      throw new Error(`${label} has colliding canonical branding keys`);
    }
    const beforeKeys = [...beforeMap.keys()].sort();
    const afterKeys = [...afterMap.keys()].sort();
    if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
      throw new Error(`${label} changed object keys`);
    }
    for (const key of beforeKeys) {
      compareJsonStructureIgnoringStrings(
        beforeMap.get(key),
        afterMap.get(key),
        `${label}.${key}`,
      );
    }
    return;
  }
  if (!Object.is(before, after)) {
    throw new Error(`${label} changed non-string value`);
  }
}

function validatorSummary(result) {
  const messages = result.issues?.messages ?? [];
  return {
    errors: result.issues?.numErrors ?? 0,
    warnings: result.issues?.numWarnings ?? 0,
    infos: result.issues?.numInfos ?? 0,
    hints: result.issues?.numHints ?? 0,
    issueCodes: [...new Set(messages.map((message) => message.code))].sort(),
  };
}

function withoutExtras(value) {
  if (Array.isArray(value)) return value.map(withoutExtras);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "extras")
      .map(([key, child]) => [key, withoutExtras(child)]),
  );
}

async function validateGlbMigration(relativePath, beforeBytes, afterBytes) {
  const before = parseGlb(beforeBytes, `${relativePath} at HEAD`);
  const after = parseGlb(afterBytes, `${relativePath} in working tree`);
  compareJsonStructureIgnoringStrings(
    withoutExtras(before.json),
    withoutExtras(after.json),
    relativePath,
  );

  const beforeBinary = before.chunks.slice(1).map((chunk) => ({
    type: chunk.type,
    bytes: chunk.bytes.length,
    sha256: sha256(chunk.bytes),
  }));
  const afterBinary = after.chunks.slice(1).map((chunk) => ({
    type: chunk.type,
    bytes: chunk.bytes.length,
    sha256: sha256(chunk.bytes),
  }));
  if (JSON.stringify(beforeBinary) !== JSON.stringify(afterBinary)) {
    throw new Error(`${relativePath} changed non-JSON GLB payload chunks`);
  }

  const options = {
    uri: path.posix.basename(relativePath),
    format: "glb",
    writeTimestamp: false,
    maxIssues: 1_000,
  };
  const [beforeValidation, afterValidation] = await Promise.all([
    validator.validateBytes(new Uint8Array(beforeBytes), options),
    validator.validateBytes(new Uint8Array(afterBytes), options),
  ]);
  const beforeSummary = validatorSummary(beforeValidation);
  const afterSummary = validatorSummary(afterValidation);
  if (JSON.stringify(beforeSummary) !== JSON.stringify(afterSummary)) {
    throw new Error(`${relativePath} changed its Khronos validator outcome`);
  }

  return {
    binaryChunks: afterBinary,
    validator: afterSummary,
  };
}

function classify(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (glbExtensions.has(extension)) return "glbOrVrm";
  if (extension === ".wasm") return "wasm";
  if (extension === ".json") return "json";
  if (extension === ".js") return "javascript";
  if (extension === ".md") return "markdown";
  return "otherText";
}

function changedByteCount(before, after) {
  if (before.length !== after.length) return null;
  let changed = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) changed += 1;
  }
  return changed;
}

export async function validateNestedAssetBrandingMigration({
  assetsRoot = defaultAssetsRoot,
} = {}) {
  const gitDirectory = resolveGitDirectory(assetsRoot);
  const modified = run(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "-z"],
    assetsRoot,
  )
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const head = run("git", ["rev-parse", "HEAD"], assetsRoot).trim();
  const files = [];
  const counts = {
    glbOrVrm: 0,
    javascript: 0,
    json: 0,
    markdown: 0,
    otherText: 0,
    wasm: 0,
  };
  let unchangedModelPayloads = 0;
  let unchangedModelCoreStructures = 0;
  let unchangedModelValidatorOutcomes = 0;
  let validWasmModules = 0;

  for (const relativePath of modified) {
    const absolutePath = path.join(assetsRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    const before = readHeadAsset(assetsRoot, gitDirectory, relativePath);
    const after = readFileSync(absolutePath);
    if (!includesTerm(before, prohibitedBinaryTerms)) continue;
    if (includesTerm(after, prohibitedBinaryTerms)) {
      throw new Error(`${relativePath} still contains a prohibited game name`);
    }

    const kind = classify(relativePath);
    counts[kind] += 1;
    const file = {
      path: relativePath,
      kind,
      beforeBytes: before.length,
      afterBytes: after.length,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    };

    if (kind === "glbOrVrm") {
      const model = await validateGlbMigration(relativePath, before, after);
      file.model = model;
      unchangedModelPayloads += 1;
      unchangedModelCoreStructures += 1;
      unchangedModelValidatorOutcomes += 1;
    } else if (kind === "json") {
      JSON.parse(after.toString("utf8"));
    } else if (kind === "javascript") {
      run("node", ["--check", absolutePath], assetsRoot);
    } else if (kind === "wasm") {
      if (!WebAssembly.validate(after)) {
        throw new Error(`${relativePath} is not a valid WebAssembly module`);
      }
      if (before.length !== after.length) {
        throw new Error(`${relativePath} changed byte length`);
      }
      file.changedBytes = changedByteCount(before, after);
      validWasmModules += 1;
    }
    files.push(file);
  }

  return {
    schemaVersion: 1,
    ok: true,
    assetsRepository: {
      path: path.relative(workspaceRoot, assetsRoot),
      head,
      trackedModifiedFiles: modified.length,
    },
    prohibitedBinaryTerms: prohibitedBinaryTerms.length,
    migratedFiles: files.length,
    counts,
    integrity: {
      validJsonFiles: counts.json,
      syntaxValidJavascriptFiles: counts.javascript,
      validWasmModules,
      unchangedModelPayloads,
      unchangedModelCoreStructures,
      unchangedModelValidatorOutcomes,
    },
    files,
  };
}

function parseArguments(argv) {
  const values = { mode: "check", report: defaultReportPath };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") values.mode = "write";
    else if (argument === "--check") values.mode = "check";
    else if (argument === "--report") {
      values.report = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await validateNestedAssetBrandingMigration();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.mode === "write") {
    mkdirSync(path.dirname(options.report), { recursive: true });
    writeFileSync(options.report, serialized);
  } else {
    if (!existsSync(options.report)) {
      throw new Error(`Missing branding migration report: ${options.report}`);
    }
    const expected = readFileSync(options.report, "utf8");
    if (expected !== serialized) {
      throw new Error(
        `Nested asset branding migration evidence drifted: ${options.report}`,
      );
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      mode: options.mode,
      migratedFiles: report.migratedFiles,
      counts: report.counts,
      report: path.relative(workspaceRoot, options.report),
      reportSha256: sha256(serialized),
    }),
  );
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
