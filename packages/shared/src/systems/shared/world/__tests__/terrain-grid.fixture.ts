import THREE from "../../../../extras/three/three";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import type { TerrainQuadNode } from "../TerrainQuadTree";

/** Authored numerical geometry fixtures, not substitutes for manager methods. */
export function gridGeometry(
  size: number,
  resolution: number,
  height: (x: number, z: number) => number,
) {
  const p = new Float32Array(resolution * resolution * 3);
  const indices: number[] = [];
  const step = size / (resolution - 1);
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const a = z * resolution + x;
      p[a * 3] = -size / 2 + x * step;
      p[a * 3 + 2] = -size / 2 + z * step;
      p[a * 3 + 1] = height(p[a * 3], p[a * 3 + 2]);
      if (x < resolution - 1 && z < resolution - 1)
        indices.push(
          a,
          a + resolution,
          a + 1,
          a + 1,
          a + resolution,
          a + resolution + 1,
        );
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
  geometry.setIndex(indices);
  return geometry;
}

export class RetainedGridFixture {
  available = true;
  private grids = new Map<
    TerrainQuadNode,
    {
      height: number;
      surface: RetainedTerrainSurface;
      geometry: THREE.BufferGeometry;
    }
  >();
  constructor(
    private identity: string,
    private height: () => number,
  ) {}
  get = (node: TerrainQuadNode): RetainedTerrainSurface | null => {
    if (!this.available) return null;
    const height = this.height();
    const old = this.grids.get(node);
    if (old?.height === height) return old.surface;
    old?.geometry.dispose();
    const geometry = gridGeometry(node.size, node.resolution, () => height);
    const surface = new RetainedTerrainSurface(
      node.id,
      this.identity,
      node.centerX,
      node.centerZ,
      node.size,
      node.resolution,
      geometry,
    );
    this.grids.set(node, { height, geometry, surface });
    return surface;
  };
  dispose() {
    for (const { geometry } of this.grids.values()) geometry.dispose();
    this.grids.clear();
  }
}
