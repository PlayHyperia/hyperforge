import type { World } from "../../../core/World";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import { ResourceType } from "../../../types/entities";
import {
  FOOTPRINT_SIZES,
  type ResourceFootprint,
} from "../../../types/game/resource-processing-types";
import { TILE_SIZE, worldToTile } from "../movement/TileSystem";

export const FLOWER_RESOURCE_CLEARANCE_LIMITS = Object.freeze({
  maxScannedEntities: 4096,
  maxObstacles: 512,
});

export type FlowerResourceClearanceLimits = Readonly<{
  maxScannedEntities: number;
  maxObstacles: number;
}>;

export type FlowerResourceClearanceRow = Readonly<{
  id: string;
  nodeUuid: string;
  resourceType: ResourceType.TREE | ResourceType.MINING_ROCK;
  position: Readonly<{ x: number; y: number; z: number }>;
  depleted: boolean;
  footprint: ResourceFootprint;
  footprintSource: "entity" | "conservative-max";
  anchorTile: Readonly<{ x: number; z: number }>;
  center: Readonly<{ x: number; z: number }>;
  radius: number;
}>;

export type FlowerResourceClearanceSnapshot = Readonly<{
  rows: readonly FlowerResourceClearanceRow[];
  receipt: Readonly<{
    schemaVersion: 1;
    policy: "live-resource-tile-envelope-v1";
    scannedEntities: number;
    obstacleCount: number;
    conservativeFallbackCount: number;
    limits: FlowerResourceClearanceLimits;
  }>;
  /** Reads only the detached snapshot. No entity scan or terrain query. */
  accepts(
    point: Readonly<{ x: number; z: number }>,
    maximumHorizontalFlowerReach: number,
  ): boolean;
  /** Synchronous full bounded re-scan, including additions and same-ID owners.
   * Call immediately before publishing a whole job, with no intervening await.
   * This is not an event subscription or a future-lifetime guarantee. */
  isCurrent(): boolean;
}>;

type CapturedObstacle = Readonly<{
  owner: ResourceEntity;
  row: FlowerResourceClearanceRow;
}>;

function captureLimits(
  requested: Partial<FlowerResourceClearanceLimits>,
): FlowerResourceClearanceLimits {
  const maxScannedEntities =
    requested.maxScannedEntities ??
    FLOWER_RESOURCE_CLEARANCE_LIMITS.maxScannedEntities;
  const maxObstacles =
    requested.maxObstacles ?? FLOWER_RESOURCE_CLEARANCE_LIMITS.maxObstacles;
  if (
    !Number.isInteger(maxScannedEntities) ||
    maxScannedEntities < 1 ||
    maxScannedEntities > FLOWER_RESOURCE_CLEARANCE_LIMITS.maxScannedEntities ||
    !Number.isInteger(maxObstacles) ||
    maxObstacles < 1 ||
    maxObstacles > FLOWER_RESOURCE_CLEARANCE_LIMITS.maxObstacles
  ) {
    throw new Error("Invalid bounded flower resource clearance limits");
  }
  return Object.freeze({ maxScannedEntities, maxObstacles });
}

function scan(world: World, limits: FlowerResourceClearanceLimits) {
  const entities = world.entities;
  const obstacles: CapturedObstacle[] = [];
  const ids = new Set<string>();
  let scannedEntities = 0;
  for (const entity of entities.values()) {
    if (++scannedEntities > limits.maxScannedEntities) {
      throw new Error("Flower resource scanned-entity cap exceeded");
    }
    if (!(entity instanceof ResourceEntity) || entity.destroyed) continue;
    const resourceType = entity.config.resourceType;
    if (
      resourceType !== ResourceType.TREE &&
      resourceType !== ResourceType.MINING_ROCK
    ) {
      continue;
    }
    if (obstacles.length >= limits.maxObstacles) {
      throw new Error("Flower resource obstacle cap exceeded");
    }
    if (
      entity.world !== world ||
      typeof entity.id !== "string" ||
      entity.id.length < 1 ||
      entity.id.length > 100 ||
      entities.get(entity.id) !== entity ||
      ids.has(entity.id)
    ) {
      throw new Error("Invalid flower resource entity ownership");
    }
    ids.add(entity.id);
    // Entity.position is the actual native node position; config/data positions
    // can be stale following client network reconciliation. No matrix update or
    // visual/proxy lookup is needed for the gameplay tile reservation.
    const { x, y, z } = entity.position;
    if (
      ![x, y, z].every(Number.isFinite) ||
      typeof entity.config.depleted !== "boolean"
    ) {
      throw new Error("Invalid live flower resource position/state");
    }
    const authoredFootprint = entity.config.footprint;
    if (
      authoredFootprint !== undefined &&
      authoredFootprint !== "standard" &&
      authoredFootprint !== "large" &&
      authoredFootprint !== "massive"
    ) {
      throw new Error("Invalid explicit flower resource footprint");
    }
    // Network-authored resource construction currently omits footprint. Never
    // infer standard=1x1 from that omission or from availability/proxy visibility.
    const footprint = authoredFootprint ?? "massive";
    const size = FOOTPRINT_SIZES[footprint];
    const anchorTile = worldToTile(x, z);
    if (
      !Number.isSafeInteger(anchorTile.x) ||
      !Number.isSafeInteger(anchorTile.z) ||
      !Number.isSafeInteger(anchorTile.x + size.x + 1) ||
      !Number.isSafeInteger(anchorTile.z + size.z + 1)
    ) {
      throw new Error("Flower resource tile coordinates exceed safe precision");
    }
    // Enclose all occupied tiles and the complete one-tile approach envelope.
    // Cardinal gathering uses only its N/E/S/W strips; retaining the four corner
    // squares is intentionally conservative. This is NOT a canopy/mesh bound.
    const center = Object.freeze({
      x: (anchorTile.x + size.x / 2) * TILE_SIZE,
      z: (anchorTile.z + size.z / 2) * TILE_SIZE,
    });
    const radius = Math.hypot(size.x / 2 + 1, size.z / 2 + 1) * TILE_SIZE;
    const row: FlowerResourceClearanceRow = Object.freeze({
      id: entity.id,
      nodeUuid: entity.node.uuid,
      resourceType,
      position: Object.freeze({ x, y, z }),
      depleted: entity.config.depleted,
      footprint,
      footprintSource:
        authoredFootprint === undefined ? "conservative-max" : "entity",
      anchorTile: Object.freeze(anchorTile),
      center,
      radius,
    });
    obstacles.push({ owner: entity, row });
  }
  obstacles.sort((a, b) =>
    a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0,
  );
  return { entities, obstacles, scannedEntities };
}

function equalObstacle(a: CapturedObstacle, b: CapturedObstacle): boolean {
  return (
    a.owner === b.owner &&
    a.row.id === b.row.id &&
    a.row.nodeUuid === b.row.nodeUuid &&
    a.row.resourceType === b.row.resourceType &&
    a.row.position.x === b.row.position.x &&
    a.row.position.y === b.row.position.y &&
    a.row.position.z === b.row.position.z &&
    a.row.depleted === b.row.depleted &&
    a.row.footprint === b.row.footprint &&
    a.row.footprintSource === b.row.footprintSource &&
    a.row.center.x === b.row.center.x &&
    a.row.center.z === b.row.center.z &&
    a.row.radius === b.row.radius
  );
}

/**
 * Inactive, resource-only placement adapter. Throws on invalid source/cap
 * admission; isCurrent and point admission fail closed. One snapshot is shared
 * by a bounded flower job, so candidates never trigger per-flower entity scans.
 *
 * Includes depleted actors, preserving their gathering/regrowth reservation.
 * Does not query ResourceSystem's incomplete client registry, alter grass RNG,
 * mutate actors, sample terrain, or establish path/station/water/mesh clearance.
 * The eventual owner must separately retire published flowers on world changes.
 */
export function captureFlowerResourceClearance(
  world: World,
  requestedLimits: Partial<FlowerResourceClearanceLimits> = {},
): FlowerResourceClearanceSnapshot {
  const limits = captureLimits(requestedLimits);
  const captured = scan(world, limits);
  const rows = Object.freeze(captured.obstacles.map(({ row }) => row));
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    policy: "live-resource-tile-envelope-v1" as const,
    scannedEntities: captured.scannedEntities,
    obstacleCount: rows.length,
    conservativeFallbackCount: rows.filter(
      (row) => row.footprintSource === "conservative-max",
    ).length,
    limits,
  });
  return Object.freeze({
    rows,
    receipt,
    accepts(
      point: Readonly<{ x: number; z: number }>,
      maximumHorizontalFlowerReach: number,
    ) {
      if (
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.z) ||
        !Number.isFinite(maximumHorizontalFlowerReach) ||
        maximumHorizontalFlowerReach < 0
      ) {
        return false;
      }
      for (const row of rows) {
        const radius = row.radius + maximumHorizontalFlowerReach;
        if (
          !Number.isFinite(radius) ||
          Math.hypot(point.x - row.center.x, point.z - row.center.z) <= radius
        ) {
          return false;
        }
      }
      return true;
    },
    isCurrent() {
      try {
        const current = scan(world, limits);
        return (
          current.entities === captured.entities &&
          current.obstacles.length === captured.obstacles.length &&
          current.obstacles.every((obstacle, index) =>
            equalObstacle(obstacle, captured.obstacles[index]),
          )
        );
      } catch {
        return false;
      }
    },
  });
}
