/**
 * TerrainVisualManager — Manages the lifecycle of quad-tree terrain visual chunks.
 *
 * Listens to TerrainQuadTree events, dispatches heavy computation to
 * QuadChunkWorker, assembles geometry on the main thread via
 * TerrainQuadChunkGenerator, and adds/removes meshes from the scene.
 *
 * CLIENT-ONLY: Server terrain uses the flat tile grid.
 */

import THREE from "../../../extras/three/three";
import {
  TerrainQuadTree,
  type TerrainQuadNode,
  type QuadTreeConfig,
  type QuadTreeListener,
} from "./TerrainQuadTree";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "./TerrainQuadChunkGenerator";
import {
  generateQuadChunkAsync,
  isQuadChunkWorkerAvailable,
  type QuadChunkWorkerConfig,
  type QuadChunkWorkerInput,
  type QuadChunkWorkerOutput,
} from "../../../utils/workers/QuadChunkWorker";
import { assertTerrainWorkerRequest } from "../../../utils/workers/TerrainWorkerShared";

export type VisualManagerTerrainProvider = FullTerrainProvider;

export interface TerrainVisualChunk {
  key: string;
  node: TerrainQuadNode;
  mesh: THREE.Mesh;
  heightData: Float32Array;
}

export interface TerrainVisualReadiness {
  ready: boolean;
  criticalRadius: number;
  requiredChunks: number;
  readyChunks: number;
  pendingChunks: number;
}

interface SettledWorkerResult {
  nodeId: number;
  node: TerrainQuadNode;
  result: QuadChunkWorkerOutput | null;
  error: unknown;
}

/**
 * Orchestrates quad-tree LOD terrain rendering with async worker dispatch.
 */
export class TerrainVisualManager implements QuadTreeListener {
  private quadTree: TerrainQuadTree;
  private provider: VisualManagerTerrainProvider;
  private readonly terrainProfileIdentity: string;
  private container: THREE.Group;
  private material: THREE.Material;
  private chunks = new Map<string, TerrainVisualChunk>();
  private playerX = 0;
  private playerZ = 0;
  private debugWireframe: boolean;
  private receiveShadow: boolean;
  private castShadow: boolean;
  private workerConfig: QuadChunkWorkerConfig;
  private workerSeed: number;
  private workerBiomeCenters: QuadChunkWorkerInput["biomeCenters"];
  private workerBiomes: QuadChunkWorkerInput["biomes"];
  private useWorkers: boolean;

  /** Node IDs with in-flight worker promises */
  private pendingNodeIds = new Set<number>();
  /** Settled worker results ready for main-thread assembly */
  private settledResults: SettledWorkerResult[] = [];
  /** Sync fallback queue (used when workers unavailable) */
  private syncQueue: TerrainQuadNode[] = [];
  /** Destroyed node IDs that should be ignored when results come back */
  private cancelledNodeIds = new Set<number>();
  /** Tracks generation failure count per node ID for bounded retry */
  private failedAttempts = new Map<number, number>();
  /** Whether initial sync bootstrap has run for the current tree structure */
  private syncBootstrapped = false;

  private maxSyncChunksPerFrame: number;
  private maxAssembliesPerFrame: number;

  private framesSinceInit = 0;
  /** Give healthy workers two seconds at 60 FPS before bounded sync failover. */
  private static SYNC_BOOTSTRAP_DELAY_FRAMES = 120;
  private static MAX_GENERATION_RETRIES = 5;

  constructor(
    config: Partial<QuadTreeConfig>,
    provider: VisualManagerTerrainProvider,
    container: THREE.Group,
    material: THREE.Material,
    workerConfig: QuadChunkWorkerConfig,
    workerSeed: number,
    workerBiomeCenters: QuadChunkWorkerInput["biomeCenters"],
    workerBiomes: QuadChunkWorkerInput["biomes"],
    debugWireframe = false,
    receiveShadow = false,
    castShadow = false,
    maxSyncChunksPerFrame = 4,
    maxAssembliesPerFrame = 6,
  ) {
    // Validate once, before tree creation or worker dispatch. Result admission
    // below uses cached string equality, never per-vertex profile serialization.
    assertTerrainWorkerRequest(workerConfig, workerSeed);
    if (
      provider.terrainProfileIdentity !== workerConfig.TERRAIN_PROFILE_IDENTITY
    ) {
      throw new Error(
        "Terrain visual provider/worker profile identity mismatch",
      );
    }
    if (
      provider.TILE_SIZE !== workerConfig.TILE_SIZE ||
      provider.MAX_HEIGHT !== workerConfig.MAX_HEIGHT ||
      provider.WATER_LEVEL_NORMALIZED !== workerConfig.WATER_LEVEL_NORMALIZED ||
      provider.SHORELINE_THRESHOLD !== workerConfig.SHORELINE_THRESHOLD ||
      provider.SHORELINE_STRENGTH !== workerConfig.SHORELINE_STRENGTH
    ) {
      throw new Error("Terrain visual provider/worker derived config mismatch");
    }
    this.terrainProfileIdentity = provider.terrainProfileIdentity;
    this.provider = provider;
    this.container = container;
    this.material = material;
    this.debugWireframe = debugWireframe;
    this.receiveShadow = receiveShadow;
    this.castShadow = castShadow;
    this.maxSyncChunksPerFrame = maxSyncChunksPerFrame;
    this.maxAssembliesPerFrame = maxAssembliesPerFrame;
    this.workerConfig = workerConfig;
    this.workerSeed = workerSeed;
    this.workerBiomeCenters = workerBiomeCenters;
    this.workerBiomes = workerBiomes;
    this.useWorkers = isQuadChunkWorkerAvailable();

    this.quadTree = new TerrainQuadTree(config);
    this.quadTree.setListener(this);
  }

  update(playerX: number, playerZ: number): void {
    this.playerX = playerX;
    this.playerZ = playerZ;
    const structureChanged = this.quadTree.update(playerX, playerZ);
    if (structureChanged) {
      this.framesSinceInit = 0;
      this.syncBootstrapped = false;
    }

    if (
      !this.syncBootstrapped &&
      this.framesSinceInit >=
        TerrainVisualManager.SYNC_BOOTSTRAP_DELAY_FRAMES &&
      this.chunks.size === 0 &&
      this.pendingNodeIds.size > 0
    ) {
      this.syncBootstrapNearbyChunks();
    }

    this.processSettledResults();
    this.processSyncQueue();
    this.framesSinceInit++;
  }

  dispose(): void {
    this.quadTree.dispose();
    for (const chunk of this.chunks.values()) {
      this.removeMeshFromScene(chunk);
    }
    this.chunks.clear();
    this.pendingNodeIds.clear();
    this.settledResults = [];
    this.syncQueue = [];
    this.cancelledNodeIds.clear();
    this.failedAttempts.clear();

    if (this.container.parent) {
      this.container.parent.remove(this.container);
    }
  }

  getQuadTree(): TerrainQuadTree {
    return this.quadTree;
  }

  getChunks(): ReadonlyMap<string, TerrainVisualChunk> {
    return this.chunks;
  }

  /**
   * Compile the exact quad-tree terrain pipeline before the first generated
   * chunk reaches the scene. A flat-grid terrain tile is not representative:
   * quad chunks have additional biome/road attributes, skirts, and a Uint32
   * index, all of which participate in WebGPU pipeline creation.
   */
  async precompileRepresentativeChunk(
    centerX: number,
    centerZ: number,
    precompileObject: (object: THREE.Object3D) => Promise<void>,
  ): Promise<void> {
    const config = this.quadTree.config;
    const workerData = generateQuadChunkDataSync(
      centerX,
      centerZ,
      config.minSize,
      config.resolution,
      this.provider,
    );
    const { geometry } = assembleQuadChunkGeometry(
      workerData,
      this.provider,
      config.skirtDrop,
    );

    const ownsMaterial = this.debugWireframe;
    const material = ownsMaterial
      ? new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true })
      : this.material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(centerX, 0, centerZ);
    mesh.name = "QuadTerrain_PrecompileSample";
    mesh.receiveShadow = this.receiveShadow;
    mesh.castShadow = this.castShadow;
    mesh.frustumCulled = true;

    try {
      await precompileObject(mesh);
    } finally {
      geometry.dispose();
      if (ownsMaterial) material.dispose();
    }
  }

  getStats(): {
    totalNodes: number;
    visualChunks: number;
    pendingWorkers: number;
    settledQueue: number;
    syncQueue: number;
  } {
    return {
      totalNodes: this.quadTree.totalNodeCount,
      visualChunks: this.chunks.size,
      pendingWorkers: this.pendingNodeIds.size,
      settledQueue: this.settledResults.length,
      syncQueue: this.syncQueue.length,
    };
  }

  /**
   * Report whether every terrain leaf intersecting the stream's critical
   * camera radius has reached the scene. Far-world streaming may continue in
   * the background without allowing a visible arena hole or late GPU upload
   * to pass the capture readiness gate.
   */
  getStreamingReadiness(criticalRadius = 250): TerrainVisualReadiness {
    const safeRadius = Math.max(1, criticalRadius);
    const radiusSquared = safeRadius * safeRadius;
    const requiredNodes = this.quadTree.getFinalNodes().filter((node) => {
      const box = node.boundingBox;
      const nearestX = THREE.MathUtils.clamp(this.playerX, box.xMin, box.xMax);
      const nearestZ = THREE.MathUtils.clamp(this.playerZ, box.zMin, box.zMax);
      const dx = this.playerX - nearestX;
      const dz = this.playerZ - nearestZ;
      return dx * dx + dz * dz <= radiusSquared;
    });
    let readyChunks = 0;
    for (const node of requiredNodes) {
      if (
        node.visualChunkKey !== null &&
        this.chunks.has(node.visualChunkKey)
      ) {
        readyChunks++;
      }
    }
    const requiredChunks = requiredNodes.length;
    return {
      ready: requiredChunks > 0 && readyChunks === requiredChunks,
      criticalRadius: safeRadius,
      requiredChunks,
      readyChunks,
      pendingChunks: requiredChunks - readyChunks,
    };
  }

  updateBiomeData(
    biomeCenters: QuadChunkWorkerInput["biomeCenters"],
    biomes: QuadChunkWorkerInput["biomes"],
  ): void {
    this.workerBiomeCenters = biomeCenters;
    this.workerBiomes = biomes;
  }

  /**
   * Invalidate quad-tree chunks that overlap a world-space AABB.
   * Destroys affected chunks so they get regenerated on the next update
   * with current flat-zone / road data. Called when flat zones are
   * registered after initial terrain generation.
   */
  invalidateRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): void {
    for (const [key, chunk] of this.chunks) {
      const node = chunk.node;
      const half = node.size * 0.5;
      const nMinX = node.centerX - half;
      const nMaxX = node.centerX + half;
      const nMinZ = node.centerZ - half;
      const nMaxZ = node.centerZ + half;

      if (nMaxX < minX || nMinX > maxX || nMaxZ < minZ || nMinZ > maxZ) {
        continue;
      }

      this.removeMeshFromScene(chunk);
      this.chunks.delete(key);
      node.visualChunkKey = null;
      node.terrainNeedsUpdate = true;
    }
  }

  // =========================================================================
  // QuadTreeListener implementation
  // =========================================================================

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    if (this.pendingNodeIds.has(node.id)) return;

    if (this.useWorkers) {
      this.dispatchWorker(node);
    } else {
      if (!this.syncQueue.includes(node)) {
        this.syncQueue.push(node);
      }
    }
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    const key = node.visualChunkKey;
    if (key !== null) {
      const chunk = this.chunks.get(key);
      if (chunk) {
        this.removeMeshFromScene(chunk);
        this.chunks.delete(key);
      }
      node.visualChunkKey = null;
    }
    if (this.pendingNodeIds.has(node.id)) {
      this.cancelledNodeIds.add(node.id);
      this.pendingNodeIds.delete(node.id);
    }
    const sqIdx = this.syncQueue.indexOf(node);
    if (sqIdx !== -1) this.syncQueue.splice(sqIdx, 1);
    this.failedAttempts.delete(node.id);
  }

  // =========================================================================
  // Worker dispatch — fire-and-forget, results arrive in settledResults
  // =========================================================================

  private dispatchWorker(node: TerrainQuadNode): void {
    const input: QuadChunkWorkerInput = {
      type: "generateQuadChunk",
      centerX: node.centerX,
      centerZ: node.centerZ,
      size: node.size,
      resolution: node.resolution,
      config: this.workerConfig,
      seed: this.workerSeed,
      biomeCenters: this.workerBiomeCenters,
      biomes: this.workerBiomes,
    };

    this.pendingNodeIds.add(node.id);
    const nodeId = node.id;

    generateQuadChunkAsync(input).then(
      (result) => {
        this.settledResults.push({ nodeId, node, result, error: null });
        this.pendingNodeIds.delete(nodeId);
      },
      (error) => {
        this.settledResults.push({ nodeId, node, result: null, error });
        this.pendingNodeIds.delete(nodeId);
      },
    );
  }

  private processSettledResults(): void {
    if (this.settledResults.length === 0) return;

    // Sort by distance to player (nearest first) for minimal visible holes.
    const px = this.playerX;
    const pz = this.playerZ;
    this.settledResults.sort((a, b) => {
      const da = (a.node.centerX - px) ** 2 + (a.node.centerZ - pz) ** 2;
      const db = (b.node.centerX - px) ** 2 + (b.node.centerZ - pz) ** 2;
      return da - db;
    });

    // A backlog is expected when the worker pool settles. Never convert it
    // into one unbounded main-thread frame; startup readiness can wait for the
    // bounded queue to drain.
    const limit = this.maxAssembliesPerFrame;
    const batch = this.settledResults.splice(0, limit);

    for (const entry of batch) {
      if (this.cancelledNodeIds.has(entry.nodeId)) {
        this.cancelledNodeIds.delete(entry.nodeId);
        continue;
      }

      if (!entry.node.isFinal || entry.node.visualChunkKey !== null) continue;

      if (entry.error || !entry.result) {
        if (entry.error) {
          console.error("[TerrainVisualManager] Worker error:", entry.error);
        }
        this.generateChunkSync(entry.node);
        continue;
      }

      this.assembleAndAddChunk(entry.node, entry.result);
    }
  }

  private processSyncQueue(): void {
    if (this.syncQueue.length === 0) return;

    const px = this.playerX;
    const pz = this.playerZ;
    this.syncQueue.sort((a, b) => {
      const da = (a.centerX - px) ** 2 + (a.centerZ - pz) ** 2;
      const db = (b.centerX - px) ** 2 + (b.centerZ - pz) ** 2;
      return da - db;
    });

    const limit = this.maxSyncChunksPerFrame;

    let generated = 0;
    while (this.syncQueue.length > 0 && generated < limit) {
      const node = this.syncQueue.shift()!;
      if (!node.isFinal || node.visualChunkKey !== null) continue;
      this.generateChunkSync(node);
      generated++;
    }
  }

  // =========================================================================
  // Sync bootstrap — generate nearest chunks synchronously to avoid holes
  // during initial load while workers are still spinning up.
  // =========================================================================

  private static SYNC_BOOTSTRAP_MAX = 30;
  private static SYNC_BOOTSTRAP_RADIUS_SQ = 1200 * 1200;

  private syncBootstrapNearbyChunks(): void {
    this.syncBootstrapped = true;

    const leafNodes = this.quadTree
      .getFinalNodes()
      .filter((n) => n.isFinal && n.visualChunkKey === null);

    if (leafNodes.length === 0) return;

    const px = this.playerX;
    const pz = this.playerZ;
    leafNodes.sort((a, b) => {
      const da = (a.centerX - px) ** 2 + (a.centerZ - pz) ** 2;
      const db = (b.centerX - px) ** 2 + (b.centerZ - pz) ** 2;
      return da - db;
    });

    const radiusSq = TerrainVisualManager.SYNC_BOOTSTRAP_RADIUS_SQ;
    const maxCount = TerrainVisualManager.SYNC_BOOTSTRAP_MAX;
    let count = 0;

    for (const node of leafNodes) {
      if (count >= maxCount) break;
      const dx = node.centerX - px;
      const dz = node.centerZ - pz;
      if (dx * dx + dz * dz > radiusSq) break;

      if (this.pendingNodeIds.has(node.id)) {
        this.cancelledNodeIds.add(node.id);
      }

      if (!this.syncQueue.includes(node)) {
        this.syncQueue.push(node);
      }
      count++;
    }
  }

  // =========================================================================
  // Chunk assembly
  // =========================================================================

  private assembleAndAddChunk(
    node: TerrainQuadNode,
    workerData: QuadChunkWorkerOutput,
  ): void {
    const key = this.makeChunkKey(node);

    let result;
    try {
      if (
        workerData.terrainProfileIdentity !== this.terrainProfileIdentity ||
        this.provider.terrainProfileIdentity !== this.terrainProfileIdentity
      ) {
        throw new Error("Terrain visual result profile identity mismatch");
      }
      result = assembleQuadChunkGeometry(
        workerData,
        this.provider,
        this.quadTree.config.skirtDrop,
      );
    } catch (err) {
      console.error(`[TerrainVisualManager] Assembly failed for ${key}:`, err);
      this.handleGenerationFailure(node);
      return;
    }

    this.addMeshToScene(node, key, result);
  }

  private generateChunkSync(node: TerrainQuadNode): void {
    const key = this.makeChunkKey(node);

    let workerData: QuadChunkWorkerOutput;
    try {
      workerData = generateQuadChunkDataSync(
        node.centerX,
        node.centerZ,
        node.size,
        node.resolution,
        this.provider,
      );
    } catch (err) {
      console.error(
        `[TerrainVisualManager] Sync data generation failed for ${key}:`,
        err,
      );
      this.handleGenerationFailure(node);
      return;
    }

    this.assembleAndAddChunk(node, workerData);
  }

  private handleGenerationFailure(node: TerrainQuadNode): void {
    const attempts = (this.failedAttempts.get(node.id) ?? 0) + 1;
    if (attempts < TerrainVisualManager.MAX_GENERATION_RETRIES) {
      this.failedAttempts.set(node.id, attempts);
      node.terrainNeedsUpdate = true;
    } else {
      console.error(
        `[TerrainVisualManager] Giving up on node ${node.id} after ${attempts} attempts`,
      );
      this.failedAttempts.delete(node.id);
    }
  }

  private makeChunkKey(node: TerrainQuadNode): string {
    return `quad_${node.id}_d${node.depth}_${node.centerX.toFixed(0)}_${node.centerZ.toFixed(0)}`;
  }

  private static DEBUG_DEPTH_COLORS = [
    0xff0000, 0xff8800, 0xffff00, 0x00ccff, 0x00ff44,
  ];

  private addMeshToScene(
    node: TerrainQuadNode,
    key: string,
    result: { geometry: THREE.BufferGeometry; heightData: Float32Array },
  ): void {
    let meshMaterial: THREE.Material;
    if (this.debugWireframe) {
      const depthColor =
        TerrainVisualManager.DEBUG_DEPTH_COLORS[
          Math.min(
            node.depth,
            TerrainVisualManager.DEBUG_DEPTH_COLORS.length - 1,
          )
        ];
      meshMaterial = new THREE.MeshBasicMaterial({
        color: depthColor,
        wireframe: true,
      });
    } else {
      meshMaterial = this.material;
    }

    const mesh = new THREE.Mesh(result.geometry, meshMaterial);
    mesh.position.set(node.centerX, 0, node.centerZ);
    mesh.name = `QuadTerrain_${key}`;
    mesh.receiveShadow = this.receiveShadow;
    mesh.castShadow = this.castShadow;
    mesh.frustumCulled = true;

    mesh.userData = {
      type: "terrain",
      walkable: true,
      clickable: true,
      quadNodeId: node.id,
      depth: node.depth,
      size: node.size,
      resolution: node.resolution,
    };

    this.container.add(mesh);

    const chunk: TerrainVisualChunk = {
      key,
      node,
      mesh,
      heightData: result.heightData,
    };

    this.chunks.set(key, chunk);
    node.visualChunkKey = key;
    this.failedAttempts.delete(node.id);
    node.testReady();
  }

  private removeMeshFromScene(chunk: TerrainVisualChunk): void {
    if (chunk.mesh.parent) {
      this.container.remove(chunk.mesh);
    }
    chunk.mesh.geometry.dispose();
  }
}
