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

const WATER_RESOLUTION_BY_DEPTH: Record<number, number> = {
  0: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
};

const SHORE_SAMPLE_GRID = 5;

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
  private chunks = new Map<string, WaterChunk>();
  private elevatedWaterMeshes: THREE.Mesh[] = [];

  constructor(
    container: THREE.Group,
    waterSystem: WaterSystem,
    getHeightAt: (x: number, z: number) => number,
    getIslandMask: (x: number, z: number) => number,
    waterThreshold: number,
    elevatedWaterBodies: readonly ElevatedWaterBody[] = [],
  ) {
    this.container = container;
    this.waterSystem = waterSystem;
    this.getHeightAt = getHeightAt;
    this.getIslandMask = getIslandMask;
    this.waterThreshold = waterThreshold;
    this.createElevatedWaterMeshes(elevatedWaterBodies);
  }

  // -- QuadTreeListener -------------------------------------------------

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    const key = this.chunkKey(node);
    if (this.chunks.has(key)) return;

    if (!this.hasUnderwaterArea(node)) return;

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

    const waterType = this.determineWaterType(node);
    const material = this.waterSystem.getMaterial(waterType);
    if (!material) return;

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

    this.container.add(mesh);
    this.waterSystem.registerWaterMesh(mesh);
    this.chunks.set(key, { nodeId: node.id, mesh });
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    const key = this.chunkKey(node);
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    this.waterSystem.unregisterWaterMesh(chunk.mesh);
    if (chunk.mesh.parent) chunk.mesh.parent.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    this.chunks.delete(key);
  }

  // -- Helpers ----------------------------------------------------------

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
    for (const [, chunk] of this.chunks) {
      this.waterSystem.unregisterWaterMesh(chunk.mesh);
      if (chunk.mesh.parent) chunk.mesh.parent.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    this.chunks.clear();
    for (const mesh of this.elevatedWaterMeshes) {
      this.waterSystem.unregisterWaterMesh(mesh);
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
    }
    this.elevatedWaterMeshes = [];
    if (this.container.parent) this.container.parent.remove(this.container);
  }
}
