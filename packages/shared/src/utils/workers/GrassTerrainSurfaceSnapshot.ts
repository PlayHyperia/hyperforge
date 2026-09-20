import type {
  FlatZone,
  RadialPondBankComposition,
  RadialPondBankSector,
} from "../../types/world/terrain";

export const GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE = 0.5;

export type GrassTerrainSurfaceZone = FlatZone & { excludeGrass?: boolean };

export type GrassTerrainWaterBody = {
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  surfaceY: number;
};

/** Convex counter-clockwise XZ silhouette. Vegetation only: never a height edit. */
export type GrassTerrainExclusionPolygon = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  vertices: { x: number; z: number }[];
};

export type GrassTerrainSurfaceSnapshot = {
  schemaVersion: 1;
  /** Global registration order, filtered by the caller's complete query region. */
  zones: GrassTerrainSurfaceZone[];
  arenaFloorIds: string[];
  arenaGradeHeight: number | null;
  waterBodies: GrassTerrainWaterBody[];
  exclusionPolygons?: GrassTerrainExclusionPolygon[];
};

export type GrassTerrainSurfaceSnapshotInput = {
  zones: readonly GrassTerrainSurfaceZone[];
  arenaFloorIds: readonly string[];
  arenaGradeHeight: number | null;
  waterBodies: readonly GrassTerrainWaterBody[];
  exclusionPolygons?: readonly GrassTerrainExclusionPolygon[];
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
    maxExclusionPolygons: number;
    maxPolygonVertices: number;
  }>;
  /** Validate once at each request boundary, not during per-blade sampling. */
  validateSnapshot(value: unknown): GrassTerrainSurfaceSnapshot;
  /** Optional blend geometry/composition admitted before copying or sampling. */
  validateBlendShape(zone: FlatZone): void;
  /** Grading geometry is already validated; this optional exclusion never shapes it. */
  validateGrassExclusionBounds(zone: FlatZone): void;
  /** Same validation algebra with explicit bounded continuation points. */
  validateSnapshotSteps(
    value: unknown,
  ): Generator<string, GrassTerrainSurfaceSnapshot, void>;
  /** Validate and copy only wire fields; queued input never aliases its source. */
  cloneSnapshot(value: unknown): GrassTerrainSurfaceSnapshot;
  cloneSnapshotSteps(
    value: unknown,
  ): Generator<string, GrassTerrainSurfaceSnapshot, void>;
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
  /** Already-validated snapshots, no terrain shaping or allocation per query. */
  isGrassExcluded(
    snapshot: Pick<GrassTerrainSurfaceSnapshot, "exclusionPolygons">,
    x: number,
    z: number,
  ): boolean;
  /** Validated polygon/finite swept bounds; boundary contact is not a miss. */
  exclusionBoundsOverlap(
    polygon: GrassTerrainExclusionPolygon,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): boolean;
  /** SAT against a full swept blade AABB, including boundary contact. */
  intersectsExclusionSteps(
    polygon: GrassTerrainExclusionPolygon,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): Generator<string, boolean, void>;
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
    // Up to 24 authored rock silhouettes plus eight courts with four exact
    // feet each (56 owners), within an explicit 64-polygon ceiling. Keep every
    // footprint and the existing vertex ceiling; never substitute roof pads.
    maxExclusionPolygons: 64,
    maxPolygonVertices: 64,
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
    bankSectors(
      radial: Record<string, unknown>,
      bed: number,
      outer: number,
      bank: number,
      bedHeight: number,
      blendRadius: number,
    ): RadialPondBankSector[] | undefined {
      if (!("bankSectors" in radial)) return undefined;
      const field = Object.getOwnPropertyDescriptor(radial, "bankSectors");
      if (!field || !field.enumerable || !("value" in field))
        return helpers.fail("pond bankSectors must be an own data field");
      const sectors: unknown = field.value;
      if (
        !Array.isArray(sectors) ||
        Object.getPrototypeOf(sectors) !== Array.prototype ||
        sectors.length > 4 ||
        Reflect.ownKeys(sectors).length !== sectors.length + 1
      )
        return helpers.fail(
          "pond bankSectors must be a dense plain array of at most four sectors",
        );
      const keys = [
        "bearing",
        "halfWidth",
        "innerRadius",
        "innerHeight",
      ] as const;
      for (let index = 0; index < sectors.length; index++) {
        const entry = Object.getOwnPropertyDescriptor(sectors, String(index));
        if (!entry || !entry.enumerable || !("value" in entry))
          return helpers.fail(
            "pond bankSectors must contain own dense data rows",
          );
        const row: unknown = entry.value;
        if (
          !row ||
          typeof row !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(row))
        )
          return helpers.fail(
            "pond bankSectors rows must contain plain data fields",
          );
        const paired = Object.prototype.hasOwnProperty.call(row, "outerRadius");
        if (paired !== Object.prototype.hasOwnProperty.call(row, "outerHeight"))
          return helpers.fail(
            "pond bankSectors outerRadius and outerHeight must be paired",
          );
        const fields = paired ? [...keys, "outerRadius", "outerHeight"] : keys;
        if (Reflect.ownKeys(row).length !== fields.length)
          return helpers.fail(
            "pond bankSectors rows must contain exactly four or six plain data fields",
          );
        const values: number[] = [];
        for (const key of fields) {
          const value = Object.getOwnPropertyDescriptor(row, key);
          if (!value || !value.enumerable || !("value" in value))
            return helpers.fail(
              "pond bankSectors fields must be own data values",
            );
          values.push(helpers.finite(value.value, "pond bankSectors " + key));
        }
        const [
          bearing,
          halfWidth,
          innerRadius,
          innerHeight,
          outerRadius,
          outerHeight,
        ] = values;
        if (
          ![bed, outer, bank, bedHeight].every(Number.isFinite) ||
          bearing < -Math.PI ||
          bearing > Math.PI ||
          halfWidth <= 0 ||
          halfWidth > Math.PI / 2 ||
          innerRadius <= bed ||
          innerRadius >= outer ||
          innerHeight <= bedHeight ||
          innerHeight > bank
        )
          return helpers.fail(
            "pond bankSectors exceeds angular or monotonic bank-profile bounds",
          );
        if (
          paired &&
          (!Number.isFinite(blendRadius) ||
            blendRadius <= 0 ||
            outerRadius <= innerRadius ||
            outerRadius >= outer + blendRadius ||
            outerHeight < innerHeight ||
            outerHeight > bank + 0.6)
        )
          return helpers.fail(
            "pond bankSectors exceeds paired outer-knot bounds",
          );
      }
      return sectors as RadialPondBankSector[];
    },
    bankComposition(
      radial: Record<string, unknown>,
      sectorCount: number,
    ): RadialPondBankComposition | undefined {
      if (!("bankComposition" in radial)) return undefined;
      const field = Object.getOwnPropertyDescriptor(radial, "bankComposition");
      if (!field?.enumerable || !("value" in field))
        return helpers.fail("pond bankComposition must be an own data field");
      const composition: unknown = field.value;
      if (
        !composition ||
        typeof composition !== "object" ||
        ![Object.prototype, null].includes(
          Object.getPrototypeOf(composition),
        ) ||
        Reflect.ownKeys(composition).length !== 2
      )
        return helpers.fail(
          "pond bankComposition must contain exactly two plain data fields",
        );
      const version = Object.getOwnPropertyDescriptor(
        composition,
        "schemaVersion",
      );
      const list = Object.getOwnPropertyDescriptor(composition, "sectors");
      if (!version?.enumerable || !("value" in version) || version.value !== 1)
        return helpers.fail(
          "pond bankComposition requires schemaVersion 1 as own data",
        );
      if (!list?.enumerable || !("value" in list))
        return helpers.fail(
          "pond bankComposition sectors must be an own data field",
        );
      const rows: unknown = list.value;
      if (
        !Array.isArray(rows) ||
        Object.getPrototypeOf(rows) !== Array.prototype ||
        rows.length > 4 ||
        Reflect.ownKeys(rows).length !== rows.length + 1
      )
        return helpers.fail(
          "pond bankComposition sectors must be a dense plain array of at most four rows",
        );
      const seen = new Set<number>();
      for (let index = 0; index < rows.length; index++) {
        const entry = Object.getOwnPropertyDescriptor(rows, String(index));
        if (!entry?.enumerable || !("value" in entry))
          return helpers.fail(
            "pond bankComposition sectors must contain own data rows",
          );
        const row: unknown = entry.value;
        if (
          !row ||
          typeof row !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
          Reflect.ownKeys(row).length !== ("groundCover" in row ? 3 : 2)
        )
          return helpers.fail(
            "pond bankComposition rows must contain two or three plain data fields",
          );
        const reference = Object.getOwnPropertyDescriptor(row, "sectorIndex");
        const role = Object.getOwnPropertyDescriptor(row, "surface");
        if (
          !reference?.enumerable ||
          !("value" in reference) ||
          !Number.isInteger(reference.value) ||
          reference.value < 0 ||
          reference.value >= sectorCount ||
          seen.has(reference.value)
        )
          return helpers.fail(
            "pond bankComposition sectorIndex must uniquely reference an existing sector",
          );
        if (
          !role?.enumerable ||
          !("value" in role) ||
          (role.value !== "sedge-shelf" &&
            role.value !== "cutbank" &&
            role.value !== "dry-turf" &&
            role.value !== "mineral-shore")
        )
          return helpers.fail(
            "pond bankComposition surface must be a supported own data value",
          );
        if ("groundCover" in row) {
          if (role.value === "mineral-shore")
            return helpers.fail(
              "pond bankComposition mineral-shore cannot establish groundCover",
            );
          const property = Object.getOwnPropertyDescriptor(row, "groundCover");
          if (!property?.enumerable || !("value" in property))
            return helpers.fail(
              "pond bankComposition groundCover must be an own data field",
            );
          const cover: unknown = property.value;
          if (
            !cover ||
            typeof cover !== "object" ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(cover)) ||
            Reflect.ownKeys(cover).length !== 2
          )
            return helpers.fail(
              "pond bankComposition groundCover must contain exactly two plain data fields",
            );
          const emergence = Object.getOwnPropertyDescriptor(
            cover,
            "emergenceHeight",
          );
          const full = Object.getOwnPropertyDescriptor(cover, "fullHeight");
          if (
            !emergence?.enumerable ||
            !("value" in emergence) ||
            !full?.enumerable ||
            !("value" in full) ||
            typeof emergence.value !== "number" ||
            !Number.isFinite(emergence.value) ||
            typeof full.value !== "number" ||
            !Number.isFinite(full.value) ||
            emergence.value <= 0 ||
            full.value < emergence.value + 0.01 ||
            full.value > 0.6
          )
            return helpers.fail(
              "pond bankComposition groundCover requires positive emergenceHeight, at least 0.01m transition width, and fullHeight <= 0.6",
            );
        }
        seen.add(reference.value);
      }
      return composition as RadialPondBankComposition;
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
    *validateMask(
      zone: Record<string, unknown>,
    ): Generator<string, number, void> {
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
          yield "snapshot_mask";
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
          yield "snapshot_mask";
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
    *validateZone(
      value: unknown,
    ): Generator<string, { id: string; maskTiles: number }, void> {
      yield "snapshot_zone";
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
      operations.validateBlendShape(value as FlatZone);
      operations.validateGrassExclusionBounds(value as FlatZone);
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
        const sectors = helpers.bankSectors(
          radial,
          bed,
          outer,
          bank,
          height,
          blend,
        );
        helpers.bankComposition(radial, sectors?.length ?? 0);
        if (radial.shorelineAmplitude !== undefined) {
          const amplitude = helpers.nonnegative(
            radial.shorelineAmplitude,
            "pond shorelineAmplitude",
          );
          if (amplitude > Math.min(1, bed * 0.25, (outer - inner) * 0.5))
            return helpers.fail(
              "pond shorelineAmplitude exceeds monotonic profile bounds",
            );
        }
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
      return { id, maskTiles: yield* helpers.validateMask(zone) };
    },
  };

  const operations: GrassTerrainSurfaceOperations = {
    limits,
    validateBlendShape(zone) {
      if ("blendComposition" in zone) {
        const composition = Object.getOwnPropertyDescriptor(
          zone,
          "blendComposition",
        );
        if (
          !composition ||
          !composition.enumerable ||
          !("value" in composition) ||
          composition.value !== "smooth-union" ||
          !("blendShape" in zone)
        )
          return helpers.fail(
            "blendComposition must be an own smooth-union data field with rounded geometry",
          );
      }
      if (!("blendShape" in zone)) return;
      const field = Object.getOwnPropertyDescriptor(zone, "blendShape");
      if (
        !field ||
        !field.enumerable ||
        !("value" in field) ||
        field.value !== "rounded"
      )
        return helpers.fail("blendShape must be an own rounded data field");
      for (const key of [
        "radialPond",
        "tileMask",
        "tileMaskTiles",
        "tileMaskBounds",
      ] as const) {
        if (!(key in zone)) continue;
        const conflict = Object.getOwnPropertyDescriptor(zone, key);
        if (!conflict || !("value" in conflict) || conflict.value !== undefined)
          return helpers.fail(
            "rounded blendShape requires rectangular geometry",
          );
      }
    },
    validateGrassExclusionBounds(zone) {
      if (!("grassExclusionBounds" in zone)) return;
      const field = Object.getOwnPropertyDescriptor(
        zone,
        "grassExclusionBounds",
      );
      if (!field || !("value" in field))
        return helpers.fail("grassExclusionBounds must be an own data field");
      const bounds = helpers.record(field.value, "grassExclusionBounds");
      const values: number[] = [];
      for (const key of ["minX", "maxX", "minZ", "maxZ"] as const) {
        const component = Object.getOwnPropertyDescriptor(bounds, key);
        if (!component || !("value" in component))
          return helpers.fail(
            "grassExclusionBounds components must be own data fields",
          );
        values.push(
          helpers.finite(component.value, "grassExclusionBounds " + key),
        );
      }
      const [minX, maxX, minZ, maxZ] = values;
      if (minX >= maxX || minZ >= maxZ)
        return helpers.fail("grassExclusionBounds must have positive area");
      if (
        minX < zone.centerX - zone.width / 2 - zone.blendRadius ||
        maxX > zone.centerX + zone.width / 2 + zone.blendRadius ||
        minZ < zone.centerZ - zone.depth / 2 - zone.blendRadius ||
        maxZ > zone.centerZ + zone.depth / 2 + zone.blendRadius
      )
        return helpers.fail(
          "grassExclusionBounds must remain inside grading support",
        );
      if (zone.blendShape === "rounded") {
        for (const x of [minX, maxX])
          for (const z of [minZ, maxZ])
            if (
              Math.hypot(
                Math.max(0, Math.abs(x - zone.centerX) - zone.width / 2),
                Math.max(0, Math.abs(z - zone.centerZ) - zone.depth / 2),
              ) > zone.blendRadius
            )
              return helpers.fail(
                "grassExclusionBounds must remain inside rounded grading support",
              );
      }
      for (const key of [
        "excludeGrass",
        "tileMask",
        "tileMaskTiles",
        "tileMaskBounds",
        "radialPond",
      ] as const) {
        if (!(key in zone)) continue;
        const conflict = Object.getOwnPropertyDescriptor(zone, key);
        if (!conflict || !("value" in conflict))
          return helpers.fail(
            "grassExclusionBounds conflict fields must be own data fields",
          );
        if (
          key === "excludeGrass"
            ? conflict.value === false
            : conflict.value !== undefined
        )
          return helpers.fail("grassExclusionBounds conflicts with " + key);
      }
    },
    validateSnapshot(input) {
      const steps = operations.validateSnapshotSteps(input);
      let step = steps.next();
      while (!step.done) step = steps.next();
      return step.value;
    },
    *validateSnapshotSteps(input) {
      yield "snapshot_header";
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
        const zone = yield* helpers.validateZone(value);
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
        yield "snapshot_floor";
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
        yield "snapshot_floor";
        const zone = helpers.record(value, "zone");
        if (
          floorIds.has(String(zone.id)) &&
          (zone.radialPond !== undefined ||
            zone.tileMask !== undefined ||
            zone.blendShape !== undefined)
        ) {
          return helpers.fail(
            "arena floors require unmodified rectangular geometry",
          );
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
        yield "snapshot_water";
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
      if (snapshot.exclusionPolygons !== undefined) {
        if (
          !Array.isArray(snapshot.exclusionPolygons) ||
          snapshot.exclusionPolygons.length > limits.maxExclusionPolygons
        )
          return helpers.fail("exclusion polygon count");
        const ids = new Set<string>();
        for (const value of snapshot.exclusionPolygons) {
          yield "snapshot_polygon";
          const polygon = helpers.record(value, "exclusion polygon");
          const id = helpers.identifier(polygon.id, "exclusion polygon ID");
          if (ids.has(id))
            return helpers.fail("duplicate exclusion polygon ID");
          ids.add(id);
          if (
            !Array.isArray(polygon.vertices) ||
            polygon.vertices.length < 3 ||
            polygon.vertices.length > limits.maxPolygonVertices
          )
            return helpers.fail("exclusion polygon vertex count");
          const points: { x: number; z: number }[] = [];
          for (const value of polygon.vertices) {
            yield "snapshot_polygon_vertex";
            const point = helpers.record(value, "exclusion vertex");
            points.push({
              x: helpers.finite(point.x, "exclusion X"),
              z: helpers.finite(point.z, "exclusion Z"),
            });
          }
          for (const axis of ["X", "Z"] as const) {
            const values = points.map((p) => (axis === "X" ? p.x : p.z));
            if (
              polygon[`min${axis}`] !== Math.min(...values) ||
              polygon[`max${axis}`] !== Math.max(...values)
            )
              return helpers.fail(
                "exclusion polygon bounds must match vertices",
              );
          }
          // Every vertex must lie strictly inside every nonincident edge.
          // This rejects concavity, winding errors, duplicates and star polygons.
          for (let i = 0; i < points.length; i++) {
            const a = points[i],
              b = points[(i + 1) % points.length];
            for (let j = 0; j < points.length; j++) {
              yield "snapshot_polygon_convexity";
              if (j === i || j === (i + 1) % points.length) continue;
              const p = points[j],
                side = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
              if (!Number.isFinite(side) || side <= 0)
                return helpers.fail(
                  "exclusion polygon must be strictly convex CCW",
                );
            }
          }
        }
      }
      return input as GrassTerrainSurfaceSnapshot;
    },
    cloneSnapshot(input) {
      const steps = operations.cloneSnapshotSteps(input);
      let step = steps.next();
      while (!step.done) step = steps.next();
      return step.value;
    },
    *cloneSnapshotSteps(input) {
      const snapshot = yield* operations.validateSnapshotSteps(input);
      const zones: GrassTerrainSurfaceZone[] = [];
      for (const zone of snapshot.zones) {
        yield "snapshot_clone_zone";
        // Recheck the borrowed optional field after the continuation boundary.
        operations.validateBlendShape(zone);
        operations.validateGrassExclusionBounds(zone);
        const clone: GrassTerrainSurfaceZone = {
          id: zone.id,
          centerX: zone.centerX,
          centerZ: zone.centerZ,
          width: zone.width,
          depth: zone.depth,
          height: zone.height,
          blendRadius: zone.blendRadius,
        };
        if (zone.blendShape !== undefined) clone.blendShape = zone.blendShape;
        if (zone.blendComposition !== undefined)
          clone.blendComposition = zone.blendComposition;
        if (zone.excludeGrass !== undefined)
          clone.excludeGrass = zone.excludeGrass;
        if (zone.grassExclusionBounds !== undefined)
          clone.grassExclusionBounds = {
            minX: zone.grassExclusionBounds.minX,
            maxX: zone.grassExclusionBounds.maxX,
            minZ: zone.grassExclusionBounds.minZ,
            maxZ: zone.grassExclusionBounds.maxZ,
          };
        if (zone.carveInset !== undefined) clone.carveInset = zone.carveInset;
        if (zone.radialPond !== undefined) {
          // Revalidate the borrowed nested recipe after the continuation, then
          // synchronously copy the bounded fields and optional pair without
          // another yield. Legacy rows keep the pair absent, not undefined.
          const sectors = helpers.bankSectors(
            helpers.record(zone.radialPond, "radial pond"),
            zone.radialPond.bedRadius,
            zone.radialPond.bankOuterRadius,
            zone.radialPond.bankHeight,
            zone.height,
            zone.blendRadius,
          );
          const composition = helpers.bankComposition(
            helpers.record(zone.radialPond, "radial pond"),
            sectors?.length ?? 0,
          );
          clone.radialPond = {
            bedRadius: zone.radialPond.bedRadius,
            bankInnerRadius: zone.radialPond.bankInnerRadius,
            bankOuterRadius: zone.radialPond.bankOuterRadius,
            bankHeight: zone.radialPond.bankHeight,
            ...(zone.radialPond.shorelineAmplitude !== undefined
              ? { shorelineAmplitude: zone.radialPond.shorelineAmplitude }
              : {}),
            ...(sectors === undefined
              ? {}
              : {
                  bankSectors: sectors.map((sector) => ({
                    bearing: sector.bearing,
                    halfWidth: sector.halfWidth,
                    innerRadius: sector.innerRadius,
                    innerHeight: sector.innerHeight,
                    ...(sector.outerRadius === undefined
                      ? {}
                      : {
                          outerRadius: sector.outerRadius,
                          outerHeight: sector.outerHeight,
                        }),
                  })),
                }),
            ...(composition === undefined
              ? {}
              : {
                  bankComposition: Object.freeze({
                    schemaVersion: composition.schemaVersion,
                    sectors: Object.freeze(
                      composition.sectors.map((sector) =>
                        Object.freeze({
                          sectorIndex: sector.sectorIndex,
                          surface: sector.surface,
                          ...(sector.groundCover === undefined
                            ? {}
                            : {
                                groundCover: Object.freeze({
                                  emergenceHeight:
                                    sector.groundCover.emergenceHeight,
                                  fullHeight: sector.groundCover.fullHeight,
                                }),
                              }),
                        }),
                      ),
                    ),
                  }),
                }),
          };
        }
        if (zone.tileMask !== undefined) {
          clone.tileMask = new Set();
          for (const key of zone.tileMask) {
            yield "snapshot_clone_mask";
            clone.tileMask.add(key);
          }
        }
        if (zone.tileMaskTiles !== undefined) {
          clone.tileMaskTiles = [];
          for (const tile of zone.tileMaskTiles) {
            yield "snapshot_clone_tile";
            clone.tileMaskTiles.push({ x: tile.x, z: tile.z });
          }
        }
        if (zone.tileMaskBounds !== undefined)
          clone.tileMaskBounds = {
            minX: zone.tileMaskBounds.minX,
            maxX: zone.tileMaskBounds.maxX,
            minZ: zone.tileMaskBounds.minZ,
            maxZ: zone.tileMaskBounds.maxZ,
          };
        zones.push(clone);
      }
      const waterBodies: GrassTerrainWaterBody[] = [];
      for (const body of snapshot.waterBodies) {
        yield "snapshot_clone_water";
        waterBodies.push({
          id: body.id,
          centerX: body.centerX,
          centerZ: body.centerZ,
          radius: body.radius,
          surfaceY: body.surfaceY,
        });
      }
      const exclusionPolygons: GrassTerrainExclusionPolygon[] = [];
      for (const polygon of snapshot.exclusionPolygons ?? []) {
        yield "snapshot_clone_polygon";
        const vertices: { x: number; z: number }[] = [];
        for (const point of polygon.vertices) {
          yield "snapshot_clone_polygon_vertex";
          vertices.push({ x: point.x, z: point.z });
        }
        exclusionPolygons.push({
          id: polygon.id,
          minX: polygon.minX,
          maxX: polygon.maxX,
          minZ: polygon.minZ,
          maxZ: polygon.maxZ,
          vertices,
        });
      }
      return {
        schemaVersion: 1,
        zones,
        arenaFloorIds: [...snapshot.arenaFloorIds],
        arenaGradeHeight: snapshot.arenaGradeHeight,
        waterBodies,
        ...(snapshot.exclusionPolygons !== undefined
          ? { exclusionPolygons }
          : {}),
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
    isGrassExcluded(snapshot, x, z) {
      for (const p of snapshot.exclusionPolygons ?? []) {
        if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
        let inside = true;
        for (let i = 0; i < p.vertices.length; i++) {
          const a = p.vertices[i],
            b = p.vertices[(i + 1) % p.vertices.length];
          if ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x) < 0) {
            inside = false;
            break;
          }
        }
        if (inside) return true;
      }
      return false;
    },
    exclusionBoundsOverlap(p, box) {
      return !(
        box.maxX < p.minX ||
        box.minX > p.maxX ||
        box.maxZ < p.minZ ||
        box.minZ > p.maxZ
      );
    },
    *intersectsExclusionSteps(p, box) {
      yield "polygon_bounds";
      if (!operations.exclusionBoundsOverlap(p, box)) return false;
      for (let i = 0; i < p.vertices.length; i++) {
        yield "polygon_edge";
        const a = p.vertices[i],
          b = p.vertices[(i + 1) % p.vertices.length];
        const nx = -(b.z - a.z),
          nz = b.x - a.x;
        const x = nx >= 0 ? box.maxX : box.minX,
          z = nz >= 0 ? box.maxZ : box.minZ;
        if (nx * (x - a.x) + nz * (z - a.z) < 0) return false;
      }
      return true;
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
