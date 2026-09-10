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
  "KayKit_Character_Animations_1.1/Animations/gltf/Rig_Medium/Rig_Medium_General.glb";
const OUTPUT_DIRECTORY =
  "artifacts/duel-launch-avatar-bakeoff/motions/steve-fishing-interactions";
const REPORT_PATH =
  "artifacts/duel-launch-avatar-bakeoff/steve-fishing-interaction-motion-report.json";
const PRESENTATION_DURATION_SECONDS = 1.2;

export const STEVE_FISHING_INTERACTION_MOTIONS = Object.freeze([
  {
    id: "small_fishing_net_release",
    clip: "Throw",
    outputClip: "Hyperia_Steve_Small_Fishing_Net_Release",
    outputFile: "steve-small-fishing-net-release.glb",
    reversed: false,
    presentationTiming: {
      durationSeconds: PRESENTATION_DURATION_SECONDS,
      releaseSeconds: 0.78,
    },
  },
  {
    id: "fishing_retrieve",
    clip: "PickUp",
    outputClip: "Hyperia_Steve_Fishing_Retrieve",
    outputFile: "steve-fishing-retrieve.glb",
    reversed: false,
    presentationTiming: {
      durationSeconds: PRESENTATION_DURATION_SECONDS,
      pickupSeconds: 0.42,
    },
  },
  {
    id: "lobster_pot_deploy",
    clip: "PickUp",
    outputClip: "Hyperia_Steve_Lobster_Pot_Deploy",
    outputFile: "steve-lobster-pot-deploy.glb",
    reversed: true,
    presentationTiming: {
      durationSeconds: PRESENTATION_DURATION_SECONDS,
      releaseSeconds: 1.08,
    },
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

function reverseLinearAnimation(animation) {
  for (const sampler of animation.listSamplers()) {
    if (sampler.getInterpolation() !== "LINEAR") {
      throw new Error(
        `${animation.getName()} uses unsupported ${sampler.getInterpolation()} interpolation`,
      );
    }
    const output = sampler.getOutput();
    const source = output?.getArray();
    const frameCount = output?.getCount() ?? 0;
    const elementSize = output?.getElementSize() ?? 0;
    if (!output || !source || frameCount < 2 || elementSize < 1) {
      throw new Error(`${animation.getName()} has an invalid output sampler`);
    }
    const reversed = new source.constructor(source.length);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sourceFrame = frameCount - frame - 1;
      for (let component = 0; component < elementSize; component += 1) {
        reversed[frame * elementSize + component] =
          source[sourceFrame * elementSize + component];
      }
    }
    output.setArray(reversed);
  }
}

function retimeLinearAnimation(animation, durationSeconds) {
  const inputs = new Set();
  let sourceDurationSeconds = 0;
  for (const sampler of animation.listSamplers()) {
    if (sampler.getInterpolation() !== "LINEAR") {
      throw new Error(
        `${animation.getName()} uses unsupported ${sampler.getInterpolation()} interpolation`,
      );
    }
    const input = sampler.getInput();
    const values = input?.getArray();
    if (!input || !values || values.length < 2) {
      throw new Error(`${animation.getName()} has an invalid time sampler`);
    }
    inputs.add(input);
    sourceDurationSeconds = Math.max(
      sourceDurationSeconds,
      values[values.length - 1] ?? 0,
    );
  }
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new Error(`${animation.getName()} has no valid source duration`);
  }
  const scale = durationSeconds / sourceDurationSeconds;
  for (const input of inputs) {
    const source = input.getArray();
    if (!source) throw new Error(`${animation.getName()} lost a time sampler`);
    const retimed = new source.constructor(source.length);
    for (let index = 0; index < source.length; index += 1) {
      retimed[index] = source[index] * scale;
    }
    // Avoid a Float32 rounding tail beyond the public 1.2 s authority.
    retimed[retimed.length - 1] = durationSeconds;
    input.setArray(retimed);
  }
}

async function sanitizeSelectedMotion(bytes, definition) {
  const io = new NodeIO();
  const document = await io.readBinary(new Uint8Array(bytes));
  const root = document.getRoot();
  const animations = root.listAnimations();
  if (animations.length !== 1) {
    throw new Error(`${definition.outputClip} must contain one animation`);
  }
  const animation = animations[0];
  animation.setName(definition.outputClip);
  if (definition.reversed) reverseLinearAnimation(animation);
  retimeLinearAnimation(
    animation,
    definition.presentationTiming.durationSeconds,
  );

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

function loadLockedSource(workspaceRoot) {
  const lock = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "scripts/duel-launch-asset-sources.json"),
      "utf8",
    ),
  );
  const pack = lock.packs?.find((candidate) => candidate.id === PACK_ID);
  const inspection = pack?.inspections?.find(
    (candidate) => candidate.entry === SOURCE_ENTRY,
  );
  if (
    !pack ||
    pack.license?.spdx !== "CC0-1.0" ||
    typeof pack.archive?.file !== "string" ||
    typeof pack.archive?.bytes !== "number" ||
    typeof pack.archive?.sha256 !== "string" ||
    typeof inspection?.sha256 !== "string"
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

export async function buildSteveFishingInteractionMotions(workspaceRoot) {
  const source = loadLockedSource(workspaceRoot);
  const outputs = [];
  for (const definition of STEVE_FISHING_INTERACTION_MOTIONS) {
    const selected = selectGlbAnimation(
      source.sourceBytes,
      definition.clip,
      SOURCE_ENTRY,
    );
    const bytes = await sanitizeSelectedMotion(selected, definition);
    const document = parseGlbJson(bytes, definition.outputFile);
    const animation = document.animations?.[0];
    if (
      document.animations?.length !== 1 ||
      animation?.name !== definition.outputClip
    ) {
      throw new Error(`${definition.id} extraction was not exact`);
    }
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: definition.outputFile,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    const unsupportedIssues = validation.issues.messages.filter(
      (message) => message.severity !== 2 || message.code !== "NODE_EMPTY",
    );
    if (unsupportedIssues.length > 0) {
      throw new Error(
        `${definition.id} has unsupported glTF findings: ${unsupportedIssues
          .map((issue) => issue.code)
          .join(", ")}`,
      );
    }
    outputs.push({
      ...definition,
      path: `${OUTPUT_DIRECTORY}/${definition.outputFile}`,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      durationSeconds: Number(
        animationDurationSeconds(document, animation).toFixed(6),
      ),
      channelCount: animation.channels?.length ?? 0,
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

function serializable(report) {
  return {
    ...report,
    outputs: report.outputs.map(({ bytes: _bytes, ...output }) => output),
  };
}

async function main() {
  const arguments_ = new Set(process.argv.slice(2));
  if (
    arguments_.size !== 1 ||
    (!arguments_.has("--write") && !arguments_.has("--check"))
  ) {
    throw new Error("Specify exactly one of --write or --check");
  }
  const check = arguments_.has("--check");
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await buildSteveFishingInteractionMotions(workspaceRoot);
  for (const output of report.outputs) {
    const outputPath = path.join(workspaceRoot, output.path);
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(output.bytes)
      ) {
        throw new Error(`${output.id} motion output is missing or stale`);
      }
    } else {
      writeAtomic(outputPath, output.bytes);
    }
  }
  const reportPath = path.join(workspaceRoot, REPORT_PATH);
  const serialized = `${JSON.stringify(serializable(report), null, 2)}\n`;
  if (check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Steve fishing-interaction motion report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  console.log(
    `${check ? "Verified" : "Built"} ${report.outputs.length} Steve fishing-interaction motions`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
