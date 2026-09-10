/**
 * TerrainQuadTree — Quad-tree LOD system for terrain visual chunks.
 *
 * Manages a hierarchical quad-tree of terrain chunks that split/unsplit
 * based on distance to the player. Near chunks are small and high-resolution,
 * far chunks are large and low-resolution.
 *
 * Inspired by infinite-world-master's Chunk/Chunks system, adapted for
 * Hyperia's terrain pipeline.
 *
 * This is a CLIENT-ONLY visual system. Server and gameplay logic still use
 * the flat 100m tile grid (TerrainTile). getHeightAt() is unaffected.
 */

/** Fixed authored areas that need gameplay-density geometry in distant streams. */
export interface TerrainDetailRegion {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly resolution: number;
}

export interface QuadTreeConfig {
  /** Smallest chunk size in meters (leaf nodes). Should match TILE_SIZE for grid alignment. */
  minSize: number;
  /** Maximum depth of quad-tree subdivision */
  maxDepth: number;
  /** Split when distance < size * splitRatio */
  splitRatio: number;
  /** Multiplier on splitRatio for unsplit threshold (prevents thrashing at boundary). Must be > 1. */
  unsplitMultiplier: number;
  /** Default vertex count per axis, before fixed fine-detail leaf overrides. */
  resolution: number;
  /** Optional fixed overrides for intersecting minimum-size leaves only. */
  fineDetailRegions?: readonly TerrainDetailRegion[];
  /** Skirt drop distance in meters to hide LOD seams */
  skirtDrop: number;
  /** Number of top-level root chunks to retain around the active root. */
  rootChunkRadius: number;
}

export const DEFAULT_QUAD_TREE_CONFIG: QuadTreeConfig = {
  minSize: 100,
  maxDepth: 4,
  splitRatio: 1.5,
  unsplitMultiplier: 1.2,
  resolution: 32,
  skirtDrop: 15,
  rootChunkRadius: 1,
};

export type QuadPosition = "ne" | "nw" | "sw" | "se";
type CardinalDirection = "n" | "e" | "s" | "w";

/**
 * A single node in the terrain quad-tree.
 * Each node represents a square region of terrain that may be subdivided.
 */
export class TerrainQuadNode {
  readonly id: number;
  readonly tree: TerrainQuadTree;
  readonly parent: TerrainQuadNode | null;
  readonly quadPosition: QuadPosition | null;
  readonly size: number;
  readonly halfSize: number;
  readonly quarterSize: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly depth: number;

  /** Normalized LOD precision: 0 at root → 1 at max depth */
  readonly precision: number;
  /** True when at maximum subdivision depth */
  readonly isMaxDepth: boolean;

  children = new Map<QuadPosition, TerrainQuadNode>();
  neighbours = new Map<CardinalDirection, TerrainQuadNode | null>();
  splitted = false;
  splitting = false;
  unsplitting = false;
  ready = false;
  needsCheck = true;

  /** True when this is a leaf node that should have terrain geometry */
  isFinal = false;
  terrainNeedsUpdate = true;

  /** Assigned by TerrainVisualManager when geometry is created */
  visualChunkKey: string | null = null;

  readonly boundingBox: {
    xMin: number;
    xMax: number;
    zMin: number;
    zMax: number;
  };

  constructor(
    tree: TerrainQuadTree,
    parent: TerrainQuadNode | null,
    quadPosition: QuadPosition | null,
    size: number,
    centerX: number,
    centerZ: number,
    depth: number,
    id: number,
  ) {
    this.id = id;
    this.tree = tree;
    this.parent = parent;
    this.quadPosition = quadPosition;
    this.size = size;
    this.halfSize = size * 0.5;
    this.quarterSize = this.halfSize * 0.5;
    this.centerX = centerX;
    this.centerZ = centerZ;
    this.depth = depth;
    this.precision = depth / tree.config.maxDepth;
    this.isMaxDepth = depth === tree.config.maxDepth;

    this.boundingBox = {
      xMin: centerX - this.halfSize,
      xMax: centerX + this.halfSize,
      zMin: centerZ - this.halfSize,
      zMax: centerZ + this.halfSize,
    };

    this.check();

    if (!this.splitted) {
      this.createFinal();
    }

    this.testReady();
  }

  /** Fixed per-leaf detail never changes merely because the camera moves. */
  get resolution(): number {
    let resolution = this.tree.config.resolution;
    if (this.isMaxDepth) {
      for (const region of this.tree.config.fineDetailRegions ?? []) {
        if (
          this.boundingBox.xMin < region.maxX &&
          this.boundingBox.xMax > region.minX &&
          this.boundingBox.zMin < region.maxZ &&
          this.boundingBox.zMax > region.minZ
        ) {
          resolution = Math.max(resolution, region.resolution);
        }
      }
    }
    return resolution;
  }

  check(): void {
    if (!this.needsCheck) return;
    this.needsCheck = false;

    const underSplit = this.tree.isUnderSplitDistance(
      this.size,
      this.centerX,
      this.centerZ,
    );

    if (underSplit) {
      if (!this.isMaxDepth && !this.splitted) {
        this.split();
      }
    } else if (this.splitted) {
      if (
        this.tree.isOverUnsplitDistance(this.size, this.centerX, this.centerZ)
      ) {
        this.unsplit();
      }
    }

    for (const child of this.children.values()) {
      child.check();
    }
  }

  update(): void {
    if (this.isFinal && this.terrainNeedsUpdate && this.neighbours.size === 4) {
      this.tree.requestTerrainGeneration(this);
      this.terrainNeedsUpdate = false;
    }

    for (const child of this.children.values()) {
      child.update();
    }
  }

  setNeighbours(
    n: TerrainQuadNode | null,
    e: TerrainQuadNode | null,
    s: TerrainQuadNode | null,
    w: TerrainQuadNode | null,
  ): void {
    this.neighbours.set("n", n);
    this.neighbours.set("e", e);
    this.neighbours.set("s", s);
    this.neighbours.set("w", w);
  }

  testReady(): void {
    if (this.splitted) {
      let readyCount = 0;
      for (const child of this.children.values()) {
        if (child.ready) readyCount++;
      }
      if (readyCount === 4) {
        this.setReady();
      }
    } else {
      if (this.visualChunkKey !== null) {
        this.setReady();
      }
    }
  }

  setReady(): void {
    if (this.ready) return;
    this.ready = true;

    if (this.splitting) {
      this.splitting = false;
      this.destroyFinal();
    }

    if (this.unsplitting) {
      this.unsplitting = false;
      for (const child of this.children.values()) {
        child.destroy();
      }
      this.children.clear();
    }

    if (this.parent) {
      this.parent.testReady();
    }
  }

  unsetReady(): void {
    if (!this.ready) return;
    this.ready = false;
  }

  split(): void {
    this.splitting = true;
    this.splitted = true;
    this.unsetReady();

    const qSize = this.halfSize;
    const q = this.quarterSize;
    const d = this.depth + 1;

    const ne = this.tree.createNode(
      this,
      "ne",
      qSize,
      this.centerX + q,
      this.centerZ - q,
      d,
    );
    this.children.set("ne", ne);

    const nw = this.tree.createNode(
      this,
      "nw",
      qSize,
      this.centerX - q,
      this.centerZ - q,
      d,
    );
    this.children.set("nw", nw);

    const sw = this.tree.createNode(
      this,
      "sw",
      qSize,
      this.centerX - q,
      this.centerZ + q,
      d,
    );
    this.children.set("sw", sw);

    const se = this.tree.createNode(
      this,
      "se",
      qSize,
      this.centerX + q,
      this.centerZ + q,
      d,
    );
    this.children.set("se", se);
  }

  unsplit(): void {
    if (!this.splitted) return;
    this.splitted = false;
    this.unsplitting = true;
    this.unsetReady();
    this.createFinal();
  }

  createFinal(): void {
    if (this.isFinal) return;
    this.isFinal = true;
    this.terrainNeedsUpdate = true;
  }

  destroyFinal(): void {
    if (!this.isFinal) return;
    this.isFinal = false;
    this.terrainNeedsUpdate = false;
    this.tree.requestTerrainDestruction(this);
  }

  destroy(): void {
    for (const child of this.children.values()) {
      child.destroy();
    }
    this.children.clear();
    this.splitted = false;
    this.splitting = false;
    this.unsplitting = false;

    this.destroyFinal();
    this.tree.removeNode(this);
  }

  isInside(x: number, z: number): boolean {
    return (
      x > this.boundingBox.xMin &&
      x < this.boundingBox.xMax &&
      z > this.boundingBox.zMin &&
      z < this.boundingBox.zMax
    );
  }

  getDeepestNodeAt(x: number, z: number): TerrainQuadNode | null {
    if (!this.splitted) return this;

    for (const child of this.children.values()) {
      if (child.isInside(x, z)) {
        return child.getDeepestNodeAt(x, z);
      }
    }

    return null;
  }
}

/**
 * Callback interface for the visual manager to receive quad-tree events.
 */
export interface QuadTreeListener {
  onNodeNeedsGeometry(node: TerrainQuadNode): void;
  onNodeDestroyGeometry(node: TerrainQuadNode): void;
}

/**
 * Forwards quad-tree events to multiple listeners (e.g. terrain + water).
 */
export class CompositeQuadTreeListener implements QuadTreeListener {
  private listeners: QuadTreeListener[] = [];

  add(listener: QuadTreeListener): void {
    this.listeners.push(listener);
  }

  onNodeNeedsGeometry(node: TerrainQuadNode): void {
    for (const l of this.listeners) l.onNodeNeedsGeometry(node);
  }

  onNodeDestroyGeometry(node: TerrainQuadNode): void {
    for (const l of this.listeners) l.onNodeDestroyGeometry(node);
  }
}

/**
 * Manages the top-level quad-tree: root chunk grid, split/unsplit,
 * neighbor resolution, and player tracking.
 */
export class TerrainQuadTree {
  readonly config: QuadTreeConfig;
  readonly maxSize: number;

  private mainChunks = new Map<string, TerrainQuadNode>();
  private allNodes = new Map<number, TerrainQuadNode>();
  private playerX = 0;
  private playerZ = 0;
  private lastGridX = NaN;
  private lastGridZ = NaN;
  private listener: QuadTreeListener | null = null;
  private nextNodeId = 0;
  /** Set true whenever the tree structure changes (split/unsplit). Cleared after neighbour resolution. */
  private structureDirty = false;

  constructor(config: Partial<QuadTreeConfig> = {}) {
    const resolvedConfig = { ...DEFAULT_QUAD_TREE_CONFIG, ...config };
    const regions = resolvedConfig.fineDetailRegions ?? [];
    if (regions.length > 8) throw new Error("Too many terrain detail regions");
    for (const region of regions) {
      if (
        ![region.minX, region.maxX, region.minZ, region.maxZ].every(
          Number.isFinite,
        ) ||
        region.minX >= region.maxX ||
        region.minZ >= region.maxZ ||
        !Number.isInteger(region.resolution) ||
        region.resolution < 2 ||
        region.resolution > 128
      )
        throw new Error("Invalid terrain detail region");
    }
    const requestedRootChunkRadius = Number.isFinite(
      resolvedConfig.rootChunkRadius,
    )
      ? resolvedConfig.rootChunkRadius
      : DEFAULT_QUAD_TREE_CONFIG.rootChunkRadius;
    this.config = {
      ...resolvedConfig,
      fineDetailRegions: Object.freeze(
        regions.map((region) => Object.freeze({ ...region })),
      ),
      rootChunkRadius: Math.max(0, Math.floor(requestedRootChunkRadius)),
    };
    this.maxSize = this.config.minSize * Math.pow(2, this.config.maxDepth);
  }

  setListener(listener: QuadTreeListener): void {
    this.listener = listener;
  }

  createNode(
    parent: TerrainQuadNode | null,
    quadPosition: QuadPosition | null,
    size: number,
    centerX: number,
    centerZ: number,
    depth: number,
  ): TerrainQuadNode {
    const id = this.nextNodeId++;
    const node = new TerrainQuadNode(
      this,
      parent,
      quadPosition,
      size,
      centerX,
      centerZ,
      depth,
      id,
    );
    this.allNodes.set(node.id, node);
    this.structureDirty = true;
    return node;
  }

  removeNode(node: TerrainQuadNode): void {
    this.allNodes.delete(node.id);
    this.structureDirty = true;
  }

  requestTerrainGeneration(node: TerrainQuadNode): void {
    this.listener?.onNodeNeedsGeometry(node);
  }

  requestTerrainDestruction(node: TerrainQuadNode): void {
    this.listener?.onNodeDestroyGeometry(node);
    if (node.visualChunkKey !== null) {
      node.visualChunkKey = null;
    }
    // DO NOT removeNode here — the node may still be alive as a structural
    // parent after splitting. Removing it from allNodes breaks neighbor
    // resolution for all descendants. Nodes are only removed from allNodes
    // when truly destroyed via destroy() → explicit removal.
  }

  isUnderSplitDistance(size: number, chunkX: number, chunkZ: number): boolean {
    const dx = this.playerX - chunkX;
    const dz = this.playerZ - chunkZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    return distance < size * this.config.splitRatio;
  }

  isOverUnsplitDistance(size: number, chunkX: number, chunkZ: number): boolean {
    const dx = this.playerX - chunkX;
    const dz = this.playerZ - chunkZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    return (
      distance > size * this.config.splitRatio * this.config.unsplitMultiplier
    );
  }

  /**
   * Main update — call every frame or when player moves significantly.
   * Returns true if the tree structure changed.
   */
  update(playerX: number, playerZ: number): boolean {
    this.playerX = playerX;
    this.playerZ = playerZ;

    // Use numeric grid coordinates instead of string comparison to avoid
    // per-frame string allocation / GC pressure.
    const gridX = Math.round((playerX / this.config.minSize) * 2 + 0.5);
    const gridZ = Math.round((playerZ / this.config.minSize) * 2 + 0.5);
    if (gridX === this.lastGridX && gridZ === this.lastGridZ) {
      if (this.structureDirty) {
        this.updateAllNeighbours();
        this.structureDirty = false;
      }
      for (const chunk of this.mainChunks.values()) {
        chunk.update();
      }
      return false;
    }
    this.lastGridX = gridX;
    this.lastGridZ = gridZ;

    // Mark all nodes for re-check
    for (const node of this.allNodes.values()) {
      node.needsCheck = true;
    }

    // Get main chunk coordinates (3x3 grid around player)
    const mainCoords = this.getMainChunkCoordinates();

    // Destroy main chunks no longer in proximity
    for (const [key, chunk] of this.mainChunks) {
      if (!mainCoords.find((c) => c.key === key)) {
        chunk.destroy();
        this.mainChunks.delete(key);
      }
    }

    // Create new main chunks
    for (const coord of mainCoords) {
      if (!this.mainChunks.has(coord.key)) {
        const chunk = this.createNode(
          null,
          null,
          this.maxSize,
          coord.worldX,
          coord.worldZ,
          0,
        );
        this.mainChunks.set(coord.key, chunk);
      }
    }

    // Check all main chunks (propagates to children)
    for (const chunk of this.mainChunks.values()) {
      chunk.check();
    }

    // Update neighbor relationships
    this.updateAllNeighbours();
    this.structureDirty = false;

    // Run update on all main chunks (triggers terrain generation requests)
    for (const chunk of this.mainChunks.values()) {
      chunk.update();
    }

    return true;
  }

  /** Destroy all chunks and reset state */
  dispose(): void {
    for (const chunk of this.mainChunks.values()) {
      chunk.destroy();
    }
    this.mainChunks.clear();
    this.allNodes.clear();
    this.lastGridX = NaN;
    this.lastGridZ = NaN;
  }

  /** Get all leaf nodes that currently have (or need) visual geometry */
  getFinalNodes(): TerrainQuadNode[] {
    const result: TerrainQuadNode[] = [];
    for (const node of this.allNodes.values()) {
      if (node.isFinal) result.push(node);
    }
    return result;
  }

  /** Get total node count (for debug stats) */
  get totalNodeCount(): number {
    return this.allNodes.size;
  }

  /** Get active visual chunk count (for debug stats) */
  get visualChunkCount(): number {
    let count = 0;
    for (const node of this.allNodes.values()) {
      if (node.visualChunkKey !== null) count++;
    }
    return count;
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  private getMainChunkCoordinates(): Array<{
    key: string;
    gridX: number;
    gridZ: number;
    worldX: number;
    worldZ: number;
  }> {
    const gx = Math.round(this.playerX / this.maxSize);
    const gz = Math.round(this.playerZ / this.maxSize);

    const coords: Array<{
      key: string;
      gridX: number;
      gridZ: number;
      worldX: number;
      worldZ: number;
    }> = [];

    const radius = this.config.rootChunkRadius;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const cx = gx + dx;
        const cz = gz + dz;
        coords.push({
          key: `${cx},${cz}`,
          gridX: cx,
          gridZ: cz,
          worldX: cx * this.maxSize,
          worldZ: cz * this.maxSize,
        });
      }
    }

    return coords;
  }

  private updateAllNeighbours(): void {
    // Main chunk neighbours from the configured root grid.
    for (const [key, chunk] of this.mainChunks) {
      const [xStr, zStr] = key.split(",");
      const x = parseFloat(xStr);
      const z = parseFloat(zStr);

      chunk.setNeighbours(
        this.mainChunks.get(`${x},${z - 1}`) ?? null,
        this.mainChunks.get(`${x + 1},${z}`) ?? null,
        this.mainChunks.get(`${x},${z + 1}`) ?? null,
        this.mainChunks.get(`${x - 1},${z}`) ?? null,
      );
    }

    // Child chunk neighbours (depth-sorted for correct propagation)
    const childNodes = [...this.allNodes.values()]
      .filter((n) => n.depth > 0)
      .sort((a, b) => a.depth - b.depth);

    for (const node of childNodes) {
      if (!node.parent) continue;

      let n: TerrainQuadNode | null = null;
      let e: TerrainQuadNode | null = null;
      let s: TerrainQuadNode | null = null;
      let w: TerrainQuadNode | null = null;

      const qp = node.quadPosition!;
      const parent = node.parent;

      // North
      if (qp === "sw") n = parent.children.get("nw") ?? null;
      else if (qp === "se") n = parent.children.get("ne") ?? null;
      else {
        const pn = parent.neighbours.get("n");
        if (pn) {
          if (pn.splitted)
            n = pn.children.get(qp === "nw" ? "sw" : "se") ?? null;
          else n = pn;
        }
      }

      // East
      if (qp === "nw") e = parent.children.get("ne") ?? null;
      else if (qp === "sw") e = parent.children.get("se") ?? null;
      else {
        const pe = parent.neighbours.get("e");
        if (pe) {
          if (pe.splitted)
            e = pe.children.get(qp === "ne" ? "nw" : "sw") ?? null;
          else e = pe;
        }
      }

      // South
      if (qp === "nw") s = parent.children.get("sw") ?? null;
      else if (qp === "ne") s = parent.children.get("se") ?? null;
      else {
        const ps = parent.neighbours.get("s");
        if (ps) {
          if (ps.splitted)
            s = ps.children.get(qp === "sw" ? "nw" : "ne") ?? null;
          else s = ps;
        }
      }

      // West
      if (qp === "ne") w = parent.children.get("nw") ?? null;
      else if (qp === "se") w = parent.children.get("sw") ?? null;
      else {
        const pw = parent.neighbours.get("w");
        if (pw) {
          if (pw.splitted)
            w = pw.children.get(qp === "nw" ? "ne" : "se") ?? null;
          else w = pw;
        }
      }

      node.setNeighbours(n, e, s, w);
    }
  }
}
