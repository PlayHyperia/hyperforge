import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import EventEmitter from "node:events";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  AttackType,
  CharacterEquipmentSystem,
  CharacterInventorySystem,
  COMBAT_CONSTANTS,
  CombatSystem,
  EventBus,
  EventType,
  ITEMS,
  PRAYER_POINT_UNITS_PER_POINT,
  PrayerSystem,
  PlayerSystem,
  prayerDataProvider,
  type World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import ammunitionManifest from "../world/assets/manifests/items/ammunition.json";
import foodManifest from "../world/assets/manifests/items/food.json";
import runesManifest from "../world/assets/manifests/items/runes.json";
import weaponsManifest from "../world/assets/manifests/items/weapons.json";
import prayersManifest from "../world/assets/manifests/prayers.json";
import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { AgentManager, setAgentManager } from "../src/eliza/AgentManager.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import { StreamingDuelScheduler } from "../src/systems/StreamingDuelScheduler/index.js";
import {
  AGENT_DUEL_COMBAT_ROLE as CHAOS_COMBAT_ROLE,
  AGENT_DUEL_ROLE_FIXTURE as ROLE_FIXTURE,
  AGENT_DUEL_ROLE_FIXTURES,
} from "./agent-duel-role-fixtures.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const STARTING_PRAYER_POINTS = 39;
const STARTING_PRAYER_UNITS =
  STARTING_PRAYER_POINTS * PRAYER_POINT_UNITS_PER_POINT;
const EXPECTED_DRAINED_PRAYER_UNITS = STARTING_PRAYER_UNITS - 400_000;
const EXPECTED_TWICE_DRAINED_PRAYER_UNITS = STARTING_PRAYER_UNITS - 800_000;
export const AGENT_IDS = [
  "persisted-cycle-chaos-alpha",
  "persisted-cycle-chaos-beta",
] as const;

const EXPECTED_PRAYER_ID = ROLE_FIXTURE.prayerId;
const rawCombinedMultiStyle =
  process.env.AGENT_DUEL_COMBINED_MULTI_STYLE?.trim();
if (
  rawCombinedMultiStyle !== undefined &&
  rawCombinedMultiStyle !== "true" &&
  rawCombinedMultiStyle !== "false"
) {
  throw new Error("AGENT_DUEL_COMBINED_MULTI_STYLE must be true or false");
}
export const AGENT_DUEL_COMBINED_MULTI_STYLE = rawCombinedMultiStyle === "true";
const FIXTURE_ITEM_IDS = new Set([
  ROLE_FIXTURE.weaponId,
  "lobster",
  ...(ROLE_FIXTURE.equippedAmmunition
    ? [ROLE_FIXTURE.equippedAmmunition.itemId]
    : []),
  ...ROLE_FIXTURE.inventorySupplies.map(({ itemId }) => itemId),
  ...(AGENT_DUEL_COMBINED_MULTI_STYLE
    ? Object.values(AGENT_DUEL_ROLE_FIXTURES).flatMap((fixture) => [
        fixture.weaponId,
        ...(fixture.equippedAmmunition
          ? [fixture.equippedAmmunition.itemId]
          : []),
        ...fixture.inventorySupplies.map(({ itemId }) => itemId),
      ])
    : []),
]);

function minimumXpForLevel(level: number): number {
  let cumulative = 0;
  for (let nextLevel = 2; nextLevel <= level; nextLevel += 1) {
    const increment =
      Math.floor(nextLevel - 1 + 300 * Math.pow(2, (nextLevel - 1) / 7)) / 4;
    cumulative = Math.floor(cumulative + increment);
  }
  return cumulative;
}

type WorkerEvent = {
  event:
    | "frozen"
    | "database_unavailable"
    | "recovered"
    | "fighting"
    | "cancelled_after_restart"
    | "error";
  cycleId?: string;
  duelId?: string;
  preparationId?: string;
  digest?: string;
  betCloseTime?: number;
  lifecycleStatus?: string;
  prayerPointUnits?: number;
  combatRole?: ChaosCombatRole;
  message?: string;
};

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
  getHealth(): number;
  isAlive(): boolean;
  isDead(): boolean;
  setHealth(health: number): void;
  setHealthAndMaxHealth(health: number, maxHealth: number): void;
  resetDeathState(): void;
  getComponent(name: string): { data: Record<string, unknown> } | null;
  modify(changes: Record<string, unknown>): void;
  markNetworkDirty(): void;
};

type CombatCall = {
  attackerId: string;
  targetId: string;
  source: "combat-system" | "agent-controller";
};

export type RuntimeWorld = ReturnType<typeof createRuntimeWorld>;

export type WorkerRuntime = RuntimeWorld & {
  pool: pg.Pool;
  databaseSystem: DatabaseSystem;
  inventorySystem: CharacterInventorySystem;
  equipmentSystem: CharacterEquipmentSystem;
  prayerSystem: PrayerSystem;
  playerSystem: PlayerSystem;
  manager: AgentManager;
};

export type AuthoritativeCombatRuntime = {
  combatSystem: CombatSystem;
  destroy(): void;
};

export type NaturalCombatTerminalEvidence = {
  authoritativeCombatTicks: number;
  diagnostics: ReturnType<StreamingDuelScheduler["getCombatAIDiagnostics"]>;
  antiCheatDiagnostics: Array<{
    agentId: string;
    score: number;
    attacksThisTick: number;
    violationCount: number;
    lastViolations: ReturnType<
      CombatSystem["antiCheat"]["getPlayerReport"]
    >["recentViolations"];
  }>;
  projectileDiagnostics: ReturnType<
    CombatSystem["getProjectileLifecycleDiagnostics"]
  >;
  resolvedCycle: NonNullable<
    ReturnType<StreamingDuelScheduler["getCurrentCycle"]>
  >;
};

type NaturalCombatTraceStage = "before_ai" | "after_ai" | "after_combat";

type NaturalCombatTraceSample = {
  stage: NaturalCombatTraceStage;
  driverTick: number;
  worldTick: number;
  contestants: Array<{
    agentId: string;
    position: [number, number, number] | null;
    tile: { x: number; z: number } | null;
    health: number | null;
    combat: {
      inCombat: boolean;
      targetId: string | null;
      lastAttackTick: number | null;
      nextAttackTick: number | null;
      combatEndTick: number | null;
    } | null;
  }>;
};

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${description} timed out${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

function processDrainTicks(system: PrayerSystem, count: number): void {
  const processDrainTick = (
    system as unknown as { processDrainTick(): void }
  ).processDrainTick.bind(system);
  for (let index = 0; index < count; index += 1) processDrainTick();
}

function installFixtureManifests(): void {
  prayerDataProvider.loadPrayers(prayersManifest);
  prayerDataProvider.rebuild();
  for (const item of [
    ...weaponsManifest,
    ...ammunitionManifest,
    ...runesManifest,
    ...foodManifest,
  ]) {
    if (!FIXTURE_ITEM_IDS.has(item.id)) continue;
    const combatFixture = Object.values(AGENT_DUEL_ROLE_FIXTURES).find(
      (fixture) => fixture.weaponId === item.id,
    );
    ITEMS.set(item.id, {
      ...item,
      ...(combatFixture ? { attackType: combatFixture.attackType } : {}),
    } as never);
  }
}

function createRuntimeWorld(
  pool: pg.Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  const emitter = new EventEmitter();
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
    send: () => undefined,
    sendToSpectators: () => undefined,
    syncStreamingContestants: () => undefined,
    requestServerAttack: (
      attackerId: string,
      targetId: string,
      _targetType: "mob" | "player",
    ) => {
      combatCalls.push({ attackerId, targetId, source: "agent-controller" });
      return combatSystem.startCombat(attackerId, targetId);
    },
    requestServerCombatApproach: (playerId: string, targetId: string) => {
      const player = entities.get(playerId);
      const target = entities.get(targetId);
      if (!player || !target) return false;
      const playerTile = {
        x: Math.floor(player.position.x),
        z: Math.floor(player.position.z),
      };
      const targetTile = {
        x: Math.floor(target.position.x),
        z: Math.floor(target.position.z),
      };
      if (
        Math.abs(playerTile.x - targetTile.x) +
          Math.abs(playerTile.z - targetTile.z) ===
        1
      ) {
        return true;
      }
      const occupied = (x: number, z: number): boolean =>
        [...entities.values()].some(
          (entity) =>
            entity.id !== playerId &&
            entity.isAlive() &&
            Math.floor(entity.position.x) === x &&
            Math.floor(entity.position.z) === z,
        );
      const destination = [
        { x: targetTile.x + 1, z: targetTile.z },
        { x: targetTile.x - 1, z: targetTile.z },
        { x: targetTile.x, z: targetTile.z + 1 },
        { x: targetTile.x, z: targetTile.z - 1 },
      ]
        .filter((tile) => !occupied(tile.x, tile.z))
        .sort((left, right) => {
          const leftDistance =
            Math.abs(left.x - playerTile.x) + Math.abs(left.z - playerTile.z);
          const rightDistance =
            Math.abs(right.x - playerTile.x) + Math.abs(right.z - playerTile.z);
          return (
            leftDistance - rightDistance || left.x - right.x || left.z - right.z
          );
        })[0];
      return destination
        ? setPosition(playerId, [
            destination.x + 0.5,
            target.position.y,
            destination.z + 0.5,
          ])
        : false;
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
    getPlayerWeaponRange: () =>
      ROLE_FIXTURE.attackType === AttackType.MELEE
        ? 1
        : ROLE_FIXTURE.attackType === AttackType.MAGIC
          ? 10
          : Number(ITEMS.get(ROLE_FIXTURE.weaponId)?.attackRange ?? 7),
    getPlayerAttackType: () => ROLE_FIXTURE.attackType,
    isInAttackRange: (
      attackerTile: { x: number; z: number },
      targetTile: { x: number; z: number },
      attackType: AttackType,
      range: number,
    ) => {
      const dx = Math.abs(attackerTile.x - targetTile.x);
      const dz = Math.abs(attackerTile.z - targetTile.z);
      if (attackType === AttackType.MELEE && range === 1) {
        return dx + dz === 1;
      }
      const distance = Math.max(dx, dz);
      return distance > 0 && distance <= range;
    },
  };

  const world = Object.assign(emitter, {
    isServer: true,
    currentTick: 1,
    $eventBus: eventBus,
    pgPool: pool,
    drizzleDb: db,
    settings: { avatar: { url: "asset://avatars/steve.vrm" } },
    network: networkSystem,
    chat: { add: () => undefined },
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
        const statsData: Record<string, unknown> = {
          prayer: {
            level: STARTING_PRAYER_POINTS,
            xp: minimumXpForLevel(STARTING_PRAYER_POINTS),
          },
          combatBonuses: { prayerBonus: 0 },
          health: {
            current: Number(data.health ?? 0),
            max: Number(data.maxHealth ?? data.health ?? 0),
          },
          hitpoints: {
            current: Number(data.health ?? 0),
            max: Number(data.maxHealth ?? data.health ?? 0),
          },
        };
        const healthData: Record<string, unknown> = {
          current: Number(data.health ?? 0),
          max: Number(data.maxHealth ?? data.health ?? 0),
          isDead: Number(data.health ?? 0) <= 0,
        };
        const components = new Map<string, { data: Record<string, unknown> }>([
          ["stats", { data: statsData }],
          ["health", { data: healthData }],
        ]);
        const applyHealth = (health: number, maxHealth?: number): void => {
          const safeMax = Math.max(
            1,
            Math.floor(
              Number.isFinite(maxHealth)
                ? Number(maxHealth)
                : Number(data.maxHealth ?? health),
            ),
          );
          const safeHealth = Math.max(
            0,
            Math.min(safeMax, Math.floor(Number(health))),
          );
          data.health = safeHealth;
          data.maxHealth = safeMax;
          data.alive = safeHealth > 0;
          data.deathState = safeHealth > 0 ? "alive" : "dead";
          healthData.current = safeHealth;
          healthData.max = safeMax;
          healthData.isDead = safeHealth <= 0;
          for (const key of ["health", "hitpoints"] as const) {
            const pool = statsData[key] as
              { current?: number; max?: number } | undefined;
            if (pool) {
              pool.current = safeHealth;
              pool.max = safeMax;
            }
          }
        };
        const entity: TestEntity = {
          id,
          type: String(entityData.type ?? "player"),
          isAgent: entityData.isAgent === true,
          isEmbeddedAgent: entityData.isAgent === true,
          position,
          data,
          stats: statsData as TestEntity["stats"],
          serialize: () => ({ ...data }),
          getHealth: () => Number(data.health ?? 0),
          isAlive: () => Number(data.health ?? 0) > 0,
          isDead: () => Number(data.health ?? 0) <= 0,
          setHealth: (health) => applyHealth(health),
          setHealthAndMaxHealth: (health, maxHealth) =>
            applyHealth(health, maxHealth),
          resetDeathState: () => {
            data.alive = Number(data.health ?? 0) > 0;
            data.deathState = "alive";
          },
          getComponent: (name) => components.get(name) ?? null,
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

export async function startWorkerRuntime(
  connectionString: string,
): Promise<WorkerRuntime> {
  installFixtureManifests();
  const pool = new pg.Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
  });
  const db = drizzle(pool, { schema });
  const runtime = createRuntimeWorld(pool, db);
  const databaseSystem = new DatabaseSystem(runtime.world);
  runtime.systems.set("database", databaseSystem);
  await databaseSystem.init();

  const inventorySystem = new CharacterInventorySystem(runtime.world);
  runtime.systems.set("inventory", inventorySystem);
  await inventorySystem.init();
  const equipmentSystem = new CharacterEquipmentSystem(runtime.world);
  runtime.systems.set("equipment", equipmentSystem);
  await equipmentSystem.init();
  const prayerSystem = new PrayerSystem(runtime.world);
  runtime.systems.set("prayer", prayerSystem);
  await prayerSystem.init();
  const playerSystem = new PlayerSystem(runtime.world);
  runtime.systems.set("player", playerSystem);
  await playerSystem.init();

  const manager = new AgentManager(runtime.world, {
    startBehaviorBridge: false,
  });
  setAgentManager(manager);
  for (const [index, agentId] of AGENT_IDS.entries()) {
    await manager.createAgent({
      characterId: agentId,
      accountId: `account-${index + 1}-${agentId}`,
      name: index === 0 ? "Persisted Chaos Alpha" : "Persisted Chaos Beta",
      scriptedRole: "combat",
      enableLlm: false,
      autoStart: true,
    });
    runtime.eventBus.emitEvent(
      EventType.PLAYER_JOINED,
      { playerId: agentId },
      "agent-duel-cycle-process-kill",
    );
  }
  await runtime.eventBus.waitForPendingHandlers(15_000);
  await waitFor(
    () => AGENT_IDS.every((agentId) => playerSystem.getPlayer(agentId)),
    "persisted PlayerSystem hydration",
  );
  for (const agentId of AGENT_IDS) {
    runtime.eventBus.emitEvent(
      EventType.PLAYER_REGISTERED,
      { playerId: agentId },
      "agent-duel-cycle-process-kill",
    );
  }
  await waitFor(
    () =>
      AGENT_IDS.every((agentId) => playerSystem.getPlayerAttackStyle(agentId)),
    "persisted attack-style hydration",
  );
  await Promise.all(
    AGENT_IDS.map((agentId) => prayerSystem.waitForPrayerIdle(agentId)),
  );
  for (const agentId of AGENT_IDS) {
    const entity = runtime.entities.get(agentId);
    if (!entity) throw new Error(`persisted agent ${agentId} was not spawned`);
    const persistedPlayer = playerSystem.getPlayer(agentId);
    if (!persistedPlayer) {
      throw new Error(`persisted PlayerSystem state missing for ${agentId}`);
    }
    const statsComponent = entity.getComponent("stats");
    if (statsComponent?.data) {
      Object.assign(statsComponent.data, persistedPlayer.skills);
    }
    runtime.eventBus.emitEvent(
      EventType.SKILLS_UPDATED,
      {
        playerId: agentId,
        skills: persistedPlayer.skills,
        persistence: "already_committed",
      },
      "agent-duel-cycle-process-kill",
    );
  }
  await runtime.eventBus.waitForPendingHandlers(15_000);
  await waitFor(
    () =>
      AGENT_IDS.every((agentId) => {
        const equipment = equipmentSystem.getPlayerEquipment(agentId);
        return (
          inventorySystem.isInventoryReady(agentId) &&
          equipment?.weapon?.itemId === ROLE_FIXTURE.weaponId &&
          (ROLE_FIXTURE.equippedAmmunition === null ||
            equipment?.arrows?.itemId ===
              ROLE_FIXTURE.equippedAmmunition.itemId) &&
          prayerSystem.getPrayerCustody(agentId).ready &&
          prayerSystem.getPrayerCustody(agentId).persistenceHealthy
        );
      }),
    "persisted worker runtime readiness",
  );
  runtime.world.currentTick += 1;
  return {
    ...runtime,
    pool,
    databaseSystem,
    inventorySystem,
    equipmentSystem,
    prayerSystem,
    playerSystem,
    manager,
  };
}

/**
 * Replace the engagement-only combat fixture with the production combat
 * authority after the persisted contestants have hydrated. This is opt-in so
 * process-kill lifecycle tests can retain their deliberately inert fight edge,
 * while the joined launch proof can exercise real projectile, damage, food,
 * and terminal custody against the same runtime and database.
 */
export async function installAuthoritativeCombatRuntime(
  runtime: WorkerRuntime,
): Promise<AuthoritativeCombatRuntime> {
  const entityRegistry = runtime.world.entities as unknown as {
    players?: Map<string, TestEntity>;
  };
  entityRegistry.players = runtime.entities;
  runtime.systems.set("entity-manager", {
    getEntity: (id: string) => runtime.entities.get(id),
  });

  const previousCombat = runtime.systems.get("combat");
  const combatSystem = new CombatSystem(runtime.world);
  runtime.systems.set("combat", combatSystem);
  await combatSystem.init();

  const network = runtime.systems.get("network") as {
    requestServerAttack?: (
      attackerId: string,
      targetId: string,
      targetType: "mob" | "player",
    ) => boolean;
    requestServerCombatApproach?: (
      playerId: string,
      targetId: string,
    ) => boolean;
    getPlayerWeaponRange: (playerId: string) => number;
    getPlayerAttackType: (playerId: string) => AttackType;
    isInAttackRange: (
      attackerTile: { x: number; z: number },
      targetTile: { x: number; z: number },
      attackType: AttackType,
      range: number,
    ) => boolean;
  };
  const previousRequestServerAttack = network.requestServerAttack;
  const previousGetPlayerWeaponRange = network.getPlayerWeaponRange;
  const previousGetPlayerAttackType = network.getPlayerAttackType;
  const getEquippedWeapon = (playerId: string) => {
    const equipment = runtime.equipmentSystem.getPlayerEquipment(playerId);
    const weaponSlot = equipment?.weapon;
    const weaponId = String(
      weaponSlot?.itemId ?? weaponSlot?.item?.id ?? "",
    ).trim();
    return weaponId ? ITEMS.get(weaponId) : undefined;
  };
  network.getPlayerAttackType = (playerId) => {
    const attackType = getEquippedWeapon(playerId)?.attackType;
    return attackType === AttackType.RANGED || attackType === AttackType.MAGIC
      ? attackType
      : AttackType.MELEE;
  };
  network.getPlayerWeaponRange = (playerId) => {
    const weapon = getEquippedWeapon(playerId);
    if (network.getPlayerAttackType(playerId) === AttackType.MELEE) return 1;
    const range = Number(weapon?.attackRange);
    return Number.isFinite(range) && range > 0 ? range : 1;
  };
  network.requestServerAttack = (attackerId, targetId, targetType) => {
    const attacker = runtime.entities.get(attackerId);
    const target = runtime.entities.get(targetId);
    if (!attacker?.isAlive() || !target?.isAlive()) return false;
    const attackType = network.getPlayerAttackType(attackerId);
    const attackRange = network.getPlayerWeaponRange(attackerId);
    if (
      !network.isInAttackRange(
        {
          x: Math.floor(attacker.position.x),
          z: Math.floor(attacker.position.z),
        },
        {
          x: Math.floor(target.position.x),
          z: Math.floor(target.position.z),
        },
        attackType,
        attackRange,
      )
    ) {
      return false;
    }
    runtime.eventBus.emitEvent(
      EventType.COMBAT_ATTACK_REQUEST,
      {
        attackerId,
        targetId,
        attackerType: "player",
        targetType,
        attackType,
      },
      "agent-duel-authoritative-combat-runtime",
    );
    return true;
  };

  // The production world bridges typed system events into its public emitter.
  // This compact runtime has no EventBridge system, so install the exact three
  // scheduler-facing signals needed for damage, healing, and terminal death.
  const publicEventTypes = [
    EventType.COMBAT_DAMAGE_DEALT,
    EventType.ENTITY_HEALED,
    EventType.ENTITY_DEATH,
  ] as const;
  const bridgeSubscriptions = publicEventTypes.map((eventType) =>
    runtime.eventBus.subscribe(eventType, (event) => {
      runtime.world.emit(eventType, event.data);
    }),
  );
  bridgeSubscriptions.push(
    runtime.eventBus.subscribe(
      EventType.COMBAT_FOLLOW_TARGET,
      (event: {
        data: {
          playerId: string;
          targetId: string;
        };
      }) => {
        network.requestServerCombatApproach?.(
          event.data.playerId,
          event.data.targetId,
        );
      },
    ),
  );

  for (const agentId of AGENT_IDS) {
    runtime.eventBus.emitEvent(
      EventType.PLAYER_JOINED,
      { playerId: agentId },
      "agent-duel-authoritative-combat-runtime",
    );
  }
  // This compact harness swaps CombatSystem into an already hydrated world.
  // Its replacement PLAYER_JOINED handlers must finish before the scheduler
  // can create combat state; otherwise a late join reset can erase a valid
  // engagement after fight start. The production world initializes systems
  // before admitting players, so make that ordering explicit here as well.
  await runtime.eventBus.waitForPendingHandlers(15_000);
  const pendingJoinHandlers = runtime.eventBus.getPendingHandlerBreakdown();
  if (pendingJoinHandlers.length > 0) {
    throw new Error(
      `authoritative combat hydration timed out: ${JSON.stringify(pendingJoinHandlers)}`,
    );
  }

  let destroyed = false;
  return {
    combatSystem,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const subscription of bridgeSubscriptions) {
        subscription.unsubscribe();
      }
      network.requestServerAttack = previousRequestServerAttack;
      network.getPlayerWeaponRange = previousGetPlayerWeaponRange;
      network.getPlayerAttackType = previousGetPlayerAttackType;
      combatSystem.destroy();
      runtime.systems.set("combat", previousCombat);
    },
  };
}

export async function stopWorkerRuntime(runtime: WorkerRuntime): Promise<void> {
  await runtime.manager.shutdown().catch(() => undefined);
  runtime.prayerSystem.destroy();
  runtime.playerSystem.destroy();
  await runtime.equipmentSystem.destroyAsync().catch(() => undefined);
  await runtime.inventorySystem.destroyAsync().catch(() => undefined);
  runtime.databaseSystem.destroy();
  await runtime.pool.end().catch(() => undefined);
}

export function schedulerInternals(scheduler: StreamingDuelScheduler) {
  return scheduler as unknown as {
    tickInterval: ReturnType<typeof setInterval> | null;
    preparationIdleCheckInFlight: boolean;
    advancePrivatePreparationGate(now: number): Promise<void>;
    startCountdown(): Promise<void>;
    abortCycleToIdle(reason: string): Promise<void>;
    orchestrator: {
      combatAIs: Map<string, { externalTick(): Promise<void> }>;
      stopCombatLoop(): void;
      runCombatAITickOnce(): Promise<void>;
      waitForCombatAITick(): Promise<void>;
    };
  };
}

/**
 * Drive the compact persisted-worker fixture through the same authoritative
 * combat authority used by the server world. The scheduler retains ownership
 * of agent-controller cadence and terminal persistence; this helper advances
 * only the world and CombatSystem ticks that a full server loop would own.
 */
export async function driveAuthoritativeCombatToNaturalTerminal(
  runtime: WorkerRuntime,
  scheduler: StreamingDuelScheduler,
  authoritativeCombat: AuthoritativeCombatRuntime,
  options: { combatTimeoutMs?: number } = {},
): Promise<NaturalCombatTerminalEvidence> {
  const initialCycle = scheduler.getCurrentCycle();
  if (
    initialCycle?.phase !== "ANNOUNCEMENT" ||
    !Number.isSafeInteger(initialCycle.betCloseTime)
  ) {
    throw new Error(
      `natural combat driver requires an announced cycle with an immutable close: ${JSON.stringify(initialCycle)}`,
    );
  }

  const internal = schedulerInternals(scheduler);
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, (initialCycle.betCloseTime as number) - Date.now() + 10),
    ),
  );
  await internal.startCountdown();
  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "COUNTDOWN",
    "authoritative natural countdown",
  );
  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "FIGHTING",
    "authoritative natural fight",
    15_000,
  );
  await waitFor(
    () => scheduler.getCombatAIDiagnostics().length === 2,
    "authoritative natural combat controllers",
  );
  // The production server has one scheduler interval and one world tick. This
  // compact gate advances the world manually, so stop the scheduler interval
  // and drive each controller exactly once per synthetic tick. Waiting for
  // global EventBus quiescence while that interval remained live allowed new
  // attack requests to replace the promise being observed and could starve the
  // world clock even though every individual database commit was fast.
  internal.orchestrator.stopCombatLoop();
  await internal.orchestrator.waitForCombatAITick();

  const combatTimeoutMs = options.combatTimeoutMs ?? 300_000;
  if (
    !Number.isSafeInteger(combatTimeoutMs) ||
    combatTimeoutMs < 10_000 ||
    combatTimeoutMs > 900_000
  ) {
    throw new Error(
      "combatTimeoutMs must be an integer between 10000 and 900000",
    );
  }
  const fightDeadline = Date.now() + combatTimeoutMs;
  let authoritativeCombatTicks = 0;
  let diagnostics = scheduler.getCombatAIDiagnostics();
  const captureControllerDiagnostics = (): void => {
    const observed = scheduler.getCombatAIDiagnostics();
    // Terminal presentation intentionally clears the live controller map. Keep
    // the final complete pre-teardown snapshot instead of replacing it with an
    // empty post-resolution lifecycle observation.
    if (observed.length > 0) diagnostics = observed;
  };
  const initialCombatTrace: NaturalCombatTraceSample[] = [];
  const recentCombatTrace: NaturalCombatTraceSample[] = [];
  const captureCombatTrace = (stage: NaturalCombatTraceStage): void => {
    const sample: NaturalCombatTraceSample = {
      stage,
      driverTick: authoritativeCombatTicks,
      worldTick: runtime.world.currentTick,
      contestants: AGENT_IDS.map((agentId) => {
        const entity = runtime.world.entities.get(agentId);
        const combatData =
          authoritativeCombat.combatSystem.getCombatData(agentId);
        const position = entity?.position
          ? ([entity.position.x, entity.position.y, entity.position.z] as [
              number,
              number,
              number,
            ])
          : null;
        return {
          agentId,
          position,
          tile: position
            ? { x: Math.floor(position[0]), z: Math.floor(position[2]) }
            : null,
          health: entity ? entity.getHealth() : null,
          combat: combatData
            ? {
                inCombat: combatData.inCombat === true,
                targetId:
                  combatData.targetId === undefined ||
                  combatData.targetId === null
                    ? null
                    : String(combatData.targetId),
                lastAttackTick: Number.isFinite(combatData.lastAttackTick)
                  ? combatData.lastAttackTick
                  : null,
                nextAttackTick: Number.isFinite(combatData.nextAttackTick)
                  ? combatData.nextAttackTick
                  : null,
                combatEndTick: Number.isFinite(combatData.combatEndTick)
                  ? combatData.combatEndTick
                  : null,
              }
            : null,
        };
      }),
    };
    if (initialCombatTrace.length < 12) initialCombatTrace.push(sample);
    recentCombatTrace.push(sample);
    if (recentCombatTrace.length > 18) recentCombatTrace.shift();
  };
  const summarizeAntiCheat = (agentId: string) => {
    const report =
      authoritativeCombat.combatSystem.antiCheat.getPlayerReport(agentId);
    return {
      score: report.score,
      attacksThisTick: report.attacksThisTick,
      violationCount: report.recentViolations.length,
      lastViolations: report.recentViolations.slice(-8),
    };
  };
  const getAntiCheatDiagnostics = () =>
    AGENT_IDS.map((agentId) => ({
      agentId,
      ...summarizeAntiCheat(agentId),
    }));
  const getProjectileDiagnostics = (): ReturnType<
    CombatSystem["getProjectileLifecycleDiagnostics"]
  > => {
    const snapshot =
      authoritativeCombat.combatSystem.getProjectileLifecycleDiagnostics();
    return {
      ...snapshot,
      recent: snapshot.recent.slice(-18),
    };
  };
  const combatFailureEvidence = () => {
    const combatSystem = authoritativeCombat.combatSystem;
    return {
      authoritativeCombatTicks,
      worldTick: runtime.world.currentTick,
      diagnostics,
      projectileDiagnostics: getProjectileDiagnostics(),
      damageReconciliation: combatSystem.getDuelDamageReconciliationStats(),
      pendingEventHandlers: runtime.eventBus.getPendingHandlerBreakdown(),
      eventHandlerDiagnostics: runtime.eventBus.getAsyncHandlerDiagnostics(),
      initialCombatTrace,
      recentCombatTrace,
      contestants: getAntiCheatDiagnostics().map((antiCheat) => {
        const agentId = antiCheat.agentId;
        const entity = runtime.world.entities.get(agentId);
        return {
          agentId,
          position: entity?.data.position ?? null,
          health: entity?.data.health ?? null,
          combatData: combatSystem.getCombatData(agentId),
          antiCheat,
        };
      }),
    };
  };
  const assertNoAntiCheatViolations = (stage: string): void => {
    if (
      getAntiCheatDiagnostics().every(
        ({ score, violationCount }) => score === 0 && violationCount === 0,
      )
    ) {
      return;
    }
    throw new Error(
      `authoritative natural combat anti-cheat violation: ${JSON.stringify({
        stage,
        ...combatFailureEvidence(),
      })}`,
    );
  };
  const assertNoOverdueEventHandlers = (stage: string): void => {
    const pendingEventHandlers = runtime.eventBus.getPendingHandlerBreakdown();
    if (pendingEventHandlers.length === 0) return;
    const combatSystem = authoritativeCombat.combatSystem;
    throw new Error(
      `authoritative natural combat event handler deadline exceeded: ${JSON.stringify(
        {
          stage,
          authoritativeCombatTicks,
          worldTick: runtime.world.currentTick,
          pendingEventHandlers,
          eventHandlerDiagnostics:
            runtime.eventBus.getAsyncHandlerDiagnostics(),
          diagnostics: scheduler.getCombatAIDiagnostics(),
          damageReconciliation: combatSystem.getDuelDamageReconciliationStats(),
          contestants: AGENT_IDS.map((agentId) => {
            const entity = runtime.world.entities.get(agentId);
            return {
              agentId,
              position: entity?.data.position ?? null,
              health: entity?.data.health ?? null,
              combatData: combatSystem.getCombatData(agentId),
            };
          }),
        },
      )}`,
    );
  };
  while (
    scheduler.getCurrentCycle()?.phase === "FIGHTING" &&
    Date.now() < fightDeadline
  ) {
    runtime.world.currentTick += 1;
    authoritativeCombatTicks += 1;
    captureCombatTrace("before_ai");
    await internal.orchestrator.runCombatAITickOnce();
    await runtime.eventBus.waitForPendingHandlers(15_000);
    assertNoOverdueEventHandlers("after_ai_tick");
    captureControllerDiagnostics();
    captureCombatTrace("after_ai");
    assertNoAntiCheatViolations("after_ai_tick");
    authoritativeCombat.combatSystem.processCombatTick(
      runtime.world.currentTick,
    );
    await runtime.eventBus.waitForPendingHandlers(15_000);
    assertNoOverdueEventHandlers("after_combat_tick");
    await waitFor(
      () =>
        authoritativeCombat.combatSystem.getDuelDamageReconciliationStats()
          .pendingOperations === 0,
      "authoritative natural damage settlement",
      15_000,
    );
    captureCombatTrace("after_combat");
    assertNoAntiCheatViolations("after_combat_tick");
    if (scheduler.getCurrentCycle()?.phase === "FIGHTING") {
      captureControllerDiagnostics();
    }
    if (scheduler.getCurrentCycle()?.phase !== "FIGHTING") break;
    await new Promise((resolve) =>
      setTimeout(resolve, COMBAT_CONSTANTS.TICK_DURATION_MS),
    );
  }

  if (scheduler.getCurrentCycle()?.phase === "FIGHTING") {
    throw new Error(
      `authoritative natural combat deadline exceeded: ${JSON.stringify(combatFailureEvidence())}`,
    );
  }

  const terminalPhase = scheduler.getCurrentCycle()?.phase ?? null;
  if (terminalPhase !== "RESOLUTION") {
    throw new Error(
      `authoritative natural combat left fighting without a resolution: ${JSON.stringify(
        { terminalPhase, ...combatFailureEvidence() },
      )}`,
    );
  }

  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "RESOLUTION",
    "authoritative natural persisted resolution",
    15_000,
  );
  await scheduler.waitForCombatCustodySettlements();
  await runtime.eventBus.waitForPendingHandlers(15_000);
  const resolvedCycle = scheduler.getCurrentCycle();
  if (!resolvedCycle) {
    throw new Error("authoritative natural terminal disappeared");
  }
  return {
    authoritativeCombatTicks,
    diagnostics,
    antiCheatDiagnostics: getAntiCheatDiagnostics(),
    projectileDiagnostics: getProjectileDiagnostics(),
    resolvedCycle,
  };
}

export async function openPersistedCycle(
  runtime: WorkerRuntime,
  scheduler: StreamingDuelScheduler,
): Promise<NonNullable<ReturnType<StreamingDuelScheduler["getCurrentCycle"]>>> {
  const internal = schedulerInternals(scheduler);
  if (internal.tickInterval) {
    clearInterval(internal.tickInterval);
    internal.tickInterval = null;
  }
  await waitFor(
    () => scheduler.getOperationalMetrics().current.availableAgents === 2,
    "two persisted contestants",
  );
  await waitFor(
    () => !internal.preparationIdleCheckInFlight,
    "initial preparation reconciliation",
  );
  await internal.advancePrivatePreparationGate(Date.now());
  await waitFor(async () => {
    const ready = await runtime.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM streaming_duel_preparations
        WHERE status = 'ready'
          AND "agent1PlanEvidence" IS NOT NULL
          AND "agent2PlanEvidence" IS NOT NULL`,
    );
    return ready.rows[0]?.count === "1";
  }, "durable two-agent preparation readiness");
  await waitFor(
    () => !internal.preparationIdleCheckInFlight,
    "ready preparation reconciliation",
  );
  await internal.advancePrivatePreparationGate(Date.now());
  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "ANNOUNCEMENT",
    "frozen announcement cycle",
  );
  const cycle = scheduler.getCurrentCycle();
  if (!cycle) throw new Error("persisted cycle disappeared after freeze");
  return cycle;
}

async function runFreezeWorker(): Promise<void> {
  const connectionString = process.env.AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("agent duel cycle freeze worker database URL is missing");
  }
  const runtime = await startWorkerRuntime(connectionString);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "1",
  });
  scheduler.init();
  const cycle = await openPersistedCycle(runtime, scheduler);
  if (
    !cycle?.competitiveSnapshot?.persisted ||
    !cycle.competitiveSnapshotDigest ||
    !cycle.competitiveSnapshot.preparationId ||
    !cycle.duelId ||
    !cycle.betCloseTime
  ) {
    throw new Error("freeze worker did not expose persisted snapshot identity");
  }
  const persisted = await runtime.pool.query<{
    lifecycleStatus: string;
    digest: string;
  }>(
    `SELECT "lifecycleStatus", "snapshotDigest" AS digest
       FROM streaming_duel_competitive_snapshots
      WHERE "cycleId" = $1`,
    [cycle.cycleId],
  );
  if (
    persisted.rows.length !== 1 ||
    persisted.rows[0]?.lifecycleStatus !== "frozen" ||
    persisted.rows[0]?.digest !== cycle.competitiveSnapshotDigest
  ) {
    throw new Error(
      `freeze worker durable snapshot drifted: ${JSON.stringify(persisted.rows)}`,
    );
  }
  emit({
    event: "frozen",
    cycleId: cycle.cycleId,
    duelId: cycle.duelId,
    preparationId: cycle.competitiveSnapshot.preparationId,
    digest: cycle.competitiveSnapshotDigest,
    betCloseTime: cycle.betCloseTime,
    lifecycleStatus: "frozen",
    combatRole: CHAOS_COMBAT_ROLE,
  });
  await new Promise<never>(() => undefined);
}

async function runRecoveryWorker(): Promise<void> {
  const connectionString = process.env.AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL;
  const expectedCycleId = process.env.AGENT_DUEL_CYCLE_CHAOS_CYCLE_ID;
  const expectedDigest = process.env.AGENT_DUEL_CYCLE_CHAOS_DIGEST;
  const expectedBetCloseTime = Number(
    process.env.AGENT_DUEL_CYCLE_CHAOS_BET_CLOSE_TIME,
  );
  if (
    !connectionString ||
    !expectedCycleId ||
    !expectedDigest ||
    !Number.isSafeInteger(expectedBetCloseTime)
  ) {
    throw new Error(
      "agent duel cycle recovery worker configuration is incomplete",
    );
  }

  const runtime = await startWorkerRuntime(connectionString);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "2",
  });
  scheduler.init();
  const internal = schedulerInternals(scheduler);
  let recoveryEvidence: WorkerEvent | null = null;
  try {
    await waitFor(() => {
      const cycle = scheduler.getCurrentCycle();
      return (
        cycle?.phase === "ANNOUNCEMENT" &&
        cycle.cycleId === expectedCycleId &&
        cycle.competitiveSnapshotDigest === expectedDigest &&
        cycle.betCloseTime === expectedBetCloseTime
      );
    }, "replacement authority snapshot recovery");
    if (Date.now() >= expectedBetCloseTime) {
      throw new Error(
        "replacement authority missed the immutable betting close",
      );
    }
    if (internal.tickInterval) {
      clearInterval(internal.tickInterval);
      internal.tickInterval = null;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expectedBetCloseTime - Date.now() + 10)),
    );
    await internal.startCountdown();
    await waitFor(
      () => scheduler.getCurrentCycle()?.phase === "COUNTDOWN",
      "recovered cycle countdown",
    );
    await waitFor(
      () => scheduler.getCurrentCycle()?.phase === "FIGHTING",
      "recovered cycle fight",
      15_000,
    );
    await waitFor(
      () => scheduler.getCombatAIDiagnostics().length === 2,
      "replacement combat controllers",
    );

    for (let tick = 0; tick < 5; tick += 1) {
      runtime.world.currentTick += 1;
      await Promise.all(
        [...internal.orchestrator.combatAIs.values()].map((ai) =>
          ai.externalTick(),
        ),
      );
    }
    await Promise.all(
      AGENT_IDS.map((agentId) =>
        runtime.prayerSystem.waitForPrayerIdle(agentId),
      ),
    );
    for (const agentId of AGENT_IDS) {
      const custody = runtime.prayerSystem.getPrayerCustody(agentId);
      if (
        custody.pointUnits !== STARTING_PRAYER_UNITS ||
        custody.activePrayers.join(",") !== EXPECTED_PRAYER_ID
      ) {
        throw new Error(
          `replacement combat prayer activation drifted for ${agentId}: ${JSON.stringify(custody)}`,
        );
      }
    }

    processDrainTicks(runtime.prayerSystem, 4);
    await Promise.all(
      AGENT_IDS.map((agentId) =>
        runtime.prayerSystem.waitForPrayerIdle(agentId),
      ),
    );
    for (const agentId of AGENT_IDS) {
      const custody = runtime.prayerSystem.getPrayerCustody(agentId);
      if (
        custody.pointUnits !== EXPECTED_DRAINED_PRAYER_UNITS ||
        custody.activePrayers.join(",") !== EXPECTED_PRAYER_ID
      ) {
        throw new Error(
          `replacement combat prayer drain drifted for ${agentId}: ${JSON.stringify(custody)}`,
        );
      }
    }

    await internal.abortCycleToIdle("operator_cancelled");
    await scheduler.waitForShutdownCleanup();
    await waitFor(
      () => scheduler.getCurrentCycle() === null,
      "cycle retirement",
    );
    for (const agentId of AGENT_IDS) {
      const custody = runtime.prayerSystem.getPrayerCustody(agentId);
      if (
        custody.pointUnits !== EXPECTED_DRAINED_PRAYER_UNITS ||
        custody.activePrayers.length !== 0
      ) {
        throw new Error(
          `terminal prayer custody drifted for ${agentId}: ${JSON.stringify(custody)}`,
        );
      }
    }
    const terminal = await runtime.pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      cancellationReason: string | null;
    }>(
      `SELECT "lifecycleStatus", "snapshotDigest",
              "terminalCancellationReason" AS "cancellationReason"
         FROM streaming_duel_competitive_snapshots
        WHERE "cycleId" = $1`,
      [expectedCycleId],
    );
    if (
      terminal.rows.length !== 1 ||
      terminal.rows[0]?.lifecycleStatus !== "retired" ||
      terminal.rows[0]?.snapshotDigest !== expectedDigest ||
      terminal.rows[0]?.cancellationReason !== "operator_cancelled"
    ) {
      throw new Error(
        `replacement terminal row drifted: ${JSON.stringify(terminal.rows)}`,
      );
    }
    recoveryEvidence = {
      event: "recovered",
      cycleId: expectedCycleId,
      digest: expectedDigest,
      betCloseTime: expectedBetCloseTime,
      lifecycleStatus: "retired",
      prayerPointUnits: EXPECTED_DRAINED_PRAYER_UNITS,
      combatRole: CHAOS_COMBAT_ROLE,
    };
  } finally {
    scheduler.destroy("scheduler_shutdown");
    await scheduler.waitForShutdownCleanup().catch(() => undefined);
    await stopWorkerRuntime(runtime);
  }
  if (!recoveryEvidence) {
    throw new Error("replacement authority produced no terminal evidence");
  }
  emit(recoveryEvidence);
}

async function runDatabaseOutageWorker(): Promise<void> {
  const connectionString = process.env.AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("agent duel cycle outage worker database URL is missing");
  }
  try {
    const runtime = await Promise.race([
      startWorkerRuntime(connectionString),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("database_unavailable_deadline")),
          5_000,
        ),
      ),
    ]);
    await stopWorkerRuntime(runtime);
    throw new Error("database outage worker unexpectedly initialized");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "database outage worker unexpectedly initialized"
    ) {
      throw error;
    }
    // Do not serialize connection strings or transport diagnostics. The
    // parent verifies the database was deliberately paused and that no
    // lifecycle row or fencing token changed before accepting this edge.
    emit({ event: "database_unavailable", combatRole: CHAOS_COMBAT_ROLE });
  }
}

async function runActiveFightWorker(): Promise<void> {
  const connectionString = process.env.AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("agent duel cycle fight worker database URL is missing");
  }
  const runtime = await startWorkerRuntime(connectionString);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "3",
  });
  scheduler.init();
  const internal = schedulerInternals(scheduler);
  const cycle = await openPersistedCycle(runtime, scheduler);
  if (
    !cycle.competitiveSnapshot?.persisted ||
    !cycle.competitiveSnapshotDigest ||
    !cycle.competitiveSnapshot.preparationId ||
    !cycle.duelId ||
    !cycle.betCloseTime
  ) {
    throw new Error("active-fight worker did not freeze persisted evidence");
  }

  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, cycle.betCloseTime! - Date.now() + 10)),
  );
  await internal.startCountdown();
  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "COUNTDOWN",
    "active-fight countdown",
  );
  await waitFor(
    () => scheduler.getCurrentCycle()?.phase === "FIGHTING",
    "active-fight combat start",
    15_000,
  );
  await waitFor(
    () => scheduler.getCombatAIDiagnostics().length === 2,
    "active-fight combat controllers",
  );
  for (let tick = 0; tick < 5; tick += 1) {
    runtime.world.currentTick += 1;
    await Promise.all(
      [...internal.orchestrator.combatAIs.values()].map((ai) =>
        ai.externalTick(),
      ),
    );
  }
  await Promise.all(
    AGENT_IDS.map((agentId) => runtime.prayerSystem.waitForPrayerIdle(agentId)),
  );
  for (const agentId of AGENT_IDS) {
    const custody = runtime.prayerSystem.getPrayerCustody(agentId);
    if (
      custody.pointUnits !== EXPECTED_DRAINED_PRAYER_UNITS ||
      custody.activePrayers.join(",") !== EXPECTED_PRAYER_ID
    ) {
      throw new Error(
        `active-fight Prayer activation drifted for ${agentId}: ${JSON.stringify(custody)}`,
      );
    }
  }
  processDrainTicks(runtime.prayerSystem, 4);
  await Promise.all(
    AGENT_IDS.map((agentId) => runtime.prayerSystem.waitForPrayerIdle(agentId)),
  );
  for (const agentId of AGENT_IDS) {
    const custody = runtime.prayerSystem.getPrayerCustody(agentId);
    if (
      custody.pointUnits !== EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
      custody.activePrayers.join(",") !== EXPECTED_PRAYER_ID
    ) {
      throw new Error(
        `active-fight Prayer drain drifted for ${agentId}: ${JSON.stringify(custody)}`,
      );
    }
  }
  const persisted = await runtime.pool.query<{
    lifecycleStatus: string;
    snapshotDigest: string;
    lockedAt: string | null;
    duelStartedAt: string | null;
    terminalAt: string | null;
  }>(
    `SELECT "lifecycleStatus", "snapshotDigest",
            "lockedAt"::text AS "lockedAt",
            "duelStartedAt"::text AS "duelStartedAt",
            "terminalAt"::text AS "terminalAt"
       FROM streaming_duel_competitive_snapshots
      WHERE "cycleId" = $1`,
    [cycle.cycleId],
  );
  if (
    persisted.rows.length !== 1 ||
    persisted.rows[0]?.lifecycleStatus !== "frozen" ||
    persisted.rows[0]?.snapshotDigest !== cycle.competitiveSnapshotDigest ||
    persisted.rows[0]?.lockedAt !== String(cycle.betCloseTime) ||
    !persisted.rows[0]?.duelStartedAt ||
    persisted.rows[0]?.terminalAt !== null
  ) {
    throw new Error(
      `active-fight durable state drifted: ${JSON.stringify(persisted.rows)}`,
    );
  }
  emit({
    event: "fighting",
    cycleId: cycle.cycleId,
    duelId: cycle.duelId,
    preparationId: cycle.competitiveSnapshot.preparationId,
    digest: cycle.competitiveSnapshotDigest,
    betCloseTime: cycle.betCloseTime,
    lifecycleStatus: "frozen",
    prayerPointUnits: EXPECTED_TWICE_DRAINED_PRAYER_UNITS,
    combatRole: CHAOS_COMBAT_ROLE,
  });
  await new Promise<never>(() => undefined);
}

async function runExpiredFightRecoveryWorker(): Promise<void> {
  const connectionString = process.env.AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL;
  const expectedCycleId = process.env.AGENT_DUEL_CYCLE_CHAOS_CYCLE_ID;
  const expectedDigest = process.env.AGENT_DUEL_CYCLE_CHAOS_DIGEST;
  const expectedBetCloseTime = Number(
    process.env.AGENT_DUEL_CYCLE_CHAOS_BET_CLOSE_TIME,
  );
  if (
    !connectionString ||
    !expectedCycleId ||
    !expectedDigest ||
    !Number.isSafeInteger(expectedBetCloseTime)
  ) {
    throw new Error(
      "expired-fight recovery worker configuration is incomplete",
    );
  }
  const runtime = await startWorkerRuntime(connectionString);
  const scheduler = new StreamingDuelScheduler(runtime.world, {
    fencingToken: "4",
  });
  scheduler.init();
  const internal = schedulerInternals(scheduler);
  if (internal.tickInterval) {
    clearInterval(internal.tickInterval);
    internal.tickInterval = null;
  }
  let recoveryEvidence: WorkerEvent | null = null;
  try {
    await waitFor(async () => {
      const terminal = await runtime.pool.query<{
        lifecycleStatus: string;
        snapshotDigest: string;
        cancellationReason: string | null;
        fencingToken: string;
      }>(
        `SELECT snapshot."lifecycleStatus", snapshot."snapshotDigest",
                snapshot."terminalCancellationReason" AS "cancellationReason",
                preparation."fencingToken"::text AS "fencingToken"
           FROM streaming_duel_competitive_snapshots snapshot
           JOIN streaming_duel_preparations preparation
             USING ("preparationId")
          WHERE snapshot."cycleId" = $1`,
        [expectedCycleId],
      );
      const row = terminal.rows[0];
      return (
        terminal.rows.length === 1 &&
        row?.lifecycleStatus === "retired" &&
        row.snapshotDigest === expectedDigest &&
        row.cancellationReason ===
          "competitive_snapshot_recovery_window_elapsed" &&
        row.fencingToken === "4"
      );
    }, "expired active-fight terminal recovery");
    await scheduler.waitForShutdownCleanup();
    await waitFor(
      () => scheduler.getCurrentCycle() === null,
      "expired active-fight cycle cleanup",
    );
    await Promise.all(
      AGENT_IDS.map((agentId) =>
        runtime.prayerSystem.waitForPrayerIdle(agentId),
      ),
    );
    for (const agentId of AGENT_IDS) {
      const custody = runtime.prayerSystem.getPrayerCustody(agentId);
      if (
        custody.pointUnits !== EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
        custody.activePrayers.length !== 0
      ) {
        throw new Error(
          `expired active-fight custody drifted for ${agentId}: ${JSON.stringify(custody)}`,
        );
      }
    }
    recoveryEvidence = {
      event: "cancelled_after_restart",
      cycleId: expectedCycleId,
      digest: expectedDigest,
      betCloseTime: expectedBetCloseTime,
      lifecycleStatus: "retired",
      prayerPointUnits: EXPECTED_TWICE_DRAINED_PRAYER_UNITS,
      combatRole: CHAOS_COMBAT_ROLE,
    };
  } finally {
    scheduler.destroy("scheduler_shutdown");
    await scheduler.waitForShutdownCleanup().catch(() => undefined);
    await stopWorkerRuntime(runtime);
  }
  if (!recoveryEvidence) {
    throw new Error("expired active-fight recovery produced no evidence");
  }
  emit(recoveryEvidence);
}

export async function docker(args: string[]): Promise<string> {
  const binary = process.env.DOCKER_BIN?.trim() || "docker";
  const result = await execFileAsync(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function waitForPostgres(
  connectionString: string,
): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new pg.Pool({ connectionString, max: 12 });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `temporary PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

function spawnWorker(input: {
  mode: "freeze" | "database-outage" | "recover" | "fight" | "recover-expired";
  connectionString: string;
  expected?: WorkerEvent;
}): { child: ChildProcess; event: Promise<WorkerEvent>; stderr: string[] } {
  const child = spawn(process.execPath, [scriptPath, `--${input.mode}`], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      STREAMING_DUEL_ENABLED: "true",
      STREAMING_DUEL_PREPARATION_MS: "60000",
      STREAMING_PERSIST_STATS: "false",
      STREAMING_AGENT_SKIP_DB_LOAD: "false",
      STREAMING_DUEL_COMBAT_AI_ENABLED: "true",
      EMBEDDED_AGENT_DUEL_PREPARATION_LLM: "false",
      STREAMING_ANNOUNCEMENT_MS: "15000",
      STREAMING_COUNTDOWN_TICKS: "1",
      STREAMING_FIGHTING_MS: "5000",
      AGENT_DUEL_CYCLE_CHAOS_DATABASE_URL: input.connectionString,
      AGENT_DUEL_CYCLE_CHAOS_ROLE: CHAOS_COMBAT_ROLE,
      AGENT_DUEL_CYCLE_CHAOS_CYCLE_ID: input.expected?.cycleId,
      AGENT_DUEL_CYCLE_CHAOS_DIGEST: input.expected?.digest,
      AGENT_DUEL_CYCLE_CHAOS_BET_CLOSE_TIME:
        input.expected?.betCloseTime?.toString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("agent duel cycle worker pipes were not created");
  }
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const event = new Promise<WorkerEvent>((resolveEvent, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(`agent duel cycle worker timed out: ${stderr.join("")}`),
        ),
      90_000,
    );
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (
            [
              "frozen",
              "database_unavailable",
              "recovered",
              "fighting",
              "cancelled_after_restart",
              "error",
            ].includes(parsed.event)
          ) {
            clearTimeout(timer);
            if (parsed.event === "error") {
              reject(new Error(parsed.message ?? "worker failed"));
            } else {
              resolveEvent(parsed);
            }
            return;
          }
        } catch {
          // Runtime diagnostics share stdout. Only explicit JSON events count.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") return;
      clearTimeout(timer);
      reject(
        new Error(
          `agent duel cycle worker exited ${code ?? signal}: ${stderr.join("")}`,
        ),
      );
    });
  });
  return { child, event, stderr };
}

async function waitForExit(
  child: ChildProcess,
  stderr: readonly string[] = [],
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`agent duel cycle worker did not exit: ${stderr.join("")}`),
        ),
      15_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

export async function seedAgents(
  db: ReturnType<typeof drizzle<typeof schema>>,
  options: { multiStyle?: boolean } = {},
): Promise<void> {
  const createdAt = "2026-08-11T00:00:00.000Z";
  const level40Xp = minimumXpForLevel(40);
  const startingPrayerXp = minimumXpForLevel(STARTING_PRAYER_POINTS);
  const magicLevel = options.multiStyle ? 40 : ROLE_FIXTURE.magicLevel;
  const roleMagicXp = minimumXpForLevel(magicLevel);
  await db.insert(schema.users).values(
    AGENT_IDS.map((agentId, index) => ({
      id: `account-${index + 1}-${agentId}`,
      name: `Duel Chaos Account ${index + 1}`,
      roles: "user",
      createdAt,
    })),
  );
  await db.insert(schema.characters).values(
    AGENT_IDS.map((agentId, index) => ({
      id: agentId,
      accountId: `account-${index + 1}-${agentId}`,
      name: index === 0 ? "Persisted Chaos Alpha" : "Persisted Chaos Beta",
      isAgent: 1,
      combatLevel: 45,
      attackLevel: 40,
      attackXp: level40Xp,
      strengthLevel: 40,
      strengthXp: level40Xp,
      defenseLevel: 40,
      defenseXp: level40Xp,
      constitutionLevel: 40,
      constitutionXp: level40Xp,
      rangedLevel: 40,
      rangedXp: level40Xp,
      magicLevel,
      magicXp: roleMagicXp,
      prayerLevel: STARTING_PRAYER_POINTS,
      prayerXp: startingPrayerXp,
      prayerPoints: STARTING_PRAYER_POINTS,
      prayerPointUnits: STARTING_PRAYER_UNITS,
      prayerMaxPoints: STARTING_PRAYER_POINTS,
      activePrayers: [],
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
      agentName: index === 0 ? "Persisted Chaos Alpha" : "Persisted Chaos Beta",
      streamingDuelEnabled: true,
    })),
  );
  await db.insert(schema.inventory).values(
    AGENT_IDS.flatMap((agentId) => [
      ...Array.from({ length: 4 }, (_, slotIndex) => ({
        playerId: agentId,
        itemId: "lobster",
        quantity: 1,
        slotIndex,
      })),
      ...ROLE_FIXTURE.inventorySupplies.map((supply, supplyIndex) => ({
        playerId: agentId,
        itemId: supply.itemId,
        quantity: supply.quantity,
        slotIndex: 4 + supplyIndex,
      })),
    ]),
  );
  await db.insert(schema.equipment).values(
    AGENT_IDS.flatMap((agentId) => {
      const equipment: Array<{
        playerId: string;
        slotType: string;
        itemId: string;
        quantity: number;
      }> = [
        {
          playerId: agentId,
          slotType: "weapon",
          itemId: ROLE_FIXTURE.weaponId,
          quantity: 1,
        },
      ];
      if (ROLE_FIXTURE.equippedAmmunition) {
        equipment.push({
          playerId: agentId,
          slotType: "arrows",
          itemId: ROLE_FIXTURE.equippedAmmunition.itemId,
          quantity: ROLE_FIXTURE.equippedAmmunition.quantity,
        });
      }
      return equipment;
    }),
  );
  if (options.multiStyle) {
    await db.insert(schema.bankStorage).values(
      AGENT_IDS.flatMap((agentId) =>
        [
          { itemId: "bronze_longsword", quantity: 1 },
          { itemId: "staff_of_air", quantity: 1 },
          { itemId: "fire_rune", quantity: 500 },
          { itemId: "mind_rune", quantity: 500 },
        ].map((item, slot) => ({
          playerId: agentId,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: 10 + slot,
          tabIndex: 0,
        })),
      ),
    );
  }
}

function expectedItemCustody(agentId: string): Array<{
  playerId: string;
  itemId: string;
  quantity: number;
  custody: string;
}> {
  if (CHAOS_COMBAT_ROLE === "ranged") {
    return [
      {
        playerId: agentId,
        itemId: "bronze_arrow",
        quantity: 100,
        custody: "equipment",
      },
      {
        playerId: agentId,
        itemId: "shortbow",
        quantity: 1,
        custody: "equipment",
      },
      {
        playerId: agentId,
        itemId: "lobster",
        quantity: 4,
        custody: "inventory",
      },
    ];
  }
  if (CHAOS_COMBAT_ROLE === "mage") {
    return [
      {
        playerId: agentId,
        itemId: "staff_of_air",
        quantity: 1,
        custody: "equipment",
      },
      {
        playerId: agentId,
        itemId: "fire_rune",
        quantity: 60,
        custody: "inventory",
      },
      {
        playerId: agentId,
        itemId: "lobster",
        quantity: 4,
        custody: "inventory",
      },
      {
        playerId: agentId,
        itemId: "mind_rune",
        quantity: 20,
        custody: "inventory",
      },
    ];
  }
  return [
    {
      playerId: agentId,
      itemId: "bronze_longsword",
      quantity: 1,
      custody: "equipment",
    },
    {
      playerId: agentId,
      itemId: "lobster",
      quantity: 4,
      custody: "inventory",
    },
  ];
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-agent-duel-cycle-chaos-${process.pid}`;
  const databaseUser = "agent_duel_cycle_test";
  const databaseName = "agent_duel_cycle_test";
  const databasePassword = `agent-duel-${randomUUID()}`;
  const image =
    process.env.AGENT_DUEL_CYCLE_CHAOS_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  const externalConnectionString =
    process.env.AGENT_DUEL_CYCLE_CHAOS_EXTERNAL_DATABASE_URL?.trim() || null;
  const rawSkipDatabaseOutage =
    process.env.AGENT_DUEL_CYCLE_CHAOS_SKIP_DATABASE_OUTAGE?.trim();
  if (
    rawSkipDatabaseOutage !== undefined &&
    rawSkipDatabaseOutage !== "true" &&
    rawSkipDatabaseOutage !== "false"
  ) {
    throw new Error(
      "AGENT_DUEL_CYCLE_CHAOS_SKIP_DATABASE_OUTAGE must be true or false",
    );
  }
  const skipDatabaseOutage = rawSkipDatabaseOutage === "true";
  if (externalConnectionString && !skipDatabaseOutage) {
    throw new Error(
      "external database mode requires AGENT_DUEL_CYCLE_CHAOS_SKIP_DATABASE_OUTAGE=true because the harness does not own that database process",
    );
  }
  const workers: ChildProcess[] = [];
  let containerStarted = false;
  let containerPaused = false;
  let pool: pg.Pool | null = null;
  let databaseOutageWorkerPid: number | null = null;
  try {
    let connectionString: string;
    if (externalConnectionString) {
      connectionString = externalConnectionString;
      pool = await waitForPostgres(connectionString);
    } else {
      await docker(["info", "--format", "{{.ServerVersion}}"]).catch(
        (error) => {
          throw new Error(
            `Docker is required for the retained chaos gate: ${error}`,
          );
        },
      );
      await docker([
        "run",
        "--rm",
        "-d",
        "--name",
        containerName,
        "-e",
        `POSTGRES_USER=${databaseUser}`,
        "-e",
        `POSTGRES_PASSWORD=${databasePassword}`,
        "-e",
        `POSTGRES_DB=${databaseName}`,
        "-p",
        "127.0.0.1::5432",
        image,
      ]);
      containerStarted = true;
      const portOutput = await docker(["port", containerName, "5432/tcp"]);
      const port = Number(portOutput.split(":").pop());
      if (!Number.isSafeInteger(port) || port <= 0) {
        throw new Error("could not resolve temporary PostgreSQL port");
      }
      connectionString = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${databaseName}`;
      pool = await waitForPostgres(connectionString);
    }
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await seedAgents(drizzle(pool, { schema }));

    const freezer = spawnWorker({ mode: "freeze", connectionString });
    workers.push(freezer.child);
    const frozen = await freezer.event;
    if (
      frozen.event !== "frozen" ||
      !frozen.cycleId ||
      !frozen.duelId ||
      !frozen.preparationId ||
      !frozen.digest ||
      !Number.isSafeInteger(frozen.betCloseTime) ||
      frozen.lifecycleStatus !== "frozen" ||
      frozen.combatRole !== CHAOS_COMBAT_ROLE
    ) {
      throw new Error(`freeze evidence is invalid: ${JSON.stringify(frozen)}`);
    }
    if (!freezer.child.kill("SIGKILL")) {
      throw new Error("failed to kill frozen-cycle authority process");
    }
    await waitForExit(freezer.child, freezer.stderr);
    if (freezer.child.signalCode !== "SIGKILL") {
      throw new Error(
        `freeze worker exited without SIGKILL: ${freezer.child.signalCode}`,
      );
    }

    const frozenAfterKill = await pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      snapshotCount: string;
    }>(
      `SELECT max("lifecycleStatus") AS "lifecycleStatus",
              max("snapshotDigest") AS "snapshotDigest",
              count(*)::text AS "snapshotCount"
         FROM streaming_duel_competitive_snapshots
        WHERE "cycleId" = $1`,
      [frozen.cycleId],
    );
    if (
      frozenAfterKill.rows[0]?.lifecycleStatus !== "frozen" ||
      frozenAfterKill.rows[0]?.snapshotDigest !== frozen.digest ||
      frozenAfterKill.rows[0]?.snapshotCount !== "1"
    ) {
      throw new Error(
        `frozen truth did not survive SIGKILL: ${JSON.stringify(frozenAfterKill.rows)}`,
      );
    }

    if (!skipDatabaseOutage) {
      await docker(["pause", containerName]);
      containerPaused = true;
      const outageProbe = spawnWorker({
        mode: "database-outage",
        connectionString,
        expected: frozen,
      });
      databaseOutageWorkerPid = outageProbe.child.pid ?? null;
      workers.push(outageProbe.child);
      const outageEvidence = await outageProbe.event;
      await waitForExit(outageProbe.child, outageProbe.stderr);
      if (
        outageEvidence.event !== "database_unavailable" ||
        outageEvidence.combatRole !== CHAOS_COMBAT_ROLE
      ) {
        throw new Error(
          `database outage evidence is invalid: ${JSON.stringify(outageEvidence)}`,
        );
      }
      await docker(["unpause", containerName]);
      containerPaused = false;
      await pool.query("SELECT 1");

      const frozenAfterOutage = await pool.query<{
        lifecycleStatus: string;
        snapshotDigest: string;
        fencingToken: string;
        snapshotCount: string;
        transitionCount: string;
      }>(
        `SELECT max(snapshot."lifecycleStatus") AS "lifecycleStatus",
                max(snapshot."snapshotDigest") AS "snapshotDigest",
                max(preparation."fencingToken")::text AS "fencingToken",
                count(DISTINCT snapshot."preparationId")::text AS "snapshotCount",
                count(DISTINCT transition."eventSequence")::text AS "transitionCount"
           FROM streaming_duel_competitive_snapshots snapshot
           JOIN streaming_duel_preparations preparation
             USING ("preparationId")
           JOIN streaming_duel_transition_events transition
             USING ("preparationId")
          WHERE snapshot."cycleId" = $1`,
        [frozen.cycleId],
      );
      if (
        frozenAfterOutage.rows[0]?.lifecycleStatus !== "frozen" ||
        frozenAfterOutage.rows[0]?.snapshotDigest !== frozen.digest ||
        frozenAfterOutage.rows[0]?.fencingToken !== "1" ||
        frozenAfterOutage.rows[0]?.snapshotCount !== "1" ||
        frozenAfterOutage.rows[0]?.transitionCount !== "4"
      ) {
        throw new Error(
          `database outage mutated frozen truth: ${JSON.stringify(frozenAfterOutage.rows)}`,
        );
      }
    }

    const replacement = spawnWorker({
      mode: "recover",
      connectionString,
      expected: frozen,
    });
    workers.push(replacement.child);
    const recovered = await replacement.event;
    await waitForExit(replacement.child, replacement.stderr);
    if (
      recovered.event !== "recovered" ||
      recovered.cycleId !== frozen.cycleId ||
      recovered.digest !== frozen.digest ||
      recovered.betCloseTime !== frozen.betCloseTime ||
      recovered.lifecycleStatus !== "retired" ||
      recovered.prayerPointUnits !== EXPECTED_DRAINED_PRAYER_UNITS ||
      recovered.combatRole !== CHAOS_COMBAT_ROLE
    ) {
      throw new Error(
        `replacement evidence is invalid: ${JSON.stringify(recovered)}`,
      );
    }

    const lifecycle = await pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      terminalOutcome: string | null;
      terminalCancellationReason: string | null;
      lockedAt: string | null;
      duelStartedAt: string | null;
      terminalAt: string | null;
      recoveredAt: string | null;
      fencingToken: string;
    }>(
      `SELECT snapshot."lifecycleStatus", snapshot."snapshotDigest",
              snapshot."terminalOutcome",
              snapshot."terminalCancellationReason",
              snapshot."lockedAt"::text AS "lockedAt",
              snapshot."duelStartedAt"::text AS "duelStartedAt",
              snapshot."terminalAt"::text AS "terminalAt",
              snapshot."recoveredAt"::text AS "recoveredAt",
              preparation."fencingToken"::text AS "fencingToken"
         FROM streaming_duel_competitive_snapshots snapshot
         JOIN streaming_duel_preparations preparation
           USING ("preparationId")
        WHERE snapshot."cycleId" = $1`,
      [frozen.cycleId],
    );
    const lifecycleRow = lifecycle.rows[0];
    if (
      lifecycle.rows.length !== 1 ||
      lifecycleRow?.lifecycleStatus !== "retired" ||
      lifecycleRow.snapshotDigest !== frozen.digest ||
      lifecycleRow.terminalOutcome !== "cancelled" ||
      lifecycleRow.terminalCancellationReason !== "operator_cancelled" ||
      lifecycleRow.lockedAt !== String(frozen.betCloseTime) ||
      !lifecycleRow.duelStartedAt ||
      !lifecycleRow.terminalAt ||
      !lifecycleRow.recoveredAt ||
      BigInt(lifecycleRow.duelStartedAt) < BigInt(lifecycleRow.lockedAt) ||
      BigInt(lifecycleRow.terminalAt) < BigInt(lifecycleRow.duelStartedAt) ||
      BigInt(lifecycleRow.recoveredAt) < BigInt(lifecycleRow.terminalAt) ||
      lifecycleRow.fencingToken !== "2"
    ) {
      throw new Error(
        `durable lifecycle drifted: ${JSON.stringify(lifecycle.rows)}`,
      );
    }

    const transitionRows = await pool.query<{
      eventSequence: string;
      eventType: string;
      fencingToken: string | null;
      snapshotDigest: string | null;
      reason: string | null;
    }>(
      `SELECT "eventSequence"::text AS "eventSequence", "eventType",
              "fencingToken"::text AS "fencingToken", "snapshotDigest", reason
         FROM streaming_duel_transition_events
        WHERE "preparationId" = $1
        ORDER BY "eventSequence"`,
      [frozen.preparationId],
    );
    const expectedTransitions = [
      "preparation_selected",
      "contestant_ready",
      "contestant_ready",
      "competitive_snapshot_frozen",
      "authority_claimed",
      "market_locked",
      "duel_started",
      "terminal_committed",
      "recovery_committed",
    ];
    if (
      transitionRows.rows.map((row) => row.eventType).join(",") !==
        expectedTransitions.join(",") ||
      transitionRows.rows.some(
        (row, index) =>
          (index > 0 &&
            BigInt(row.eventSequence) <=
              BigInt(transitionRows.rows[index - 1]!.eventSequence)) ||
          (row.snapshotDigest !== null && row.snapshotDigest !== frozen.digest),
      ) ||
      transitionRows.rows[4]?.fencingToken !== "2" ||
      transitionRows.rows[7]?.reason !== "operator_cancelled"
    ) {
      throw new Error(
        `durable transition history drifted: ${JSON.stringify(transitionRows.rows)}`,
      );
    }

    const prayerRows = await pool.query<{
      id: string;
      prayerPointUnits: number;
      activePrayers: string[];
    }>(
      `SELECT id, "prayerPointUnits", "activePrayers"
         FROM characters
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [AGENT_IDS],
    );
    if (
      prayerRows.rows.length !== 2 ||
      prayerRows.rows.some(
        (row) =>
          row.prayerPointUnits !== EXPECTED_DRAINED_PRAYER_UNITS ||
          row.activePrayers.length !== 0,
      )
    ) {
      throw new Error(
        `durable Prayer custody drifted: ${JSON.stringify(prayerRows.rows)}`,
      );
    }

    const operations = await pool.query<{
      playerId: string;
      operationType: string;
      transition: string | null;
    }>(
      `SELECT "playerId", "operationType",
              "operationState"->>'transition' AS transition
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
        ORDER BY "playerId", timestamp, id`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      const agentOperations = operations.rows.filter(
        (row) => row.playerId === agentId,
      );
      const drains = agentOperations.filter(
        (row) =>
          row.operationType === "prayer_state_transition" &&
          row.transition === "drain",
      );
      if (
        agentOperations.filter(
          (row) => row.operationType === "duel_preparation_plan",
        ).length !== 1 ||
        agentOperations.filter(
          (row) =>
            row.operationType === "prayer_state_transition" &&
            row.transition === "toggle",
        ).length !== 1 ||
        drains.length < 1 ||
        drains.length > 4 ||
        agentOperations.filter(
          (row) =>
            row.operationType === "prayer_state_transition" &&
            row.transition === "deactivate_all",
        ).length !== 1
      ) {
        throw new Error(
          `operation receipts drifted for ${agentId}: ${JSON.stringify(agentOperations)}`,
        );
      }
    }

    const custody = await pool.query<{
      playerId: string;
      itemId: string;
      quantity: number;
      custody: string;
    }>(
      `SELECT item."playerId", item."itemId",
              sum(item.quantity)::int AS quantity, item.custody
         FROM (
           SELECT "playerId", "itemId", quantity, 'inventory'::text AS custody
             FROM inventory WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'equipment'::text AS custody
             FROM equipment WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'bank'::text AS custody
             FROM bank_storage WHERE "playerId" = ANY($1::text[])
         ) item
        GROUP BY item."playerId", item."itemId", item.custody
        ORDER BY item."playerId", item.custody, item."itemId"`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      const rows = custody.rows.filter((row) => row.playerId === agentId);
      const expected = expectedItemCustody(agentId);
      if (JSON.stringify(rows) !== JSON.stringify(expected)) {
        throw new Error(
          `item custody drifted for ${agentId}: ${JSON.stringify(rows)}`,
        );
      }
    }

    const activeFight = spawnWorker({ mode: "fight", connectionString });
    workers.push(activeFight.child);
    const fighting = await activeFight.event;
    if (
      fighting.event !== "fighting" ||
      !fighting.cycleId ||
      !fighting.duelId ||
      !fighting.preparationId ||
      !fighting.digest ||
      !Number.isSafeInteger(fighting.betCloseTime) ||
      fighting.lifecycleStatus !== "frozen" ||
      fighting.prayerPointUnits !== EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
      fighting.combatRole !== CHAOS_COMBAT_ROLE
    ) {
      throw new Error(
        `active-fight evidence is invalid: ${JSON.stringify(fighting)}`,
      );
    }
    if (!activeFight.child.kill("SIGKILL")) {
      throw new Error("failed to kill active-fight authority process");
    }
    await waitForExit(activeFight.child, activeFight.stderr);
    if (activeFight.child.signalCode !== "SIGKILL") {
      throw new Error(
        `active-fight worker exited without SIGKILL: ${activeFight.child.signalCode}`,
      );
    }

    const fightingAfterKill = await pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      lockedAt: string | null;
      duelStartedAt: string | null;
      terminalAt: string | null;
      fencingToken: string;
    }>(
      `SELECT snapshot."lifecycleStatus", snapshot."snapshotDigest",
              snapshot."lockedAt"::text AS "lockedAt",
              snapshot."duelStartedAt"::text AS "duelStartedAt",
              snapshot."terminalAt"::text AS "terminalAt",
              preparation."fencingToken"::text AS "fencingToken"
         FROM streaming_duel_competitive_snapshots snapshot
         JOIN streaming_duel_preparations preparation
           USING ("preparationId")
        WHERE snapshot."cycleId" = $1`,
      [fighting.cycleId],
    );
    if (
      fightingAfterKill.rows.length !== 1 ||
      fightingAfterKill.rows[0]?.lifecycleStatus !== "frozen" ||
      fightingAfterKill.rows[0]?.snapshotDigest !== fighting.digest ||
      fightingAfterKill.rows[0]?.lockedAt !== String(fighting.betCloseTime) ||
      !fightingAfterKill.rows[0]?.duelStartedAt ||
      fightingAfterKill.rows[0]?.terminalAt !== null ||
      fightingAfterKill.rows[0]?.fencingToken !== "3"
    ) {
      throw new Error(
        `active-fight truth did not survive SIGKILL: ${JSON.stringify(fightingAfterKill.rows)}`,
      );
    }
    const activePrayerAfterKill = await pool.query<{
      id: string;
      prayerPointUnits: number;
      activePrayers: string[];
    }>(
      `SELECT id, "prayerPointUnits", "activePrayers"
         FROM characters
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [AGENT_IDS],
    );
    if (
      activePrayerAfterKill.rows.length !== 2 ||
      activePrayerAfterKill.rows.some(
        (row) =>
          row.prayerPointUnits !== EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
          row.activePrayers.join(",") !== EXPECTED_PRAYER_ID,
      )
    ) {
      throw new Error(
        `active Prayer truth did not survive SIGKILL: ${JSON.stringify(activePrayerAfterKill.rows)}`,
      );
    }

    const expiredRecovery = spawnWorker({
      mode: "recover-expired",
      connectionString,
      expected: fighting,
    });
    workers.push(expiredRecovery.child);
    const cancelledAfterRestart = await expiredRecovery.event;
    await waitForExit(expiredRecovery.child, expiredRecovery.stderr);
    if (
      cancelledAfterRestart.event !== "cancelled_after_restart" ||
      cancelledAfterRestart.cycleId !== fighting.cycleId ||
      cancelledAfterRestart.digest !== fighting.digest ||
      cancelledAfterRestart.betCloseTime !== fighting.betCloseTime ||
      cancelledAfterRestart.lifecycleStatus !== "retired" ||
      cancelledAfterRestart.prayerPointUnits !==
        EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
      cancelledAfterRestart.combatRole !== CHAOS_COMBAT_ROLE
    ) {
      throw new Error(
        `expired-fight recovery evidence is invalid: ${JSON.stringify(cancelledAfterRestart)}`,
      );
    }

    const expiredLifecycle = await pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      terminalOutcome: string | null;
      terminalCancellationReason: string | null;
      lockedAt: string | null;
      duelStartedAt: string | null;
      terminalAt: string | null;
      recoveredAt: string | null;
      fencingToken: string;
    }>(
      `SELECT snapshot."lifecycleStatus", snapshot."snapshotDigest",
              snapshot."terminalOutcome",
              snapshot."terminalCancellationReason",
              snapshot."lockedAt"::text AS "lockedAt",
              snapshot."duelStartedAt"::text AS "duelStartedAt",
              snapshot."terminalAt"::text AS "terminalAt",
              snapshot."recoveredAt"::text AS "recoveredAt",
              preparation."fencingToken"::text AS "fencingToken"
         FROM streaming_duel_competitive_snapshots snapshot
         JOIN streaming_duel_preparations preparation
           USING ("preparationId")
        WHERE snapshot."cycleId" = $1`,
      [fighting.cycleId],
    );
    const expiredRow = expiredLifecycle.rows[0];
    if (
      expiredLifecycle.rows.length !== 1 ||
      expiredRow?.lifecycleStatus !== "retired" ||
      expiredRow.snapshotDigest !== fighting.digest ||
      expiredRow.terminalOutcome !== "cancelled" ||
      expiredRow.terminalCancellationReason !==
        "competitive_snapshot_recovery_window_elapsed" ||
      expiredRow.lockedAt !== String(fighting.betCloseTime) ||
      !expiredRow.duelStartedAt ||
      !expiredRow.terminalAt ||
      !expiredRow.recoveredAt ||
      BigInt(expiredRow.terminalAt) < BigInt(expiredRow.duelStartedAt) ||
      BigInt(expiredRow.recoveredAt) < BigInt(expiredRow.terminalAt) ||
      expiredRow.fencingToken !== "4"
    ) {
      throw new Error(
        `expired active-fight lifecycle drifted: ${JSON.stringify(expiredLifecycle.rows)}`,
      );
    }

    const expiredTransitions = await pool.query<{
      eventSequence: string;
      eventType: string;
      fencingToken: string | null;
      snapshotDigest: string | null;
      reason: string | null;
    }>(
      `SELECT "eventSequence"::text AS "eventSequence", "eventType",
              "fencingToken"::text AS "fencingToken", "snapshotDigest", reason
         FROM streaming_duel_transition_events
        WHERE "preparationId" = $1
        ORDER BY "eventSequence"`,
      [fighting.preparationId],
    );
    const expectedExpiredTransitions = [
      "preparation_selected",
      "contestant_ready",
      "contestant_ready",
      "competitive_snapshot_frozen",
      "market_locked",
      "duel_started",
      "authority_claimed",
      "terminal_committed",
      "recovery_committed",
    ];
    if (
      expiredTransitions.rows.map((row) => row.eventType).join(",") !==
        expectedExpiredTransitions.join(",") ||
      expiredTransitions.rows.some(
        (row, index) =>
          (index > 0 &&
            BigInt(row.eventSequence) <=
              BigInt(expiredTransitions.rows[index - 1]!.eventSequence)) ||
          (row.snapshotDigest !== null &&
            row.snapshotDigest !== fighting.digest),
      ) ||
      expiredTransitions.rows[4]?.eventType !== "market_locked" ||
      expiredTransitions.rows[5]?.eventType !== "duel_started" ||
      expiredTransitions.rows[6]?.eventType !== "authority_claimed" ||
      expiredTransitions.rows[6]?.fencingToken !== "4" ||
      expiredTransitions.rows[7]?.reason !==
        "competitive_snapshot_recovery_window_elapsed"
    ) {
      throw new Error(
        `expired active-fight transition history drifted: ${JSON.stringify(expiredTransitions.rows)}`,
      );
    }

    const finalOperations = await pool.query<{
      playerId: string;
      operationType: string;
      transition: string | null;
    }>(
      `SELECT "playerId", "operationType",
              "operationState"->>'transition' AS transition
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
        ORDER BY "playerId", timestamp, id`,
      [AGENT_IDS],
    );
    for (const agentId of AGENT_IDS) {
      const agentOperations = finalOperations.rows.filter(
        (row) => row.playerId === agentId,
      );
      const drainCount = agentOperations.filter(
        (row) =>
          row.operationType === "prayer_state_transition" &&
          row.transition === "drain",
      ).length;
      if (
        agentOperations.filter(
          (row) => row.operationType === "duel_preparation_plan",
        ).length !== 2 ||
        agentOperations.filter(
          (row) =>
            row.operationType === "prayer_state_transition" &&
            row.transition === "toggle",
        ).length !== 2 ||
        drainCount < 2 ||
        drainCount > 8 ||
        agentOperations.filter(
          (row) =>
            row.operationType === "prayer_state_transition" &&
            row.transition === "deactivate_all",
        ).length !== 2
      ) {
        throw new Error(
          `two-cycle operation receipts drifted for ${agentId}: ${JSON.stringify(agentOperations)}`,
        );
      }
    }

    const finalPrayer = await pool.query<{
      id: string;
      prayerPointUnits: number;
      activePrayers: string[];
    }>(
      `SELECT id, "prayerPointUnits", "activePrayers"
         FROM characters
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [AGENT_IDS],
    );
    if (
      finalPrayer.rows.length !== 2 ||
      finalPrayer.rows.some(
        (row) =>
          row.prayerPointUnits !== EXPECTED_TWICE_DRAINED_PRAYER_UNITS ||
          row.activePrayers.length !== 0,
      )
    ) {
      throw new Error(
        `post-restart Prayer custody drifted: ${JSON.stringify(finalPrayer.rows)}`,
      );
    }
    const finalCustody = await pool.query<{
      playerId: string;
      itemId: string;
      quantity: number;
      custody: string;
    }>(
      `SELECT item."playerId", item."itemId",
              sum(item.quantity)::int AS quantity, item.custody
         FROM (
           SELECT "playerId", "itemId", quantity, 'inventory'::text AS custody
             FROM inventory WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'equipment'::text AS custody
             FROM equipment WHERE "playerId" = ANY($1::text[])
           UNION ALL
           SELECT "playerId", "itemId", quantity, 'bank'::text AS custody
             FROM bank_storage WHERE "playerId" = ANY($1::text[])
         ) item
        GROUP BY item."playerId", item."itemId", item.custody
        ORDER BY item."playerId", item.custody, item."itemId"`,
      [AGENT_IDS],
    );
    if (JSON.stringify(finalCustody.rows) !== JSON.stringify(custody.rows)) {
      throw new Error(
        `post-restart item custody drifted: ${JSON.stringify(finalCustody.rows)}`,
      );
    }
    const snapshotTotal = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM streaming_duel_competitive_snapshots`,
    );
    if (snapshotTotal.rows[0]?.count !== "2") {
      throw new Error(
        `two-cycle snapshot count drifted: ${JSON.stringify(snapshotTotal.rows)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        combatRole: CHAOS_COMBAT_ROLE,
        weaponId: ROLE_FIXTURE.weaponId,
        prayerId: EXPECTED_PRAYER_ID,
        freezeWorkerPid: freezer.child.pid,
        databaseOutageWorkerPid,
        replacementWorkerPid: replacement.child.pid,
        freezeWorkerKilled: true,
        databaseOutageFailedClosed: !skipDatabaseOutage,
        databaseOutageSkipped: skipDatabaseOutage,
        frozenTruthUnchangedDuringOutage: !skipDatabaseOutage,
        recoveryAfterDatabaseRestore: !skipDatabaseOutage,
        externalDatabase: externalConnectionString !== null,
        exactCycleRecovered: true,
        exactSnapshotDigestRecovered: true,
        immutableBetClosePreserved: true,
        countdownAndFightReached: true,
        combatControllerCount: 2,
        prayerDrainUnitsPerAgent: 400_000,
        noPrayerRefund: true,
        lifecycleStatus: "retired",
        terminalOutcome: "cancelled",
        terminalReason: "operator_cancelled",
        transitionRows: transitionRows.rows.length,
        activeFightWorkerPid: activeFight.child.pid,
        expiredRecoveryWorkerPid: expiredRecovery.child.pid,
        activeFightWorkerKilled: true,
        activePrayerPersistedAcrossKill: true,
        expiredFightResumed: false,
        expiredFightCancellationReason:
          "competitive_snapshot_recovery_window_elapsed",
        expiredFightTransitionRows: expiredTransitions.rows.length,
        totalSnapshotRows: Number(snapshotTotal.rows[0]?.count),
        cumulativePrayerDrainUnitsPerAgent: 800_000,
        terminalPrayerDeactivatedWithoutRefund: true,
        duplicateSnapshot: false,
        duplicatePreparationPlan: false,
        exactItemCustody: true,
      })}\n`,
    );
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
    if (pool) await pool.end().catch(() => undefined);
    if (containerStarted) {
      if (containerPaused) {
        await docker(["unpause", containerName]).catch(() => undefined);
      }
      await docker(["stop", "--time", "1", containerName]).catch(
        () => undefined,
      );
    }
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);

if (isDirectExecution) {
  try {
    if (process.argv.includes("--freeze")) {
      await runFreezeWorker();
    } else if (process.argv.includes("--database-outage")) {
      await runDatabaseOutageWorker();
      process.exit(0);
    } else if (process.argv.includes("--recover")) {
      await runRecoveryWorker();
      // The worker has already closed every owned runtime and PostgreSQL handle.
      // Imported agent modules retain process-global diagnostic handles that are
      // intentionally shared by the long-lived server, so the finite chaos
      // worker exits explicitly only after emitting post-cleanup evidence.
      process.exit(0);
    } else if (process.argv.includes("--fight")) {
      await runActiveFightWorker();
    } else if (process.argv.includes("--recover-expired")) {
      await runExpiredFightRecoveryWorker();
      process.exit(0);
    } else {
      await runParent();
    }
  } catch (error) {
    if (process.argv.some((argument) => argument.startsWith("--"))) {
      emit({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
