import { describe, expect, it } from "vitest";
import { CollisionMatrix, ZONE_SIZE } from "../CollisionMatrix";
import { CollisionFlag, CollisionMask } from "../CollisionFlags";
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

describe("real walkable deck collision ownership", () => {
  it("suppresses only base water/slope and accepts no rails without erasing blockers or occupancy", () => {
    const matrix = new CollisionMatrix();
    const terrain = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
    const preserved =
      CollisionFlag.BLOCKED |
      CollisionFlag.BLOCK_LOS |
      CollisionFlag.OCCUPIED_PLAYER |
      CollisionFlag.OCCUPIED_NPC |
      CollisionFlag.BRIDGE |
      CollisionFlag.DECORATION |
      CollisionFlag.WALL_NORTH;
    matrix.setFlags(-1, -1, terrain | preserved);
    const lease = matrix.acquireWalkableDeck([{ x: -1, z: -1 }], []);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease.tileCount).toBe(1);
    expect(matrix.getFlags(-1, -1)).toBe(preserved | CollisionFlag.DOCK);
    expect(matrix.hasFlags(-1, -1, terrain)).toBe(false);
    expect(matrix.isWalkable(-1, -1)).toBe(false);
    matrix.removeFlags(-1, -1, preserved);
    expect(matrix.getFlags(-1, -1)).toBe(CollisionFlag.DOCK);
    expect(matrix.isWalkable(-1, -1)).toBe(true);
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(matrix.getFlags(-1, -1)).toBe(terrain);
  });

  it("copies mutable inputs and reference-counts overlapping decks and each merged rail bit", () => {
    const matrix = new CollisionMatrix();
    const tiles = [{ x: 0, z: 0 }];
    const walls = [
      { x: 0, z: 0, flags: CollisionFlag.WALL_EAST },
      { x: 0, z: 0, flags: CollisionFlag.WALL_NORTH },
    ];
    matrix.setFlags(0, 0, CollisionFlag.WATER | CollisionFlag.WALL_SOUTH);
    const a = matrix.acquireWalkableDeck(tiles, walls);
    const b = matrix.acquireWalkableDeck(tiles, [
      {
        x: 0,
        z: 0,
        flags: CollisionFlag.WALL_EAST | CollisionFlag.WALL_NORTH_EAST,
      },
    ]);
    tiles[0].x = 10;
    walls[0].x = 20;
    expect(matrix.getFlags(0, 0)).toBe(
      CollisionFlag.DOCK |
        CollisionFlag.WALL_EAST |
        CollisionFlag.WALL_NORTH |
        CollisionFlag.WALL_NORTH_EAST |
        CollisionFlag.WALL_SOUTH,
    );
    expect(matrix.getFlags(10, 0)).toBe(0);
    expect(matrix.isBlocked(1, -1, 0, 0)).toBe(true);
    a.release();
    expect(matrix.getFlags(0, 0)).toBe(
      CollisionFlag.DOCK |
        CollisionFlag.WALL_EAST |
        CollisionFlag.WALL_NORTH_EAST |
        CollisionFlag.WALL_SOUTH,
    );
    expect(matrix.isBlocked(1, -1, 0, 0)).toBe(true);
    b.release();
    expect(matrix.getFlags(0, 0)).toBe(
      CollisionFlag.WATER | CollisionFlag.WALL_SOUTH,
    );
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    "keeps shared placeholder zones until both footprint and deck release (static-first=%s, release-static-first=%s)",
    (staticFirst, releaseStaticFirst) => {
      const matrix = new CollisionMatrix();
      const tile = [{ x: -8, z: 8 }];
      const staticLease = staticFirst
        ? matrix.acquireStaticFootprint(tile)
        : undefined;
      const deck = matrix.acquireWalkableDeck(tile, [
        { x: -8, z: 8, flags: CollisionFlag.WALL_WEST },
      ]);
      const footprint = staticLease ?? matrix.acquireStaticFootprint(tile);
      expect(matrix.getZoneCount()).toBe(1);
      expect(matrix.getFlags(-8, 8)).toBe(
        CollisionFlag.BLOCKED | CollisionFlag.DOCK | CollisionFlag.WALL_WEST,
      );
      if (releaseStaticFirst) {
        footprint.release();
        expect(matrix.getFlags(-8, 8)).toBe(
          CollisionFlag.DOCK | CollisionFlag.WALL_WEST,
        );
        expect(matrix.getZoneCount()).toBe(1);
        deck.release();
      } else {
        deck.release();
        expect(matrix.getFlags(-8, 8)).toBe(CollisionFlag.BLOCKED);
        expect(matrix.getZoneCount()).toBe(1);
        footprint.release();
      }
      expect(matrix.getZoneCount()).toBe(0);
      expect(matrix.getFlags(-8, 8)).toBe(0);
    },
  );

  it("retains current terrain rebakes and network writes, exports combined flags, and does not alias synthesized arrays", () => {
    const matrix = new CollisionMatrix();
    const tiles = [
      { x: -1, z: -1 },
      { x: 0, z: 0 },
      { x: 8, z: -8 },
    ];
    const deck = matrix.acquireWalkableDeck(tiles, [
      { x: -1, z: -1, flags: CollisionFlag.WALL_NORTH },
    ]);
    const footprint = matrix.acquireStaticFootprint([{ x: -1, z: -1 }]);
    const terrainMask = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
    for (const { x, z } of tiles) {
      matrix.replaceFlagsInRegion(x, z, 1, 1, terrainMask, [terrainMask]);
      matrix.addFlags(x, z, CollisionFlag.DECORATION);
    }
    expect(matrix.getFlags(0, 0)).toBe(
      CollisionFlag.DOCK | CollisionFlag.DECORATION,
    );
    const network = new Int32Array(64);
    network[63] =
      CollisionFlag.STEEP_SLOPE |
      CollisionFlag.OCCUPIED_NPC |
      CollisionFlag.WALL_EAST;
    matrix.setZoneData(-1, -1, network);
    const expected =
      CollisionFlag.DOCK |
      CollisionFlag.BLOCKED |
      CollisionFlag.OCCUPIED_NPC |
      CollisionFlag.WALL_NORTH |
      CollisionFlag.WALL_EAST;
    expect(matrix.getFlags(-1, -1)).toBe(expected);
    const exported = matrix.getZoneData(-1, -1)!;
    expect(exported[63]).toBe(expected);
    network[63] = 0;
    exported[63] = 0;
    expect(matrix.getFlags(-1, -1)).toBe(expected);
    const remote = new CollisionMatrix();
    remote.applyNetworkZones(
      matrix.getZoneKeys().map(({ zoneX, zoneZ }) => ({
        zoneX,
        zoneZ,
        base64Data: matrix.serializeZone(zoneX, zoneZ)!,
      })),
    );
    expect(remote.getFlags(-1, -1)).toBe(expected);
    expect(
      matrix
        .getZonesInRadius(0, 0, 16)
        .find((zone) => zone.zoneX === -1 && zone.zoneZ === -1)!.data[63],
    ).toBe(expected);
    deck.release();
    expect(matrix.getFlags(-1, -1)).toBe(
      CollisionFlag.BLOCKED |
        CollisionFlag.STEEP_SLOPE |
        CollisionFlag.OCCUPIED_NPC |
        CollisionFlag.WALL_EAST,
    );
    footprint.release();
    expect(matrix.getFlags(-1, -1)).toBe(
      CollisionFlag.STEEP_SLOPE |
        CollisionFlag.OCCUPIED_NPC |
        CollisionFlag.WALL_EAST,
    );
    expect(matrix.getFlags(0, 0)).toBe(terrainMask | CollisionFlag.DECORATION);
    expect(remote.getFlags(-1, -1)).toBe(expected);
    remote.deserializeZone(-1, -1, matrix.serializeZone(-1, -1)!);
    expect(remote.getFlags(-1, -1)).toBe(matrix.getFlags(-1, -1));
  });

  it("preserves a base-owned DOCK/wall and observes latest base clear while overlapping leases remain", () => {
    const matrix = new CollisionMatrix();
    const tile = [{ x: 1, z: 1 }];
    matrix.setFlags(
      1,
      1,
      CollisionFlag.DOCK | CollisionFlag.WALL_EAST | CollisionFlag.WATER,
    );
    const a = matrix.acquireWalkableDeck(tile, [
      { x: 1, z: 1, flags: CollisionFlag.WALL_EAST },
    ]);
    a.release();
    expect(matrix.getFlags(1, 1)).toBe(
      CollisionFlag.DOCK | CollisionFlag.WALL_EAST | CollisionFlag.WATER,
    );
    const b = matrix.acquireWalkableDeck(tile, []),
      c = matrix.acquireWalkableDeck(tile, []);
    matrix.setZoneData(0, 0, new Int32Array(64));
    b.release();
    expect(matrix.getFlags(1, 1)).toBe(CollisionFlag.DOCK);
    c.release();
    expect(matrix.getFlags(1, 1)).toBe(0);
  });

  it("makes both kinds of old lease inert after clear and refreshes signed-zone caches", () => {
    const matrix = new CollisionMatrix();
    const tile = [{ x: -1, z: -1 }];
    const oldDeck = matrix.acquireWalkableDeck(tile, [
      { x: 8, z: -8, flags: CollisionFlag.WALL_SOUTH },
    ]);
    const oldStatic = matrix.acquireStaticFootprint(tile);
    expect(matrix.getFlags(-1, -1)).toBe(
      CollisionFlag.DOCK | CollisionFlag.BLOCKED,
    );
    matrix.clear();
    const deck = matrix.acquireWalkableDeck(tile, []);
    expect(oldDeck.release()).toBe(false);
    expect(oldStatic.release()).toBe(false);
    expect(matrix.getFlags(-1, -1)).toBe(CollisionFlag.DOCK);
    expect(matrix.getFlags(8, -8)).toBe(0);
    deck.release();
    expect(matrix.getFlags(-1, -1)).toBe(0);
    expect(matrix.getZoneCount()).toBe(0);
  });

  it("routes actual BFS through the land entry but not rails or diagonal corners across negative zones", () => {
    const matrix = new CollisionMatrix();
    matrix.replaceFlagsInRegion(
      -14,
      -6,
      14,
      13,
      CollisionFlag.WATER,
      new Int32Array(14 * 13).fill(CollisionFlag.WATER),
    );
    const tiles: { x: number; z: number }[] = [];
    const walls: { x: number; z: number; flags: number }[] = [];
    for (let x = -10; x <= -5; x++) {
      for (let z = -1; z <= 1; z++) tiles.push({ x, z });
      walls.push(
        { x, z: -1, flags: CollisionFlag.WALL_NORTH },
        { x, z: -2, flags: CollisionFlag.WALL_SOUTH },
        { x, z: 1, flags: CollisionFlag.WALL_SOUTH },
        { x, z: 2, flags: CollisionFlag.WALL_NORTH },
      );
    }
    for (let z = -1; z <= 1; z++)
      walls.push(
        { x: -5, z, flags: CollisionFlag.WALL_EAST },
        { x: -4, z, flags: CollisionFlag.WALL_WEST },
      );
    for (let x = -12; x <= -11; x++)
      for (let z = -1; z <= 1; z++) matrix.setFlags(x, z, 0);
    const deck = matrix.acquireWalkableDeck(tiles, walls);
    expect(matrix.isBlocked(-11, 0, -10, 0)).toBe(false);
    expect(matrix.isBlocked(-10, 0, -11, 0)).toBe(false);
    // Remove water outside one rail to prove the WALL, not water, blocks it.
    matrix.setFlags(-8, -2, 0);
    matrix.setFlags(-7, -2, 0);
    expect(matrix.isBlocked(-8, -1, -8, -2)).toBe(true);
    expect(matrix.isBlocked(-8, -2, -8, -1)).toBe(true);
    expect(matrix.isBlocked(-8, -1, -7, -2)).toBe(true);
    const start = { x: -12, z: 0 },
      target = { x: -5, z: 0 };
    const bfs = new BFSPathfinder();
    const path = bfs.findPath(
      start,
      target,
      (tile, from) =>
        tile.x >= -14 &&
        tile.x <= -1 &&
        Math.abs(tile.z) <= 6 &&
        matrix.isWalkable(tile.x, tile.z) &&
        (!from || !matrix.isBlocked(from.x, from.z, tile.x, tile.z)),
    );
    expect(path.at(-1)).toEqual(target);
    expect(bfs.wasLastPathPartial()).toBe(false);
    let from = start;
    for (const to of path) {
      expect(matrix.isBlocked(from.x, from.z, to.x, to.z)).toBe(false);
      from = to;
    }
    deck.release();
    expect(matrix.isWalkable(target.x, target.z)).toBe(false);
    expect(matrix.getFlags(-8, -2)).toBe(0);
  });

  it("rejects malformed/adversarial input atomically without invoking accessors", () => {
    const matrix = new CollisionMatrix();
    const valid = [{ x: 0, z: 0 }];
    let reads = 0;
    const getterRow = Object.defineProperty({ z: 0 }, "x", {
      enumerable: true,
      get() {
        reads++;
        return 0;
      },
    });
    const getterArray = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        reads++;
        return { x: 0, z: 0 };
      },
    });
    const inherited = Object.create({ x: 0 });
    inherited.z = 0;
    const hidden = Object.defineProperty({ z: 0 }, "x", { value: 0 });
    const badTiles: unknown[] = [
      [],
      new Array(1),
      getterArray,
      [getterRow],
      [inherited],
      [hidden],
      [{ x: 0, z: 0, extra: 1 }],
      [{ x: 0, z: 0, [Symbol("extra")]: 1 }],
      [{ x: 0.5, z: 0 }],
      [{ x: NaN, z: 0 }],
      [{ x: 0, z: Infinity }],
      [{ x: 2147483648, z: 0 }],
      [{ x: 0, z: -2147483649 }],
      [valid[0], valid[0]],
      Array.from({ length: 4097 }, (_, x) => ({ x, z: 0 })),
    ];
    for (const tiles of badTiles) {
      expect(() =>
        matrix.acquireWalkableDeck(tiles as { x: number; z: number }[], []),
      ).toThrow();
      expect(matrix.getZoneCount()).toBe(0);
    }
    const badWalls: unknown[] = [
      new Array(1),
      [{ x: 0, z: 0, flags: 0 }],
      ...[
        NaN,
        Infinity,
        -1,
        0.5,
        2 ** 32 + CollisionFlag.WALL_NORTH,
        CollisionFlag.DOCK,
        CollisionFlag.WATER,
        CollisionFlag.BLOCKED,
        CollisionFlag.WALL_NORTH | CollisionFlag.OCCUPIED_NPC,
      ].map((flags) => [{ x: 0, z: 0, flags }]),
      [{ x: 0, z: 0, flags: CollisionFlag.WALL_EAST, extra: true }],
      [
        Object.defineProperty({ x: 0, z: 0 }, "flags", {
          enumerable: true,
          get() {
            reads++;
            return CollisionFlag.WALL_NORTH;
          },
        }),
      ],
      Array.from({ length: 4097 }, (_, x) => ({
        x,
        z: 0,
        flags: CollisionFlag.WALL_NORTH,
      })),
    ];
    for (const walls of badWalls) {
      expect(() =>
        matrix.acquireWalkableDeck(
          valid,
          walls as { x: number; z: number; flags: number }[],
        ),
      ).toThrow();
      expect(matrix.getZoneCount()).toBe(0);
    }
    expect(reads).toBe(0);
    expect(matrix.getFlags(0, 0)).toBe(0);
    const nullRow = Object.assign(
      Object.create(null) as { x: number; z: number },
      { x: 0, z: 0 },
    );
    const allowed = matrix.acquireWalkableDeck(
      Object.freeze([Object.freeze(nullRow)]),
      [],
    );
    allowed.release();
    expect(matrix.getZoneCount()).toBe(0);
  });

  it("bounds owners and rows without overflowing overlap counters or leaking allocations", () => {
    const matrix = new CollisionMatrix();
    const tiles = Array.from({ length: 4096 }, (_, x) => ({ x, z: 0 }));
    const large = matrix.acquireWalkableDeck(
      tiles,
      tiles.map((tile) => ({ ...tile, flags: CollisionMask.WALLS })),
    );
    expect(large.tileCount).toBe(4096);
    expect(matrix.getFlags(4095, 0)).toBe(
      CollisionFlag.DOCK | CollisionMask.WALLS,
    );
    large.release();
    expect(matrix.getZoneCount()).toBe(0);
    const leases = Array.from({ length: 1024 }, () =>
      matrix.acquireWalkableDeck(
        [{ x: 0, z: 0 }],
        [{ x: 0, z: 0, flags: CollisionMask.WALLS }],
      ),
    );
    expect(() => matrix.acquireWalkableDeck([{ x: 100, z: 100 }], [])).toThrow(
      "owner limit",
    );
    expect(matrix.getZoneCount()).toBe(1);
    for (const lease of leases.slice(0, -1)) lease.release();
    expect(matrix.getFlags(0, 0)).toBe(
      CollisionFlag.DOCK | CollisionMask.WALLS,
    );
    leases.at(-1)!.release();
    expect(matrix.getZoneCount()).toBe(0);
  });
});
