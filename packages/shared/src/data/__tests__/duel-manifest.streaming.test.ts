import { describe, expect, it } from "vitest";
import {
  getCombatArenaBoundsContainingPositions,
  getDuelArenaConfig,
  getDuelArenaProtectionBounds,
  isPositionInsideDuelArenaLobby,
  isPositionInsideCombatArena,
  isPositionInsideDuelArenaZone,
} from "../duel-manifest";
import { ALL_WORLD_AREAS, type WorldArea } from "../world-areas";
import { resolveWorldSpawnPosition } from "../../runtime/WorldSpawnAdmission";
import { DataManager } from "../DataManager";
import { World } from "../../core/World";
import { ZoneDetectionSystem } from "../../systems/shared/death/ZoneDetectionSystem";

async function withFacilityAreas(
  run: () => void | Promise<void>,
): Promise<void> {
  const original = { ...ALL_WORLD_AREAS };
  const arena = original.duel_arena;
  ALL_WORLD_AREAS.duel_arena = {
    ...arena,
    duelProtection: "facility-floors-v1",
  };
  ALL_WORLD_AREAS.arena_grounds = {
    ...arena,
    id: "arena_grounds",
    name: "Arena Grounds",
    bounds: {
      ...arena.bounds,
      minX: arena.bounds.minX - 0.5,
      minZ: arena.bounds.minZ - 0.5,
    },
  };
  delete ALL_WORLD_AREAS.arena_grounds.duelProtection;
  ALL_WORLD_AREAS.haven_pond = {
    ...arena,
    id: "haven_pond",
    name: "Inland Pond",
    bounds: { minX: 377, maxX: 443, minZ: 382, maxZ: 448 },
  };
  delete ALL_WORLD_AREAS.haven_pond.duelProtection;
  try {
    await run();
  } finally {
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    Object.assign(ALL_WORLD_AREAS, original);
  }
}

describe("admitted facility protection and actual zone-cache ownership", () => {
  it("keeps an immutable union of the real floors and one-metre aprons, not its bounding rectangle", async () => {
    await withFacilityAreas(() => {
      const bounds = getDuelArenaProtectionBounds();
      expect(bounds).toEqual([
        { minX: 339, maxX: 361, minZ: 393, maxZ: 419 },
        { minX: 375, maxX: 395, minZ: 367, maxZ: 385 },
        { minX: 338, maxX: 352, minZ: 369, maxZ: 383 },
      ]);
      expect(getDuelArenaProtectionBounds()).toBe(bounds);
      expect(Object.isFrozen(bounds)).toBe(true);
      for (const b of bounds) {
        expect(Object.isFrozen(b)).toBe(true);
        const midX = (b.minX + b.maxX) / 2,
          midZ = (b.minZ + b.maxZ) / 2;
        for (const x of [b.minX, b.maxX]) {
          expect(isPositionInsideDuelArenaZone(x, midZ)).toBe(true);
          expect(
            isPositionInsideDuelArenaZone(
              x + (x === b.minX ? -0.001 : 0.001),
              midZ,
            ),
          ).toBe(false);
        }
        for (const z of [b.minZ, b.maxZ]) {
          expect(isPositionInsideDuelArenaZone(midX, z)).toBe(true);
          expect(
            isPositionInsideDuelArenaZone(
              midX,
              z + (z === b.minZ ? -0.001 : 0.001),
            ),
          ).toBe(false);
        }
      }
      for (const [x, z] of [
        [365, 390],
        [387, 419],
        [390, 424.5],
        [410, 415],
      ])
        expect(isPositionInsideDuelArenaZone(x, z)).toBe(false);
      expect(isPositionInsideDuelArenaZone(NaN, 376)).toBe(false);
      expect(isPositionInsideDuelArenaZone(385, Infinity)).toBe(false);
    });
  });

  it("admits challenges only on the actual lobby floor, excluding its apron, hospital and ring", async () => {
    await withFacilityAreas(() => {
      for (const x of [376, 385, 394])
        for (const z of [368, 376, 384])
          expect(isPositionInsideDuelArenaLobby(x, z)).toBe(true);
      for (const [x, z] of [
        [375.5, 376],
        [394.5, 376],
        [385, 367.5],
        [385, 384.5],
        [345, 376],
        [350, 406],
        [365, 390],
        [390, 424.5],
      ])
        expect(isPositionInsideDuelArenaLobby(x, z)).toBe(false);
    });
  });

  it("uses physical facility precedence over overlapping pond and never leaks through the same two-metre cache cell", async () => {
    await withFacilityAreas(async () => {
      const world = new World();
      const zone = world.register(
        "zone-detection",
        ZoneDetectionSystem,
      ) as ZoneDetectionSystem;
      try {
        await zone.init();
        for (let repeat = 0; repeat < 3; repeat++) {
          for (const [x, expected] of [
            [374.9, "arena_grounds"],
            [375.1, "duel_arena"],
            [394.9, "duel_arena"],
            [395.1, "arena_grounds"],
          ] as const)
            expect(zone.getZoneProperties({ x, z: 376 }).id).toBe(expected);
        }
        expect(zone.getZoneProperties({ x: 385, z: 383.5 }).id).toBe(
          "duel_arena",
        );
        expect(zone.getZoneProperties({ x: 390, z: 424.5 }).id).toBe(
          "haven_pond",
        );
        for (const [x, z, id] of [
          [365, 390, "arena_grounds"],
          [400, 348.5, "arena_grounds"],
          [316, 390, "arena_grounds"],
          [420, 400, "haven_pond"],
          [350, 433, "arena_grounds"],
        ] as const) {
          const props = zone.getZoneProperties({ x, z });
          expect(props.id).toBe(id);
          expect(props.isSafe).toBe(true);
          expect(props.isPvPEnabled).toBe(false);
          expect(isPositionInsideDuelArenaZone(x, z)).toBe(false);
        }
      } finally {
        world.destroy();
      }
    });
  });

  it.each([null, undefined, false, "broad", {}, { version: 1 }])(
    "rejects present malformed protection metadata %j",
    async (mode) => {
      await withFacilityAreas(() => {
        ALL_WORLD_AREAS.duel_arena = {
          ...ALL_WORLD_AREAS.duel_arena,
          duelProtection: mode,
        } as WorldArea;
        expect(() => getDuelArenaProtectionBounds()).toThrow("footprint mode");
      });
    },
  );

  it("rejects incomplete envelopes, reversed bounds, escaped facilities and mismatched identity", async () => {
    await withFacilityAreas(() => {
      const valid = ALL_WORLD_AREAS.duel_arena;
      const envelopes: Partial<WorldArea["bounds"]>[] = [
        {},
        { ...valid.bounds, minX: 350 },
        { ...valid.bounds, maxZ: 350 },
      ];
      for (const key of ["minX", "maxX", "minZ", "maxZ"] as const) {
        const missing: Partial<WorldArea["bounds"]> = { ...valid.bounds };
        delete missing[key];
        envelopes.push(missing);
      }
      for (const bounds of envelopes) {
        ALL_WORLD_AREAS.duel_arena = {
          ...valid,
          bounds,
          subZones: undefined,
        } as WorldArea;
        expect(() => getDuelArenaProtectionBounds()).toThrow();
      }
      ALL_WORLD_AREAS.duel_arena = { ...valid, id: "other" };
      expect(() => getDuelArenaProtectionBounds()).toThrow(
        "canonical area identity",
      );
    });
  });
});

function withSubZones(subZones: unknown, run: () => void): void {
  const original = ALL_WORLD_AREAS.duel_arena;
  ALL_WORLD_AREAS.duel_arena = {
    ...original,
    subZones: subZones as WorldArea["subZones"],
  };
  try {
    run();
  } finally {
    ALL_WORLD_AREAS.duel_arena = original;
  }
}

function validArena() {
  return {
    name: "Single arena",
    safeZone: true,
    bounds: { minX: 340, maxX: 360, minZ: 394, maxZ: 418 },
    arenaCount: 1,
    arenaLayout: "1x1",
    arenaSize: { width: 20, length: 24 },
    arenaGap: 4,
    spawnLayout: "alongLength",
  };
}

describe("streaming duel arena assignment", () => {
  it("keeps the canonical ring and lobby unchanged, without sharing mutable config state", () => {
    const config = getDuelArenaConfig();
    expect(config).toMatchObject({
      baseX: 340,
      baseZ: 394,
      arenaWidth: 20,
      arenaLength: 24,
      columns: 1,
      rows: 1,
      arenaCount: 1,
      spawnOffset: 8,
      lobbySpawnPoint: { x: 385, y: 0.42, z: 374 },
    });
    config.arenaCount = 6;
    config.lobbySpawnPoint.x = 0;
    expect(getDuelArenaConfig().arenaCount).toBe(1);
    expect(getDuelArenaConfig().lobbySpawnPoint.x).toBe(385);
  });

  it("admits a valid explicit single-ring override and canonical omitted layout/count defaults", () => {
    for (const arena of [
      validArena(),
      { ...validArena(), arenaCount: undefined, arenaLayout: undefined },
    ]) {
      withSubZones({ arenas: arena }, () => {
        expect(getDuelArenaConfig()).toMatchObject({
          columns: 1,
          rows: 1,
          arenaCount: 1,
        });
        expect(isPositionInsideCombatArena(350, 406)).toBe(true);
      });
    }
  });

  it("retains the complete hospital and lobby safe-zone footprints, not just the ring grid", () => {
    expect(ALL_WORLD_AREAS.duel_arena.bounds).toEqual({
      minX: 316,
      maxX: 420,
      minZ: 348.5,
      maxZ: 433,
    });
    for (const [minX, maxX, minZ, maxZ] of [
      [331, 359, 364.5, 387.5],
      [365, 405, 363.5, 388.5],
    ]) {
      for (const x of [minX, maxX])
        for (const z of [minZ, maxZ]) {
          expect(isPositionInsideDuelArenaZone(x, z)).toBe(true);
          expect(isPositionInsideCombatArena(x, z)).toBe(false);
        }
    }
    expect(isPositionInsideDuelArenaZone(350, 433.001)).toBe(false);
  });

  it.each([
    null,
    {},
    { arenas: null },
    { arenas: { ...validArena(), bounds: null } },
    ...[0, -1, 1.5, 2, 6, NaN, Infinity, null, "1"].map((arenaCount) => ({
      arenas: { ...validArena(), arenaCount },
    })),
    ...[
      "",
      "2x3",
      "0x1",
      "1x2",
      "x1x1",
      "1x1tail",
      "1.5x1",
      "1x1 ",
      null,
      1,
    ].map((arenaLayout) => ({
      arenas: { ...validArena(), arenaLayout },
    })),
    ...[
      null,
      { width: NaN, length: 24 },
      { width: 20, length: 16 },
      { width: 0, length: 24 },
    ].map((arenaSize) => ({
      arenas: { ...validArena(), arenaSize },
    })),
    ...[-1, NaN, Infinity, null].map((arenaGap) => ({
      arenas: { ...validArena(), arenaGap },
    })),
    ...["diagonal", null].map((spawnLayout) => ({
      arenas: { ...validArena(), spawnLayout },
    })),
    ...["minX", "maxX", "minZ", "maxZ"].map((key) => ({
      arenas: {
        ...validArena(),
        bounds: { ...validArena().bounds, [key]: NaN },
      },
    })),
    {
      arenas: {
        ...validArena(),
        bounds: { ...validArena().bounds, maxX: 384 },
      },
    },
    { arenas: validArena(), lobby: { spawnPoint: null } },
    { arenas: validArena(), lobby: null },
    {
      arenas: validArena(),
      lobby: { spawnPoint: { x: 405, y: 0.42, z: 374 } },
    },
    { arenas: validArena(), lobby: { spawnPoint: { x: 385, y: 0.42, z: 0 } } },
    {
      arenas: {
        ...validArena(),
        bounds: { minX: 1e308, maxX: 1e308, minZ: 394, maxZ: 418 },
      },
    },
    {
      arenas: validArena(),
      lobby: { spawnPoint: { x: 385, y: Infinity, z: 374 } },
    },
  ])(
    "rejects invalid explicit configuration without fallback or hidden rings (%j)",
    (subZones) => {
      withSubZones(subZones, () => {
        expect(() => getDuelArenaConfig()).toThrow(
          /Invalid duel arena configuration/,
        );
        expect(() => isPositionInsideCombatArena(350, 406)).toThrow(
          /Invalid duel arena configuration/,
        );
        expect(() =>
          getCombatArenaBoundsContainingPositions([[350, 0.42, 406]]),
        ).toThrow(/Invalid duel arena configuration/);
      });
    },
  );

  it("removes all five retired combat rings without discarding valid saved island coordinates", () => {
    const lobby = getDuelArenaConfig().lobbySpawnPoint;
    for (const [x, z] of [
      [374, 406],
      [350, 434],
      [374, 434],
      [350, 462],
      [374, 462],
    ]) {
      const position = [x, 28.82, z] as const;
      expect(isPositionInsideCombatArena(x, z)).toBe(false);
      expect(getCombatArenaBoundsContainingPositions([position])).toBeNull();
      expect(
        resolveWorldSpawnPosition(
          position,
          [lobby.x, lobby.y, lobby.z],
          DataManager.getWorldTerrainProfile(),
        ),
      ).toEqual({
        position: [...position],
        rehomed: false,
        reason: null,
      });
    }
    for (const [x, z] of [
      [340, 394],
      [360, 418],
      [350, 406],
    ]) {
      expect(isPositionInsideCombatArena(x, z)).toBe(true);
    }
    expect(isPositionInsideCombatArena(NaN, 406)).toBe(false);
    expect(isPositionInsideCombatArena(350, Infinity)).toBe(false);
  });

  it("binds both authoritative spawns to one exact combat ring", () => {
    const config = getDuelArenaConfig();
    const positions = [
      [config.baseX + 1, config.baseY, config.baseZ + 1],
      [config.baseX + 2, config.baseY, config.baseZ + 2],
    ] as const;

    expect(getCombatArenaBoundsContainingPositions(positions)).toEqual({
      minX: config.baseX,
      maxX: config.baseX + config.arenaWidth,
      minZ: config.baseZ,
      maxZ: config.baseZ + config.arenaLength,
    });
  });

  it("rejects missing positions or contestants in different rings", () => {
    const config = getDuelArenaConfig();
    const firstRing = [
      config.baseX + 1,
      config.baseY,
      config.baseZ + 1,
    ] as const;
    const secondRing = [
      config.baseX + config.arenaWidth + config.arenaGap + 1,
      config.baseY,
      config.baseZ + 1,
    ] as const;

    expect(
      getCombatArenaBoundsContainingPositions([firstRing, secondRing]),
    ).toBeNull();
    expect(getCombatArenaBoundsContainingPositions([])).toBeNull();
  });
});
