import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCertifiedTwoHandDuelPresentationAssets } from "./install-certified-two-hand-duel-presentation-assets.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFINITION = JSON.parse(
  readFileSync(
    path.join(
      WORKSPACE_ROOT,
      "scripts/certified-two-hand-duel-presentation-asset-install.json",
    ),
    "utf8",
  ),
);

function withTemporaryAssets(run) {
  const assetsRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-certified-two-hand-duel-"),
  );
  try {
    return run(assetsRoot);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
}

test("installs only the five hash-locked canonical two-hand assets", () => {
  withTemporaryAssets((assetsRoot) => {
    const result = installCertifiedTwoHandDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    assert.equal(result.activationId, "steve-bronze-2h-duel-controlled-v1");
    assert.equal(result.installed.length, 5);
    assert.deepEqual(
      result.installed.map(({ id, path: installedPath, sha256 }) => ({
        id,
        path: installedPath,
        sha256,
      })),
      [DEFINITION.equipment, ...DEFINITION.motions].map((source) => ({
        id: source.id ?? "equipment",
        path: source.destinationPath,
        sha256: source.sha256,
      })),
    );
    assert.doesNotThrow(() =>
      installCertifiedTwoHandDuelPresentationAssets({
        workspaceRoot: WORKSPACE_ROOT,
        assetsRoot,
        definition: DEFINITION,
        check: true,
      }),
    );
  });
});

test("fails closed when a canonical runtime asset is missing or stale", () => {
  withTemporaryAssets((assetsRoot) => {
    installCertifiedTwoHandDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const destination = path.join(
      assetsRoot,
      DEFINITION.motions[2].destinationPath,
    );
    rmSync(destination);
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /emote-2h-duel-run-steve\.glb is missing or stale/u,
    );
    writeFileSync(destination, Buffer.from("stale"));
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /emote-2h-duel-run-steve\.glb is missing or stale/u,
    );
  });
});

test("rejects evidence drift and unsafe runtime destinations", () => {
  withTemporaryAssets((assetsRoot) => {
    const drifted = structuredClone(DEFINITION);
    drifted.evidence.webGPUReviews[0].reportSha256 = "0".repeat(64);
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: drifted,
          check: false,
        }),
      /WebGPU report drifted/u,
    );

    const unsafe = structuredClone(DEFINITION);
    unsafe.equipment.destinationPath = "../outside.glb";
    unsafe.equipment.assetUrl = "asset://../outside.glb";
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: unsafe,
          check: false,
        }),
      /normalized relative path/u,
    );
  });
});

test("rejects an incomplete exact-angle WebGPU review", () => {
  withTemporaryAssets((assetsRoot) => {
    const incomplete = structuredClone(DEFINITION);
    incomplete.evidence.webGPUReviews[0].contactSheetSha256 = "0".repeat(64);
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: incomplete,
          check: false,
        }),
      /WebGPU contact sheet drifted/u,
    );
  });
});

test("fails closed when a reviewed avatar LOD drifts", () => {
  withTemporaryAssets((assetsRoot) => {
    const drifted = structuredClone(DEFINITION);
    drifted.evidence.runtimeWebGPUReviews[2].avatarSha256 = "0".repeat(64);
    assert.throws(
      () =>
        installCertifiedTwoHandDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: drifted,
          check: false,
        }),
      /lod2 avatar drifted/u,
    );
  });
});
