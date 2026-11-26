import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCertifiedPreparationActivation,
  installCertifiedPreparationPresentationAssets,
} from "./install-certified-preparation-presentation-assets.mjs";

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
      "scripts/certified-preparation-presentation-asset-install.json",
    ),
    "utf8",
  ),
);

function seedManifest(assetsRoot, relativePath) {
  const destination = path.join(assetsRoot, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(SOURCE_ASSETS_ROOT, relativePath), destination);
}

function withTemporaryAssets(run) {
  const assetsRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-preparation-presentation-"),
  );
  seedManifest(assetsRoot, DEFINITION.itemsManifest.path);
  seedManifest(assetsRoot, DEFINITION.runtimeManifest.path);
  try {
    return run(assetsRoot);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
}

test("installs every locked payload before publishing the combined activation", () => {
  withTemporaryAssets((assetsRoot) => {
    const result = installCertifiedPreparationPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    assert.equal(result.activationCount, 13);
    assert.equal(result.installed.length, 16);
    assert.doesNotThrow(() =>
      installCertifiedPreparationPresentationAssets({
        workspaceRoot: WORKSPACE_ROOT,
        assetsRoot,
        definition: DEFINITION,
        check: true,
      }),
    );

    const runtime = JSON.parse(
      readFileSync(
        path.join(assetsRoot, DEFINITION.runtimeManifest.path),
        "utf8",
      ),
    );
    const optionalPreservedIds = new Set(
      DEFINITION.runtimeManifest.optionalPreserveActivationIds,
    );
    const optionalPreservedCount = runtime.activations.filter((activation) =>
      optionalPreservedIds.has(activation.activationId),
    ).length;
    assert.equal(runtime.activations.length, 14 + optionalPreservedCount);
    assert.equal(runtime.activations[0].activationId, "steve-harpoon-v1");
    assert.deepEqual(
      runtime.activations
        .filter(
          (activation) =>
            activation.activationGroupId === DEFINITION.activationGroupId,
        )
        .map((activation) => activation.itemId),
      DEFINITION.families.flatMap((family) => family.itemIds),
    );
    for (const activation of runtime.activations.filter(
      (candidate) =>
        candidate.activationGroupId === DEFINITION.activationGroupId,
    )) {
      assert.equal(activation.state, "active");
      assert.equal(activation.slot, "gatheringtool");
      assert.equal(activation.motion.loopSeamExact, true);
      assert.deepEqual(activation.rollback.gatheringModelPathsByAvatar, {});
    }
  });
});

test("adds gathering fits without replacing dual-role combat model paths", () => {
  withTemporaryAssets((assetsRoot) => {
    const before = JSON.parse(
      readFileSync(path.join(assetsRoot, DEFINITION.itemsManifest.path)),
    );
    installCertifiedPreparationPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const after = JSON.parse(
      readFileSync(path.join(assetsRoot, DEFINITION.itemsManifest.path)),
    );
    for (const itemId of DEFINITION.families.flatMap(
      (family) => family.itemIds,
    )) {
      const prior = before.find((item) => item.id === itemId);
      const active = after.find((item) => item.id === itemId);
      assert.equal(active.equippedModelPath, prior.equippedModelPath, itemId);
      assert.match(
        active.gatheringModelPathsByAvatar.steve,
        new RegExp(`${itemId.replaceAll("_", "-")}-steve-fitted\\.glb$`, "u"),
        itemId,
      );
    }
  });
});

test("check fails closed when an installed payload is absent or stale", () => {
  withTemporaryAssets((assetsRoot) => {
    const result = installCertifiedPreparationPresentationAssets({
      workspaceRoot: WORKSPACE_ROOT,
      assetsRoot,
      definition: DEFINITION,
      check: false,
    });
    const target = path.join(assetsRoot, result.installed[0].path);
    rmSync(target);
    assert.throws(
      () =>
        installCertifiedPreparationPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /missing or stale/u,
    );
    writeFileSync(target, Buffer.from("stale"));
    assert.throws(
      () =>
        installCertifiedPreparationPresentationAssets({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
          check: true,
        }),
      /missing or stale/u,
    );
  });
});

test("rejects drifted evidence and unowned runtime activations", () => {
  withTemporaryAssets((assetsRoot) => {
    const drifted = structuredClone(DEFINITION);
    drifted.reports.motions.sha256 = "0".repeat(64);
    assert.throws(
      () =>
        buildCertifiedPreparationActivation({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: drifted,
        }),
      /drifted from its SHA-256 lock/u,
    );

    const runtimePath = path.join(assetsRoot, DEFINITION.runtimeManifest.path);
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    runtime.activations.push({ activationId: "unowned-v1" });
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    assert.throws(
      () =>
        buildCertifiedPreparationActivation({
          workspaceRoot: WORKSPACE_ROOT,
          assetsRoot,
          definition: DEFINITION,
        }),
      /unowned activation/u,
    );
  });
});
