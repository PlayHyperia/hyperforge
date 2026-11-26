import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCertifiedFishingInteractionPresentationAssets } from "./install-certified-fishing-interaction-presentation-assets.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const definition = JSON.parse(
  readFileSync(
    path.join(
      workspaceRoot,
      "scripts/certified-fishing-interaction-presentation-asset-install.json",
    ),
    "utf8",
  ),
);

test("installs and verifies the exact certified fishing-interaction activation", () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-fishing-interaction-install-"),
  );
  try {
    for (const authority of [
      definition.itemsManifest,
      definition.runtimeManifest,
    ]) {
      const destination = path.join(temporaryRoot, authority.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(
        path.join(
          workspaceRoot,
          "packages/server/world/assets",
          authority.path,
        ),
        destination,
      );
    }
    const existingFishingMotion = path.join(
      temporaryRoot,
      "emotes/emote-steve-fishing-cast.glb",
    );
    mkdirSync(path.dirname(existingFishingMotion), { recursive: true });
    cpSync(
      path.join(
        workspaceRoot,
        "packages/server/world/assets/emotes/emote-steve-fishing-cast.glb",
      ),
      existingFishingMotion,
    );

    const installed = installCertifiedFishingInteractionPresentationAssets({
      workspaceRoot,
      assetsRoot: temporaryRoot,
      definition,
      check: false,
    });
    assert.equal(installed.activationCount, 3);
    assert.equal(installed.installed.length, 8);
    assert.doesNotThrow(() =>
      installCertifiedFishingInteractionPresentationAssets({
        workspaceRoot,
        assetsRoot: temporaryRoot,
        definition,
        check: true,
      }),
    );

    const tools = JSON.parse(
      readFileSync(
        path.join(temporaryRoot, definition.itemsManifest.path),
        "utf8",
      ),
    );
    assert.equal(
      tools.find((item) => item.id === "small_fishing_net").modelPath,
      "asset://models/tools/fishing-interactions/small-fishing-net-world.glb",
    );
    assert.equal(
      tools.find((item) => item.id === "lobster_pot")
        .gatheringModelPathsByAvatar.steve,
      "asset://models/tools/fishing-interactions/lobster-pot-steve-fitted.glb",
    );
    const runtime = JSON.parse(
      readFileSync(
        path.join(temporaryRoot, definition.runtimeManifest.path),
        "utf8",
      ),
    );
    assert.deepEqual(
      runtime.activations.slice(-3).map((entry) => entry.activationId),
      [
        "steve-fly-fishing-rod-v1",
        "steve-small-fishing-net-v1",
        "steve-lobster-pot-v1",
      ],
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
