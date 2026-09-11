import {
  CollisionFlag,
  CollisionMatrix,
  DataManager,
  getDuelArenaConfig,
  getDuelArenaGradeHeight,
  DUEL_ARENA_FLOOR_GROUND_OFFSET,
} from "@hyperforge/shared";
import { createDuelArenaFloorZones } from "../../../../../shared/src/data/arena-grading";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ArenaPoolManager } from "../ArenaPoolManager";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

describe("ArenaPoolManager authoritative collision", () => {
  it("places all actual manifest spawns and vertical bounds on the shared arena floors", () => {
    const pool = new ArenaPoolManager();
    const config = getDuelArenaConfig();
    const groundY = getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_GROUND_OFFSET;
    const floors = createDuelArenaFloorZones(config, getDuelArenaGradeHeight());

    expect(pool.totalArenas).toBe(1);
    expect(pool.getAllArenaIds()).toEqual([1]);
    expect(groundY).toBeCloseTo(28.819301523097685, 12);
    expect(groundY).not.toBe(config.baseY);
    for (const id of pool.getAllArenaIds()) {
      const arena = pool.getArena(id)!;
      const floor = floors.find(
        (zone) => zone.id === `duel_arena_floor_${id}`,
      )!;
      expect(arena.bounds.min).toEqual({
        x: floor.centerX - floor.width / 2,
        y: groundY - 1,
        z: floor.centerZ - floor.depth / 2,
      });
      expect(arena.bounds.max).toEqual({
        x: floor.centerX + floor.width / 2,
        y: groundY + 10,
        z: floor.centerZ + floor.depth / 2,
      });
      for (const [index, spawn] of arena.spawnPoints.entries()) {
        const offset = (index === 0 ? -1 : 1) * config.spawnOffset;
        expect(spawn).toEqual({
          x: floor.centerX + (config.spawnLayout === "alongWidth" ? offset : 0),
          y: floor.height,
          z: floor.centerZ + (config.spawnLayout === "alongWidth" ? 0 : offset),
        });
        expect(Math.abs(spawn.x - floor.centerX)).toBeLessThan(floor.width / 2);
        expect(Math.abs(spawn.z - floor.centerZ)).toBeLessThan(floor.depth / 2);
      }
    }
  });

  it("keeps a specifically owned arena out of general allocation", () => {
    const pool = new ArenaPoolManager();

    expect(pool.reserveSpecificArena(1, "streaming-owner")).toBe(true);
    expect(pool.reserveSpecificArena(1, "second-owner")).toBe(false);
    expect(pool.getDuelIdForArena(1)).toBe("streaming-owner");
    expect(pool.reserveArena("ordinary-duel")).toBeNull();
    expect(pool.getAvailableCount()).toBe(0);

    expect(pool.releaseSpecificArena(1, "wrong-owner")).toBe(false);
    expect(pool.getDuelIdForArena(1)).toBe("streaming-owner");
    expect(pool.releaseSpecificArena(1, "streaming-owner")).toBe(true);
    expect(pool.reserveArena("next-duel")).toBe(1);
  });

  it("has no retired rings, reservations or perimeter collision", () => {
    const pool = new ArenaPoolManager();
    const collision = new CollisionMatrix();
    pool.registerArenaWallCollision(collision);

    for (let id = 2; id <= 6; id++) {
      expect(pool.getArena(id)).toBeUndefined();
      expect(pool.getSpawnPoints(id)).toBeUndefined();
      expect(pool.reserveSpecificArena(id, "retired-owner")).toBe(false);
      const column = (id - 1) % 2;
      const row = Math.floor((id - 1) / 2);
      const minX = 340 + column * 24;
      const minZ = 394 + row * 28;
      for (let x = minX - 1; x <= minX + 21; x++) {
        expect(collision.hasFlags(x, minZ - 1, CollisionFlag.BLOCKED)).toBe(
          false,
        );
        expect(collision.hasFlags(x, minZ + 25, CollisionFlag.BLOCKED)).toBe(
          false,
        );
      }
      for (let z = minZ; z <= minZ + 24; z++) {
        expect(collision.hasFlags(minX - 1, z, CollisionFlag.BLOCKED)).toBe(
          false,
        );
        expect(collision.hasFlags(minX + 21, z, CollisionFlag.BLOCKED)).toBe(
          false,
        );
      }
    }
    expect(pool.reserveArena("ordinary-owner")).toBe(1);
    expect(pool.reserveArena("second-owner")).toBeNull();
    expect(pool.releaseSpecificArena(1, "ordinary-owner")).toBe(true);
    expect(pool.reserveArena("next-owner")).toBe(1);
  });

  it("closes every arena perimeter against cardinal and diagonal traversal", () => {
    const collision = new CollisionMatrix();
    const pool = new ArenaPoolManager();
    const config = getDuelArenaConfig();

    pool.registerArenaWallCollision(collision);

    expect(pool.totalArenas).toBe(config.arenaCount);
    for (const arenaId of pool.getAllArenaIds()) {
      const bounds = pool.getArenaBounds(arenaId)!;
      const minX = Math.round(bounds.min.x);
      const maxX = Math.round(bounds.max.x);
      const minZ = Math.round(bounds.min.z);
      const maxZ = Math.round(bounds.max.z);

      for (let x = minX - 1; x <= maxX + 1; x++) {
        expect(collision.hasFlags(x, minZ - 1, CollisionFlag.BLOCKED)).toBe(
          true,
        );
        expect(collision.hasFlags(x, maxZ + 1, CollisionFlag.BLOCKED)).toBe(
          true,
        );
      }
      for (let z = minZ; z <= maxZ; z++) {
        expect(collision.hasFlags(minX - 1, z, CollisionFlag.BLOCKED)).toBe(
          true,
        );
        expect(collision.hasFlags(maxX + 1, z, CollisionFlag.BLOCKED)).toBe(
          true,
        );
      }

      const centerX = Math.floor((minX + maxX) / 2);
      const centerZ = Math.floor((minZ + maxZ) / 2);
      expect(collision.isBlocked(minX, centerZ, minX - 1, centerZ)).toBe(true);
      expect(collision.isBlocked(maxX, centerZ, maxX + 1, centerZ)).toBe(true);
      expect(collision.isBlocked(centerX, minZ, centerX, minZ - 1)).toBe(true);
      expect(collision.isBlocked(centerX, maxZ, centerX, maxZ + 1)).toBe(true);
      expect(collision.isBlocked(minX, minZ, minX - 1, minZ - 1)).toBe(true);
      expect(collision.isBlocked(maxX, maxZ, maxX + 1, maxZ + 1)).toBe(true);
    }
  });

  it("fails closed when the collision matrix does not retain wall flags", () => {
    const collision = new CollisionMatrix();
    vi.spyOn(collision, "addFlags").mockImplementation(() => {});

    expect(() =>
      new ArenaPoolManager().registerArenaWallCollision(collision),
    ).toThrow(/Authoritative arena collision audit failed/);
  });
});
