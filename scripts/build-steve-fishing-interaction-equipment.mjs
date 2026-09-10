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

import { buildRigidDuelEquipment } from "./build-steve-rigid-duel-equipment.mjs";

const MANIFEST_PATH = "scripts/steve-fishing-interaction-equipment-fits.json";
const REPORT_PATH =
  "artifacts/duel-launch-avatar-bakeoff/steve-fishing-interaction-equipment-fit-report.json";

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

export async function buildSteveFishingInteractionEquipment(
  workspaceRoot,
  check,
) {
  const manifest = JSON.parse(
    readFileSync(path.join(workspaceRoot, MANIFEST_PATH), "utf8"),
  );
  return buildRigidDuelEquipment({
    workspaceRoot,
    assetsRoot: workspaceRoot,
    manifest,
    check,
  });
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
  const report = await buildSteveFishingInteractionEquipment(
    workspaceRoot,
    check,
  );
  const reportPath = path.join(workspaceRoot, REPORT_PATH);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Steve fishing-interaction equipment report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  console.log(
    `${check ? "Verified" : "Built"} ${report.outputs.length} Steve fishing-interaction equipment fits`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
