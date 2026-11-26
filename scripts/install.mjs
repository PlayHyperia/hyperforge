#!/usr/bin/env node
/**
 * Hyperia install bootstrap
 *
 * Ensures local prerequisites used by `bun run duel` are ready:
 * - synced game assets
 * - Playwright Chromium browser (used by stream-to-rtmp capture)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const isWindows = process.platform === "win32";

function run(label, command, args) {
  console.log(`[install] ${label}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? "unknown"}).`);
  }
}

function main() {
  run("Ensuring required assets", isWindows ? "node.exe" : "node", [
    "scripts/ensure-assets.mjs",
  ]);

  if (process.env.HYPERIA_SKIP_BROWSER_INSTALL === "true") {
    console.log(
      "[install] Skipping browser installation (HYPERIA_SKIP_BROWSER_INSTALL=true)",
    );
  } else {
    const installSystemDependencies =
      process.platform === "linux" &&
      (Boolean(process.env.CI) ||
        process.env.HYPERIA_REQUIRE_BROWSER_SYSTEM_DEPS === "true");
    run("Installing Playwright Chromium", isWindows ? "bunx.cmd" : "bunx", [
      "playwright",
      "install",
      ...(installSystemDependencies ? ["--with-deps"] : []),
      "chromium",
    ]);
  }

  console.log("[install] Done. Next: bun run duel --fresh");
}

try {
  main();
} catch (error) {
  console.error(
    `[install] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
