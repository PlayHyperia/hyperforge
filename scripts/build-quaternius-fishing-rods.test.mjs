import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as THREE from "three";

import {
  inspectFishingRodCandidate,
  validateFishingRodSourceManifest,
} from "./build-quaternius-fishing-rods.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(
    path.join(workspaceRoot, "scripts/quaternius-fishing-rod-sources.json"),
    "utf8",
  ),
);

test("locks five isolated CC0 rod sources without activating runtime paths", () => {
  const candidates = validateFishingRodSourceManifest(manifest, workspaceRoot);
  assert.equal(candidates.length, 5);
  assert.deepEqual(
    candidates.map((candidate) => candidate.intendedRuntimeItemId),
    ["fishing_rod", "fly_fishing_rod", null, null, null],
  );
  assert.equal(manifest.activationStatus, "not-activated");
});

test("rejects activation claims and source hash drift", () => {
  assert.throws(
    () =>
      validateFishingRodSourceManifest(
        { ...manifest, activationStatus: "active" },
        workspaceRoot,
      ),
    /source manifest is invalid/u,
  );
  const drifted = structuredClone(manifest);
  drifted.candidates[0].obj.sha256 = "0".repeat(64);
  assert.throws(
    () => validateFishingRodSourceManifest(drifted, workspaceRoot),
    /SHA-256 drifted/u,
  );

  const reassigned = structuredClone(manifest);
  reassigned.candidates[0].intendedRuntimeItemId = "harpoon";
  assert.throws(
    () => validateFishingRodSourceManifest(reassigned, workspaceRoot),
    /candidate 0 is invalid/u,
  );

  const previewDrifted = structuredClone(manifest);
  previewDrifted.sourcePreview.sha256 = "invalid";
  assert.throws(
    () => validateFishingRodSourceManifest(previewDrifted, workspaceRoot),
    /source manifest is invalid/u,
  );

  const duplicatedSource = structuredClone(manifest);
  duplicatedSource.candidates[1].obj.fileId =
    duplicatedSource.candidates[0].obj.fileId;
  assert.throws(
    () => validateFishingRodSourceManifest(duplicatedSource, workspaceRoot),
    /Duplicate fishing-rod source file ID/u,
  );
});

test("rejects empty or non-triangulated candidate geometry", () => {
  assert.throws(
    () => inspectFishingRodCandidate(new THREE.Group()),
    /candidate geometry is invalid/u,
  );
  const invalid = new THREE.Group();
  invalid.add(
    new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
          3,
        ),
      ),
      new THREE.MeshBasicMaterial(),
    ),
  );
  assert.throws(() => inspectFishingRodCandidate(invalid), /not triangulated/u);
});
