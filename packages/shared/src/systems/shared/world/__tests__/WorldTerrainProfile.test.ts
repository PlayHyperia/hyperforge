import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERRAIN_CONSTANTS } from "../../../../constants/GameConstants";
import {
  BASE_OFFSET,
  BEACH_PROFILE_POWER,
  FEATURE_SCALE,
  ISLAND_DEEP_OCEAN_BUFFER,
  ISLAND_FALLOFF,
  ISLAND_RADIUS,
  MAX_HEIGHT,
  OCEAN_FLOOR_HEIGHT,
  SHORELINE_CONFIG,
  TERRAIN_SCALE,
} from "../TerrainHeightParams";
import {
  LARGE_WORLD_TERRAIN_PROFILE as large,
  deserializeWorldTerrainProfile,
  resolveWorldTerrainProfile,
  serializeWorldTerrainProfile,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentityInput,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

type MutableProfile = {
  -readonly [
    K in keyof WorldTerrainProfile
  ]: WorldTerrainProfile[K] extends Readonly<Record<string, number>>
    ? { -readonly [P in keyof WorldTerrainProfile[K]]: number }
    : WorldTerrainProfile[K];
};

function copy(): MutableProfile {
  return JSON.parse(JSON.stringify(large)) as MutableProfile;
}

// Validation fixture ONLY; not a supplied layout, shoreline or performance preset.
function compactInput() {
  return {
    ...copy(),
    id: "compact-validation-fixture",
    kind: "compact-candidate" as const,
    bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
    island: { ...large.island, radius: 100, falloff: 25, deepOceanBuffer: 20 },
  };
}

describe("WorldTerrainProfile isolated contract", () => {
  it("matches actual shared height/shore/water constants, not the stale manifest", () => {
    expect(large.island).toEqual({
      centerX: 0,
      centerZ: 0,
      radius: ISLAND_RADIUS,
      falloff: ISLAND_FALLOFF,
      deepOceanBuffer: ISLAND_DEEP_OCEAN_BUFFER,
      beachProfilePower: BEACH_PROFILE_POWER,
    });
    expect(large.height).toEqual({
      maxHeightParameter: MAX_HEIGHT,
      terrainScale: TERRAIN_SCALE,
      baseOffset: BASE_OFFSET,
      featureScale: FEATURE_SCALE,
    });
    expect(large.water).toEqual({
      threshold: TERRAIN_CONSTANTS.WATER_THRESHOLD,
      oceanFloorHeight: OCEAN_FLOOR_HEIGHT,
    });
    expect(large.shoreline).toEqual(SHORELINE_CONFIG);
    expect(large.terrainTileSize).toBe(TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE);
    expect(large.seed).toBe(0);
  });

  it("records TerrainSystem's nominal envelope, not the centered mesh endpoint", () => {
    const source = readFileSync(
      new URL("../TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    const worldSize = source.match(/WORLD_SIZE:\s*(\d+),/);
    const islandSize = source.match(/ISLAND_MAX_WORLD_SIZE_TILES:\s*(\d+),/);
    expect(worldSize?.[1]).toBe("100");
    expect(islandSize?.[1]).toBe("100");
    expect(source).toContain(
      "min: { x: -worldSizeMeters / 2, z: -worldSizeMeters / 2 }",
    );
    const halfWidth =
      (Number(islandSize?.[1]) * TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE) / 2;
    expect(large.bounds).toEqual({
      minX: -halfWidth,
      maxX: halfWidth,
      minZ: -halfWidth,
      maxZ: halfWidth,
    });
    expect(large.boundsMeaning).toBe("nominal-generation-envelope");
  });

  it("selects default only on omission and freezes every nested numeric group", () => {
    expect(resolveWorldTerrainProfile()).toBe(large);
    for (const value of [
      large,
      large.bounds,
      large.island,
      large.height,
      large.water,
      large.shoreline,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(large.bounds, "minX", 0)).toBe(false);
    for (const input of [null, "compact", {}, [], false])
      expect(() => resolveWorldTerrainProfile(input)).toThrow();
  });

  it("admits only complete explicit compact inputs and owns an immutable copy", () => {
    const input = compactInput();
    const before = JSON.stringify(input);
    const profile = resolveWorldTerrainProfile(input);
    expect(profile.kind).toBe("compact-candidate");
    expect(JSON.stringify(input)).toBe(before);
    expect(profile.island).not.toBe(input.island);
    input.island.radius = 10;
    expect(profile.island.radius).toBe(100);
    expect(Object.isFrozen(profile.island)).toBe(true);
    expect(large.island.radius).toBe(ISLAND_RADIUS);
    expect(() =>
      resolveWorldTerrainProfile({ id: "compact", kind: "compact-candidate" }),
    ).toThrow();
  });

  it("has stable domain-separated hash input across key order and JSON roundtrips", () => {
    const profile = validateWorldTerrainProfile(compactInput());
    const shuffled = Object.fromEntries(
      Object.entries(profile)
        .reverse()
        .map(([key, value]) => [
          key,
          value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
        ]),
    );
    const reordered = validateWorldTerrainProfile(shuffled);
    expect(serializeWorldTerrainProfile(profile)).toBe(
      serializeWorldTerrainProfile(reordered),
    );
    expect(
      deserializeWorldTerrainProfile(serializeWorldTerrainProfile(profile)),
    ).toEqual(profile);
    const bytes = worldTerrainProfileIdentityInput(profile);
    expect(new TextDecoder().decode(bytes)).toBe(
      `hyperia-world-terrain-profile-v1\n${serializeWorldTerrainProfile(profile)}`,
    );
    const digest = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    expect(digest(bytes)).toBe(
      digest(worldTerrainProfileIdentityInput(reordered)),
    );
    expect(digest(bytes)).not.toBe(
      digest(
        worldTerrainProfileIdentityInput(
          validateWorldTerrainProfile({ ...profile, seed: 1 }),
        ),
      ),
    );
    bytes.fill(0);
    expect(worldTerrainProfileIdentityInput(profile)[0]).toBe(
      "h".charCodeAt(0),
    );
  });

  it("canonicalizes negative zero without changing positive/negative coordinates", () => {
    const profile = validateWorldTerrainProfile({
      ...compactInput(),
      seed: -0,
      island: { ...compactInput().island, centerX: -0 },
    });
    expect(Object.is(profile.seed, -0)).toBe(false);
    expect(Object.is(profile.island.centerX, -0)).toBe(false);
    expect(profile.bounds.minX).toBe(-200);
  });

  it("does not reuse the reserved large-world ID or kind for different data", () => {
    expect(() => validateWorldTerrainProfile({ ...copy(), seed: 1 })).toThrow(
      /reserved/,
    );
    expect(() =>
      validateWorldTerrainProfile({ ...compactInput(), id: large.id }),
    ).toThrow(/reserved/);
    expect(() =>
      validateWorldTerrainProfile({ ...compactInput(), kind: "large-world" }),
    ).toThrow(/reserved/);
    expect(
      deserializeWorldTerrainProfile(serializeWorldTerrainProfile(large)),
    ).toEqual(large);
  });

  it.each([-1, 1.5, 0x100000000, Infinity, NaN, "0", null])(
    "rejects invalid wire seed %s",
    (seed) => {
      expect(() =>
        validateWorldTerrainProfile({ ...compactInput(), seed }),
      ).toThrow();
    },
  );

  it.each([0, 1, 0xffffffff])("admits exact uint32 wire seed %s", (seed) => {
    expect(validateWorldTerrainProfile({ ...compactInput(), seed }).seed).toBe(
      seed,
    );
  });

  it("rejects unknown/missing keys, wrong versions, getters and non-JSON records", () => {
    const missing: Partial<MutableProfile> = compactInput();
    delete missing.water;
    for (const input of [
      missing,
      { ...compactInput(), extra: 1 },
      { ...compactInput(), schemaVersion: 2 },
      { ...compactInput(), algorithm: "old-gpu" },
      { ...compactInput(), boundsMeaning: "mesh-extent" },
      { ...compactInput(), id: "../other-world" },
      { ...compactInput(), island: { ...large.island, extra: 0 } },
      new Date(),
    ])
      expect(() => validateWorldTerrainProfile(input)).toThrow();
    const getter = compactInput();
    Object.defineProperty(getter, "seed", {
      get: () => {
        throw new Error("must not invoke");
      },
      enumerable: true,
    });
    expect(() => validateWorldTerrainProfile(getter)).toThrow(/accessors/);
    const symbol = { ...compactInput(), [Symbol("hidden")]: 1 };
    expect(() => validateWorldTerrainProfile(symbol)).toThrow(/keys/);
  });

  it("rejects incoherent bounds, island, height, water and shoreline values", () => {
    const input = compactInput();
    const invalid = [
      { terrainTileSize: 0 },
      { terrainTileSize: 3 },
      { bounds: { ...input.bounds, maxX: input.bounds.minX } },
      { bounds: { ...input.bounds, maxX: Infinity } },
      { island: { ...input.island, radius: 0 } },
      { island: { ...input.island, falloff: 101 } },
      { island: { ...input.island, centerX: 190 } },
      { island: { ...input.island, deepOceanBuffer: -1 } },
      { height: { ...input.height, maxHeightParameter: 16 } },
      { height: { ...input.height, terrainScale: 0 } },
      { water: { ...input.water, oceanFloorHeight: 16 } },
      { shoreline: { ...input.shoreline, THRESHOLD: 2 } },
      { shoreline: { ...input.shoreline, SLOPE_SAMPLE_DISTANCE: 0 } },
      { shoreline: { ...input.shoreline, LAND_BAND: NaN } },
    ];
    for (const change of invalid)
      expect(() =>
        validateWorldTerrainProfile({ ...input, ...change }),
      ).toThrow();
    expect(() => deserializeWorldTerrainProfile("not JSON")).toThrow();
  });
});
