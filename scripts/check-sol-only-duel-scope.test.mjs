import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scopeGatePath = path.resolve(
  rootDir,
  "scripts/check-sol-only-duel-scope.mjs",
);

test("protects launch-reachable duel surfaces and retired token APIs", async () => {
  const source = await readFile(scopeGatePath, "utf8");

  for (const protectedPath of [
    "packages/server/src/routes",
    "packages/server/src/streaming",
    "packages/server/src/systems/DuelScheduler",
    "packages/server/src/systems/DuelSystem",
    "packages/server/src/systems/StreamingDuelScheduler",
    "packages/shared/src/types/web3/index.ts",
    "packages/app/.env.e2e",
  ]) {
    assert.equal(source.includes(`"${protectedPath}"`), true);
  }
  assert.match(
    source,
    /const excludedDirectoryNames = new Set\(\["__tests__"\]\);/,
  );
});

test("keeps the desktop E2E environment free of retired market state", async () => {
  const source = await readFile(
    path.resolve(rootDir, "packages/app/.env.e2e"),
    "utf8",
  );

  assert.match(source, /^VITE_SOLANA_CLUSTER=localnet$/m);
  assert.doesNotMatch(source, /GOLD|USDC|BET_|HEADLESS_WALLET|ACTIVE_MATCH/);
});

test("passes the SOL-only launch-scope gate", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [scopeGatePath],
    { cwd: rootDir },
  );
  assert.equal(stderr, "");

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.asset, "native SOL");
  assert.equal(report.authoritativeUnit, "lamports");
  assert.equal(report.retiredBettingPanel, true);
  assert.equal(report.retiredWebsiteBettingClient, true);
  assert.equal(report.retiredSharedBettingTokenApi, true);
  assert.equal(report.scannedFiles >= 90, true);
});
