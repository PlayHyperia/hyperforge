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

export type GrassPlacementDomainInput = {
  /** Real retained terrain leaf frame, including for cell-owned grass. */
  centerX: number;
  centerZ: number;
  size: number;
  clumpSpacing: number;
  spacingMul: number;
  placementCell?: GrassPlacementCell;
};

export type GrassPlacementDomain = Readonly<{
  /** Sampling frame only. Output offsets still use the input leaf frame. */
  centerX: number;
  centerZ: number;
  size: number;
  maxCount: number;
  placementCell?: GrassPlacementCell;
}>;

/** Self-contained methods: the exact factory is embedded in the real worker. */
export function createGrassPlacementCellOperations() {
  const helpers = {
    fail(message: string): never {
      throw new Error(`Invalid grass placement cell: ${message}`);
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
      const spacing = input.clumpSpacing * input.spacingMul;
      // Keep historical domains and arithmetic unchanged. Only explicit cells
      // opt in to the new quota and containment admission.
      if (input.placementCell === undefined)
        return Object.freeze({
          centerX: input.centerX,
          centerZ: input.centerZ,
          size: input.size,
          maxCount: Math.ceil((input.size * input.size) / (spacing * spacing)),
        });
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
      return Object.freeze({
        centerX: bounds.minX + 12.5,
        centerZ: bounds.minZ + 12.5,
        size: 25,
        maxCount,
        placementCell: cell,
      });
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
