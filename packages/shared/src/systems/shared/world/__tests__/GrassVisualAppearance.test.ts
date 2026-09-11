import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  COMPACT_MEADOW_APPEARANCE,
  GRASS_CONFIG,
  GrassVisualManager,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassVisualProfile,
  type GrassWorkerSetup,
} from "../GrassVisualManager";
import { SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";

/** Real geometry/material construction; no renderer or GPU is simulated. */
function manager(profile: GrassVisualProfile = {}) {
  const terrain = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
  const config = createTerrainWorkerConfig(terrain, 16);
  const setup: GrassWorkerSetup = {
    terrainConfig: config,
    seed: terrain.seed,
    biomeCenters: [],
    biomes: {},
    grassConfigs: {},
    tileSize: terrain.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: () => {
      throw new Error("Appearance construction must not generate placements");
    },
  };
  return new GrassVisualManager(
    config.TERRAIN_PROFILE_IDENTITY,
    new THREE.Group(),
    () => null,
    () => 28,
    terrain.water.threshold,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.4,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
    }),
    setup,
    profile,
  );
}

function geometryBytes(geometry: THREE.BufferGeometry) {
  return (
    Object.values(geometry.attributes).reduce(
      (sum, attribute) => sum + attribute.array.byteLength,
      0,
    ) + geometry.index!.array.byteLength
  );
}

// Generated from the actual constructor at pushed checkpoint 2bc7c5a898984090.
// Position/normal/UV/index bytes in that order; no GPU or rendering assertion.
const legacyGeometryHashes = [
  "30d43cae657ad1a55190ed6e23dda8cc7973ee4bb684a248e9d39ee851f5a109",
  "06e6a222140aa84141061eb5775b6dc46a84a8a739b69d8ee00450de8b695b2d",
  "b6d82f6b4b98e0d3a5a40813c6a5f8bac7ff94559df4e77f058a1aba4ae4a26c",
];

describe("compact meadow appearance candidate (CPU only)", () => {
  it("leaves ordinary and fixed-arena geometry/material behavior identical", () => {
    const ordinary = manager();
    const fixed = manager(STREAMING_GRASS_VISUAL_PROFILE);
    try {
      for (let lod = 0; lod < GRASS_CONFIG.LOD_TIERS.length; lod++) {
        const a = ordinary["lodGeometries"][lod];
        const b = fixed["lodGeometries"][lod];
        const hash = createHash("sha256");
        for (const attribute of [
          a.attributes.position,
          a.attributes.normal,
          a.attributes.uv,
          a.index!,
        ]) {
          const values = attribute.array;
          hash.update(
            new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
          );
        }
        expect(hash.digest("hex")).toBe(legacyGeometryHashes[lod]);
        expect(b.index!.array).toEqual(a.index!.array);
        for (const key of Object.keys(a.attributes))
          expect(b.attributes[key].array).toEqual(a.attributes[key].array);
      }
      expect(ordinary["material"].name).toBe("legacy-blades-v1");
      expect(fixed["material"].name).toBe("legacy-blades-v1");
    } finally {
      ordinary.destroy();
      fixed.destroy();
    }
  });

  it("preserves topology, buffer bytes, deterministic blade roots and UVs at every LOD", () => {
    const baseline = manager();
    const candidate = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    const repeat = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    try {
      for (const [lod, tier] of GRASS_CONFIG.LOD_TIERS.entries()) {
        const before = baseline["lodGeometries"][lod];
        const after = candidate["lodGeometries"][lod];
        expect(after.index!.array).toEqual(before.index!.array);
        expect(after.attributes.uv.array).toEqual(before.attributes.uv.array);
        expect(after.attributes.normal.array).toEqual(
          before.attributes.normal.array,
        );
        expect(Object.keys(after.attributes)).toEqual(
          Object.keys(before.attributes),
        );
        expect(geometryBytes(after)).toBe(geometryBytes(before));
        expect(after.attributes.position.array).toEqual(
          repeat["lodGeometries"][lod].attributes.position.array,
        );
        const oldPosition = before.attributes.position;
        const newPosition = after.attributes.position;
        const vertsPerBlade = tier.bladeSegments * 2 + 1;
        for (let blade = 0; blade < tier.bladesPerClump; blade++) {
          const root = blade * vertsPerBlade;
          for (const get of ["getX", "getZ"] as const) {
            const oldCenter =
              (oldPosition[get](root) + oldPosition[get](root + 1)) / 2;
            const newCenter =
              (newPosition[get](root) + newPosition[get](root + 1)) / 2;
            expect(Math.abs(oldCenter - newCenter)).toBeLessThan(6e-8);
          }
          expect(newPosition.getY(root)).toBe(0);
          expect(newPosition.getY(root + 1)).toBe(0);
          const tip = root + vertsPerBlade - 1;
          const height = newPosition.getY(tip);
          expect(height).toBeGreaterThan(0.2);
          expect(height).toBeLessThan(0.73);
          expect(height).toBeLessThan(oldPosition.getY(tip));
          const width = Math.hypot(
            newPosition.getX(root + 1) - newPosition.getX(root),
            newPosition.getZ(root + 1) - newPosition.getZ(root),
          );
          expect(width / height).toBeCloseTo(
            COMPACT_MEADOW_APPEARANCE.BLADE_WIDTH_RATIO,
            6,
          );
        }
        for (const value of newPosition.array)
          expect(Number.isFinite(value)).toBe(true);
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        for (let index = 0; index < after.index!.count; index += 3) {
          a.fromBufferAttribute(newPosition, after.index!.getX(index));
          b.fromBufferAttribute(newPosition, after.index!.getX(index + 1));
          c.fromBufferAttribute(newPosition, after.index!.getX(index + 2));
          expect(b.sub(a).cross(c.sub(a)).length()).toBeGreaterThan(1e-5);
        }
      }
      expect(candidate["lodGeometries"][1].attributes.position.count).toBe(60);
      expect(candidate["lodGeometries"][1].index!.count / 3).toBe(36);
    } finally {
      baseline.destroy();
      candidate.destroy();
      repeat.destroy();
    }
  });

  it("uses one opaque PBR material without adding texture inputs", () => {
    const owner = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    try {
      const material = owner["material"];
      expect(material.name).toBe(COMPACT_MEADOW_APPEARANCE.id);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      expect(material.side).toBe(THREE.DoubleSide);
      expect(material.roughness).toBe(1);
      expect(material.metalness).toBe(0);
      expect(material.fog).toBe(false);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.alphaMap).toBeNull();
      expect(material.emissive.getHex()).toBe(0);
      expect(material.positionNode).toBeTruthy();
      expect(material.colorNode).toBeTruthy();
      expect(owner["maxRenderDistance"]).toBe(140);
      expect(owner["minimumLodLevel"]).toBe(1);
      expect(owner["clumpSpacing"]).toBe(2.8);
      expect(owner["maxChunksPerFrame"]).toBe(1);
    } finally {
      owner.destroy();
    }
  });
});
