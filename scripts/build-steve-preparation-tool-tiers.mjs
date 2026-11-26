#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildKayKitPreparationToolTiers } from "./build-kaykit-preparation-tool-tiers.mjs";

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return { check: argv[0] === "--check" };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const config = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "scripts/steve-preparation-tool-tiers.json"),
      "utf8",
    ),
  );
  const report = await buildKayKitPreparationToolTiers({
    workspaceRoot,
    config,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.summary.certifiedCandidateCount} canonical Steve preparation-tool tier candidates; active manifests unchanged\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
