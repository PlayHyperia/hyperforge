import type THREE from "../../../extras/three/three";

export type TerrainGridSample = {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  faceIndex: number;
};

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
