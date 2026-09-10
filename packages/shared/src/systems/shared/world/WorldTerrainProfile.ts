/**
 * Unconnected, explicit terrain-profile contract; importing this changes no world.
 *
 * Future consumers: TerrainSystem height/walkability, TerrainWorker's generated
 * height code, and network manifest/profile admission. The current standalone
 * GPUComputeIntegration heightmap shader uses a DIFFERENT noise/coast algorithm;
 * sharing these values does not establish CPU/worker/GPU height parity.
 *
 * Identity covers these selected parameters, not biome definitions, flat zones,
 * navigation, resource manifests or the source-code closure of a whole world.
 */
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
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
} from "./TerrainHeightParams";

type NumericFields<T> = { readonly [K in keyof T]: number };

export type WorldTerrainProfile = Readonly<{
  schemaVersion: 1;
  algorithm: "terrain-height-params-v1";
  id: string;
  kind: "large-world" | "compact-candidate";
  seed: number;
  /** Nominal getWorldInfo() envelope, NOT exact centered-tile mesh extents. */
  boundsMeaning: "nominal-generation-envelope";
  bounds: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  terrainTileSize: number;
  island: Readonly<{
    centerX: number;
    centerZ: number;
    radius: number;
    falloff: number;
    deepOceanBuffer: number;
    beachProfilePower: number;
  }>;
  height: Readonly<{
    /** Existing MAX_HEIGHT parameter; not a proven bound on generated heights. */
    maxHeightParameter: number;
    terrainScale: number;
    baseOffset: number;
    featureScale: number;
  }>;
  water: Readonly<{ threshold: number; oceanFloorHeight: number }>;
  shoreline: NumericFields<typeof SHORELINE_CONFIG>;
}>;

/** Actual legacy defaults, without an invented compact layout or env reads.
 * TerrainSystem's nominal envelope is ±(100 tiles × 100 m)/2; centered chunks
 * may extend outside it. Island radius is NOT the 10 km envelope's half-width.
 */
export const LARGE_WORLD_TERRAIN_PROFILE: WorldTerrainProfile = Object.freeze({
  schemaVersion: 1,
  algorithm: "terrain-height-params-v1",
  id: "large-world-v1",
  kind: "large-world",
  seed: 0,
  boundsMeaning: "nominal-generation-envelope",
  bounds: Object.freeze({ minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 }),
  terrainTileSize: TERRAIN_CONSTANTS.TERRAIN_TILE_SIZE,
  island: Object.freeze({
    centerX: 0,
    centerZ: 0,
    radius: ISLAND_RADIUS,
    falloff: ISLAND_FALLOFF,
    deepOceanBuffer: ISLAND_DEEP_OCEAN_BUFFER,
    beachProfilePower: BEACH_PROFILE_POWER,
  }),
  height: Object.freeze({
    maxHeightParameter: MAX_HEIGHT,
    terrainScale: TERRAIN_SCALE,
    baseOffset: BASE_OFFSET,
    featureScale: FEATURE_SCALE,
  }),
  water: Object.freeze({
    threshold: TERRAIN_CONSTANTS.WATER_THRESHOLD,
    oceanFloorHeight: OCEAN_FLOOR_HEIGHT,
  }),
  shoreline: Object.freeze({ ...SHORELINE_CONFIG }),
});

function fail(field: string): never {
  throw new Error(`Invalid WorldTerrainProfile: ${field}`);
}

function record(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail(`${field} keys`);
  // Only JSON-style data properties are supported; do not invoke input getters.
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !("value" in d),
    )
  )
    fail(`${field} accessors`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field);
  return value === 0 ? 0 : value; // Canonicalize -0 before serialization.
}

function numericGroup<T extends Readonly<Record<string, number>>>(
  value: unknown,
  shape: T,
  field: string,
): NumericFields<T> {
  const keys = Object.keys(shape);
  const data = record(value, keys, field);
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, finite(data[key], `${field}.${key}`)]),
    ),
  ) as NumericFields<T>;
}

/** Strict complete input only: no partial merge, coercion or unknown fields.
 * Compact inputs are structurally valid authoring candidates, NOT approved land,
 * shoreline containment, navigation or performance. No compact preset is supplied.
 */
export function validateWorldTerrainProfile(
  input: unknown,
): WorldTerrainProfile {
  const base = LARGE_WORLD_TERRAIN_PROFILE;
  const data = record(input, Object.keys(base), "profile");
  if (
    data.schemaVersion !== 1 ||
    data.algorithm !== base.algorithm ||
    data.boundsMeaning !== base.boundsMeaning
  )
    fail("version/algorithm/boundsMeaning");
  if (typeof data.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(data.id))
    fail("id");
  if (data.kind !== "large-world" && data.kind !== "compact-candidate")
    fail("kind");
  const seed = finite(data.seed, "seed");
  // Explicit new wire contract; no change to legacy parseInt/env seed behavior.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    fail("seed must be uint32");
  const bounds = numericGroup(data.bounds, base.bounds, "bounds");
  const terrainTileSize = finite(data.terrainTileSize, "terrainTileSize");
  const island = numericGroup(data.island, base.island, "island");
  const height = numericGroup(data.height, base.height, "height");
  const water = numericGroup(data.water, base.water, "water");
  const shoreline = numericGroup(data.shoreline, base.shoreline, "shoreline");
  if (
    terrainTileSize <= 0 ||
    bounds.minX >= bounds.maxX ||
    bounds.minZ >= bounds.maxZ
  )
    fail("positive tile size and ordered bounds required");
  for (const width of [bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ]) {
    if (
      !Number.isFinite(width) ||
      !Number.isSafeInteger(width / terrainTileSize)
    )
      fail("bounds span must contain an integer number of terrain tiles");
  }
  if (
    island.radius <= 0 ||
    island.falloff <= 0 ||
    island.falloff > island.radius ||
    island.deepOceanBuffer < 0 ||
    island.beachProfilePower <= 0
  )
    fail("island dimensions");
  const nominalExtent = island.radius + island.deepOceanBuffer;
  if (
    !Number.isFinite(nominalExtent) ||
    island.centerX - nominalExtent < bounds.minX ||
    island.centerX + nominalExtent > bounds.maxX ||
    island.centerZ - nominalExtent < bounds.minZ ||
    island.centerZ + nominalExtent > bounds.maxZ
  )
    fail("nominal island extent outside bounds");
  // No assertion that noisy coastline/flat zones fit this nominal radius.
  if (
    height.maxHeightParameter <= 0 ||
    height.terrainScale <= 0 ||
    height.featureScale <= 0 ||
    water.threshold <= water.oceanFloorHeight ||
    water.threshold >= height.maxHeightParameter
  )
    fail("height/water ordering");
  if (
    shoreline.THRESHOLD < 0 ||
    shoreline.THRESHOLD > 1 ||
    shoreline.STRENGTH < 0 ||
    shoreline.STRENGTH > 1 ||
    shoreline.MIN_SLOPE < 0 ||
    shoreline.SLOPE_SAMPLE_DISTANCE <= 0 ||
    shoreline.LAND_BAND <= 0 ||
    shoreline.LAND_MAX_MULTIPLIER <= 0 ||
    shoreline.UNDERWATER_BAND <= 0 ||
    shoreline.UNDERWATER_DEPTH_MULTIPLIER <= 0
  )
    fail("shoreline ranges");
  const profile: WorldTerrainProfile = Object.freeze({
    schemaVersion: 1,
    algorithm: base.algorithm,
    id: data.id,
    kind: data.kind,
    seed,
    boundsMeaning: base.boundsMeaning,
    bounds,
    terrainTileSize,
    island,
    height,
    water,
    shoreline,
  });
  // Reserved legacy ID/kind cannot silently be reused for changed parameters.
  if (
    (profile.kind === "large-world" || profile.id === base.id) &&
    JSON.stringify(profile) !== JSON.stringify(base)
  )
    fail("reserved large-world identity differs");
  return profile;
}

/** Omission alone selects the untouched default; null/unknown selections fail. */
export function resolveWorldTerrainProfile(
  input?: unknown,
): WorldTerrainProfile {
  return input === undefined
    ? LARGE_WORLD_TERRAIN_PROFILE
    : validateWorldTerrainProfile(input);
}

/** Fixed field order, finite numbers and canonical zero; independent of input order. */
export function serializeWorldTerrainProfile(
  profile: WorldTerrainProfile,
): string {
  return JSON.stringify(validateWorldTerrainProfile(profile));
}

export function deserializeWorldTerrainProfile(
  json: string,
): WorldTerrainProfile {
  return validateWorldTerrainProfile(JSON.parse(json) as unknown);
}

/** Domain-separated UTF-8 bytes for caller-owned hashing/handshakes.
 * No crypto implementation or global WebCrypto mutation is installed here.
 */
export function worldTerrainProfileIdentityInput(
  profile: WorldTerrainProfile,
): Uint8Array {
  return new TextEncoder().encode(
    `hyperia-world-terrain-profile-v1\n${serializeWorldTerrainProfile(profile)}`,
  );
}
