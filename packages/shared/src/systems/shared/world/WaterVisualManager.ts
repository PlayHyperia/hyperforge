/**
 * WaterVisualManager — Generates flat water meshes aligned with the terrain
 * quad-tree. Compact single-root terrain publishes complete conforming ocean
 * partitions; ordinary terrain retains its per-leaf PlaneGeometry path.
 *
 * The terrain quad-tree drives split/merge. Compact events invalidate staging;
 * update() flushes it only after actual terrain ownership has settled.
 *
 * CLIENT-ONLY: Only used when USE_QUADTREE_LOD is true.
 */

import THREE from "../../../extras/three/three";
import type { TerrainQuadNode, QuadTreeListener } from "./TerrainQuadTree";
import type {
  TerrainVisualManager,
  TerrainVisualChunk,
} from "./TerrainVisualManager";
import {
  createConformingWaterGrid,
  type WaterGridSide,
} from "./ConformingWaterGrid";
import {
  createConformingWaterEdgePlan,
  type ConformingWaterLeafPlan,
} from "./ConformingWaterEdgePlan";
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

export const COMPACT_ELEVATED_WATER = Object.freeze({
  id: "canonical-basin-water-v1",
  spacing: 0.5,
  maxRadius: 32,
  maxHeightQueries: 16_641,
  maxTriangles: 65_536,
});

type PondPoint = { x: number; z: number; height: number; key: string };
type PondShore = { a: PondPoint; b: PondPoint };
type ShoreTree = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  segments?: readonly PondShore[];
  left?: ShoreTree;
  right?: ShoreTree;
};

/** Nearest horizontal distance to the sampled, piecewise-linear shoreline,
 * including every island/component. This is not terrain depth or a radial proxy. */
function pondShoreTree(segments: readonly PondShore[]): ShoreTree {
  const node: ShoreTree = {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const { a, b } of segments) {
    node.minX = Math.min(node.minX, a.x, b.x);
    node.maxX = Math.max(node.maxX, a.x, b.x);
    node.minZ = Math.min(node.minZ, a.z, b.z);
    node.maxZ = Math.max(node.maxZ, a.z, b.z);
  }
  if (segments.length <= 8) node.segments = segments;
  else {
    const x = node.maxX - node.minX >= node.maxZ - node.minZ;
    const ordered = [...segments].sort((a, b) =>
      x ? a.a.x + a.b.x - b.a.x - b.b.x : a.a.z + a.b.z - b.a.z - b.b.z,
    );
    const middle = Math.floor(ordered.length / 2);
    node.left = pondShoreTree(ordered.slice(0, middle));
    node.right = pondShoreTree(ordered.slice(middle));
  }
  return node;
}

function pondShoreDistance(x: number, z: number, root: ShoreTree): number {
  const boxDistance = (node: ShoreTree) =>
    Math.max(node.minX - x, 0, x - node.maxX) ** 2 +
    Math.max(node.minZ - z, 0, z - node.maxZ) ** 2;
  let best = Infinity;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (boxDistance(node) >= best) continue;
    if (node.segments) {
      for (const { a, b } of node.segments) {
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const length = dx * dx + dz * dz;
        const t =
          length > 0
            ? Math.max(
                0,
                Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length),
              )
            : 0;
        best = Math.min(
          best,
          (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2,
        );
      }
    } else {
      const a = node.left!,
        b = node.right!;
      // Visit the nearer child first, then prune against its actual distance.
      if (boxDistance(a) < boxDistance(b)) pending.push(b, a);
      else pending.push(a, b);
    }
  }
  return Math.sqrt(best);
}

/** Static compact pond mesh: sample once, clip every grid triangle by water
 * elevation, and retain dry islands. Resolution is fixed, not camera-dependent.
 * The contour approximates canonical terrain at 0.5m; sub-grid features are not
 * certified. A wet coverage-envelope edge is an authoring error, never a new
 * circular shoreline or a reason to coarsen the mesh. */
function createCanonicalPondGeometry(
  body: ElevatedWaterBody,
  getHeightAt: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const started = performance.now();
  const { spacing, maxRadius, maxHeightQueries, maxTriangles } =
    COMPACT_ELEVATED_WATER;
  if (
    !body.id ||
    ![body.centerX, body.centerZ, body.radius, body.surfaceY].every(
      Number.isFinite,
    ) ||
    body.radius <= 0 ||
    body.radius > maxRadius ||
    body.radiusSq !== body.radius * body.radius
  )
    throw new Error(
      "Compact pond water requires a finite radius in (0,32] and exact radiusSq",
    );
  let heightQueries = 0;
  const sample = (x: number, z: number) => {
    if (++heightQueries > maxHeightQueries)
      throw new Error("Compact pond height-query budget exceeded");
    const height = getHeightAt(body.centerX + x, body.centerZ + z);
    if (!Number.isFinite(height))
      throw new Error("Compact pond canonical height is nonfinite");
    return height;
  };
  const perimeterSamples = Math.max(
    8,
    Math.ceil((2 * Math.PI * body.radius) / spacing),
  );
  for (let i = 0; i < perimeterSamples; i++) {
    const angle = (2 * Math.PI * i) / perimeterSamples;
    if (
      sample(Math.cos(angle) * body.radius, Math.sin(angle) * body.radius) <
      body.surfaceY
    )
      throw new Error("Compact pond basin touches its water coverage envelope");
  }
  const half = Math.ceil(body.radius / spacing),
    size = half * 2,
    stride = size + 1;
  const points: PondPoint[] = [];
  const guardRadiusSq = (body.radius + Math.SQRT2 * spacing) ** 2;
  for (let iz = 0; iz <= size; iz++)
    for (let ix = 0; ix <= size; ix++) {
      const x = (ix - half) * spacing,
        z = (iz - half) * spacing;
      // The one-cell guard samples real ground outside the disk too. Irrelevant
      // square corners cannot contribute a wet polygon or spend canonical work.
      const height =
        x * x + z * z <= guardRadiusSq ? sample(x, z) : body.surfaceY;
      points.push({ x, z, height, key: `g${iz * stride + ix}` });
    }
  const gridSamples = heightQueries - perimeterSamples;
  const crossings = new Map<string, PondPoint>();
  const edge = (a: PondPoint, b: PondPoint): PondPoint => {
    if (a.height === body.surfaceY) return a;
    if (b.height === body.surfaceY) return b;
    const key = a.key < b.key ? `${a.key}:${b.key}` : `${b.key}:${a.key}`;
    let point = crossings.get(key);
    if (!point) {
      // Canonical edge orientation gives bit-identical shared intersections.
      if (a.key > b.key) [a, b] = [b, a];
      const t = (body.surfaceY - a.height) / (b.height - a.height);
      point = {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        height: body.surfaceY,
        key,
      };
      crossings.set(key, point);
    }
    return point;
  };
  const vertices: PondPoint[] = [],
    indices: number[] = [];
  const vertexIds = new Map<string, number>();
  const shores: PondShore[] = [];
  const vertex = (point: PondPoint): number => {
    let id = vertexIds.get(point.key);
    if (id !== undefined) return id;
    // Circle is convex: all accepted triangle interiors remain in the disk.
    // Include Float32 storage in this check, not merely the double precursor.
    const x = Math.fround(point.x),
      z = Math.fround(point.z);
    if (x * x + z * z > body.radiusSq)
      throw new Error(
        "Compact pond sampled wet geometry escapes its coverage envelope",
      );
    id = vertices.length;
    vertices.push({ ...point, x, z });
    vertexIds.set(point.key, id);
    return id;
  };
  const triangle = (a: PondPoint, b: PondPoint, c: PondPoint) => {
    const input = [a, b, c];
    if (input.every((p) => p.height >= body.surfaceY)) return;
    const polygon: PondPoint[] = [];
    for (let i = 0; i < 3; i++) {
      const previous = input[(i + 2) % 3],
        current = input[i];
      const beforeWet = previous.height < body.surfaceY,
        currentWet = current.height < body.surfaceY;
      if (beforeWet !== currentWet) polygon.push(edge(previous, current));
      if (currentWet) polygon.push(current);
    }
    const unique = polygon.filter(
      (p, i) => i === 0 || p.key !== polygon[i - 1].key,
    );
    if (unique.length > 1 && unique[0].key === unique[unique.length - 1].key)
      unique.pop();
    if (unique.length < 3) return;
    for (let i = 1; i < unique.length - 1; i++) {
      const p = unique[0],
        q = unique[i],
        r = unique[i + 1];
      const px = Math.fround(p.x),
        pz = Math.fround(p.z);
      const qx = Math.fround(q.x),
        qz = Math.fround(q.z);
      const rx = Math.fround(r.x),
        rz = Math.fround(r.z);
      if ((qz - pz) * (rx - px) - (qx - px) * (rz - pz) <= 0) continue;
      indices.push(vertex(p), vertex(q), vertex(r));
      if (indices.length / 3 > maxTriangles)
        throw new Error("Compact pond triangle budget exceeded");
    }
  };
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const a = points[z * stride + x],
        b = points[z * stride + x + 1];
      const c = points[(z + 1) * stride + x],
        d = points[(z + 1) * stride + x + 1];
      // +Y winding, with identical diagonals throughout the static lattice.
      triangle(a, c, b);
      triangle(b, c, d);
    }
  // Derive the boundary from the actual stored triangles, including every
  // inner loop. This also detects a wet boundary cut off by the sampled grid.
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < indices.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j],
        b = indices[i + ((j + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = edges.get(key);
      if (existing) {
        if (++existing.count > 2)
          throw new Error("Compact pond has a nonmanifold boundary");
      } else edges.set(key, { a, b, count: 1 });
    }
  for (const { a, b, count } of edges.values())
    if (count === 1) {
      if (
        vertices[a].height !== body.surfaceY ||
        vertices[b].height !== body.surfaceY
      )
        throw new Error(
          "Compact pond sampled wet boundary is not a terrain shoreline",
        );
      shores.push({ a: vertices[a], b: vertices[b] });
    }
  if (!indices.length || !shores.length)
    throw new Error(
      "Compact pond requires a sampled wet basin with a dry shoreline",
    );
  const tree = pondShoreTree(shores);
  const positions = new Float32Array(vertices.length * 3);
  const normals = new Float32Array(vertices.length * 3);
  const uvs = new Float32Array(vertices.length * 2);
  const distances = new Float32Array(vertices.length);
  for (const [i, point] of vertices.entries()) {
    positions[i * 3] = point.x;
    positions[i * 3 + 2] = point.z;
    normals[i * 3 + 1] = 1;
    uvs[i * 2] = 0.5 + point.x / (2 * body.radius);
    uvs[i * 2 + 1] = 0.5 - point.z / (2 * body.radius);
    distances[i] =
      point.height === body.surfaceY
        ? 0
        : pondShoreDistance(point.x, point.z, tree);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "shoreDistance",
    new THREE.BufferAttribute(distances, 1),
  );
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.elevatedWater = Object.freeze({
    id: COMPACT_ELEVATED_WATER.id,
    spacing,
    radius: body.radius,
    heightQueries,
    gridSamples,
    perimeterSamples,
    shoreSegments: shores.length,
    vertices: vertices.length,
    triangles: indices.length / 3,
    setupMs: performance.now() - started,
  });
  return geometry;
}

// One broadcast root is 1,600 m wide. Its ocean continues to a 3,600 m
// square, leaving at least 1,000 m to the edge for an eye inside the root
// (the unchanged fog is complete at 800 m). No additional terrain is made.
const OCEAN_CONTINUATION_BANDS = 8;
const OCEAN_CONTINUATION_ROOT_HALF_SIZE = 800;
const OCEAN_CONTINUATION_OUTER_HALF_SIZE = 1800;

export const COMPACT_CONFORMING_WATER = Object.freeze({
  id: "compact-conforming-ocean-v1",
  latticeSpacing: 6.25,
  maxLeavesPerUpdate: 8,
  maxMeshesPerUpdate: 2,
  updateTargetMs: 2,
});
const CONFORMING_RESOLUTION = [2, 4, 8, 16, 16] as const;
const GRID_SIDES: readonly WaterGridSide[] = ["minX", "maxX", "minZ", "maxZ"];

interface WaterChunk {
  nodeId: number;
  mesh: THREE.Mesh;
  signature?: string;
  ownedGeometry?: THREE.BufferGeometry;
}

type FrontierLeaf = {
  node: TerrainQuadNode;
  owner: TerrainVisualChunk;
  geometry: THREE.BufferGeometry;
};
type WaterStage = {
  epoch: number;
  root: TerrainQuadNode;
  frontier: readonly FrontierLeaf[];
  plans: readonly ConformingWaterLeafPlan[];
  next: number;
  chunks: Map<string, WaterChunk>;
  created: WaterChunk[];
};

export class WaterVisualManager implements QuadTreeListener {
  private container: THREE.Group;
  private waterSystem: WaterSystem;
  private getHeightAt: (x: number, z: number) => number;
  private readonly getElevatedGroundHeight: (x: number, z: number) => number;
  private getIslandMask: (x: number, z: number) => number;
  private waterThreshold: number;
  private readonly compactOceanOwnership: boolean;
  private chunks = new Map<string, WaterChunk>();
  private retiringKeys = new Set<string>();
  private elevatedWaterMeshes: THREE.Mesh[] = [];
  private destroyed = false;
  private readonly terrainVisual: TerrainVisualManager | null;
  private readonly conforming: boolean;
  private topologyDirty = true;
  private topologyEpoch = 0;
  private topologyRevision = 0;
  private topologyLeaves = 0;
  private topologyError: string | null = null;
  private updatingTopology = false;
  private staging: WaterStage | null = null;
  private readonly disposedChunks = new WeakSet<WaterChunk>();

  constructor(
    container: THREE.Group,
    waterSystem: WaterSystem,
    getHeightAt: (x: number, z: number) => number,
    getIslandMask: (x: number, z: number) => number,
    waterThreshold: number,
    elevatedWaterBodies: readonly ElevatedWaterBody[] = [],
    terrainProfile?: WorldTerrainProfile,
    terrainVisual?: TerrainVisualManager,
    getElevatedGroundHeight?: (x: number, z: number) => number,
  ) {
    const profile =
      terrainProfile === undefined
        ? undefined
        : validateWorldTerrainProfile(terrainProfile);
    if (profile && profile.water.threshold !== waterThreshold) {
      throw new Error("Water visual threshold differs from terrain profile");
    }
    this.compactOceanOwnership = profile?.kind === "compact-candidate";
    this.terrainVisual = terrainVisual ?? null;
    const config = terrainVisual?.getQuadTree().config;
    this.conforming = Boolean(
      this.compactOceanOwnership &&
      config &&
      config.rootChunkRadius === 0 &&
      config.minSize === 100 &&
      config.maxDepth === 4,
    );
    this.container = container;
    this.waterSystem = waterSystem;
    this.getHeightAt = getHeightAt;
    this.getElevatedGroundHeight = getElevatedGroundHeight ?? getHeightAt;
    this.getIslandMask = getIslandMask;
    this.waterThreshold = waterThreshold;
    this.createElevatedWaterMeshes(elevatedWaterBodies);
  }

  // -- QuadTreeListener -------------------------------------------------

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    if (this.destroyed) return;
    if (this.conforming) {
      this.invalidateTopology();
      return;
    }
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
    // Chunk-local placement is immutable; parent/world transforms stay live.
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
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
    if (this.conforming) {
      if (!this.destroyed) this.invalidateTopology();
      return;
    }
    const key = this.chunkKey(node);
    if (this.retiringKeys.has(key)) return;
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.retireChunk(key, chunk);
  }

  // -- Helpers ----------------------------------------------------------

  private invalidateTopology(): void {
    this.topologyEpoch++;
    this.topologyDirty = true;
    this.topologyError = null;
  }

  getConformingReadiness() {
    return {
      id: COMPACT_CONFORMING_WATER.id,
      required: this.conforming,
      ready:
        !this.destroyed &&
        (!this.conforming ||
          (this.topologyRevision > 0 &&
            !this.topologyDirty &&
            !this.staging &&
            !this.topologyError)),
      revision: this.topologyRevision,
      partitionLeaves: this.topologyLeaves,
      waterChunks: this.chunks.size,
      stagedChunks: this.staging?.created.length ?? 0,
      pending: this.conforming && (this.topologyDirty || this.staging !== null),
      error: this.topologyError,
    };
  }

  /** Called AFTER terrain's settled/synchronous publications, before rendering.
   * Keep the previous complete water partition while at most two new meshes are
   * built per update. The time target is checked between indivisible leaf builds,
   * not claimed as a hard frame-time guarantee. Unchanged updates allocate none.
   */
  update(): void {
    if (
      !this.conforming ||
      this.destroyed ||
      this.updatingTopology ||
      (!this.topologyDirty && !this.staging)
    )
      return;
    this.updatingTopology = true;
    try {
      if (
        this.staging &&
        (this.staging.epoch !== this.topologyEpoch ||
          !this.frontierCurrent(this.staging))
      )
        this.cancelStage();
      if (this.destroyed) return;
      if (!this.staging) {
        for (
          let owner: THREE.Object3D | null = this.container;
          owner;
          owner = owner.parent
        ) {
          if (
            owner.position.lengthSq() !== 0 ||
            owner.rotation.x !== 0 ||
            owner.rotation.y !== 0 ||
            owner.rotation.z !== 0 ||
            owner.scale.x !== 1 ||
            owner.scale.y !== 1 ||
            owner.scale.z !== 1 ||
            (!owner.matrixAutoUpdate &&
              !owner.matrix.equals(new THREE.Matrix4()))
          )
            throw new Error(
              "Conforming water requires identity world-XZ parent transforms",
            );
        }
        const selected = this.selectFrontier();
        // Initial descendants can publish without a destruction callback: keep
        // retrying this incomplete epoch until all four branches actually exist.
        if (!selected) return;
        const { root, frontier } = selected;
        const plan = createConformingWaterEdgePlan({
          root,
          lattice: {
            originX: 0,
            originZ: 0,
            spacing: COMPACT_CONFORMING_WATER.latticeSpacing,
          },
          leaves: frontier.map(({ node }) => ({
            id: node.id,
            depth: node.depth,
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            spacing: node.size / CONFORMING_RESOLUTION[node.depth],
          })),
        });
        const byId = new Map(frontier.map((leaf) => [leaf.node.id, leaf]));
        this.staging = {
          epoch: this.topologyEpoch,
          root,
          frontier: plan.leaves.map((leaf) => byId.get(leaf.id)!),
          plans: plan.leaves,
          next: 0,
          chunks: new Map(),
          created: [],
        };
      }
      const stage = this.staging;
      const started = performance.now();
      let checked = 0,
        built = 0;
      while (
        stage.next < stage.plans.length &&
        checked < COMPACT_CONFORMING_WATER.maxLeavesPerUpdate &&
        built < COMPACT_CONFORMING_WATER.maxMeshesPerUpdate
      ) {
        if (
          checked &&
          performance.now() - started >= COMPACT_CONFORMING_WATER.updateTargetMs
        )
          break;
        const plan = stage.plans[stage.next],
          leaf = stage.frontier[stage.next];
        stage.next++;
        checked++;
        if (!this.hasUnderwaterArea(leaf.node)) continue;
        const key = this.chunkKey(leaf.node);
        const signature = [
          stage.root.centerX,
          stage.root.centerZ,
          stage.root.size,
          plan.spacing,
          plan.bounds.minX,
          plan.bounds.maxX,
          plan.bounds.minZ,
          plan.bounds.maxZ,
          ...GRID_SIDES.flatMap((side) => [side, ...plan.edges[side]]),
        ].join(",");
        const existing = this.chunks.get(key);
        if (
          existing?.signature === signature &&
          this.conformingChunkCurrent(existing, true)
        ) {
          stage.chunks.set(key, existing);
          continue;
        }
        const chunk = this.createConformingChunk(
          leaf.node,
          plan,
          stage.root,
          signature,
        );
        if (!chunk) {
          this.cancelStage();
          return;
        }
        stage.created.push(chunk);
        stage.chunks.set(key, chunk);
        built++;
        // Register ownership before any synchronous scene callback. New meshes
        // remain hidden until the whole partition is ready, including dry leaves.
        this.waterSystem.registerWaterMesh(chunk.mesh, true);
        this.container.add(chunk.mesh);
        if (
          this.destroyed ||
          stage.epoch !== this.topologyEpoch ||
          this.staging !== stage ||
          !this.conformingChunkCurrent(chunk, false) ||
          !this.frontierCurrent(stage)
        ) {
          this.cancelStage();
          return;
        }
      }
      if (stage.next === stage.plans.length) {
        if (!this.frontierCurrent(stage)) {
          this.cancelStage();
          return;
        }
        const created = new Set(stage.created);
        if (
          ![...stage.chunks.values()].every((chunk) =>
            this.conformingChunkCurrent(chunk, !created.has(chunk)),
          )
        )
          throw new Error(
            "Conforming water staged ownership changed before publication",
          );
        const previous = this.chunks;
        // No events or renderer work between ownership/visibility assignments.
        // Removed/dispose listeners below always see the complete new partition.
        this.chunks = stage.chunks;
        this.staging = null;
        this.topologyLeaves = stage.plans.length;
        this.topologyRevision++;
        this.topologyDirty = false;
        for (const [key, chunk] of previous)
          if (this.chunks.get(key) !== chunk) chunk.mesh.visible = false;
        for (const chunk of this.chunks.values()) chunk.mesh.visible = true;
        this.disposeChunks(
          [...previous]
            .filter(([key, chunk]) => this.chunks.get(key) !== chunk)
            .map(([, chunk]) => chunk),
        );
      }
    } catch (error) {
      this.topologyError = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 512);
      this.topologyDirty = false;
      try {
        this.cancelStage();
      } catch (cleanup) {
        this.topologyError += `; cleanup: ${String(cleanup).slice(0, 256)}`;
      }
      // The readiness gate exposes failure; never publish a partial substitute.
    } finally {
      this.updatingTopology = false;
    }
  }

  private selectFrontier(): {
    root: TerrainQuadNode;
    frontier: FrontierLeaf[];
  } | null {
    const terrain = this.terrainVisual!;
    const roots = new Set<TerrainQuadNode>();
    for (let node of terrain.getQuadTree().getFinalNodes()) {
      while (node.parent) node = node.parent;
      roots.add(node);
    }
    if (!roots.size) return null;
    if (roots.size !== 1)
      throw new Error("Conforming water requires one complete terrain root");
    const root = [...roots][0],
      frontier: FrontierLeaf[] = [];
    const visit = (node: TerrainQuadNode): boolean => {
      if (terrain.hasInstalledChunk(node)) {
        const owner = terrain.getChunks().get(node.visualChunkKey!)!;
        frontier.push({ node, owner, geometry: owner.mesh.geometry });
        return true;
      }
      if (node.children.size !== 4) return false;
      for (const child of node.children.values())
        if (!visit(child)) return false;
      return true;
    };
    return visit(root) ? { root, frontier } : null;
  }

  private frontierCurrent(stage: WaterStage): boolean {
    const current = this.selectFrontier();
    if (
      !current ||
      current.root !== stage.root ||
      current.frontier.length !== stage.frontier.length
    )
      return false;
    const admitted = new Map(
      stage.frontier.map((leaf) => [leaf.node.id, leaf]),
    );
    return current.frontier.every((leaf) => {
      const old = admitted.get(leaf.node.id);
      return (
        old?.node === leaf.node &&
        old.owner === leaf.owner &&
        old.geometry === leaf.geometry
      );
    });
  }

  private createConformingChunk(
    node: TerrainQuadNode,
    plan: ConformingWaterLeafPlan,
    root: TerrainQuadNode,
    signature: string,
  ): WaterChunk | null {
    const material = this.waterSystem.getMaterial("ocean");
    if (!material) return null;
    const grid = createConformingWaterGrid(plan),
      geometry = grid.geometry;
    try {
      geometry.setAttribute(
        "shoreDistance",
        new THREE.BufferAttribute(
          new Float32Array(geometry.getAttribute("position").count).fill(50),
          1,
        ),
      );
      geometry.userData.conformingWater = Object.freeze({
        id: COMPACT_CONFORMING_WATER.id,
        bounds: plan.bounds,
        spacing: plan.spacing,
        lattice: plan.lattice,
        edges: Object.freeze(
          Object.fromEntries(
            GRID_SIDES.map((side) => [
              side,
              Object.freeze(Array.from(grid.edges[side])),
            ]),
          ),
        ),
        counts: grid.counts,
      });
      this.appendConformingContinuation(geometry, grid.edges, plan, root);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(0, this.waterThreshold, 0);
      // Freeze only local placement, never the inherited world transform.
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.name = `WaterQT_ocean_${this.chunkKey(node)}`;
      mesh.renderOrder = 100;
      mesh.visible = false;
      mesh.layers.set(1);
      mesh.userData = {
        type: "water",
        waterType: "ocean",
        walkable: false,
        clickable: false,
      };
      return { nodeId: node.id, mesh, signature, ownedGeometry: geometry };
    } catch (error) {
      geometry.dispose();
      throw error;
    }
  }

  private conformingChunkCurrent(chunk: WaterChunk, visible: boolean): boolean {
    const mesh = chunk.mesh;
    return (
      !this.disposedChunks.has(chunk) &&
      mesh.parent === this.container &&
      mesh.geometry === chunk.ownedGeometry &&
      mesh.material === this.waterSystem.getMaterial("ocean") &&
      mesh.visible === visible &&
      mesh.position.x === 0 &&
      mesh.position.y === this.waterThreshold &&
      mesh.position.z === 0 &&
      mesh.rotation.x === 0 &&
      mesh.rotation.y === 0 &&
      mesh.rotation.z === 0 &&
      mesh.scale.x === 1 &&
      mesh.scale.y === 1 &&
      mesh.scale.z === 1
    );
  }

  private cancelStage(): void {
    const stage = this.staging;
    this.staging = null;
    if (stage) this.disposeChunks(stage.created);
  }

  /** Dispose detached ownership; never delete a same-key replacement. */
  private disposeChunks(chunks: readonly WaterChunk[]): void {
    let failure: unknown;
    for (const chunk of chunks) {
      if (this.disposedChunks.has(chunk)) continue;
      this.disposedChunks.add(chunk);
      try {
        try {
          this.waterSystem.unregisterWaterMesh(chunk.mesh);
        } finally {
          try {
            chunk.mesh.removeFromParent();
          } finally {
            (chunk.ownedGeometry ?? chunk.mesh.geometry).dispose();
          }
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private appendConformingContinuation(
    geometry: THREE.BufferGeometry,
    gridEdges: Readonly<Record<WaterGridSide, Uint32Array>>,
    plan: ConformingWaterLeafPlan,
    root: TerrainQuadNode,
  ): void {
    if (root.halfSize !== OCEAN_CONTINUATION_ROOT_HALF_SIZE)
      throw new Error("Unexpected compact ocean root extent");
    const edges: number[][] = [];
    if (plan.bounds.minZ === root.boundingBox.zMin)
      edges.push(Array.from(gridEdges.minZ));
    if (plan.bounds.maxX === root.boundingBox.xMax)
      edges.push(Array.from(gridEdges.maxX));
    if (plan.bounds.maxZ === root.boundingBox.zMax)
      edges.push(Array.from(gridEdges.maxZ).reverse());
    if (plan.bounds.minX === root.boundingBox.xMin)
      edges.push(Array.from(gridEdges.minX).reverse());
    if (!edges.length) return;
    const position = geometry.getAttribute("position"),
      normal = geometry.getAttribute("normal"),
      uv = geometry.getAttribute("uv"),
      shore = geometry.getAttribute("shoreDistance"),
      originalIndex = geometry.getIndex()!;
    const addedVertices =
      edges.reduce((sum, edge) => sum + edge.length, 0) *
      OCEAN_CONTINUATION_BANDS;
    const addedIndices =
      edges.reduce((sum, edge) => sum + edge.length - 1, 0) *
      OCEAN_CONTINUATION_BANDS *
      6;
    const count = position.count + addedVertices;
    if (count > 65535)
      throw new Error("Conforming ocean continuation exceeds its index budget");
    const positions = new Float32Array(count * 3),
      normals = new Float32Array(count * 3),
      uvs = new Float32Array(count * 2),
      shores = new Float32Array(count),
      indices = new Uint16Array(originalIndex.count + addedIndices);
    positions.set(position.array);
    normals.set(normal.array);
    uvs.set(uv.array);
    shores.set(shore.array);
    indices.set(originalIndex.array);
    let nextVertex = position.count,
      nextIndex = originalIndex.count;
    for (const edge of edges) {
      let previous = edge;
      for (let band = 1; band <= OCEAN_CONTINUATION_BANDS; band++) {
        const row: number[] = [],
          scale = 1 + (5 * band) / 32;
        for (const source of edge) {
          const vertex = nextVertex++;
          row.push(vertex);
          const x =
            root.centerX + (position.getX(source) - root.centerX) * scale;
          const z =
            root.centerZ + (position.getZ(source) - root.centerZ) * scale;
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(z) ||
            Math.fround(x) !== x ||
            Math.fround(z) !== z
          )
            throw new Error(
              "Conforming continuation lost exact world coordinates",
            );
          positions[vertex * 3] = x;
          positions[vertex * 3 + 2] = z;
          normals[vertex * 3 + 1] = 1;
          shores[vertex] = 50;
          uvs[vertex * 2] =
            (x - plan.bounds.minX) / (plan.bounds.maxX - plan.bounds.minX);
          uvs[vertex * 2 + 1] =
            1 - (z - plan.bounds.minZ) / (plan.bounds.maxZ - plan.bounds.minZ);
        }
        for (let i = 0; i < edge.length - 1; i++) {
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
    geometry.userData.oceanContinuation = Object.freeze({
      version: 2,
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
    });
  }

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

    try {
      for (const body of bodies) {
        let geometry: THREE.BufferGeometry;
        if (this.compactOceanOwnership) {
          geometry = createCanonicalPondGeometry(
            body,
            this.getElevatedGroundHeight,
          );
        } else {
          const segments = Math.max(
            32,
            Math.min(96, Math.ceil(body.radius * 6)),
          );
          geometry = new THREE.CircleGeometry(body.radius, segments);
          geometry.rotateX(-Math.PI / 2);

          const positions = geometry.getAttribute("position");
          const shoreDistances = new Float32Array(positions.count);
          for (let index = 0; index < positions.count; index += 1) {
            const distanceFromCenter = Math.hypot(
              positions.getX(index),
              positions.getZ(index),
            );
            shoreDistances[index] = Math.max(
              0,
              body.radius - distanceFromCenter,
            );
          }
          geometry.setAttribute(
            "shoreDistance",
            new THREE.BufferAttribute(shoreDistances, 1),
          );
        }

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(body.centerX, body.surfaceY, body.centerZ);
        // The authored pond stays rigid while its parent/world transform is live.
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.name = `WaterQT_elevated_${body.id}`;
        mesh.renderOrder = 101;
        mesh.userData = {
          type: "water",
          waterType: "lake",
          waterBodyId: body.id,
          elevated: true,
          compactQuietPond: this.compactOceanOwnership,
          walkable: false,
          clickable: false,
        };
        mesh.layers.set(1);

        // Own the resource before synchronous scene callbacks can throw.
        this.elevatedWaterMeshes.push(mesh);
        this.container.add(mesh);
        this.waterSystem.registerWaterMesh(mesh);
      }
    } catch (error) {
      // The container and material are borrowed. In particular, a rejected
      // second basin must not leak the first or remove pre-existing children.
      try {
        this.disposeElevatedWaterMeshes();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Elevated water construction and rollback failed",
        );
      }
      throw error;
    }
  }

  private disposeElevatedWaterMeshes(): void {
    const meshes = this.elevatedWaterMeshes.splice(0);
    const failures: unknown[] = [];
    for (const mesh of meshes) {
      for (const release of [
        () => this.waterSystem.unregisterWaterMesh(mesh),
        () => mesh.removeFromParent(),
        () => mesh.geometry.dispose(),
      ]) {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Elevated water cleanup failed");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    let failure: unknown;
    if (this.conforming) {
      const active = [...this.chunks.values()],
        staged = this.staging?.created ?? [];
      this.chunks = new Map();
      this.staging = null;
      try {
        this.disposeChunks([...active, ...staged]);
      } catch (error) {
        failure = error;
      }
    }
    for (const [key, chunk] of this.chunks) this.retireChunk(key, chunk);
    try {
      this.disposeElevatedWaterMeshes();
    } catch (error) {
      failure ??= error;
    }
    if (this.container.parent) this.container.parent.remove(this.container);
    if (failure !== undefined) throw failure;
  }
}
