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
import { NodeIO } from "@gltf-transform/core";

import { parseGlbJson } from "./audit-avatar-lods.mjs";
import { selectGlbAnimation } from "./build-duel-launch-avatar-candidates.mjs";
import { readZipArchive } from "./lib/read-zip-archive.mjs";

const PACK_ID = "kaykit-character-animations-1.1-free";
const SOURCE_ENTRY =
  "KayKit_Character_Animations_1.1/Animations/gltf/Rig_Medium/Rig_Medium_Tools.glb";
const OUTPUT_DIRECTORY =
  "artifacts/duel-launch-avatar-bakeoff/motions/harpoon-water-strike-candidates";
const REPORT_PATH =
  "artifacts/duel-launch-avatar-bakeoff/harpoon-water-strike-candidate-report.json";

export const HARPOON_WATER_STRIKE_CLIPS = Object.freeze([
  {
    id: "dig",
    clip: "Dig",
    displayName: "Full dig action",
    outputFile: "kaykit-harpoon-water-dig.glb",
  },
  {
    id: "digging",
    clip: "Digging",
    displayName: "Looping dig strike",
    outputFile: "kaykit-harpoon-water-digging.glb",
  },
  {
    id: "pickaxe",
    clip: "Pickaxe",
    displayName: "Full pickaxe action",
    outputFile: "kaykit-harpoon-water-pickaxe.glb",
  },
  {
    id: "water-strike",
    clip: "Digging",
    outputClip: "Hyperia_Harpoon_Water_Strike",
    displayName: "Time-shifted water strike",
    outputFile: "kaykit-harpoon-water-strike.glb",
    shiftStartFrame: 17,
    targetDurationSeconds: 1.2,
  },
  {
    id: "steve-water-strike",
    clip: "Digging",
    outputClip: "Hyperia_Steve_Harpoon_Water_Strike",
    displayName: "Steve launch-avatar water strike",
    outputFile: "steve-harpoon-water-strike.glb",
    shiftStartFrame: 17,
    targetDurationSeconds: 1.2,
    timeWarpControlPoints: [
      [0, 0],
      [0.4, 0.2],
      [0.775, 0.5],
      [0.82, 0.9],
      [1, 1],
    ],
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

export function warpNormalizedAnimationTime(ratio, controlPoints) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(
      "Animation time ratio must be finite and between zero and one",
    );
  }
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
    throw new Error("Animation time warp requires at least two control points");
  }
  const points = controlPoints.map((point) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every(Number.isFinite)
    ) {
      throw new Error(
        "Animation time-warp control points must be finite pairs",
      );
    }
    return point;
  });
  if (
    points[0][0] !== 0 ||
    points[0][1] !== 0 ||
    points.at(-1)[0] !== 1 ||
    points.at(-1)[1] !== 1
  ) {
    throw new Error("Animation time warp must preserve both clip endpoints");
  }
  for (let index = 1; index < points.length; index += 1) {
    if (
      points[index][0] <= points[index - 1][0] ||
      points[index][1] <= points[index - 1][1]
    ) {
      throw new Error(
        "Animation time-warp control points must be strictly increasing",
      );
    }
  }
  if (ratio === 1) return 1;
  const upperIndex = points.findIndex((point) => ratio <= point[0]);
  const upper = points[upperIndex];
  const lower = points[upperIndex - 1] ?? upper;
  if (lower === upper) return upper[1];
  const segmentRatio = (ratio - lower[0]) / (upper[0] - lower[0]);
  return lower[1] + segmentRatio * (upper[1] - lower[1]);
}

async function timeShiftLoopingMotion(bytes, candidate) {
  if (!Number.isSafeInteger(candidate.shiftStartFrame)) return bytes;
  const io = new NodeIO();
  const document = await io.readBinary(new Uint8Array(bytes));
  const animations = document.getRoot().listAnimations();
  if (animations.length !== 1) {
    throw new Error(`${candidate.clip} must contain exactly one animation`);
  }
  const animation = animations[0];
  animation.setName(candidate.outputClip);
  const retainedAccessors = new Set();
  const timeAccessors = new Set();
  let shiftedSamplerCount = 0;
  for (const sampler of animation.listSamplers()) {
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (input) retainedAccessors.add(input);
    if (output) retainedAccessors.add(output);
    if (input) timeAccessors.add(input);
    const times = input?.getArray();
    const values = output?.getArray();
    const frameCount = input?.getCount() ?? 0;
    const elementSize = output?.getElementSize() ?? 0;
    if (!times || !values || frameCount <= 2) continue;
    if (
      output.getCount() !== frameCount ||
      candidate.shiftStartFrame < 1 ||
      candidate.shiftStartFrame >= frameCount - 1
    ) {
      throw new Error(`${candidate.clip} has unsupported animation sampling`);
    }
    const indices = [
      ...Array.from(
        { length: frameCount - candidate.shiftStartFrame },
        (_unused, index) => candidate.shiftStartFrame + index,
      ),
      ...Array.from(
        { length: candidate.shiftStartFrame },
        (_unused, index) => index + 1,
      ),
    ];
    if (indices.length !== frameCount) {
      throw new Error(`${candidate.clip} produced an invalid shifted cycle`);
    }
    const shifted = new values.constructor(values.length);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sourceFrame = indices[frame];
      for (let component = 0; component < elementSize; component += 1) {
        shifted[frame * elementSize + component] =
          values[sourceFrame * elementSize + component];
      }
    }
    for (let component = 0; component < elementSize; component += 1) {
      if (
        Math.abs(
          shifted[component] -
            shifted[(frameCount - 1) * elementSize + component],
        ) > 1e-6
      ) {
        throw new Error(`${candidate.clip} shifted loop seam is not exact`);
      }
    }
    output.setArray(shifted);
    shiftedSamplerCount += 1;
  }
  if (shiftedSamplerCount === 0) {
    throw new Error(`${candidate.clip} has no dynamic samplers to shift`);
  }
  if (
    typeof candidate.targetDurationSeconds === "number" &&
    Number.isFinite(candidate.targetDurationSeconds) &&
    candidate.targetDurationSeconds > 0
  ) {
    for (const input of timeAccessors) {
      const times = input.getArray();
      const sourceDuration = times?.[times.length - 1] ?? 0;
      if (!times || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        throw new Error(`${candidate.clip} has invalid animation time data`);
      }
      const scaled = new times.constructor(times.length);
      const scale = candidate.targetDurationSeconds / sourceDuration;
      for (let index = 0; index < times.length; index += 1) {
        scaled[index] = times[index] * scale;
      }
      scaled[scaled.length - 1] = candidate.targetDurationSeconds;
      input.setArray(scaled);
    }
  }
  if (candidate.timeWarpControlPoints) {
    for (const input of timeAccessors) {
      const times = input.getArray();
      const duration = times?.[times.length - 1] ?? 0;
      if (!times || !Number.isFinite(duration) || duration <= 0) {
        throw new Error(`${candidate.clip} has invalid animation time data`);
      }
      const warped = new times.constructor(times.length);
      for (let index = 0; index < times.length; index += 1) {
        warped[index] =
          warpNormalizedAnimationTime(
            Math.min(1, Math.max(0, times[index] / duration)),
            candidate.timeWarpControlPoints,
          ) * duration;
      }
      warped[0] = 0;
      warped[warped.length - 1] = duration;
      input.setArray(warped);
    }
  }
  const root = document.getRoot();
  const animatedNodes = new Set(
    animation.listChannels().map((channel) => channel.getTargetNode()),
  );
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
  const lockPath = path.join(
    workspaceRoot,
    "scripts/duel-launch-asset-sources.json",
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const pack = lock.packs?.find((candidate) => candidate.id === PACK_ID);
  if (
    !pack ||
    typeof pack.archive?.file !== "string" ||
    typeof pack.archive?.bytes !== "number" ||
    typeof pack.archive?.sha256 !== "string"
  ) {
    throw new Error(`Source lock is missing ${PACK_ID}`);
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

export async function buildKayKitHarpoonMotionCandidates(workspaceRoot) {
  const source = loadLockedToolsSource(workspaceRoot);
  const outputs = [];
  for (const candidate of HARPOON_WATER_STRIKE_CLIPS) {
    const selectedBytes = selectGlbAnimation(
      source.sourceBytes,
      candidate.clip,
      SOURCE_ENTRY,
    );
    const bytes = await timeShiftLoopingMotion(selectedBytes, candidate);
    const document = parseGlbJson(bytes, candidate.outputFile);
    const animations = document.animations ?? [];
    const outputClip = candidate.outputClip ?? candidate.clip;
    if (animations.length !== 1 || animations[0]?.name !== outputClip) {
      throw new Error(`${candidate.clip} extraction was not exact`);
    }
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: candidate.outputFile,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    if (validation.issues.numErrors !== 0) {
      throw new Error(
        `${candidate.clip} has ${validation.issues.numErrors} Khronos validation errors`,
      );
    }
    outputs.push({
      ...candidate,
      outputClip,
      path: `${OUTPUT_DIRECTORY}/${candidate.outputFile}`,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      durationSeconds: animationDurationSeconds(document, animations[0]),
      channelCount: animations[0].channels?.length ?? 0,
      loopSeamExact: Number.isSafeInteger(candidate.shiftStartFrame)
        ? true
        : null,
      timeWarpControlPoints: candidate.timeWarpControlPoints ?? null,
      validator: {
        errors: validation.issues.numErrors,
        warnings: validation.issues.numWarnings,
        infos: validation.issues.numInfos,
        hints: validation.issues.numHints,
        infoCodes: [
          ...new Set(
            validation.issues.messages
              .filter((message) => message.severity === 2)
              .map((message) => message.code),
          ),
        ].sort(),
      },
    });
  }
  const generatorPath = fileURLToPath(import.meta.url);
  return {
    schemaVersion: 1,
    intendedRuntimeItemId: "harpoon",
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
  const report = await buildKayKitHarpoonMotionCandidates(workspaceRoot);
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
    `${check ? "Verified" : "Built"} ${report.outputs.length} inactive harpoon water-strike motion candidates\n`,
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
