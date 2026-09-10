import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBounds, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import type {
  ModelBoundsManifest,
  StationsManifest,
} from "../../../../data/StationDataProvider";
import { STATION_GROUND_CLEARANCE } from "../../entities/StationSpawnerSystem";

const assets = new URL(
  "../../../../../../server/world/assets/",
  import.meta.url,
);
const manifest = JSON.parse(
  readFileSync(new URL("manifests/stations.json", assets), "utf8"),
) as StationsManifest;
const boundsManifest = JSON.parse(
  readFileSync(new URL("manifests/model-bounds.json", assets), "utf8"),
) as ModelBoundsManifest;

describe("authored station model grounding", () => {
  it("covers every launch station family", () => {
    expect(manifest.stations.map((station) => station.type).sort()).toEqual([
      "altar",
      "anvil",
      "bank",
      "furnace",
      "range",
      "runecrafting_altar",
    ]);
  });

  for (const station of manifest.stations) {
    it(`grounds the actual ${station.type} GLB using its runtime scale, offset and entity clearance`, async () => {
      expect(station.model).toMatch(/^asset:\/\/models\/stations\//);
      const document = await new NodeIO().read(
        fileURLToPath(new URL(station.model!.slice("asset://".length), assets)),
      );
      const scene = document.getRoot().getDefaultScene();
      expect(scene).not.toBeNull();
      // Real GLB vertex data and node transforms, not a generated test model or
      // trusted bounding-box metadata. Static stations must remain unskinned.
      expect(document.getRoot().listSkins()).toHaveLength(0);
      expect(document.getRoot().listAnimations()).toHaveLength(0);
      const bounds = getBounds(scene!);
      expect(bounds.min.every(Number.isFinite)).toBe(true);
      expect(bounds.max.every(Number.isFinite)).toBe(true);
      const recorded = boundsManifest.models.find(
        (entry) => entry.assetPath === station.model,
      );
      expect(recorded).toBeDefined();
      for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
        expect(bounds.min[index]).toBeCloseTo(recorded!.bounds.min[axis], 6);
        expect(bounds.max[index]).toBeCloseTo(recorded!.bounds.max[axis], 6);
      }
      const baseAboveGround =
        bounds.min[1] * station.modelScale +
        station.modelYOffset +
        STATION_GROUND_CLEARANCE;
      expect(Math.abs(baseAboveGround)).toBeLessThanOrEqual(0.000001);
      // Mesh contact across its footprint still needs real rendered-terrain
      // verification; this test isolates the authored static-model origin.
    });
  }
});
