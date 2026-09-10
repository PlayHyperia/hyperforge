/**
 * MobProjectileAttack Integration Tests
 *
 * Tests for mob magic and ranged attack paths:
 * - Magic mobs cast spells and emit projectile events
 * - Ranged mobs fire arrows and emit projectile events
 * - Range validation rejects out-of-range attacks
 * - Event→handler routing dispatches correctly by attackType
 * - Missing spellId/arrowId handled gracefully
 *
 * Uses the same createTestWorld/createTestPlayer/createTestMob
 * pattern from CombatFlow.integration.test.ts. Registers test
 * NPCs directly in ALL_NPCS (no mocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CombatSystem } from "../CombatSystem";
import { COMBAT_CONSTANTS } from "../../../../constants/CombatConstants";
import { ALL_NPCS } from "../../../../data/npcs";
import { EventType } from "../../../../types/events";
import type { NPCData } from "../../../../types/entities/npc-mob-types";
import type { World } from "../../../../core/World";
import { EventBus } from "../../infrastructure/EventBus";

// ─── Test NPC IDs ────────────────────────────────────────────────
const TEST_MAGE_ID = "test_mage";
const TEST_RANGER_ID = "test_ranger";
const TEST_NO_SPELL_ID = "test_mage_no_spell";
const TEST_NO_ARROW_ID = "test_ranger_no_arrow";

// ─── Helpers ─────────────────────────────────────────────────────

interface HealthTracker {
  current: number;
  max: number;
  damageHistory: number[];
}

function createTestPlayer(
  id: string,
  options: {
    health?: number;
    maxHealth?: number;
    position?: { x: number; y: number; z: number };
    stats?: { attack: number; strength: number; defence: number };
  } = {},
) {
  const healthTracker: HealthTracker = {
    current: options.health ?? 100,
    max: options.maxHealth ?? 100,
    damageHistory: [],
  };

  const position = options.position ?? { x: 0.5, y: 0, z: 0.5 };
  const stats = options.stats ?? { attack: 10, strength: 10, defence: 10 };

  return {
    id,
    type: "player" as const,
    position,
    health: healthTracker.current,
    healthTracker,
    stats: {
      ...stats,
      hitpoints: healthTracker.max,
    },
    data: {
      isLoading: false,
      stats: {
        ...stats,
        hitpoints: healthTracker.max,
      },
    },
    combat: {
      combatTarget: null as string | null,
      inCombat: false,
    },
    emote: "idle",
    base: { quaternion: { set: vi.fn(), copy: vi.fn() } },
    node: {
      position,
      quaternion: { set: vi.fn(), copy: vi.fn() },
    },
    getPosition: () => position,
    markNetworkDirty: vi.fn(),
    takeDamage: vi.fn((amount: number) => {
      healthTracker.damageHistory.push(amount);
      healthTracker.current = Math.max(0, healthTracker.current - amount);
      return healthTracker.current <= 0;
    }),
    getHealth: () => healthTracker.current,
    getComponent: (name: string) => {
      if (name === "health") {
        return {
          data: {
            current: healthTracker.current,
            max: healthTracker.max,
            isDead: healthTracker.current <= 0,
          },
        };
      }
      if (name === "stats") {
        return {
          data: {
            attack: stats.attack,
            strength: stats.strength,
            defense: stats.defence,
            ranged: 1,
          },
        };
      }
      return null;
    },
    isDead: () => healthTracker.current <= 0,
    get alive() {
      return healthTracker.current > 0;
    },
  };
}

function createTestMob(
  id: string,
  options: {
    health?: number;
    maxHealth?: number;
    position?: { x: number; y: number; z: number };
    stats?: { attack: number; strength: number; defence: number };
    combatRange?: number;
    attackSpeedTicks?: number;
    mobType?: string;
  } = {},
) {
  const healthTracker: HealthTracker = {
    current: options.health ?? 50,
    max: options.maxHealth ?? 50,
    damageHistory: [],
  };

  const position = options.position ?? { x: 0.5, y: 0, z: 1.5 };
  const stats = options.stats ?? { attack: 5, strength: 5, defence: 5 };
  const combatRange = options.combatRange ?? 1;
  const attackSpeedTicks =
    options.attackSpeedTicks ?? COMBAT_CONSTANTS.DEFAULT_ATTACK_SPEED_TICKS;
  const mobType = options.mobType ?? "";

  return {
    id,
    type: "mob" as const,
    position,
    health: healthTracker.current,
    healthTracker,
    stats: {
      ...stats,
      hitpoints: healthTracker.max,
    },
    node: {
      position,
      quaternion: { set: vi.fn(), copy: vi.fn() },
    },
    getPosition: () => position,
    getMobData: () => ({
      health: healthTracker.current,
      attack: stats.attack,
      attackPower: stats.strength,
      defense: stats.defence,
      stats: {
        ...stats,
        hitpoints: healthTracker.max,
      },
      combatRange,
      attackSpeedTicks,
      type: mobType,
    }),
    getHealth: () => healthTracker.current,
    takeDamage: vi.fn((amount: number) => {
      healthTracker.damageHistory.push(amount);
      healthTracker.current = Math.max(0, healthTracker.current - amount);
      return healthTracker.current <= 0;
    }),
    isAttackable: () => healthTracker.current > 0,
    isDead: () => healthTracker.current <= 0,
    setServerEmote: vi.fn(),
    markNetworkDirty: vi.fn(),
  };
}

function createTestWorld(options: { currentTick?: number } = {}) {
  const eventHandlers = new Map<string, Function[]>();
  const emittedEvents: Array<{ event: string; data: unknown }> = [];

  // Shared EventBus — SystemBase reads world.$eventBus for subscribe/emit
  const $eventBus = new EventBus();

  let currentTick = options.currentTick ?? 100;

  const entities = new Map<string, unknown>() as Map<string, unknown> & {
    players: Map<string, unknown>;
  };

  const playersInternalMap = new Map<
    string,
    ReturnType<typeof createTestPlayer>
  >();
  const players = {
    set: (id: string, player: ReturnType<typeof createTestPlayer>) => {
      playersInternalMap.set(id, player);
      entities.set(id, player);
      return players;
    },
    get: (id: string) => playersInternalMap.get(id),
    delete: (id: string) => {
      entities.delete(id);
      return playersInternalMap.delete(id);
    },
    has: (id: string) => playersInternalMap.has(id),
    clear: () => {
      for (const id of playersInternalMap.keys()) {
        entities.delete(id);
      }
      playersInternalMap.clear();
    },
    get size() {
      return playersInternalMap.size;
    },
    [Symbol.iterator]: () => playersInternalMap[Symbol.iterator](),
    keys: () => playersInternalMap.keys(),
    values: () => playersInternalMap.values(),
    entries: () => playersInternalMap.entries(),
    forEach: (
      fn: (
        value: ReturnType<typeof createTestPlayer>,
        key: string,
        map: Map<string, ReturnType<typeof createTestPlayer>>,
      ) => void,
    ) => playersInternalMap.forEach(fn),
  };
  entities.players = players as unknown as Map<string, unknown>;

  const mobsInternalMap = new Map<string, ReturnType<typeof createTestMob>>();
  const mobs = {
    set: (id: string, mob: ReturnType<typeof createTestMob>) => {
      mobsInternalMap.set(id, mob);
      entities.set(id, mob);
      return mobs;
    },
    get: (id: string) => mobsInternalMap.get(id),
    delete: (id: string) => {
      entities.delete(id);
      return mobsInternalMap.delete(id);
    },
    has: (id: string) => mobsInternalMap.has(id),
    clear: () => {
      for (const id of mobsInternalMap.keys()) {
        entities.delete(id);
      }
      mobsInternalMap.clear();
    },
    get size() {
      return mobsInternalMap.size;
    },
    [Symbol.iterator]: () => mobsInternalMap[Symbol.iterator](),
  };

  const mockPlayerSystem = {
    damagePlayer: vi.fn(
      (playerId: string, damage: number, _attackerId: string) => {
        const player = players.get(playerId);
        if (!player) return false;
        if (player.healthTracker.current <= 0) return false;

        player.healthTracker.damageHistory.push(damage);
        player.healthTracker.current = Math.max(
          0,
          player.healthTracker.current - damage,
        );
        player.health = player.healthTracker.current;
        return true;
      },
    ),
    getPlayer: (id: string) => players.get(id),
    getPlayerAutoRetaliate: () => true,
  };

  return {
    isServer: true,
    $eventBus,
    get currentTick() {
      return currentTick;
    },
    setTick(tick: number) {
      currentTick = tick;
    },
    advanceTicks(count: number) {
      currentTick += count;
    },
    entities,
    players,
    mobs,
    emittedEvents,
    network: {
      send: vi.fn(),
    },
    getPlayer: (id: string) => players.get(id),
    getSystem: (name: string) => {
      if (name === "entity-manager") {
        return {
          getEntity: (id: string) => entities.get(id) || players.get(id),
        };
      }
      if (name === "equipment") {
        return {
          getPlayerEquipment: () => ({ weapon: null }),
        };
      }
      if (name === "player") {
        return mockPlayerSystem;
      }
      if (name === "mob-npc") {
        return {
          getMob: (id: string) => mobs.get(id),
        };
      }
      if (name === "ground-item") {
        return {
          spawnGroundItem: vi.fn(),
        };
      }
      return undefined;
    },
    on: (event: string, handler: Function) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    },
    off: vi.fn(),
    emit: vi.fn((event: string, data: unknown) => {
      emittedEvents.push({ event, data });
      const handlers = eventHandlers.get(event) || [];
      handlers.forEach((h) => h(data));
    }),
    getEventHandlers: () => eventHandlers,
  };
}

// ─── Minimal NPCData factory for ALL_NPCS registration ──────────

function makeTestNPCData(overrides: {
  id: string;
  magic?: number;
  ranged?: number;
  attackType?: "melee" | "ranged" | "magic";
  spellId?: string;
  arrowId?: string;
  combatRange?: number;
  attackSpeedTicks?: number;
}): NPCData {
  return {
    id: overrides.id,
    name: overrides.id,
    description: "test npc",
    category: "mob",
    faction: "enemy",
    stats: {
      level: 10,
      health: 50,
      attack: 5,
      strength: 5,
      defense: 5,
      defenseBonus: 0,
      ranged: overrides.ranged ?? 1,
      magic: overrides.magic ?? 1,
    },
    combat: {
      attackable: true,
      aggressive: true,
      retaliates: true,
      aggroRange: 5,
      combatRange: overrides.combatRange ?? 1,
      leashRange: 8,
      attackSpeedTicks: overrides.attackSpeedTicks ?? 4,
      respawnTime: 30000,
      xpReward: 20,
      poisonous: false,
      immuneToPoison: false,
      attackType: overrides.attackType,
      spellId: overrides.spellId,
      arrowId: overrides.arrowId,
    },
    movement: {
      type: "wander",
      speed: 1,
      wanderRadius: 3,
      roaming: false,
    },
    drops: {
      defaultDrop: { itemId: "bones", quantity: 1, enabled: true },
      always: [],
      common: [],
      uncommon: [],
      rare: [],
      veryRare: [],
    },
    services: {
      shop: { enabled: false, shopId: "" },
      bank: { enabled: false },
      quest: { enabled: false, questId: "" },
    },
    behavior: {
      type: "aggressive",
      fleeHealthPercent: 0,
      callForHelp: false,
      helpRange: 0,
      customBehavior: null,
    },
    appearance: {
      modelPath: "goblin/goblin_rigged.glb",
      scale: 1,
    },
    position: { x: 0, y: 0, z: 0 },
  } as NPCData;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("MobProjectileAttack Integration", () => {
  let combatSystem: CombatSystem;
  let world: ReturnType<typeof createTestWorld>;

  beforeEach(async () => {
    // Register test NPCs
    ALL_NPCS.set(
      TEST_MAGE_ID,
      makeTestNPCData({
        id: TEST_MAGE_ID,
        magic: 20,
        attackType: "magic",
        spellId: "wind_strike",
        combatRange: 10,
        attackSpeedTicks: 5,
      }),
    );
    ALL_NPCS.set(
      TEST_RANGER_ID,
      makeTestNPCData({
        id: TEST_RANGER_ID,
        ranged: 20,
        attackType: "ranged",
        arrowId: "bronze_arrow",
        combatRange: 7,
        attackSpeedTicks: 4,
      }),
    );
    ALL_NPCS.set(
      TEST_NO_SPELL_ID,
      makeTestNPCData({
        id: TEST_NO_SPELL_ID,
        magic: 15,
        attackType: "magic",
        // intentionally no spellId
        combatRange: 10,
      }),
    );
    ALL_NPCS.set(
      TEST_NO_ARROW_ID,
      makeTestNPCData({
        id: TEST_NO_ARROW_ID,
        ranged: 15,
        attackType: "ranged",
        // intentionally no arrowId
        combatRange: 7,
      }),
    );

    world = createTestWorld({ currentTick: 100 });
    combatSystem = new CombatSystem(world as unknown as World);
    await combatSystem.init();
  });

  afterEach(() => {
    combatSystem.destroy();
    ALL_NPCS.delete(TEST_MAGE_ID);
    ALL_NPCS.delete(TEST_RANGER_ID);
    ALL_NPCS.delete(TEST_NO_SPELL_ID);
    ALL_NPCS.delete(TEST_NO_ARROW_ID);
  });

  // ─── Helper: find emitted events by type from eventBus history ─
  function findEvents(eventType: string) {
    return world.$eventBus
      .getEventHistory(eventType)
      .map((e) => ({ event: e.type, data: e.data }));
  }

  // ─── Helper: emit a mob attack event through the eventBus ─────
  function emitMobAttack(data: {
    mobId: string;
    targetId: string;
    attackType?: string;
    spellId?: string;
    arrowId?: string;
  }) {
    world.$eventBus.emitEvent(
      EventType.COMBAT_MOB_NPC_ATTACK,
      data as Record<string, unknown>,
      "test",
    );
  }

  // ─── MOB MAGIC ATTACKS ─────────────────────────────────────────

  describe("mob magic attacks", () => {
    it("routes magic attack to MagicAttackHandler and emits projectile", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 }, // 5 tiles away
        mobType: TEST_MAGE_ID,
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "wind_strike",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      expect(payload.attackerId).toBe("mob1");
      expect(payload.targetId).toBe("player1");
      expect(payload.spellId).toBe("wind_strike");
    });

    it("creates magic projectile with correct visual data", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_MAGE_ID,
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "wind_strike",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      // wind_strike element is "air"
      expect(payload.projectileType).toBe("air");
      expect(payload.sourcePosition).toBeDefined();
      expect(payload.targetPosition).toBeDefined();
      expect(payload.delayMs).toBe(COMBAT_CONSTANTS.SPELL_LAUNCH_DELAY_MS);
      expect(typeof payload.travelDurationMs).toBe("number");
      expect(payload.travelDurationMs as number).toBeGreaterThanOrEqual(200);
      expect(payload.projectileId).toEqual(expect.any(String));
    });

    it("skips attack when mob has no spellId", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_NO_SPELL_ID,
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        // no spellId in event, no spellId in NPC data
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("has no spellId configured"),
      );

      warnSpy.mockRestore();
    });

    it("respects magic range and rejects out-of-range attack", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 15.5 }, // 15 tiles away, > combatRange 10
        mobType: TEST_MAGE_ID,
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "wind_strike",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);

      const failedEvents = findEvents(EventType.COMBAT_ATTACK_FAILED);
      expect(failedEvents.length).toBe(1);
      expect((failedEvents[0].data as Record<string, unknown>).reason).toBe(
        "out_of_range",
      );
    });

    it("enters combat state after magic attack", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_MAGE_ID,
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "wind_strike",
      });

      // Mob should be in combat after the attack
      expect(combatSystem.isInCombat("mob1")).toBe(true);
      const combatData = combatSystem.getCombatData("mob1");
      expect(combatData).not.toBeNull();
      expect(combatData?.targetId).toBe("player1");
    });
  });

  // ─── MOB RANGED ATTACKS ────────────────────────────────────────

  describe("mob ranged attacks", () => {
    it("routes ranged attack to RangedAttackHandler and emits projectile", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_RANGER_ID,
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "bronze_arrow",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      expect(payload.attackerId).toBe("mob1");
      expect(payload.targetId).toBe("player1");
      expect(payload.arrowId).toBe("bronze_arrow");
    });

    it("creates arrow projectile with correct visual data", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_RANGER_ID,
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "bronze_arrow",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      expect(payload.projectileType).toBe("arrow");
      expect(payload.sourcePosition).toBeDefined();
      expect(payload.targetPosition).toBeDefined();
      expect(payload.delayMs).toBe(COMBAT_CONSTANTS.ARROW_LAUNCH_DELAY_MS);
      expect(typeof payload.travelDurationMs).toBe("number");
      expect(payload.travelDurationMs as number).toBeGreaterThanOrEqual(200);
      expect(payload.projectileId).toEqual(expect.any(String));
    });

    it("carries one stable projectile identity from launch through impact", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_RANGER_ID,
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "bronze_arrow",
      });

      const launchPayload = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED)[0]
        .data as Record<string, unknown>;
      const projectileId = launchPayload.projectileId;
      expect(projectileId).toEqual(expect.any(String));

      for (let tick = 101; tick <= 103; tick++) {
        world.setTick(tick);
        combatSystem.processCombatTick(tick);
      }

      const matchingImpacts = findEvents(
        EventType.COMBAT_PROJECTILE_HIT,
      ).filter(
        (event) =>
          (event.data as Record<string, unknown>).projectileId === projectileId,
      );
      expect(matchingImpacts).toHaveLength(1);
      const matchingDamage = findEvents(EventType.COMBAT_DAMAGE_DEALT).filter(
        (event) =>
          (event.data as Record<string, unknown>).projectileId === projectileId,
      );
      expect(matchingDamage).toHaveLength(1);
      expect(matchingDamage[0].data).toMatchObject({ attackType: "ranged" });
    });

    it("skips attack when mob has no arrowId", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_NO_ARROW_ID,
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        // no arrowId in event, no arrowId in NPC data
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("has no arrowId configured"),
      );

      warnSpy.mockRestore();
    });

    it("respects ranged range and rejects out-of-range attack", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 15.5 }, // 15 tiles away, > combatRange 7
        mobType: TEST_RANGER_ID,
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "bronze_arrow",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);

      const failedEvents = findEvents(EventType.COMBAT_ATTACK_FAILED);
      expect(failedEvents.length).toBe(1);
      expect((failedEvents[0].data as Record<string, unknown>).reason).toBe(
        "out_of_range",
      );
    });
  });

  // ─── MOB ATTACK ROUTING ────────────────────────────────────────

  describe("mob attack routing", () => {
    it("routes melee attackType to melee handler (no projectile)", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 1.5 }, // 1 tile away (melee range)
        mobType: TEST_MAGE_ID, // has NPC data, but attack routed as melee
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "melee",
      });

      // Melee attacks do not emit COMBAT_PROJECTILE_LAUNCHED
      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);
    });

    it("defaults to melee when attackType is missing", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 1.5 },
        mobType: TEST_MAGE_ID,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      // Emit without attackType — should default to melee
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
      });

      // No projectile for melee
      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(0);
    });

    it("passes event-carried spellId to magic handler over NPC data", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_MAGE_ID, // NPC data has spellId: "wind_strike"
        combatRange: 10,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      // Event carries "water_strike" which should take priority
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "water_strike",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      // Should use the event-provided spellId, not the NPC data default
      expect(payload.spellId).toBe("water_strike");
      // water_strike element is "water"
      expect(payload.projectileType).toBe("water");
    });

    it("passes event-carried arrowId to ranged handler over NPC data", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_RANGER_ID, // NPC data has arrowId: "bronze_arrow"
        combatRange: 7,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      // Event carries "iron_arrow" which should take priority
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "iron_arrow",
      });

      const projectileEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(projectileEvents.length).toBe(1);

      const payload = projectileEvents[0].data as Record<string, unknown>;
      expect(payload.arrowId).toBe("iron_arrow");
    });
  });

  // ─── MOB AUTO-ATTACK TICK PATH ──────────────────────────────────

  describe("mob auto-attack tick path", () => {
    it("mob magic auto-attacks on subsequent ticks", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
        health: 500,
        maxHealth: 500,
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_MAGE_ID,
        combatRange: 10,
        attackSpeedTicks: 5,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      // Initial attack via event — enters combat with weaponType MAGIC
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "magic",
        spellId: "wind_strike",
      });

      const firstEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(firstEvents.length).toBe(1);
      expect((firstEvents[0].data as Record<string, unknown>).spellId).toBe(
        "wind_strike",
      );

      // Advance past the attack cooldown (attackSpeedTicks = 5)
      world.advanceTicks(6);

      // processCombatTick triggers auto-attack via CombatTickProcessor
      combatSystem.processCombatTick(world.currentTick);

      // Should have a second projectile — spell resolved from NPC data (no event data)
      const allEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(allEvents.length).toBe(2);

      const secondPayload = allEvents[1].data as Record<string, unknown>;
      expect(secondPayload.attackerId).toBe("mob1");
      expect(secondPayload.targetId).toBe("player1");
      // Auto-attack resolves spellId from NPC manifest (wind_strike)
      expect(secondPayload.spellId).toBe("wind_strike");
    });

    it("mob ranged auto-attacks on subsequent ticks", () => {
      const player = createTestPlayer("player1", {
        position: { x: 0.5, y: 0, z: 0.5 },
        health: 500,
        maxHealth: 500,
      });
      const mob = createTestMob("mob1", {
        position: { x: 0.5, y: 0, z: 5.5 },
        mobType: TEST_RANGER_ID,
        combatRange: 7,
        attackSpeedTicks: 4,
      });

      world.players.set("player1", player);
      world.mobs.set("mob1", mob);

      // Initial attack via event — enters combat with weaponType RANGED
      emitMobAttack({
        mobId: "mob1",
        targetId: "player1",
        attackType: "ranged",
        arrowId: "bronze_arrow",
      });

      const firstEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(firstEvents.length).toBe(1);
      expect((firstEvents[0].data as Record<string, unknown>).arrowId).toBe(
        "bronze_arrow",
      );

      // Advance past the attack cooldown (attackSpeedTicks = 4)
      world.advanceTicks(5);

      // processCombatTick triggers auto-attack via CombatTickProcessor
      combatSystem.processCombatTick(world.currentTick);

      // Should have a second projectile — arrow resolved from NPC data (no event data)
      const allEvents = findEvents(EventType.COMBAT_PROJECTILE_LAUNCHED);
      expect(allEvents.length).toBe(2);

      const secondPayload = allEvents[1].data as Record<string, unknown>;
      expect(secondPayload.attackerId).toBe("mob1");
      expect(secondPayload.targetId).toBe("player1");
      // Auto-attack resolves arrowId from NPC manifest (bronze_arrow)
      expect(secondPayload.arrowId).toBe("bronze_arrow");
    });
  });
});
