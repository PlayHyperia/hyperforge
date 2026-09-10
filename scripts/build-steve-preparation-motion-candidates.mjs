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

import { NodeIO } from "@gltf-transform/core";
import validator from "gltf-validator";

import { parseGlbJson } from "./audit-avatar-lods.mjs";
import { selectGlbAnimation } from "./build-duel-launch-avatar-candidates.mjs";
import { readZipArchive } from "./lib/read-zip-archive.mjs";

const PACK_ID = "kaykit-character-animations-1.1-free";
const SOURCE_ENTRY =
  "KayKit_Character_Animations_1.1/Animations/gltf/Rig_Medium/Rig_Medium_Tools.glb";
const OUTPUT_DIRECTORY =
  "artifacts/duel-launch-avatar-bakeoff/motions/steve-preparation";
const REPORT_PATH =
  "artifacts/duel-launch-avatar-bakeoff/steve-preparation-motion-candidate-report.json";

export const STEVE_PREPARATION_MOTIONS = Object.freeze([
  {
    id: "woodcutting",
    clip: "Chop",
    outputClip: "Hyperia_Steve_Woodcutting",
    outputFile: "steve-woodcutting.glb",
  },
  {
    id: "mining",
    clip: "Pickaxe",
    outputClip: "Hyperia_Steve_Mining",
    outputFile: "steve-mining.glb",
  },
  {
    id: "fishing",
    clip: "Fishing_Cast",
    outputClip: "Hyperia_Steve_Fishing_Cast",
    outputFile: "steve-fishing-cast.glb",
  },
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function animationDurationSeconds(document, animation) {
  const duration = Math.max(
    0,
    ...(animation.samplers ?? []).map(
      (sampler) => document.accessors?.[sampler.input]?.max?.[0] ?? 0,
    ),
  );
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${animation.name ?? "animation"} has no valid duration`);
  }
  return duration;
}

function assertExactLoopSeam(animation) {
  let sampled = 0;
  for (const sampler of animation.listSamplers()) {
    const output = sampler.getOutput();
    const values = output?.getArray();
    const frameCount = output?.getCount() ?? 0;
    const elementSize = output?.getElementSize() ?? 0;
    if (!values || frameCount < 2 || elementSize < 1) continue;
    sampled += 1;
    for (let component = 0; component < elementSize; component += 1) {
      if (
        Math.abs(
          values[component] -
            values[(frameCount - 1) * elementSize + component],
        ) > 1e-6
      ) {
        throw new Error(
          `${animation.getName()} does not have an exact loop seam`,
        );
      }
    }
  }
  if (sampled < 1) {
    throw new Error(`${animation.getName()} has no sampled animation channels`);
  }
}

async function sanitizeSelectedMotion(bytes, outputClip) {
  const io = new NodeIO();
  const document = await io.readBinary(new Uint8Array(bytes));
  const root = document.getRoot();
  const animations = root.listAnimations();
  if (animations.length !== 1) {
    throw new Error(`${outputClip} must contain exactly one animation`);
  }
  const animation = animations[0];
  animation.setName(outputClip);
  assertExactLoopSeam(animation);

  const retainedAccessors = new Set();
  const animatedNodes = new Set();
  for (const sampler of animation.listSamplers()) {
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (input) retainedAccessors.add(input);
    if (output) retainedAccessors.add(output);
  }
  for (const channel of animation.listChannels()) {
    const target = channel.getTargetNode();
    if (target) animatedNodes.add(target);
  }
  for (const node of root.listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const property of [
    ...root.listMeshes(),
    ...root.listSkins(),
    ...root.listMaterials(),
    ...root.listTextures(),
  ]) {
    property.dispose();
  }
  for (const accessor of root.listAccessors()) {
    if (!retainedAccessors.has(accessor)) accessor.dispose();
  }
  for (const node of root.listNodes()) {
    if (!animatedNodes.has(node) && node.listChildren().length === 0) {
      node.dispose();
    }
  }
  return Buffer.from(await io.writeBinary(document));
}

function loadLockedToolsSource(workspaceRoot) {
  const lock = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "scripts/duel-launch-asset-sources.json"),
      "utf8",
    ),
  );
  const pack = lock.packs?.find((candidate) => candidate.id === PACK_ID);
  if (
    !pack ||
    pack.license?.spdx !== "CC0-1.0" ||
    typeof pack.archive?.file !== "string" ||
    typeof pack.archive?.bytes !== "number" ||
    typeof pack.archive?.sha256 !== "string"
  ) {
    throw new Error(`Source lock is missing valid ${PACK_ID} authority`);
  }
  const archivePath = path.join(
    workspaceRoot,
    "artifacts/duel-launch-assets/downloads",
    path.basename(pack.archive.file),
  );
  const archiveBytes = readFileSync(archivePath);
  if (
    archiveBytes.length !== pack.archive.bytes ||
    sha256(archiveBytes) !== pack.archive.sha256
  ) {
    throw new Error(`${PACK_ID} archive drifted from its immutable lock`);
  }
  const inspection = pack.inspections?.find(
    (candidate) => candidate.entry === SOURCE_ENTRY,
  );
  if (!inspection || typeof inspection.sha256 !== "string") {
    throw new Error(`Source lock is missing ${SOURCE_ENTRY}`);
  }
  const archive = readZipArchive(archiveBytes, PACK_ID);
  const sourceBytes = archive.entries.get(SOURCE_ENTRY)?.data;
  if (!sourceBytes || sha256(sourceBytes) !== inspection.sha256) {
    throw new Error(`${SOURCE_ENTRY} drifted from its immutable lock`);
  }
  return {
    archive: {
      file: pack.archive.file,
      bytes: pack.archive.bytes,
      sha256: pack.archive.sha256,
    },
    sourceBytes,
    sourceSha256: inspection.sha256,
  };
}

export async function buildStevePreparationMotionCandidates(workspaceRoot) {
  const source = loadLockedToolsSource(workspaceRoot);
  const outputs = [];
  for (const candidate of STEVE_PREPARATION_MOTIONS) {
    const selected = selectGlbAnimation(
      source.sourceBytes,
      candidate.clip,
      SOURCE_ENTRY,
    );
    const bytes = await sanitizeSelectedMotion(selected, candidate.outputClip);
    const document = parseGlbJson(bytes, candidate.outputFile);
    const animations = document.animations ?? [];
    if (
      animations.length !== 1 ||
      animations[0]?.name !== candidate.outputClip
    ) {
      throw new Error(`${candidate.clip} extraction was not exact`);
    }
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: candidate.outputFile,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    const infoCodes = [
      ...new Set(
        validation.issues.messages
          .filter((message) => message.severity === 2)
          .map((message) => message.code),
      ),
    ].sort();
    if (
      validation.issues.numErrors !== 0 ||
      validation.issues.numWarnings !== 0 ||
      validation.issues.numHints !== 0 ||
      infoCodes.some((code) => code !== "NODE_EMPTY")
    ) {
      throw new Error(`${candidate.clip} has unsupported glTF findings`);
    }
    outputs.push({
      ...candidate,
      path: `${OUTPUT_DIRECTORY}/${candidate.outputFile}`,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      durationSeconds: animationDurationSeconds(document, animations[0]),
      channelCount: animations[0].channels?.length ?? 0,
      loopSeamExact: true,
      validator: {
        errors: validation.issues.numErrors,
        warnings: validation.issues.numWarnings,
        infos: validation.issues.numInfos,
        hints: validation.issues.numHints,
        infoCodes,
      },
    });
  }
  const generatorPath = fileURLToPath(import.meta.url);
  return {
    schemaVersion: 1,
    intendedRuntimeItemIds: ["bronze_hatchet", "bronze_pickaxe", "fishing_rod"],
    activationStatus: "not-activated",
    approvedForRuntimeActivation: false,
    provenance: {
      sourcePackId: PACK_ID,
      sourceArchive: source.archive,
      sourceEntry: SOURCE_ENTRY,
      sourceSha256: source.sourceSha256,
      license: "CC0-1.0",
    },
    generator: {
      path: path
        .relative(workspaceRoot, generatorPath)
        .split(path.sep)
        .join("/"),
      sha256: sha256(readFileSync(generatorPath)),
    },
    outputs,
  };
}

function serializableReport(report) {
  return {
    ...report,
    outputs: report.outputs.map(({ bytes: _bytes, ...output }) => output),
  };
}

async function run({ check }) {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await buildStevePreparationMotionCandidates(workspaceRoot);
  for (const output of report.outputs) {
    const outputPath = path.join(workspaceRoot, output.path);
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(output.bytes)
      ) {
        throw new Error(`${output.path} is missing or stale`);
      }
    } else {
      writeAtomic(outputPath, output.bytes);
    }
  }
  const reportPath = path.join(workspaceRoot, REPORT_PATH);
  const serialized = `${JSON.stringify(serializableReport(report), null, 2)}\n`;
  if (check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error(`${REPORT_PATH} is missing or stale`);
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  process.stdout.write(
    `${check ? "Verified" : "Built"} ${report.outputs.length} inactive Steve preparation motions\n`,
  );
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return { check: argv[0] === "--check" };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
