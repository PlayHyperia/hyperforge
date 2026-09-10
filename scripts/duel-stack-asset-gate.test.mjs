import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readLaunchAssetByteEvidence } from "./lib/launch-asset-byte-evidence.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function readByteCompleteSource(fileName) {
  const sourcePath = path.join(scriptsDirectory, fileName);
  const evidence = readLaunchAssetByteEvidence(sourcePath, {
    timeoutMs: 60_000,
  });
  assert.equal(evidence.ok, true, evidence.ok ? undefined : evidence.error);
  assert.ok(evidence.evidence.bytesRead > 1_000, `${fileName} is too small`);
  return readFileSync(sourcePath, "utf8");
}

const duelStackSource = readByteCompleteSource("duel-stack.mjs");
const smokeLauncherSource = readByteCompleteSource("smoke-duel-launch.mjs");

test("every stack launch gates game reuse and startup on byte-complete assets", () => {
  const initialReadinessIndex = duelStackSource.indexOf("initial readiness:");
  const assetGateIndex = duelStackSource.indexOf(
    '"duel-launch-assets"',
    initialReadinessIndex,
  );
  const reuseIndex = duelStackSource.indexOf(
    "reusing existing game server + client",
    initialReadinessIndex,
  );
  const startComponentsIndex = duelStackSource.indexOf(
    "starting missing game components",
    initialReadinessIndex,
  );
  const sharedBuildIndex = duelStackSource.indexOf(
    '"shared-build"',
    startComponentsIndex,
  );
  const serverStartIndex = duelStackSource.indexOf(
    '"game-server"',
    startComponentsIndex,
  );

  assert.ok(initialReadinessIndex >= 0, "initial readiness check not found");
  assert.ok(assetGateIndex > initialReadinessIndex, "asset gate not found");
  assert.ok(reuseIndex > assetGateIndex, "assets must gate service reuse");
  assert.ok(
    startComponentsIndex > assetGateIndex,
    "assets must gate component startup",
  );
  assert.ok(sharedBuildIndex > assetGateIndex, "assets must gate shared build");
  assert.ok(serverStartIndex > assetGateIndex, "assets must gate server start");

  const gateBlock = duelStackSource.slice(initialReadinessIndex, reuseIndex);
  assert.match(gateBlock, /process\.execPath/u);
  assert.match(gateBlock, /scripts\/validate-duel-launch-assets\.mjs/u);
});

test("the outer smoke byte-validates the exact nested launcher before spawn", () => {
  const argumentIndex = smokeLauncherSource.indexOf(
    "const args = buildDuelSmokeLauncherArgs",
  );
  const byteReadIndex = smokeLauncherSource.indexOf(
    "readLaunchAssetByteEvidence",
    argumentIndex,
  );
  const spawnIndex = smokeLauncherSource.indexOf(
    "const child = spawn(gameBunPath, args",
    argumentIndex,
  );

  assert.ok(argumentIndex >= 0, "nested launcher arguments not found");
  assert.ok(byteReadIndex > argumentIndex, "nested byte preflight not found");
  assert.ok(
    spawnIndex > byteReadIndex,
    "byte preflight must gate nested spawn",
  );
  const preflightBlock = smokeLauncherSource.slice(argumentIndex, spawnIndex);
  assert.match(preflightBlock, /scripts\/duel-stack\.mjs/u);
  assert.match(preflightBlock, /timeoutMs:\s*60_000/u);
  assert.match(preflightBlock, /bytesRead\s*<\s*10_000/u);
});
