import assert from "node:assert/strict";
import test from "node:test";

import {
  createFishingToolCandidateScene,
  exportFishingToolCandidate,
  inspectFishingToolCandidate,
} from "./build-hyperia-fishing-tool-candidates.mjs";

const EXPECTED = Object.freeze({
  small_fishing_net: {
    meshCount: 46,
    materialCount: 3,
    vertices: 1_981,
    triangles: 1_464,
    maximumLongestDimension: 1,
  },
  harpoon: {
    meshCount: 10,
    materialCount: 3,
    vertices: 475,
    triangles: 394,
    maximumLongestDimension: 2,
  },
  lobster_pot: {
    meshCount: 82,
    materialCount: 4,
    vertices: 2_965,
    triangles: 1_796,
    maximumLongestDimension: 1,
  },
});

test("builds exact readable fishing-tool geometry within launch budgets", () => {
  for (const [itemId, expected] of Object.entries(EXPECTED)) {
    const root = createFishingToolCandidateScene(itemId);
    const inspection = inspectFishingToolCandidate(root);
    assert.deepEqual(
      {
        meshCount: inspection.meshCount,
        materialCount: inspection.materialCount,
        vertices: inspection.vertices,
        triangles: inspection.triangles,
      },
      {
        meshCount: expected.meshCount,
        materialCount: expected.materialCount,
        vertices: expected.vertices,
        triangles: expected.triangles,
      },
    );
    assert.ok(
      Math.max(...inspection.bounds.size) <= expected.maximumLongestDimension,
    );
    assert.deepEqual(root.userData.hyperia, {
      schemaVersion: 1,
      itemId,
      source: "deterministic-repository-authored-geometry",
      externalGeometry: false,
      externalTextures: false,
      activationStatus: "not-activated",
      fishingWorld: {
        schemaVersion: 1,
        itemId,
        placement:
          itemId === "small_fishing_net"
            ? {
                positionOffset: [0, 0.02, 0.66],
                rotationEulerDegrees: [-90, 0, 0],
                scale: 1,
              }
            : itemId === "lobster_pot"
              ? {
                  positionOffset: [0, 0, 0],
                  rotationEulerDegrees: [0, 0, 0],
                  scale: 1,
                }
              : null,
      },
    });
  }
});

test("exports byte-stable GLBs with zero Khronos findings", async () => {
  for (const itemId of Object.keys(EXPECTED)) {
    const first = await exportFishingToolCandidate(itemId);
    const second = await exportFishingToolCandidate(itemId);
    assert.ok(first.output.equals(second.output));
    assert.deepEqual(first.validator, {
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
    });
  }
});

test("rejects an undeclared fishing-tool identity", () => {
  assert.throws(
    () => createFishingToolCandidateScene("generic_fishing_prop"),
    /Unsupported fishing-tool candidate/u,
  );
});
