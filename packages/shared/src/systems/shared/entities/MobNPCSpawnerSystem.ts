import { ALL_NPCS, getNPCById } from "../../../data/npcs";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import type {
  LevelRange,
  NPCData,
  MobSpawnStats,
} from "../../../types/core/core";
import { EntityType, InteractionType } from "../../../types/entities/entities";
import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { SystemBase } from "../infrastructure/SystemBase";
// NOTE: Import directly to avoid circular dependency through barrel file
import { EntityManager } from "./EntityManager";
import { TerrainSystem } from "../world/TerrainSystem";
import type { TownSystem } from "../world/TownSystem";
import { MobEntity } from "../../../entities/npc/MobEntity";
import { MOB_CONSTANTS } from "../../../constants/GameConstants";

// Types are now imported from shared type files

/**
 * Mob NPC Spawner System
 *
 * Uses EntityManager to spawn mob entities instead of MobApp objects.
 * Creates and manages all combat NPC instances (mobs, bosses, quest enemies)
 * across the world based on GDD specifications.
 */
type SpawnedMobDetail = {
  spawnKey: string;
  mobId: string;
  mobType: string;
  level: number;
  position: { x: number; y: number; z: number };
  levelRange: LevelRange;
  isBoss: boolean;
  sourceTileKey?: string;
};

type SpawnMobOptions = {
  level?: number;
  levelRange?: LevelRange;
  isBoss?: boolean;
  spawnKey?: string;
  sourceTileKey?: string;
};

export class MobNPCSpawnerSystem extends SystemBase {
  private spawnedMobs = new Map<string, string>(); // spawnKey -> entityId
  private spawnedMobDetails = new Map<string, SpawnedMobDetail>();
  private entityIdToSpawnKey = new Map<string, string>();
  private tileSpawnKeys = new Map<string, Set<string>>();
  private activeMobTiles = new Set<string>();
  private spawnedBossHotspots = new Set<string>();
  private mobIdCounter = 0;
  private terrainSystem!: TerrainSystem;
  private townSystem: TownSystem | null = null;
  private lastSpawnTime = 0;
  private readonly SPAWN_COOLDOWN = 5000; // 5 seconds between spawns
  private readonly BIOME_SPAWNS_PER_TILE = 3;
  private npcSpawningStopped = false;
  private startPromise: Promise<void> | null = null;

  // EntityManager publishes only after async Entity.init. Reserve before that
  // await, across spawner instances sharing the same authoritative manager.
  private static readonly pendingNPCPlacements = new WeakMap<
    EntityManager,
    Map<string, Promise<boolean>>
  >();

  private static readonly banditCapIds = new Set<string>(
    MOB_CONSTANTS.BANDIT_MOB_IDS_FOR_GLOBAL_CAP,
  );

  constructor(world: World) {
    super(world, {
      name: "mob-npc-spawner",
      dependencies: {
        required: ["entity-manager", "terrain"], // Depends on EntityManager and terrain for placement
        optional: ["mob-npc", "towns"], // Better with mob NPC system, towns for safe zone checking
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Get terrain system reference
    this.terrainSystem = this.world.getSystem<TerrainSystem>("terrain")!;

    // Get town system reference for safe zone checking (procedural towns)
    this.townSystem = this.world.getSystem<TownSystem>("towns") ?? null;

    // Set up event subscriptions for mob lifecycle (do not consume MOB_NPC_SPAWN_REQUEST to avoid re-emission loops)
    this.subscribe<{ mobId: string }>(EventType.MOB_NPC_DESPAWN, (data) => {
      this.despawnMob(data.mobId);
    });
    this.subscribe(EventType.MOB_NPC_RESPAWN_ALL, (_event) =>
      this.respawnAllMobs(),
    );

    // Subscribe to terrain generation to spawn mobs for new tiles
    this.subscribe(EventType.TERRAIN_TILE_GENERATED, (data) =>
      this.onTileGenerated(
        data as {
          tileX: number;
          tileZ: number;
          biome: string;
          contentGenerated?: boolean;
        },
      ),
    );
    this.subscribe(EventType.TERRAIN_TILE_UNLOADED, (data) =>
      this.onTileUnloaded(data as { tileX: number; tileZ: number }),
    );
  }

  start(): Promise<void> {
    // Spawn NPCs immediately at world start (they're static, not reactive to terrain)
    // NPCs like bank clerks, shopkeepers should be available from the start
    if (!this.world.isServer || this.npcSpawningStopped)
      return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const start = Promise.resolve().then(async () => {
      await this.spawnAllNPCsFromManifest();
      if (this.npcSpawningStopped) return;
      // Spawn procedural building NPCs inside town buildings
      await this.spawnBuildingNPCs();
      if (this.npcSpawningStopped) return;
      // Spawn a default test goblin near origin for testing combat
      await this.spawnDefaultMob();
    });
    this.startPromise = start.finally(() => {
      this.startPromise = null;
    });
    // Additional mobs are spawned reactively as terrain tiles generate via biomes.json
    return this.startPromise;
  }

  /** Static NPCs remain resident across tile reloads and spawner replacement. */
  private static async npcPlacementId(
    prefix: string,
    placement: readonly (string | number)[],
  ): Promise<string> {
    // A deterministic 160-bit SHA-256 suffix keeps the established prefix and
    // current manifest IDs within the entity protocol's 64-character alphabet.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(placement)),
    );
    const suffix = Array.from(new Uint8Array(digest).subarray(0, 20), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${prefix}${suffix}`;
  }

  private async spawnNPCPlacement(
    manager: EntityManager,
    config: Parameters<EntityManager["spawnEntity"]>[0],
    onSpawn?: (
      entity: NonNullable<Awaited<ReturnType<EntityManager["spawnEntity"]>>>,
    ) => void,
  ): Promise<boolean> {
    if (this.npcSpawningStopped) return false;
    let pending = MobNPCSpawnerSystem.pendingNPCPlacements.get(manager);
    if (!pending) {
      pending = new Map();
      MobNPCSpawnerSystem.pendingNPCPlacements.set(manager, pending);
    }
    const existing = pending.get(config.id);
    if (existing) {
      await existing;
      // An old owner may have been destroyed while initializing. A live
      // replacement can retry after that owner's cleanup, never concurrently.
      return this.spawnNPCPlacement(manager, config, onSpawn);
    }
    if (manager.getEntity(config.id)) return false;
    const spawn = Promise.resolve().then(async () => {
      if (this.npcSpawningStopped) return false;
      const entity = await manager.spawnEntity(config);
      if (!entity) return false;
      if (this.npcSpawningStopped) {
        if (manager.getEntity(config.id) === entity)
          manager.destroyEntity(config.id);
        return false;
      }
      onSpawn?.(entity);
      return true;
    });
    const reservation = spawn.finally(() => {
      if (pending.get(config.id) === reservation) pending.delete(config.id);
    });
    pending.set(config.id, reservation);
    return reservation;
  }

  /**
   * Spawn all NPCs defined in world-areas.json immediately
   * Unlike mobs, NPCs are static and should be available at world start
   */
  private async spawnAllNPCsFromManifest(): Promise<void> {
    // Wait for EntityManager to be ready
    let entityManager = this.world.getSystem<EntityManager>("entity-manager");
    let attempts = 0;

    while (!entityManager && attempts < 50 && !this.npcSpawningStopped) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      entityManager = this.world.getSystem<EntityManager>("entity-manager");
      attempts++;
    }

    if (this.npcSpawningStopped) return;
    if (!entityManager) {
      console.error(
        "[MobNPCSpawnerSystem] ❌ EntityManager not available for NPC spawning",
      );
      return;
    }

    const terrainSystem = this.terrainSystem;

    for (const area of Object.values(ALL_WORLD_AREAS)) {
      if (!area.npcs || area.npcs.length === 0) continue;

      for (const npc of area.npcs) {
        if (this.npcSpawningStopped) return;
        // Get ground height at NPC position
        const groundY = terrainSystem.getHeightAt(
          npc.position.x,
          npc.position.z,
        );
        // NPCs should be at ground level (not +1m), the model's pivot handles foot placement
        const spawnY = groundY;

        // ALL NPC data comes from npcs.json manifest - world-areas only provides position/type
        const npcManifestData = getNPCById(npc.id);
        if (!npcManifestData) {
          console.warn(
            `[MobNPCSpawnerSystem] ⚠️ NPC ${npc.id} not found in npcs.json manifest!`,
          );
          continue; // Skip NPCs not in manifest
        }

        const modelPath =
          npcManifestData.appearance?.modelPath ||
          "asset://models/human/human_rigged.glb";
        const npcServices = npcManifestData.services?.types || [];
        const npcQuestIds = npcManifestData.services?.questIds as
          string[] | undefined;
        const npcDescription = npcManifestData.description || npc.id;
        const npcName = npcManifestData.name || npc.id;

        const npcConfig = {
          // Authored physical placement, not mutable service metadata or the
          // terrain-resolved height. Array reordering must not change identity.
          id: await MobNPCSpawnerSystem.npcPlacementId(`npc_${npc.id}_`, [
            area.id,
            npc.position.x,
            npc.position.y,
            npc.position.z,
          ]),
          type: EntityType.NPC,
          name: npcName, // From npcs.json
          position: { x: npc.position.x, y: spawnY, z: npc.position.z },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 100, y: 100, z: 100 }, // Scale up rigged models
          visible: true,
          interactable: true,
          interactionType: InteractionType.TALK,
          interactionDistance: 3,
          description: npcDescription, // From npcs.json
          model: modelPath, // From npcs.json
          properties: {
            movementComponent: null,
            combatComponent: null,
            healthComponent: null,
            visualComponent: null,
            health: { current: 1, max: 1 },
            level: 1,
          },
          npcType: npc.type, // From world-areas (bank, store, etc.)
          npcId: npc.id, // Manifest ID for dialogue lookup
          // Preserve the exact store identity from world-areas.json. The
          // secure store handler binds every purchase to this identity; a
          // positional or NPC-type guess could select the wrong inventory.
          storeId: npc.storeId,
          dialogueLines: [],
          services: npcServices, // From npcs.json
          questIds: npcQuestIds, // Quest IDs from npcs.json
          inventory: [],
          skillsOffered: [],
          questsAvailable: [],
        };

        try {
          const spawned = await this.spawnNPCPlacement(
            entityManager,
            npcConfig,
            (spawnedNPC) => {
              if (npc.storeId) {
                this.emitTypedEvent(EventType.STORE_REGISTER_NPC, {
                  npcId: spawnedNPC.id,
                  storeId: npc.storeId,
                  position: npc.position,
                  name: npcName,
                  area: area.id,
                });
              }
            },
          );
          if (!spawned) continue;
          console.log(
            `[MobNPCSpawnerSystem] ✅ Spawned NPC ${npc.id} (${npcName}) at (${npc.position.x}, ${spawnY.toFixed(2)}, ${npc.position.z})`,
          );
        } catch (err) {
          console.error(
            `[MobNPCSpawnerSystem] ❌ Failed to spawn NPC ${npc.id}:`,
            err,
          );
        }
      }
    }
  }

  /**
   * NPC config for procedural building NPCs (not in npcs.json manifest).
   * Each npcType maps to display name, description, and services.
   */
  private static readonly BUILDING_NPC_CONFIG: Record<
    string,
    { name: string; description: string; services: string[]; model: string }
  > = {
    innkeeper: {
      name: "Innkeeper",
      description: "The innkeeper tends the bar and rents rooms.",
      services: ["rest", "food"],
      model: "asset://models/npcs/Lowe/Lowe.vrm",
    },
    banker: {
      name: "Banker",
      description: "A banker who manages your deposits.",
      services: ["bank"],
      model: "asset://models/npcs/banker/banker.vrm",
    },
    blacksmith: {
      name: "Blacksmith",
      description: "A skilled blacksmith working the forge.",
      services: ["repair", "smithing"],
      model: "asset://models/npcs/horvik/Horvik.vrm",
    },
    shopkeeper: {
      name: "Shopkeeper",
      description: "A general store shopkeeper with various wares.",
      services: ["shop"],
      model: "asset://models/npcs/shopkeeper/shopkeeper.vrm",
    },
    priest: {
      name: "Priest",
      description: "A priest offering blessings and guidance.",
      services: ["prayer", "blessing"],
      model: "asset://models/npcs/Zamorin/Zamorin.vrm",
    },
    "guild-master": {
      name: "Guild Master",
      description: "The guild master oversees guild operations.",
      services: ["guild", "quests"],
      model: "asset://models/npcs/dommik/Dommik.vrm",
    },
    mayor: {
      name: "Mayor",
      description: "The town mayor manages local affairs.",
      services: ["quests", "governance"],
      model: "asset://models/npcs/tanner-ellis/tanner-ellis.vrm",
    },
    noble: {
      name: "Noble",
      description: "A noble resident of the estate.",
      services: ["quests"],
      model: "asset://models/npcs/fisherman-pete/fisherman-pete.vrm",
    },
    "guard-captain": {
      name: "Guard Captain",
      description: "The guard captain oversees the garrison.",
      services: ["quests", "bounties"],
      model: "asset://models/npcs/captain-rowan/captain-rowan.vrm",
    },
    lord: {
      name: "Lord",
      description: "The lord of this castle commands the region.",
      services: ["quests", "governance"],
      model: "asset://models/npcs/forester-wilma/forester-wilma.vrm",
    },
  };

  /**
   * Spawn procedural NPCs inside town buildings.
   * Uses TownSystem.getAllBuildingNPCSpawnPoints() to get spawn positions
   * computed from building layouts (behind counters, near forges, etc.).
   */
  private async spawnBuildingNPCs(): Promise<void> {
    if (!this.townSystem) {
      console.log(
        "[MobNPCSpawnerSystem] No TownSystem available - skipping building NPCs",
      );
      return;
    }

    const entityManager = this.world.getSystem<EntityManager>("entity-manager");
    if (!entityManager) {
      console.error(
        "[MobNPCSpawnerSystem] ❌ EntityManager not available for building NPC spawning",
      );
      return;
    }

    const spawnPoints = this.townSystem.getAllBuildingNPCSpawnPoints();
    if (spawnPoints.length === 0) {
      console.log("[MobNPCSpawnerSystem] No building NPC spawn points found");
      return;
    }

    let spawnedCount = 0;
    for (const point of spawnPoints) {
      if (this.npcSpawningStopped) return;
      const config = MobNPCSpawnerSystem.BUILDING_NPC_CONFIG[point.npcType];
      if (!config) {
        console.warn(
          `[MobNPCSpawnerSystem] ⚠️ Unknown building NPC type: ${point.npcType}`,
        );
        continue;
      }

      // Unique NPC name per building: e.g. "Innkeeper of Oakvale"
      const npcName = `${config.name} of ${point.townName}`;
      const npcId = await MobNPCSpawnerSystem.npcPlacementId("building_npc_", [
        point.townId,
        point.buildingId,
      ]);

      // Convert rotation (radians) to quaternion for Y-axis rotation
      const halfAngle = point.rotation / 2;
      const qw = Math.cos(halfAngle);
      const qy = Math.sin(halfAngle);

      const npcConfig = {
        id: npcId,
        type: EntityType.NPC,
        name: npcName,
        position: point.position,
        rotation: { x: 0, y: qy, z: 0, w: qw },
        scale: { x: 100, y: 100, z: 100 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.TALK,
        interactionDistance: 3,
        description: config.description,
        model: config.model,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: { current: 1, max: 1 },
          level: 1,
        },
        npcType: point.npcType,
        npcId: point.buildingId,
        dialogueLines: [],
        services: config.services,
        inventory: [],
        skillsOffered: [],
        questsAvailable: [],
      };

      try {
        if (await this.spawnNPCPlacement(entityManager, npcConfig))
          spawnedCount++;
      } catch (err) {
        console.error(
          `[MobNPCSpawnerSystem] ❌ Failed to spawn building NPC ${npcId}:`,
          err,
        );
      }
    }

    console.log(
      `[MobNPCSpawnerSystem] ✅ Spawned ${spawnedCount}/${spawnPoints.length} building NPCs across ${this.townSystem.getTowns().length} towns`,
    );
  }

  /**
   * Spawn default test mobs for initial world content
   * Spawns multiple goblins around the spawn area for testing
   */
  private async spawnDefaultMob(): Promise<void> {
    // Wait for EntityManager to be ready
    let entityManager = this.world.getSystem<EntityManager>("entity-manager");
    let attempts = 0;

    while (!entityManager && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      entityManager = this.world.getSystem<EntityManager>("entity-manager");
      attempts++;
    }

    if (!entityManager) {
      console.error(
        "[MobNPCSpawnerSystem] ❌ EntityManager never became available after 10 seconds!",
      );
      return;
    }

    // Get goblin data from manifest - fail fast if not found
    const goblinData = getNPCById("goblin");

    if (!goblinData) {
      console.error(
        `[MobNPCSpawnerSystem] ❌ NPC manifest not found for 'goblin'. ` +
          `Ensure npcs.json is loaded and contains this NPC type.`,
      );
      return;
    }

    if (!goblinData.appearance?.modelPath) {
      console.error(
        `[MobNPCSpawnerSystem] ❌ NPC 'goblin' has no modelPath defined in manifest.`,
      );
      return;
    }

    // Spawn multiple test goblins around the spawn area
    const testPositions = [
      { x: 8, z: 8 }, // Near spawn, north-east
      { x: -8, z: 8 }, // Near spawn, north-west
      { x: 12, z: -5 }, // East of spawn
      { x: -12, z: -5 }, // West of spawn
      { x: 15, z: 15 }, // Further north-east
    ];

    let spawnedCount = 0;
    for (let i = 0; i < testPositions.length; i++) {
      const pos = testPositions[i];
      // Get terrain height at position
      const terrainHeight = this.terrainSystem.getHeightAt(pos.x, pos.z);
      const spawnPosition = { x: pos.x, y: terrainHeight, z: pos.z };

      // Build mob config from manifest data
      const mobConfig = {
        id: `default_goblin_${i + 1}`,
        type: EntityType.MOB,
        name: goblinData.name,
        position: spawnPosition,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: {
          x: goblinData.appearance.scale ?? 1,
          y: goblinData.appearance.scale ?? 1,
          z: goblinData.appearance.scale ?? 1,
        },
        visible: true,
        interactable: true,
        interactionType: InteractionType.ATTACK,
        interactionDistance: 10,
        description: goblinData.description,
        model: goblinData.appearance.modelPath,
        properties: {
          movementComponent: null,
          combatComponent: null,
          healthComponent: null,
          visualComponent: null,
          health: {
            current: goblinData.stats.health,
            max: goblinData.stats.health,
          },
          level: goblinData.stats.level,
        },
        // MobEntity specific - from manifest
        mobType: goblinData.id,
        level: goblinData.stats.level,
        currentHealth: goblinData.stats.health,
        maxHealth: goblinData.stats.health,
        attack: goblinData.stats.attack,
        attackPower: goblinData.stats.strength,
        defense: goblinData.stats.defense,
        attackSpeedTicks: goblinData.combat.attackSpeedTicks,
        moveSpeed: goblinData.movement.speed,
        xpReward: goblinData.combat.xpReward,
        lootTable: goblinData.drops.common.map((drop) => ({
          itemId: drop.itemId,
          minQuantity: drop.minQuantity,
          maxQuantity: drop.maxQuantity,
          chance: drop.chance,
        })),
        spawnPoint: spawnPosition,
        aggressive: goblinData.combat.aggressive,
        retaliates: goblinData.combat.retaliates,
        attackable: goblinData.combat.attackable ?? true,
        movementType: goblinData.movement.type,
        aggroRange: goblinData.combat.aggroRange,
        combatRange: goblinData.combat.combatRange,
        leashRange: goblinData.combat.leashRange,
        wanderRadius: goblinData.movement.wanderRadius,
        aiState: "idle",
        targetPlayerId: null,
        lastAttackTime: 0,
        deathTime: null,
        respawnTime: goblinData.combat.respawnTime,
      };

      try {
        await entityManager.spawnEntity(mobConfig);
        spawnedCount++;
      } catch (err) {
        console.error(
          `[MobNPCSpawnerSystem] ❌ Error spawning goblin ${i + 1}:`,
          err,
        );
      }
    }

    console.log(
      `[MobNPCSpawnerSystem] ✅ Spawned ${spawnedCount} test goblins around spawn area`,
    );
  }

  private getMobLevelRange(mobData: NPCData): LevelRange {
    const fallback = {
      min: mobData.stats.level,
      max: mobData.stats.level,
    };

    const range = mobData.levelRange;
    if (!range) {
      return fallback;
    }

    const min = Math.max(1, Math.floor(range.min));
    const max = Math.max(min, Math.floor(range.max));
    return { min, max };
  }

  private clampLevelToRange(level: number, range: LevelRange): number {
    if (level < range.min) return range.min;
    if (level > range.max) return range.max;
    return level;
  }

  private selectMobForLevel(
    mobTypes: string[],
    targetLevel: number,
    rng?: () => number,
  ): { mobData: NPCData; levelRange: LevelRange } | null {
    const candidates: Array<{
      mobData: NPCData;
      levelRange: LevelRange;
      distance: number;
    }> = [];

    for (const mobType of mobTypes) {
      const mobData = getNPCById(mobType);
      if (!mobData) continue;
      if (mobData.category !== "mob") continue;

      const levelRange = this.getMobLevelRange(mobData);
      const distance =
        targetLevel < levelRange.min
          ? levelRange.min - targetLevel
          : targetLevel > levelRange.max
            ? targetLevel - levelRange.max
            : 0;

      candidates.push({ mobData, levelRange, distance });
    }

    if (candidates.length === 0) {
      return null;
    }

    const inRange = candidates.filter((candidate) => candidate.distance === 0);
    const pool = inRange.length > 0 ? inRange : candidates;
    const minDistance = Math.min(
      ...pool.map((candidate) => candidate.distance),
    );
    const closest = pool.filter(
      (candidate) => candidate.distance === minDistance,
    );
    const roll = rng ? rng() : Math.random();
    const pickIndex = Math.floor(roll * closest.length);
    const selected = closest[pickIndex] ?? closest[0];
    return {
      mobData: selected.mobData,
      levelRange: selected.levelRange,
    };
  }

  private countLiveBanditsWorldwide(): number {
    const entityManager = this.world.getSystem<EntityManager>("entity-manager");
    if (!entityManager) {
      return 0;
    }
    const mobs = entityManager.getEntitiesByType(EntityType.MOB);
    let count = 0;
    for (const entity of mobs) {
      if (!(entity instanceof MobEntity)) {
        continue;
      }
      if (entity.isDead()) {
        continue;
      }
      if (MobNPCSpawnerSystem.banditCapIds.has(entity.getMobData().type)) {
        count += 1;
      }
    }
    return count;
  }

  private selectBossForHotspot(seed: number): NPCData | null {
    const bosses = Array.from(ALL_NPCS.values()).filter(
      (npc) => npc.category === "boss" && npc.spawnCategory === "world",
    );
    if (bosses.length === 0) {
      return null;
    }
    const index = Math.min(bosses.length - 1, Math.floor(seed * bosses.length));
    return bosses[index] ?? bosses[0];
  }

  private async spawnMobFromData(
    mobData: NPCData,
    position: { x: number; y: number; z: number },
    options?: SpawnMobOptions,
  ): Promise<void> {
    if (
      options?.sourceTileKey &&
      !this.activeMobTiles.has(options.sourceTileKey)
    ) {
      return;
    }

    // Check if position is in a procedural town safe zone - don't spawn mobs there
    if (
      this.townSystem &&
      this.townSystem.isInSafeZone(position.x, position.z)
    ) {
      return;
    }

    if (MobNPCSpawnerSystem.banditCapIds.has(mobData.id)) {
      if (
        this.countLiveBanditsWorldwide() >= MOB_CONSTANTS.MAX_BANDIT_MOBS_WORLD
      ) {
        return;
      }
    }

    const resolvedRange =
      options && options.levelRange
        ? options.levelRange
        : this.getMobLevelRange(mobData);
    const requestedLevel =
      options && typeof options.level === "number"
        ? options.level
        : mobData.stats.level;
    const level = this.clampLevelToRange(requestedLevel, resolvedRange);

    // Use spawn point position as key to prevent duplicates (same spot = same mob)
    const spawnKey =
      options && options.spawnKey
        ? options.spawnKey
        : `${mobData.id}_${Math.round(position.x)}_${Math.round(position.z)}`;

    // Check if we already spawned at this location
    if (this.spawnedMobs.has(spawnKey)) {
      return;
    }

    // Generate unique mob ID for the entity
    const mobId = `gdd_${mobData.id}_${this.mobIdCounter++}`;

    // Track this spawn point BEFORE spawning to prevent race conditions
    this.spawnedMobs.set(spawnKey, mobId);
    this.entityIdToSpawnKey.set(mobId, spawnKey);
    const isBoss = options?.isBoss === true;
    this.spawnedMobDetails.set(spawnKey, {
      spawnKey,
      mobId,
      mobType: mobData.id,
      level,
      position,
      levelRange: resolvedRange,
      isBoss,
      sourceTileKey: options?.sourceTileKey,
    });
    if (options?.sourceTileKey) {
      const ownedSpawns =
        this.tileSpawnKeys.get(options.sourceTileKey) ?? new Set<string>();
      ownedSpawns.add(spawnKey);
      this.tileSpawnKeys.set(options.sourceTileKey, ownedSpawns);
    }

    // Get EntityManager to spawn directly (like original spawnDefaultMob)
    const entityManager = this.world.getSystem<EntityManager>("entity-manager");
    if (!entityManager) {
      console.error("[MobNPCSpawnerSystem] EntityManager not available");
      this.forgetSpawnKey(spawnKey);
      return;
    }

    const scaled = entityManager.getScaledMobStats(mobData.id, level);

    // Build COMPLETE config from manifest data (matching original hardcoded format)
    const mobConfig = {
      id: mobId,
      type: EntityType.MOB,
      name: `${mobData.name} (Lv${level})`,
      position: position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: {
        x: mobData.appearance.scale ?? 1,
        y: mobData.appearance.scale ?? 1,
        z: mobData.appearance.scale ?? 1,
      },
      visible: true,
      interactable: true,
      interactionType: InteractionType.ATTACK,
      interactionDistance: 10,
      description: `${mobData.description} (Level ${level})`,
      model: mobData.appearance.modelPath,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: scaled.maxHealth, max: scaled.maxHealth },
        level: level,
      },
      // MobEntity specific - from manifest
      mobType: mobData.id,
      level,
      currentHealth: scaled.maxHealth,
      maxHealth: scaled.maxHealth,
      attack: scaled.attack,
      attackPower: scaled.attackPower,
      defense: scaled.defense,
      defenseBonus: scaled.defenseBonus,
      attackSpeedTicks: scaled.attackSpeedTicks,
      moveSpeed: scaled.moveSpeed,
      xpReward: scaled.xpReward,
      lootTable: mobData.drops.common.map((drop) => ({
        itemId: drop.itemId,
        minQuantity: drop.minQuantity,
        maxQuantity: drop.maxQuantity,
        chance: drop.chance,
      })),
      spawnPoint: position,
      aggressive: mobData.combat.aggressive,
      retaliates: mobData.combat.retaliates,
      attackable: mobData.combat.attackable ?? true,
      movementType: mobData.movement.type,
      aggroRange: scaled.aggroRange,
      combatRange: scaled.combatRange,
      leashRange: mobData.combat.leashRange,
      attackType: mobData.combat.attackType ?? "melee",
      spellId: mobData.combat.spellId,
      arrowId: mobData.combat.arrowId,
      wanderRadius: scaled.wanderRadius,
      aiState: "idle",
      targetPlayerId: null,
      lastAttackTime: 0,
      deathTime: null,
      respawnTime: mobData.combat.respawnTime,
    };

    try {
      await entityManager.spawnEntity(mobConfig);
      // Terrain can unload while an async entity spawn is in flight. Never let
      // a late completion resurrect an entity owned by an inactive tile.
      if (
        options?.sourceTileKey &&
        !this.activeMobTiles.has(options.sourceTileKey)
      ) {
        entityManager.destroyEntity(mobId);
        this.forgetSpawnKey(spawnKey);
      }
    } catch (err) {
      this.forgetSpawnKey(spawnKey);
      console.error(`[MobNPCSpawnerSystem] Error spawning ${mobData.id}:`, err);
    }
  }

  private forgetSpawnKey(spawnKey: string): void {
    const entityId = this.spawnedMobs.get(spawnKey);
    const detail = this.spawnedMobDetails.get(spawnKey);
    if (entityId) this.entityIdToSpawnKey.delete(entityId);
    if (detail?.sourceTileKey) {
      const ownedSpawns = this.tileSpawnKeys.get(detail.sourceTileKey);
      ownedSpawns?.delete(spawnKey);
      if (ownedSpawns?.size === 0) {
        this.tileSpawnKeys.delete(detail.sourceTileKey);
      }
    }
    if (detail?.isBoss && spawnKey.startsWith("boss_")) {
      this.spawnedBossHotspots.delete(spawnKey.slice("boss_".length));
    }
    this.spawnedMobs.delete(spawnKey);
    this.spawnedMobDetails.delete(spawnKey);
  }

  private despawnSpawnKey(spawnKey: string): void {
    const entityId = this.spawnedMobs.get(spawnKey);
    this.forgetSpawnKey(spawnKey);
    if (entityId) {
      this.emitTypedEvent(EventType.ENTITY_DEATH, { entityId });
    }
  }

  // Note: This system intentionally does not handle MOB_NPC_SPAWN_REQUEST events to prevent
  // recursive re-emission loops. It only produces spawn requests via spawnMobFromData.

  private despawnMob(mobId: string): void {
    const spawnKey = this.spawnedMobs.has(mobId)
      ? mobId
      : this.entityIdToSpawnKey.get(mobId);
    if (spawnKey) this.despawnSpawnKey(spawnKey);
  }

  private respawnAllMobs(): void {
    // Kill all existing mobs
    for (const [_mobId, entityId] of this.spawnedMobs) {
      this.emitTypedEvent(EventType.ENTITY_DEATH, { entityId });
    }
    this.spawnedMobs.clear();
    this.spawnedMobDetails.clear();
    this.entityIdToSpawnKey.clear();
    this.tileSpawnKeys.clear();
    this.spawnedBossHotspots.clear();

    // Mobs will respawn naturally as terrain tiles remain loaded
    // TerrainSystem will re-emit TERRAIN_TILE_GENERATED which will trigger mob spawning
  }

  // Public API
  getSpawnedMobs(): Map<string, string> {
    return this.spawnedMobs;
  }

  getMobCount(): number {
    return this.spawnedMobs.size;
  }

  getMobsByType(mobType: string): string[] {
    const mobEntityIds: string[] = [];
    for (const [id, entityId] of this.spawnedMobs) {
      if (id.includes(mobType)) {
        mobEntityIds.push(entityId);
      }
    }
    return mobEntityIds;
  }

  getSpawnedMobDetails(): SpawnedMobDetail[] {
    return Array.from(this.spawnedMobDetails.values());
  }

  getMobStats(): MobSpawnStats {
    const stats = {
      totalMobs: this.spawnedMobs.size,
      level1Mobs: 0,
      level2Mobs: 0,
      level3Mobs: 0,
      byType: {} as Record<string, number>,
      spawnedMobs: this.spawnedMobs.size,
    };

    for (const [mobId] of this.spawnedMobs) {
      for (const mobType of ALL_NPCS.keys()) {
        if (mobId.includes(mobType)) {
          stats.byType[mobType] = (stats.byType[mobType] || 0) + 1;
        }
      }
    }

    return stats;
  }

  /**
   * Handle terrain tile generation - spawn mobs for new tiles
   * Only runs on server - clients receive entities via network sync
   */
  private onTileGenerated(tileData: {
    tileX: number;
    tileZ: number;
    biome: string;
    contentGenerated?: boolean;
  }): void {
    // CRITICAL: Only server should spawn mobs - clients receive them via network sync
    if (!this.world.isServer) {
      return;
    }

    // Horizon tiles contain geometry only. Treat legacy events without this
    // flag as full-content events for backwards compatibility.
    if (tileData.contentGenerated === false) {
      return;
    }

    const sourceTileKey = `${tileData.tileX}_${tileData.tileZ}`;
    this.activeMobTiles.add(sourceTileKey);

    const TILE_SIZE = this.terrainSystem.getTileSize();
    const tileBounds = {
      minX: tileData.tileX * TILE_SIZE,
      maxX: (tileData.tileX + 1) * TILE_SIZE,
      minZ: tileData.tileZ * TILE_SIZE,
      maxZ: (tileData.tileZ + 1) * TILE_SIZE,
    };

    // Find which world areas overlap with this new tile
    const overlappingAreas: Array<
      (typeof ALL_WORLD_AREAS)[keyof typeof ALL_WORLD_AREAS]
    > = [];
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      const areaBounds = area.bounds;
      // Simple bounding box overlap check
      if (
        tileBounds.minX < areaBounds.maxX &&
        tileBounds.maxX > areaBounds.minX &&
        tileBounds.minZ < areaBounds.maxZ &&
        tileBounds.maxZ > areaBounds.minZ
      ) {
        overlappingAreas.push(area);
      }
    }

    if (overlappingAreas.length > 0) {
      this.generateContentForTile(tileData, overlappingAreas, sourceTileKey);
    }

    // Don't spawn biome mobs or bosses inside safe zones (e.g. duel arena, lobby, hospital).
    // generateMobSpawnsForArea already skips safe zones for manifest-defined spawns; this
    // mirrors that check for terrain-based biome mobs which bypass the area filter entirely.
    const tileInSafeZone = overlappingAreas.some((area) => area.safeZone);
    if (!tileInSafeZone) {
      this.spawnBiomeMobsForTile(tileData, sourceTileKey);
      this.spawnBossForTile(tileData, sourceTileKey);
    }
  }

  private onTileUnloaded(tileData: { tileX: number; tileZ: number }): void {
    if (!this.world.isServer) return;
    const sourceTileKey = `${tileData.tileX}_${tileData.tileZ}`;
    this.activeMobTiles.delete(sourceTileKey);
    const spawnKeys = this.tileSpawnKeys.get(sourceTileKey);
    if (!spawnKeys) return;

    // Copy before despawning because forgetSpawnKey mutates the ownership set.
    for (const spawnKey of [...spawnKeys]) {
      this.despawnSpawnKey(spawnKey);
    }
    this.tileSpawnKeys.delete(sourceTileKey);
  }

  /**
   * Generate mobs for overlapping world areas
   */
  private generateContentForTile(
    tileData: { tileX: number; tileZ: number },
    areas: Array<(typeof ALL_WORLD_AREAS)[keyof typeof ALL_WORLD_AREAS]>,
    sourceTileKey: string,
  ): void {
    for (const area of areas) {
      // Spawn mobs from world-areas.ts data if they fall within this tile
      this.generateMobSpawnsForArea(area, tileData, sourceTileKey);
    }
  }

  private spawnBiomeMobsForTile(
    tileData: {
      tileX: number;
      tileZ: number;
    },
    sourceTileKey: string,
  ): void {
    const spawnPositions = this.terrainSystem.getMobSpawnPositionsForTile(
      tileData.tileX,
      tileData.tileZ,
      this.BIOME_SPAWNS_PER_TILE,
    );
    const rng = this.terrainSystem.createDeterministicRng(
      tileData.tileX,
      tileData.tileZ,
      "biome-mobs",
    );

    for (const [spawnIndex, spawn] of spawnPositions.entries()) {
      if (!spawn.mobTypes || spawn.mobTypes.length === 0) continue;

      const difficultySample = this.terrainSystem.getDifficultyAtWorldPosition(
        spawn.position.x,
        spawn.position.z,
        spawn.difficulty,
      );

      if (difficultySample.isSafe || difficultySample.level <= 0) continue;

      const selection = this.selectMobForLevel(
        spawn.mobTypes,
        difficultySample.level,
        rng,
      );
      if (!selection) continue;

      this.spawnMobFromData(selection.mobData, spawn.position, {
        level: difficultySample.level,
        levelRange: selection.levelRange,
        sourceTileKey,
        spawnKey: `biome_${sourceTileKey}_${spawnIndex}`,
      });
    }
  }

  private spawnBossForTile(
    tileData: { tileX: number; tileZ: number },
    sourceTileKey: string,
  ): void {
    const tileSize = this.terrainSystem.getTileSize();
    const tileMinX = tileData.tileX * tileSize;
    const tileMaxX = (tileData.tileX + 1) * tileSize;
    const tileMinZ = tileData.tileZ * tileSize;
    const tileMaxZ = (tileData.tileZ + 1) * tileSize;

    const hotspots = this.terrainSystem.getBossHotspots();
    for (const hotspot of hotspots) {
      if (this.spawnedBossHotspots.has(hotspot.id)) {
        continue;
      }

      const closestX = Math.max(tileMinX, Math.min(hotspot.x, tileMaxX));
      const closestZ = Math.max(tileMinZ, Math.min(hotspot.z, tileMaxZ));
      const dx = hotspot.x - closestX;
      const dz = hotspot.z - closestZ;
      if (dx * dx + dz * dz > hotspot.radius * hotspot.radius) {
        continue;
      }

      const bossData = this.selectBossForHotspot(hotspot.seed);
      if (!bossData) {
        continue;
      }

      const bossLevel = this.terrainSystem.getBossLevelAtWorldPosition(
        hotspot.x,
        hotspot.z,
      );
      const levelRange = this.getMobLevelRange(bossData);
      const bossY = this.terrainSystem.getHeightAt(hotspot.x, hotspot.z);

      this.spawnedBossHotspots.add(hotspot.id);
      this.spawnMobFromData(
        bossData,
        { x: hotspot.x, y: bossY, z: hotspot.z },
        {
          level: bossLevel,
          levelRange,
          isBoss: true,
          spawnKey: `boss_${hotspot.id}`,
          sourceTileKey,
        },
      );
    }
  }

  /**
   * Spawn mobs from a world area when its tile generates
   */
  private generateMobSpawnsForArea(
    area: (typeof ALL_WORLD_AREAS)[keyof typeof ALL_WORLD_AREAS],
    tileData: { tileX: number; tileZ: number },
    sourceTileKey: string,
  ): void {
    if (area.safeZone || area.difficultyLevel <= 0) {
      return;
    }

    const TILE_SIZE = this.terrainSystem.getTileSize();

    for (const spawnPoint of area.mobSpawns) {
      const spawnTileX = Math.floor(spawnPoint.position.x / TILE_SIZE);
      const spawnTileZ = Math.floor(spawnPoint.position.z / TILE_SIZE);

      if (spawnTileX === tileData.tileX && spawnTileZ === tileData.tileZ) {
        const mobData = ALL_NPCS.get(spawnPoint.mobId);
        if (!mobData) continue;

        // Spawn maxCount mobs (default to 1 if not specified)
        const maxCount = spawnPoint.maxCount ?? 1;
        // Use spawnRadius for spreading, or 2 units if multiple mobs but no radius
        const effectiveRadius =
          spawnPoint.spawnRadius > 0
            ? spawnPoint.spawnRadius
            : maxCount > 1
              ? 2
              : 0;

        for (let i = 0; i < maxCount; i++) {
          // Calculate position: spread mobs evenly in circle when multiple
          let mobX = spawnPoint.position.x;
          let mobZ = spawnPoint.position.z;

          if (maxCount > 1) {
            // Deterministic positions: evenly spaced in a circle
            const angle = (i / maxCount) * Math.PI * 2;
            mobX += Math.cos(angle) * effectiveRadius;
            mobZ += Math.sin(angle) * effectiveRadius;
          }

          // Ground mob spawn to terrain height
          let mobY = spawnPoint.position.y;
          const th = this.terrainSystem.getHeightAt(mobX, mobZ);
          if (Number.isFinite(th)) mobY = th;

          const difficultySample =
            this.terrainSystem.getDifficultyAtWorldPosition(
              mobX,
              mobZ,
              area.difficultyLevel,
            );
          if (difficultySample.isSafe || difficultySample.level <= 0) {
            continue;
          }

          const levelRange = this.getMobLevelRange(mobData);
          this.spawnMobFromData(
            mobData,
            { x: mobX, y: mobY, z: mobZ },
            {
              level: difficultySample.level,
              levelRange,
              sourceTileKey,
              spawnKey: `area_${sourceTileKey}_${mobData.id}_${Math.round(spawnPoint.position.x)}_${Math.round(spawnPoint.position.z)}_${i}`,
            },
          );
        }
      }
    }
  }

  // Required System lifecycle methods
  update(_dt: number): void {
    // Update mob behaviors, check for respawns, etc.
  }

  /**
   * Cleanup when system is destroyed
   */
  destroy(): void {
    this.npcSpawningStopped = true;
    // Clear all spawn tracking
    this.spawnedMobs.clear();
    this.spawnedMobDetails.clear();
    this.entityIdToSpawnKey.clear();
    this.tileSpawnKeys.clear();
    this.activeMobTiles.clear();
    this.spawnedBossHotspots.clear();

    // Reset counter
    this.mobIdCounter = 0;

    // Call parent cleanup
    super.destroy();
  }
}
