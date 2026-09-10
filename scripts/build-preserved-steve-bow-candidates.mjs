#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { certifyExistingFittedBowGlb } from "./build-steve-rigid-duel-equipment.mjs";

const SOURCE_PATH = "models/bows/bow-wood/bow-wood-aligned.glb";
const SOURCE_SHA256 =
  "1324ef803dd5455618953cb991d3a72b1ccf729ac0116d3147d518f8882dcb1d";
const EXPORTED_AT = "2026-08-19T22:50:00.000Z";
// Measured from the rendered Steve right-hand mesh in the production ranged
// motion; raw bone origins sit well below the visible palm.
const DRAW_HAND_LOCAL_OFFSET = [
  -0.001610018312, 0.322080308384, -0.032384146338,
];
// Matches the current full-draw wrapper orientation, so locomotion can cancel
// wrist roll without changing the already-reviewed draw pose or aim axis.
const STABLE_BOW_AVATAR_LOCAL_EULER_DEGREES = [
  12.537015022091, -5.840151142208, 10.447351368731,
];
const BOW_GRIP_CONTACT = {
  schemaVersion: 1,
  contentNodeName: "EquipmentContent",
  sourceAxis: [0, 1, 0],
  actionEnd: "dynamic-aim",
  zones: [
    {
      id: "primary",
      boneName: "leftHand",
      minimumSourceProjection: -0.16,
      maximumSourceProjection: 0.16,
    },
  ],
};
const CANDIDATE_OUTPUTS = [
  {
    itemId: "shortbow",
    path: "models/bows/bow-wood/candidates/shortbow-preserved-fit.glb",
  },
  {
    itemId: "magic_shortbow",
    path: "models/bows/bow-wood/candidates/magic-shortbow-preserved-fit.glb",
  },
];
const ACTIVE_OUTPUTS = [
  {
    itemId: "shortbow",
    path: "models/bows/bow-wood/shortbow-steve-fitted.glb",
  },
  {
    itemId: "magic_shortbow",
    path: "models/bows/bow-wood/magic-shortbow-steve-fitted.glb",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeAssetPath(assetsRoot, relativePath) {
  const root = path.resolve(assetsRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Asset path escapes the root: ${relativePath}`);
  }
  return resolved;
}

function writeAtomic(outputPath, value) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, value);
  renameSync(temporaryPath, outputPath);
}

export function parsePreservedSteveBowArguments(argv) {
  let assetsRoot = "packages/server/world/assets";
  let install = false;
  for (const argument of argv) {
    if (argument.startsWith("--assets-root=")) {
      assetsRoot = argument.slice("--assets-root=".length);
    } else if (argument === "--install") {
      install = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!assetsRoot.trim()) throw new Error("Assets root must be non-empty");
  return { assetsRoot, install };
}

export function buildPreservedSteveBowCandidates(
  assetsRoot,
  { install = false } = {},
) {
  const sourcePath = safeAssetPath(assetsRoot, SOURCE_PATH);
  const source = readFileSync(sourcePath);
  if (sha256(source) !== SOURCE_SHA256) {
    throw new Error("Visually reviewed aligned bow source hash drifted");
  }

  const outputs = install ? ACTIVE_OUTPUTS : CANDIDATE_OUTPUTS;
  return outputs.map((definition) => {
    const candidate = certifyExistingFittedBowGlb({
      source,
      itemId: definition.itemId,
      compatibleAvatarId: "steve",
      legacyAvatarId: "/api/assets/steve/model",
      drawHandLocalOffset: DRAW_HAND_LOCAL_OFFSET,
      stableHeldPose: {
        avatarLocalEulerDegrees: STABLE_BOW_AVATAR_LOCAL_EULER_DEGREES,
      },
      gripContact: BOW_GRIP_CONTACT,
      exportedAt: EXPORTED_AT,
    });
    const outputPath = safeAssetPath(assetsRoot, definition.path);
    writeAtomic(outputPath, candidate.output);
    return {
      itemId: definition.itemId,
      path: definition.path,
      sha256: sha256(candidate.output),
      sourceSha256: candidate.report.sourceSha256,
      preservedRelativeMatrix: candidate.report.preservedRelativeMatrix,
      removedStaticStringTriangles:
        candidate.report.staticString.removedTriangleCount,
    };
  });
}

function main() {
  const { assetsRoot, install } = parsePreservedSteveBowArguments(
    process.argv.slice(2),
  );
  const outputs = buildPreservedSteveBowCandidates(assetsRoot, { install });
  process.stdout.write(`${JSON.stringify({ install, outputs }, null, 2)}\n`);
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
