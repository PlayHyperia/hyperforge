import type { FlatZone } from "../../types/world/terrain";

export const GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE = 0.5;

export type GrassTerrainSurfaceZone = FlatZone & { excludeGrass?: boolean };

export type GrassTerrainWaterBody = {
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  surfaceY: number;
};

export type GrassTerrainSurfaceSnapshot = {
  schemaVersion: 1;
  /** Global registration order, filtered by the caller's complete query region. */
  zones: GrassTerrainSurfaceZone[];
  arenaFloorIds: string[];
  arenaGradeHeight: number | null;
  waterBodies: GrassTerrainWaterBody[];
};

export type GrassTerrainSurfaceSnapshotInput = {
  zones: readonly GrassTerrainSurfaceZone[];
  arenaFloorIds: readonly string[];
  arenaGradeHeight: number | null;
  waterBodies: readonly GrassTerrainWaterBody[];
};

export type GrassTerrainZoneIndex = {
  readonly indexedZoneReferences: number;
  readonly bucketCount: number;
  /** Reused result storage: consume synchronously; do not retain or recurse. */
  getZonesAt(x: number, z: number): readonly GrassTerrainSurfaceZone[];
};

export type GrassTerrainSurfaceOperations = {
  readonly limits: Readonly<{
    maxZones: number;
    maxMaskTiles: number;
    maxWaterBodies: number;
    maxIndexedZoneReferences: number;
    maxIdLength: number;
  }>;
  /** Validate once at each request boundary, not during per-blade sampling. */
  validateSnapshot(value: unknown): GrassTerrainSurfaceSnapshot;
  /** Validate and copy only wire fields; queued input never aliases its source. */
  cloneSnapshot(value: unknown): GrassTerrainSurfaceSnapshot;
  /** Snapshot must already be validated; validates index bounds before loops. */
  createZoneIndex(
    snapshot: GrassTerrainSurfaceSnapshot,
    tileSize: number,
  ): GrassTerrainZoneIndex;
  /** Validated snapshot and finite coordinates/ocean level supplied by caller. */
  getWaterSurfaceAt(
    snapshot: GrassTerrainSurfaceSnapshot,
    oceanLevel: number,
    x: number,
    z: number,
  ): number;
};

/**
 * Self-contained for generated workers through this factory's toString().
 * All runtime helpers use method syntax, avoiding external bundler name helpers.
 * Main-thread callers invoke it normally; no production main-thread evaluation.
 */
export function createGrassTerrainSurfaceOperations(): GrassTerrainSurfaceOperations {
  const limits = Object.freeze({
    maxZones: 512,
    maxMaskTiles: 32768,
    maxWaterBodies: 128,
    maxIndexedZoneReferences: 65536,
    maxIdLength: 128,
  });
  const helpers = {
    fail(label: string): never {
      throw new Error("Invalid grass terrain surface: " + label);
    },
    record(value: unknown, label: string): Record<string, unknown> {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value instanceof Set
      ) {
        return helpers.fail(label + " must be an object");
      }
      return value as Record<string, unknown>;
    },
    finite(value: unknown, label: string): number {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return helpers.fail(label + " must be finite");
      }
      return value;
    },
    positive(value: unknown, label: string): number {
      const result = helpers.finite(value, label);
      if (result <= 0) return helpers.fail(label + " must be positive");
      return result;
    },
    nonnegative(value: unknown, label: string): number {
      const result = helpers.finite(value, label);
      if (result < 0) return helpers.fail(label + " must be nonnegative");
      return result;
    },
    identifier(value: unknown, label: string): string {
      if (
        typeof value !== "string" ||
        !value.trim().length ||
        value.length > limits.maxIdLength
      ) {
        return helpers.fail(label + " must be a bounded nonempty ID");
      }
      return value;
    },
    tileCoordinate(value: unknown, label: string): number {
      const number = helpers.finite(value, label);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(number + 1)) {
        return helpers.fail(label + " must be a safe tile integer");
      }
      return number;
    },
    tileKey(value: unknown): { x: number; z: number } {
      if (typeof value !== "string" || value.length > 40) {
        return helpers.fail("tileMask key must be bounded canonical x,z");
      }
      const parts = value.split(",");
      if (parts.length !== 2) return helpers.fail("tileMask key must be x,z");
      const x = helpers.tileCoordinate(Number(parts[0]), "mask X");
      const z = helpers.tileCoordinate(Number(parts[1]), "mask Z");
      if (`${x},${z}` !== value) {
        return helpers.fail("tileMask key must be canonical x,z");
      }
      return { x, z };
    },
    validateMask(zone: Record<string, unknown>): number {
      const mask = zone.tileMask;
      const tiles = zone.tileMaskTiles;
      if (mask !== undefined && !(mask instanceof Set)) {
        return helpers.fail("tileMask must be a native Set");
      }
      if (tiles !== undefined && !Array.isArray(tiles)) {
        return helpers.fail("tileMaskTiles must be an array");
      }
      const count = Math.max(mask?.size ?? 0, tiles?.length ?? 0);
      if (count > limits.maxMaskTiles) {
        return helpers.fail("tile mask bound exceeded");
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      if (mask) {
        for (const key of mask) {
          const tile = helpers.tileKey(key);
          minX = Math.min(minX, tile.x);
          maxX = Math.max(maxX, tile.x);
          minZ = Math.min(minZ, tile.z);
          maxZ = Math.max(maxZ, tile.z);
        }
      }
      if (tiles) {
        if (mask && mask.size !== tiles.length) {
          return helpers.fail("tileMask and tileMaskTiles sizes differ");
        }
        const seen = new Set<string>();
        for (const value of tiles) {
          const tile = helpers.record(value, "mask tile");
          const x = helpers.tileCoordinate(tile.x, "tile X");
          const z = helpers.tileCoordinate(tile.z, "tile Z");
          const key = `${x},${z}`;
          if (seen.has(key) || (mask && !mask.has(key))) {
            return helpers.fail(
              "tileMaskTiles must exactly match unique mask keys",
            );
          }
          seen.add(key);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
      if (zone.tileMaskBounds !== undefined) {
        const bounds = helpers.record(zone.tileMaskBounds, "mask bounds");
        if (!count) return helpers.fail("empty mask cannot have finite bounds");
        const expected = { minX, maxX, minZ, maxZ };
        for (const key of ["minX", "maxX", "minZ", "maxZ"] as const) {
          if (
            helpers.tileCoordinate(bounds[key], "mask bounds " + key) !==
            expected[key]
          ) {
            return helpers.fail(
              "mask bounds must equal exact inclusive tile extrema",
            );
          }
        }
      }
      return count;
    },
    validateZone(value: unknown): { id: string; maskTiles: number } {
      const zone = helpers.record(value, "zone");
      const id = helpers.identifier(zone.id, "zone ID");
      const x = helpers.finite(zone.centerX, "zone centerX");
      const z = helpers.finite(zone.centerZ, "zone centerZ");
      const width = helpers.positive(zone.width, "zone width");
      const depth = helpers.positive(zone.depth, "zone depth");
      const height = helpers.finite(zone.height, "zone height");
      const blend = helpers.nonnegative(zone.blendRadius, "zone blendRadius");
      const radius = Math.max(width, depth) / 2 + blend;
      for (const edge of [x - radius, x + radius, z - radius, z + radius]) {
        helpers.finite(edge, "zone indexing extent");
      }
      if (
        zone.excludeGrass !== undefined &&
        typeof zone.excludeGrass !== "boolean"
      ) {
        return helpers.fail("excludeGrass must be boolean when present");
      }
      if (zone.carveInset !== undefined) {
        helpers.nonnegative(zone.carveInset, "zone carveInset");
      }
      if (zone.radialPond !== undefined) {
        const radial = helpers.record(zone.radialPond, "radial pond");
        const bed = helpers.positive(radial.bedRadius, "pond bedRadius");
        const inner = helpers.positive(
          radial.bankInnerRadius,
          "pond bankInnerRadius",
        );
        const outer = helpers.positive(
          radial.bankOuterRadius,
          "pond bankOuterRadius",
        );
        const bank = helpers.finite(radial.bankHeight, "pond bankHeight");
        const diameter = 2 * (outer + blend);
        if (
          inner <= bed ||
          outer < inner ||
          bank <= height ||
          blend <= 0 ||
          !Number.isFinite(diameter) ||
          width < diameter ||
          depth < diameter
        ) {
          return helpers.fail("inconsistent radial pond profile or extent");
        }
        if (
          zone.tileMask !== undefined ||
          zone.tileMaskTiles !== undefined ||
          zone.tileMaskBounds !== undefined
        ) {
          return helpers.fail(
            "radial pond cannot also have tile-mask geometry",
          );
        }
      }
      return { id, maskTiles: helpers.validateMask(zone) };
    },
  };

  const operations: GrassTerrainSurfaceOperations = {
    limits,
    validateSnapshot(input) {
      const snapshot = helpers.record(input, "snapshot");
      if (snapshot.schemaVersion !== 1)
        return helpers.fail("schemaVersion must be 1");
      if (
        !Array.isArray(snapshot.zones) ||
        snapshot.zones.length > limits.maxZones
      ) {
        return helpers.fail("zones array bound exceeded or missing");
      }
      const zoneIds = new Set<string>();
      let maskTiles = 0;
      for (const value of snapshot.zones) {
        const zone = helpers.validateZone(value);
        if (zoneIds.has(zone.id)) return helpers.fail("duplicate zone ID");
        zoneIds.add(zone.id);
        maskTiles += zone.maskTiles;
        if (maskTiles > limits.maxMaskTiles)
          return helpers.fail("total mask tile bound exceeded");
      }
      if (
        !Array.isArray(snapshot.arenaFloorIds) ||
        snapshot.arenaFloorIds.length > limits.maxZones
      ) {
        return helpers.fail("arenaFloorIds array bound exceeded or missing");
      }
      const floorIds = new Set<string>();
      for (const value of snapshot.arenaFloorIds) {
        const id = helpers.identifier(value, "arena floor ID");
        if (floorIds.has(id) || !zoneIds.has(id)) {
          return helpers.fail("arena floor IDs must be unique zone subsets");
        }
        floorIds.add(id);
      }
      if (snapshot.arenaGradeHeight !== null)
        helpers.finite(snapshot.arenaGradeHeight, "arenaGradeHeight");
      if (floorIds.size && snapshot.arenaGradeHeight === null) {
        return helpers.fail("arena floor IDs require a finite grade height");
      }
      for (const value of snapshot.zones) {
        const zone = helpers.record(value, "zone");
        if (
          floorIds.has(String(zone.id)) &&
          (zone.radialPond !== undefined || zone.tileMask !== undefined)
        ) {
          return helpers.fail("arena floors require rectangular geometry");
        }
      }
      if (
        !Array.isArray(snapshot.waterBodies) ||
        snapshot.waterBodies.length > limits.maxWaterBodies
      ) {
        return helpers.fail("waterBodies array bound exceeded or missing");
      }
      const waterIds = new Set<string>();
      for (const value of snapshot.waterBodies) {
        const water = helpers.record(value, "water body");
        const id = helpers.identifier(water.id, "water body ID");
        if (waterIds.has(id)) return helpers.fail("duplicate water body ID");
        waterIds.add(id);
        const x = helpers.finite(water.centerX, "water centerX");
        const z = helpers.finite(water.centerZ, "water centerZ");
        const radius = helpers.positive(water.radius, "water radius");
        helpers.positive(radius * radius, "water radius squared");
        for (const edge of [x - radius, x + radius, z - radius, z + radius])
          helpers.finite(edge, "water extent");
        helpers.finite(water.surfaceY, "water surfaceY");
      }
      return input as GrassTerrainSurfaceSnapshot;
    },
    cloneSnapshot(input) {
      const snapshot = operations.validateSnapshot(input);
      const zones = snapshot.zones.map((zone) => {
        const clone: GrassTerrainSurfaceZone = {
          id: zone.id,
          centerX: zone.centerX,
          centerZ: zone.centerZ,
          width: zone.width,
          depth: zone.depth,
          height: zone.height,
          blendRadius: zone.blendRadius,
        };
        if (zone.excludeGrass !== undefined)
          clone.excludeGrass = zone.excludeGrass;
        if (zone.carveInset !== undefined) clone.carveInset = zone.carveInset;
        if (zone.radialPond !== undefined)
          clone.radialPond = {
            bedRadius: zone.radialPond.bedRadius,
            bankInnerRadius: zone.radialPond.bankInnerRadius,
            bankOuterRadius: zone.radialPond.bankOuterRadius,
            bankHeight: zone.radialPond.bankHeight,
          };
        if (zone.tileMask !== undefined)
          clone.tileMask = new Set(zone.tileMask);
        if (zone.tileMaskTiles !== undefined)
          clone.tileMaskTiles = zone.tileMaskTiles.map((tile) => ({
            x: tile.x,
            z: tile.z,
          }));
        if (zone.tileMaskBounds !== undefined)
          clone.tileMaskBounds = {
            minX: zone.tileMaskBounds.minX,
            maxX: zone.tileMaskBounds.maxX,
            minZ: zone.tileMaskBounds.minZ,
            maxZ: zone.tileMaskBounds.maxZ,
          };
        return clone;
      });
      return {
        schemaVersion: 1,
        zones,
        arenaFloorIds: [...snapshot.arenaFloorIds],
        arenaGradeHeight: snapshot.arenaGradeHeight,
        waterBodies: snapshot.waterBodies.map((body) => ({
          id: body.id,
          centerX: body.centerX,
          centerZ: body.centerZ,
          radius: body.radius,
          surfaceY: body.surfaceY,
        })),
      };
    },
    createZoneIndex(snapshot, tileSize) {
      helpers.positive(tileSize, "terrain tile size");
      const half = tileSize / 2;
      // Calculate and bound every range BEFORE constructing any bucket loops.
      let indexedZoneReferences = 0;
      const ranges = snapshot.zones.map((zone) => {
        const radius = Math.max(zone.width, zone.depth) / 2 + zone.blendRadius;
        const minX = Math.floor((zone.centerX - radius + half) / tileSize);
        const maxX = Math.floor((zone.centerX + radius + half) / tileSize);
        const minZ = Math.floor((zone.centerZ - radius + half) / tileSize);
        const maxZ = Math.floor((zone.centerZ + radius + half) / tileSize);
        for (const index of [minX, maxX, minZ, maxZ]) {
          if (!Number.isSafeInteger(index))
            return helpers.fail("unsafe spatial index extent");
        }
        const count = (maxX - minX + 1) * (maxZ - minZ + 1);
        indexedZoneReferences += count;
        if (
          !Number.isSafeInteger(count) ||
          count <= 0 ||
          indexedZoneReferences > limits.maxIndexedZoneReferences
        ) {
          return helpers.fail("spatial index reference bound exceeded");
        }
        return { zone, minX, maxX, minZ, maxZ };
      });
      const buckets = new Map<string, GrassTerrainSurfaceZone[]>();
      for (const range of ranges) {
        for (let tx = range.minX; tx <= range.maxX; tx++) {
          for (let tz = range.minZ; tz <= range.maxZ; tz++) {
            const key = `${tx}_${tz}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(range.zone);
            else buckets.set(key, [range.zone]);
          }
        }
      }
      const candidates: GrassTerrainSurfaceZone[] = [];
      const checked = new Set<string>();
      return {
        indexedZoneReferences,
        bucketCount: buckets.size,
        getZonesAt(x, z) {
          const tileX = Math.floor((x + half) / tileSize);
          const tileZ = Math.floor((z + half) / tileSize);
          if (
            !Number.isSafeInteger(tileX) ||
            !Number.isSafeInteger(tileZ) ||
            !Number.isSafeInteger(tileX - 1) ||
            !Number.isSafeInteger(tileX + 1) ||
            !Number.isSafeInteger(tileZ - 1) ||
            !Number.isSafeInteger(tileZ + 1)
          ) {
            return helpers.fail("unsafe spatial query tile");
          }
          candidates.length = 0;
          checked.clear();
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const bucket = buckets.get(`${tileX + dx}_${tileZ + dz}`);
              if (!bucket) continue;
              for (const zone of bucket) {
                if (checked.has(zone.id)) continue;
                checked.add(zone.id);
                candidates.push(zone);
              }
            }
          }
          return candidates;
        },
      };
    },
    getWaterSurfaceAt(snapshot, oceanLevel, x, z) {
      let highest: number | null = null;
      for (const body of snapshot.waterBodies) {
        const dx = x - body.centerX;
        const dz = z - body.centerZ;
        if (
          dx * dx + dz * dz <= body.radius * body.radius &&
          (highest === null || body.surfaceY > highest)
        )
          highest = body.surfaceY;
      }
      // An authored body can be below ocean level. Ocean is only the no-body fallback.
      return highest === null ? oceanLevel : highest;
    },
  };
  return operations;
}

/** Detached request ownership, preserving optional mask/list/bounds semantics. */
export function createGrassTerrainSurfaceSnapshot(
  input: GrassTerrainSurfaceSnapshotInput,
): GrassTerrainSurfaceSnapshot {
  return createGrassTerrainSurfaceOperations().cloneSnapshot({
    ...input,
    schemaVersion: 1,
  });
}
