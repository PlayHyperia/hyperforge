import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AttackType,
  CharacterEquipmentSystem,
  CharacterInventorySystem,
  EventBus,
  EventType,
  ITEMS,
  PRAYER_POINT_UNITS_PER_POINT,
  PrayerSystem,
  prayerDataProvider,
  type World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import ammunitionManifest from "../../../world/assets/manifests/items/ammunition.json";
import foodManifest from "../../../world/assets/manifests/items/food.json";
import runesManifest from "../../../world/assets/manifests/items/runes.json";
import weaponsManifest from "../../../world/assets/manifests/items/weapons.json";
import prayersManifest from "../../../world/assets/manifests/prayers.json";
import { createPostgresClientDatabase } from "../../database/postgres-transaction.js";
import * as schema from "../../database/schema.js";
import {
  AgentManager,
  getAgentManager,
  setAgentManager,
} from "../AgentManager.js";
import { DatabaseSystem } from "../../systems/DatabaseSystem/index.js";
import { StreamingDuelScheduler } from "../../systems/StreamingDuelScheduler/index.js";
import {
  digestCompetitiveSnapshot,
  type CompetitiveSnapshot,
} from "../../systems/StreamingDuelScheduler/competitive-snapshot.js";

const baseDatabaseUrl =
  process.env.AGENT_DUEL_CYCLE_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const STARTING_PRAYER_POINTS = 39;
const STARTING_PRAYER_UNITS =
  STARTING_PRAYER_POINTS * PRAYER_POINT_UNITS_PER_POINT;
const FIXTURE_ITEM_IDS = new Set([
  "bronze_longsword",
  "shortbow",
  "bronze_arrow",
  "staff_of_air",
  "fire_rune",
  "mind_rune",
  "lobster",
]);
const AGENT_IDS = [
  "persisted-duelist-alpha",
  "persisted-duelist-beta",
] as const;

type TestEntity = {
  id: string;
  type: string;
  isAgent: boolean;
  isEmbeddedAgent: boolean;
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
  serialize(): Record<string, unknown>;
  isAlive(): boolean;
  isDead(): boolean;
  modify(changes: Record<string, unknown>): void;
  markNetworkDirty(): void;
};

type CombatCall = {
  attackerId: string;
  targetId: string;
  source: "combat-system" | "agent-controller";
};

function processDrainTicks(system: PrayerSystem, count: number): void {
  const processDrainTick = (
    system as unknown as { processDrainTick(): void }
  ).processDrainTick.bind(system);
  for (let index = 0; index < count; index += 1) processDrainTick();
}

async function waitForCondition(
  assertion: () => void | Promise<void>,
  timeout = 15_000,
): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: 25 });
}

function createPersistedRuntimeWorld(
  pool: pg.Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  const emitter = new EventBus();
  const eventBus = new EventBus();
  const entities = new Map<string, TestEntity>();
  const systems = new Map<string, unknown>();
  const combatState = new Map<string, string>();
  const combatCalls: CombatCall[] = [];

  const setPosition = (
    playerId: string,
    position: [number, number, number],
  ): boolean => {
    const entity = entities.get(playerId);
    if (!entity) return false;
    entity.position.set(position[0], position[1], position[2]);
    return true;
  };

  const combatSystem = {
    startCombat: (attackerId: string, targetId: string) => {
      const attacker = entities.get(attackerId);
      const target = entities.get(targetId);
      if (!attacker?.isAlive() || !target?.isAlive()) return false;
      combatCalls.push({ attackerId, targetId, source: "combat-system" });
      combatState.set(attackerId, targetId);
      attacker.data.inCombat = true;
      attacker.data.combatTarget = targetId;
      attacker.data.attackTarget = targetId;
      return true;
    },
    isInCombat: (playerId: string) => combatState.has(playerId),
    getCombatData: (playerId: string) => {
      const targetId = combatState.get(playerId);
      return targetId ? { targetId, inCombat: true } : null;
    },
    forceEndCombat: (playerId: string) => {
      combatState.delete(playerId);
      const entity = entities.get(playerId);
      if (!entity) return;
      entity.data.inCombat = false;
      entity.data.combatTarget = null;
      entity.data.attackTarget = null;
      entity.data.c = false;
      entity.data.ct = null;
    },
  };

  const networkSystem = {
    send: vi.fn(),
    sendToSpectators: vi.fn(),
    syncStreamingContestants: vi.fn(),
    requestServerAttack: (
      attackerId: string,
      targetId: string,
      _targetType: "mob" | "player",
    ) => {
      combatCalls.push({ attackerId, targetId, source: "agent-controller" });
      return combatSystem.startCombat(attackerId, targetId);
    },
    requestServerCombatApproach: (playerId: string, targetId: string) => {
      const target = entities.get(targetId);
      if (!target) return false;
      return setPosition(playerId, [
        target.position.x + 1,
        target.position.y,
        target.position.z,
      ]);
    },
    requestServerMove: (playerId: string, target: [number, number, number]) =>
      setPosition(playerId, target),
    cancelServerMove: () => true,
    getServerMovementDebug: () => ({
      activePath: false,
      currentTile: null,
      nextTile: null,
      destinationTile: null,
      remainingPathTiles: 0,
      moveSeq: 0,
    }),
    getPlayerWeaponRange: () => 7,
  };

  const world = Object.assign(emitter, {
    isServer: true,
    currentTick: 1,
    $eventBus: eventBus,
    pgPool: pool,
    drizzleDb: db,
    settings: { avatar: { url: "asset://avatars/steve.vrm" } },
    network: networkSystem,
    chat: { add: vi.fn() },
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
      add: (entityData: Record<string, unknown>) => {
        const id = String(entityData.id);
        const rawPosition = Array.isArray(entityData.position)
          ? entityData.position
          : [0, 0, 0];
        const data: Record<string, unknown> = {
          ...entityData,
          type: String(entityData.type ?? "player"),
          position: [
            Number(rawPosition[0] ?? 0),
            Number(rawPosition[1] ?? 0),
            Number(rawPosition[2] ?? 0),
          ],
          alive: true,
          deathState: "alive",
          inCombat: false,
          combatTarget: null,
          attackTarget: null,
        };
        const position = {
          x: Number(rawPosition[0] ?? 0),
          y: Number(rawPosition[1] ?? 0),
          z: Number(rawPosition[2] ?? 0),
          set(x: number, y: number, z: number): void {
            this.x = x;
            this.y = y;
            this.z = z;
            data.position = [x, y, z];
          },
        };
        const entity: TestEntity = {
          id,
          type: String(entityData.type ?? "player"),
          isAgent: entityData.isAgent === true,
          isEmbeddedAgent: entityData.isAgent === true,
          position,
          data,
          stats: {
            prayer: { level: STARTING_PRAYER_POINTS, xp: 0 },
            combatBonuses: { prayerBonus: 0 },
          },
          serialize: () => ({ ...data }),
          isAlive: () => Number(data.health ?? 0) > 0,
          isDead: () => Number(data.health ?? 0) <= 0,
          modify: (changes) => Object.assign(data, changes),
          markNetworkDirty: () => undefined,
        };
        entities.set(id, entity);
        return entity;
      },
      remove: (id: string) => entities.delete(id),
      values: () => entities.values(),
      getAllEntities: () => entities,
      [Symbol.iterator]: () => entities[Symbol.iterator](),
    },
    getPlayer: (id: string) => entities.get(id),
    getPlayers: () =>
      [...entities.values()].filter((entity) => entity.type === "player"),
    getSystem: (name: string) => systems.get(name),
  });

  systems.set("terrain", { getHeightAt: () => 0 });
  systems.set("movement", {
    requestMovement: setPosition,
    cancelMovement: () => undefined,
  });
  systems.set("combat", combatSystem);
  systems.set("network", networkSystem);

  world.on(
    "player:teleport",
    (payload: {
      playerId?: string;
      position?: { x?: number; y?: number; z?: number };
      rotation?: number;
    }) => {
      if (!payload.playerId || !payload.position) return;
      const entity = entities.get(payload.playerId);
      if (!entity) return;
      const x = Number(payload.position.x);
      const y = Number(payload.position.y);
      const z = Number(payload.position.z);
      if (![x, y, z].every(Number.isFinite)) return;
      entity.position.set(x, y, z);
      if (Number.isFinite(payload.rotation)) {
        entity.data.rotation = payload.rotation;
      }
    },
  );

  return {
    world: world as unknown as World,
    eventBus,
    systems,
    entities,
    combatCalls,
  };
}

describeDatabase("persisted AgentManager streaming duel cycle", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let databaseSystem: DatabaseSystem;
  let inventorySystem: CharacterInventorySystem;
  let equipmentSystem: CharacterEquipmentSystem;
  let prayerSystem: PrayerSystem;
  let manager: AgentManager;
  let scheduler: StreamingDuelScheduler;
  let runtime: ReturnType<typeof createPersistedRuntimeWorld>;
  let previousManager: AgentManager | null;
  const priorItems = new Map<string, unknown>();
  const priorEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of [
      "NODE_ENV",
      "STREAMING_DUEL_ENABLED",
      "STREAMING_DUEL_PREPARATION_MS",
      "STREAMING_PERSIST_STATS",
      "STREAMING_AGENT_SKIP_DB_LOAD",
      "STREAMING_DUEL_COMBAT_AI_ENABLED",
      "EMBEDDED_AGENT_DUEL_PREPARATION_LLM",
    ]) {
      priorEnvironment.set(key, process.env[key]);
    }
    // Source-level Vitest execution has no competitive-build manifest beside
    // the TypeScript module. A development source identity remains attestable
    // while, unlike the broad unit-test fixture allowance, keeping these
    // persisted contestants on the real non-diagnostic custody path.
    // Production bundles are verified separately and must carry their
    // generated manifest.
    process.env.NODE_ENV = "development";
    process.env.STREAMING_DUEL_ENABLED = "true";
    process.env.STREAMING_DUEL_PREPARATION_MS = "60000";
    process.env.STREAMING_PERSIST_STATS = "false";
    process.env.STREAMING_AGENT_SKIP_DB_LOAD = "false";
    process.env.STREAMING_DUEL_COMBAT_AI_ENABLED = "true";
    process.env.EMBEDDED_AGENT_DUEL_PREPARATION_LLM = "false";

    prayerDataProvider.loadPrayers(prayersManifest);
    prayerDataProvider.rebuild();
    for (const item of [
      ...weaponsManifest,
      ...ammunitionManifest,
      ...runesManifest,
      ...foodManifest,
    ]) {
      if (!FIXTURE_ITEM_IDS.has(item.id)) continue;
      priorItems.set(item.id, ITEMS.get(item.id));
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

    databaseName = `hyperia_agent_duel_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 12 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../../database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }

    db = drizzle(pool, { schema });
    const createdAt = "2026-08-11T00:00:00.000Z";
    await db.insert(schema.users).values(
      AGENT_IDS.map((agentId, index) => ({
        id: `account-${index + 1}-${agentId}`,
        name: `Duel Account ${index + 1}`,
        roles: "user",
        createdAt,
      })),
    );
    await db.insert(schema.characters).values(
      AGENT_IDS.map((agentId, index) => ({
        id: agentId,
        accountId: `account-${index + 1}-${agentId}`,
        name: index === 0 ? "Persisted Alpha" : "Persisted Beta",
        isAgent: 1,
        combatLevel: 45,
        attackLevel: 40,
        strengthLevel: 40,
        defenseLevel: 40,
        constitutionLevel: 40,
        rangedLevel: 40,
        magicLevel: 40,
        prayerLevel: STARTING_PRAYER_POINTS,
        prayerPoints: STARTING_PRAYER_POINTS,
        prayerPointUnits: STARTING_PRAYER_UNITS,
        prayerMaxPoints: STARTING_PRAYER_POINTS,
        activePrayers: ["thick_skin"],
        health: 40,
        maxHealth: 40,
        positionX: index * 4,
        positionY: 0,
        positionZ: index * 4,
      })),
    );
    await db.insert(schema.agentMappings).values(
      AGENT_IDS.map((agentId, index) => ({
        agentId: `eliza-${index + 1}-${agentId}`,
        accountId: `account-${index + 1}-${agentId}`,
        characterId: agentId,
        agentName: index === 0 ? "Persisted Alpha" : "Persisted Beta",
        streamingDuelEnabled: true,
      })),
    );
    await db.insert(schema.inventory).values(
      AGENT_IDS.flatMap((agentId) =>
        Array.from({ length: 4 }, (_, slotIndex) => ({
          playerId: agentId,
          itemId: "lobster",
          quantity: 1,
          slotIndex,
        })),
      ),
    );
    await db.insert(schema.equipment).values(
      AGENT_IDS.map((agentId) => ({
        playerId: agentId,
        slotType: "weapon",
        itemId: "bronze_longsword",
        quantity: 1,
      })),
    );
    await db.insert(schema.bankStorage).values(
      AGENT_IDS.flatMap((agentId) => [
        {
          playerId: agentId,
          itemId: "shortbow",
          quantity: 1,
          slot: 0,
          tabIndex: 0,
        },
        {
          playerId: agentId,
          itemId: "bronze_arrow",
          quantity: 100,
          slot: 1,
          tabIndex: 0,
        },
        {
          playerId: agentId,
          itemId: "staff_of_air",
          quantity: 1,
          slot: 2,
          tabIndex: 0,
        },
        {
          playerId: agentId,
          itemId: "fire_rune",
          quantity: 60,
          slot: 3,
          tabIndex: 0,
        },
        {
          playerId: agentId,
          itemId: "mind_rune",
          quantity: 20,
          slot: 4,
          tabIndex: 0,
        },
      ]),
    );

    runtime = createPersistedRuntimeWorld(pool, db);
    databaseSystem = new DatabaseSystem(runtime.world);
    runtime.systems.set("database", databaseSystem);
    await databaseSystem.init();

    inventorySystem = new CharacterInventorySystem(runtime.world);
    runtime.systems.set("inventory", inventorySystem);
    await inventorySystem.init();
    equipmentSystem = new CharacterEquipmentSystem(runtime.world);
    runtime.systems.set("equipment", equipmentSystem);
    await equipmentSystem.init();
    prayerSystem = new PrayerSystem(runtime.world);
    runtime.systems.set("prayer", prayerSystem);
    await prayerSystem.init();

    previousManager = getAgentManager();
    manager = new AgentManager(runtime.world, { startBehaviorBridge: false });
    setAgentManager(manager);
    for (const [index, agentId] of AGENT_IDS.entries()) {
      await manager.createAgent({
        characterId: agentId,
        accountId: `account-${index + 1}-${agentId}`,
        name: index === 0 ? "Persisted Alpha" : "Persisted Beta",
        scriptedRole: "combat",
        enableLlm: false,
        autoStart: true,
      });
      runtime.eventBus.emitEvent(
        EventType.PLAYER_JOINED,
        { playerId: agentId },
        "AgentDuelArena.integration",
      );
    }
    await runtime.eventBus.waitForPendingHandlers(15_000);
    await Promise.all(
      AGENT_IDS.map((agentId) => prayerSystem.waitForPrayerIdle(agentId)),
    );
    for (const agentId of AGENT_IDS) {
      const entity = runtime.entities.get(agentId)!;
      runtime.eventBus.emitEvent(
        EventType.SKILLS_UPDATED,
        { playerId: agentId, skills: entity.data.skills },
        "AgentDuelArena.integration",
      );
    }
    await waitForCondition(() => {
      for (const agentId of AGENT_IDS) {
        expect(inventorySystem.isInventoryReady(agentId)).toBe(true);
        expect(
          equipmentSystem.getPlayerEquipment(agentId)?.weapon?.itemId,
        ).toBe("bronze_longsword");
        expect(prayerSystem.getPrayerCustody(agentId)).toMatchObject({
          ready: true,
          persistenceHealthy: true,
          pointUnits: STARTING_PRAYER_UNITS,
          activePrayers: ["thick_skin"],
        });
      }
    });
    runtime.world.currentTick += 1;
  }, 60_000);

  afterEach(async () => {
    const cycle = scheduler?.getCurrentCycle();
    if (cycle) {
      // The test advances wall time across the betting/countdown boundaries.
      // Commit any failure-path cancellation before restoring Date.now so a
      // teardown cannot move terminalAt behind a persisted future milestone.
      const occurredAt = Math.max(
        Date.now(),
        cycle.phaseStartTime,
        cycle.betCloseTime ?? 0,
        cycle.fightStartTime ?? 0,
      );
      await (
        scheduler as unknown as {
          abortCycleToIdle(
            reason: string,
            occurredAtOverride?: number,
          ): Promise<void>;
        }
      ).abortCycleToIdle("integration_test_cleanup", occurredAt);
      await scheduler.waitForShutdownCleanup();
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    scheduler?.destroy("scheduler_shutdown");
    await scheduler?.waitForShutdownCleanup().catch(() => undefined);
    await manager?.shutdown().catch(() => undefined);
    if (previousManager) setAgentManager(previousManager);
    prayerSystem?.destroy();
    await equipmentSystem?.destroyAsync().catch(() => undefined);
    await inventorySystem?.destroyAsync().catch(() => undefined);
    databaseSystem?.destroy();

    for (const itemId of FIXTURE_ITEM_IDS) {
      const prior = priorItems.get(itemId);
      if (prior) ITEMS.set(itemId, prior as never);
      else ITEMS.delete(itemId);
    }
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    await pool?.end();
    if (adminPool && databaseName) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  }, 60_000);

  it("prepares, freezes, exercises every combat-role Prayer, drains, and tears down two persisted agents without custody loss", async () => {
    const preparationEvents: Array<{ event: string; payload: unknown }> = [];
    for (const event of [
      "duel:preparation:selected",
      "duel:preparation:agent_bank_status",
      "duel:preparation:agent_plan_status",
      "duel:preparation:ready",
      "duel:preparation:readiness",
      "duel:preparation:readiness_rejected",
      "duel:preparation:failed",
      "duel:preparation:cancelled",
    ]) {
      runtime.world.on(event, (payload: unknown) => {
        preparationEvents.push({ event, payload });
      });
    }
    scheduler = new StreamingDuelScheduler(runtime.world, {
      fencingToken: "1",
    });
    scheduler.init();

    // Drive the durable gate explicitly in this integration. Repeatedly
    // invoking the one-second scheduler reconciliation while the two readiness
    // writes are still committing manufactures concurrent launch attempts and
    // obscures the exact persisted lifecycle edge under test.
    const schedulerInternal = scheduler as unknown as {
      tickInterval: ReturnType<typeof setInterval> | null;
      preparationIdleCheckInFlight: boolean;
      advancePrivatePreparationGate(now: number): Promise<void>;
      orchestrator: {
        inspectCompetitiveLoadout(agentId: string):
          | {
              ok: true;
              initialCombatRole: string;
              availableCombatStyles: string[];
            }
          | { ok: false; reason: string };
        waitForPublicActionObservations(): Promise<void>;
      };
    };
    if (schedulerInternal.tickInterval) {
      clearInterval(schedulerInternal.tickInterval);
      schedulerInternal.tickInterval = null;
    }

    await waitForCondition(() => {
      expect(scheduler.getOperationalMetrics().current.availableAgents).toBe(2);
    });
    await waitForCondition(() => {
      expect(schedulerInternal.preparationIdleCheckInFlight).toBe(false);
    });
    await schedulerInternal.advancePrivatePreparationGate(Date.now());

    await waitForCondition(async () => {
      const durablePreparation = await pool.query<{
        status: string;
        agent1Id: string;
        agent2Id: string;
        agent1PlanEvidence: {
          primaryStyle: string;
          availableStyles: string[];
        } | null;
        agent2PlanEvidence: {
          primaryStyle: string;
          availableStyles: string[];
        } | null;
      }>(
        `SELECT status, "agent1Id", "agent2Id",
                "agent1PlanEvidence", "agent2PlanEvidence"
           FROM streaming_duel_preparations
          WHERE status = 'ready'
          ORDER BY "selectedAt" DESC
          LIMIT 1`,
      );
      expect(durablePreparation.rows).toHaveLength(1);
      const ready = durablePreparation.rows[0]!;
      const readiness1 =
        schedulerInternal.orchestrator.inspectCompetitiveLoadout(
          ready.agent1Id,
        );
      const readiness2 =
        schedulerInternal.orchestrator.inspectCompetitiveLoadout(
          ready.agent2Id,
        );
      expect(readiness1).toMatchObject({ ok: true });
      expect(readiness2).toMatchObject({ ok: true });
      if (!readiness1.ok || !readiness2.ok) return;
      expect({
        primaryStyle: readiness1.initialCombatRole,
        availableStyles: [...readiness1.availableCombatStyles].sort(),
      }).toEqual({
        primaryStyle: ready.agent1PlanEvidence?.primaryStyle,
        availableStyles: [
          ...(ready.agent1PlanEvidence?.availableStyles ?? []),
        ].sort(),
      });
      expect({
        primaryStyle: readiness2.initialCombatRole,
        availableStyles: [...readiness2.availableCombatStyles].sort(),
      }).toEqual({
        primaryStyle: ready.agent2PlanEvidence?.primaryStyle,
        availableStyles: [
          ...(ready.agent2PlanEvidence?.availableStyles ?? []),
        ].sort(),
      });
    }, 30_000);

    try {
      await schedulerInternal.advancePrivatePreparationGate(Date.now());
      await waitForCondition(() => {
        expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
      }, 30_000);
    } catch (error) {
      const durablePreparation = await pool.query(
        `SELECT "preparationId", status, version,
                "agent1ReadyAt", "agent2ReadyAt", "cancellationReason",
                "agent1PlanEvidence", "agent2PlanEvidence"
           FROM streaming_duel_preparations
          ORDER BY "selectedAt", "preparationId"`,
      );
      const durableTransitions = await pool.query(
        `SELECT "eventType", "preparationVersion", reason
           FROM streaming_duel_transition_events
          ORDER BY "eventSequence"`,
      );
      throw new Error(
        `persisted duel preparation did not open a public cycle: ${JSON.stringify(
          {
            cause: error instanceof Error ? error.message : String(error),
            operational: scheduler.getOperationalMetrics().current,
            preparationEvents,
            durablePreparation: durablePreparation.rows,
            durableTransitions: durableTransitions.rows,
          },
        )}`,
      );
    }

    const announcement = scheduler.getCurrentCycle();
    expect(announcement).not.toBeNull();
    expect(announcement?.competitiveSnapshot).toMatchObject({
      diagnostic: false,
      persisted: true,
      contestants: [
        expect.objectContaining({
          initialCombatStyle: "melee",
          availableCombatStyles: ["melee", "ranged", "mage"],
          prayer: expect.objectContaining({
            pointUnits: STARTING_PRAYER_UNITS,
            activePrayers: [],
          }),
          preparation: expect.objectContaining({
            primaryStyle: "melee",
            availableStyles: ["melee", "ranged", "mage"],
            planningSource: "deterministic",
            planningPolicyVersion: "duel-preparation-role-v3",
            tacticalStrategy: expect.objectContaining({
              prayer: "superhuman_strength",
            }),
          }),
        }),
        expect.objectContaining({
          initialCombatStyle: "melee",
          availableCombatStyles: ["melee", "ranged", "mage"],
          prayer: expect.objectContaining({
            pointUnits: STARTING_PRAYER_UNITS,
            activePrayers: [],
          }),
          preparation: expect.objectContaining({
            primaryStyle: "melee",
            availableStyles: ["melee", "ranged", "mage"],
            planningSource: "deterministic",
            planningPolicyVersion: "duel-preparation-role-v3",
            tacticalStrategy: expect.objectContaining({
              prayer: "superhuman_strength",
            }),
          }),
        }),
      ],
    });
    const frozenSnapshot = announcement!.competitiveSnapshot!;
    const frozenSnapshotDigest = announcement!.competitiveSnapshotDigest!;
    expect(digestCompetitiveSnapshot(frozenSnapshot)).toBe(
      frozenSnapshotDigest,
    );
    for (const publicAgent of [
      scheduler.getStreamingState().cycle.agent1,
      scheduler.getStreamingState().cycle.agent2,
    ]) {
      expect(publicAgent?.strategySummary).toEqual({
        schemaVersion: 1,
        approach: "balanced",
        tacticalMacro: "pressure",
        attackStyle: "aggressive",
        prayer: "superhuman_strength",
        preferredCombatRole: null,
        foodThreshold: 40,
        switchDefensiveAt: 30,
        source: "deterministic",
        policyVersion: "duel-preparation-role-v3",
      });
      expect(publicAgent?.strategySummary).not.toHaveProperty(
        "decisionOutcome",
      );
      expect(publicAgent?.strategySummary).not.toHaveProperty(
        "decisionLatencyMs",
      );
      expect(publicAgent?.strategySummary).not.toHaveProperty("reasoning");
    }

    const preFightPrayerOperations = await pool.query<{
      playerId: string;
      transition: string | null;
      pointUnits: number | null;
      activePrayers: string[] | null;
    }>(
      `SELECT "playerId",
              "operationState"->>'transition' AS transition,
              ("operationState"->'committed'->>'pointUnits')::int AS "pointUnits",
              ARRAY(
                SELECT jsonb_array_elements_text(
                  "operationState"->'committed'->'activePrayers'
                )
              ) AS "activePrayers"
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
          AND "operationType" = 'prayer_state_transition'
        ORDER BY "playerId", timestamp, id`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      expect(
        preFightPrayerOperations.rows.filter((row) => row.playerId === agentId),
      ).toEqual([
        {
          playerId: agentId,
          transition: "deactivate_all",
          pointUnits: STARTING_PRAYER_UNITS,
          activePrayers: [],
        },
      ]);
      expect(prayerSystem.getPrayerCustody(agentId)).toMatchObject({
        pointUnits: STARTING_PRAYER_UNITS,
        activePrayers: [],
      });
    }

    const persistedFreeze = await pool.query<{
      preparationStatus: string;
      lifecycleStatus: string;
      snapshot: Record<string, unknown>;
    }>(
      `SELECT p.status AS "preparationStatus",
              s."lifecycleStatus",
              s.snapshot
         FROM streaming_duel_preparations p
         JOIN streaming_duel_competitive_snapshots s
           ON s."preparationId" = p."preparationId"
        WHERE s."cycleId" = $1`,
      [announcement!.cycleId],
    );
    expect(persistedFreeze.rows).toEqual([
      expect.objectContaining({
        preparationStatus: "frozen",
        lifecycleStatus: "frozen",
        snapshot: expect.objectContaining({ diagnostic: false }),
      }),
    ]);
    expect(persistedFreeze.rows[0]!.snapshot).toEqual(frozenSnapshot);
    expect(
      digestCompetitiveSnapshot(
        persistedFreeze.rows[0]!.snapshot as CompetitiveSnapshot,
      ),
    ).toBe(frozenSnapshotDigest);

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(announcement!.betCloseTime!);
    await (
      scheduler as unknown as {
        startCountdown(): Promise<void>;
      }
    ).startCountdown();
    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    const countdown = scheduler.getCurrentCycle()!;
    nowSpy.mockReturnValue(countdown.fightStartTime!);
    await (
      scheduler as unknown as {
        doStartFight(now: number): Promise<void>;
      }
    ).doStartFight(countdown.fightStartTime!);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    await waitForCondition(() => {
      expect(scheduler.getCombatAIDiagnostics()).toHaveLength(2);
    });
    const countdownPrayerOperationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
          AND "operationType" = 'prayer_state_transition'`,
      [AGENT_IDS],
    );
    expect(countdownPrayerOperationCount.rows).toEqual([{ count: "2" }]);
    const combatAIs = (
      scheduler as unknown as {
        orchestrator: {
          combatAIs: Map<string, { externalTick(): Promise<void> }>;
        };
      }
    ).orchestrator.combatAIs;
    const completeExecutorCommand =
      databaseSystem.completeStreamingDuelExecutorCommandAsync.bind(
        databaseSystem,
      );
    const executorCompletionRequests: Array<
      Parameters<DatabaseSystem["completeStreamingDuelExecutorCommandAsync"]>[0]
    > = [];
    const injectedCompletionResponseLosses = new Set<
      "movement" | "engagement"
    >();
    vi.spyOn(
      databaseSystem,
      "completeStreamingDuelExecutorCommandAsync",
    ).mockImplementation(async (request) => {
      executorCompletionRequests.push(request);
      const receipt = await completeExecutorCommand(request);
      const action = request.publicActionObservation.action;
      if (!injectedCompletionResponseLosses.has(action)) {
        injectedCompletionResponseLosses.add(action);
        throw new Error(`injected_${action}_completion_response_loss`);
      }
      return receipt;
    });
    let publicExecutorObservations = scheduler
      .getStreamingState()
      .cycle.actionObservations.filter(
        ({ action }) => action === "movement" || action === "engagement",
      );
    const observedRolesByAgent = new Map(
      AGENT_IDS.map((agentId) => [agentId, new Set<string>()]),
    );
    const observedPrayersByAgent = new Map(
      AGENT_IDS.map((agentId) => [agentId, new Set<string>()]),
    );
    const captureCombatState = (): void => {
      for (const diagnostic of scheduler.getCombatAIDiagnostics()) {
        observedRolesByAgent
          .get(diagnostic.characterId as (typeof AGENT_IDS)[number])
          ?.add(diagnostic.combatRole);
      }
      for (const agentId of AGENT_IDS) {
        for (const prayerId of prayerSystem.getPrayerCustody(agentId)
          .activePrayers) {
          observedPrayersByAgent.get(agentId)!.add(prayerId);
        }
      }
    };
    captureCombatState();
    for (let tick = 0; tick < 36; tick += 1) {
      runtime.world.currentTick += 1;
      // The stable actor order is intentional: each controller observes the
      // opponent's newly committed weapon before choosing its counter-role.
      // This drives both persisted agents through all three legal roles using
      // the ordinary production counter-selection path rather than mutating a
      // test-only strategy or calling the loadout boundary directly.
      for (const agentId of AGENT_IDS) {
        await combatAIs.get(agentId)!.externalTick();
      }
      await Promise.all(
        AGENT_IDS.map((agentId) => prayerSystem.waitForPrayerIdle(agentId)),
      );
      await schedulerInternal.orchestrator.waitForPublicActionObservations();
      captureCombatState();
      publicExecutorObservations = scheduler
        .getStreamingState()
        .cycle.actionObservations.filter(
          ({ action }) => action === "movement" || action === "engagement",
        );
      const bothControllersReachedExecutorBoundary = AGENT_IDS.every(
        (agentId) => {
          const actions = new Set(
            publicExecutorObservations
              .filter(({ actorId }) => actorId === agentId)
              .map(({ action }) => action),
          );
          return actions.has("movement") && actions.has("engagement");
        },
      );
      const allRolePrayerPairsObserved = AGENT_IDS.every((agentId) => {
        const roles = observedRolesByAgent.get(agentId)!;
        const prayers = observedPrayersByAgent.get(agentId)!;
        return (
          ["melee", "ranged", "mage"].every((role) => roles.has(role)) &&
          ["superhuman_strength", "hawk_eye", "mystic_lore"].every((prayerId) =>
            prayers.has(prayerId),
          )
        );
      });
      if (bothControllersReachedExecutorBoundary && allRolePrayerPairsObserved)
        break;
    }
    await Promise.all(
      AGENT_IDS.map((agentId) => prayerSystem.waitForPrayerIdle(agentId)),
    );

    const finalCombatDiagnostics = scheduler.getCombatAIDiagnostics();
    for (const diagnostic of finalCombatDiagnostics) {
      expect(diagnostic).toMatchObject({
        prayerToggleAttempts: 7,
        prayerToggleCommits: 7,
        prayerToggleRejects: 0,
        successfulRoleSwitches: 3,
        roleSwitchFailures: 0,
      });
      expect(diagnostic.tickCount).toBeGreaterThanOrEqual(32);
    }
    const finalRoleByAgent = new Map(
      finalCombatDiagnostics.map((diagnostic) => [
        diagnostic.characterId,
        diagnostic.combatRole,
      ]),
    );
    expect([...finalRoleByAgent.entries()]).toEqual([
      [AGENT_IDS[0], "mage"],
      [AGENT_IDS[1], "melee"],
    ]);
    const prayerForRole = (role: string | undefined): string =>
      role === "mage"
        ? "mystic_lore"
        : role === "ranged"
          ? "hawk_eye"
          : "superhuman_strength";
    for (const agentId of AGENT_IDS) {
      expect([...observedRolesByAgent.get(agentId)!].sort()).toEqual([
        "mage",
        "melee",
        "ranged",
      ]);
      expect([...observedPrayersByAgent.get(agentId)!].sort()).toEqual([
        "hawk_eye",
        "mystic_lore",
        "superhuman_strength",
      ]);
      expect(prayerSystem.getPrayerCustody(agentId)).toMatchObject({
        pointUnits: STARTING_PRAYER_UNITS,
        activePrayers: [prayerForRole(finalRoleByAgent.get(agentId))],
      });
    }
    expect(
      runtime.combatCalls.filter((call) => call.source === "agent-controller"),
    ).toEqual(
      expect.arrayContaining(
        AGENT_IDS.map((attackerId) => expect.objectContaining({ attackerId })),
      ),
    );
    await schedulerInternal.orchestrator.waitForPublicActionObservations();
    expect([...injectedCompletionResponseLosses].sort()).toEqual([
      "engagement",
      "movement",
    ]);
    for (const action of ["movement", "engagement"] as const) {
      const requestsByOperation = new Map<
        string,
        typeof executorCompletionRequests
      >();
      for (const request of executorCompletionRequests) {
        if (request.publicActionObservation.action !== action) continue;
        const requests = requestsByOperation.get(request.operationId) ?? [];
        requests.push(request);
        requestsByOperation.set(request.operationId, requests);
      }
      const reconciled = [...requestsByOperation.values()].filter(
        (requests) => requests.length >= 2,
      );
      expect(reconciled.length).toBeGreaterThanOrEqual(1);
      for (const exactRetries of reconciled) {
        expect(exactRetries.length).toBeLessThanOrEqual(4);
        for (const retry of exactRetries.slice(1)) {
          expect(retry).toEqual(exactRetries[0]);
        }
      }
    }
    for (const agentId of AGENT_IDS) {
      const observations = publicExecutorObservations.filter(
        ({ actorId }) => actorId === agentId,
      );
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "movement",
            outcome: "accepted",
          }),
          expect.objectContaining({
            action: "engagement",
            outcome: "accepted",
          }),
        ]),
      );
    }

    processDrainTicks(prayerSystem, 4);
    await Promise.all(
      AGENT_IDS.map((agentId) => prayerSystem.waitForPrayerIdle(agentId)),
    );
    const expectedAfterDrain = STARTING_PRAYER_UNITS - 400_000;
    for (const agentId of AGENT_IDS) {
      expect(prayerSystem.getPrayerCustody(agentId)).toMatchObject({
        pointUnits: expectedAfterDrain,
        activePrayers: [prayerForRole(finalRoleByAgent.get(agentId))],
      });
    }

    nowSpy.mockReturnValue(countdown.fightStartTime! + 5_000);
    await (
      scheduler as unknown as {
        abortCycleToIdle(reason: string): Promise<void>;
      }
    ).abortCycleToIdle("operator_cancelled");
    await scheduler.waitForShutdownCleanup();
    nowSpy.mockRestore();

    expect(scheduler.getCurrentCycle()).toBeNull();
    for (const agentId of AGENT_IDS) {
      expect(prayerSystem.getPrayerCustody(agentId)).toMatchObject({
        ready: true,
        persistenceHealthy: true,
        pointUnits: expectedAfterDrain,
        activePrayers: [],
      });
    }

    const persistedTerminal = await pool.query<{
      lifecycleStatus: string;
      terminalCancellationReason: string | null;
      snapshotDigest: string;
      snapshot: Record<string, unknown>;
    }>(
      `SELECT "lifecycleStatus", "terminalCancellationReason",
              "snapshotDigest", snapshot
         FROM streaming_duel_competitive_snapshots
        WHERE "cycleId" = $1`,
      [announcement!.cycleId],
    );
    expect(persistedTerminal.rows).toEqual([
      {
        lifecycleStatus: "retired",
        terminalCancellationReason: "operator_cancelled",
        snapshotDigest: frozenSnapshotDigest,
        snapshot: frozenSnapshot,
      },
    ]);
    const terminalTransition = await pool.query<{
      snapshotDigest: string | null;
      terminalOutcome: string | null;
      reason: string | null;
    }>(
      `SELECT "snapshotDigest", "terminalOutcome", reason
         FROM streaming_duel_transition_events
        WHERE "cycleId" = $1
          AND "eventType" = 'terminal_committed'`,
      [announcement!.cycleId],
    );
    expect(terminalTransition.rows).toEqual([
      {
        snapshotDigest: frozenSnapshotDigest,
        terminalOutcome: "cancelled",
        reason: "operator_cancelled",
      },
    ]);

    const persistedPrayer = await pool.query<{
      id: string;
      prayerPointUnits: number;
      activePrayers: string[];
    }>(
      `SELECT id,
              "prayerPointUnits",
              "activePrayers"
         FROM characters
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [AGENT_IDS],
    );
    expect(persistedPrayer.rows).toEqual(
      [...AGENT_IDS].sort().map((id) => ({
        id,
        prayerPointUnits: expectedAfterDrain,
        activePrayers: [],
      })),
    );

    const operationEvidence = await pool.query<{
      playerId: string;
      operationType: string;
      id: string;
      completed: boolean;
      transition: string | null;
      executorAction: string | null;
      executorOutcome: string | null;
      publicActionValue: string | null;
      operationVersion: number | null;
      decisionOutcome: string | null;
      decisionLatencyMs: number | null;
    }>(
      `SELECT "playerId",
              "operationType",
              id,
              completed,
              "operationState"->>'transition' AS transition,
              "operationState"->'publicActionObservation'->>'action' AS "executorAction",
              "operationState"->>'outcome' AS "executorOutcome",
              "operationState"->'publicActionObservation'->>'value' AS "publicActionValue",
              ("operationState"->>'version')::int AS "operationVersion",
              "operationState"->'recoveryEvidence'->>'decisionOutcome' AS "decisionOutcome",
              ("operationState"->'recoveryEvidence'->>'decisionLatencyMs')::int AS "decisionLatencyMs"
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
        ORDER BY "playerId", timestamp, id`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      const operations = operationEvidence.rows.filter(
        (row) => row.playerId === agentId,
      );
      const planOperations = operations.filter(
        (row) => row.operationType === "duel_preparation_plan",
      );
      expect(planOperations).toEqual([
        expect.objectContaining({
          completed: true,
          operationVersion: 3,
          decisionOutcome: "deterministic_runtime_unavailable",
          decisionLatencyMs: expect.any(Number),
        }),
      ]);
      expect(planOperations[0]!.decisionLatencyMs).toBeGreaterThanOrEqual(0);
      expect(planOperations[0]!.decisionLatencyMs).toBeLessThanOrEqual(10_000);
      const executorOperations = operations.filter(
        (row) => row.operationType === "streaming_duel_executor_command",
      );
      expect(executorOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            completed: true,
            executorAction: "movement",
            executorOutcome: "accepted",
          }),
          expect.objectContaining({
            completed: true,
            executorAction: "engagement",
            executorOutcome: "accepted",
          }),
        ]),
      );
      const drainOperations = operations.filter(
        (row) =>
          row.operationType === "prayer_state_transition" &&
          row.transition === "drain",
      );
      // Drain ticks may coalesce before or after the first transaction yields;
      // custody and the bounded number of durable receipts are the invariant.
      expect(drainOperations.length).toBeGreaterThanOrEqual(1);
      expect(drainOperations.length).toBeLessThanOrEqual(4);
      expect(new Set(drainOperations.map((row) => row.id)).size).toBe(
        drainOperations.length,
      );
      const toggleOperations = operations.filter(
        (row) =>
          row.operationType === "prayer_state_transition" &&
          row.transition === "toggle",
      );
      expect(toggleOperations).toHaveLength(7);
      expect(
        [
          ...new Set(toggleOperations.map((row) => row.publicActionValue)),
        ].sort(),
      ).toEqual(["hawk_eye", "mystic_lore", "superhuman_strength"]);
      const deactivateAllOperations = operations.filter(
        (row) =>
          row.operationType === "prayer_state_transition" &&
          row.transition === "deactivate_all",
      );
      expect(deactivateAllOperations).toHaveLength(2);
      expect(
        deactivateAllOperations.some((row) =>
          row.id.startsWith("market-freeze-prayer:"),
        ),
      ).toBe(true);
      expect(deactivateAllOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `duel-prayer-teardown:${announcement!.cycleId}:${agentId}`,
          }),
        ]),
      );
      const roleSwitchOperations = operations.filter(
        (row) => row.operationType === "combat_loadout_switch",
      );
      expect(roleSwitchOperations).toHaveLength(3);
      expect(
        [
          ...new Set(roleSwitchOperations.map((row) => row.publicActionValue)),
        ].sort(),
      ).toEqual(["mage", "melee", "ranged"]);
    }

    const durableExecutorObservations = await pool.query<{
      operationId: string;
      actorId: string;
      action: string;
      outcome: string;
    }>(
      `SELECT "operationId",
              "actorId",
              action,
              observation->>'outcome' AS outcome
         FROM streaming_duel_action_observations
        WHERE "cycleId" = $1
          AND action IN ('movement', 'engagement')
        ORDER BY sequence`,
      [announcement!.cycleId],
    );
    const executorOperations = operationEvidence.rows.filter(
      (row) => row.operationType === "streaming_duel_executor_command",
    );
    expect(
      durableExecutorObservations.rows
        .map((row) => ({
          operationId: row.operationId,
          actorId: row.actorId,
          action: row.action,
          outcome: row.outcome,
        }))
        .sort((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
    ).toEqual(
      executorOperations
        .map((row) => ({
          operationId: row.id,
          actorId: row.playerId,
          action: row.executorAction,
          outcome: row.executorOutcome,
        }))
        .sort((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
    );

    const durableRolePrayerObservations = await pool.query<{
      operationId: string;
      actorId: string;
      action: string;
      outcome: string;
      value: string;
    }>(
      `SELECT "operationId",
              "actorId",
              action,
              observation->>'outcome' AS outcome,
              observation->>'value' AS value
         FROM streaming_duel_action_observations
        WHERE "cycleId" = $1
          AND action IN ('prayer', 'role_switch')
        ORDER BY sequence`,
      [announcement!.cycleId],
    );
    for (const agentId of AGENT_IDS) {
      const observations = durableRolePrayerObservations.rows.filter(
        (row) => row.actorId === agentId,
      );
      expect(
        observations.filter((row) => row.action === "prayer"),
      ).toHaveLength(7);
      expect(
        [
          ...new Set(
            observations
              .filter((row) => row.action === "prayer")
              .map((row) => row.value),
          ),
        ].sort(),
      ).toEqual(["hawk_eye", "mystic_lore", "superhuman_strength"]);
      expect(
        observations
          .filter((row) => row.action === "role_switch")
          .map((row) => row.value)
          .sort(),
      ).toEqual(["mage", "melee", "ranged"]);
      expect(observations.every((row) => row.outcome === "committed")).toBe(
        true,
      );
    }
    for (const observation of durableRolePrayerObservations.rows) {
      const operation = operationEvidence.rows.find(
        (row) => row.id === observation.operationId,
      );
      expect(operation).toMatchObject({
        playerId: observation.actorId,
        operationType:
          observation.action === "prayer"
            ? "prayer_state_transition"
            : "combat_loadout_switch",
        completed: true,
        executorAction: observation.action,
        publicActionValue: observation.value,
      });
    }

    const conservedItems = await pool.query<{
      playerId: string;
      itemId: string;
      quantity: number;
      custody: string;
    }>(
      `SELECT custody."playerId",
              custody."itemId",
              sum(custody.quantity)::int AS quantity,
              custody.custody
         FROM (
           SELECT "playerId", "itemId", quantity, 'inventory'::text AS custody
             FROM inventory
            WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'equipment'::text AS custody
             FROM equipment
            WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'bank'::text AS custody
             FROM bank_storage
            WHERE "playerId" = ANY($1::text[])
         ) custody
        GROUP BY custody."playerId", custody."itemId", custody.custody
        ORDER BY custody."playerId", custody.custody, custody."itemId"`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      const rows = conservedItems.rows.filter(
        (row) => row.playerId === agentId,
      );
      const totals = Object.fromEntries(
        [...new Set(rows.map((row) => row.itemId))]
          .sort()
          .map((itemId) => [
            itemId,
            rows
              .filter((row) => row.itemId === itemId)
              .reduce((total, row) => total + row.quantity, 0),
          ]),
      );
      expect(totals).toEqual({
        bronze_arrow: 100,
        bronze_longsword: 1,
        fire_rune: 60,
        lobster: 4,
        mind_rune: 20,
        shortbow: 1,
        staff_of_air: 1,
      });
      const finalRole = finalRoleByAgent.get(agentId);
      const expectedWeapon =
        finalRole === "mage"
          ? "staff_of_air"
          : finalRole === "ranged"
            ? "shortbow"
            : "bronze_longsword";
      expect(rows.filter((row) => row.custody === "equipment")).toEqual([
        {
          playerId: agentId,
          itemId: expectedWeapon,
          quantity: 1,
          custody: "equipment",
        },
        ...(finalRole === "ranged"
          ? [
              {
                playerId: agentId,
                itemId: "bronze_arrow",
                quantity: 50,
                custody: "equipment",
              },
            ]
          : []),
      ]);
    }
  }, 60_000);
});
