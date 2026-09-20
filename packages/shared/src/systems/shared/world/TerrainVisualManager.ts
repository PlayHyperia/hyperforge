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
  assembleQuadChunkGeometrySteps,
  generateQuadChunkDataSync,
  generateQuadChunkDataSteps,
  type ChunkGeometryResult,
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
import {
  RetainedTerrainSurface,
  type TerrainGridBounds,
} from "./TerrainGridSurface";

export type VisualManagerTerrainProvider = FullTerrainProvider & {
  /** All mutable canonical, road and biome inputs, bound to these worker inputs. */
  capturePreparationLease(
    biomeCenters: QuadChunkWorkerInput["biomeCenters"],
    biomes: QuadChunkWorkerInput["biomes"],
  ): Readonly<{ isCurrent(): boolean }>;
};

export interface TerrainVisualChunk {
  key: string;
  node: TerrainQuadNode;
  mesh: THREE.Mesh;
  heightData: Float32Array;
  surface: RetainedTerrainSurface;
}

export interface TerrainVisualReadiness {
  ready: boolean;
  criticalRadius: number;
  requiredChunks: number;
  readyChunks: number;
  pendingChunks: number;
}

/** Borrowed rendered geometry only: neither complete coverage nor a lease on
 * roads, exclusions or water. Consumers must retain those owners separately. */
export interface RetainedTerrainRegion {
  readonly bounds: Readonly<TerrainGridBounds>;
  readonly surfaces: readonly RetainedTerrainSurface[];
  /** Includes newly arriving neighbors, not just the surfaces present at capture.
   * Once observed stale, this lease never becomes valid again. */
  isCurrent(): boolean;
}

interface ChunkPreparationRequest {
  /** Object identity is the generation token; node IDs can outlive a request. */
  node: TerrainQuadNode;
  input: Pick<
    QuadChunkWorkerInput,
    "centerX" | "centerZ" | "size" | "resolution"
  >;
  skirtDrop: number;
  lease: Readonly<{ isCurrent(): boolean }>;
  revision: number;
  reservedBytes: number;
  state: "worker" | "ready" | "preparing" | "cancelled";
  result: QuadChunkWorkerOutput | null;
}

type PreparedChunk = ChunkGeometryResult & { surface: RetainedTerrainSurface };

interface ActiveChunkPreparation {
  request: ChunkPreparationRequest;
  steps: Generator<string, PreparedChunk, void>;
  phase: string;
  completed?: PreparedChunk;
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
  private releasedGeometry = new WeakSet<THREE.BufferGeometry>();
  private removedMeshes = new WeakSet<THREE.Mesh>();
  private disposed = false;
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

  /** Wanted node references own no buffers/leases; bounded by the live tree. */
  private wantedNodes = new Set<TerrainQuadNode>();
  private requests = new Map<TerrainQuadNode, ChunkPreparationRequest>();
  /** Cancelled promises retain their reservation until they actually settle. */
  private workerFlights = new Set<ChunkPreparationRequest>();
  private forceSyncNodes = new Set<TerrainQuadNode>();
  private activePreparation: ActiveChunkPreparation | null = null;
  private inputRevision = 0;
  private reservedRawBytes = 0;
  private peakReservedRawBytes = 0;
  private lastPreparationMs = 0;
  private maxPreparationMs = 0;
  private maxPreparationStepMs = 0;
  private maxPreparationStepPhase = "";
  private preparationSlices = 0;
  private cancelledPreparations = 0;
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
  /** CPU scheduling targets, not native frame-time acceptance. Native typed
   * allocations/bounding volumes and GC may overrun a slice; record overruns. */
  private static PREPARATION_BUDGET_MS = 2;
  private static MAX_WORKER_FLIGHTS = 4;
  private static MAX_PREPARATION_REQUESTS = 16;
  private static MAX_RAW_BYTES = 16 * 1024 * 1024;

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
      config.resolution !== undefined &&
      (!Number.isInteger(config.resolution) ||
        config.resolution < 2 ||
        config.resolution > 256)
    ) {
      throw new Error(
        "Terrain visual resolution must be an integer from 2 to 256",
      );
    }
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
    this.workerConfig = structuredClone(workerConfig);
    this.workerSeed = workerSeed;
    this.workerBiomeCenters = structuredClone(workerBiomeCenters);
    this.workerBiomes = structuredClone(workerBiomes);
    this.useWorkers = isQuadChunkWorkerAvailable();

    this.quadTree = new TerrainQuadTree(config);
    this.quadTree.setListener(this);
  }

  update(playerX: number, playerZ: number): void {
    if (this.disposed) return;
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
      this.workerFlights.size > 0
    ) {
      this.syncBootstrapNearbyChunks();
    }

    this.processPreparation();
    this.framesSinceInit++;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quadTree.dispose();
    for (const chunk of this.chunks.values()) {
      this.removeMeshFromScene(chunk);
    }
    this.chunks.clear();
    for (const request of this.requests.values()) this.cancelRequest(request);
    this.wantedNodes.clear();
    this.forceSyncNodes.clear();
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

  /** Installed ownership, including a still-drawn transitioning ancestor.
   * Unlike grass contact leases, water may retain that ancestor until a whole
   * replacement partition is ready. This never changes terrain readiness.
   */
  hasInstalledChunk(node: TerrainQuadNode): boolean {
    if (this.disposed || node.visualChunkKey === null) return false;
    const chunk = this.chunks.get(node.visualChunkKey);
    return Boolean(
      chunk?.node === node &&
      chunk.mesh.parent === this.container &&
      chunk.mesh.visible,
    );
  }

  getRetainedSurface(node: TerrainQuadNode): RetainedTerrainSurface | null {
    // A transitioning parent keeps isFinal until its children are ready. It
    // cannot certify contact while new child meshes may overlap it on screen.
    if (
      !node.isFinal ||
      node.splitting ||
      node.unsplitting ||
      node.visualChunkKey === null
    )
      return null;
    const chunk = this.chunks.get(node.visualChunkKey);
    if (!chunk || chunk.node !== node || chunk.mesh.parent !== this.container)
      return null;
    if (!chunk.surface.matchesGeometry(chunk.mesh.geometry)) return null;
    // A split keeps its old parent mesh until all children are ready. Do not
    // place grass against one surface while an overlapping ancestor is drawn.
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.visualChunkKey && this.chunks.has(parent.visualChunkKey))
        return null;
    }
    return chunk.surface;
  }

  /** Exact installed surface only; no parent/child overlap or stale geometry. */
  getRetainedSurfaceAt(x: number, z: number): RetainedTerrainSurface | null {
    for (const chunk of this.chunks.values()) {
      const node = chunk.node,
        half = node.size / 2;
      if (
        x < node.centerX - half ||
        x >= node.centerX + half ||
        z < node.centerZ - half ||
        z >= node.centerZ + half
      )
        continue;
      const surface = this.getRetainedSurface(node);
      if (surface) return surface;
    }
    return null;
  }

  /** Capture every admitted final surface intersecting the closed world-space
   * envelope. Never infer neighbors from a handful of height samples: their
   * sizes can differ during streaming. A missing region is an empty lease, not
   * ready grass. Exceeding capacity fails explicitly; no partial set is returned.
   * Revalidation reads the actual installed owners without allocating arrays or
   * serializing terrain. Cost is O(installed chunks × bounded region surfaces). */
  captureRetainedSurfaceRegion(
    bounds: TerrainGridBounds,
    maxSurfaces = 16,
  ): RetainedTerrainRegion {
    if (this.disposed) throw new Error("Terrain visual manager is disposed");
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ ||
      !Number.isSafeInteger(maxSurfaces) ||
      maxSurfaces < 1 ||
      maxSurfaces > 256
    )
      throw new Error("Invalid retained terrain region");
    const region = Object.freeze({ ...bounds });
    const intersects = (node: TerrainQuadNode) => {
      const half = node.size / 2;
      return (
        node.centerX + half >= region.minX &&
        node.centerX - half <= region.maxX &&
        node.centerZ + half >= region.minZ &&
        node.centerZ - half <= region.maxZ
      );
    };
    const captured: RetainedTerrainSurface[] = [];
    for (const chunk of this.chunks.values()) {
      if (!intersects(chunk.node)) continue;
      const surface = this.getRetainedSurface(chunk.node);
      if (!surface) continue;
      if (captured.length === maxSurfaces)
        throw new Error("Retained terrain region exceeds surface capacity");
      captured.push(surface);
    }
    const surfaces = Object.freeze(captured);
    let current = true;
    return Object.freeze({
      bounds: region,
      surfaces,
      isCurrent: () => {
        if (!current || this.disposed) return (current = false);
        let matches = 0;
        for (const chunk of this.chunks.values()) {
          if (!intersects(chunk.node)) continue;
          const surface = this.getRetainedSurface(chunk.node);
          if (!surface) continue;
          if (!surfaces.includes(surface)) return (current = false);
          matches++;
        }
        return (current = matches === surfaces.length);
      },
    });
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
    const config = { ...this.quadTree.config };
    // The focus may lie between grid centers, but this sample still covers a
    // minimum-size rectangle. Match TerrainQuadNode's strict area-overlap/max
    // detail rule; base streaming density cannot represent an admitted pond.
    const halfSize = config.minSize / 2;
    let resolution = config.resolution;
    for (const region of config.fineDetailRegions ?? []) {
      if (
        centerX - halfSize < region.maxX &&
        centerX + halfSize > region.minX &&
        centerZ - halfSize < region.maxZ &&
        centerZ + halfSize > region.minZ
      ) {
        resolution = Math.max(resolution, region.resolution);
      }
    }
    const revision = this.inputRevision;
    const lease = this.provider.capturePreparationLease(
      this.workerBiomeCenters,
      this.workerBiomes,
    );
    const current = () =>
      !this.disposed &&
      revision === this.inputRevision &&
      config.minSize === this.quadTree.config.minSize &&
      config.resolution === this.quadTree.config.resolution &&
      config.fineDetailRegions === this.quadTree.config.fineDetailRegions &&
      config.skirtDrop === this.quadTree.config.skirtDrop &&
      lease.isCurrent();
    // start() awaits this before update() is enabled. Drain cooperatively here,
    // not through the frame queue (which would deadlock initialization).
    const provider = this.provider;
    function* sampleSteps(): Generator<string, ChunkGeometryResult, void> {
      const raw = yield* generateQuadChunkDataSteps(
        centerX,
        centerZ,
        config.minSize,
        resolution,
        provider,
      );
      return yield* assembleQuadChunkGeometrySteps(
        raw,
        provider,
        config.skirtDrop,
      );
    }
    const steps = sampleSteps();
    let sample: ChunkGeometryResult | undefined;
    try {
      while (!sample) {
        const start = performance.now();
        if (!current())
          throw new Error(
            "Terrain precompile inputs changed or owner disposed",
          );
        do {
          const step = steps.next();
          if (step.done) {
            sample = step.value;
            break;
          }
        } while (
          performance.now() - start <
          TerrainVisualManager.PREPARATION_BUDGET_MS
        );
        if (!current())
          throw new Error(
            "Terrain precompile inputs changed or owner disposed",
          );
        if (!sample)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      if (sample) this.releaseGeometry(sample.geometry);
      throw error;
    } finally {
      steps.return(undefined as never);
    }
    const { geometry } = sample;

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
      if (!current())
        throw new Error("Terrain precompile inputs changed or owner disposed");
      await precompileObject(mesh);
      if (!current())
        throw new Error("Terrain precompile inputs changed or owner disposed");
    } finally {
      this.releaseGeometry(geometry);
      if (ownsMaterial) material.dispose();
    }
  }

  getStats(): {
    totalNodes: number;
    visualChunks: number;
    pendingWorkers: number;
    settledQueue: number;
    syncQueue: number;
    preparationActive: boolean;
    reservedRawBytes: number;
    peakReservedRawBytes: number;
    preparationRequests: number;
    preparationSlices: number;
    lastPreparationMs: number;
    maxPreparationMs: number;
    maxPreparationStepMs: number;
    maxPreparationStepPhase: string;
    cancelledPreparations: number;
  } {
    return {
      totalNodes: this.quadTree.totalNodeCount,
      visualChunks: this.chunks.size,
      pendingWorkers: this.workerFlights.size,
      settledQueue: [...this.requests.values()].filter(
        (request) => request.state === "ready",
      ).length,
      syncQueue: this.wantedNodes.size,
      preparationActive: this.activePreparation !== null,
      reservedRawBytes: this.reservedRawBytes,
      peakReservedRawBytes: this.peakReservedRawBytes,
      preparationRequests: this.requests.size,
      preparationSlices: this.preparationSlices,
      lastPreparationMs: this.lastPreparationMs,
      maxPreparationMs: this.maxPreparationMs,
      maxPreparationStepMs: this.maxPreparationStepMs,
      maxPreparationStepPhase: this.maxPreparationStepPhase,
      cancelledPreparations: this.cancelledPreparations,
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
      if (this.hasInstalledChunk(node)) {
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
    this.workerBiomeCenters = structuredClone(biomeCenters);
    this.workerBiomes = structuredClone(biomes);
    this.inputRevision++;
    this.invalidateRegion(-Infinity, -Infinity, Infinity, Infinity);
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
    for (const request of this.requests.values()) {
      const node = request.node,
        half = node.size / 2;
      if (
        node.centerX + half < minX ||
        node.centerX - half > maxX ||
        node.centerZ + half < minZ ||
        node.centerZ - half > maxZ
      )
        continue;
      this.cancelRequest(request, true);
    }
    for (const chunk of this.chunks.values()) {
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
      node.terrainNeedsUpdate = true;
    }
  }

  // =========================================================================
  // QuadTreeListener implementation
  // =========================================================================

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    if (
      !this.disposed &&
      !this.requests.has(node) &&
      node.visualChunkKey === null
    )
      this.wantedNodes.add(node);
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    const key = node.visualChunkKey;
    if (key !== null) {
      const chunk = this.chunks.get(key);
      if (chunk) {
        this.removeMeshFromScene(chunk);
      } else node.visualChunkKey = null;
    }
    const request = this.requests.get(node);
    if (request) this.cancelRequest(request);
    this.wantedNodes.delete(node);
    this.forceSyncNodes.delete(node);
    this.failedAttempts.delete(node.id);
  }

  // =========================================================================
  // Bounded requests, resumable private drafts, atomic scene admission.
  // =========================================================================

  private dispatchWorker(request: ChunkPreparationRequest): void {
    const node = request.node;
    const input: QuadChunkWorkerInput = {
      type: "generateQuadChunk",
      ...request.input,
      config: this.workerConfig,
      seed: this.workerSeed,
      biomeCenters: this.workerBiomeCenters,
      biomes: this.workerBiomes,
    };

    this.workerFlights.add(request);
    generateQuadChunkAsync(input).then(
      (result) => this.acceptWorkerResult(request, result),
      (error) => {
        if (this.requests.get(node) === request && !this.disposed)
          console.error(
            "[TerrainVisualManager] Worker error; queued cooperative fallback:",
            error,
          );
        this.acceptWorkerResult(request, null);
      },
    );
  }

  private acceptWorkerResult(
    request: ChunkPreparationRequest,
    result: QuadChunkWorkerOutput | null,
  ): void {
    this.workerFlights.delete(request);
    // No provider work here: settlement only transfers ownership to the queue.
    // In particular an old callback cannot delete a newer request for this node.
    if (
      this.disposed ||
      this.requests.get(request.node) !== request ||
      request.state === "cancelled"
    ) {
      this.releaseReservation(request);
      return;
    }
    request.result = result;
    request.state = "ready";
  }

  private releaseReservation(request: ChunkPreparationRequest): void {
    this.reservedRawBytes -= request.reservedBytes;
    request.reservedBytes = 0;
    request.result = null;
  }

  private cancelRequest(request: ChunkPreparationRequest, retry = false): void {
    if (request.state === "cancelled") return;
    request.state = "cancelled";
    this.cancelledPreparations++;
    if (this.activePreparation?.request === request) {
      if (this.activePreparation.completed)
        this.releaseGeometry(this.activePreparation.completed.geometry);
      this.activePreparation.steps.return(undefined as never);
      this.activePreparation = null;
    }
    if (this.requests.get(request.node) === request)
      this.requests.delete(request.node);
    if (!this.workerFlights.has(request)) this.releaseReservation(request);
    if (
      retry &&
      !this.disposed &&
      request.node.isFinal &&
      request.node.visualChunkKey === null
    ) {
      this.wantedNodes.add(request.node);
      request.node.terrainNeedsUpdate = true;
    }
  }

  private isRequestCurrent(
    request: ChunkPreparationRequest,
    unpublished = true,
  ): boolean {
    return (
      !this.disposed &&
      this.requests.get(request.node) === request &&
      request.state !== "cancelled" &&
      request.node.isFinal &&
      (!unpublished || request.node.visualChunkKey === null) &&
      request.node.tree === this.quadTree &&
      request.node.centerX === request.input.centerX &&
      request.node.centerZ === request.input.centerZ &&
      request.node.size === request.input.size &&
      request.node.resolution === request.input.resolution &&
      this.quadTree.config.skirtDrop === request.skirtDrop &&
      request.revision === this.inputRevision &&
      this.provider.terrainProfileIdentity === this.terrainProfileIdentity &&
      request.lease.isCurrent()
    );
  }

  private distanceSquared(node: TerrainQuadNode): number {
    return (
      (node.centerX - this.playerX) ** 2 + (node.centerZ - this.playerZ) ** 2
    );
  }

  private nextWantedNode(): TerrainQuadNode | null {
    let nearest: TerrainQuadNode | null = null,
      distance = Infinity;
    for (const node of this.wantedNodes) {
      if (
        !node.isFinal ||
        node.visualChunkKey !== null ||
        this.requests.has(node)
      ) {
        this.wantedNodes.delete(node);
        this.forceSyncNodes.delete(node);
        continue;
      }
      const needsWorker = this.useWorkers && !this.forceSyncNodes.has(node);
      if (
        needsWorker &&
        this.workerFlights.size >= TerrainVisualManager.MAX_WORKER_FLIGHTS
      )
        continue;
      const nextDistance = this.distanceSquared(node);
      if (nextDistance < distance) {
        nearest = node;
        distance = nextDistance;
      }
    }
    return nearest;
  }

  private admitRequest(node: TerrainQuadNode): ChunkPreparationRequest | null {
    // Raw channels = ten float32 + one uint8 per vertex; reserve the worker's
    // overflow height grid too. Geometry has a separate single-draft bound.
    const reservedBytes =
      41 * node.resolution ** 2 + 4 * (node.resolution + 2) ** 2;
    const cancelledFlights = [...this.workerFlights].filter(
      (request) => request.state === "cancelled",
    ).length;
    if (
      this.requests.size + cancelledFlights >=
        TerrainVisualManager.MAX_PREPARATION_REQUESTS ||
      this.reservedRawBytes + reservedBytes > TerrainVisualManager.MAX_RAW_BYTES
    )
      return null;
    const lease = this.provider.capturePreparationLease(
      this.workerBiomeCenters,
      this.workerBiomes,
    );
    if (!lease.isCurrent()) return null;
    const useWorker = this.useWorkers && !this.forceSyncNodes.has(node);
    const request: ChunkPreparationRequest = {
      node,
      input: {
        centerX: node.centerX,
        centerZ: node.centerZ,
        size: node.size,
        resolution: node.resolution,
      },
      skirtDrop: this.quadTree.config.skirtDrop,
      lease,
      revision: this.inputRevision,
      reservedBytes,
      state: useWorker ? "worker" : "ready",
      result: null,
    };
    this.wantedNodes.delete(node);
    this.forceSyncNodes.delete(node);
    this.requests.set(node, request);
    this.reservedRawBytes += reservedBytes;
    this.peakReservedRawBytes = Math.max(
      this.peakReservedRawBytes,
      this.reservedRawBytes,
    );
    if (useWorker) this.dispatchWorker(request);
    return request;
  }

  private assertResult(
    request: ChunkPreparationRequest,
    raw: QuadChunkWorkerOutput,
  ): void {
    const node = request.input,
      count = node.resolution ** 2;
    if (
      raw.type !== "quadChunkResult" ||
      raw.terrainProfileIdentity !== this.terrainProfileIdentity ||
      raw.centerX !== node.centerX ||
      raw.centerZ !== node.centerZ ||
      raw.size !== node.size ||
      raw.resolution !== node.resolution
    )
      throw new Error(
        "Terrain visual result profile or chunk identity mismatch",
      );
    const channels: Array<[Float32Array | Uint8Array, number]> = [
      [raw.heightData, count],
      [raw.normalData, count * 3],
      [raw.colorData, count * 3],
      [raw.biomeForestWeight, count],
      [raw.biomeCanyonWeight, count],
      [raw.riverProximity, count],
    ];
    for (const [channel, length] of channels)
      if (!(channel instanceof Float32Array) || channel.length !== length)
        throw new Error("Terrain worker channel dimensions mismatch");
    if (
      !(raw.biomeData instanceof Uint8Array) ||
      raw.biomeData.length !== count
    )
      throw new Error("Terrain worker biome dimensions mismatch");
    channels.push([raw.biomeData, count]);
    const buffers = new Set(channels.map(([channel]) => channel.buffer));
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    if (bytes > request.reservedBytes)
      throw new Error("Terrain worker exceeded raw memory reservation");
  }

  private *prepareChunk(
    request: ChunkPreparationRequest,
  ): Generator<string, PreparedChunk, void> {
    const node = request.node;
    let result: ChunkGeometryResult | undefined;
    let transferred = false;
    try {
      const raw =
        request.result ??
        (yield* generateQuadChunkDataSteps(
          request.input.centerX,
          request.input.centerZ,
          request.input.size,
          request.input.resolution,
          this.provider,
        ));
      this.assertResult(request, raw);
      result = yield* assembleQuadChunkGeometrySteps(
        raw,
        this.provider,
        request.skirtDrop,
      );
      const surface = yield* RetainedTerrainSurface.prepare(
        node.id,
        this.terrainProfileIdentity,
        node.centerX,
        node.centerZ,
        node.size,
        node.resolution,
        result.geometry,
      );
      transferred = true;
      return { ...result, surface };
    } finally {
      if (!transferred && result) this.releaseGeometry(result.geometry);
    }
  }

  private processPreparation(): void {
    const start = performance.now();
    const deadline = start + TerrainVisualManager.PREPARATION_BUDGET_MS;
    let assembled = 0,
      synced = 0;
    try {
      while (!this.disposed && performance.now() < deadline) {
        if (!this.activePreparation) {
          let ready: ChunkPreparationRequest | undefined;
          for (const request of this.requests.values()) {
            if (request.state !== "ready") continue;
            if (
              !ready ||
              this.distanceSquared(request.node) <
                this.distanceSquared(ready.node)
            )
              ready = request;
          }
          if (ready) {
            if (
              ready.result
                ? assembled >= this.maxAssembliesPerFrame
                : synced >= this.maxSyncChunksPerFrame
            )
              break;
            if (!this.isRequestCurrent(ready)) {
              this.cancelRequest(ready, true);
              continue;
            }
            ready.state = "preparing";
            this.activePreparation = {
              request: ready,
              steps: this.prepareChunk(ready),
              phase: "prepare_start",
            };
          } else {
            const node = this.nextWantedNode();
            if (!node || !this.admitRequest(node)) break;
            continue;
          }
        }
        const active = this.activePreparation;
        if (!this.isRequestCurrent(active.request)) {
          this.cancelRequest(active.request, true);
          continue;
        }
        try {
          // No asynchronous boundary inside this slice. Full input leases are
          // checked before/after it and immediately before publication.
          do {
            const stepStart = performance.now();
            const step = active.steps.next();
            const elapsed = performance.now() - stepStart;
            const phase = step.done ? "prepare_complete" : step.value;
            if (elapsed > this.maxPreparationStepMs) {
              this.maxPreparationStepMs = elapsed;
              this.maxPreparationStepPhase = `${active.phase} -> ${phase}`;
            }
            active.phase = phase;
            if (step.done) {
              active.completed = step.value;
              if (!this.isRequestCurrent(active.request)) {
                this.cancelRequest(active.request, true);
                break;
              }
              try {
                this.addMeshToScene(
                  active.request.node,
                  this.makeChunkKey(active.request.node),
                  step.value,
                  step.value.surface,
                  () => this.isRequestCurrent(active.request),
                );
              } catch (error) {
                this.releaseGeometry(step.value.geometry);
                throw error;
              }
              active.completed = undefined;
              if (!this.isRequestCurrent(active.request, false)) {
                const chunk = this.chunks.get(
                  this.makeChunkKey(active.request.node),
                );
                if (chunk?.mesh.geometry === step.value.geometry)
                  this.removeMeshFromScene(chunk);
                this.cancelRequest(active.request, true);
                break;
              }
              if (active.request.result) assembled++;
              else synced++;
              if (this.requests.get(active.request.node) === active.request)
                this.requests.delete(active.request.node);
              this.releaseReservation(active.request);
              this.activePreparation = null;
              break;
            }
          } while (performance.now() < deadline);
          if (
            this.activePreparation === active &&
            !this.isRequestCurrent(active.request)
          )
            this.cancelRequest(active.request, true);
        } catch (error) {
          if (
            active.request.state === "cancelled" ||
            !this.isRequestCurrent(active.request)
          ) {
            this.cancelRequest(active.request, true);
            continue;
          }
          console.error(
            `[TerrainVisualManager] Preparation failed for ${this.makeChunkKey(active.request.node)}:`,
            error,
          );
          this.cancelRequest(active.request);
          this.handleGenerationFailure(active.request.node);
        }
      }
    } finally {
      this.lastPreparationMs = performance.now() - start;
      this.maxPreparationMs = Math.max(
        this.maxPreparationMs,
        this.lastPreparationMs,
      );
      this.preparationSlices++;
    }
  }

  // Slow/unavailable workers use the same bounded generator, never a whole
  // synchronous chunk. Cancelled flights still count toward the memory cap.

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

      const request = this.requests.get(node);
      if (request?.state === "worker") this.cancelRequest(request, true);
      if (!this.requests.has(node)) {
        this.forceSyncNodes.add(node);
        this.wantedNodes.add(node);
      }
      count++;
    }
  }

  // =========================================================================
  // Explicit synchronous CPU consumers share the same generator arithmetic.
  // No update, worker completion, fallback or bootstrap calls these helpers.
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
      this.addMeshToScene(node, key, result);
    } catch (err) {
      if (result) this.releaseGeometry(result.geometry);
      console.error(`[TerrainVisualManager] Assembly failed for ${key}:`, err);
      this.handleGenerationFailure(node);
      return;
    }
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
    if (this.disposed || !node.isFinal) return;
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
    preparedSurface?: RetainedTerrainSurface,
    isCurrent: () => boolean = () => !this.disposed,
  ): void {
    // Validate before allocating a material/mesh or publishing it to the scene.
    // The assembly caller owns and disposes the geometry if admission fails.
    const surface =
      preparedSurface ??
      new RetainedTerrainSurface(
        node.id,
        this.terrainProfileIdentity,
        node.centerX,
        node.centerZ,
        node.size,
        node.resolution,
        result.geometry,
      );
    if (!surface.matchesGeometry(result.geometry))
      throw new Error("Terrain surface changed before publication");
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
    // Chunk-local placement is immutable; parent/world transforms stay live.
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
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

    const chunk: TerrainVisualChunk = {
      key,
      node,
      mesh,
      heightData: result.heightData,
      surface,
    };

    try {
      if (!isCurrent()) throw new Error("Terrain publication owner changed");
      // Three dispatches synchronous added/childadded events. They may dispose,
      // invalidate, reparent or throw before publication: recheck and roll back.
      this.container.add(mesh);
      if (!isCurrent() || mesh.parent !== this.container)
        throw new Error(
          "Terrain publication owner changed during scene attachment",
        );
      this.chunks.set(key, chunk);
      node.visualChunkKey = key;
      this.failedAttempts.delete(node.id);
      node.testReady();
    } catch (error) {
      if (this.chunks.get(key) === chunk) this.chunks.delete(key);
      if (node.visualChunkKey === key) node.visualChunkKey = null;
      try {
        mesh.removeFromParent();
      } finally {
        if (this.debugWireframe) meshMaterial.dispose();
      }
      // The caller still owns geometry until this method returns successfully.
      throw error;
    }
  }

  private removeMeshFromScene(chunk: TerrainVisualChunk): void {
    if (this.removedMeshes.has(chunk.mesh)) return;
    this.removedMeshes.add(chunk.mesh);
    // Retire ownership before Three's synchronous removal callbacks. They can
    // re-enter dispose/invalidation; an old removal must not delete a new owner.
    if (this.chunks.get(chunk.key) === chunk) this.chunks.delete(chunk.key);
    if (chunk.node.visualChunkKey === chunk.key)
      chunk.node.visualChunkKey = null;
    try {
      chunk.mesh.removeFromParent();
    } catch (error) {
      console.error(
        "[TerrainVisualManager] Scene removal listener failed:",
        error,
      );
    } finally {
      this.releaseGeometry(chunk.mesh.geometry);
      if (this.debugWireframe) {
        const materials = Array.isArray(chunk.mesh.material)
          ? chunk.mesh.material
          : [chunk.mesh.material];
        for (const material of materials) {
          try {
            material.dispose();
          } catch (error) {
            console.error(
              "[TerrainVisualManager] Material disposal listener failed:",
              error,
            );
          }
        }
      }
    }
  }

  private releaseGeometry(geometry: THREE.BufferGeometry): void {
    if (this.releasedGeometry.has(geometry)) return;
    this.releasedGeometry.add(geometry);
    try {
      geometry.dispose();
    } catch (error) {
      console.error(
        "[TerrainVisualManager] Geometry disposal listener failed:",
        error,
      );
    }
  }
}
