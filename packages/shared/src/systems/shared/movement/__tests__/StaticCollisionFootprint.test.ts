import { describe, expect, it } from "vitest";
import { CollisionMatrix, ZONE_SIZE } from "../CollisionMatrix";
import { CollisionFlag } from "../CollisionFlags";
import { BFSPathfinder } from "../BFSPathfinder";

describe("real static scenery collision ownership", () => {
  it("blocks cardinal and diagonal traversal and releases only its own contribution", () => {
    const matrix = new CollisionMatrix();
    const a = matrix.acquireStaticFootprint([
      { x: 0, z: 0 },
      { x: 1, z: 1 },
    ]);
    const b = matrix.acquireStaticFootprint([{ x: 0, z: 0 }]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.tileCount).toBe(2);
    expect(matrix.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
    expect(matrix.isWalkable(0, 0)).toBe(false);
    expect(matrix.isBlocked(-1, 0, 0, 0)).toBe(true);
    expect(matrix.isBlocked(0, 1, 1, 0)).toBe(true);
    matrix.addFlags(1, 1, CollisionFlag.WATER);
    expect(a.release()).toBe(true);
    expect(a.release()).toBe(false);
    expect(matrix.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
    expect(matrix.getFlags(1, 1)).toBe(CollisionFlag.WATER);
    expect(b.release()).toBe(true);
    expect(matrix.getFlags(0, 0)).toBe(0);
    expect(matrix.getFlags(1, 1)).toBe(CollisionFlag.WATER);
  });

  it("preserves both earlier and later base-object flags through every write path", () => {
    const matrix = new CollisionMatrix();
    matrix.addFlags(1, 2, CollisionFlag.BLOCKED);
    const lease = matrix.acquireStaticFootprint([{ x: 1, z: 2 }]);
    matrix.removeFlags(1, 2, CollisionFlag.BLOCKED);
    expect(matrix.getFlags(1, 2)).toBe(CollisionFlag.BLOCKED);
    matrix.setFlags(1, 2, CollisionFlag.WALL_EAST);
    expect(matrix.getFlags(1, 2)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WALL_EAST,
    );
    matrix.replaceFlagsInRegion(
      1,
      2,
      1,
      1,
      CollisionFlag.BLOCKED | CollisionFlag.WATER,
      [CollisionFlag.WATER],
    );
    expect(matrix.getFlags(1, 2)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WATER | CollisionFlag.WALL_EAST,
    );
    matrix.addFlags(1, 2, CollisionFlag.BLOCKED);
    lease.release();
    expect(matrix.getFlags(1, 2)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WATER | CollisionFlag.WALL_EAST,
    );
  });

  it("refreshes cached zones and isolates caller mutation across signed zone boundaries", () => {
    const matrix = new CollisionMatrix();
    const tiles = [
      { x: -1, z: -1 },
      { x: -8, z: 8 },
      { x: 8, z: -8 },
      { x: 0, z: 0 },
    ];
    expect(matrix.getFlags(0, 0)).toBe(0);
    const lease = matrix.acquireStaticFootprint(tiles);
    tiles[3].x = 90;
    for (const tile of [{ x: 0, z: 0 }, ...tiles.slice(0, 3)]) {
      for (let i = 0; i < 3; i++) {
        expect(matrix.getFlags(tile.x, tile.z)).toBe(CollisionFlag.BLOCKED);
        expect(matrix.hasFlags(tile.x, tile.z, CollisionFlag.BLOCKED)).toBe(
          true,
        );
      }
    }
    expect(matrix.getZoneCount()).toBe(4);
    expect(matrix.getZonesInRadius(0, 0, 16)).toHaveLength(4);
    lease.release();
    expect(matrix.getFlags(0, 0)).toBe(0);
    expect(matrix.getZoneCount()).toBe(0);
  });

  it("exports combined flags without baking local leases into the base or aliasing synthesized data", () => {
    const matrix = new CollisionMatrix();
    const lease = matrix.acquireStaticFootprint([{ x: 3, z: 4 }]);
    const network = new Int32Array(ZONE_SIZE * ZONE_SIZE);
    network[3 + 4 * ZONE_SIZE] = CollisionFlag.WATER;
    matrix.setZoneData(0, 0, network);
    const exported = matrix.getZoneData(0, 0)!;
    expect(exported[35]).toBe(CollisionFlag.BLOCKED | CollisionFlag.WATER);
    exported[35] = 0;
    network[35] = 0;
    expect(matrix.getFlags(3, 4)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WATER,
    );
    const remote = new CollisionMatrix();
    expect(remote.deserializeZone(0, 0, matrix.serializeZone(0, 0)!)).toBe(
      true,
    );
    expect(remote.getFlags(3, 4)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WATER,
    );
    lease.release();
    expect(matrix.getFlags(3, 4)).toBe(CollisionFlag.WATER);
    expect(remote.getFlags(3, 4)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.WATER,
    );
    remote.deserializeZone(0, 0, matrix.serializeZone(0, 0)!);
    expect(remote.getFlags(3, 4)).toBe(CollisionFlag.WATER);
  });

  it("makes old releases inert after a full clear and allows an independent new owner", () => {
    const matrix = new CollisionMatrix();
    const old = matrix.acquireStaticFootprint([{ x: 4, z: 4 }]);
    matrix.clear();
    const current = matrix.acquireStaticFootprint([{ x: 4, z: 4 }]);
    expect(old.release()).toBe(false);
    expect(matrix.getFlags(4, 4)).toBe(CollisionFlag.BLOCKED);
    expect(current.release()).toBe(true);
    expect(matrix.getZoneCount()).toBe(0);
  });

  it("rejects malformed or oversized footprints atomically before allocation", () => {
    const matrix = new CollisionMatrix();
    for (const tiles of [
      [],
      [
        { x: 0, z: 0 },
        { x: NaN, z: 0 },
      ],
      [{ x: 0.5, z: 0 }],
      [
        { x: 0, z: 0 },
        { x: 0, z: 0 },
      ],
      [{ x: 2147483648, z: 0 }],
      Array.from({ length: 4097 }, (_, x) => ({ x, z: 0 })),
    ]) {
      expect(() => matrix.acquireStaticFootprint(tiles)).toThrow();
      expect(matrix.getZoneCount()).toBe(0);
    }
  });

  it("caps owners before typed counters could overflow and releases all allocations", () => {
    const matrix = new CollisionMatrix();
    const leases = Array.from({ length: 1024 }, () =>
      matrix.acquireStaticFootprint([{ x: 1, z: 1 }]),
    );
    expect(() => matrix.acquireStaticFootprint([{ x: 20, z: 20 }])).toThrow();
    expect(matrix.getZoneCount()).toBe(1);
    for (const lease of leases.slice(0, -1)) lease.release();
    expect(matrix.isWalkable(1, 1)).toBe(false);
    leases.at(-1)!.release();
    expect(matrix.getZoneCount()).toBe(0);
  });

  it("routes actual BFS around solid posts with no diagonal corner cutting", () => {
    const matrix = new CollisionMatrix();
    const lease = matrix.acquireStaticFootprint([
      { x: 2, z: 0 },
      { x: 2, z: 1 },
    ]);
    const start = { x: 0, z: 0 },
      target = { x: 4, z: 0 };
    const route = new BFSPathfinder().findPath(
      start,
      target,
      (tile, from) =>
        Math.abs(tile.x) < 10 &&
        Math.abs(tile.z) < 10 &&
        matrix.isWalkable(tile.x, tile.z) &&
        (!from || !matrix.isBlocked(from.x, from.z, tile.x, tile.z)),
    );
    expect(route.at(-1)).toEqual(target);
    let cursor = start;
    for (const tile of route) {
      expect(matrix.isBlocked(cursor.x, cursor.z, tile.x, tile.z)).toBe(false);
      cursor = tile;
    }
    expect(route.some((tile) => tile.z !== 0)).toBe(true);
    lease.release();
  });
});
