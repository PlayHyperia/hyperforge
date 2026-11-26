import THREE from "../../../extras/three/three";

export type WaterGridSide = "minX" | "maxX" | "minZ" | "maxZ";

export type ConformingWaterGridInput = Readonly<{
  bounds: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  /** Native interior-cell pitch; an integer multiple of the shared lattice. */
  spacing: number;
  lattice: Readonly<{ originX: number; originZ: number; spacing: number }>;
  /**
   * Exact, increasing WORLD coordinates including both corners and every native
   * boundary vertex: Z coordinates on X edges, X coordinates on Z edges.
   * Neighbors must supply the same subdivision of their shared edge.
   */
  edges: Readonly<Record<WaterGridSide, readonly number[]>>;
}>;

export type ConformingWaterGrid = Readonly<{
  geometry: THREE.BufferGeometry;
  /** Increasing world-axis order, including corners; indices into position. */
  edges: Readonly<Record<WaterGridSide, Uint32Array>>;
  counts: Readonly<{
    cells: number;
    baseVertices: number;
    addedEdgeVertices: number;
    transitionCells: number;
    triangles: number;
  }>;
}>;

export const CONFORMING_WATER_GRID_LIMITS = Object.freeze({
  maxSegmentsPerAxis: 256,
  maxEdgeVertices: 4097,
});

const SIDES: readonly WaterGridSide[] = ["minX", "maxX", "minZ", "maxZ"];

/**
 * Pure geometry construction, not a live water/neighbor ownership policy.
 * Positions are WORLD X/Z with Y=0. Use a common identity X/Z mesh transform;
 * subtracting a different leaf origin and adding it back in the shader forfeits
 * the identical Float32 edge-coordinate contract. A common sea-level Y is safe.
 *
 * Ordinary cells retain two triangles. A cell with extra boundary subdivisions
 * uses its strictly interior center and a clockwise X/Z boundary fan (+Y). This
 * handles two refined edges at a corner without intersecting stitching strips.
 * Returned geometry/typed arrays are independently owned by the caller.
 */
export function createConformingWaterGrid(
  input: ConformingWaterGridInput,
): ConformingWaterGrid {
  const { bounds, spacing, lattice } = input;
  const finiteFloat = (value: number): number => {
    if (!Number.isFinite(value) || Math.fround(value) !== value)
      throw new RangeError(
        "Water grid coordinates must be exact finite Float32",
      );
    return value === 0 ? 0 : value;
  };
  for (const value of [
    bounds.minX,
    bounds.maxX,
    bounds.minZ,
    bounds.maxZ,
    lattice.originX,
    lattice.originZ,
    lattice.spacing,
    spacing,
  ])
    finiteFloat(value);
  if (spacing <= 0 || lattice.spacing <= 0)
    throw new RangeError("Water grid pitches must be positive");
  const stride = spacing / lattice.spacing;
  const nx = (bounds.maxX - bounds.minX) / spacing;
  const nz = (bounds.maxZ - bounds.minZ) / spacing;
  if (
    !Number.isSafeInteger(stride) ||
    stride < 1 ||
    ![nx, nz].every(
      (count) =>
        Number.isSafeInteger(count) &&
        count >= 1 &&
        count <= CONFORMING_WATER_GRID_LIMITS.maxSegmentsPerAxis,
    )
  )
    throw new RangeError("Water grid requires bounded whole lattice cells");

  const latticeIndex = (coordinate: number, origin: number): number => {
    finiteFloat(coordinate);
    const index = (coordinate - origin) / lattice.spacing;
    if (
      !Number.isSafeInteger(index) ||
      origin + index * lattice.spacing !== coordinate
    )
      throw new RangeError("Water grid coordinate is off the shared lattice");
    return index;
  };
  const firstX = latticeIndex(bounds.minX, lattice.originX);
  const firstZ = latticeIndex(bounds.minZ, lattice.originZ);
  latticeIndex(bounds.maxX, lattice.originX);
  latticeIndex(bounds.maxZ, lattice.originZ);
  const worldCoordinate = (origin: number, index: number): number => {
    if (!Number.isSafeInteger(index))
      throw new RangeError(
        "Water grid lattice index exceeds integer precision",
      );
    return finiteFloat(origin + index * lattice.spacing);
  };

  // Validate the complete edge contract before constructing an owned geometry.
  const coordinates = {} as Record<WaterGridSide, number[]>;
  for (const side of SIDES) {
    const values = input.edges[side];
    if (
      !Array.isArray(values) ||
      values.length < 2 ||
      values.length > CONFORMING_WATER_GRID_LIMITS.maxEdgeVertices
    )
      throw new RangeError("Water grid requires bounded explicit edge lists");
    const onX = side === "minX" || side === "maxX";
    const origin = onX ? lattice.originZ : lattice.originX;
    const start = onX ? firstZ : firstX;
    const count = onX ? nz : nx;
    const min = onX ? bounds.minZ : bounds.minX;
    const max = onX ? bounds.maxZ : bounds.maxX;
    if (values[0] !== min || values[values.length - 1] !== max)
      throw new RangeError("Water grid edge must include its exact corners");
    const indices: number[] = [];
    for (let i = 0; i < values.length; i++) {
      if (i > 0 && values[i] <= values[i - 1])
        throw new RangeError("Water grid edges must be strictly increasing");
      indices.push(latticeIndex(values[i], origin));
    }
    const included = new Set(indices);
    for (let i = 0; i <= count; i++) {
      if (!included.has(start + i * stride))
        throw new RangeError("Water grid edge omits a native boundary vertex");
    }
    coordinates[side] = indices;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const addVertex = (x: number, z: number): number => {
    const index = positions.length / 3;
    positions.push(finiteFloat(x), 0, finiteFloat(z));
    uvs.push(
      (x - bounds.minX) / (bounds.maxX - bounds.minX),
      1 - (z - bounds.minZ) / (bounds.maxZ - bounds.minZ),
    );
    return index;
  };
  const vertex = (x: number, z: number): number => z * (nx + 1) + x;
  for (let z = 0; z <= nz; z++)
    for (let x = 0; x <= nx; x++)
      addVertex(
        worldCoordinate(lattice.originX, firstX + x * stride),
        worldCoordinate(lattice.originZ, firstZ + z * stride),
      );
  const baseVertices = positions.length / 3;
  const edgeLists = {} as Record<WaterGridSide, Uint32Array>;
  const edgeCells = {} as Record<WaterGridSide, number[][]>;
  for (const side of SIDES) {
    const onX = side === "minX" || side === "maxX";
    const start = onX ? firstZ : firstX;
    const count = onX ? nz : nx;
    const cells = Array.from({ length: count }, (): number[] => []);
    const edge: number[] = [];
    for (const coordinate of coordinates[side]) {
      const offset = (coordinate - start) / stride;
      let id: number;
      if (Number.isInteger(offset)) {
        id = onX
          ? vertex(side === "minX" ? 0 : nx, offset)
          : vertex(offset, side === "minZ" ? 0 : nz);
      } else {
        id = onX
          ? addVertex(
              side === "minX" ? bounds.minX : bounds.maxX,
              worldCoordinate(lattice.originZ, coordinate),
            )
          : addVertex(
              worldCoordinate(lattice.originX, coordinate),
              side === "minZ" ? bounds.minZ : bounds.maxZ,
            );
      }
      edge.push(id);
      if (Number.isInteger(offset) && offset > 0) cells[offset - 1].push(id);
      if (offset < count) cells[Math.floor(offset)].push(id);
    }
    edgeLists[side] = new Uint32Array(edge);
    edgeCells[side] = cells;
  }
  const addedEdgeVertices = positions.length / 3 - baseVertices;
  let transitionCells = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const a = vertex(x, z);
      const b = vertex(x, z + 1);
      const c = vertex(x + 1, z + 1);
      const d = vertex(x + 1, z);
      const left = x === 0 ? edgeCells.minX[z] : [a, b];
      const top = z === nz - 1 ? edgeCells.maxZ[x] : [b, c];
      const right = x === nx - 1 ? edgeCells.maxX[z] : [d, c];
      const bottom = z === 0 ? edgeCells.minZ[x] : [a, d];
      if (left.length + top.length + right.length + bottom.length === 8) {
        indices.push(a, b, d, b, c, d);
        continue;
      }
      const boundary: number[] = [];
      for (let i = 0; i < left.length - 1; i++) boundary.push(left[i]);
      for (let i = 0; i < top.length - 1; i++) boundary.push(top[i]);
      for (let i = right.length - 1; i > 0; i--) boundary.push(right[i]);
      for (let i = bottom.length - 1; i > 0; i--) boundary.push(bottom[i]);
      const center = addVertex(
        positions[a * 3] + (positions[d * 3] - positions[a * 3]) / 2,
        positions[a * 3 + 2] +
          (positions[b * 3 + 2] - positions[a * 3 + 2]) / 2,
      );
      for (let i = 0; i < boundary.length; i++)
        indices.push(center, boundary[i], boundary[(i + 1) % boundary.length]);
      transitionCells++;
    }
  }

  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(uvs), 2),
  );
  // Three selects Uint16 for ordinary leaves, Uint32 only when required.
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return Object.freeze({
    geometry,
    edges: Object.freeze(edgeLists),
    counts: Object.freeze({
      cells: nx * nz,
      baseVertices,
      addedEdgeVertices,
      transitionCells,
      triangles: indices.length / 3,
    }),
  });
}
