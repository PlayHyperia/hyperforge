import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCertifiedBowDuelPresentationAssets } from "./install-certified-bow-duel-presentation-assets.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ASSETS_ROOT = path.join(
  WORKSPACE_ROOT,
  "packages/server/world/assets",
);
const DEFINITION = JSON.parse(
  readFileSync(
    path.join(
      WORKSPACE_ROOT,
      "scripts/certified-bow-duel-presentation-asset-install.json",
    ),
    "utf8",
  ),
);

function withTemporaryAssets(run) {
  const assetsRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-certified-bow-duel-"),
  );
  mkdirSync(path.join(assetsRoot, "models/bows"), { recursive: true });
  cpSync(
    path.join(SOURCE_ASSETS_ROOT, "models/bows/bow-wood"),
    path.join(assetsRoot, "models/bows/bow-wood"),
    { recursive: true },
  );
  try {
    return run(assetsRoot);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
}

test("installs only the three hash-locked canonical bow-duel motions", () => {
  withTemporaryAssets((assetsRoot) => {
    const result = installCertifiedBowDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    assert.equal(result.activationId, "steve-bow-duel-natural-v1");
    assert.deepEqual(
      result.installed.map(({ id, path: installedPath, sha256 }) => ({
        id,
        path: installedPath,
        sha256,
      })),
      DEFINITION.motions.map((motion) => ({
        id: motion.id,
        path: motion.destinationPath,
        sha256: motion.sha256,
      })),
    );
    assert.doesNotThrow(() =>
      installCertifiedBowDuelPresentationAssets({
        workspaceRoot: WORKSPACE_ROOT,
        assetsRoot,
        definition: DEFINITION,
        check: true,
      }),
    );
    for (const motion of DEFINITION.motions) {
      assert.ok(!motion.destinationPath.includes("candidates"));
      assert.deepEqual(
        readFileSync(path.join(assetsRoot, motion.destinationPath)),
        readFileSync(path.join(WORKSPACE_ROOT, motion.sourcePath)),
      );
    }
  });
});

test("fails closed when a canonical runtime motion is missing or stale", () => {
  withTemporaryAssets((assetsRoot) => {
    installCertifiedBowDuelPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const destination = path.join(
      assetsRoot,
      DEFINITION.motions[1].destinationPath,
    );
    rmSync(destination);
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /emote-bow-duel-walk-steve\.glb is missing or stale/u,
    );
    writeFileSync(destination, Buffer.from("stale"));
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /emote-bow-duel-walk-steve\.glb is missing or stale/u,
    );
  });
});

test("rejects evidence drift and unsafe canonical destinations", () => {
  withTemporaryAssets((assetsRoot) => {
    const drifted = structuredClone(DEFINITION);
    drifted.candidateReport.sha256 = "0".repeat(64);
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: drifted,
          check: false,
        }),
      /bow locomotion candidate report drifted/u,
    );

    const unsafe = structuredClone(DEFINITION);
    unsafe.motions[0].destinationPath = "../outside.glb";
    unsafe.motions[0].assetUrl = "asset://../outside.glb";
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: unsafe,
          check: false,
        }),
      /normalized relative path/u,
    );
  });
});

test("rejects an incomplete exact-angle attack or hit-reaction matrix", () => {
  withTemporaryAssets((assetsRoot) => {
    const incomplete = structuredClone(DEFINITION);
    const review = incomplete.evidence.browserReviews.find(
      (entry) => entry.id === "shortbow-combat-multiview",
    );
    review.hitReactionSampleCount = 15;
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: incomplete,
          check: false,
        }),
      /does not cover the exact attack\/hit-reaction matrix/u,
    );
  });
});

test("rejects an active bow whose geometry no longer matches visual review", () => {
  withTemporaryAssets((assetsRoot) => {
    const activePath = path.join(
      assetsRoot,
      DEFINITION.equipment[0].activePath,
    );
    const bytes = Buffer.from(readFileSync(activePath));
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(activePath, bytes);
    const changed = structuredClone(DEFINITION);
    changed.equipment[0].activeSha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");
    assert.throws(
      () =>
        installCertifiedBowDuelPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: changed,
          check: false,
        }),
      /active geometry does not match reviewed geometry/u,
    );
  });
});
