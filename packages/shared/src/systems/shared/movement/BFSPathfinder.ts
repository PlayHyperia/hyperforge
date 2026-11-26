/**
 * BFS Pathfinder — classic MMORPG "Smartpathing"
 *
 * classic MMORPG player movement uses BFS ("smartpathing") as the primary algorithm.
 * Naive/dumb diagonal pathing is ONLY used by NPC chase movement (see ChasePathfinding.ts).
 *
 * Key features:
 * - BFS with classic MMORPG neighbor order (W,E,S,N,SW,SE,NW,NE)
 * - findPathToAny(): Multi-destination BFS for combat — terminates at the first
 *   valid combat tile reached, naturally finding the shortest path.
 * - findNaivePath(): Exposed for NPC chase systems only, never called from findPath().
 *
 * **BFS Iteration Limit:**
 *
 * To prevent main thread blocking on complex maps, BFS is limited to
 * MAX_BFS_ITERATIONS (2000) iterations. If the limit is reached:
 * 1. A partial path to the closest explored tile is returned
 * 2. `wasLastPathPartial()` returns true
 * 3. A warning is logged (throttled to avoid spam)
 *
 * Callers can check `wasLastPathPartial()` after `findPath()` to determine
 * if the returned path reaches the actual destination or just a partial point.
 * This can be used to show a visual indicator to the player.
 *
 * **Search Radius:**
 *
 * BFS is limited to PATHFIND_RADIUS (128 tiles) from the start position.
 * Destinations outside this radius will result in partial paths.
 *
 */

import {
  TileCoord,
  TILE_DIRECTIONS,
  PATHFIND_RADIUS,
  MAX_PATH_LENGTH as _MAX_PATH_LENGTH,
  tileKeyNumeric,
  tilesEqual,
  isDiagonal,
} from "./TileSystem";
import { bfsPool } from "./ObjectPools";

/**
 * Walkability check function type
 * Takes a tile and optional "from" tile for directional blocking
 */
export type WalkabilityChecker = (
  tile: TileCoord,
  fromTile?: TileCoord,
) => boolean;

type GuidedPathNode = {
  tile: TileCoord;
  cost: number;
  heuristic: number;
  order: number;
};

export type GuidedPathSearchResult = {
  status: "pending" | "found" | "exhausted";
  /** A copied, at-most-200-tile segment, as with the one-shot path APIs. */
  path: TileCoord[];
};

type GuidedSearchState = {
  start: Readonly<TileCoord>;
  destinations: readonly Readonly<TileCoord>[];
  destinationKeys: Set<number>;
  heuristic(tile: TileCoord): number;
  visited: Set<number>;
  parent: Map<number, TileCoord>;
  open: GuidedPathNode[];
  bestCostByTile: Map<number, number>;
  checkedTiles: Set<number>;
  insertionOrder: number;
  totalIterations: number;
  closestTile: TileCoord;
  closestHeuristic: number;
  closestCost: number;
  status: GuidedPathSearchResult["status"];
  foundTile: TileCoord | null;
};

// A pending search owns these structures until its caller drops the job. They
// must never be returned to bfsPool between slices or exposed for mutation.
const guidedSearchStates = new WeakMap<GuidedPathSearch, GuidedSearchState>();

/**
 * One stationary-start search, bounded spatially by PATHFIND_RADIUS. The caller
 * owns cancellation and graph invalidation: invalidate when a checked tile's
 * collision/occupancy changes, or when other walkability inputs change. Passing
 * a fresh callback alone cannot reopen a previously closed part of the graph.
 */
export class GuidedPathSearch {
  readonly start: Readonly<TileCoord>;

  constructor(start: TileCoord, destinations: readonly TileCoord[]) {
    for (const tile of [start, ...destinations]) {
      if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.z)) {
        throw new Error("[BFSPathfinder] Guided search requires finite tiles");
      }
    }
    this.start = Object.freeze({ x: start.x, z: start.z });
    const copiedDestinations = destinations.map((tile) =>
      Object.freeze({ x: tile.x, z: tile.z }),
    );
    const destinationKeys = new Set(copiedDestinations.map(tileKeyNumeric));
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const tile of copiedDestinations) {
      minX = Math.min(minX, tile.x);
      maxX = Math.max(maxX, tile.x);
      minZ = Math.min(minZ, tile.z);
      maxZ = Math.max(maxZ, tile.z);
    }
    const heuristic = (tile: TileCoord): number => {
      if (copiedDestinations.length <= 32) {
        let nearest = Infinity;
        for (const destination of copiedDestinations) {
          nearest = Math.min(
            nearest,
            Math.max(
              Math.abs(tile.x - destination.x),
              Math.abs(tile.z - destination.z),
            ),
          );
        }
        return nearest;
      }
      const dx = tile.x < minX ? minX - tile.x : Math.max(0, tile.x - maxX);
      const dz = tile.z < minZ ? minZ - tile.z : Math.max(0, tile.z - maxZ);
      return Math.max(dx, dz);
    };
    const startKey = tileKeyNumeric(this.start);
    const startHeuristic = heuristic(this.start);
    const atDestination = destinationKeys.has(startKey);
    guidedSearchStates.set(this, {
      start: this.start,
      destinations: copiedDestinations,
      destinationKeys,
      heuristic,
      visited: new Set(),
      parent: new Map(),
      open:
        destinations.length && !atDestination
          ? [{ tile: this.start, cost: 0, heuristic: startHeuristic, order: 0 }]
          : [],
      bestCostByTile: new Map([[startKey, 0]]),
      // The caller may have checked the requested goals before beginning. Goal
      // closure/opening must invalidate even before this search expands them.
      checkedTiles: new Set([startKey, ...destinationKeys]),
      insertionOrder: 1,
      totalIterations: 0,
      closestTile: this.start,
      closestHeuristic: startHeuristic,
      closestCost: 0,
      status: atDestination
        ? "found"
        : destinations.length
          ? "pending"
          : "exhausted",
      foundTile: atDestination ? this.start : null,
    });
  }

  /** Every heap pop, including stale entries, across all advances. */
  get totalIterations(): number {
    return guidedSearchStates.get(this)!.totalIterations;
  }

  /** Includes blocked destinations, diagonal clearance tiles and from tiles. */
  hasCheckedTile(x: number, z: number): boolean {
    return guidedSearchStates
      .get(this)!
      .checkedTiles.has(tileKeyNumeric({ x, z }));
  }
}

/**
 * BFS Pathfinder for tile-based movement
 */
export class BFSPathfinder {
  /**
   * Track whether the last path was partial (didn't reach destination).
   * Set to true when BFS iteration limit is reached or target is unreachable.
   */
  private _lastPathWasPartial = false;

  /**
   * Track the actual destination for the last path request.
   * Used to compare against partial path endpoint.
   */
  private _lastRequestedDestination: TileCoord | null = null;

  /**
   * How many BFS iterations the last findPath/findPathToAny call consumed.
   * Used by callers to track global iteration budgets across multiple calls.
   */
  private _lastIterationsUsed = 0;

  /** Pre-allocated scratch tile for BFS neighbor checks (zero allocation) */
  private _scratchNeighbor: TileCoord = { x: 0, z: 0 };

  /** Pre-allocated scratch tiles for diagonal corner clipping checks */
  private _scratchCardinalX: TileCoord = { x: 0, z: 0 };
  private _scratchCardinalZ: TileCoord = { x: 0, z: 0 };

  /**
   * Check if the last path returned by findPath() was partial.
   * A partial path means the destination wasn't reached due to:
   * - BFS iteration limit (MAX_BFS_ITERATIONS)
   * - Destination outside search radius (PATHFIND_RADIUS)
   * - Destination is blocked (path goes to nearest walkable)
   *
   * @returns true if last path was partial, false if it reached destination
   */
  wasLastPathPartial(): boolean {
    return this._lastPathWasPartial;
  }

  /**
   * Get the destination that was requested for the last path.
   * Useful for comparing against the actual path endpoint to show
   * the player where they wanted to go vs where they'll actually end up.
   */
  getLastRequestedDestination(): TileCoord | null {
    return this._lastRequestedDestination;
  }

  /**
   * How many BFS iterations the last findPath/findPathToAny consumed.
   * Callers use this to maintain a global iteration budget across multiple
   * pathfinding calls in a single tick.
   */
  getLastIterationsUsed(): number {
    return this._lastIterationsUsed;
  }

  /**
   * Find a path from start to end using BFS (classic MMORPG "smartpathing").
   * BFS is the primary pathfinder for all player movement.
   *
   * After calling, check `wasLastPathPartial()` to see if the path
   * reaches the actual destination or just a partial point.
   *
   * @param maxIterations - Optional iteration cap (defaults to internal MAX_BFS_ITERATIONS).
   *   Callers can pass a lower value when a global budget is running low.
   */
  findPath(
    start: TileCoord,
    end: TileCoord,
    isWalkable: WalkabilityChecker,
    maxIterations?: number,
  ): TileCoord[] {
    // Reset per-request metadata so callers can trust path status from this call.
    this._lastPathWasPartial = false;
    this._lastIterationsUsed = 0;
    this._lastRequestedDestination = { x: end.x, z: end.z };

    // Validate inputs
    if (!start || typeof start.x !== "number" || typeof start.z !== "number") {
      throw new Error(
        `[BFSPathfinder] Invalid start tile: ${JSON.stringify(start)}`,
      );
    }
    if (!end || typeof end.x !== "number" || typeof end.z !== "number") {
      throw new Error(
        `[BFSPathfinder] Invalid end tile: ${JSON.stringify(end)}`,
      );
    }
    if (!Number.isFinite(start.x) || !Number.isFinite(start.z)) {
      throw new Error(
        `[BFSPathfinder] Start tile has non-finite coords: (${start.x}, ${start.z})`,
      );
    }
    if (!Number.isFinite(end.x) || !Number.isFinite(end.z)) {
      throw new Error(
        `[BFSPathfinder] End tile has non-finite coords: (${end.x}, ${end.z})`,
      );
    }
    if (typeof isWalkable !== "function") {
      throw new Error(`[BFSPathfinder] isWalkable must be a function`);
    }

    // Already at destination
    if (tilesEqual(start, end)) {
      return [];
    }

    // Check if end is walkable
    const originalEnd = { x: end.x, z: end.z };
    if (!isWalkable(end)) {
      // Find nearest walkable tile to destination
      const nearestWalkable = this.findNearestWalkable(end, isWalkable);
      if (!nearestWalkable) {
        this._lastPathWasPartial = true; // Destination unreachable
        return []; // No path possible
      }
      end = nearestWalkable;
      // Mark as partial if we had to change the destination
      if (!tilesEqual(originalEnd, end)) {
        this._lastPathWasPartial = true;
      }
    }

    // BFS is the primary pathfinder (classic MMORPG "smartpathing")
    // Note: BFS may also set _lastPathWasPartial if iteration limit is reached
    return this.findBFSPath(start, end, isWalkable, maxIterations);
  }

  /**
   * Find the same shortest eight-direction path while ordering unexplored
   * tiles by an admissible Chebyshev heuristic. Long server-owned routes use
   * this bounded search so open terrain does not require breadth-first
   * expansion of every tile around the actor before making useful progress.
   */
  findPathGuided(
    start: TileCoord,
    end: TileCoord,
    isWalkable: WalkabilityChecker,
    maxIterations?: number,
  ): TileCoord[] {
    this._lastPathWasPartial = false;
    this._lastIterationsUsed = 0;
    this._lastRequestedDestination = { x: end.x, z: end.z };

    if (!start || typeof start.x !== "number" || typeof start.z !== "number") {
      throw new Error(
        `[BFSPathfinder] Invalid start tile: ${JSON.stringify(start)}`,
      );
    }
    if (!end || typeof end.x !== "number" || typeof end.z !== "number") {
      throw new Error(
        `[BFSPathfinder] Invalid end tile: ${JSON.stringify(end)}`,
      );
    }
    if (!Number.isFinite(start.x) || !Number.isFinite(start.z)) {
      throw new Error(
        `[BFSPathfinder] Start tile has non-finite coords: (${start.x}, ${start.z})`,
      );
    }
    if (!Number.isFinite(end.x) || !Number.isFinite(end.z)) {
      throw new Error(
        `[BFSPathfinder] End tile has non-finite coords: (${end.x}, ${end.z})`,
      );
    }
    if (typeof isWalkable !== "function") {
      throw new Error(`[BFSPathfinder] isWalkable must be a function`);
    }
    if (tilesEqual(start, end)) return [];

    const originalEnd = { x: end.x, z: end.z };
    if (!isWalkable(end)) {
      const nearestWalkable = this.findNearestWalkable(end, isWalkable);
      if (!nearestWalkable) {
        this._lastPathWasPartial = true;
        return [];
      }
      end = nearestWalkable;
      if (!tilesEqual(originalEnd, end)) this._lastPathWasPartial = true;
    }

    return this.findGuidedPath(start, [end], isWalkable, maxIterations);
  }

  /**
   * Multi-destination BFS: find shortest path from start to ANY destination tile.
   *
   * classic MMORPG combat pathfinding feeds all valid interaction tiles into the pathfinder
   * and terminates as soon as any is reached. This naturally finds the shortest
   * path to the closest valid combat tile.
   *
   * @param start - Starting tile
   * @param destinations - Array of valid destination tiles (e.g. all tiles in attack range with LoS)
   * @param isWalkable - Walkability checker
   * @returns Shortest path to the nearest reachable destination, or [] if none reachable
   */
  findPathToAny(
    start: TileCoord,
    destinations: TileCoord[],
    isWalkable: WalkabilityChecker,
    maxIterations?: number,
  ): TileCoord[] {
    this._lastPathWasPartial = false;
    this._lastIterationsUsed = 0;
    this._lastRequestedDestination = null;
    if (destinations.length === 0) {
      return [];
    }

    // Check if already at any destination
    for (const dest of destinations) {
      if (tilesEqual(start, dest)) {
        this._lastIterationsUsed = 0;
        return [];
      }
    }

    // Build destination lookup set for O(1) checks
    const destSet = new Set<number>();
    for (const dest of destinations) {
      destSet.add(tileKeyNumeric(dest));
    }

    const iterLimit =
      maxIterations !== undefined
        ? Math.min(maxIterations, this.MAX_BFS_ITERATIONS)
        : this.MAX_BFS_ITERATIONS;

    // Standard BFS from start, terminate at first destination hit
    const pooledData = bfsPool.acquire();
    const { visited, parent, queue } = pooledData;

    try {
      queue.push(start);
      visited.add(tileKeyNumeric(start));

      const minX = start.x - PATHFIND_RADIUS;
      const maxX = start.x + PATHFIND_RADIUS;
      const minZ = start.z - PATHFIND_RADIUS;
      const maxZ = start.z + PATHFIND_RADIUS;
      let front = 0;
      let iterations = 0;

      while (front < queue.length) {
        if (iterations >= iterLimit) {
          this._lastPathWasPartial = true;
          this._lastIterationsUsed = iterations;
          return this.findPartialPathToAny(
            start,
            destinations,
            visited,
            parent,
          );
        }
        iterations++;

        const current = queue[front++];

        // Check if we reached ANY destination (inline tileKeyNumeric)
        const currentKey =
          ((current.x + 1048576) | 0) * 2097152 + ((current.z + 1048576) | 0);
        if (destSet.has(currentKey)) {
          this._lastIterationsUsed = iterations;
          return this.reconstructPath(start, current, parent);
        }

        // Expand neighbors in classic MMORPG order (zero-allocation scratch tile for checks)
        for (const dir of TILE_DIRECTIONS) {
          const nx = current.x + dir.x;
          const nz = current.z + dir.z;
          if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;

          const neighborKey =
            ((nx + 1048576) | 0) * 2097152 + ((nz + 1048576) | 0);
          if (visited.has(neighborKey)) continue;

          // Use scratch tile for walkability check (zero allocation)
          this._scratchNeighbor.x = nx;
          this._scratchNeighbor.z = nz;
          if (!this.canMoveTo(current, this._scratchNeighbor, isWalkable))
            continue;

          // Only allocate when actually enqueuing
          const neighbor: TileCoord = { x: nx, z: nz };
          visited.add(neighborKey);
          parent.set(neighborKey, current);
          queue.push(neighbor);
        }
      }

      // No destination reachable — partial path to closest destination
      this._lastIterationsUsed = iterations;
      return this.findPartialPathToAny(start, destinations, visited, parent);
    } finally {
      bfsPool.release(pooledData);
    }
  }

  /** Guided shortest-path variant for an authored set of valid destinations. */
  findPathToAnyGuided(
    start: TileCoord,
    destinations: TileCoord[],
    isWalkable: WalkabilityChecker,
    maxIterations?: number,
  ): TileCoord[] {
    this._lastPathWasPartial = false;
    this._lastIterationsUsed = 0;
    this._lastRequestedDestination = null;
    if (destinations.length === 0) return [];
    if (destinations.some((destination) => tilesEqual(start, destination))) {
      return [];
    }
    return this.findGuidedPath(start, destinations, isWalkable, maxIterations);
  }

  private guidedNodeComesBefore(
    left: GuidedPathNode,
    right: GuidedPathNode,
  ): boolean {
    const leftScore = left.cost + left.heuristic;
    const rightScore = right.cost + right.heuristic;
    return (
      leftScore < rightScore ||
      (leftScore === rightScore &&
        (left.heuristic < right.heuristic ||
          (left.heuristic === right.heuristic && left.order < right.order)))
    );
  }

  private pushGuidedNode(heap: GuidedPathNode[], node: GuidedPathNode): void {
    let index = heap.length;
    heap.push(node);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (!this.guidedNodeComesBefore(node, heap[parentIndex])) break;
      heap[index] = heap[parentIndex];
      index = parentIndex;
    }
    heap[index] = node;
  }

  private popGuidedNode(heap: GuidedPathNode[]): GuidedPathNode | null {
    const root = heap[0];
    const tail = heap.pop();
    if (!root || !tail || heap.length === 0) return root ?? null;

    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= heap.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex =
        rightIndex < heap.length &&
        this.guidedNodeComesBefore(heap[rightIndex], heap[leftIndex])
          ? rightIndex
          : leftIndex;
      if (!this.guidedNodeComesBefore(heap[childIndex], tail)) break;
      heap[index] = heap[childIndex];
      index = childIndex;
    }
    heap[index] = tail;
    return root;
  }

  private findGuidedPath(
    start: TileCoord,
    destinations: TileCoord[],
    isWalkable: WalkabilityChecker,
    maxIterations?: number,
  ): TileCoord[] {
    const adjustedDestination = this._lastPathWasPartial;
    const requestedDestination = this._lastRequestedDestination;
    const result = this.advanceGuidedSearch(
      this.beginGuidedSearch(start, destinations),
      isWalkable,
      maxIterations ?? this.MAX_BFS_ITERATIONS,
    );
    this._lastPathWasPartial ||= adjustedDestination;
    this._lastRequestedDestination = requestedDestination;
    return result.path;
  }

  /** No walkability work or implicit nearest-destination substitution. */
  beginGuidedSearch(
    start: TileCoord,
    destinations: readonly TileCoord[],
  ): GuidedPathSearch {
    return new GuidedPathSearch(start, destinations);
  }

  /**
   * Advance one caller-owned job, charging every heap pop (even stale entries).
   * A slice ending with an open frontier is pending, never unreachable. Zero
   * allowance leaves the job untouched and resets last-slice usage to zero.
   * Inputs to walkability must remain stable until the caller discards the job.
   */
  advanceGuidedSearch(
    search: GuidedPathSearch,
    isWalkable: WalkabilityChecker,
    maxIterations: number,
  ): GuidedPathSearchResult {
    const state = guidedSearchStates.get(search);
    if (!state) throw new Error("[BFSPathfinder] Invalid guided search");
    if (typeof isWalkable !== "function") {
      throw new Error("[BFSPathfinder] isWalkable must be a function");
    }
    if (!Number.isFinite(maxIterations)) {
      throw new Error(
        "[BFSPathfinder] Guided slice requires a finite allowance",
      );
    }
    const iterLimit = Math.max(
      0,
      Math.min(Math.floor(maxIterations), this.MAX_BFS_ITERATIONS),
    );
    this._lastIterationsUsed = 0;
    this._lastRequestedDestination =
      state.destinations.length === 1 ? { ...state.destinations[0] } : null;
    const { start, visited, parent, open, bestCostByTile } = state;
    const checkedWalkability: WalkabilityChecker = (tile, fromTile) => {
      state.checkedTiles.add(tileKeyNumeric(tile));
      if (fromTile) {
        state.checkedTiles.add(tileKeyNumeric(fromTile));
        // Directional collision checkers can inspect diagonal clearance before
        // returning false, ahead of canMoveTo's own cardinal callbacks.
        if (tile.x !== fromTile.x && tile.z !== fromTile.z) {
          state.checkedTiles.add(tileKeyNumeric({ x: tile.x, z: fromTile.z }));
          state.checkedTiles.add(tileKeyNumeric({ x: fromTile.x, z: tile.z }));
        }
      }
      return isWalkable(tile, fromTile);
    };

    while (
      state.status === "pending" &&
      open.length > 0 &&
      this._lastIterationsUsed < iterLimit
    ) {
      const current = this.popGuidedNode(open)!;
      this._lastIterationsUsed++;
      state.totalIterations++;
      const currentKey = tileKeyNumeric(current.tile);
      if (visited.has(currentKey)) continue;
      if (bestCostByTile.get(currentKey) !== current.cost) continue;
      visited.add(currentKey);
      if (state.destinationKeys.has(currentKey)) {
        state.foundTile = current.tile;
        state.status = "found";
        break;
      }
      if (
        current.heuristic < state.closestHeuristic ||
        (current.heuristic === state.closestHeuristic &&
          current.cost < state.closestCost)
      ) {
        state.closestTile = current.tile;
        state.closestHeuristic = current.heuristic;
        state.closestCost = current.cost;
      }
      for (const dir of TILE_DIRECTIONS) {
        const nx = current.tile.x + dir.x;
        const nz = current.tile.z + dir.z;
        if (
          nx < start.x - PATHFIND_RADIUS ||
          nx > start.x + PATHFIND_RADIUS ||
          nz < start.z - PATHFIND_RADIUS ||
          nz > start.z + PATHFIND_RADIUS
        )
          continue;
        const neighborKey =
          ((nx + 1048576) | 0) * 2097152 + ((nz + 1048576) | 0);
        if (visited.has(neighborKey)) continue;
        this._scratchNeighbor.x = nx;
        this._scratchNeighbor.z = nz;
        if (
          !this.canMoveTo(
            current.tile,
            this._scratchNeighbor,
            checkedWalkability,
          )
        )
          continue;
        const nextCost = current.cost + 1;
        const previousCost = bestCostByTile.get(neighborKey);
        if (previousCost !== undefined && previousCost <= nextCost) continue;
        const neighbor = { x: nx, z: nz };
        bestCostByTile.set(neighborKey, nextCost);
        parent.set(neighborKey, current.tile);
        this.pushGuidedNode(open, {
          tile: neighbor,
          cost: nextCost,
          heuristic: state.heuristic(neighbor),
          order: state.insertionOrder++,
        });
      }
    }
    if (state.status === "pending" && open.length === 0)
      state.status = "exhausted";
    const endpoint = state.foundTile ?? state.closestTile;
    const path = tilesEqual(endpoint, start)
      ? []
      : this.reconstructPath(start, endpoint, parent);
    // A found route can exceed the historical 200-tile returned segment. Keep
    // continuation intent until the segment actually reaches the found goal.
    this._lastPathWasPartial =
      state.status !== "found" ||
      (path.length > 0 && !tilesEqual(path[path.length - 1], endpoint));
    return { status: state.status, path };
  }

  /**
   * Naive diagonal pathing — "dumb pathfinding" for NPC chase systems.
   * Moves diagonally toward target first, then cardinally.
   * This is NOT used for player movement (players use BFS).
   *
   * Exposed publicly for ChasePathfinding and NPC follow systems.
   */
  findNaivePath(
    start: TileCoord,
    end: TileCoord,
    isWalkable: WalkabilityChecker,
  ): TileCoord[] {
    const path: TileCoord[] = [];
    let current = { ...start };

    const maxIterations = 500;
    let iterations = 0;

    while (!tilesEqual(current, end) && iterations < maxIterations) {
      iterations++;

      const dx = Math.sign(end.x - current.x);
      const dz = Math.sign(end.z - current.z);

      let nextTile: TileCoord | null = null;

      if (dx !== 0 && dz !== 0) {
        const diagonal: TileCoord = { x: current.x + dx, z: current.z + dz };

        if (this.canMoveTo(current, diagonal, isWalkable)) {
          nextTile = diagonal;
        } else {
          const xDist = Math.abs(end.x - current.x);
          const zDist = Math.abs(end.z - current.z);

          if (xDist >= zDist) {
            const cardinalX: TileCoord = { x: current.x + dx, z: current.z };
            const cardinalZ: TileCoord = { x: current.x, z: current.z + dz };
            if (this.canMoveTo(current, cardinalX, isWalkable)) {
              nextTile = cardinalX;
            } else if (this.canMoveTo(current, cardinalZ, isWalkable)) {
              nextTile = cardinalZ;
            }
          } else {
            const cardinalZ: TileCoord = { x: current.x, z: current.z + dz };
            const cardinalX: TileCoord = { x: current.x + dx, z: current.z };
            if (this.canMoveTo(current, cardinalZ, isWalkable)) {
              nextTile = cardinalZ;
            } else if (this.canMoveTo(current, cardinalX, isWalkable)) {
              nextTile = cardinalX;
            }
          }
        }
      } else if (dx !== 0) {
        const cardinalX: TileCoord = { x: current.x + dx, z: current.z };
        if (this.canMoveTo(current, cardinalX, isWalkable)) {
          nextTile = cardinalX;
        }
      } else if (dz !== 0) {
        const cardinalZ: TileCoord = { x: current.x, z: current.z + dz };
        if (this.canMoveTo(current, cardinalZ, isWalkable)) {
          nextTile = cardinalZ;
        }
      }

      if (!nextTile) {
        return [];
      }

      path.push(nextTile);
      current = nextTile;

      if (path.length > 200) {
        return path;
      }
    }

    return path;
  }

  /**
   * BFS pathfinding — primary pathfinder for player movement.
   *
   * Uses object pool to minimize allocations in this hot path.
   *
   * PERFORMANCE: Limited to MAX_BFS_ITERATIONS to prevent main thread blocking.
   * If limit is reached, returns partial path to closest explored tile.
   *
   * OPTIMIZATION: Uses read index instead of queue.shift() for O(1) dequeue.
   */
  // 4000 iterations gives ~31-tile reliable radius in open terrain (4n² ≈ 4000 → n ≈ 31).
  // Reduced from 8000 to limit event loop blocking when multiple players path simultaneously.
  // Path continuation seamlessly extends partial paths so players still reach distant targets.
  private readonly MAX_BFS_ITERATIONS = 4000;
  private _bfsIterationWarnings = 0;

  private findBFSPath(
    start: TileCoord,
    end: TileCoord,
    isWalkable: WalkabilityChecker,
    maxIterationsOverride?: number,
  ): TileCoord[] {
    // Acquire pooled data structures to avoid per-call allocations
    const pooledData = bfsPool.acquire();
    const { visited, parent, queue } = pooledData;

    try {
      // Start BFS from start tile
      queue.push(start);
      // OPTIMIZATION: Use numeric key instead of string to avoid allocation
      visited.add(tileKeyNumeric(start));

      // Track bounds for 128x128 limit
      const minX = start.x - PATHFIND_RADIUS;
      const maxX = start.x + PATHFIND_RADIUS;
      const minZ = start.z - PATHFIND_RADIUS;
      const maxZ = start.z + PATHFIND_RADIUS;

      // PERFORMANCE: Track iterations to prevent blocking
      let iterations = 0;
      const iterLimit =
        maxIterationsOverride !== undefined
          ? Math.min(maxIterationsOverride, this.MAX_BFS_ITERATIONS)
          : this.MAX_BFS_ITERATIONS;

      // OPTIMIZATION: Use read index instead of shift() - O(1) vs O(n)
      let queueReadIndex = 0;

      while (queueReadIndex < queue.length) {
        // PERFORMANCE: Check iteration limit to prevent frame drops
        if (iterations >= iterLimit) {
          // Mark path as partial due to iteration limit
          this._lastPathWasPartial = true;
          this._lastIterationsUsed = iterations;
          // Log warning periodically (not every path to avoid spam)
          if (this._bfsIterationWarnings % 100 === 0) {
            console.warn(
              `[BFSPathfinder] Iteration limit (${iterLimit}) reached at tile (${start.x},${start.z}), returning partial path to (${end.x},${end.z})`,
            );
          }
          this._bfsIterationWarnings++;
          // Return partial path to closest explored tile
          return this.findPartialPath(start, end, visited, parent);
        }
        iterations++;

        // O(1) dequeue using read index
        const current = queue[queueReadIndex++];

        // Found the destination
        if (tilesEqual(current, end)) {
          this._lastIterationsUsed = iterations;
          return this.reconstructPath(start, end, parent);
        }

        // Check all 8 directions in classic MMORPG order: W, E, S, N, SW, SE, NW, NE
        // OPTIMIZATION: Use scratch tile for checks, only allocate when enqueuing.
        // Reduces allocations from 8 per iteration to ~1-2 (only walkable neighbors).
        for (const dir of TILE_DIRECTIONS) {
          const nx = current.x + dir.x;
          const nz = current.z + dir.z;

          // Skip if out of search bounds
          if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) {
            continue;
          }

          // OPTIMIZATION: Inline tileKeyNumeric to avoid TileCoord allocation
          const neighborKey =
            ((nx + 1048576) | 0) * 2097152 + ((nz + 1048576) | 0);

          // Skip if already visited
          if (visited.has(neighborKey)) {
            continue;
          }

          // Use scratch tile for walkability check (zero allocation)
          this._scratchNeighbor.x = nx;
          this._scratchNeighbor.z = nz;

          // Check walkability (including diagonal corner checks)
          if (!this.canMoveTo(current, this._scratchNeighbor, isWalkable)) {
            continue;
          }

          // Only allocate a new tile when actually adding to queue
          const neighbor: TileCoord = { x: nx, z: nz };
          visited.add(neighborKey);
          parent.set(neighborKey, current);
          queue.push(neighbor);
        }
      }

      // No path found - return partial path to closest point
      this._lastPathWasPartial = true;
      this._lastIterationsUsed = iterations;
      return this.findPartialPath(start, end, visited, parent);
    } finally {
      // Always release back to pool
      bfsPool.release(pooledData);
    }
  }

  /**
   * Check if movement from one tile to another is valid.
   * Handles diagonal corner clipping prevention.
   */
  canMoveTo(
    from: TileCoord,
    to: TileCoord,
    isWalkable: WalkabilityChecker,
  ): boolean {
    // Target must be walkable
    if (!isWalkable(to, from)) {
      return false;
    }

    const dx = to.x - from.x;
    const dz = to.z - from.z;

    // For diagonal movement, check corner clipping (zero allocation using scratch tiles)
    if (isDiagonal(dx, dz)) {
      this._scratchCardinalX.x = from.x + dx;
      this._scratchCardinalX.z = from.z;
      this._scratchCardinalZ.x = from.x;
      this._scratchCardinalZ.z = from.z + dz;

      // Both adjacent tiles must be walkable to prevent corner clipping
      if (
        !isWalkable(this._scratchCardinalX, from) ||
        !isWalkable(this._scratchCardinalZ, from)
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Reconstruct path from BFS parent map
   * Returns FULL TILE-BY-TILE path from start (exclusive) to end (inclusive)
   *
   * OPTIMIZATION: Uses push + reverse instead of unshift for O(n) vs O(n²)
   * Uses numeric keys for Map lookup (no string allocation in hot path)
   */
  private reconstructPath(
    start: TileCoord,
    end: TileCoord,
    parent: Map<number, TileCoord>,
  ): TileCoord[] {
    const fullPath: TileCoord[] = [];
    let current = end;

    // Trace back from end to start (builds path in reverse order)
    while (!tilesEqual(current, start)) {
      // Own every coordinate in the returned path. Direct path callers often
      // pass a reusable scratch tile as `end`; retaining that reference makes
      // a later path request silently rewrite this path's destination.
      fullPath.push({ x: current.x, z: current.z });
      // OPTIMIZATION: Use numeric key
      const parentTile = parent.get(tileKeyNumeric(current));
      if (!parentTile) break;
      current = parentTile;
    }

    // Reverse to get correct order (single O(n) pass vs O(n²) for unshift)
    fullPath.reverse();

    // Limit to reasonable max to prevent memory issues
    if (fullPath.length > 200) {
      fullPath.length = 200; // Truncate in place instead of slice()
    }

    return fullPath;
  }

  /**
   * Find nearest walkable tile to a target
   * Used when destination is blocked
   */
  private findNearestWalkable(
    target: TileCoord,
    isWalkable: WalkabilityChecker,
  ): TileCoord | null {
    // Check tiles in expanding rings around target
    for (let radius = 1; radius <= 5; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          // Only check tiles on the edge of this ring
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) {
            continue;
          }

          const tile: TileCoord = {
            x: target.x + dx,
            z: target.z + dz,
          };

          if (isWalkable(tile)) {
            return tile;
          }
        }
      }
    }

    return null;
  }

  /**
   * Find a partial path when destination is unreachable
   * Returns path to the closest visited tile to the destination
   *
   * OPTIMIZATION: Uses numeric keys and parseTileKeyNumeric for fast iteration
   */
  private findPartialPath(
    start: TileCoord,
    end: TileCoord,
    visited: Set<number>,
    parent: Map<number, TileCoord>,
  ): TileCoord[] {
    // Find the visited tile closest to the destination
    let closestTile: TileCoord | null = null;
    let closestDistance = Infinity;

    // OPTIMIZATION: Parse numeric key instead of string split
    for (const key of visited) {
      // Decode numeric key: x in upper bits, z in lower bits
      const offsetZ = key % 2097152;
      const offsetX = ((key - offsetZ) / 2097152) | 0;
      const x = offsetX - 1048576;
      const z = offsetZ - 1048576;

      const distance = Math.abs(x - end.x) + Math.abs(z - end.z);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestTile = { x, z };
      }
    }

    if (!closestTile || tilesEqual(closestTile, start)) {
      return [];
    }

    return this.reconstructPath(start, closestTile, parent);
  }

  /**
   * Find a partial path when no destination is reachable (multi-destination variant).
   * Returns path to the visited tile closest to any destination.
   */
  private findPartialPathToAny(
    start: TileCoord,
    destinations: TileCoord[],
    visited: Set<number>,
    parent: Map<number, TileCoord>,
  ): TileCoord[] {
    let closestTile: TileCoord | null = null;
    let closestDistance = Infinity;

    for (const key of visited) {
      // Decode numeric key: x in upper bits, z in lower bits
      const offsetZ = key % 2097152;
      const offsetX = ((key - offsetZ) / 2097152) | 0;
      const x = offsetX - 1048576;
      const z = offsetZ - 1048576;
      const tile: TileCoord = { x, z };

      // Find minimum Manhattan distance to any destination
      let minDist = Infinity;
      for (const dest of destinations) {
        const distance = Math.abs(tile.x - dest.x) + Math.abs(tile.z - dest.z);
        if (distance < minDist) minDist = distance;
      }

      if (minDist < closestDistance) {
        closestDistance = minDist;
        closestTile = tile;
      }
    }

    if (!closestTile || tilesEqual(closestTile, start)) {
      return [];
    }

    return this.reconstructPath(start, closestTile, parent);
  }

  /**
   * Calculate path length (in tiles walked, not checkpoints)
   */
  getPathLength(path: TileCoord[]): number {
    if (path.length <= 1) {
      return path.length;
    }

    let length = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dz = Math.abs(path[i].z - path[i - 1].z);
      // Diagonal counts as 1 tile (Chebyshev distance)
      length += Math.max(dx, dz);
    }

    return length;
  }
}
