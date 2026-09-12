/**
 * WaterVisualManager — Generates flat water meshes aligned with the terrain
 * quad-tree. Each quad-tree leaf node that contains any underwater area gets
 * a simple PlaneGeometry at WATER_THRESHOLD height.
 *
 * The terrain quad-tree drives split/merge; this manager only reacts to
 * onNodeNeedsGeometry / onNodeDestroyGeometry events.
 *
 * CLIENT-ONLY: Only used when USE_QUADTREE_LOD is true.
 */

import THREE from "../../../extras/three/three";
import type { TerrainQuadNode, QuadTreeListener } from "./TerrainQuadTree";
import type { ElevatedWaterBody } from "./WaterBodyRegistry";
import type { WaterSystem, WaterBodyType } from "./WaterSystem";
import {
  validateWorldTerrainProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";

const WATER_RESOLUTION_BY_DEPTH: Record<number, number> = {
  0: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
};

const SHORE_SAMPLE_GRID = 5;

// One broadcast root is 1,600 m wide. Its ocean continues to a 3,600 m
// square, leaving at least 1,000 m to the edge for an eye inside the root
// (the unchanged fog is complete at 800 m). No additional terrain is made.
const OCEAN_CONTINUATION_BANDS = 8;
const OCEAN_CONTINUATION_ROOT_HALF_SIZE = 800;
const OCEAN_CONTINUATION_OUTER_HALF_SIZE = 1800;

interface WaterChunk {
  nodeId: number;
  mesh: THREE.Mesh;
}

export class WaterVisualManager implements QuadTreeListener {
  private container: THREE.Group;
  private waterSystem: WaterSystem;
  private getHeightAt: (x: number, z: number) => number;
  private getIslandMask: (x: number, z: number) => number;
  private waterThreshold: number;
  private readonly compactOceanOwnership: boolean;
  private chunks = new Map<string, WaterChunk>();
  private retiringKeys = new Set<string>();
  private elevatedWaterMeshes: THREE.Mesh[] = [];
  private destroyed = false;

  constructor(
    container: THREE.Group,
    waterSystem: WaterSystem,
    getHeightAt: (x: number, z: number) => number,
    getIslandMask: (x: number, z: number) => number,
    waterThreshold: number,
    elevatedWaterBodies: readonly ElevatedWaterBody[] = [],
    terrainProfile?: WorldTerrainProfile,
  ) {
    const profile =
      terrainProfile === undefined
        ? undefined
        : validateWorldTerrainProfile(terrainProfile);
    if (profile && profile.water.threshold !== waterThreshold) {
      throw new Error("Water visual threshold differs from terrain profile");
    }
    this.compactOceanOwnership = profile?.kind === "compact-candidate";
    this.container = container;
    this.waterSystem = waterSystem;
    this.getHeightAt = getHeightAt;
    this.getIslandMask = getIslandMask;
    this.waterThreshold = waterThreshold;
    this.createElevatedWaterMeshes(elevatedWaterBodies);
  }

  // -- QuadTreeListener -------------------------------------------------

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    if (this.destroyed) return;
    const key = this.chunkKey(node);
    if (this.chunks.has(key)) return;

    if (!this.hasUnderwaterArea(node)) return;

    // Do not allocate an owned geometry before its borrowed material exists.
    const waterType = this.determineWaterType(node);
    const material = this.waterSystem.getMaterial(waterType);
    if (!material) return;

    const resolution =
      WATER_RESOLUTION_BY_DEPTH[node.depth] ??
      Math.min(16, Math.max(2, node.depth * 4));

    const geom = new THREE.PlaneGeometry(
      node.size,
      node.size,
      resolution,
      resolution,
    );
    geom.rotateX(-Math.PI / 2);

    const count = geom.attributes.position.count;
    const shores = new Float32Array(count).fill(50);
    geom.setAttribute("shoreDistance", new THREE.BufferAttribute(shores, 1));

    const normals = new Float32Array(count * 3);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i + 1] = 1;
    }
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

    let continuation: boolean;
    try {
      continuation = this.appendOceanContinuation(geom, node, resolution);
    } catch (error) {
      geom.dispose();
      throw error;
    }

    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set(node.centerX, this.waterThreshold, node.centerZ);
    mesh.name = `WaterQT_${waterType}_${key}`;
    mesh.renderOrder = 100;
    mesh.userData = {
      type: "water",
      waterType,
      walkable: false,
      clickable: false,
    };
    mesh.layers.set(1);

    let published = false;
    try {
      this.waterSystem.registerWaterMesh(mesh, continuation);
      this.chunks.set(key, { nodeId: node.id, mesh });
      published = true;
      // Publish ownership before Three's synchronous added/childadded events.
      // A listener can retire this exact node or the whole manager here.
      this.container.add(mesh);
    } catch (error) {
      if (this.chunks.get(key)?.mesh === mesh) {
        this.onNodeDestroyGeometry(node);
      } else if (!published) {
        this.waterSystem.unregisterWaterMesh(mesh);
        mesh.removeFromParent();
        geom.dispose();
      }
      throw error;
    }
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    const key = this.chunkKey(node);
    if (this.retiringKeys.has(key)) return;
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.retireChunk(key, chunk);
  }

  // -- Helpers ----------------------------------------------------------

  private retireChunk(key: string, chunk: WaterChunk): void {
    if (this.chunks.get(key) !== chunk) return;
    // Detach ownership before synchronous childremoved/dispose listeners. A
    // listener may publish a replacement with the same node key; an old
    // retirement callback must neither recurse nor delete that replacement.
    this.chunks.delete(key);
    const alreadyRetiring = this.retiringKeys.has(key);
    this.retiringKeys.add(key);
    try {
      this.waterSystem.unregisterWaterMesh(chunk.mesh);
      try {
        chunk.mesh.removeFromParent();
      } finally {
        chunk.mesh.geometry.dispose();
      }
    } finally {
      if (!alreadyRetiring) this.retiringKeys.delete(key);
    }
  }

  /**
   * Extend the exact exposed edges of this leaf, in the same mesh. In
   * particular, do not subdivide a coarse leaf's inner edge: its displaced
   * polyline, not an independently sampled wave, is the seam authority.
   * Parent/child geometry retains the quad-tree's existing transition lifetime.
   */
  private appendOceanContinuation(
    geometry: THREE.PlaneGeometry,
    node: TerrainQuadNode,
    resolution: number,
  ): boolean {
    if (
      !this.compactOceanOwnership ||
      node.tree.config.rootChunkRadius !== 0 ||
      node.tree.config.minSize !== 100 ||
      node.tree.config.maxDepth !== 4
    )
      return false;
    let root = node;
    while (root.parent) root = root.parent;
    if (
      root.depth !== 0 ||
      root.size !== node.tree.maxSize ||
      root.halfSize !== OCEAN_CONTINUATION_ROOT_HALF_SIZE
    )
      return false;

    const stride = resolution + 1;
    const edges: number[][] = [];
    // Clockwise in XZ; each edge and its outward row then have +Y winding.
    if (node.boundingBox.zMin === root.boundingBox.zMin)
      edges.push(Array.from({ length: stride }, (_, i) => i));
    if (node.boundingBox.xMax === root.boundingBox.xMax)
      edges.push(
        Array.from({ length: stride }, (_, i) => i * stride + resolution),
      );
    if (node.boundingBox.zMax === root.boundingBox.zMax)
      edges.push(
        Array.from({ length: stride }, (_, i) => stride * stride - 1 - i),
      );
    if (node.boundingBox.xMin === root.boundingBox.xMin)
      edges.push(
        Array.from({ length: stride }, (_, i) => (resolution - i) * stride),
      );
    if (edges.length === 0) return false;

    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const shore = geometry.getAttribute("shoreDistance");
    const originalIndex = geometry.getIndex()!;
    const addedVertices = edges.length * stride * OCEAN_CONTINUATION_BANDS;
    const addedIndices =
      edges.length * resolution * OCEAN_CONTINUATION_BANDS * 6;
    const vertexCount = position.count + addedVertices;
    if (vertexCount > 65535)
      throw new Error("Ocean continuation exceeds its index budget");

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const shores = new Float32Array(vertexCount);
    const indices = new Uint16Array(originalIndex.count + addedIndices);
    positions.set(position.array);
    normals.set(normal.array);
    uvs.set(uv.array);
    shores.set(shore.array);
    indices.set(originalIndex.array);
    let nextVertex = position.count;
    let nextIndex = originalIndex.count;
    for (const edge of edges) {
      let previous = edge;
      for (let band = 1; band <= OCEAN_CONTINUATION_BANDS; band++) {
        const row: number[] = [];
        // 1 + 5*band/32 is binary-exact. Neighboring leaves of different
        // pitches share these endpoint chains, including root-corner diagonals.
        const scale =
          1 +
          ((OCEAN_CONTINUATION_OUTER_HALF_SIZE / root.halfSize - 1) * band) /
            OCEAN_CONTINUATION_BANDS;
        for (const source of edge) {
          const vertex = nextVertex++;
          row.push(vertex);
          const x =
            root.centerX +
            (position.getX(source) + node.centerX - root.centerX) * scale -
            node.centerX;
          const z =
            root.centerZ +
            (position.getZ(source) + node.centerZ - root.centerZ) * scale -
            node.centerZ;
          if (!Number.isFinite(x) || !Number.isFinite(z))
            throw new Error("Non-finite ocean continuation position");
          positions[vertex * 3] = x;
          positions[vertex * 3 + 2] = z;
          normals[vertex * 3 + 1] = 1;
          uvs[vertex * 2] = x / node.size + 0.5;
          uvs[vertex * 2 + 1] = 0.5 - z / node.size;
          shores[vertex] = 50;
        }
        for (let i = 0; i < resolution; i++) {
          indices[nextIndex++] = previous[i];
          indices[nextIndex++] = previous[i + 1];
          indices[nextIndex++] = row[i];
          indices[nextIndex++] = previous[i + 1];
          indices[nextIndex++] = row[i + 1];
          indices[nextIndex++] = row[i];
        }
        previous = row;
      }
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute(
      "shoreDistance",
      new THREE.BufferAttribute(shores, 1),
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // PlaneGeometry.parameters continues to describe the unchanged inner leaf;
    // the additional geometry is explicit rather than masquerading as that grid.
    geometry.userData.oceanContinuation = {
      version: 1,
      rootCenterX: root.centerX,
      rootCenterZ: root.centerZ,
      rootHalfSize: root.halfSize,
      outerHalfSize: OCEAN_CONTINUATION_OUTER_HALF_SIZE,
      bands: OCEAN_CONTINUATION_BANDS,
      edgeCount: edges.length,
      baseVertexCount: position.count,
      baseIndexCount: originalIndex.count,
      addedVertices,
      addedIndices,
    };
    return true;
  }

  private chunkKey(node: TerrainQuadNode): string {
    return `wq_${node.id}_d${node.depth}_${node.centerX}_${node.centerZ}`;
  }

  private hasUnderwaterArea(node: TerrainQuadNode): boolean {
    const half = node.halfSize;
    const step = node.size / (SHORE_SAMPLE_GRID - 1);
    const startX = node.centerX - half;
    const startZ = node.centerZ - half;

    for (let i = 0; i < SHORE_SAMPLE_GRID; i++) {
      for (let j = 0; j < SHORE_SAMPLE_GRID; j++) {
        const wx = startX + i * step;
        const wz = startZ + j * step;
        if (this.getHeightAt(wx, wz) < this.waterThreshold) {
          return true;
        }
      }
    }
    return false;
  }

  private determineWaterType(node: TerrainQuadNode): WaterBodyType {
    // Compact terrain has one ocean-level surface. A coastal leaf can be
    // centered inland while containing ocean: its center mask is not water
    // ownership. Authored elevated ponds have their own lake meshes below.
    if (this.compactOceanOwnership) return "ocean";
    const mask = this.getIslandMask(node.centerX, node.centerZ);
    return mask < 0.3 ? "ocean" : "lake";
  }

  /**
   * Elevated manifest ponds are independent of the ocean-level quad-tree
   * threshold. Keep their small, authored surfaces resident so a quad-tree
   * viewport cannot omit the water while retaining the matching terrain,
   * collision, resource, and camera context.
   */
  private createElevatedWaterMeshes(
    bodies: readonly ElevatedWaterBody[],
  ): void {
    const material = this.waterSystem.getMaterial("lake");
    if (!material) return;

    for (const body of bodies) {
      const segments = Math.max(32, Math.min(96, Math.ceil(body.radius * 6)));
      const geometry = new THREE.CircleGeometry(body.radius, segments);
      geometry.rotateX(-Math.PI / 2);

      const positions = geometry.getAttribute("position");
      const shoreDistances = new Float32Array(positions.count);
      for (let index = 0; index < positions.count; index += 1) {
        const distanceFromCenter = Math.hypot(
          positions.getX(index),
          positions.getZ(index),
        );
        shoreDistances[index] = Math.max(0, body.radius - distanceFromCenter);
      }
      geometry.setAttribute(
        "shoreDistance",
        new THREE.BufferAttribute(shoreDistances, 1),
      );

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(body.centerX, body.surfaceY, body.centerZ);
      mesh.name = `WaterQT_elevated_${body.id}`;
      mesh.renderOrder = 101;
      mesh.userData = {
        type: "water",
        waterType: "lake",
        waterBodyId: body.id,
        elevated: true,
        compactQuietPond: this.compactOceanOwnership && body.radius <= 12,
        walkable: false,
        clickable: false,
      };
      mesh.layers.set(1);

      this.container.add(mesh);
      this.waterSystem.registerWaterMesh(mesh);
      this.elevatedWaterMeshes.push(mesh);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [key, chunk] of this.chunks) this.retireChunk(key, chunk);
    for (const mesh of this.elevatedWaterMeshes) {
      this.waterSystem.unregisterWaterMesh(mesh);
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
    }
    this.elevatedWaterMeshes = [];
    if (this.container.parent) this.container.parent.remove(this.container);
  }
}
