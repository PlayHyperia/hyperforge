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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifest = JSON.parse(
    readFileSync(
      path.join(
        workspaceRoot,
        "scripts/kaykit-runtime-duel-equipment-fits.json",
      ),
      "utf8",
    ),
  );
  const report = await buildRigidDuelEquipment({
    workspaceRoot,
    assetsRoot: workspaceRoot,
    manifest,
    check: options.check,
  });
  const reportPath = path.join(
    workspaceRoot,
    "artifacts/duel-launch-avatar-bakeoff/kaykit-runtime-duel-equipment-report.json",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("KayKit runtime duel-equipment report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.outputs.length} KayKit runtime duel-equipment fits\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
