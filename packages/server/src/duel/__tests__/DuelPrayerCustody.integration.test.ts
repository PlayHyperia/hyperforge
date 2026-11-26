import {
  AttackType,
  DataManager,
  EventBus,
  EventType,
  ITEMS,
  PRAYER_POINT_UNITS_PER_POINT,
  PrayerSystem,
  getDuelArenaEgressPosition,
  getDuelArenaGradeHeight,
  prayerDataProvider,
  type PrayerPersistenceSnapshot,
  type PrayerStateCommitRequest,
  type PrayerStateCommitReceipt,
  type World,
} from "@hyperforge/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import ammunitionManifest from "../../../world/assets/manifests/items/ammunition.json";
import runesManifest from "../../../world/assets/manifests/items/runes.json";
import weaponsManifest from "../../../world/assets/manifests/items/weapons.json";
import prayersManifest from "../../../world/assets/manifests/prayers.json";
import { EmbeddedHyperiaService } from "../../eliza/EmbeddedHyperiaService.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../../systems/StreamingDuelScheduler/competitive-tactical-strategy.js";
import { getAvailablePrayerIdsForLevel } from "../../systems/StreamingDuelScheduler/competitive-prayer-policy.js";
import { DuelOrchestrator } from "../../systems/StreamingDuelScheduler/managers/DuelOrchestrator.js";
import { DuelCombatAI } from "../DuelCombatAI.js";

const AGENT_ID = "prayer-custody-agent";
const OPPONENT_ID = "prayer-custody-opponent";
const STARTING_POINT_UNITS = 40 * PRAYER_POINT_UNITS_PER_POINT;
const originalNodeEnv = process.env.NODE_ENV;
const fixtureItemIds = new Set([
  "shortbow",
  "bronze_arrow",
  "bronze_longsword",
  "staff_of_air",
  "fire_rune",
  "mind_rune",
]);
const previousFixtureItems = new Map<string, unknown>();

type FixtureCombatRole = "melee" | "ranged" | "mage";

type TestEntity = {
  id: string;
  type: "player";
  position: {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
  };
  data: Record<string, unknown>;
  stats: {
    prayer: { level: number; xp: number };
    combatBonuses: { prayerBonus: number };
  };
};

type PersistedPrayerOperation = {
  requestFingerprint: string;
  transition: PrayerStateCommitRequest["transition"];
  committed: PrayerPersistenceSnapshot;
};

beforeAll(async () => {
  const validation = await DataManager.getInstance().initialize();
  expect(validation.isValid).toBe(true);
  prayerDataProvider.loadPrayers(prayersManifest);
  prayerDataProvider.rebuild();
  for (const item of [
    ...weaponsManifest,
    ...ammunitionManifest,
    ...runesManifest,
  ]) {
    if (!fixtureItemIds.has(item.id)) continue;
    previousFixtureItems.set(item.id, ITEMS.get(item.id));
    ITEMS.set(item.id, {
      ...item,
      ...(item.id === "shortbow"
        ? { attackType: AttackType.RANGED }
        : item.id === "bronze_longsword"
          ? { attackType: AttackType.MELEE }
          : item.id === "staff_of_air"
            ? { attackType: AttackType.MAGIC }
            : {}),
    } as never);
  }
});

afterAll(() => {
  for (const itemId of fixtureItemIds) {
    const previous = previousFixtureItems.get(itemId);
    if (previous) ITEMS.set(itemId, previous as never);
    else ITEMS.delete(itemId);
  }
});

beforeEach(() => {
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function createEntity(id: string, xOffset: number): TestEntity {
  const lobby = getDuelArenaEgressPosition();
  const x = lobby.x + xOffset;
  const position = {
    x,
    y: lobby.y,
    z: lobby.z,
    set(nextX: number, nextY: number, nextZ: number): void {
      this.x = nextX;
      this.y = nextY;
      this.z = nextZ;
    },
  };
  const skills = Object.fromEntries(
    [
      "attack",
      "strength",
      "defense",
      "constitution",
      "ranged",
      "magic",
      "prayer",
    ].map((skill) => [skill, { level: 40, xp: 0 }]),
  );
  return {
    id,
    type: "player",
    position,
    data: {
      type: "player",
      name: id,
      position: [x, lobby.y, lobby.z],
      health: 40,
      maxHealth: 40,
      alive: true,
      skills,
      selectedSpell: null,
      activePrayers: [],
      prayerPointUnits: STARTING_POINT_UNITS,
      prayerPoints: 40,
      prayerMaxPoints: 40,
    },
    stats: {
      prayer: { level: 40, xp: 0 },
      combatBonuses: { prayerBonus: 0 },
    },
  };
}

function createCustodyWorld(combatRole: FixtureCombatRole = "ranged") {
  const persisted = new Map<string, PrayerPersistenceSnapshot>([
    [
      AGENT_ID,
      {
        pointUnits: STARTING_POINT_UNITS,
        maxPoints: 40,
        activePrayers: [],
      },
    ],
    [
      OPPONENT_ID,
      {
        pointUnits: STARTING_POINT_UNITS,
        maxPoints: 40,
        activePrayers: [],
      },
    ],
  ]);
  const operations = new Map<string, PersistedPrayerOperation>();
  const commitRequests: PrayerStateCommitRequest[] = [];
  const database = {
    getPlayerAsync: vi.fn(async (playerId: string) => {
      const state = persisted.get(playerId);
      if (!state) return null;
      return {
        prayerLevel: state.maxPoints,
        prayerMaxPoints: state.maxPoints,
        prayerPoints:
          state.pointUnits <= 0
            ? 0
            : Math.ceil(state.pointUnits / PRAYER_POINT_UNITS_PER_POINT),
        prayerPointUnits: state.pointUnits,
        activePrayers: [...state.activePrayers],
      };
    }),
    commitPrayerStateOperationAsync: vi.fn(
      async (
        request: PrayerStateCommitRequest,
      ): Promise<PrayerStateCommitReceipt> => {
        commitRequests.push(structuredClone(request));
        const operationKey = `${request.playerId}:${request.operationId}`;
        const prior = operations.get(operationKey);
        if (prior) {
          if (
            prior.requestFingerprint !== request.requestFingerprint ||
            prior.transition !== request.transition
          ) {
            throw new Error("prayer_state_operation_id_conflict");
          }
          return {
            operationId: request.operationId,
            playerId: request.playerId,
            requestFingerprint: request.requestFingerprint,
            transition: request.transition,
            replayed: true,
            committed: structuredClone(prior.committed),
          };
        }
        const current = persisted.get(request.playerId);
        if (JSON.stringify(current) !== JSON.stringify(request.expected)) {
          throw new Error("prayer_state_conflict");
        }
        const committed = structuredClone(request.committed);
        persisted.set(request.playerId, committed);
        operations.set(operationKey, {
          requestFingerprint: request.requestFingerprint,
          transition: request.transition,
          committed,
        });
        return {
          operationId: request.operationId,
          playerId: request.playerId,
          requestFingerprint: request.requestFingerprint,
          transition: request.transition,
          replayed: false,
          committed: structuredClone(committed),
        };
      },
    ),
  };

  const entityItems = new Map<string, TestEntity>([
    [AGENT_ID, createEntity(AGENT_ID, 0)],
    // Keep the prayer-custody fixture inside every role's authoritative attack
    // range so this integration does not also depend on pursuit/pathfinding.
    [OPPONENT_ID, createEntity(OPPONENT_ID, 1)],
  ]);
  entityItems.get(AGENT_ID)!.data.selectedSpell =
    combatRole === "mage" ? "fire_strike" : null;
  const equipment = new Map([
    [
      AGENT_ID,
      combatRole === "ranged"
        ? {
            weapon: { itemId: "shortbow", quantity: 1 },
            arrows: { itemId: "bronze_arrow", quantity: 100 },
          }
        : {
            weapon: {
              itemId:
                combatRole === "mage" ? "staff_of_air" : "bronze_longsword",
              quantity: 1,
            },
            arrows: null,
          },
    ],
    [
      OPPONENT_ID,
      {
        weapon: { itemId: "bronze_longsword", quantity: 1 },
        arrows: null,
      },
    ],
  ]);
  const inventory = new Map([
    [
      AGENT_ID,
      {
        playerId: AGENT_ID,
        items:
          combatRole === "mage"
            ? [
                { slot: 0, itemId: "fire_rune", quantity: 60 },
                { slot: 1, itemId: "mind_rune", quantity: 20 },
              ]
            : [],
        coins: 0,
      },
    ],
    [OPPONENT_ID, { playerId: OPPONENT_ID, items: [], coins: 0 }],
  ]);
  const systems = new Map<string, unknown>();
  systems.set("database", database);
  systems.set("player", {
    isPlayerReady: (playerId: string) => entityItems.has(playerId),
  });
  systems.set("inventory", {
    getInventory: (playerId: string) => inventory.get(playerId),
    isInventoryReady: (playerId: string) => inventory.has(playerId),
  });
  systems.set("equipment", {
    getPlayerEquipment: (playerId: string) => equipment.get(playerId),
    isEquipmentReady: (playerId: string) => equipment.has(playerId),
  });
  const requestServerAttack = vi.fn(() => true);
  systems.set("network", {
    requestServerAttack,
    requestServerMove: vi.fn(() => true),
    getServerMovementDebug: vi.fn(() => null),
    getPlayerWeaponRange: vi.fn(() => 1),
    getPlayerAttackType: vi.fn(() => AttackType.MELEE),
    isInAttackRange: vi.fn(() => true),
  });
  systems.set("combat", { forceEndCombat: vi.fn() });
  systems.set("terrain", { getHeightAt: () => getDuelArenaGradeHeight() });

  const emitter = new EventBus();
  const world = Object.assign(emitter, {
    isServer: true,
    currentTick: 1,
    $eventBus: new EventBus(),
    entities: {
      get: (id: string) => entityItems.get(id),
      values: () => entityItems.values(),
      items: entityItems,
      [Symbol.iterator]: () => entityItems[Symbol.iterator](),
    },
    getPlayer: (id: string) => entityItems.get(id),
    getPlayers: vi.fn(() => []),
    getSystem: (name: string) => systems.get(name),
    network: null,
  });
  return {
    world,
    systems,
    persisted,
    commitRequests,
    requestServerAttack,
  };
}

function processDrainTicks(system: PrayerSystem, count: number): void {
  const processDrainTick = (
    system as unknown as { processDrainTick(): void }
  ).processDrainTick.bind(system);
  for (let index = 0; index < count; index += 1) processDrainTick();
}

describe("production duel prayer custody integration", () => {
  it.each([
    ["melee", "superhuman_strength"],
    ["ranged", "hawk_eye"],
    ["mage", "mystic_lore"],
  ] as const)(
    "carries one frozen %s prayer through service activation, exact drain, and abort teardown",
    async (combatRole, expectedPrayer) => {
      const fixture = createCustodyWorld(combatRole);
      const prayerSystem = new PrayerSystem(fixture.world as unknown as World);
      fixture.systems.set("prayer", prayerSystem);
      await prayerSystem.init();
      fixture.world.emit(EventType.PLAYER_REGISTERED, { playerId: AGENT_ID });
      fixture.world.emit(EventType.PLAYER_REGISTERED, {
        playerId: OPPONENT_ID,
      });
      await Promise.all([
        prayerSystem.waitForPrayerIdle(AGENT_ID),
        prayerSystem.waitForPrayerIdle(OPPONENT_ID),
      ]);

      let cycle: Record<string, unknown> | null = null;
      const orchestrator = new DuelOrchestrator(
        fixture.world as unknown as World,
        () => cycle as never,
        () => {},
        () => new Map(),
        () => {},
        () => {},
        () => [],
        () => [],
      );
      const agent = orchestrator.createContestant(AGENT_ID, OPPONENT_ID)!;
      const opponent = orchestrator.createContestant(OPPONENT_ID, AGENT_ID)!;
      cycle = {
        cycleId: `prayer-custody-${combatRole}-cycle`,
        phase: "FIGHTING",
        agent1: agent,
        agent2: opponent,
        competitiveSnapshot: { diagnostic: false },
      };

      const availablePrayerIds = getAvailablePrayerIdsForLevel(40);
      expect(availablePrayerIds).toContain(expectedPrayer);
      const agentFreeze = orchestrator.freezeCompetitiveLoadout(agent);
      const opponentFreeze = orchestrator.freezeCompetitiveLoadout(opponent);
      expect(agentFreeze.ok, JSON.stringify(agentFreeze)).toBe(true);
      expect(agentFreeze).toMatchObject({
        ok: true,
        diagnostic: false,
      });
      expect(opponentFreeze.ok, JSON.stringify(opponentFreeze)).toBe(true);
      expect(opponentFreeze).toMatchObject({
        ok: true,
        diagnostic: false,
      });

      const service = new EmbeddedHyperiaService(
        fixture.world as unknown as World,
        AGENT_ID,
        "prayer-custody-account",
        "Prayer Custody Agent",
      );
      (
        service as unknown as {
          playerEntityId: string;
          isActive: boolean;
        }
      ).playerEntityId = AGENT_ID;
      (service as unknown as { isActive: boolean }).isActive = true;
      const ai = new DuelCombatAI(service, OPPONENT_ID, {
        combatRole,
        noFood: true,
        availablePrayerIds,
        tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
          combatRole,
          availablePrayerIds,
        ),
      });
      ai.start();
      await ai.externalTick();

      expect(ai.getStats()).toMatchObject({
        prayerToggleAttempts: 1,
        prayerToggleCommits: 1,
        prayerToggleRejects: 0,
        combatRole,
      });
      expect(prayerSystem.getPrayerCustody(AGENT_ID)).toMatchObject({
        ready: true,
        persistenceHealthy: true,
        pointUnits: STARTING_POINT_UNITS,
        activePrayers: [expectedPrayer],
      });
      expect(fixture.requestServerAttack).toHaveBeenCalledWith(
        AGENT_ID,
        OPPONENT_ID,
        "player",
      );

      processDrainTicks(prayerSystem, 4);
      await prayerSystem.waitForPrayerIdle(AGENT_ID);
      const expectedAfterDrain = STARTING_POINT_UNITS - 400_000;
      expect(prayerSystem.getPrayerCustody(AGENT_ID)).toMatchObject({
        pointUnits: expectedAfterDrain,
        activePrayers: [expectedPrayer],
      });
      expect(fixture.persisted.get(AGENT_ID)).toEqual({
        pointUnits: expectedAfterDrain,
        maxPoints: 40,
        activePrayers: [expectedPrayer],
      });

      ai.stop();
      await orchestrator.cleanupAfterAbort(cycle as never);

      expect(prayerSystem.getPrayerCustody(AGENT_ID)).toMatchObject({
        ready: true,
        persistenceHealthy: true,
        pointUnits: expectedAfterDrain,
        activePrayers: [],
      });
      expect(fixture.persisted.get(AGENT_ID)).toEqual({
        pointUnits: expectedAfterDrain,
        maxPoints: 40,
        activePrayers: [],
      });
      const transitions = fixture.commitRequests.map(
        ({ transition }) => transition,
      );
      expect(transitions[0]).toBe("toggle");
      expect(transitions.at(-1)).toBe("deactivate_all");
      expect(transitions.slice(1, -1).length).toBeGreaterThan(0);
      expect(transitions.slice(1, -1).every((value) => value === "drain")).toBe(
        true,
      );
      expect(fixture.commitRequests.at(-1)?.operationId).toBe(
        `duel-prayer-teardown:prayer-custody-${combatRole}-cycle:${AGENT_ID}`,
      );
      prayerSystem.destroy();
    },
  );
});
