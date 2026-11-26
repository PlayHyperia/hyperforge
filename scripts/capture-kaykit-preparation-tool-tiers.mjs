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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const EXPECTED_NODE_VERSION = "v22.23.2";
const SAFE_ID = /^[a-z0-9_]+$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function humanize(value) {
  return value
    .split("_")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertFiniteObjectNumbers(value, label) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`${label}.${key} must be finite`);
    }
  }
}

function validateMotionEvidence({
  report,
  itemId,
  family,
  candidatePath,
  candidateSha256,
}) {
  if (
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length !== 0 ||
    !Array.isArray(report.motions) ||
    report.motions.length !== 1
  ) {
    throw new Error(`${itemId} motion report is not a clean one-cell pass`);
  }
  const motion = report.motions[0];
  const equipment = motion?.equipment;
  const expectedMotion = family === "hatchet" ? "woodcutting" : "mining";
  if (
    motion.id !== expectedMotion ||
    !Array.isArray(motion.failures) ||
    motion.failures.length !== 0 ||
    equipment?.itemId !== itemId ||
    equipment?.asset !== candidatePath ||
    equipment?.metadataValid !== true ||
    equipment?.metadataReason !== null ||
    equipment?.attached !== true ||
    equipment?.visible !== true ||
    equipment?.attachmentBone !== "rightHand" ||
    report.inputs?.[candidatePath] !== candidateSha256
  ) {
    throw new Error(`${itemId} motion evidence drifted`);
  }
  assertFiniteObjectNumbers(equipment.bounds, `${itemId}.bounds`);
  for (const key of [
    "rightHandNearestVertexDistance",
    "leftHandNearestVertexDistance",
    "headNearestVertexDistance",
    "torsoNearestVertexDistance",
  ]) {
    if (!Number.isFinite(equipment[key]) || equipment[key] < 0) {
      throw new Error(`${itemId}.${key} must be a non-negative finite number`);
    }
  }
  return {
    motionId: motion.id,
    trackCount: motion.trackCount,
    movingBoneCount: motion.movingBoneCount,
    maximumBoneRotationDegrees: motion.maximumBoneRotationDegrees,
    equipment: {
      metadataValid: true,
      attached: true,
      visible: true,
      attachmentBone: equipment.attachmentBone,
      weaponType: equipment.weaponType,
      bounds: equipment.bounds,
      rightHandNearestVertexDistance: equipment.rightHandNearestVertexDistance,
      leftHandNearestVertexDistance: equipment.leftHandNearestVertexDistance,
      headNearestVertexDistance: equipment.headNearestVertexDistance,
      torsoNearestVertexDistance: equipment.torsoNearestVertexDistance,
    },
  };
}

async function buildFamilyContactSheet({ captures, outputPath }) {
  const cellWidth = 560;
  const cellHeight = 680;
  const columns = 3;
  const rows = 2;
  const cells = [];
  for (const [index, capture] of captures.entries()) {
    const source = sharp(capture.imagePath);
    const metadata = await source.metadata();
    if (
      !Number.isInteger(metadata.width) ||
      metadata.width < cellWidth ||
      !Number.isInteger(metadata.height) ||
      metadata.height < cellHeight
    ) {
      throw new Error(
        `${capture.itemId} screenshot is smaller than review crop`,
      );
    }
    const input = await source
      .extract({ left: 0, top: 0, width: cellWidth, height: cellHeight })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    cells.push({
      input,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * cellHeight,
    });
  }
  const output = await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 4,
      background: { r: 8, g: 11, b: 19, alpha: 1 },
    },
  })
    .composite(cells)
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  writeAtomic(outputPath, output);
  return {
    sha256: sha256(output),
    bytes: output.length,
    width: columns * cellWidth,
    height: rows * cellHeight,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.version !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Tier capture requires Node.js ${EXPECTED_NODE_VERSION}; found ${process.version}`,
    );
  }
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const candidateReportPath = path.join(
    workspaceRoot,
    "artifacts/duel-launch-avatar-bakeoff/kaykit-preparation-tool-tier-report.json",
  );
  const candidateReportBytes = readFileSync(candidateReportPath);
  const candidateReport = JSON.parse(candidateReportBytes.toString("utf8"));
  if (
    candidateReport.summary?.certifiedCandidateCount !== 12 ||
    candidateReport.summary?.readyForProductReview !== true ||
    candidateReport.summary?.approvedForRuntimeActivation !== false ||
    candidateReport.activeRuntimePathsChanged !== false ||
    !Array.isArray(candidateReport.outputs) ||
    candidateReport.outputs.length !== 12
  ) {
    throw new Error("Tier candidate report is not ready for visual review");
  }
  const reviewDirectory = path.join(
    workspaceRoot,
    "artifacts/duel-launch-avatar-bakeoff/preparation-tier-review",
  );
  const captures = [];
  for (const candidate of candidateReport.outputs) {
    if (
      !SAFE_ID.test(candidate.itemId) ||
      !["hatchet", "pickaxe"].includes(candidate.family) ||
      !["one-hand", "two-hand"].includes(candidate.grip)
    ) {
      throw new Error("Tier candidate report contains an invalid identity");
    }
    const candidatePath = path
      .relative(
        path.join(workspaceRoot, "artifacts/duel-launch-avatar-bakeoff"),
        path.join(workspaceRoot, candidate.outputPath),
      )
      .split(path.sep)
      .join("/");
    const imageRelative = `artifacts/duel-launch-avatar-bakeoff/preparation-tier-review/${candidate.itemId}-motion-contact-sheet.png`;
    const reportRelative = `artifacts/duel-launch-avatar-bakeoff/preparation-tier-review/${candidate.itemId}-motion-report.json`;
    const imagePath = path.join(workspaceRoot, imageRelative);
    const reportPath = path.join(workspaceRoot, reportRelative);
    if (options.write) {
      const motionManifest =
        candidate.family === "hatchet"
          ? "scripts/kaykit-hatchet-tier-review-motion.json"
          : "scripts/kaykit-pickaxe-tier-review-motion.json";
      const result = spawnSync(
        process.execPath,
        [
          "scripts/capture-duel-avatar-motion.mjs",
          "--assets-root",
          "artifacts/duel-launch-avatar-bakeoff",
          "--avatar",
          "kaykit-knight.vrm",
          "--motions",
          motionManifest,
          "--equipment",
          candidatePath,
          "--item-id",
          candidate.itemId,
          "--equipment-slot",
          "gatheringtool",
          "--avatar-id",
          candidateReport.avatarId,
          "--grip",
          candidate.grip,
          "--title",
          `${humanize(candidate.itemId)} · KayKit tier review`,
          "--output",
          imageRelative,
          "--report",
          reportRelative,
        ],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: process.env,
          timeout: 180_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `${candidate.itemId} capture failed: ${(result.stderr || result.stdout || "no output").trim()}`,
        );
      }
    }
    if (!existsSync(imagePath) || !existsSync(reportPath)) {
      throw new Error(`${candidate.itemId} capture evidence is missing`);
    }
    const imageBytes = readFileSync(imagePath);
    const reportBytes = readFileSync(reportPath);
    const motionEvidence = validateMotionEvidence({
      report: JSON.parse(reportBytes.toString("utf8")),
      itemId: candidate.itemId,
      family: candidate.family,
      candidatePath,
      candidateSha256: candidate.outputSha256,
    });
    const imageMetadata = await sharp(imageBytes).metadata();
    if (
      imageMetadata.format !== "png" ||
      imageMetadata.width !== 1600 ||
      imageMetadata.height !== 1200
    ) {
      throw new Error(`${candidate.itemId} screenshot dimensions drifted`);
    }
    captures.push({
      itemId: candidate.itemId,
      family: candidate.family,
      tier: candidate.tier,
      priority: candidate.priority,
      candidatePath: candidate.outputPath,
      candidateSha256: candidate.outputSha256,
      imagePath,
      imageRelative,
      imageSha256: sha256(imageBytes),
      imageBytes: imageBytes.length,
      reportPath,
      reportRelative,
      reportSha256: sha256(reportBytes),
      motionEvidence,
    });
  }

  const previousReportPath = path.join(
    reviewDirectory,
    "kaykit-preparation-tool-tier-visual-report.json",
  );
  const previousReport =
    options.check && existsSync(previousReportPath)
      ? JSON.parse(readFileSync(previousReportPath, "utf8"))
      : null;
  const familyContactSheets = [];
  for (const family of ["hatchet", "pickaxe"]) {
    const outputPath = path.join(
      reviewDirectory,
      `kaykit-${family}-tier-review-contact-sheet.png`,
    );
    const familyCaptures = captures.filter(
      (capture) => capture.family === family,
    );
    let summary;
    if (options.write) {
      summary = await buildFamilyContactSheet({
        captures: familyCaptures,
        outputPath,
      });
    } else {
      if (!existsSync(outputPath)) {
        throw new Error(`${family} family contact sheet is missing`);
      }
      const bytes = readFileSync(outputPath);
      const metadata = await sharp(bytes).metadata();
      summary = {
        sha256: sha256(bytes),
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
      };
      const expected = previousReport?.familyContactSheets?.find(
        (entry) => entry.family === family,
      );
      if (
        !expected ||
        expected.sha256 !== summary.sha256 ||
        expected.bytes !== summary.bytes ||
        expected.width !== summary.width ||
        expected.height !== summary.height
      ) {
        throw new Error(`${family} family contact sheet drifted`);
      }
    }
    familyContactSheets.push({
      family,
      path: path.relative(workspaceRoot, outputPath).split(path.sep).join("/"),
      ...summary,
    });
  }

  const report = {
    schemaVersion: 1,
    exportedAt: candidateReport.exportedAt,
    status: "technical_candidates_visually_qualified_unapproved",
    activeRuntimePathsChanged: false,
    candidateReport: {
      path: path
        .relative(workspaceRoot, candidateReportPath)
        .split(path.sep)
        .join("/"),
      sha256: sha256(candidateReportBytes),
    },
    runtime: {
      node: process.version,
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    summary: {
      captureCount: captures.length,
      passedMotionCount: captures.length,
      metadataValidCount: captures.filter(
        (capture) => capture.motionEvidence.equipment.metadataValid,
      ).length,
      attachedCount: captures.filter(
        (capture) => capture.motionEvidence.equipment.attached,
      ).length,
      visibleCount: captures.filter(
        (capture) => capture.motionEvidence.equipment.visible,
      ).length,
      browserErrorCount: 0,
      failureCount: 0,
      activeRuntimePathChangeCount: 0,
      approvedForRuntimeActivation: false,
    },
    familyContactSheets,
    captures: captures.map((capture) => ({
      itemId: capture.itemId,
      family: capture.family,
      tier: capture.tier,
      priority: capture.priority,
      candidatePath: capture.candidatePath,
      candidateSha256: capture.candidateSha256,
      image: {
        path: capture.imageRelative,
        sha256: capture.imageSha256,
        bytes: capture.imageBytes,
        width: 1600,
        height: 1200,
      },
      report: {
        path: capture.reportRelative,
        sha256: capture.reportSha256,
      },
      motionEvidence: capture.motionEvidence,
    })),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (
      !previousReport ||
      readFileSync(previousReportPath, "utf8") !== serialized
    ) {
      throw new Error("Preparation-tool tier visual report is stale");
    }
  } else {
    writeAtomic(previousReportPath, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Captured"} ${captures.length} exact tier motion cells with zero browser or attachment failure; active manifests unchanged\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
