/**
 * WaterBodyRegistry — spatial index of water bodies at arbitrary elevations.
 *
 * Ocean water (terrain < WATER_THRESHOLD) is the fallback.
 * Inland water bodies (lakes, ponds) can be registered explicitly
 * with per-body surfaceY elevations.
 *
 * Spatial grid: O(1) hash + O(K) body check where K ≈ 0-2 per cell.
 */

import type { TerrainGridBounds } from "./TerrainGridSurface";

export type WaterBodySourceType = "explicit" | "landscape_pond";

export class ElevatedWaterBody {
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  radiusSq: number;
  surfaceY: number;
  sourceType: WaterBodySourceType;

  constructor(data: {
    id: string;
    centerX: number;
    centerZ: number;
    radius: number;
    radiusSq: number;
    surfaceY: number;
    sourceType: WaterBodySourceType;
  }) {
    this.id = data.id;
    this.centerX = data.centerX;
    this.centerZ = data.centerZ;
    this.radius = data.radius;
    this.radiusSq = data.radiusSq;
    this.surfaceY = data.surfaceY;
    this.sourceType = data.sourceType;
  }
}

function gridKey(cx: number, cz: number): number {
  return cx * 131072 + cz;
}

export class WaterBodyRegistry {
  private bodies: ElevatedWaterBody[] = [];
  private gridCellSize: number;
  private grid: Map<number, number[]> = new Map();
  private oceanLevel: number;

  constructor(oceanLevel: number, gridCellSize = 50) {
    this.oceanLevel = oceanLevel;
    this.gridCellSize = gridCellSize;
  }

  register(data: {
    id: string;
    centerX: number;
    centerZ: number;
    radius: number;
    radiusSq: number;
    surfaceY: number;
    sourceType: WaterBodySourceType;
  }): void {
    if (this.bodies.some((b) => b.id === data.id)) {
      console.warn(
        `[WaterBodyRegistry] Duplicate water body ID "${data.id}" — skipping`,
      );
      return;
    }
    const body = new ElevatedWaterBody(data);
    const idx = this.bodies.length;
    this.bodies.push(body);

    const cs = this.gridCellSize;
    const minCX = Math.floor((body.centerX - body.radius) / cs);
    const maxCX = Math.floor((body.centerX + body.radius) / cs);
    const minCZ = Math.floor((body.centerZ - body.radius) / cs);
    const maxCZ = Math.floor((body.centerZ + body.radius) / cs);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const key = gridKey(cx, cz);
        let cell = this.grid.get(key);
        if (!cell) {
          cell = [];
          this.grid.set(key, cell);
        }
        cell.push(idx);
      }
    }
  }

  getBodyAt(worldX: number, worldZ: number): ElevatedWaterBody | null {
    const cs = this.gridCellSize;
    const cx = Math.floor(worldX / cs);
    const cz = Math.floor(worldZ / cs);
    const cell = this.grid.get(gridKey(cx, cz));
    if (!cell) return null;

    let best: ElevatedWaterBody | null = null;
    for (let i = 0; i < cell.length; i++) {
      const body = this.bodies[cell[i]];
      const dx = worldX - body.centerX;
      const dz = worldZ - body.centerZ;
      if (dx * dx + dz * dz <= body.radiusSq) {
        if (!best || body.surfaceY > best.surfaceY) {
          best = body;
        }
      }
    }
    return best;
  }

  getWaterSurfaceAt(worldX: number, worldZ: number): number {
    const body = this.getBodyAt(worldX, worldZ);
    if (body) return body.surfaceY;
    return this.oceanLevel;
  }

  isUnderwater(worldX: number, worldZ: number, terrainHeight: number): boolean {
    return terrainHeight < this.getWaterSurfaceAt(worldX, worldZ);
  }

  getBodiesInTile(
    tileX: number,
    tileZ: number,
    tileSize: number,
  ): ElevatedWaterBody[] {
    // Terrain meshes are centered on tileX * tileSize, so tile 0 spans
    // [-tileSize/2, +tileSize/2). Match TerrainSystem's indexing exactly or
    // elevated bodies on the negative half of a tile disappear from both
    // collision baking and rendering.
    const minX = tileX * tileSize - tileSize * 0.5;
    const maxX = minX + tileSize;
    const minZ = tileZ * tileSize - tileSize * 0.5;
    const maxZ = minZ + tileSize;

    const result: ElevatedWaterBody[] = [];
    const seen = new Set<number>();

    const cs = this.gridCellSize;
    const cMinX = Math.floor(minX / cs);
    const cMaxX = Math.floor(maxX / cs);
    const cMinZ = Math.floor(minZ / cs);
    const cMaxZ = Math.floor(maxZ / cs);

    for (let cx = cMinX; cx <= cMaxX; cx++) {
      for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        const cell = this.grid.get(gridKey(cx, cz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (seen.has(idx)) continue;
          seen.add(idx);

          const body = this.bodies[idx];
          const closestX = Math.max(minX, Math.min(maxX, body.centerX));
          const closestZ = Math.max(minZ, Math.min(maxZ, body.centerZ));
          const dx = closestX - body.centerX;
          const dz = closestZ - body.centerZ;
          if (dx * dx + dz * dz <= body.radiusSq) {
            result.push(body);
          }
        }
      }
    }
    return result;
  }

  getAllBodies(): ReadonlyArray<ElevatedWaterBody> {
    return this.bodies;
  }

  /** Closed-region, read-only ownership for suspended vegetation work. Newly
   * registered or moved-in bodies invalidate it; unrelated bodies do not. */
  captureRegion(
    bounds: TerrainGridBounds,
    padding = 0,
  ): { isCurrent(): boolean } {
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, padding].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ ||
      padding < 0 ||
      padding > 32 ||
      this.bodies.length > 128
    )
      throw new Error("Invalid water-region lease");
    const region = Object.freeze({ ...bounds });
    const valid = (body: ElevatedWaterBody) =>
      Number.isFinite(body.centerX) &&
      Number.isFinite(body.centerZ) &&
      Number.isFinite(body.radius) &&
      Number.isFinite(body.radiusSq) &&
      Number.isFinite(body.surfaceY) &&
      body.radius > 0 &&
      body.radiusSq === body.radius * body.radius;
    const overlaps = (body: ElevatedWaterBody) => {
      const dx =
        body.centerX -
        Math.max(region.minX, Math.min(region.maxX, body.centerX));
      const dz =
        body.centerZ -
        Math.max(region.minZ, Math.min(region.maxZ, body.centerZ));
      return dx * dx + dz * dz <= (body.radius + padding) ** 2;
    };
    const captured = new Map<ElevatedWaterBody, Readonly<ElevatedWaterBody>>();
    for (const body of this.bodies) {
      if (!valid(body)) throw new Error("Invalid water-region body");
      if (overlaps(body)) captured.set(body, Object.freeze({ ...body }));
    }
    let current = true;
    return Object.freeze({
      isCurrent: () => {
        if (!current || this.bodies.length > 128) return (current = false);
        let matches = 0;
        for (const body of this.bodies) {
          if (!valid(body)) return (current = false);
          if (!overlaps(body)) continue;
          const old = captured.get(body);
          if (
            !old ||
            old.id !== body.id ||
            old.centerX !== body.centerX ||
            old.centerZ !== body.centerZ ||
            old.radius !== body.radius ||
            old.radiusSq !== body.radiusSq ||
            old.surfaceY !== body.surfaceY ||
            old.sourceType !== body.sourceType
          )
            return (current = false);
          matches++;
        }
        return (current = matches === captured.size);
      },
    });
  }

  getOceanLevel(): number {
    return this.oceanLevel;
  }
}
