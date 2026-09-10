#!/usr/bin/env node

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

import { buildBowDuelLocomotionCandidates } from "./build-bow-duel-locomotion-candidates.mjs";

export const REVIEWED_BOW_CARRY_CANDIDATE_ID = "locked";

export const BOW_DUEL_LOCOMOTION_OUTPUTS = Object.freeze([
  {
    locomotionId: "idle",
    outputAsset: "emotes/emote-bow-duel-idle-steve.glb",
  },
  {
    locomotionId: "walk",
    outputAsset: "emotes/emote-bow-duel-walk-steve.glb",
  },
  {
    locomotionId: "run",
    outputAsset: "emotes/emote-bow-duel-run-steve.glb",
  },
]);

const REPORT_PATH =
  "artifacts/duel-avatar-candidates/bow-duel-locomotion-build-report.json";

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

export async function buildBowDuelLocomotionEmotes(workspaceRoot) {
  const candidates = await buildBowDuelLocomotionCandidates(workspaceRoot);
  const reviewed = new Map(
    candidates.outputs
      .filter(
        (output) => output.candidateId === REVIEWED_BOW_CARRY_CANDIDATE_ID,
      )
      .map((output) => [output.locomotionId, output]),
  );
  const outputs = BOW_DUEL_LOCOMOTION_OUTPUTS.map((definition) => {
    const candidate = reviewed.get(definition.locomotionId);
    if (!candidate) {
      throw new Error(
        `Reviewed bow carry is missing ${definition.locomotionId}`,
      );
    }
    return {
      ...definition,
      sourceCandidateAsset: candidate.outputAsset,
      sourceCandidateSha256: candidate.sha256,
      blendStrength: candidate.blendStrength,
      baseAsset: candidate.baseAsset,
      baseSha256: candidate.baseSha256,
      byteLength: candidate.byteLength,
      sha256: candidate.sha256,
      validation: candidate.validation,
      durationSeconds: candidate.durationSeconds,
      channelCount: candidate.channelCount,
      overrides: candidate.overrides,
      bytes: candidate.bytes,
    };
  });
  return {
    schemaVersion: 1,
    activationStatus: "reviewed-production",
    approvedForRuntimeActivation: true,
    reviewedCandidateId: REVIEWED_BOW_CARRY_CANDIDATE_ID,
    reference: candidates.reference,
    armBones: candidates.armBones,
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
  const report = await buildBowDuelLocomotionEmotes(workspaceRoot);
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  for (const output of report.outputs) {
    const outputPath = path.join(assetsRoot, output.outputAsset);
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(output.bytes)
      ) {
        throw new Error(`${output.outputAsset} is missing or stale`);
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
  console.log(
    `${check ? "Verified" : "Built"} ${report.outputs.length} production bow duel locomotion clips`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.size !== 1 || (!args.has("--write") && !args.has("--check"))) {
    console.error(
      "Usage: node scripts/build-bow-duel-locomotion-emotes.mjs --write|--check",
    );
    process.exitCode = 1;
  } else {
    run({ check: args.has("--check") }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
