/**
 * Explicit terrain-profile contract; importing this selects no runtime world.
 *
 * Consumers supply an explicitly admitted profile to CPU/worker height code.
 * Terrain, navigation and network admission must agree before world startup.
 * The current standalone
 * GPUComputeIntegration heightmap shader uses a DIFFERENT noise/coast algorithm;
 * sharing these values does not establish CPU/worker/GPU height parity.
 *
 * Identity covers these selected parameters, not biome definitions, flat zones,
 * navigation, resource manifests or the source-code closure of a whole world.
 */
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import havenShoulderData from "../../../data/compact-haven-shoulder-v1.json";
import {
  createCompactHavenShoulder,
  type CompactHavenShoulder,
} from "./CompactHavenShoulder";
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
const havenShoulderAdmission = createCompactHavenShoulder();

/** Metre offsets from the island centre at a 165 m authoring radius. */
export const COMPACT_LANDFORM_PARAMETERS = Object.freeze({
  westHeadlandBearing: Math.PI,
  westHeadlandHalfWidth: (35 * Math.PI) / 180,
  westHeadlandStrength: 0.19,
  inletBearing: (48 * Math.PI) / 180,
  inletTipDistance: 84,
  inletTipTransition: 26,
  inletHalfWidth: 42,
  inletBankTransition: 18,
  ridgeStartZ: -65,
  ridgeEndZ: 75,
  ridgeBaseX: -82,
  ridgeBend: 30,
  ridgeWestWidth: 26,
  ridgeEastWidth: 48,
  ridgeHeight: 18,
  ridgeEndFade: 35,
});

/** Sculpt-v3 bay shape, inside the unchanged sculpt-v2 refinement envelope. */
export const COMPACT_BAY_PARAMETERS = Object.freeze({
  innerHalfWidth: 24,
  centerlineBend: 8,
  leftBankScale: 0.95,
  rightBankScale: 1.1,
});

/** Sculpt-v4 rocky terrace; metre offsets at the same 165 m authoring radius. */
export const COMPACT_TERRACE_PARAMETERS = Object.freeze({
  startZ: -50,
  endZ: 60,
  endFade: 12,
  westFoot: -26,
  crestStart: -6,
  crestEnd: 2,
  crestHeight: 20,
  scarpRun: 10,
  shelfWidth: 13,
  shelfHeight: 11,
  apronWidth: 21,
  eastPreservationStart: -76,
  eastPreservationEnd: -70,
});

/** Sculpt-v5 outcrops and saddles, within the existing refined western ridge. */
export const COMPACT_RIDGE_BREAKUP_PARAMETERS = Object.freeze({
  northGapZ: -15,
  northGapHalfWidth: 20,
  northGapDepth: 0.72,
  southGapZ: 26,
  southGapHalfWidth: 20,
  southGapDepth: 0.58,
  lateralWarp: 4,
  warpWavelength: 96,
  facetRelief: 0.6,
  facetScale: 0.06,
});

export type WorldTerrainProfile = Readonly<{
  schemaVersion: 1;
  algorithm:
    | "terrain-height-params-v1"
    | "compact-island-sculpt-v1"
    | "compact-island-sculpt-v2"
    | "compact-island-sculpt-v3"
    | "compact-island-sculpt-v4"
    | "compact-island-sculpt-v5";
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
    /** Absolute bound on fractional noisy-radius variation, enforced by height code. */
    maxCoastVariation: number;
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
  /** Required by sculpt-v2 and later; included in CPU/worker/content identity. */
  landform?: NumericFields<typeof COMPACT_LANDFORM_PARAMETERS>;
  /** Required by sculpt-v3 and later; earlier algorithms cannot carry this group. */
  bay?: NumericFields<typeof COMPACT_BAY_PARAMETERS>;
  /** Required by sculpt-v4 and later; does not alter navigation policy. */
  terrace?: NumericFields<typeof COMPACT_TERRACE_PARAMETERS>;
  /** Required by sculpt-v5; shared by height, navigation and native workers. */
  ridgeBreakup?: NumericFields<typeof COMPACT_RIDGE_BREAKUP_PARAMETERS>;
  /** Explicit bounded authored modifier; omission preserves the v5 base exactly. */
  havenShoulder?: CompactHavenShoulder;
}>;

/** Historical numeric regression fixture only, never a runtime selection.
 * TerrainSystem's nominal envelope is ±(100 tiles × 100 m)/2; centered chunks
 * may extend outside it. Island radius is NOT the 10 km envelope's half-width.
 */
export const LEGACY_TERRAIN_PROFILE_FIXTURE: WorldTerrainProfile =
  Object.freeze({
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
      maxCoastVariation: 0.3,
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

/** Candidate parameters only: consumers must explicitly select and admit it. */
export const COMPACT_WORLD_TERRAIN_PROFILE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...LEGACY_TERRAIN_PROFILE_FIXTURE,
    id: "compact-duel-island-v1",
    kind: "compact-candidate",
    bounds: { minX: 150, maxX: 550, minZ: 200, maxZ: 600 },
    island: {
      centerX: 350,
      centerZ: 400,
      radius: 165,
      falloff: 30,
      deepOceanBuffer: 25,
      beachProfilePower: BEACH_PROFILE_POWER,
      maxCoastVariation: 0.06,
    },
  });

/** Explicit new authoring candidate; v1 remains a numeric regression fixture. */
export const SCULPTED_COMPACT_V1_PROFILE_FIXTURE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...COMPACT_WORLD_TERRAIN_PROFILE,
    algorithm: "compact-island-sculpt-v1",
    id: "compact-duel-island-v2",
    island: {
      ...COMPACT_WORLD_TERRAIN_PROFILE.island,
      falloff: 42,
      deepOceanBuffer: 15,
      maxCoastVariation: 0.12,
    },
    height: {
      maxHeightParameter: 50,
      terrainScale: 12,
      baseOffset: 28.15,
      featureScale: 1.4,
    },
  });

/** Previous rectangular-bay shape, retained only as a regression fixture. */
export const SCULPTED_COMPACT_V2_PROFILE_FIXTURE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
    algorithm: "compact-island-sculpt-v2",
    id: "compact-duel-island-v3",
    landform: COMPACT_LANDFORM_PARAMETERS,
  });

/** Previous smooth ridge with the tapered bay, retained as a regression fixture. */
export const SCULPTED_COMPACT_V3_PROFILE_FIXTURE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
    algorithm: "compact-island-sculpt-v3",
    id: "compact-duel-island-v4",
    bay: COMPACT_BAY_PARAMETERS,
  });

/** Previous continuous terrace, retained only for numeric regression. */
export const SCULPTED_COMPACT_V4_PROFILE_FIXTURE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
    algorithm: "compact-island-sculpt-v4",
    id: "compact-duel-island-v5",
    terrace: COMPACT_TERRACE_PARAMETERS,
  });

/** Base sculpt fixture: asymmetric outcrops separated by saddles. */
export const SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
    algorithm: "compact-island-sculpt-v5",
    id: "compact-duel-island-v6",
    ridgeBreakup: COMPACT_RIDGE_BREAKUP_PARAMETERS,
  });

/** Explicit Haven candidate; the full content identity includes its authored data. */
export const HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE: WorldTerrainProfile =
  validateWorldTerrainProfile({
    ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
    havenShoulder: havenShoulderData,
  });

/** Styling/ecology family, not a substitute for strict profile admission. */
export function isCompactSculptProfile(profile: WorldTerrainProfile): boolean {
  return (
    profile.algorithm === "compact-island-sculpt-v1" ||
    profile.algorithm === "compact-island-sculpt-v2" ||
    profile.algorithm === "compact-island-sculpt-v3" ||
    profile.algorithm === "compact-island-sculpt-v4" ||
    profile.algorithm === "compact-island-sculpt-v5"
  );
}

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
 * Compact inputs have a bounded procedural coast, but are NOT approval of
 * authored grading/content containment, navigation, rendering or performance.
 */
export function validateWorldTerrainProfile(
  input: unknown,
): WorldTerrainProfile {
  const base = LEGACY_TERRAIN_PROFILE_FIXTURE;
  const v2 =
    input !== null &&
    typeof input === "object" &&
    Object.getOwnPropertyDescriptor(input, "algorithm")?.value ===
      "compact-island-sculpt-v2";
  const v3 =
    input !== null &&
    typeof input === "object" &&
    Object.getOwnPropertyDescriptor(input, "algorithm")?.value ===
      "compact-island-sculpt-v3";
  const v4 =
    input !== null &&
    typeof input === "object" &&
    Object.getOwnPropertyDescriptor(input, "algorithm")?.value ===
      "compact-island-sculpt-v4";
  const v5 =
    input !== null &&
    typeof input === "object" &&
    Object.getOwnPropertyDescriptor(input, "algorithm")?.value ===
      "compact-island-sculpt-v5";
  const hasHavenShoulder =
    input !== null &&
    typeof input === "object" &&
    Object.prototype.hasOwnProperty.call(input, "havenShoulder");
  const data = record(
    input,
    v5
      ? [
          ...Object.keys(base),
          "landform",
          "bay",
          "terrace",
          "ridgeBreakup",
          ...(hasHavenShoulder ? ["havenShoulder"] : []),
        ]
      : v4
        ? [...Object.keys(base), "landform", "bay", "terrace"]
        : v3
          ? [...Object.keys(base), "landform", "bay"]
          : v2
            ? [...Object.keys(base), "landform"]
            : Object.keys(base),
    "profile",
  );
  if (
    data.schemaVersion !== 1 ||
    (data.algorithm !== "terrain-height-params-v1" &&
      data.algorithm !== "compact-island-sculpt-v1" &&
      data.algorithm !== "compact-island-sculpt-v2" &&
      data.algorithm !== "compact-island-sculpt-v3" &&
      data.algorithm !== "compact-island-sculpt-v4" &&
      data.algorithm !== "compact-island-sculpt-v5") ||
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
  const landform =
    v2 || v3 || v4 || v5
      ? numericGroup(data.landform, COMPACT_LANDFORM_PARAMETERS, "landform")
      : undefined;
  const bay =
    v3 || v4 || v5
      ? numericGroup(data.bay, COMPACT_BAY_PARAMETERS, "bay")
      : undefined;
  const terrace =
    v4 || v5
      ? numericGroup(data.terrace, COMPACT_TERRACE_PARAMETERS, "terrace")
      : undefined;
  const ridgeBreakup = v5
    ? numericGroup(
        data.ridgeBreakup,
        COMPACT_RIDGE_BREAKUP_PARAMETERS,
        "ridgeBreakup",
      )
    : undefined;
  const havenShoulder = hasHavenShoulder
    ? havenShoulderAdmission.validate(data.havenShoulder)
    : undefined;
  if (
    havenShoulder &&
    (havenShoulder.minX < bounds.minX ||
      havenShoulder.maxX > bounds.maxX ||
      havenShoulder.minZ < bounds.minZ ||
      havenShoulder.maxZ > bounds.maxZ ||
      havenShoulder.grade <= water.threshold ||
      [
        ...havenShoulder.crest,
        ...havenShoulder.shelf,
        ...havenShoulder.toe,
      ].some((p) => p[2] > height.maxHeightParameter))
  )
    fail("Haven shoulder envelope/height");
  if (ridgeBreakup) {
    const r = ridgeBreakup;
    if (
      !terrace ||
      r.northGapHalfWidth < 16 ||
      r.southGapHalfWidth < 16 ||
      r.northGapZ - r.northGapHalfWidth < terrace.startZ + 6 ||
      r.southGapZ + r.southGapHalfWidth > terrace.endZ - 6 ||
      r.northGapZ + r.northGapHalfWidth >= r.southGapZ - r.southGapHalfWidth ||
      r.northGapDepth < 0 ||
      r.northGapDepth > 0.8 ||
      r.southGapDepth < 0 ||
      r.southGapDepth > 0.8 ||
      r.lateralWarp < 0 ||
      r.lateralWarp > 4 ||
      r.warpWavelength < 32 ||
      r.warpWavelength > 120 ||
      r.facetRelief < 0 ||
      r.facetRelief > 1.5 ||
      r.facetScale < 0.05 ||
      r.facetScale > 0.14
    )
      fail("ridge breakup ranges/refined support");
  }
  if (
    terrace &&
    (!landform ||
      terrace.startZ < landform.ridgeStartZ ||
      terrace.endZ > landform.ridgeEndZ ||
      terrace.startZ >= terrace.endZ ||
      terrace.endFade < 6 ||
      terrace.endFade > (terrace.endZ - terrace.startZ) / 2 ||
      terrace.westFoot !== -landform.ridgeWestWidth ||
      terrace.crestStart - terrace.westFoot < 3 ||
      terrace.crestStart > 0 ||
      terrace.crestEnd - terrace.crestStart < 3 ||
      terrace.crestEnd > 16 ||
      terrace.crestHeight <= 0 ||
      terrace.crestHeight > 24 ||
      terrace.shelfHeight <= 0 ||
      terrace.shelfHeight >= terrace.crestHeight ||
      terrace.scarpRun < 6 ||
      terrace.scarpRun > 16 ||
      terrace.shelfWidth < 6 ||
      terrace.shelfWidth > 24 ||
      terrace.apronWidth < 6 ||
      terrace.apronWidth > 40 ||
      terrace.eastPreservationStart <
        landform.ridgeBaseX - Math.abs(landform.ridgeBend) ||
      terrace.eastPreservationEnd - terrace.eastPreservationStart < 3 ||
      terrace.eastPreservationEnd >
        landform.ridgeBaseX + landform.ridgeEastWidth / 2)
  )
    fail("terrace ranges/refined support");
  if (
    bay &&
    (!landform ||
      bay.innerHalfWidth < 16 ||
      bay.innerHalfWidth > landform.inletHalfWidth ||
      Math.abs(bay.centerlineBend) >
        landform.inletHalfWidth - bay.innerHalfWidth ||
      bay.leftBankScale < 0.5 ||
      bay.leftBankScale > 1.5 ||
      bay.rightBankScale < 0.5 ||
      bay.rightBankScale > 1.5 ||
      Math.max(bay.leftBankScale, bay.rightBankScale) *
        landform.inletBankTransition >=
        bay.innerHalfWidth ||
      landform.inletTipDistance + landform.inletTipTransition >=
        165 * (1 + island.maxCoastVariation))
  )
    fail("bay ranges/envelope");
  if (
    landform &&
    (Math.abs(landform.westHeadlandBearing) > Math.PI ||
      Math.abs(landform.inletBearing) > Math.PI ||
      landform.westHeadlandHalfWidth < 0.1 ||
      landform.westHeadlandHalfWidth > Math.PI / 2 ||
      landform.westHeadlandStrength < 0 ||
      landform.westHeadlandStrength > 0.3 ||
      landform.inletTipDistance <= 0 ||
      landform.inletTipDistance >= 165 ||
      landform.inletTipTransition < 16 ||
      landform.inletTipTransition > 80 ||
      landform.inletHalfWidth < 20 ||
      landform.inletHalfWidth > 80 ||
      landform.inletBankTransition < 12 ||
      landform.inletBankTransition >= landform.inletHalfWidth ||
      landform.ridgeStartZ < -165 ||
      landform.ridgeEndZ > 165 ||
      landform.ridgeStartZ >= landform.ridgeEndZ ||
      Math.abs(landform.ridgeBaseX) + Math.abs(landform.ridgeBend) > 165 ||
      landform.ridgeWestWidth < 16 ||
      landform.ridgeWestWidth > 80 ||
      landform.ridgeEastWidth < 16 ||
      landform.ridgeEastWidth > 80 ||
      landform.ridgeHeight <= 0 ||
      landform.ridgeHeight > 24 ||
      landform.ridgeEndFade < 16 ||
      landform.ridgeEndFade > (landform.ridgeEndZ - landform.ridgeStartZ) / 2)
  )
    fail("landform ranges");
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
    island.beachProfilePower <= 0 ||
    island.maxCoastVariation < 0 ||
    island.maxCoastVariation >= 1
  )
    fail("island dimensions");
  const nominalExtent =
    island.radius * (1 + island.maxCoastVariation) + island.deepOceanBuffer;
  if (
    !Number.isFinite(nominalExtent) ||
    island.centerX - nominalExtent < bounds.minX ||
    island.centerX + nominalExtent > bounds.maxX ||
    island.centerZ - nominalExtent < bounds.minZ ||
    island.centerZ + nominalExtent > bounds.maxZ
  )
    fail("bounded noisy island extent outside bounds");
  // Authored flat zones still require separate content containment admission.
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
    algorithm: data.algorithm,
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
    ...(landform ? { landform } : {}),
    ...(bay ? { bay } : {}),
    ...(terrace ? { terrace } : {}),
    ...(ridgeBreakup ? { ridgeBreakup } : {}),
    ...(havenShoulder ? { havenShoulder } : {}),
  });
  const reservedSculptAlgorithm = {
    "compact-duel-island-v2": "compact-island-sculpt-v1",
    "compact-duel-island-v3": "compact-island-sculpt-v2",
    "compact-duel-island-v4": "compact-island-sculpt-v3",
    "compact-duel-island-v5": "compact-island-sculpt-v4",
    "compact-duel-island-v6": "compact-island-sculpt-v5",
  } as const;
  if (
    Object.prototype.hasOwnProperty.call(reservedSculptAlgorithm, profile.id) &&
    reservedSculptAlgorithm[
      profile.id as keyof typeof reservedSculptAlgorithm
    ] !== profile.algorithm
  )
    fail("reserved sculpt identity/algorithm differs");
  // Reserved legacy ID/kind cannot silently be reused for changed parameters.
  if (
    (profile.kind === "large-world" || profile.id === base.id) &&
    JSON.stringify(profile) !== JSON.stringify(base)
  )
    fail("reserved large-world identity differs");
  return profile;
}

/** Runtime selection is always explicit; omission never restores the old world. */
export function resolveWorldTerrainProfile(
  input?: unknown,
): WorldTerrainProfile {
  const profile = validateWorldTerrainProfile(input);
  if (profile.kind !== "compact-candidate")
    fail("legacy regression fixture is not a runtime world");
  return profile;
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
  return new TextEncoder().encode(worldTerrainProfileIdentity(profile));
}

/** Canonical identity payload, not a cryptographic digest or asset-manifest identity. */
export function worldTerrainProfileIdentity(
  profile: WorldTerrainProfile,
): string {
  return `hyperia-world-terrain-profile-v1\n${serializeWorldTerrainProfile(profile)}`;
}
