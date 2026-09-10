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

import validator from "gltf-validator";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/u;
const SAFE_ITEM_ID = /^[a-z0-9][a-z0-9_]*$/u;
const SAFE_GOOGLE_FILE_ID = /^[A-Za-z0-9_-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERIFIED_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const EXPECTED_RUNTIME_ITEM_IDS = [
  "fishing_rod",
  "fly_fishing_rod",
  null,
  null,
  null,
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function assertSourceFile(workspaceRoot, source, label, extension) {
  if (
    !isRecord(source) ||
    typeof source.path !== "string" ||
    path.extname(source.path).toLowerCase() !== extension ||
    typeof source.fileId !== "string" ||
    !SAFE_GOOGLE_FILE_ID.test(source.fileId) ||
    !Number.isInteger(source.bytes) ||
    source.bytes <= 0 ||
    typeof source.sha256 !== "string" ||
    !SHA256.test(source.sha256)
  ) {
    throw new Error(`${label} source identity is invalid`);
  }
  const filePath = safeWorkspacePath(
    workspaceRoot,
    source.path,
    `${label}.path`,
  );
  const bytes = readFileSync(filePath);
  if (bytes.length !== source.bytes) {
    throw new Error(`${label} byte count drifted`);
  }
  if (sha256(bytes) !== source.sha256) {
    throw new Error(`${label} SHA-256 drifted`);
  }
  return { filePath, bytes };
}

export function validateFishingRodSourceManifest(manifest, workspaceRoot) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.provider !== "Quaternius" ||
    manifest.pack !== "Animated Cute Fish Pack" ||
    manifest.disposition !== "isolated-preparation-fishing-candidate" ||
    manifest.activationStatus !== "not-activated" ||
    typeof manifest.verifiedAt !== "string" ||
    !VERIFIED_DATE.test(manifest.verifiedAt) ||
    typeof manifest.packPage !== "string" ||
    !manifest.packPage.startsWith("https://quaternius.com/") ||
    typeof manifest.publicFolder !== "string" ||
    !manifest.publicFolder.startsWith("https://drive.google.com/") ||
    !isRecord(manifest.sourcePreview) ||
    typeof manifest.sourcePreview.url !== "string" ||
    !manifest.sourcePreview.url.startsWith("https://quaternius.com/") ||
    !SHA256.test(manifest.sourcePreview.sha256 ?? "") ||
    !Number.isSafeInteger(manifest.sourcePreview.width) ||
    manifest.sourcePreview.width <= 0 ||
    !Number.isSafeInteger(manifest.sourcePreview.height) ||
    manifest.sourcePreview.height <= 0 ||
    !isRecord(manifest.license) ||
    manifest.license.spdx !== "CC0-1.0" ||
    manifest.license.url !==
      "https://creativecommons.org/publicdomain/zero/1.0/" ||
    manifest.license.commercialUse !== true ||
    manifest.license.modification !== true ||
    manifest.license.redistribution !== true ||
    manifest.license.attributionRequired !== false ||
    !Array.isArray(manifest.candidates) ||
    manifest.candidates.length !== 5
  ) {
    throw new Error("Quaternius fishing-rod source manifest is invalid");
  }

  assertSourceFile(
    workspaceRoot,
    {
      path: manifest.license.sourcePath,
      fileId: manifest.license.sourceFileId,
      bytes: manifest.license.sourceBytes,
      sha256: manifest.license.sourceSha256,
    },
    "license",
    ".txt",
  );
  const licenseText = readFileSync(
    safeWorkspacePath(
      workspaceRoot,
      manifest.license.sourcePath,
      "license.sourcePath",
    ),
    "utf8",
  );
  if (
    !licenseText.includes("CC0 1.0 Universal") ||
    !licenseText.includes("Public Domain Dedication")
  ) {
    throw new Error("Quaternius source license text is incomplete");
  }

  const ids = new Set();
  const runtimeItemIds = new Set();
  const sourcePaths = new Set();
  const sourceFileIds = new Set();
  return manifest.candidates.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !SAFE_ID.test(candidate.id) ||
      candidate.id !== `fishing-rod-level-${index + 1}` ||
      (candidate.intendedRuntimeItemId !== null &&
        (typeof candidate.intendedRuntimeItemId !== "string" ||
          !SAFE_ITEM_ID.test(candidate.intendedRuntimeItemId))) ||
      candidate.intendedRuntimeItemId !== EXPECTED_RUNTIME_ITEM_IDS[index]
    ) {
      throw new Error(`Fishing-rod candidate ${index} is invalid`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`Duplicate fishing-rod candidate ID: ${candidate.id}`);
    }
    ids.add(candidate.id);
    if (candidate.intendedRuntimeItemId !== null) {
      if (runtimeItemIds.has(candidate.intendedRuntimeItemId)) {
        throw new Error(
          `Duplicate fishing-rod runtime item: ${candidate.intendedRuntimeItemId}`,
        );
      }
      runtimeItemIds.add(candidate.intendedRuntimeItemId);
    }
    const objSource = assertSourceFile(
      workspaceRoot,
      candidate.obj,
      `${candidate.id}.obj`,
      ".obj",
    );
    const mtlSource = assertSourceFile(
      workspaceRoot,
      candidate.mtl,
      `${candidate.id}.mtl`,
      ".mtl",
    );
    for (const [label, source] of [
      ["obj", candidate.obj],
      ["mtl", candidate.mtl],
    ]) {
      if (sourcePaths.has(source.path)) {
        throw new Error(`Duplicate fishing-rod source path: ${source.path}`);
      }
      if (sourceFileIds.has(source.fileId)) {
        throw new Error(
          `Duplicate fishing-rod source file ID: ${source.fileId}`,
        );
      }
      sourcePaths.add(source.path);
      sourceFileIds.add(source.fileId);
      if (
        !path.basename(source.path).startsWith(`FishingRod_Lvl${index + 1}.`)
      ) {
        throw new Error(
          `${candidate.id}.${label} does not match its authored source level`,
        );
      }
    }
    return {
      ...candidate,
      objSource,
      mtlSource,
    };
  });
}

function standardMaterial(source) {
  const material = new THREE.MeshStandardMaterial({
    name: source.name,
    color: source.color?.clone?.() ?? new THREE.Color(0xffffff),
    emissive: source.emissive?.clone?.() ?? new THREE.Color(0x000000),
    opacity: source.opacity ?? 1,
    transparent: source.transparent ?? false,
    side: source.side,
    metalness: 0.05,
    roughness: 0.72,
  });
  material.alphaTest = source.alphaTest ?? 0;
  return material;
}

function replaceLegacyMaterials(root) {
  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const sourceMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const materials = sourceMaterials.map(standardMaterial);
    object.material = Array.isArray(object.material) ? materials : materials[0];
  });
}

export function inspectFishingRodCandidate(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true);
  const size = bounds.getSize(new THREE.Vector3());
  let meshCount = 0;
  let vertices = 0;
  let triangles = 0;
  let materialCount = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    meshCount += 1;
    const position = object.geometry.attributes.position;
    if (!position || position.itemSize !== 3 || position.count < 3) {
      throw new Error("Fishing-rod mesh has invalid positions");
    }
    vertices += position.count;
    const elementCount = object.geometry.index?.count ?? position.count;
    if (elementCount % 3 !== 0) {
      throw new Error("Fishing-rod mesh is not triangulated");
    }
    triangles += elementCount / 3;
    materialCount += Array.isArray(object.material)
      ? object.material.length
      : object.material
        ? 1
        : 0;
  });
  const finiteBounds = [...bounds.min.toArray(), ...bounds.max.toArray()].every(
    Number.isFinite,
  );
  const longestDimension = Math.max(size.x, size.y, size.z);
  if (
    !finiteBounds ||
    meshCount < 1 ||
    vertices < 3 ||
    triangles < 1 ||
    materialCount < 1 ||
    !Number.isFinite(longestDimension) ||
    longestDimension <= 0
  ) {
    throw new Error("Fishing-rod candidate geometry is invalid");
  }
  return {
    meshCount,
    materialCount,
    vertices,
    triangles,
    bounds: {
      minimum: bounds.min.toArray(),
      maximum: bounds.max.toArray(),
      size: size.toArray(),
    },
    longestDimension,
  };
}

function installFileReaderPolyfill() {
  if (typeof globalThis.FileReader === "function") return;
  globalThis.FileReader = class FileReader {
    result = null;
    error = null;
    onloadend = null;
    onerror = null;

    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((value) => {
          this.result = value;
          this.onloadend?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.(error);
        });
    }
  };
}

async function exportCandidate(candidate) {
  const materials = new MTLLoader().parse(
    candidate.mtlSource.bytes.toString("utf8"),
    "",
  );
  materials.preload();
  const root = new OBJLoader()
    .setMaterials(materials)
    .parse(candidate.objSource.bytes.toString("utf8"));
  root.name = candidate.id;
  replaceLegacyMaterials(root);
  const sourceInspection = inspectFishingRodCandidate(root);
  root.userData.hyperia = {
    schemaVersion: 1,
    sourceCandidateId: candidate.id,
    intendedRuntimeItemId: candidate.intendedRuntimeItemId,
    activationStatus: "not-activated",
    sourceObjSha256: candidate.obj.sha256,
    sourceMtlSha256: candidate.mtl.sha256,
  };
  installFileReaderPolyfill();
  const exported = await new GLTFExporter().parseAsync(root, {
    binary: true,
    trs: true,
    onlyVisible: false,
  });
  const output = Buffer.from(exported);
  const validation = await validator.validateBytes(new Uint8Array(output), {
    uri: `${candidate.id}.glb`,
  });
  const validatorSummary = {
    errors: validation.issues.numErrors,
    warnings: validation.issues.numWarnings,
    infos: validation.issues.numInfos,
    hints: validation.issues.numHints,
  };
  if (Object.values(validatorSummary).some((count) => count !== 0)) {
    throw new Error(
      `${candidate.id} produced validator findings: ${JSON.stringify(validatorSummary)}`,
    );
  }
  return { output, sourceInspection, validator: validatorSummary };
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

export async function buildQuaterniusFishingRodCandidates({
  workspaceRoot,
  manifest,
  outputDirectory,
  check,
}) {
  const candidates = validateFishingRodSourceManifest(manifest, workspaceRoot);
  const outputs = [];
  for (const candidate of candidates) {
    const built = await exportCandidate(candidate);
    const outputRelativePath = path.posix.join(
      path.relative(workspaceRoot, outputDirectory).split(path.sep).join("/"),
      `quaternius-${candidate.id}.glb`,
    );
    const outputPath = safeWorkspacePath(
      workspaceRoot,
      outputRelativePath,
      `${candidate.id}.outputPath`,
    );
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(built.output)
      ) {
        throw new Error(`${candidate.id} generated GLB is stale`);
      }
    } else {
      writeAtomic(outputPath, built.output);
    }
    outputs.push({
      id: candidate.id,
      intendedRuntimeItemId: candidate.intendedRuntimeItemId,
      activationStatus: "not-activated",
      sourceObjSha256: candidate.obj.sha256,
      sourceMtlSha256: candidate.mtl.sha256,
      outputPath: outputRelativePath,
      outputBytes: built.output.length,
      outputSha256: sha256(built.output),
      sourceInspection: built.sourceInspection,
      validator: built.validator,
    });
  }
  return {
    schemaVersion: 1,
    provider: manifest.provider,
    pack: manifest.pack,
    license: manifest.license.spdx,
    activationStatus: "not-activated",
    outputs,
  };
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
  const manifest = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "scripts/quaternius-fishing-rod-sources.json"),
      "utf8",
    ),
  );
  const outputDirectory = path.join(
    workspaceRoot,
    "artifacts/duel-launch-avatar-bakeoff/fishing-kit",
  );
  const report = await buildQuaterniusFishingRodCandidates({
    workspaceRoot,
    manifest,
    outputDirectory,
    check: options.check,
  });
  const reportPath = path.join(
    outputDirectory,
    "quaternius-fishing-rod-candidate-report.json",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Quaternius fishing-rod candidate report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.outputs.length} isolated Quaternius fishing-rod candidates\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
