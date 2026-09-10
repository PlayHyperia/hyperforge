import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateFishingWorldPresentationAuditManifest } from "./fishing-world-presentation-audit.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = JSON.parse(
  readFileSync(
    path.join(
      workspaceRoot,
      "scripts/active-fishing-world-presentation-audit.json",
    ),
    "utf8",
  ),
);

test("accepts the exact two-item active fishing world-presentation authority", () => {
  const result = validateFishingWorldPresentationAuditManifest(manifest);
  assert.deepEqual(
    result.items.map((item) => item.itemId),
    ["small_fishing_net", "lobster_pot"],
  );
  assert.equal(result.performance.iterations, 180);
});

test("rejects missing, reordered, duplicated, or unsafe item assets", () => {
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        items: manifest.items.slice(1),
      }),
    /manifest is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        items: [...manifest.items].reverse(),
      }),
    /small_fishing_net is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        items: manifest.items.map((item, index) =>
          index === 1
            ? { ...item, worldAsset: manifest.items[0].worldAsset }
            : item,
        ),
      }),
    /lobster_pot is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        items: manifest.items.map((item, index) =>
          index === 0 ? { ...item, heldAsset: "../escape.glb" } : item,
        ),
      }),
    /small_fishing_net is invalid/u,
  );
});

test("rejects timing drift and weakened performance gates", () => {
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        pose: {
          ...manifest.pose,
          minimumActionArmDeviationDegrees: 5,
        },
      }),
    /manifest is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        retrievalPickupDelaySeconds: 0.5,
      }),
    /manifest is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        items: manifest.items.map((item, index) =>
          index === 0 ? { ...item, releaseDelaySeconds: 0.2 } : item,
        ),
      }),
    /small_fishing_net is invalid/u,
  );
  assert.throws(
    () =>
      validateFishingWorldPresentationAuditManifest({
        ...manifest,
        performance: {
          ...manifest.performance,
          maximumP95FrameWorkMs: 21,
        },
      }),
    /manifest is invalid/u,
  );
});
