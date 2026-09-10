import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCertifiedDuelPresentationRuntimeManifest,
  installCertifiedDuelPresentationAssets,
} from "./install-certified-duel-presentation-assets.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFINITION = JSON.parse(
  readFileSync(
    path.join(
      WORKSPACE_ROOT,
      "scripts/certified-duel-presentation-asset-install.json",
    ),
    "utf8",
  ),
);

function withTemporaryAssets(run) {
  const assetsRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-certified-presentation-"),
  );
  try {
    return run(assetsRoot);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
}

test("installs the locked pair before writing its activation marker", () => {
  withTemporaryAssets((assetsRoot) => {
    const installed = installCertifiedDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    assert.equal(installed.installed.length, 2);
    assert.doesNotThrow(() =>
      installCertifiedDuelPresentationAssets({
        workspaceRoot: WORKSPACE_ROOT,
        assetsRoot,
        definition: DEFINITION,
        check: true,
      }),
    );
    const manifest = JSON.parse(
      readFileSync(
        path.join(assetsRoot, "manifests/duel-presentation-assets.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      manifest,
      buildCertifiedDuelPresentationRuntimeManifest(DEFINITION),
    );
    assert.equal(manifest.activations[0].state, "active");
    assert.deepEqual(manifest.activations[0].rollback, {
      equippedModelPath: null,
      equippedModelPathsByAvatar: {},
      bodyEmotePath: null,
      removeInstalledAssets: true,
    });
  });
});

test("fails closed when either installed half is absent or stale", () => {
  withTemporaryAssets((assetsRoot) => {
    installCertifiedDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const motionPath = path.join(assetsRoot, DEFINITION.motion.destinationPath);
    rmSync(motionPath);
    assert.throws(
      () =>
        installCertifiedDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /harpoon-water-strike.*missing or stale/u,
    );
    writeFileSync(motionPath, Buffer.from("stale"));
    assert.throws(
      () =>
        installCertifiedDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /harpoon-water-strike.*missing or stale/u,
    );
  });
});

test("rejects drifted evidence and unsafe runtime destinations", () => {
  withTemporaryAssets((assetsRoot) => {
    const drifted = structuredClone(DEFINITION);
    drifted.motion.sourceSha256 = "0".repeat(64);
    assert.throws(
      () =>
        installCertifiedDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: drifted,
          check: false,
        }),
      /drifted from its SHA-256 lock/u,
    );

    const unsafe = structuredClone(DEFINITION);
    unsafe.motion.destinationPath = "../outside.glb";
    unsafe.motion.assetUrl = "asset://../outside.glb";
    assert.throws(
      () =>
        installCertifiedDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: unsafe,
          check: false,
        }),
      /normalized relative path/u,
    );
  });
});

test("preserves separately certified activations when refreshing the harpoon", () => {
  withTemporaryAssets((assetsRoot) => {
    installCertifiedDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const manifestPath = path.join(
      assetsRoot,
      "manifests/duel-presentation-assets.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.activations.push({
      activationId: "separately-certified-v1",
      state: "active",
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    installCertifiedDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const refreshed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(
      refreshed.activations.map((activation) => activation.activationId),
      ["steve-harpoon-v1", "separately-certified-v1"],
    );
    assert.doesNotThrow(() =>
      installCertifiedDuelPresentationAssets({
        workspaceRoot: WORKSPACE_ROOT,
        assetsRoot,
        definition: DEFINITION,
        check: true,
      }),
    );
  });
});
