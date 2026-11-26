/** A grass-owned world-grid cell; never a substitute terrain leaf. */
export type GrassPlacementCell = Readonly<{
  schemaVersion: 1;
  size: 25;
  indexX: number;
  indexZ: number;
}>;

export type GrassPlacementCellBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type GrassPlacementDistribution = "fine-cell-stratified-v1";

export type GrassPlacementCoverage = "sixty-centimetre-cell-v1";

export type GrassPlacementCoverageTrial = Readonly<{
  id: GrassPlacementCoverage;
  cell: GrassPlacementCell;
}>;

export type GrassPlacementDomainInput = {
  /** Real retained terrain leaf frame, including for cell-owned grass. */
  centerX: number;
  centerZ: number;
  size: number;
  clumpSpacing: number;
  spacingMul: number;
  placementCell?: GrassPlacementCell;
  placementDistribution?: GrassPlacementDistribution;
  placementCoverage?: GrassPlacementCoverage;
};

export type GrassPlacementDomain = Readonly<{
  /** Sampling frame only. Output offsets still use the input leaf frame. */
  centerX: number;
  centerZ: number;
  size: number;
  maxCount: number;
  placementCell?: GrassPlacementCell;
  placementDistribution?: GrassPlacementDistribution;
  placementCoverage?: GrassPlacementCoverage;
  strataRows?: number;
  /** Present only for stratified sampling; actual storage uses the parent leaf. */
  leafFrame?: Readonly<{
    centerX: number;
    centerZ: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    interiorMinX: number;
    interiorMaxX: number;
    interiorMinZ: number;
    interiorMaxZ: number;
    worldBounds: GrassPlacementCellBounds;
  }>;
}>;

export type GrassPlacementPosition = {
  /** Ideal sampling-domain coordinates, before a rare storage-edge correction. */
  x: number;
  z: number;
  /** Stratified policy only: use these directly, without subtracting world XZ. */
  leafX?: number;
  leafZ?: number;
};

/** Self-contained methods: the exact factory is embedded in the real worker. */
export function createGrassPlacementCellOperations() {
  const admittedDomains = new WeakSet<GrassPlacementDomain>();
  // Shared only during domain admission, never allocated or touched per clump.
  const floatView = new Float32Array(1);
  const bits = new Uint32Array(floatView.buffer);
  const helpers = {
    fail(message: string): never {
      throw new Error(`Invalid grass placement cell: ${message}`);
    },
    validateDistribution(
      value: unknown,
    ): GrassPlacementDistribution | undefined {
      if (value === undefined || value === "fine-cell-stratified-v1")
        return value;
      return helpers.fail("unsupported placement distribution");
    },
    validateCoverage(value: unknown): GrassPlacementCoverage | undefined {
      if (value === undefined || value === "sixty-centimetre-cell-v1")
        return value;
      return helpers.fail("unsupported placement coverage");
    },
    validateCoverageTrial(input: unknown): GrassPlacementCoverageTrial {
      if (typeof input !== "object" || input === null || Array.isArray(input))
        return helpers.fail("coverage trial requires a record");
      const keys = Reflect.ownKeys(input);
      const values = Object.getOwnPropertyDescriptors(input);
      if (
        keys.length !== 2 ||
        keys.some((key) => key !== "id" && key !== "cell") ||
        ["id", "cell"].some(
          (key) => !values[key]?.enumerable || !("value" in values[key]),
        )
      )
        return helpers.fail("coverage trial requires exact own data fields");
      const id = helpers.validateCoverage(values.id.value);
      if (id === undefined)
        return helpers.fail("coverage trial id is required");
      return Object.freeze({
        id,
        cell: helpers.validateCell(values.cell.value),
      });
    },
    adjacentFloat32(value: number, direction: -1 | 1): number {
      floatView[0] = value;
      if (floatView[0] === 0) return direction * 2 ** -149;
      bits[0] += (floatView[0] > 0 ? 1 : -1) * direction;
      return floatView[0];
    },
    validateCell(input: unknown): GrassPlacementCell {
      if (typeof input !== "object" || input === null || Array.isArray(input))
        return helpers.fail("expected a record");
      const keys = Reflect.ownKeys(input);
      if (
        keys.length !== 4 ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !["schemaVersion", "size", "indexX", "indexZ"].includes(key),
        )
      )
        return helpers.fail("unexpected fields");
      const values = Object.getOwnPropertyDescriptors(input);
      for (const key of ["schemaVersion", "size", "indexX", "indexZ"])
        if (!values[key] || !("value" in values[key]))
          return helpers.fail("accessor fields are not admitted");
      if (values.schemaVersion.value !== 1 || values.size.value !== 25)
        return helpers.fail("unsupported schema or cell size");
      const indexX: unknown = values.indexX.value;
      const indexZ: unknown = values.indexZ.value;
      // Explicit bounded world grid [-102400,102400] metres. This is not a
      // camera-dependent coverage limit or permission to allocate large jobs.
      for (const index of [indexX, indexZ])
        if (
          typeof index !== "number" ||
          !Number.isSafeInteger(index) ||
          index < -4096 ||
          index > 4095
        )
          return helpers.fail("index outside the bounded world grid");
      if (typeof indexX !== "number" || typeof indexZ !== "number")
        return helpers.fail("non-numeric index");
      return Object.freeze({
        schemaVersion: 1,
        size: 25,
        indexX: indexX === 0 ? 0 : indexX,
        indexZ: indexZ === 0 ? 0 : indexZ,
      });
    },
    getBounds(input: unknown): GrassPlacementCellBounds {
      const cell = helpers.validateCell(input);
      return Object.freeze({
        minX: cell.indexX * 25,
        maxX: (cell.indexX + 1) * 25,
        minZ: cell.indexZ * 25,
        maxZ: (cell.indexZ + 1) * 25,
      });
    },
    resolveDomain(input: GrassPlacementDomainInput): GrassPlacementDomain {
      const coverageField = Object.getOwnPropertyDescriptor(
        input,
        "placementCoverage",
      );
      if (
        "placementCoverage" in input &&
        (!coverageField?.enumerable || !("value" in coverageField))
      )
        return helpers.fail("placement coverage must be own data");
      const coverage = helpers.validateCoverage(coverageField?.value);
      if (coverageField && coverage === undefined)
        return helpers.fail("explicitly undefined placement coverage");
      const distribution = helpers.validateDistribution(
        input.placementDistribution,
      );
      if (
        Object.prototype.hasOwnProperty.call(input, "placementDistribution") &&
        distribution === undefined
      )
        return helpers.fail("explicitly undefined placement distribution");
      if (distribution && input.placementCell === undefined)
        return helpers.fail("placement distribution requires an explicit cell");
      if (
        coverage &&
        (distribution !== "fine-cell-stratified-v1" ||
          input.placementCell === undefined ||
          input.clumpSpacing !== 0.6 ||
          input.spacingMul !== 1)
      )
        return helpers.fail(
          "placement coverage requires a fine sixty-centimetre cell",
        );
      const spacing = input.clumpSpacing * input.spacingMul;
      // Keep historical domains and arithmetic unchanged. Only explicit cells
      // opt in to the new quota and containment admission.
      if (input.placementCell === undefined) {
        const domain = Object.freeze({
          centerX: input.centerX,
          centerZ: input.centerZ,
          size: input.size,
          maxCount: Math.ceil((input.size * input.size) / (spacing * spacing)),
        });
        admittedDomains.add(domain);
        return domain;
      }
      const cell = helpers.validateCell(input.placementCell);
      if (
        ![input.centerX, input.centerZ, input.size].every(Number.isFinite) ||
        input.size <= 0 ||
        Math.abs(input.centerX) > 131072 ||
        Math.abs(input.centerZ) > 131072 ||
        input.size > 262144 ||
        !Number.isFinite(input.clumpSpacing) ||
        input.clumpSpacing <= 0 ||
        !Number.isFinite(input.spacingMul) ||
        input.spacingMul <= 0 ||
        !Number.isFinite(spacing) ||
        spacing <= 0
      )
        return helpers.fail("invalid leaf frame or spacing");
      const bounds = helpers.getBounds(cell);
      const half = input.size / 2;
      if (
        bounds.minX < input.centerX - half ||
        bounds.maxX > input.centerX + half ||
        bounds.minZ < input.centerZ - half ||
        bounds.maxZ > input.centerZ + half
      )
        return helpers.fail("cell is not fully contained in the terrain leaf");
      const maxCount = Math.ceil((25 * 25) / (spacing * spacing));
      if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 4096)
        return helpers.fail("candidate quota exceeds 4096");
      let leafFrame: GrassPlacementDomain["leafFrame"];
      if (distribution) {
        const minX = bounds.minX - input.centerX;
        const maxX = bounds.maxX - input.centerX;
        const minZ = bounds.minZ - input.centerZ;
        const maxZ = bounds.maxZ - input.centerZ;
        // Four conservative double ULPs cover cancellation on world rebuild.
        // One adjacent Float32 then encloses that margin even at local zero.
        // Only a candidate that actually crosses a stored/world cell boundary
        // is moved to these precomputed interior limits; all other draws remain.
        const guardX =
          4 *
          Number.EPSILON *
          Math.max(
            1,
            Math.abs(input.centerX),
            Math.abs(bounds.minX),
            Math.abs(bounds.maxX),
          );
        const guardZ =
          4 *
          Number.EPSILON *
          Math.max(
            1,
            Math.abs(input.centerZ),
            Math.abs(bounds.minZ),
            Math.abs(bounds.maxZ),
          );
        leafFrame = Object.freeze({
          centerX: input.centerX,
          centerZ: input.centerZ,
          minX,
          maxX,
          minZ,
          maxZ,
          interiorMinX: helpers.adjacentFloat32(minX + guardX, 1),
          interiorMaxX: helpers.adjacentFloat32(maxX - guardX, -1),
          interiorMinZ: helpers.adjacentFloat32(minZ + guardZ, 1),
          interiorMaxZ: helpers.adjacentFloat32(maxZ - guardZ, -1),
          worldBounds: bounds,
        });
      }
      const domain = Object.freeze({
        centerX: bounds.minX + 12.5,
        centerZ: bounds.minZ + 12.5,
        size: 25,
        maxCount,
        placementCell: cell,
        ...(coverage ? { placementCoverage: coverage } : {}),
        ...(distribution
          ? {
              placementDistribution: distribution,
              strataRows: Math.round(Math.sqrt(maxCount)),
              leafFrame,
            }
          : {}),
      });
      admittedDomains.add(domain);
      return domain;
    },
    /** Stateless fork for newly established roots. It must never advance the
     * historical position/acceptance/rotation stream or change attempt count. */
    establishmentRotation(
      domain: GrassPlacementDomain,
      seed: number,
      index: number,
    ): number {
      if (
        !admittedDomains.has(domain) ||
        !Number.isSafeInteger(seed) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= domain.maxCount
      )
        return helpers.fail("invalid establishment fork owner or index");
      let value =
        (seed ^
          ((domain.centerX * 374761393 + domain.centerZ * 668265263) | 0) ^
          Math.imul(index + 1, 0x9e3779b1) ^
          0x706f6e64) |
        0;
      value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
      value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
      return (((value ^ (value >>> 15)) >>> 0) / 4294967296) * Math.PI * 2;
    },
    samplePosition(
      domain: GrassPlacementDomain,
      index: number,
      u: number,
      v: number,
      out: GrassPlacementPosition,
    ): void {
      if (
        !admittedDomains.has(domain) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= domain.maxCount
      )
        return helpers.fail("unadmitted domain or invalid candidate index");
      if (
        !Number.isFinite(u) ||
        !Number.isFinite(v) ||
        u < 0 ||
        u >= 1 ||
        v < 0 ||
        v >= 1
      )
        return helpers.fail("jitter must be finite and in [0,1)");
      if (!domain.placementDistribution) {
        out.x = (u - 0.5) * domain.size;
        out.z = (v - 0.5) * domain.size;
        return;
      }
      const rows = domain.strataRows;
      const leaf = domain.leafFrame;
      if (rows === undefined || leaf === undefined)
        return helpers.fail("missing stratified domain metadata");
      // Inverse of floor(r*N/rows), without walking preceding rows or using the
      // accepted count. Filtering an earlier candidate never changes this cell.
      const row = Math.floor(((index + 1) * rows - 1) / domain.maxCount);
      const start = Math.floor((row * domain.maxCount) / rows);
      const columns = Math.floor(((row + 1) * domain.maxCount) / rows) - start;
      // Every real mulberry32 draw is unchanged. Guard only hypothetical doubles
      // above its maximum so col+u cannot round into the next mathematical cell.
      const x =
        ((index - start + Math.min(u, 1 - 2 ** -32)) / columns - 0.5) *
        domain.size;
      const z =
        ((start + Math.min(v, 1 - 2 ** -32) * columns) / domain.maxCount -
          0.5) *
        domain.size;
      let leafX = domain.centerX - leaf.centerX + x;
      let leafZ = domain.centerZ - leaf.centerZ + z;
      const storedX = Math.fround(leafX);
      const storedZ = Math.fround(leafZ);
      const bounds = leaf.worldBounds;
      if (
        storedX < leaf.minX ||
        storedX >= leaf.maxX ||
        leaf.centerX + storedX < bounds.minX ||
        leaf.centerX + storedX >= bounds.maxX ||
        leaf.centerX + leafX < bounds.minX ||
        leaf.centerX + leafX >= bounds.maxX
      )
        leafX = Math.max(leaf.interiorMinX, Math.min(leaf.interiorMaxX, leafX));
      if (
        storedZ < leaf.minZ ||
        storedZ >= leaf.maxZ ||
        leaf.centerZ + storedZ < bounds.minZ ||
        leaf.centerZ + storedZ >= bounds.maxZ ||
        leaf.centerZ + leafZ < bounds.minZ ||
        leaf.centerZ + leafZ >= bounds.maxZ
      )
        leafZ = Math.max(leaf.interiorMinZ, Math.min(leaf.interiorMaxZ, leafZ));
      out.x = x;
      out.z = z;
      out.leafX = leafX;
      out.leafZ = leafZ;
    },
  };
  return Object.freeze(helpers);
}

const operations = createGrassPlacementCellOperations();

export function getGrassPlacementCellBounds(
  cell: GrassPlacementCell,
): GrassPlacementCellBounds {
  return operations.getBounds(cell);
}
