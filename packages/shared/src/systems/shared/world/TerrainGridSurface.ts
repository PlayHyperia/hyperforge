import type THREE from "../../../extras/three/three";

export type TerrainGridSample = {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  faceIndex: number;
};

export type TerrainGridBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type TerrainTriangleVisitor = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  faceIndex: number,
) => void;

/** Caller-owned storage, overwritten by each successful cursor advance. */
export type TerrainGridTriangle = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** One read-only retained-grid traversal, with no per-triangle allocations.
 * The surface owner must remain current while the caller suspends work. */
class RetainedTerrainTriangleCursor {
  private x: number;
  private z: number;
  private second = false;

  constructor(
    private readonly positions: Float32Array,
    private readonly resolution: number,
    private readonly x0: number,
    private readonly x1: number,
    private readonly z1: number,
    z0: number,
  ) {
    this.x = x0;
    this.z = z0;
  }

  next(out: TerrainGridTriangle): boolean {
    if (this.z > this.z1 || this.x0 > this.x1) return false;
    const p = this.positions,
      r = this.resolution;
    const a = (this.z * r + this.x) * 3;
    const b = a + 3,
      c = a + r * 3,
      d = c + 3;
    const first = this.second ? b : a,
      last = this.second ? d : b;
    out[0] = p[first];
    out[1] = p[first + 1];
    out[2] = p[first + 2];
    out[3] = p[c];
    out[4] = p[c + 1];
    out[5] = p[c + 2];
    out[6] = p[last];
    out[7] = p[last + 1];
    out[8] = p[last + 2];
    out[9] = (this.z * (r - 1) + this.x) * 2 + (this.second ? 1 : 0);
    if (this.second && ++this.x > this.x1) {
      this.x = this.x0;
      this.z++;
    }
    this.second = !this.second;
    return true;
  }
}

/** One installed geometry revision, never a procedural or bilinear approximation. */
export class RetainedTerrainSurface {
  readonly revision: string;
  private readonly positions: Float32Array;
  private readonly positionVersion: number;
  private readonly indexVersion: number;
  private readonly index: THREE.BufferAttribute;

  constructor(
    readonly nodeId: number,
    readonly terrainProfileIdentity: string,
    readonly centerX: number,
    readonly centerZ: number,
    readonly size: number,
    readonly resolution: number,
    geometry: THREE.BufferGeometry,
  ) {
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    if (
      !Number.isInteger(resolution) ||
      resolution < 2 ||
      resolution > 256 ||
      !Number.isFinite(size) ||
      size <= 0 ||
      !Number.isFinite(centerX) ||
      !Number.isFinite(centerZ) ||
      !position ||
      !("version" in position) ||
      position.itemSize !== 3 ||
      !(position.array instanceof Float32Array) ||
      position.count < resolution * resolution ||
      !index ||
      index.count < (resolution - 1) ** 2 * 6
    )
      throw new Error("Invalid retained terrain grid");
    this.positions = position.array;
    this.revision = geometry.uuid;
    this.positionVersion = position.version;
    this.indexVersion = index.version;
    this.index = index;
    // Validate the main grid once, excluding skirts. Sampling is then O(1).
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const a = z * resolution + x;
        const p = a * 3;
        if (
          this.positions[p] !==
            Math.fround(-size / 2 + x * (size / (resolution - 1))) ||
          this.positions[p + 2] !==
            Math.fround(-size / 2 + z * (size / (resolution - 1))) ||
          !Number.isFinite(this.positions[p + 1])
        )
          throw new Error(
            "Retained terrain grid is not an unmodified regular Float32 grid",
          );
        if (
          (x > 0 && this.positions[p] <= this.positions[p - 3]) ||
          (z > 0 &&
            this.positions[p + 2] <= this.positions[p - resolution * 3 + 2])
        )
          throw new Error(
            "Retained terrain grid axes must be strictly increasing",
          );
        if (x === resolution - 1 || z === resolution - 1) continue;
        const offset = (z * (resolution - 1) + x) * 6;
        if (
          index.getX(offset) !== a ||
          index.getX(offset + 1) !== a + resolution ||
          index.getX(offset + 2) !== a + 1 ||
          index.getX(offset + 3) !== a + 1 ||
          index.getX(offset + 4) !== a + resolution ||
          index.getX(offset + 5) !== a + resolution + 1
        )
          throw new Error("Retained terrain triangle topology mismatch");
      }
    }
  }

  matchesGeometry(geometry: THREE.BufferGeometry): boolean {
    const position = geometry.getAttribute("position");
    return (
      geometry.uuid === this.revision &&
      position?.array === this.positions &&
      "version" in position &&
      position.version === this.positionVersion &&
      geometry.index === this.index &&
      geometry.index?.version === this.indexVersion
    );
  }

  /** Resume one original triangle at a time without repeating spatial queries
   * or allocating vertex tuples. Includes both cells at exact Float32 edges,
   * in the same row/cell/face order as visitTrianglesInBounds. */
  createTriangleCursor(
    bounds: TerrainGridBounds,
  ): RetainedTerrainTriangleCursor {
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ
    )
      throw new Error("Invalid retained triangle query");
    const half = this.size / 2,
      p = this.positions,
      r = this.resolution;
    if (
      bounds.maxX < -half ||
      bounds.minX > half ||
      bounds.maxZ < -half ||
      bounds.minZ > half
    )
      return new RetainedTerrainTriangleCursor(p, r, 0, -1, -1, 0);
    const bound = (
      value: number,
      stride: number,
      offset: number,
      upper: boolean,
    ) => {
      let lo = 0,
        hi = r;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          coordinate = p[mid * stride + offset];
        if (coordinate < value || (upper && coordinate === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return new RetainedTerrainTriangleCursor(
      p,
      r,
      Math.max(0, bound(bounds.minX, 3, 0, false) - 1),
      Math.min(r - 2, bound(bounds.maxX, 3, 0, true) - 1),
      Math.min(r - 2, bound(bounds.maxZ, r * 3, 2, true) - 1),
      Math.max(0, bound(bounds.minZ, r * 3, 2, false) - 1),
    );
  }

  /**
   * Bounded read-only access to original main-grid triangles (never skirts).
   * Bounds and vertices are chunk-local. The caller clips candidate triangles
   * to its exact footprint; this method deliberately includes boundary cells.
   */
  visitTrianglesInBounds(
    bounds: TerrainGridBounds,
    visit: TerrainTriangleVisitor,
    triangleBudget: number,
  ): { visited: number; exhausted: boolean } {
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ ||
      !Number.isSafeInteger(triangleBudget) ||
      triangleBudget < 0 ||
      triangleBudget > 1_000_000
    )
      throw new Error("Invalid retained triangle query");
    const half = this.size / 2;
    if (
      bounds.maxX < -half ||
      bounds.minX > half ||
      bounds.maxZ < -half ||
      bounds.minZ > half
    )
      return { visited: 0, exhausted: false };
    const p = this.positions;
    const r = this.resolution;
    // Search the actual Float32 axes, not an idealized division. At equality,
    // include both cells touching a boundary; otherwise visit only its owner.
    const axisBound = (
      value: number,
      stride: number,
      offset: number,
      upper: boolean,
    ) => {
      let low = 0,
        high = r;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (
          p[middle * stride + offset] < value ||
          (upper && p[middle * stride + offset] === value)
        )
          low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const x0 = Math.max(0, axisBound(bounds.minX, 3, 0, false) - 1);
    const x1 = Math.min(r - 2, axisBound(bounds.maxX, 3, 0, true) - 1);
    const z0 = Math.max(0, axisBound(bounds.minZ, r * 3, 2, false) - 1);
    const z1 = Math.min(r - 2, axisBound(bounds.maxZ, r * 3, 2, true) - 1);
    let visited = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const a = (z * r + x) * 3;
        const b = a + 3;
        const c = a + r * 3;
        const d = c + 3;
        const face = (z * (r - 1) + x) * 2;
        if (visited === triangleBudget) return { visited, exhausted: true };
        visit(
          p[a],
          p[a + 1],
          p[a + 2],
          p[c],
          p[c + 1],
          p[c + 2],
          p[b],
          p[b + 1],
          p[b + 2],
          face,
        );
        visited++;
        if (visited === triangleBudget) return { visited, exhausted: true };
        visit(
          p[b],
          p[b + 1],
          p[b + 2],
          p[c],
          p[c + 1],
          p[c + 2],
          p[d],
          p[d + 1],
          p[d + 2],
          face + 1,
        );
        visited++;
      }
    }
    return { visited, exhausted: false };
  }

  /** Local X/Z are the exact Float32 instance offsets used by the grass shader. */
  sample(localX: number, localZ: number, out: TerrainGridSample): boolean {
    const p = this.positions;
    const r = this.resolution;
    const last = r - 1;
    if (
      !Number.isFinite(localX) ||
      !Number.isFinite(localZ) ||
      localX < p[0] ||
      localX > p[last * 3] ||
      localZ < p[2] ||
      localZ > p[last * r * 3 + 2]
    )
      return false;
    let x = Math.min(
      last - 1,
      Math.floor(((localX + this.size / 2) * last) / this.size),
    );
    let z = Math.min(
      last - 1,
      Math.floor(((localZ + this.size / 2) * last) / this.size),
    );
    // Ideal grid division may round to the adjacent cell at a Float32 boundary.
    if (x > 0 && localX < p[x * 3]) x--;
    else if (x < last - 1 && localX >= p[(x + 1) * 3]) x++;
    if (z > 0 && localZ < p[z * r * 3 + 2]) z--;
    else if (z < last - 1 && localZ >= p[(z + 1) * r * 3 + 2]) z++;
    const a = (z * r + x) * 3;
    const b = a + 3;
    const c = a + r * 3;
    const d = c + 3;
    const dx = p[b] - p[a];
    const dz = p[c + 2] - p[a + 2];
    const u = (localX - p[a]) / dx;
    const v = (localZ - p[a + 2]) / dz;
    const first = u + v <= 1;
    out.height = first
      ? (1 - u - v) * p[a + 1] + u * p[b + 1] + v * p[c + 1]
      : (1 - v) * p[b + 1] + (1 - u) * p[c + 1] + (u + v - 1) * p[d + 1];
    const sx = first ? (p[b + 1] - p[a + 1]) / dx : (p[d + 1] - p[c + 1]) / dx;
    const sz = first ? (p[c + 1] - p[a + 1]) / dz : (p[d + 1] - p[b + 1]) / dz;
    const length = Math.hypot(sx, 1, sz);
    out.nx = -sx / length;
    out.ny = 1 / length;
    out.nz = -sz / length;
    out.faceIndex = (z * last + x) * 2 + (first ? 0 : 1);
    return true;
  }
}
