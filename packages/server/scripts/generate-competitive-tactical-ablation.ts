import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runCompetitiveTacticalAblation } from "../src/duel/__tests__/competitiveTacticalAblationHarness.js";

const outputPath = resolve(
  import.meta.dirname,
  "../tests/fixtures/duel/competitive-tactical-ablation-v3.json",
);
const serialized = `${JSON.stringify(await runCompetitiveTacticalAblation(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let retained = "";
  try {
    retained = await readFile(outputPath, "utf8");
  } catch {
    throw new Error(`retained tactical ablation is missing: ${outputPath}`);
  }
  if (retained !== serialized) {
    throw new Error(
      "retained tactical ablation drifted; regenerate and review the outcome evidence",
    );
  }
  const report = JSON.parse(retained) as { reportHash?: unknown };
  console.log(`Retained tactical ablation verified: ${report.reportHash}`);
} else {
  await writeFile(outputPath, serialized, "utf8");
  const report = JSON.parse(serialized) as { reportHash?: unknown };
  console.log(`Retained tactical ablation updated: ${report.reportHash}`);
}
