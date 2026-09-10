import { createHash } from "node:crypto";

import {
  AttackType,
  CollisionFlag,
  CollisionMatrix,
  THREE,
  TILES_PER_TICK_RUN,
  type FoodConsumptionReceipt,
} from "@hyperforge/shared";
import { describe, expect, it, vi } from "vitest";

import type { EmbeddedGameState } from "../../eliza/types.js";
import { ArenaPoolManager } from "../../systems/DuelSystem/ArenaPoolManager.js";
import { TileMovementManager } from "../../systems/ServerNetwork/tile-movement.js";
import type { CompetitiveTacticalStrategy } from "../../systems/StreamingDuelScheduler/competitive-tactical-strategy.js";
import { DuelCombatAI } from "../DuelCombatAI.js";

const TICK_MS = 600;
const SCENARIO_TICKS = 72;

type FighterId = "fighter-a" | "fighter-b";
type ArenaRole = "melee" | "ranged" | "mage";

type ArenaEntity = {
  id: FighterId;
  position: THREE.Vector3;
  node: THREE.Object3D;
  data: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    arenaBounds: {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    };
    duelAiControlsMovement: true;
    isEmbeddedAgent: true;
    tileMovementActive?: boolean;
  };
};

type ArenaScenarioResult = {
  traceHash: string;
  packetHash: string;
  movementDirections: string[];
  maximumChebyshevStep: number;
  minimumSeparation: number;
  maximumSeparation: number;
  wallBandVisits: number;
  startPackets: number;
  tileUpdates: number;
  fighterAStats: ReturnType<DuelCombatAI["getStats"]>;
  fighterBStats: ReturnType<DuelCombatAI["getStats"]>;
};

const strategy = (
  role: ArenaRole,
  tacticalMacro: "pressure" | "orbit",
): CompetitiveTacticalStrategy => ({
  approach: tacticalMacro === "pressure" ? "aggressive" : "balanced",
  tacticalMacro,
  attackStyle: role === "melee" ? "aggressive" : "accurate",
  prayer:
    role === "ranged"
      ? "hawk_eye"
      : role === "mage"
        ? "mystic_lore"
        : "superhuman_strength",
  preferredCombatRole: null,
  foodThreshold: 40,
  switchDefensiveAt: 30,
  reasoning: `Deterministic ${role} arena movement integration policy.`,
});

const finiteRound = (value: number): number =>
  Math.round(value * 1_000) / 1_000;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function runArenaScenario(
  roles: readonly [ArenaRole, ArenaRole] = ["ranged", "melee"],
): Promise<ArenaScenarioResult> {
  const collision = new CollisionMatrix();
  const arenaPool = new ArenaPoolManager();
  arenaPool.registerArenaWallCollision(collision);
  const arenaId = arenaPool.getAllArenaIds()[0];
  const bounds = arenaPool.getArenaBounds(arenaId);
  if (!bounds) throw new Error("duel arena bounds are unavailable");

  const arenaBounds = {
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
  };
  const createEntity = (
    id: FighterId,
    x: number,
    z: number,
    y = 0,
  ): ArenaEntity => ({
    id,
    position: new THREE.Vector3(x, y, z),
    node: new THREE.Object3D(),
    data: {
      position: [x, y, z],
      quaternion: [0, 0, 0, 1],
      arenaBounds,
      duelAiControlsMovement: true,
      isEmbeddedAgent: true,
    },
  });

  const sameStyle = roles[0] === roles[1];
  const sameStyleMelee = sameStyle && roles[0] === "melee";
  const centerX = Math.round((arenaBounds.minX + arenaBounds.maxX) * 0.5);
  const centerZ = Math.round((arenaBounds.minZ + arenaBounds.maxZ) * 0.5);
  // The mixed pair begins diagonally near a corner to exercise wall recovery.
  // Same-style pairs use the production arena's 1.3-unit spawn separation and
  // half-tile alignment so spacing and footwork must survive real rounding and
  // collision arbitration instead of only a convenient integer-grid layout.
  const fighterA = createEntity(
    "fighter-a",
    sameStyle ? centerX + 0.5 : arenaBounds.minX + 3.5,
    sameStyle ? centerZ - 0.65 : arenaBounds.minZ + 3.5,
    sameStyle ? 23.831899122339173 : 0,
  );
  const fighterB = createEntity(
    "fighter-b",
    sameStyle ? centerX + 0.5 : arenaBounds.minX + 7.5,
    sameStyle ? centerZ + 0.65 : arenaBounds.minZ + 7.5,
    sameStyle ? 23.80591889570453 : 0,
  );
  const entities = new Map<FighterId, ArenaEntity>([
    [fighterA.id, fighterA],
    [fighterB.id, fighterB],
  ]);
  const packets: Array<{ name: string; data: unknown }> = [];
  const world = {
    entities: {
      get: (id: string) => entities.get(id as FighterId) ?? null,
      players: entities,
    },
    collision,
    getSystem: () => null,
    emit: vi.fn(),
    faceDirectionManager: { markPlayerMoved: vi.fn() },
  };
  const movement = new TileMovementManager(world as never, (name, data) => {
    packets.push({ name, data });
  });
  movement.syncPlayerPosition(fighterA.id, fighterA.position);
  movement.syncPlayerPosition(fighterB.id, fighterB.position);

  let currentTick = 0;
  let now = 10_000;
  const combatState = new Map<FighterId, boolean>([
    [fighterA.id, false],
    [fighterB.id, false],
  ]);
  const activePrayers = new Map<FighterId, string[]>([
    [fighterA.id, []],
    [fighterB.id, []],
  ]);

  const distance = (left: ArenaEntity, right: ArenaEntity): number =>
    Math.hypot(
      right.position.x - left.position.x,
      right.position.z - left.position.z,
    );

  const createService = (
    own: ArenaEntity,
    opponent: ArenaEntity,
    role: ArenaRole,
    opponentRole: ArenaRole,
  ) => ({
    getGameState: (): EmbeddedGameState => ({
      playerId: own.id,
      position: [own.position.x, own.position.y, own.position.z],
      health: 100,
      maxHealth: 100,
      alive: true,
      skills: {},
      inventory: [],
      equipment: {
        weapon: {
          itemId:
            role === "ranged"
              ? "shortbow"
              : role === "mage"
                ? "staff_of_air"
                : "bronze_longsword",
          quantity: 1,
        },
      },
      nearbyEntities: [
        {
          id: opponent.id,
          name: opponent.id,
          type: "player",
          position: [
            opponent.position.x,
            opponent.position.y,
            opponent.position.z,
          ],
          distance: distance(own, opponent),
          health: 100,
          maxHealth: 100,
          equippedWeapon:
            opponentRole === "ranged"
              ? "shortbow"
              : opponentRole === "mage"
                ? "staff_of_air"
                : "bronze_longsword",
        },
      ],
      inCombat: combatState.get(own.id) === true,
      currentTarget: combatState.get(own.id) === true ? opponent.id : null,
      activePrayers: activePrayers.get(own.id) ?? [],
      prayerPointUnits: 100_000_000,
      prayerPoints: 100,
      prayerMaxPoints: 100,
    }),
    getWeaponAttackRange: (): number =>
      role === "ranged" || role === "mage" ? 7 : sameStyleMelee ? 1 : 2.2,
    getLiveEntityPosition: (entityId: string) =>
      entityId === opponent.id
        ? ([opponent.position.x, opponent.position.y, opponent.position.z] as [
            number,
            number,
            number,
          ])
        : null,
    executeUse: async (itemId: string): Promise<FoodConsumptionReceipt> => ({
      ok: false,
      committed: false,
      consumed: false,
      playerId: own.id,
      itemId,
      operationId: `arena-food-disabled:${own.id}:${currentTick}`,
      replayed: false,
      healedAmount: 0,
      newHealth: 100,
      reason: "item_not_owned",
    }),
    executeAttack: async (targetId: string): Promise<boolean> => {
      if (targetId !== opponent.id) {
        throw new Error("arena integration AI attacked a foreign target");
      }
      combatState.set(own.id, true);
      return true;
    },
    executeMove: async (
      target: [number, number, number],
      runMode: boolean,
    ): Promise<boolean> => {
      movement.movePlayerToward(
        own.id,
        { x: target[0], y: target[1], z: target[2] },
        runMode,
      );
      return true;
    },
    executeCombatApproach: (targetId: string): boolean => {
      if (targetId !== opponent.id) return false;
      movement.movePlayerToward(
        own.id,
        opponent.position,
        true,
        sameStyleMelee ? 1 : 2.2,
        AttackType.MELEE,
      );
      return true;
    },
    getMovementDebugState: () => movement.getPlayerMovementDebug(own.id),
    executeChangeStyle: async (): Promise<boolean> => true,
    executePrayerToggle: async (prayerId: string) => {
      const current = new Set(activePrayers.get(own.id) ?? []);
      if (current.has(prayerId)) current.delete(prayerId);
      else current.add(prayerId);
      const next = [...current].sort();
      activePrayers.set(own.id, next);
      return {
        success: true,
        committed: true,
        playerId: own.id,
        operationId: `arena-prayer:${own.id}:${currentTick}:${prayerId}`,
        replayed: false,
        pointUnits: 100_000_000,
        points: 100,
        maxPoints: 100,
        activePrayers: next,
      };
    },
  });

  const fighterAAi = new DuelCombatAI(
    createService(fighterA, fighterB, roles[0], roles[1]) as never,
    fighterB.id,
    {
      combatRole: roles[0],
      opponentCombatRole: roles[1],
      noFood: true,
      tacticalStrategy: strategy(
        roles[0],
        roles[0] === "melee" ? "pressure" : "orbit",
      ),
      initialStrafeSign: 1,
      movementClampBounds: arenaBounds,
    },
  );
  const fighterBAi = new DuelCombatAI(
    createService(fighterB, fighterA, roles[1], roles[0]) as never,
    fighterA.id,
    {
      combatRole: roles[1],
      opponentCombatRole: roles[0],
      noFood: true,
      tacticalStrategy: strategy(
        roles[1],
        roles[1] === "melee" ? "pressure" : "orbit",
      ),
      initialStrafeSign: -1,
      movementClampBounds: arenaBounds,
    },
  );

  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => now;
  Math.random = () => 0.5;
  const trace: unknown[] = [];
  const directionSet = new Set<string>();
  let maximumChebyshevStep = 0;
  let minimumSeparation = Number.POSITIVE_INFINITY;
  let maximumSeparation = 0;
  let wallBandVisits = 0;

  try {
    fighterAAi.start();
    fighterBAi.start();
    for (currentTick = 1; currentTick <= SCENARIO_TICKS; currentTick++) {
      const before = new Map(
        [...entities].map(([id, entity]) => [
          id,
          { x: entity.position.x, z: entity.position.z },
        ]),
      );
      await fighterAAi.externalTick();
      await fighterBAi.externalTick();
      movement.processPlayerTick(fighterA.id, currentTick);
      movement.processPlayerTick(fighterB.id, currentTick);

      for (const [id, entity] of entities) {
        const prior = before.get(id)!;
        const dx = Math.round(entity.position.x - prior.x);
        const dz = Math.round(entity.position.z - prior.z);
        maximumChebyshevStep = Math.max(
          maximumChebyshevStep,
          Math.abs(dx),
          Math.abs(dz),
        );
        if (dx !== 0 || dz !== 0) {
          directionSet.add(`${Math.sign(dx)},${Math.sign(dz)}`);
        }
        expect(entity.position.x).toBeGreaterThanOrEqual(arenaBounds.minX);
        expect(entity.position.x).toBeLessThanOrEqual(arenaBounds.maxX);
        expect(entity.position.z).toBeGreaterThanOrEqual(arenaBounds.minZ);
        expect(entity.position.z).toBeLessThanOrEqual(arenaBounds.maxZ);
        const wallDistance = Math.min(
          entity.position.x - arenaBounds.minX,
          arenaBounds.maxX - entity.position.x,
          entity.position.z - arenaBounds.minZ,
          arenaBounds.maxZ - entity.position.z,
        );
        if (wallDistance <= 3.5) wallBandVisits++;
      }

      const separation = distance(fighterA, fighterB);
      minimumSeparation = Math.min(minimumSeparation, separation);
      maximumSeparation = Math.max(maximumSeparation, separation);
      trace.push({
        tick: currentTick,
        a: [finiteRound(fighterA.position.x), finiteRound(fighterA.position.z)],
        b: [finiteRound(fighterB.position.x), finiteRound(fighterB.position.z)],
        separation: finiteRound(separation),
        aPath: movement.getPlayerMovementDebug(fighterA.id),
        bPath: movement.getPlayerMovementDebug(fighterB.id),
      });
      now += TICK_MS;
    }
  } finally {
    fighterAAi.stop();
    fighterBAi.stop();
    Date.now = originalNow;
    Math.random = originalRandom;
  }

  const movementPackets = packets.filter(
    ({ name }) =>
      name === "tileMovementStart" ||
      name === "entityTileUpdate" ||
      name === "tileMovementEnd",
  );
  for (const packet of movementPackets) {
    const data = packet.data as {
      path?: Array<{ x: number; z: number }>;
      destinationTile?: { x: number; z: number };
    };
    for (const tile of data.path ?? []) {
      expect(collision.hasFlags(tile.x, tile.z, CollisionFlag.BLOCKED)).toBe(
        false,
      );
    }
    if (data.destinationTile) {
      expect(data.destinationTile.x).toBeGreaterThanOrEqual(
        Math.round(arenaBounds.minX),
      );
      expect(data.destinationTile.x).toBeLessThanOrEqual(
        Math.round(arenaBounds.maxX),
      );
      expect(data.destinationTile.z).toBeGreaterThanOrEqual(
        Math.round(arenaBounds.minZ),
      );
      expect(data.destinationTile.z).toBeLessThanOrEqual(
        Math.round(arenaBounds.maxZ),
      );
    }
  }

  return {
    traceHash: hash(trace),
    packetHash: hash(movementPackets),
    movementDirections: [...directionSet].sort(),
    maximumChebyshevStep,
    minimumSeparation: finiteRound(minimumSeparation),
    maximumSeparation: finiteRound(maximumSeparation),
    wallBandVisits,
    startPackets: movementPackets.filter(
      ({ name }) => name === "tileMovementStart",
    ).length,
    tileUpdates: movementPackets.filter(
      ({ name }) => name === "entityTileUpdate",
    ).length,
    fighterAStats: fighterAAi.getStats(),
    fighterBStats: fighterBAi.getStats(),
  };
}

describe("DuelCombatAI production arena movement integration", () => {
  it("replays bounded collision-safe wall recovery and omnidirectional paths exactly", async () => {
    const first = await runArenaScenario();
    const replay = await runArenaScenario();
    expect(replay).toEqual(first);
    expect(first.traceHash).toBe(
      "a254943787554987b93355cea57a1963019483f9e1faddf62b512086f6774691",
    );
    expect(first.packetHash).toBe(
      "5e1701e5fd6f929a77541c84d4a153bac1184e9c1c89bc72199794bf58ee7185",
    );
    expect(first.movementDirections).toEqual([
      "-1,-1",
      "-1,1",
      "0,-1",
      "0,1",
      "1,-1",
      "1,0",
      "1,1",
    ]);
    expect(first.startPackets).toBeGreaterThan(0);
    expect(first.tileUpdates).toBeGreaterThan(0);
    expect(first.wallBandVisits).toBeGreaterThan(0);
    expect(first.maximumChebyshevStep).toBeLessThanOrEqual(TILES_PER_TICK_RUN);
    // Adjacent combat tiles are one metre apart. The duel avatars' collision
    // capsules are at most 0.4 m in radius, so this rejects same-tile/body
    // collapse while preserving the authoritative adjacent-tile melee range.
    expect(first.minimumSeparation).toBeGreaterThanOrEqual(1);
    expect(first.maximumSeparation).toBeGreaterThan(first.minimumSeparation);
    expect(
      first.movementDirections.some((direction) =>
        direction.split(",").every((axis) => axis !== "0"),
      ),
    ).toBe(true);
    expect(
      first.movementDirections.some((direction) =>
        direction.split(",").includes("0"),
      ),
    ).toBe(true);
    expect(first.fighterAStats.movementPathsActive).toBeGreaterThan(0);
    expect(first.fighterBStats.movementPathsActive).toBeGreaterThan(0);
  });

  it("replays collision-safe same-style melee footwork with diagonal and directional movement", async () => {
    const first = await runArenaScenario(["melee", "melee"]);
    const replay = await runArenaScenario(["melee", "melee"]);

    expect(replay).toEqual(first);
    expect(first.traceHash).toBe(
      "61df02fd3de15f29de2657981fe995a057d5cb3f6857b0e2935d29677f1be1fa",
    );
    expect(first.packetHash).toBe(
      "3c3b4a262229f4397e8e225a9c08e645f67f4402f69cd313c694945b51d92687",
    );
    expect(first.movementDirections).toEqual(["-1,-1", "-1,1", "1,-1", "1,1"]);
    expect(first.startPackets).toBeGreaterThan(0);
    expect(first.tileUpdates).toBeGreaterThan(0);
    expect(first.maximumChebyshevStep).toBeLessThanOrEqual(TILES_PER_TICK_RUN);
    // Same-style footwork may close to adjacent combat tiles, but the fighters
    // must never collapse into the same tile/body space.
    expect(first.minimumSeparation).toBeGreaterThanOrEqual(1);
    expect(first.maximumSeparation).toBeGreaterThan(first.minimumSeparation);
    expect(
      first.movementDirections.some((direction) =>
        direction.split(",").every((axis) => axis !== "0"),
      ),
    ).toBe(true);
    expect(
      first.movementDirections.some((value) => value.startsWith("-1,")),
    ).toBe(true);
    expect(
      first.movementDirections.some((value) => value.startsWith("1,")),
    ).toBe(true);
    expect(
      first.movementDirections.some((value) => value.endsWith(",-1")),
    ).toBe(true);
    expect(first.movementDirections.some((value) => value.endsWith(",1"))).toBe(
      true,
    );
    expect(first.fighterAStats.movementPathsActive).toBeGreaterThan(0);
    expect(first.fighterBStats.movementPathsActive).toBeGreaterThan(0);
    expect(first.fighterAStats.movementPathsInactive).toBe(0);
    expect(first.fighterBStats.movementPathsInactive).toBe(0);
  });

  it("replays collision-safe same-style ranged spacing and full-tile orbit footwork", async () => {
    const first = await runArenaScenario(["ranged", "ranged"]);
    const replay = await runArenaScenario(["ranged", "ranged"]);

    expect(replay).toEqual(first);
    expect(first.traceHash).toBe(
      "f691f300085030c740dcd591c39518d22737b8c5a989bdcca051097b9b1c0c35",
    );
    expect(first.packetHash).toBe(
      "ea0be0b15f1ead4debe43126a4bab2f0cbb7f78bf2ab6b2352ff3a3b5d946080",
    );
    expect(first.movementDirections).toEqual([
      "-1,-1",
      "-1,1",
      "0,-1",
      "0,1",
      "1,-1",
      "1,1",
    ]);
    expect(first.startPackets).toBeGreaterThan(0);
    expect(first.tileUpdates).toBeGreaterThan(0);
    expect(first.maximumChebyshevStep).toBeLessThanOrEqual(TILES_PER_TICK_RUN);
    expect(first.minimumSeparation).toBeGreaterThan(1);
    expect(first.maximumSeparation).toBeLessThanOrEqual(6);
    expect(first.fighterAStats.movementPathsActive).toBeGreaterThan(10);
    expect(first.fighterBStats.movementPathsActive).toBeGreaterThan(10);
    expect(first.fighterAStats.movementPathsInactive).toBe(0);
    expect(first.fighterBStats.movementPathsInactive).toBe(0);
  });

  it("replays collision-safe same-style mage spacing and full-tile orbit footwork", async () => {
    const first = await runArenaScenario(["mage", "mage"]);
    const replay = await runArenaScenario(["mage", "mage"]);

    expect(replay).toEqual(first);
    expect(first.traceHash).toBe(
      "f691f300085030c740dcd591c39518d22737b8c5a989bdcca051097b9b1c0c35",
    );
    expect(first.packetHash).toBe(
      "ea0be0b15f1ead4debe43126a4bab2f0cbb7f78bf2ab6b2352ff3a3b5d946080",
    );
    expect(first.movementDirections).toEqual([
      "-1,-1",
      "-1,1",
      "0,-1",
      "0,1",
      "1,-1",
      "1,1",
    ]);
    expect(first.startPackets).toBeGreaterThan(0);
    expect(first.tileUpdates).toBeGreaterThan(0);
    expect(first.maximumChebyshevStep).toBeLessThanOrEqual(TILES_PER_TICK_RUN);
    expect(first.minimumSeparation).toBeGreaterThan(1);
    expect(first.maximumSeparation).toBeLessThanOrEqual(6);
    expect(first.fighterAStats.movementPathsActive).toBeGreaterThan(10);
    expect(first.fighterBStats.movementPathsActive).toBeGreaterThan(10);
    expect(first.fighterAStats.movementPathsInactive).toBe(0);
    expect(first.fighterBStats.movementPathsInactive).toBe(0);
  });
});
