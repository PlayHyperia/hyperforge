/**
 * MobEntity - Enemy/Monster Entity
 *
 * Represents hostile creatures (mobs) in the game world. Handles combat AI,
 * patrolling, aggression, and loot drops.
 *
 * **Extends**: CombatantEntity (inherits health, combat, and damage)
 *
 * **Key Features**:
 *
 * **AI Behavior**:
 * - Idle state: Stands still or patrols spawn area
 * - Patrol state: Walks between patrol points
 * - Aggro state: Detected player within aggro radius
 * - Combat state: Actively attacking target
 * - Fleeing state: Low health retreat (future)
 * - Dead state: Corpse state before despawn
 *
 * **Combat System**:
 * - Attack power and speed
 * - Defense rating
 * - Attack range (melee or ranged)
 * - Aggro radius (detection range)
 * - Combat level for XP calculations
 * - Attack styles (melee, ranged, magic)
 *
 * **Patrol System**:
 * - Generates random patrol points around spawn
 * - Walks between points when not in combat
 * - Returns to spawn area if pulled too far
 * - Configurable patrol radius
 *
 * **Aggression**:
 * - Aggro radius determines detection range
 * - Remembers last attacker
 * - Chases target within leash distance
 * - Resets when target dies or escapes
 *
 * **Loot System**:
 * - Drops items on death based on loot table
 * - Quantity randomization
 * - Rare drop chances
 * - Corpse despawn timer
 *
 * **Respawning**:
 * - Respawn timer after death
 * - Resets to spawn position
 * - Full health restoration
 * - State reset (clears aggro, target)
 *
 * **Visual Representation**:
 * - 3D model (GLB) or procedural mesh
 * - Health bar when damaged
 * - Death animation
 * - Attack animations
 * - Name shown in right-click menu (classic MMORPG pattern)
 *
 * **Network Sync**:
 * - Position broadcast to clients
 * - State changes (idle, combat, dead)
 * - Health updates
 * - Target information
 *
 * **Database**: Mob instances are NOT persisted (respawn from spawn points)
 *
 * **Runs on**: Server (authoritative), Client (visual only)
 * **Referenced by**: MobNPCSystem, MobNPCSpawnerSystem, CombatSystem, AggroSystem
 *
 * @public
 */

import THREE, {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from "../../extras/three/three";
import type {
  EntityData,
  MeshUserData,
  MobEntityData,
  Position3D,
} from "../../types";
import { AttackType } from "../../types/core/core";
import type {
  EntityInteractionData,
  MobEntityConfig,
} from "../../types/entities";
import { MobAIState } from "../../types/entities";
import { EventType } from "../../types/events";
import type { World } from "../../core/World";
import { CombatantEntity, type CombatantConfig } from "../CombatantEntity";
import { modelCache } from "../../utils/rendering/ModelCache";
import type {
  VRMAvatarInstance,
  LoadedAvatar,
} from "../../types/rendering/nodes";
import { Emotes } from "../../data/playerEmotes";
// NOTE: Loot drops are handled by LootSystem, not MobEntity directly
import { DeathStateManager } from "../managers/DeathStateManager";
import { CombatStateManager } from "../managers/CombatStateManager";
import {
  AIStateMachine,
  type AIStateContext,
} from "../managers/AIStateMachine";
import {
  generateKillToken,
  MAX_MOB_COMBAT_DAMAGE,
} from "../../utils/game/KillTokenUtils";
import { generateGroundItemMobLootOperationId } from "../../utils/game/GroundItemSourceIdentity";
import { RespawnManager } from "../managers/RespawnManager";
import type {
  HealthBars as HealthBarsSystem,
  HealthBarHandle,
} from "../../systems/client/HealthBars";
import { COMBAT_CONSTANTS } from "../../constants/CombatConstants";
import { DISTANCE_CONSTANTS } from "../../constants/GameConstants";
import { ticksToMs } from "../../utils/game/CombatCalculations";
import { AggroManager } from "../managers/AggroManager";
import {
  worldToTile,
  tileToWorld,
  TICK_DURATION_MS,
  tileChebyshevDistance,
  getBestStepOutTile,
  type TileCoord,
} from "../../systems/shared/movement/TileSystem";
import { CollisionMask } from "../../systems/shared/movement/CollisionFlags";
import type { EntityID } from "../../types/core/identifiers";
import { getNPCSize, getOccupiedTiles } from "./LargeNPCSupport";
import { getGameRng } from "../../utils/SeededRandom";
import { isTerrainSystem } from "../../utils/typeGuards";
import {
  AnimationLOD,
  getCameraPosition,
} from "../../utils/rendering/AnimationLOD";
import { RAYCAST_PROXY } from "../../systems/client/interaction/constants";
import type { AggroSystem } from "../../systems/shared/combat/AggroSystem";

// Polyfill ProgressEvent for Node.js server environment

if (typeof ProgressEvent === "undefined") {
  const ProgressEventPolyfill = class extends Event {
    lengthComputable = false;
    loaded = 0;
    total = 0;
    constructor(
      type: string,
      init?: { lengthComputable?: boolean; loaded?: number; total?: number },
    ) {
      super(type);
      if (init) {
        this.lengthComputable = init.lengthComputable || false;
        this.loaded = init.loaded || 0;
        this.total = init.total || 0;
      }
    }
  };
  (
    globalThis as unknown as { ProgressEvent?: typeof ProgressEventPolyfill }
  ).ProgressEvent = ProgressEventPolyfill;
}

/** Valid melee attack styles for XP validation (avoids granting wrong XP type) */
const MELEE_STYLES = new Set([
  "accurate",
  "aggressive",
  "defensive",
  "controlled",
]);

const MOB_IMPOSTOR_DISTANCES = {
  impostorDistance: 60,
  cullDistance: DISTANCE_CONSTANTS.RENDER.MOB,
  hysteresis: 5,
} as const;

export class MobEntity extends CombatantEntity {
  private static readonly loggedNullVrmModels = new Set<string>();

  protected config: MobEntityConfig;

  private deathManager: DeathStateManager;
  private combatManager: CombatStateManager;
  private aiStateMachine: AIStateMachine;
  private respawnManager: RespawnManager;
  private aggroManager: AggroManager;

  private _avatarInstance: VRMAvatarInstance | null = null;
  private _currentEmote: string | null = null;
  private _serverEmote: string | null = null; // Server-forced one-shot emote (e.g., combat)
  private _pendingServerEmote: string | null = null; // Emote received before VRM loaded - apply when ready
  private _manualEmoteOverrideUntil: number = 0; // Timestamp until which manual emote override is active
  private _tempMatrix = new THREE.Matrix4();
  private _tempScale = new THREE.Vector3(1, 1, 1);
  // Pre-allocated temps for update/lateUpdate to avoid per-frame allocations
  private _healthBarMatrix = new THREE.Matrix4();
  private _combatQuat = new THREE.Quaternion();
  private _combatAxis = new THREE.Vector3(0, 1, 0);
  private _targetQuat = new THREE.Quaternion();
  private _targetAxis = new THREE.Vector3(0, 1, 0);
  private _terrainWarningLogged = false;
  private _hasValidTerrainHeight = false;
  // Track if we've received authoritative position from server (Issue #416 fix)
  // Ensures all clients start with same XZ before terrain snapping
  private _hasReceivedServerPosition = false;
  // Track if death position has been terrain-snapped (Issue #244 fix)
  // Ensures death animation plays at ground level, not floating
  private _deathPositionTerrainSnapped = false;
  // PERFORMANCE: Raycast proxy for fast click detection
  // VRM SkinnedMesh raycast is extremely slow (~700-1800ms) because THREE.js
  // must transform every vertex by bone weights. This simple capsule is instant.
  private _raycastProxy: THREE.Mesh | null = null;
  // Track if visibility needs to be restored after respawn position update
  private _pendingRespawnRestore = false;

  private patrolPoints: Array<{ x: number; z: number }> = [];
  private currentPatrolIndex = 0;

  private _wanderTarget: { x: number; z: number } | null = null;
  private _lastPosition: THREE.Vector3 = new THREE.Vector3();
  private _lastPositionValid = false;
  private _stuckTimer = 0;
  private readonly STUCK_TIMEOUT = 3000; // Give up after 3 seconds stuck
  // Tile movement throttling - prevent emitting duplicate move requests
  // Uses tick-based throttling (aligned with 600ms server ticks) instead of time-based
  private _lastRequestedTargetTile: { x: number; z: number } | null = null;
  private _lastMoveRequestTick: number = -1;

  // Pre-allocated buffers for zero-allocation hot path operations
  /** Reusable buffer for occupied tiles (max 5x5 = 25 tiles for large bosses) */
  private readonly _occupiedTilesBuffer: TileCoord[] = Array.from(
    { length: 25 },
    () => ({ x: 0, z: 0 }),
  );

  /** Reusable buffer for cardinal step-out tiles */
  private readonly _cardinalBuffer: TileCoord[] = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];

  /** Pre-allocated tile for current position */
  private readonly _currentTile: TileCoord = { x: 0, z: 0 };

  /** Shuffle indices for random cardinal selection (avoids array allocation) */
  private readonly _shuffleIndices: number[] = [0, 1, 2, 3];

  /** Tracked PLAYER_SET_DEAD handler for cleanup */
  private _playerDeadHandler: ((data: unknown) => void) | null = null;

  /** Cached NPC size (avoid repeated lookups) */
  private _cachedNPCSize: { width: number; depth: number } | null = null;

  /** Track if occupancy is currently registered */
  private _occupancyRegistered = false;

  /** Reusable tile for spawn checking */
  private readonly _spawnCheckTile: TileCoord = { x: 0, z: 0 };

  /** Max spiral search radius for unoccupied spawn tile */
  private readonly MAX_SPAWN_SEARCH_RADIUS = 10;

  /** Animation LOD controller - throttles animation updates for distant mobs */
  private readonly _animationLOD = new AnimationLOD({
    fullDistance: 25, // Full 60fps animation within 25m
    halfDistance: 45, // 30fps animation at 25-45m
    quarterDistance: 70, // 15fps animation at 45-70m
    pauseDistance: 110, // No animation beyond 110m (bind pose)
  });

  /** Emote name to URL mapping - pre-allocated to avoid allocation in hot path */
  private readonly _emoteMap: Record<string, string> = {
    idle: Emotes.IDLE,
    walk: Emotes.WALK,
    run: Emotes.RUN,
    combat: Emotes.COMBAT,
    death: Emotes.DEATH,
    victory: Emotes.VICTORY,
  };

  /** Duration of death animation in ticks (7 ticks = 4200ms at 600ms/tick) */
  private readonly DEATH_ANIMATION_TICKS = 7;

  /**
   * Find an unoccupied tile for spawning using spiral search
   *
   * classic MMORPG Mechanic: If spawn tile is occupied, search outward in expanding rings
   * until an unoccupied tile is found. Uses Chebyshev distance (8-connected).
   *
   * @param centerX - Center tile X coordinate
   * @param centerZ - Center tile Z coordinate
   * @returns Unoccupied tile coordinates, or null if none found within radius
   */
  private findUnoccupiedSpawnTile(
    centerX: number,
    centerZ: number,
  ): TileCoord | null {
    // Cache NPC size on first call
    if (!this._cachedNPCSize) {
      this._cachedNPCSize = getNPCSize(this.config.mobType);
    }

    // Check center tile first
    this._spawnCheckTile.x = centerX;
    this._spawnCheckTile.z = centerZ;

    // For multi-tile NPCs, check all tiles they would occupy
    const tileCount = getOccupiedTiles(
      this._spawnCheckTile,
      this._cachedNPCSize,
      this._occupiedTilesBuffer,
    );

    // Check if center is unoccupied (check all tiles for multi-tile NPCs)
    // Must check BOTH entity occupancy AND static collision (resources, stations)
    let centerOccupied = false;
    for (let i = 0; i < tileCount; i++) {
      const tile = this._occupiedTilesBuffer[i];
      // Check for other entities
      if (this.world.entityOccupancy.isOccupied(tile)) {
        centerOccupied = true;
        break;
      }
      // Check for static collision (trees, rocks, furnaces, etc.)
      if (
        this.world.collision.hasFlags(tile.x, tile.z, CollisionMask.BLOCKS_WALK)
      ) {
        centerOccupied = true;
        break;
      }
    }
    if (!centerOccupied) {
      return { x: centerX, z: centerZ };
    }

    // Spiral search outward in expanding rings (Chebyshev distance)
    // Ring order: distance 1 (8 tiles), distance 2 (16 tiles), etc.
    for (let dist = 1; dist <= this.MAX_SPAWN_SEARCH_RADIUS; dist++) {
      // Check all tiles at this Chebyshev distance
      // Iterate the ring: top row, bottom row, left column, right column (excluding corners already covered)
      for (let dx = -dist; dx <= dist; dx++) {
        for (let dz = -dist; dz <= dist; dz++) {
          // Only check tiles at exactly this distance (ring, not filled square)
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== dist) continue;

          const checkX = centerX + dx;
          const checkZ = centerZ + dz;

          this._spawnCheckTile.x = checkX;
          this._spawnCheckTile.z = checkZ;

          // Get occupied tiles for this candidate position
          const candTileCount = getOccupiedTiles(
            this._spawnCheckTile,
            this._cachedNPCSize,
            this._occupiedTilesBuffer,
          );

          // Check if all tiles are unoccupied
          // Must check BOTH entity occupancy AND static collision (resources, stations)
          let isValid = true;
          for (let i = 0; i < candTileCount; i++) {
            const tile = this._occupiedTilesBuffer[i];
            // Check for other entities
            if (this.world.entityOccupancy.isOccupied(tile)) {
              isValid = false;
              break;
            }
            // Check for static collision (trees, rocks, furnaces, etc.)
            if (
              this.world.collision.hasFlags(
                tile.x,
                tile.z,
                CollisionMask.BLOCKS_WALK,
              )
            ) {
              isValid = false;
              break;
            }
          }

          if (isValid) {
            return { x: checkX, z: checkZ };
          }
        }
      }
    }

    // No unoccupied tile found within radius - shouldn't happen in normal gameplay
    console.warn(
      `[MobEntity] No unoccupied spawn tile found within ${this.MAX_SPAWN_SEARCH_RADIUS} tiles for ${this.config.name}`,
    );
    return null;
  }

  /**
   * Register this mob's tile occupancy in EntityOccupancyMap
   *
   * Called after spawn/respawn to set collision flags on tiles this mob occupies.
   * Uses pre-allocated buffers to avoid hot path allocations.
   *
   * classic MMORPG Mechanic: Flags set when entity spawns/moves TO a tile
   * If spawn tile is occupied, finds nearby unoccupied tile first.
   */
  private registerOccupancy(): void {
    // Server-only: occupancy tracking is authoritative
    if (!this.world.isServer) return;

    // Cache NPC size on first call (avoids repeated lookups)
    if (!this._cachedNPCSize) {
      this._cachedNPCSize = getNPCSize(this.config.mobType);
    }

    // Get current world position and convert to tile
    const pos = this.getPosition();
    this._currentTile.x = Math.floor(pos.x);
    this._currentTile.z = Math.floor(pos.z);

    // Check if spawn tile is already occupied by another mob
    // If so, find an unoccupied tile nearby (rules-accurate: NPCs don't stack)
    const unoccupiedTile = this.findUnoccupiedSpawnTile(
      this._currentTile.x,
      this._currentTile.z,
    );

    if (
      unoccupiedTile &&
      (unoccupiedTile.x !== this._currentTile.x ||
        unoccupiedTile.z !== this._currentTile.z)
    ) {
      // Relocate mob to unoccupied tile
      const worldPos = tileToWorld(unoccupiedTile);
      this.position.x = worldPos.x;
      this.position.z = worldPos.z;
      // Update current tile to the new position
      this._currentTile.x = unoccupiedTile.x;
      this._currentTile.z = unoccupiedTile.z;
    }

    // Fill occupied tiles buffer (zero-allocation using pre-allocated buffer)
    const tileCount = getOccupiedTiles(
      this._currentTile,
      this._cachedNPCSize,
      this._occupiedTilesBuffer,
    );

    // Check if this mob should ignore collision (bosses, special NPCs)
    const ignoresCollision = this.config.ignoresEntityCollision === true;

    // Register with EntityOccupancyMap
    this.world.entityOccupancy.occupy(
      this.id as EntityID,
      this._occupiedTilesBuffer,
      tileCount,
      "mob",
      ignoresCollision,
    );

    this._occupancyRegistered = true;
  }

  /**
   * Remove this mob's tile occupancy from EntityOccupancyMap
   *
   * Called when mob dies or despawns to clear collision flags.
   *
   * classic MMORPG Mechanic: Flags removed when entity despawns/dies
   */
  private unregisterOccupancy(): void {
    // Server-only: occupancy tracking is authoritative
    if (!this.world.isServer) return;

    if (!this._occupancyRegistered) return;

    this.world.entityOccupancy.vacate(this.id as EntityID);
    this._occupancyRegistered = false;
  }

  /**
   * Update this mob's tile occupancy after movement
   *
   * Called after successful movement to update collision flags.
   * Uses atomic move() to avoid race conditions.
   *
   * classic MMORPG Mechanic: Flags removed from old tiles, added to new tiles (in order)
   * Called by MobTileMovementManager after successful movement.
   */
  public updateOccupancy(): void {
    // Server-only: occupancy tracking is authoritative
    if (!this.world.isServer) return;

    if (!this._occupancyRegistered) {
      // If not registered, register instead of update
      this.registerOccupancy();
      return;
    }

    // Cache NPC size on first call
    if (!this._cachedNPCSize) {
      this._cachedNPCSize = getNPCSize(this.config.mobType);
    }

    // Get current world position and convert to tile
    const pos = this.getPosition();
    this._currentTile.x = Math.floor(pos.x);
    this._currentTile.z = Math.floor(pos.z);

    // Fill occupied tiles buffer
    const tileCount = getOccupiedTiles(
      this._currentTile,
      this._cachedNPCSize,
      this._occupiedTilesBuffer,
    );

    // Atomic move (removes old, adds new)
    this.world.entityOccupancy.move(
      this.id as EntityID,
      this._occupiedTilesBuffer,
      tileCount,
    );
  }

  // Track the mob's current spawn location (changes on respawn)
  // This is different from respawnManager.getSpawnAreaCenter() which is fixed
  private _currentSpawnPoint: Position3D;

  private _justRespawned = false; // Track if we just respawned (for one-time logging)

  // AI runs once per server tick (600ms), not every frame (~16ms)
  private _lastAITick: number = -1;
  /** Cached AI context — closures capture `this`, so safe to reuse across ticks */
  private _cachedAIContext: AIStateContext | null = null;

  private _healthBarHandle: HealthBarHandle | null = null; // Handle to HealthBars system
  private _healthBarVisibleUntil: number = 0; // Timestamp when health bar should hide
  private _lastKnownHealth: number = 0; // Track previous health to detect damage

  async init(): Promise<void> {
    await super.init();

    // Register for update loop (CLIENT ONLY)
    // Client: VRM animations via clientUpdate()
    // Server: mobs are NOT in the hot set — serverUpdate() logic (death state,
    // target validation) is handled per-tick via runAITick() to reduce GC pressure.
    // With 98+ mobs, per-frame updates at 10Hz generated excessive garbage.
    if (!this.world.isServer) {
      this.world.setHot(this, true);
    }

    // Register with HealthBars system (client-side only)
    // Uses atlas-based instanced mesh for performance instead of sprite per mob
    if (!this.world.isServer) {
      const healthbars = this.world.systems.find(
        (s) =>
          (s as { systemName?: string }).systemName === "healthbars" ||
          s.constructor.name === "HealthBars",
      ) as HealthBarsSystem | undefined;

      if (healthbars) {
        this._healthBarHandle = healthbars.add(
          this.id,
          this.config.currentHealth,
          this.config.maxHealth,
        );
        // Health bar starts hidden (classic fantasy MMORPG pattern: only show during combat)
      }
    }

    this._lastKnownHealth = this.config.currentHealth;

    // TODO: Server-side validation disabled due to ProgressEvent polyfill issues
    // Validation happens on client side instead (see clientUpdate)
  }

  /**
   * Override initializeVisuals to skip sprite health bar creation
   * MobEntity uses HealthBars system (atlas + instanced mesh) instead
   */
  protected override initializeVisuals(): void {
    // Call parent but it won't create health bar for mobs because we override createHealthBar
    // Note: We still want name tags from Entity.ts if applicable
    // But mobs don't show nametags (names appear in the context menu only)
    // So just create the mesh without UI elements
  }

  constructor(world: World, config: MobEntityConfig) {
    // Convert MobEntityConfig to CombatantConfig format with proper type assertion
    // attackSpeedTicks is in game ticks (600ms each), convert to attacks/second for legacy field
    const attacksPerSecond = 1.0 / (config.attackSpeedTicks * 0.6);
    const combatConfig = {
      ...config,
      rotation: config.rotation || { x: 0, y: 0, z: 0, w: 1 },
      combat: {
        attack: Math.floor(config.attackPower / 10),
        defense: Math.floor(config.defense / 10),
        attackSpeed: attacksPerSecond,
        criticalChance: 0.05,
        combatLevel: config.level,
        respawnTime: config.respawnTime,
        aggroRadius: config.aggroRange,
        attackRange: config.combatRange,
      },
    } as unknown as CombatantConfig;

    super(world, combatConfig);
    this.config = config;

    // Entity constructor defaults to 100/100 - sync with config
    this.health = config.currentHealth;
    this.maxHealth = config.maxHealth;
    this.data.health = this.health;
    (this.data as { maxHealth?: number }).maxHealth = this.maxHealth;

    // Manifest is source of truth for respawnTime - no minimum enforcement
    if (!this.config.respawnTime) {
      this.config.respawnTime = 15000; // Default 15s if not specified
    }

    // Death State Manager
    this.deathManager = new DeathStateManager({
      respawnTime: this.config.respawnTime,
      deathAnimationDuration: this.DEATH_ANIMATION_TICKS * TICK_DURATION_MS,
      spawnPoint: this.config.spawnPoint,
    });

    // Wire up death manager callbacks (handles visibility during death animation only)
    this.deathManager.onMeshVisibilityChange((visible) => {
      if (this.mesh) {
        this.mesh.visible = visible;
      }
    });

    // NOTE: Respawn callback is now handled by RespawnManager, not DeathStateManager

    // Combat State Manager (TICK-BASED)
    // attackSpeedTicks from manifest is already in ticks
    this.combatManager = new CombatStateManager({
      attackPower: this.config.attackPower,
      attackSpeedTicks: this.config.attackSpeedTicks,
      attackRange: this.config.combatRange,
    });

    // Wire up combat manager callbacks
    this.combatManager.onAttack((targetId) => {
      this.performAttackAction(targetId);
    });

    // AI State Machine
    this.aiStateMachine = new AIStateMachine();

    // Aggro Manager - handles targeting and aggro detection
    this.aggroManager = new AggroManager({
      aggroRange: this.config.aggroRange,
      combatRange: this.config.combatRange,
    });

    // Respawn Manager - handles spawn area and respawn locations
    this.respawnManager = new RespawnManager({
      spawnAreaCenter: this.config.spawnPoint, // Use spawnPoint as center of spawn area
      spawnAreaRadius: this.config.wanderRadius || this.config.aggroRange, // Spawn anywhere within wander/aggro range
      respawnTimeMin: this.config.respawnTime,
      respawnTimeMax: this.config.respawnTime + 5000, // Add 5s randomness
    });

    // Wire up respawn manager callback
    this.respawnManager.onRespawn((spawnPoint) => {
      this.handleRespawn(spawnPoint);
    });

    // Listen for player deaths - disengage if we were targeting them
    this._playerDeadHandler = (data: unknown) => {
      const deathData = data as { playerId: string; isDead: boolean };
      if (
        deathData.isDead &&
        this.config.targetPlayerId === deathData.playerId
      ) {
        this.clearTargetAndExitCombat();
      }
    };
    this.world.on(EventType.PLAYER_SET_DEAD, this._playerDeadHandler);

    // CRITICAL: Server uses RespawnManager to generate random spawn position
    // Client uses position from config (which comes from network data - the server's authoritative position)
    // This prevents client from generating its own random position that differs from server
    let initialSpawnPoint: Position3D;

    if (this.world.isServer) {
      // Server: Generate random position within spawn area
      initialSpawnPoint = this.respawnManager.generateSpawnPoint();
    } else {
      // Client: Use position from network data (via config.spawnPoint)
      // The server already determined the correct position, client should not randomize
      initialSpawnPoint = { ...this.config.spawnPoint };
    }

    // Track current spawn location for AI (patrol, leashing, return)
    this._currentSpawnPoint = { ...initialSpawnPoint };

    this.setPosition(
      initialSpawnPoint.x,
      initialSpawnPoint.y,
      initialSpawnPoint.z,
    );
    this.node.position.set(
      initialSpawnPoint.x,
      initialSpawnPoint.y,
      initialSpawnPoint.z,
    );

    // Register tile occupancy for rules-accurate NPC collision
    // Called after position is set (server-only, no-op on client)
    this.registerOccupancy();

    this.generatePatrolPoints();

    // Set entity properties for systems to access
    this.setProperty("mobType", config.mobType);
    this.setProperty("level", config.level);
    this.setProperty("health", {
      current: config.currentHealth,
      max: config.maxHealth,
    });

    // Add stats component for skills system compatibility
    this.addComponent("stats", {
      // Combat stats - mobs have simplified skills
      attack: {
        level: Math.max(1, Math.floor(config.attackPower / 10)),
        xp: 0,
      },
      strength: {
        level: Math.max(1, Math.floor(config.attackPower / 10)),
        xp: 0,
      },
      defense: { level: Math.max(1, Math.floor(config.defense / 10)), xp: 0 },
      constitution: { level: Math.max(10, config.level), xp: 0 },
      ranged: { level: 1, xp: 0 }, // Most mobs don't use ranged
      // Non-combat skills not applicable to mobs
      woodcutting: { level: 1, xp: 0 },
      mining: { level: 1, xp: 0 },
      fishing: { level: 1, xp: 0 },
      firemaking: { level: 1, xp: 0 },
      cooking: { level: 1, xp: 0 },
      // Additional stats
      combatLevel: config.level,
      totalLevel: config.level * 5, // Approximate
      health: config.currentHealth,
      maxHealth: config.maxHealth,
      level: config.level,
      // HP stats for combat level calculation
      hitpoints: {
        level: Math.max(10, config.level),
        current: config.currentHealth,
        max: config.maxHealth,
      },
      prayer: { level: 1, points: 0 }, // Mobs don't use prayer
      magic: { level: 1, xp: 0 }, // Basic mobs don't use magic
    });
  }

  /**
   * Setup animations from GLB data (inline animations)
   */
  private async setupAnimations(
    animations: THREE.AnimationClip[],
  ): Promise<void> {
    if (!this.mesh || animations.length === 0) {
      console.warn(
        `[MobEntity] Cannot setup animations - no mesh or no animations`,
      );
      return;
    }

    // Find the SkinnedMesh to apply animation to
    let skinnedMesh: THREE.SkinnedMesh | null = null;
    this.mesh.traverse((child) => {
      if (!skinnedMesh && (child as THREE.SkinnedMesh).isSkinnedMesh) {
        skinnedMesh = child as THREE.SkinnedMesh;
      }
    });

    if (!skinnedMesh) {
      console.warn(`[MobEntity] No SkinnedMesh found in model for animations`);
      return;
    }

    // Create AnimationMixer on SkinnedMesh (required for DetachedBindMode)
    const mixer = new THREE.AnimationMixer(skinnedMesh);

    // Store all animation clips for state-based switching
    const animationClips: {
      idle?: THREE.AnimationClip;
      walk?: THREE.AnimationClip;
    } = {};

    // Categorize animations by name
    for (const clip of animations) {
      const nameLower = clip.name.toLowerCase();
      if (nameLower.includes("idle") || nameLower.includes("standing")) {
        animationClips.idle = clip;
      } else if (nameLower.includes("walk") || nameLower.includes("move")) {
        animationClips.walk = clip;
      }
    }

    // Default to first animation if no categorized animations found
    if (!animationClips.idle && !animationClips.walk) {
      animationClips.idle = animations[0];
    }

    // Play idle animation by default (or walk if idle doesn't exist)
    const initialClip =
      animationClips.idle || animationClips.walk || animations[0];
    const action = mixer.clipAction(initialClip);
    action.enabled = true;
    action.setEffectiveWeight(1.0);
    action.setLoop(THREE.LoopRepeat, Infinity); // Loop animation indefinitely
    action.play();

    // Store mixer and clips on entity
    (this as { mixer?: THREE.AnimationMixer }).mixer = mixer;
    (this as { animationClips?: typeof animationClips }).animationClips =
      animationClips;
    (this as { currentAction?: THREE.AnimationAction }).currentAction = action;
  }

  /**
   * Load VRM model and create avatar instance
   */
  private async loadVRMModel(): Promise<void> {
    // LOGGING: No more silent failures - log all early returns
    if (!this.world.loader) {
      console.warn(
        `[MobEntity] ${this.id}: No world.loader available for VRM loading`,
      );
      return;
    }
    if (!this.config.model) {
      console.warn(`[MobEntity] ${this.id}: No model path configured`);
      return;
    }
    if (!this.world.stage?.scene) {
      console.warn(`[MobEntity] ${this.id}: No world.stage.scene available`);
      return;
    }

    // Create VRM hooks with scene reference (CRITICAL for visibility!)
    const vrmHooks = {
      scene: this.world.stage.scene,
      octree: this.world.stage?.octree,
      camera: this.world.camera,
      loader: this.world.loader,
    };

    // Load the VRM avatar using the same loader as players
    const src = (await this.world.loader.load(
      "avatar",
      this.config.model,
    )) as LoadedAvatar;

    // Convert to nodes
    const nodeMap = src.toNodes(vrmHooks);
    const avatarNode = nodeMap.get("avatar") || nodeMap.get("root");

    if (!avatarNode) {
      console.warn(
        `[MobEntity] ${this.id}: No avatar/root node found in VRM for ${this.config.model}`,
      );
      return;
    }

    // Get the factory from the avatar node
    const avatarNodeWithFactory = avatarNode as {
      factory?: {
        create: (matrix: THREE.Matrix4, hooks?: unknown) => VRMAvatarInstance;
      };
    };

    if (!avatarNodeWithFactory?.factory) {
      console.warn(
        `[MobEntity] ${this.id}: No VRM factory found on avatar node for ${this.config.model}`,
      );
      return;
    }

    // Update our node's transform
    this.node.updateMatrix();
    this.node.updateMatrixWorld(true);

    // Create the VRM instance using the factory
    this._avatarInstance = avatarNodeWithFactory.factory.create(
      this.node.matrixWorld,
      vrmHooks,
    );

    if (!this._avatarInstance) {
      const modelKey = this.config.model || "unknown-model";
      if (!MobEntity.loggedNullVrmModels.has(modelKey)) {
        MobEntity.loggedNullVrmModels.add(modelKey);
        console.warn(
          `[MobEntity] VRM factory.create() returned null for ${modelKey}; mob avatar visuals disabled for this model`,
        );
      }
      return;
    }

    // Check for pending emote that arrived before VRM loaded
    if (this._pendingServerEmote) {
      // Apply the pending emote using the same logic as modify()
      this.applyServerEmote(this._pendingServerEmote);
      this._pendingServerEmote = null;
    } else {
      // Set initial emote to idle
      this._currentEmote = Emotes.IDLE;
      this._avatarInstance.setEmote(this._currentEmote);
    }

    // NOTE: Don't register VRM instance as hot - the MobEntity itself is registered
    // The entity's clientUpdate() will call avatarInstance.update()

    // Get the scene from the VRM instance
    const instanceWithRaw = this._avatarInstance as {
      raw?: { scene?: THREE.Object3D };
    };
    if (instanceWithRaw?.raw?.scene) {
      this.mesh = instanceWithRaw.raw.scene;
      this.mesh.name = `Mob_VRM_${this.config.mobType}_${this.id}`;

      // PERFORMANCE: Set VRM mesh to layer 1 (main camera only, not minimap)
      // Minimap only renders terrain and uses 2D dots for entities
      this.mesh.layers.set(1);
      this.mesh.traverse((child) => {
        child.layers.set(1);
        // PERFORMANCE: Disable raycasting on VRM meshes - use _raycastProxy instead
        // SkinnedMesh raycast is extremely slow (~700-1800ms) because THREE.js
        // must transform every vertex by bone weights. The capsule proxy is instant.
        child.raycast = () => {};
      });

      // Apply manifest scale on top of VRM's height normalization
      // VRM is auto-normalized to 1.6m, so scale 2.0 = 3.2m tall
      const configScale = this.config.scale;
      this.mesh.scale.set(
        this.mesh.scale.x * configScale.x,
        this.mesh.scale.y * configScale.y,
        this.mesh.scale.z * configScale.z,
      );

      // Set up userData for interaction detection
      const userData: MeshUserData = {
        type: "mob",
        entityId: this.id,
        name: this.config.name,
        interactable: true,
        mobData: {
          id: this.id,
          name: this.config.name,
          type: this.config.mobType,
          level: this.config.level,
          health: this.config.currentHealth,
          maxHealth: this.config.maxHealth,
        },
      };
      this.mesh.userData = { ...this.mesh.userData, ...userData };

      // Animated impostor support for VRM mobs (walk cycle)
      // DISABLED: Animated impostor system not ready for agents/player characters
      // this.cleanupAnimatedHLOD();
      // void this.initAnimatedHLODFromEmote(
      //   `mob_${this.config.mobType}`,
      //   Emotes.WALK,
      //   this._avatarInstance?.raw,
      //   MOB_IMPOSTOR_DISTANCES,
      // );

      // VRM instances manage their own positioning via move() - do NOT parent to node
      // The factory already added the scene to world.stage.scene
      // We'll use avatarInstance.move() to position it each frame
    } else {
      console.error(
        `[MobEntity] ❌ No scene in VRM instance for ${this.config.mobType}`,
      );
    }
  }

  /**
   * Load VRM model asynchronously (background loading).
   * PERFORMANCE: Keeps raycast proxy for fast click detection after VRM loads.
   * This is the non-blocking wrapper for loadVRMModel() used by createMesh().
   */
  private async loadVRMModelAsync(): Promise<void> {
    try {
      await this.loadVRMModel();
      // PERFORMANCE: Keep raycast proxy - don't remove it
      // VRM meshes have raycast disabled in loadVRMModel()
    } catch (err) {
      // Log and re-throw so caller's catch block fires
      console.error(`[MobEntity] VRM load error for ${this.id}:`, err);
      throw err;
    }
  }

  /**
   * Load external animation files (walking.glb, running.glb, etc.)
   * These are custom animations made specifically for the mob models
   */
  private async loadIdleAnimation(): Promise<void> {
    if (!this.mesh || !this.world.loader) {
      return;
    }

    const modelPath = this.config.model;
    if (!modelPath) return;

    const modelDir = modelPath.substring(0, modelPath.lastIndexOf("/"));

    // EXPECT: Model has SkinnedMesh
    let skinnedMesh: THREE.SkinnedMesh | null = null;
    this.mesh.traverse((child) => {
      if (!skinnedMesh && (child as THREE.SkinnedMesh).isSkinnedMesh) {
        skinnedMesh = child as THREE.SkinnedMesh;
      }
    });

    if (!skinnedMesh) {
      throw new Error(
        `[MobEntity] No SkinnedMesh in model: ${this.config.mobType} (${modelPath})`,
      );
    }

    // Create AnimationMixer on SkinnedMesh (required for DetachedBindMode)
    const mixer = new THREE.AnimationMixer(skinnedMesh);
    const animationClips: {
      idle?: THREE.AnimationClip;
      walk?: THREE.AnimationClip;
      run?: THREE.AnimationClip;
    } = {};

    // Load animation files (load as raw GLB, not emote, to avoid bone remapping)
    const animFiles = [
      { name: "walk", path: `${modelDir}/animations/walking.glb` },
      { name: "run", path: `${modelDir}/animations/running.glb` },
    ];

    for (const { name, path } of animFiles) {
      try {
        // Load as model (not emote) to get raw animations without VRM retargeting
        const result = await modelCache.loadModel(path, this.world);
        if (result.animations && result.animations.length > 0) {
          const clip = result.animations[0];
          animationClips[name as "walk" | "run"] = clip;
          if (name === "walk") animationClips.idle = clip; // Use walk as idle
        }
      } catch (_err) {
        // Animation file not found - skip
      }
    }

    // EXPECT: At least one clip loaded
    const initialClip = animationClips.idle || animationClips.walk;
    if (!initialClip) {
      throw new Error(
        `[MobEntity] NO CLIPS: ${this.config.mobType}\n` +
          `  Dir: ${modelDir}/animations/\n` +
          `  Result: idle=${!!animationClips.idle}, walk=${!!animationClips.walk}, run=${!!animationClips.run}`,
      );
    }

    const action = mixer.clipAction(initialClip);
    action.enabled = true;
    action.setEffectiveWeight(1.0);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();

    // Store mixer and clips
    (this as { mixer?: THREE.AnimationMixer }).mixer = mixer;
    (this as { animationClips?: typeof animationClips }).animationClips =
      animationClips;
    (this as { currentAction?: THREE.AnimationAction }).currentAction = action;

    // EXPECT: Action running after play()
    if (!action.isRunning()) {
      throw new Error(`[MobEntity] ACTION NOT RUNNING: ${this.config.mobType}`);
    }
  }

  /**
   * Create an invisible raycast proxy for fast click detection.
   *
   * PERFORMANCE: VRM SkinnedMesh raycast is extremely slow (~700-1800ms) because
   * THREE.js must transform every vertex by bone weights. This simple capsule
   * is instant and stays for the entity's lifetime.
   *
   * IMMEDIATE INTERACTION: Also ensures the mob is interactive BEFORE VRM loads.
   * classic fantasy MMORPG-style: entity is functional immediately, visuals are secondary.
   */
  private createRaycastProxy(): void {
    // Skip on server - no visuals needed
    if (this.world.isServer) return;

    // Create invisible capsule geometry matching mob's expected size
    // Use manifest scale to size placeholder appropriately
    const configScale = this.config.scale;
    const baseRadius = RAYCAST_PROXY.BASE_RADIUS * configScale.x;
    const baseHeight = RAYCAST_PROXY.TALL_HEIGHT * configScale.y;

    const geometry = new THREE.CapsuleGeometry(
      baseRadius,
      baseHeight,
      RAYCAST_PROXY.CAP_SEGMENTS,
      RAYCAST_PROXY.HEIGHT_SEGMENTS,
    );
    // WebGPU-compatible invisible material for click detection
    const material = new MeshBasicNodeMaterial();
    material.visible = false; // Invisible - only for click detection
    material.transparent = true;
    material.opacity = 0;

    const hitbox = new THREE.Mesh(geometry, material);
    hitbox.name = `Mob_Hitbox_${this.config.mobType}_${this.id}`;

    // CRITICAL: Set up userData for click detection (same as VRM/GLB mesh)
    const userData: MeshUserData = {
      type: "mob",
      entityId: this.id,
      name: this.config.name,
      interactable: true,
      mobData: {
        id: this.id,
        name: this.config.name,
        type: this.config.mobType,
        level: this.config.level,
        health: this.config.currentHealth,
        maxHealth: this.config.maxHealth,
      },
    };
    hitbox.userData = { ...userData };

    // Store reference for cleanup in destroy()
    this._raycastProxy = hitbox;

    // Add to node so it's in the scene and raycastable
    this.node.add(hitbox);

    // CRITICAL: Set as this.mesh so existing systems work immediately
    // When VRM loads, this.mesh will be replaced with the VRM scene
    this.mesh = hitbox;
  }

  /**
   * Destroy the raycast proxy during entity cleanup.
   * PERFORMANCE: The proxy is kept for the entity's lifetime to provide fast
   * click detection (VRM/GLB raycast is disabled). Only called in destroy().
   */
  private destroyRaycastProxy(): void {
    if (this._raycastProxy) {
      this.node.remove(this._raycastProxy);
      this._raycastProxy.geometry.dispose();
      (this._raycastProxy.material as THREE.Material).dispose();
      this._raycastProxy = null;
    }
  }

  protected async createMesh(): Promise<void> {
    if (this.world.isServer) {
      return;
    }

    // Create placeholder hitbox for immediate click detection before VRM loads
    this.createRaycastProxy();

    // Load 3D model in background (non-blocking)
    if (this.config.model && this.world.loader) {
      try {
        // Check if this is a VRM file
        if (this.config.model.endsWith(".vrm")) {
          // Fire-and-forget VRM loading - placeholder is already functional
          // If VRM loads successfully, it will replace the placeholder
          // If VRM fails, the placeholder remains functional (invisible but clickable)
          this.loadVRMModelAsync().catch((err) => {
            console.warn(
              `[MobEntity] VRM loading failed for ${this.config.mobType}, using placeholder:`,
              err instanceof Error ? err.message : err,
            );
            // Placeholder is already in place - mob remains functional
          });
          return; // Mesh is set (placeholder), VRM loading continues in background
        }

        // Otherwise load as GLB (existing code path)
        const { scene, animations } = await modelCache.loadModel(
          this.config.model,
          this.world,
        );

        // GLB loaded successfully - keep raycast proxy for performance
        this.mesh = scene;
        this.mesh.name = `Mob_${this.config.mobType}_${this.id}`;

        // GLB models: Don't manually scale - it breaks skeleton/animations
        // The model should be exported at the correct scale
        // Config scale from manifest can still be applied
        const configScale = this.config.scale;
        this.mesh.scale.set(configScale.x, configScale.y, configScale.z);
        this.mesh.updateMatrix();
        this.mesh.updateMatrixWorld(true);

        // NOW bind the skeleton at the scaled size and set layer for minimap exclusion
        this.mesh.layers.set(1); // Main camera only, not minimap
        this.mesh.traverse((child) => {
          // PERFORMANCE: Set all children to layer 1 (minimap only sees layer 0)
          child.layers.set(1);
          // PERFORMANCE: Disable raycasting on GLB meshes - use _raycastProxy instead
          child.raycast = () => {};

          if (child instanceof THREE.SkinnedMesh && child.skeleton) {
            // Ensure mesh matrix is updated
            child.updateMatrix();
            child.updateMatrixWorld(true);

            // Bind skeleton with DetachedBindMode (like VRM)
            child.bindMode = THREE.DetachedBindMode;
            child.bindMatrix.copy(child.matrixWorld);
            child.bindMatrixInverse.copy(child.bindMatrix).invert();
          }
        });

        // Set up userData for interaction detection
        const userData: MeshUserData = {
          type: "mob",
          entityId: this.id,
          name: this.config.name,
          interactable: true,
          mobData: {
            id: this.id,
            name: this.config.name,
            type: this.config.mobType,
            level: this.config.level,
            health: this.config.currentHealth,
            maxHealth: this.config.maxHealth,
          },
        };
        this.mesh.userData = { ...userData };

        // Add as child of node (standard approach with correct scale)
        // Position is relative to node, so keep it at origin
        this.mesh.position.set(0, 0, 0);
        this.mesh.quaternion.identity();
        this.node.add(this.mesh);

        // Always try to load external animations (most mobs use separate files)
        await this.loadIdleAnimation();

        // Also try inline animations if they exist
        if (animations.length > 0) {
          const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
          if (!mixer) {
            await this.setupAnimations(animations);
          }
        }

        const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
        const clips = (
          this as {
            animationClips?: {
              idle?: THREE.AnimationClip;
              walk?: THREE.AnimationClip;
            };
          }
        ).animationClips;
        const walkClip = clips?.walk ?? clips?.idle;

        if (this.mesh && mixer && walkClip) {
          // DISABLED: Animated impostor system not ready for agents/player characters
          // this.cleanupAnimatedHLOD();
          // const bakeSource = this.cloneForAnimatedImpostor(this.mesh);
          // const bakeMixer = this.createImpostorMixer(bakeSource);
          // void this.initAnimatedHLOD(
          //   `mob_${this.config.mobType}`,
          //   bakeMixer,
          //   walkClip,
          //   bakeSource,
          //   MOB_IMPOSTOR_DISTANCES,
          // );
        }

        return;
      } catch (error) {
        console.warn(
          `[MobEntity] Failed to load model for ${this.config.mobType}, using placeholder:`,
          error,
        );
        // Fall through to visible placeholder
      }
    }

    // No model available - create visible placeholder capsule
    // Remove invisible placeholder (if it's still the current mesh)
    if (this.mesh === this._raycastProxy) {
      this.destroyRaycastProxy();
    }

    const mobName = String(this.config.mobType).toLowerCase();
    const colorHash = mobName
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = (colorHash % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.6, 0.4);

    const configScale = this.config.scale;
    const geometry = new THREE.CapsuleGeometry(
      0.4 * configScale.x,
      1.6 * configScale.y,
      4,
      8,
    );
    // Use MeshStandardNodeMaterial for proper WebGPU lighting (responds to sun, moon, and environment maps)
    // Add subtle emissive so mobs pop at night (matches player rendering)
    const emissiveColor = color.clone();
    const material = new MeshStandardNodeMaterial();
    material.color = new THREE.Color(color.getHex());
    material.emissive = emissiveColor;
    material.emissiveIntensity = 0.3; // Subtle glow - matches PlayerEntity and VRM avatars
    material.roughness = 0.8;
    material.metalness = 0.0;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `Mob_${this.config.mobType}_${this.id}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // Set up userData with proper typing for mob
    const userData: MeshUserData = {
      type: "mob",
      entityId: this.id,
      name: this.config.name,
      interactable: true,
      mobData: {
        id: this.id,
        name: this.config.name,
        type: this.config.mobType,
        level: this.config.level,
        health: this.config.currentHealth,
        maxHealth: this.config.maxHealth,
      },
    };
    this.mesh.userData = { ...userData };

    // Add mesh to node so it appears in the scene
    this.node.add(this.mesh);

    // Health bar is created by Entity base class
  }

  protected async onInteract(data: EntityInteractionData): Promise<void> {
    // Handle attack interaction
    if (data.interactionType === "attack") {
      this.world.emit(EventType.COMBAT_ATTACK_REQUEST, {
        attackerId: data.playerId,
        targetId: this.id,
        attackerType: "player",
        targetType: "mob",
        attackType: AttackType.MELEE,
        position: this.getPosition(),
      });
    } else {
      // Default interaction - show mob info or examine
      this.world.emit(EventType.MOB_NPC_EXAMINE, {
        playerId: data.playerId,
        mobId: this.id,
        mobData: this.getMobData(),
      });
    }
  }

  /**
   * Create AI State Context for the state machine
   * This provides all the methods the AI states need to interact with the mob
   */
  private getAIContext(): AIStateContext {
    if (this._cachedAIContext) return this._cachedAIContext;
    this._cachedAIContext = this.createAIContext();
    return this._cachedAIContext;
  }

  private createAIContext(): AIStateContext {
    return {
      // Position & Movement
      getPosition: () => this.getPosition(),
      moveTowards: (target, _deltaTime) => {
        // Emit tile movement request instead of continuous movement
        // Server's MobTileMovementManager will handle the actual movement on ticks
        // The deltaTime parameter is ignored - movement is now tick-based

        // Convert positions to tiles for comparison
        const currentPos = this.getPosition();
        const currentTile = worldToTile(currentPos.x, currentPos.z);
        const targetTile = worldToTile(target.x, target.z);

        // CRITICAL: Skip if already at target tile (defense-in-depth)
        // This prevents spam when AI states call moveTowards to same tile
        // The AI states should also check this, but this is a safety net
        if (currentTile.x === targetTile.x && currentTile.z === targetTile.z) {
          return; // Already at destination tile - nothing to do
        }

        // TICK-BASED THROTTLING: Only emit one move request per tick per target
        // This aligns with the 600ms server tick system instead of arbitrary time cooldowns
        const currentTick = this.world.currentTick;
        const targetTileChanged =
          !this._lastRequestedTargetTile ||
          this._lastRequestedTargetTile.x !== targetTile.x ||
          this._lastRequestedTargetTile.z !== targetTile.z;

        if (!targetTileChanged && currentTick === this._lastMoveRequestTick) {
          return; // Same tick, same target - already requested this movement
        }

        // Update tracking
        this._lastRequestedTargetTile = { x: targetTile.x, z: targetTile.z };
        this._lastMoveRequestTick = currentTick;

        // Note: Debug logging removed for production. Enable if needed:
        // console.log(`[MobEntity] moveTowards: ${this.id} from tile (${currentTile.x}, ${currentTile.z}) to tile (${targetTile.x}, ${targetTile.z}), emitting MOB_NPC_MOVE_REQUEST`);

        this.world.emit(EventType.MOB_NPC_MOVE_REQUEST, {
          mobId: this.id,
          targetPos: target,
          // If chasing a player, include targetEntityId for dynamic repathing
          targetEntityId: this.config.targetPlayerId || undefined,
          tilesPerTick: Math.max(
            1,
            Math.round((this.config.moveSpeed * TICK_DURATION_MS) / 1000),
          ),
        });
      },
      teleportTo: (position) => {
        this.setPosition(position.x, position.y, position.z);
        this.config.aiState = MobAIState.IDLE;
        this.config.currentHealth = this.config.maxHealth;
        this.setHealth(this.config.maxHealth);
        this.setProperty("health", {
          current: this.config.maxHealth,
          max: this.config.maxHealth,
        });
        this.combatManager.exitCombat();
        this.markNetworkDirty();
      },

      // Targeting
      findNearbyPlayer: () => this.findNearbyPlayer(),
      getPlayer: (playerId) => this.getPlayer(playerId),
      getCurrentTarget: () => this.config.targetPlayerId,
      setTarget: (playerId) => {
        this.config.targetPlayerId = playerId;
        if (playerId) {
          this.aggroManager.setTarget(playerId);
        } else {
          this.aggroManager.clearTarget();
        }
      },

      // Combat (TICK-BASED, rules-accurate)
      canAttack: (currentTick) => this.combatManager.canAttack(currentTick),
      performAttack: (targetId, currentTick) => {
        this.combatManager.performAttack(targetId, currentTick);
      },
      onEnterCombatRange: (currentTick) => {
        this.combatManager.onEnterCombatRange(currentTick);
      },
      isInCombat: () => this.combatManager.isInCombat(),
      exitCombat: () => this.combatManager.exitCombat(),

      // Spawn & Leashing (use CURRENT spawn location, not area center)
      // CRITICAL: Return mob's current spawn point (changes on respawn)
      // NOT the spawn area center (which is fixed)
      getSpawnPoint: () => this._currentSpawnPoint,
      getDistanceFromSpawn: () => this.getSpawnDistanceTiles(), // classic MMORPG Chebyshev tiles
      getWanderRadius: () => this.respawnManager.getSpawnAreaRadius(),
      getLeashRange: () =>
        this.config.leashRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE,
      getCombatRange: () => this.config.combatRange,

      // Wander
      getWanderTarget: () =>
        this._wanderTarget
          ? { ...this._wanderTarget, y: this.getPosition().y }
          : null,
      setWanderTarget: (target) => {
        this._wanderTarget = target ? { x: target.x, z: target.z } : null;
      },
      generateWanderTarget: () => this.generateWanderTarget(),

      // Movement type (from manifest)
      getMovementType: () => this.config.movementType,

      // Timing
      getCurrentTick: () => this.world.currentTick, // Server tick number for combat timing
      getTime: () => Date.now(), // Date.now() for non-combat timing (idle duration, etc.)

      // State management
      markNetworkDirty: () => this.markNetworkDirty(),
      emitEvent: (eventType, data) => {
        this.world.emit(eventType as EventType, data);
      },

      // Entity Occupancy (rules-accurate NPC collision)
      getEntityId: () => this.id as EntityID,
      getEntityOccupancy: () => this.world.entityOccupancy,
      isWalkable: (tile) => {
        // Check CollisionMatrix for static objects (trees, rocks, stations)
        if (
          this.world.collision.hasFlags(
            tile.x,
            tile.z,
            CollisionMask.BLOCKS_WALK,
          )
        ) {
          return false;
        }

        // Check terrain walkability using TerrainSystem if available
        const terrain = this.world.getSystem("terrain");
        if (isTerrainSystem(terrain)) {
          const worldPos = tileToWorld(tile);
          const result = terrain.isPositionWalkable(worldPos.x, worldPos.z);
          return result.walkable;
        }
        // Fallback: assume walkable if no terrain system
        return true;
      },

      // Same-tile step-out (rules-accurate)
      // When NPC is on same tile as target, it cannot attack.
      // Tries all 4 cardinal directions in shuffled order, picking the first
      // valid tile (walkable terrain + no entity blocking).
      // Returns false if ALL directions are blocked (mob is stuck).
      tryStepOutCardinal: (): boolean => {
        const currentPos = this.getPosition();
        const currentTile = worldToTile(currentPos.x, currentPos.z);

        // Use game RNG for deterministic shuffled direction order
        const rng = getGameRng();

        // Find best step-out tile (checks walkability + entity occupancy)
        // Uses shuffled order for classic MMORPG-style randomness
        const stepOutTile = getBestStepOutTile(
          currentTile,
          this.world.entityOccupancy,
          this.id as EntityID,
          (tile) => {
            // Check CollisionMatrix for static objects (trees, rocks, stations)
            if (
              this.world.collision.hasFlags(
                tile.x,
                tile.z,
                CollisionMask.BLOCKS_WALK,
              )
            ) {
              return false;
            }

            // Check terrain walkability using type guard
            const terrain = this.world.getSystem?.("terrain");
            if (isTerrainSystem(terrain)) {
              const worldPos = tileToWorld(tile);
              const result = terrain.isPositionWalkable(worldPos.x, worldPos.z);
              return result.walkable;
            }
            // Fallback: assume walkable if no terrain system
            return true;
          },
          rng,
        );

        // If no valid tile found, all directions are blocked
        if (!stepOutTile) {
          // All cardinal tiles blocked - wait for next tick
          // In classic MMORPG, mob would be stuck until a tile opens up
          return false;
        }

        // Convert to world position
        const targetWorld = tileToWorld(stepOutTile);
        const targetPos = {
          x: targetWorld.x,
          y: currentPos.y,
          z: targetWorld.z,
        };

        // Emit movement request
        this.world.emit(EventType.MOB_NPC_MOVE_REQUEST, {
          mobId: this.id,
          targetPos: targetPos,
          targetEntityId: undefined, // Not chasing - just stepping out
          tilesPerTick: 1, // Single tile step
        });

        return true; // Valid tile found and movement requested
      },
    };
  }

  /**
   * Generate a random wander target within wander radius (rules-accurate)
   *
   * classic MMORPG generates wander targets relative to SPAWN, not current position.
   * This ensures NPCs naturally drift back toward spawn over time,
   * even after being leashed far from their spawn point.
   *
   * Uses CURRENT spawn point (changes on respawn), not fixed config.spawnPoint
   */
  private generateWanderTarget(): Position3D {
    const spawn = this._currentSpawnPoint;
    const radius = this.config.wanderRadius;

    // rules-accurate: Random tile within [-radius, +radius] of spawn
    // This creates a square wander area centered on spawn
    const range = 2 * radius + 1;
    const offsetX = Math.floor(Math.random() * range) - radius;
    const offsetZ = Math.floor(Math.random() * range) - radius;

    return {
      x: spawn.x + offsetX,
      y: this.getPosition().y,
      z: spawn.z + offsetZ,
    };
  }

  /**
   * Handle respawn callback from RespawnManager (SERVER-SIDE)
   * Handles game logic: health reset, state changes, position teleport
   * Visual restoration happens on client side in handleClientRespawn()
   *
   * @param spawnPoint - Random spawn point generated by RespawnManager
   */
  private handleRespawn(spawnPoint: Position3D): void {
    // Reset health and state
    this.config.currentHealth = this.config.maxHealth;
    this.setHealth(this.config.maxHealth);
    this.setProperty("health", {
      current: this.config.maxHealth,
      max: this.config.maxHealth,
    });

    // Reset AI state - set to IDLE first, then force AI state machine to IDLE
    this.config.aiState = MobAIState.IDLE;
    this.config.targetPlayerId = null;
    this.config.deathTime = null;

    // Clear aggro target
    this.aggroManager.clearTarget();

    // CRITICAL: Reset DeathStateManager BEFORE network sync
    // Without this, getNetworkData() thinks mob is still dead and strips position from network packet!
    this.deathManager.reset();
    // Reset death terrain snap flag for next death (Issue #244)
    this._deathPositionTerrainSnapped = false;

    // CRITICAL: Force AI state machine to IDLE state after respawn
    this.aiStateMachine.forceState(MobAIState.IDLE, this.getAIContext());

    // Clear combat state
    this.combatManager.exitCombat();

    // Clear any combat state in CombatSystem
    const combatSystem =
      this.world.getSystem<
        import("../../types/systems/system-interfaces").CombatSystem
      >("combat");
    if (combatSystem) {
      combatSystem.forceEndCombat(this.id);
    }

    // CRITICAL: Update current spawn point to NEW random location
    // This ensures AI (patrol, leashing, return) uses the new spawn location
    this._currentSpawnPoint = { ...spawnPoint };

    // Regenerate patrol points around NEW spawn location
    this.patrolPoints = [];
    this.generatePatrolPoints();

    // Teleport to NEW random spawn point (generated by RespawnManager)
    this.setPosition(spawnPoint.x, spawnPoint.y, spawnPoint.z);

    // CRITICAL: Force update node position (setPosition might only update this.position)
    this.node.position.set(spawnPoint.x, spawnPoint.y, spawnPoint.z);
    this.position.set(spawnPoint.x, spawnPoint.y, spawnPoint.z);

    // Register tile occupancy at new spawn location
    this.registerOccupancy();

    // Update userData
    if (this.mesh?.userData) {
      const userData = this.mesh.userData as MeshUserData;
      if (userData.mobData) {
        userData.mobData.health = this.config.currentHealth;
      }
    }

    // Emit respawn event
    this.world.emit(EventType.MOB_NPC_RESPAWNED, {
      mobId: this.id,
      position: this.getPosition(),
    });

    // Set flag to log next network sync (one-time only)
    this._justRespawned = true;

    this.markNetworkDirty();
  }

  // NOTE: Client-side respawn restoration is now handled inline in modify()
  // AFTER super.modify() updates the position from server
  // This ensures the VRM is moved to the correct spawn location, not the death location

  /**
   * Perform attack action (called by CombatStateManager)
   */
  private performAttackAction(targetId: string): void {
    this.world.emit(EventType.COMBAT_MOB_NPC_ATTACK, {
      mobId: this.id,
      targetId: targetId,
      attackerType: "mob",
      targetType: "player",
      attackType: this.config.attackType ?? "melee",
      spellId: this.config.spellId,
      arrowId: this.config.arrowId,
    });
  }

  /**
   * Tick-driven AI update entry point (called by GameTickProcessor).
   * Guarded to avoid duplicate AI updates within the same server tick.
   *
   * Also handles death state management and target validation that previously
   * ran per-frame in serverUpdate(). Moved here because mobs are no longer in
   * the server hot set (reducing GC pressure from 98+ mob × 10Hz updates).
   */
  public runAITick(deltaTime: number): void {
    const currentTick = this.world.currentTick;
    if (currentTick === this._lastAITick) {
      return;
    }
    this._lastAITick = currentTick;

    // Handle death state (position locking, respawn timer)
    if (this.deathManager.isCurrentlyDead()) {
      const currentTime = Date.now();

      // Lock position to death location
      const lockedPos = this.deathManager.getLockedPosition();
      if (lockedPos) {
        if (
          this.position.x !== lockedPos.x ||
          this.position.y !== lockedPos.y ||
          this.position.z !== lockedPos.z
        ) {
          this.position.copy(lockedPos);
          this.node.position.copy(lockedPos);
        }
      }

      // Update death animation timing
      this.deathManager.update(deltaTime, currentTime);

      // Update respawn timer (tick-based)
      if (this.respawnManager.isRespawnTimerActive()) {
        this.respawnManager.update(currentTick);
      }

      return; // Don't run AI when dead
    }

    // Validate target is still alive (classic fantasy MMORPG-style: instant disengage on target death)
    if (this.config.targetPlayerId) {
      const targetPlayer = this.world.getPlayer(this.config.targetPlayerId);
      if (!targetPlayer || targetPlayer.health.current <= 0) {
        this.clearTargetAndExitCombat();
      }
    }

    // Run AI state machine
    this.aiStateMachine.update(this.getAIContext(), deltaTime);
    this.config.aiState = this.aiStateMachine.getCurrentState();
  }

  /**
   * SERVER-SIDE UPDATE
   * No-op on server — mobs are not in the hot set to reduce GC pressure.
   * Death state management and target validation moved to runAITick().
   */
  protected serverUpdate(_deltaTime: number): void {
    // All server-side mob logic runs in runAITick() (tick-driven, not frame-driven)
  }

  /**
   * Map AI state to emote URL for VRM animations
   */
  private getEmoteForAIState(aiState: MobAIState): string {
    switch (aiState) {
      case MobAIState.WANDER:
      case MobAIState.CHASE:
        return Emotes.WALK;
      case MobAIState.ATTACK:
        // Return IDLE for attack state - CombatSystem handles one-shot attack animations
        // This prevents AI from continuously looping the combat animation
        return Emotes.IDLE;
      case MobAIState.RETURN:
        return Emotes.WALK; // Walk back to spawn
      case MobAIState.DEAD:
        return Emotes.DEATH; // Death animation
      case MobAIState.IDLE:
      default:
        return Emotes.IDLE;
    }
  }

  /**
   * Check if an emote URL is a priority emote (combat/death) that should override protection.
   * Priority emotes can interrupt the manual override protection period.
   */
  private isPriorityEmote(emoteUrl: string | null): boolean {
    if (!emoteUrl) return false;
    return (
      emoteUrl.includes("combat") ||
      emoteUrl.includes("punching") ||
      emoteUrl.includes("death")
    );
  }

  /**
   * Check if an emote URL is a combat emote (for attack animation timing).
   * Combat emotes use attackSpeedTicks for their protection duration.
   */
  private isCombatEmote(emoteUrl: string | null): boolean {
    if (!emoteUrl) return false;
    return emoteUrl.includes("combat") || emoteUrl.includes("punching");
  }

  /**
   * Apply a server emote to this mob (used by modify() and pending emote handling)
   * Requires _avatarInstance to be loaded.
   */
  private applyServerEmote(serverEmote: string): void {
    if (!this._avatarInstance) {
      console.warn(
        `[MobEntity] applyServerEmote called without avatar for ${this.config.mobType}`,
      );
      return;
    }

    // Map symbolic emote names to asset URLs (same as PlayerRemote)
    // Uses pre-allocated _emoteMap to avoid allocation in hot path
    const emoteUrl = serverEmote.startsWith("asset://")
      ? serverEmote
      : this._emoteMap[serverEmote] || Emotes.IDLE;

    // If manual override is active and this is NOT a priority emote, ignore it
    // This prevents idle/walk emotes from overwriting combat animations
    if (
      !this.isPriorityEmote(emoteUrl) &&
      Date.now() < this._manualEmoteOverrideUntil
    ) {
      return;
    }

    if (this._currentEmote !== emoteUrl) {
      this._currentEmote = emoteUrl;
      this._avatarInstance.setEmote(emoteUrl);

      // Set override durations for one-shot animations
      if (this.isCombatEmote(emoteUrl)) {
        // Match server-side timing from CombatAnimationManager.setCombatEmote():
        // Hold combat pose until 1 tick before next attack (minimum 2 ticks)
        // Formula: Math.max(2, attackSpeedTicks - 1) ticks * TICK_DURATION_MS
        const protectionTicks = Math.max(
          2,
          (this.config.attackSpeedTicks || 4) - 1,
        );
        const protectionMs = protectionTicks * TICK_DURATION_MS;
        this._manualEmoteOverrideUntil = Date.now() + protectionMs;
      } else if (emoteUrl.includes("death")) {
        this._manualEmoteOverrideUntil =
          Date.now() + this.DEATH_ANIMATION_TICKS * TICK_DURATION_MS;
      } else if (emoteUrl.includes("idle")) {
        this._manualEmoteOverrideUntil = 0; // Clear override when reset to idle
      }
    }
  }

  /**
   * Switch animation based on AI state (GLB mobs only)
   * Note: VRM mobs handle emotes directly in clientUpdate(), not here.
   * This method is only called for GLB-based mobs from the GLB path in clientUpdate().
   */
  private updateAnimation(): void {
    // GLB path: Use mixer-based animation
    const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
    const clips = (
      this as {
        animationClips?: {
          idle?: THREE.AnimationClip;
          walk?: THREE.AnimationClip;
        };
      }
    ).animationClips;
    const currentAction = (this as { currentAction?: THREE.AnimationAction })
      .currentAction;

    if (!mixer || !clips) {
      return;
    }

    // Determine which animation should be playing based on AI state
    let targetClip: THREE.AnimationClip | undefined;

    if (
      this.config.aiState === MobAIState.WANDER ||
      this.config.aiState === MobAIState.CHASE ||
      this.config.aiState === MobAIState.RETURN
    ) {
      // Moving states - play walk animation
      targetClip = clips.walk || clips.idle;
    } else {
      // Idle, attack, or dead - play idle animation
      targetClip = clips.idle || clips.walk;
    }

    // Switch animation if needed
    if (targetClip && currentAction?.getClip() !== targetClip) {
      currentAction?.fadeOut(0.2);
      const newAction = mixer.clipAction(targetClip);
      newAction.reset();
      newAction.setLoop(THREE.LoopRepeat, Infinity); // Loop animation indefinitely
      newAction.fadeIn(0.2).play();
      (this as { currentAction?: THREE.AnimationAction }).currentAction =
        newAction;
    }
  }

  /**
   * CLIENT-SIDE UPDATE
   * Handles visual updates: animations, interpolation, and rendering
   * Position and AI state are synced from server via modify()
   */
  private clientUpdateCalls = 0;
  private initialBonePosition: THREE.Vector3 | null = null;

  // Track when death animation started on client (in Date.now() milliseconds)
  private clientDeathStartTime: number | null = null;

  /**
   * Override health bar rendering to use HealthBars system (atlas + instanced mesh)
   * Shows 0 during death animation regardless of actual health value
   */
  protected override updateHealthBar(): void {
    if (!this._healthBarHandle) {
      return;
    }

    // CRITICAL: Show 0 health during death animation regardless of actual health value
    // This prevents health bar from showing server respawn health during client-side death animation
    const displayHealth = this.deathManager.isCurrentlyDead() ? 0 : this.health;

    this._healthBarHandle.setHealth(displayHealth, this.maxHealth);
  }

  protected clientUpdate(deltaTime: number): void {
    super.clientUpdate(deltaTime);
    this.clientUpdateCalls++;

    // ANIMATION LOD: Calculate distance to camera once and throttle animation updates
    // This reduces CPU/GPU load for distant mobs significantly (50-80% savings)
    const cameraPos = getCameraPosition(this.world);
    const animLODResult = cameraPos
      ? this._animationLOD.updateFromPosition(
          this.node.position.x,
          this.node.position.z,
          cameraPos.x,
          cameraPos.z,
          deltaTime,
        )
      : {
          shouldUpdate: true,
          effectiveDelta: deltaTime,
          lodLevel: 0,
          distanceSq: 0,
        };
    const isAnimatedImpostor = this.animatedHLODState?.isImpostor === true;

    // Update health bar position (HealthBars system uses atlas + instanced mesh)
    if (this._healthBarHandle) {
      // Position health bar above mob's head using pre-allocated matrix
      this._healthBarMatrix.copyPosition(this.node.matrixWorld);
      // Offset Y to position above the mob (2.0 units up)
      this._healthBarMatrix.elements[13] += 2.0;
      this._healthBarHandle.move(this._healthBarMatrix);
    }

    // Hide health bar after combat timeout (classic fantasy MMORPG pattern: 4.8 seconds)
    if (this._healthBarHandle && this._healthBarVisibleUntil > 0) {
      if (Date.now() >= this._healthBarVisibleUntil) {
        this._healthBarHandle.hide();
        this._healthBarVisibleUntil = 0;
      }
    }

    // Handle dead state on client (hide mesh and stop VRM animation after death animation)
    if (this.config.aiState === MobAIState.DEAD) {
      // Start tracking client-side death time when we first see DEAD state
      if (!this.clientDeathStartTime) {
        this.clientDeathStartTime = Date.now();
      }

      const currentTime = Date.now();
      const timeSinceDeath = currentTime - this.clientDeathStartTime;

      // Hide mesh and VRM after death animation finishes
      if (timeSinceDeath >= this.DEATH_ANIMATION_TICKS * TICK_DURATION_MS) {
        // Hide the mesh
        if (this.mesh && this.mesh.visible) {
          this.mesh.visible = false;
        }
        // Hide the node (contains VRM scene)
        if (this.node && this.node.visible) {
          this.node.visible = false;
        }
        // CRITICAL: Stop the VRM animation mixer by clearing the emote
        // This prevents the death animation from looping
        if (this._avatarInstance && this._currentEmote === Emotes.DEATH) {
          this._currentEmote = ""; // Clear emote to stop mixer
          this._avatarInstance.setEmote(""); // Stop animation playback
          this._manualEmoteOverrideUntil = 0; // Clear override
        }
        // Skip all further updates while dead and invisible
        return;
      }
    } else {
      // Not dead anymore - this is handled in modify() when state changes
      // No need for duplicate logic here
    }

    // VRM path: Use avatar instance update (handles everything)
    if (this._avatarInstance) {
      // CRITICAL: Don't switch emotes while in DEAD state
      // The death animation was already set via server emote, just let it play
      // After 4.5s the node will be hidden above
      if (this.config.aiState !== MobAIState.DEAD) {
        // Skip AI-based emote updates if manual override is active (for one-shot attack animations)
        const now = Date.now();
        if (now >= this._manualEmoteOverrideUntil) {
          // Switch animation based on AI state (walk when patrolling/chasing, idle otherwise)
          const targetEmote = this.getEmoteForAIState(this.config.aiState);
          if (this._currentEmote !== targetEmote) {
            this._currentEmote = targetEmote;
            this._avatarInstance.setEmote(targetEmote);
          }
        }
      }

      // COMBAT ROTATION: Rotate to face target when in ATTACK state (classic fantasy MMORPG-style)
      // BUT: Only apply combat rotation when NOT moving via tile movement
      // TileInterpolator handles rotation when entity is walking/running
      const isTileMoving = this.data.tileMovementActive === true;
      if (
        !isTileMoving &&
        this.config.aiState === MobAIState.ATTACK &&
        this.config.targetPlayerId
      ) {
        const targetPlayer = this.world.getPlayer?.(this.config.targetPlayerId);
        if (targetPlayer && targetPlayer.position) {
          const dx = targetPlayer.position.x - this.position.x;
          const dz = targetPlayer.position.z - this.position.z;
          const distanceSquared = dx * dx + dz * dz;

          // RULES-ACCURATE: Skip rotation when on same tile (distance too small)
          // Prevents 180° flips from floating-point instability when dx ≈ 0, dz ≈ 0
          // Threshold: 0.25 = 0.5^2 (half a tile)
          const MIN_ROTATION_DISTANCE_SQ = 0.25;

          if (distanceSquared >= MIN_ROTATION_DISTANCE_SQ) {
            let angle = Math.atan2(dx, dz);

            // VRM 1.0+ models have 180° base rotation, so we need to compensate
            // Otherwise entities face AWAY from each other instead of towards
            angle += Math.PI;

            // Apply rotation to node quaternion using pre-allocated temps
            this._combatQuat.setFromAxisAngle(this._combatAxis, angle);
            this.node.quaternion.copy(this._combatQuat);
          }
          // else: preserve current facing direction (no rotation update)
        }
      }

      // If mob is dead, lock position to prevent death animation from sliding
      const lockedPos = this.deathManager.getLockedPosition();
      if (lockedPos) {
        this.node.position.copy(lockedPos);
        this.position.copy(lockedPos);
      } else {
        // CRITICAL: Snap to terrain EVERY frame (server doesn't have terrain system)
        // Keep trying until terrain tile is generated, then snap every frame
        // This also counteracts VRM animation root motion that would push character into ground
        //
        // Issue #416 fix: Only snap to terrain AFTER receiving server position
        // This ensures all clients use same XZ coordinates for terrain lookup,
        // preventing Y desync between clients with different terrain load times
        if (this._hasReceivedServerPosition) {
          const terrain = this.world.getSystem("terrain");
          if (terrain && "getHeightAt" in terrain) {
            try {
              // CRITICAL: Must call method on terrain object to preserve 'this' context
              const terrainHeight = (
                terrain as { getHeightAt: (x: number, z: number) => number }
              ).getHeightAt(this.node.position.x, this.node.position.z);
              if (Number.isFinite(terrainHeight)) {
                this._hasValidTerrainHeight = true;
                this.node.position.y = terrainHeight;
                this.position.y = terrainHeight;
              }
            } catch (_err) {
              // Terrain tile not generated yet - keep current Y and retry next frame
              if (
                this.clientUpdateCalls === 10 &&
                !this._hasValidTerrainHeight
              ) {
                console.warn(
                  `[MobEntity] Waiting for terrain tile to generate at (${this.node.position.x.toFixed(1)}, ${this.node.position.z.toFixed(1)})`,
                );
              }
            }
          }
        }
      }

      // Update node transform matrices
      // NOTE: ClientNetwork updates XZ from server, we calculate Y from client terrain
      this.node.updateMatrix();
      this.node.updateMatrixWorld(true);

      // SPECIAL HANDLING FOR DEATH: Lock position, let animation play
      const deathLockedPos = this.deathManager.getLockedPosition();
      if (deathLockedPos) {
        // Issue #244 fix: Terrain-snap death position ONCE to prevent floating death animation
        // Server doesn't have terrain, so death position Y may be stale/incorrect
        if (!this._deathPositionTerrainSnapped) {
          const terrain = this.world.getSystem("terrain");
          if (terrain && "getHeightAt" in terrain) {
            try {
              const terrainHeight = (
                terrain as { getHeightAt: (x: number, z: number) => number }
              ).getHeightAt(deathLockedPos.x, deathLockedPos.z);
              if (Number.isFinite(terrainHeight)) {
                // Snap death position to ground level
                deathLockedPos.y = terrainHeight;
                this._deathPositionTerrainSnapped = true;
              }
            } catch (_err) {
              // Terrain not ready yet, will retry next frame
            }
          }
        }

        // Lock the node position to death position (prevents teleporting)
        this.node.position.copy(deathLockedPos);
        this.position.copy(deathLockedPos);
        this.node.updateMatrix();
        this.node.updateMatrixWorld(true);

        // DON'T call move() - it causes sliding due to internal interpolation
        // VRM scene was positioned once in modify() when entering death state
        // Just update the animation, VRM scene stays locked
        // NOTE: Death animations always run at full speed (no LOD throttling)
        if (!isAnimatedImpostor) {
          this._avatarInstance.update(deltaTime);
        }
      } else {
        // NORMAL PATH: Use move() to sync VRM - it preserves the VRM's internal scale
        // move() applies vrm.scene.scale to maintain height normalization
        this._avatarInstance.move(this.node.matrixWorld);

        // ANIMATION LOD: Only update VRM animations when LOD allows
        // This significantly reduces CPU/GPU load for distant mobs
        if (!isAnimatedImpostor && animLODResult.shouldUpdate) {
          // Update VRM animations (mixer + humanoid + skeleton)
          // Use effectiveDelta which may be accumulated from skipped frames
          this._avatarInstance.update(animLODResult.effectiveDelta);
        }
      }

      // Post-animation position locking for non-death states
      if (this.config.aiState !== MobAIState.DEAD) {
        // CRITICAL: Re-snap to terrain AFTER animation update to counteract root motion
        // Animation root motion can push character down/back, so we fix position after it applies
        const terrain = this.world.getSystem("terrain");
        if (terrain && "getHeightAt" in terrain) {
          try {
            const terrainHeight = (
              terrain as { getHeightAt: (x: number, z: number) => number }
            ).getHeightAt(this.node.position.x, this.node.position.z);
            if (Number.isFinite(terrainHeight)) {
              this.node.position.y = terrainHeight;
              this.position.y = terrainHeight;

              // CRITICAL: Update matrices and call move() again to apply corrected Y position to VRM
              this.node.updateMatrix();
              this.node.updateMatrixWorld(true);
              this._avatarInstance.move(this.node.matrixWorld);
            }
          } catch (_err) {
            // Terrain tile not generated yet
          }
        }
      }

      // VRM handles all animation internally
      return;
    }

    // If mesh is the placeholder hitbox, skip animation (VRM still loading)
    if (this.mesh === this._raycastProxy) {
      // Just update position from terrain while waiting for VRM to load
      const terrain = this.world.getSystem("terrain");
      if (terrain && "getHeightAt" in terrain) {
        try {
          const terrainHeight = (
            terrain as { getHeightAt: (x: number, z: number) => number }
          ).getHeightAt(this.node.position.x, this.node.position.z);
          if (Number.isFinite(terrainHeight)) {
            this.node.position.y = terrainHeight;
            this.position.y = terrainHeight;
          }
        } catch {
          // Terrain tile not generated yet
        }
      }
      return; // No animation updates while in placeholder mode
    }

    // GLB path: Existing animation code for non-VRM mobs
    // Update animations based on AI state
    this.updateAnimation();

    // Update animation mixer
    const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;

    // Note: Mixer may not exist for mobs with no animations - that's OK
    // The visible placeholder fallback doesn't have a mixer

    // ANIMATION LOD: Only update mixer when LOD allows
    // This significantly reduces CPU/GPU load for distant mobs
    if (mixer && !isAnimatedImpostor && animLODResult.shouldUpdate) {
      mixer.update(animLODResult.effectiveDelta);

      // Update skeleton bones using pre-defined callback to avoid GC pressure
      if (this.mesh) {
        this.mesh.traverse(this._updateSkeletonCallback);
      }
    }
  }

  /**
   * Pre-defined callback for skeleton update to avoid creating new functions every frame
   * Called from lateUpdate via mesh.traverse()
   */
  private _updateSkeletonCallback = (child: THREE.Object3D): void => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      const skeleton = child.skeleton;

      // Update bone matrices using for-loop instead of forEach to avoid callback allocation
      const bones = skeleton.bones;
      for (let i = 0; i < bones.length; i++) {
        bones[i].updateMatrixWorld();
      }
      skeleton.update();

      // VALIDATION: Check if bones are actually transforming (only first 60 frames)
      if (this.clientUpdateCalls === 1) {
        // Find hips bone using for-loop instead of .find()
        let hipsBone: THREE.Bone | undefined;
        for (let i = 0; i < bones.length; i++) {
          if (bones[i].name.toLowerCase().includes("hips")) {
            hipsBone = bones[i];
            break;
          }
        }
        if (hipsBone) {
          // Use copy instead of clone to reuse existing object if available
          if (!this.initialBonePosition) {
            this.initialBonePosition = hipsBone.position.clone();
          } else {
            this.initialBonePosition.copy(hipsBone.position);
          }
        }
      } else if (this.clientUpdateCalls === 60) {
        // Find hips bone using for-loop instead of .find()
        let hipsBone: THREE.Bone | undefined;
        for (let i = 0; i < bones.length; i++) {
          if (bones[i].name.toLowerCase().includes("hips")) {
            hipsBone = bones[i];
            break;
          }
        }
        if (hipsBone && this.initialBonePosition) {
          const distance = hipsBone.position.distanceTo(
            this.initialBonePosition,
          );
          if (distance < 0.001) {
            const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
            throw new Error(
              `[MobEntity] BONES NOT MOVING: ${this.config.mobType}\n` +
                `  Start: [${this.initialBonePosition.toArray().map((v) => v.toFixed(4))}]\n` +
                `  Now: [${hipsBone.position.toArray().map((v) => v.toFixed(4))}]\n` +
                `  Distance: ${distance.toFixed(6)} (need > 0.001)\n` +
                `  Mixer time: ${mixer?.time.toFixed(2) ?? "N/A"}s\n` +
                `  Animation runs but doesn't affect bones!`,
            );
          }
        }
      }
    }
  };

  /**
   * Calculate 2D horizontal distance (XZ plane only, ignoring Y)
   * @deprecated Use getSpawnDistanceTiles() for leash/spawn checks - classic MMORPG uses Chebyshev distance
   */
  private getDistance2D(point: Position3D): number {
    const pos = this.getPosition();
    const dx = pos.x - point.x;
    const dz = pos.z - point.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Calculate tile-based Chebyshev distance from spawn point (rules-accurate)
   *
   * classic MMORPG uses Chebyshev distance (max of dx, dz) for tile-based checks.
   * This is critical for diagonal positions:
   * - Euclidean: (6,6) from (0,0) = 8.49 tiles (WRONG)
   * - Chebyshev: (6,6) from (0,0) = 6 tiles (CORRECT)
   */
  private getSpawnDistanceTiles(): number {
    const pos = this.getPosition();
    const spawn = this._currentSpawnPoint;
    const currentTile = worldToTile(pos.x, pos.z);
    const spawnTile = worldToTile(spawn.x, spawn.z);
    return tileChebyshevDistance(currentTile, spawnTile);
  }

  /**
   * Get the mob's current spawn point (public accessor for movement capping)
   * Used by MobTileMovementManager to enforce rules-accurate leash range
   */
  getSpawnPoint(): Position3D {
    return this._currentSpawnPoint;
  }

  /**
   * Get the mob's leash range (max tiles from spawn during chase)
   * rules-accurate default: 7 tiles max range from spawn
   */
  getLeashRange(): number {
    return this.config.leashRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE;
  }

  takeDamage(damage: number, attackerId?: string): boolean {
    // Already dead - ignore damage
    if (this.deathManager.isCurrentlyDead()) {
      return false;
    }

    // Enter combat (prevents safety teleport while fighting)
    this.combatManager.enterCombat(attackerId);

    // Apply damage
    this.config.currentHealth = Math.max(0, this.config.currentHealth - damage);

    // Sync all health fields (single source of truth)
    this.setHealth(this.config.currentHealth);
    this.setProperty("health", {
      current: this.config.currentHealth,
      max: this.config.maxHealth,
    });

    // Update health bar visual (setHealth already does this, but ensure it's called)
    this.updateHealthBar();

    // Update userData for mesh
    if (this.mesh?.userData) {
      const userData = this.mesh.userData as MeshUserData;
      if (userData.mobData) {
        userData.mobData.health = this.config.currentHealth;
      }
    }

    // COMBAT_DAMAGE_DEALT is emitted by CombatSystem - no need to emit here
    // to avoid duplicate damage splats

    // Check if mob died
    if (this.config.currentHealth <= 0) {
      this.die();
      return true; // Mob died
    } else {
      // Become aggressive towards attacker (use AggroManager for target management)
      // BUT only if mob retaliates - peaceful mobs (retaliates: false) don't fight back
      if (attackerId && !this.config.targetPlayerId && this.config.retaliates) {
        this.config.targetPlayerId = attackerId;
        this.aggroManager.setTargetIfNone(attackerId);
        this.aiStateMachine.forceState(MobAIState.CHASE, this.getAIContext());
      }
    }

    this.markNetworkDirty();
    return false; // Mob survived
  }

  die(): void {
    // One mob life may emit at most one authenticated loot operation. The
    // death manager flips synchronously below, so duplicate damage/direct calls
    // cannot mint a second operation while HMAC generation is still pending.
    if (this.deathManager.isCurrentlyDead()) return;

    // Unregister tile occupancy (dead NPCs don't block tiles)
    this.unregisterOccupancy();

    // Use Date.now() for consistent millisecond timing (world.getTime() has inconsistent units)
    const currentTime = Date.now();
    const deathPosition = this.getPosition();

    // Delegate death logic to DeathStateManager (position locking, death animation timing)
    this.deathManager.die(deathPosition, currentTime);

    // Start respawn timer with RespawnManager (TICK-BASED - generates NEW random spawn point - NOT death location!)
    // Uses server tick for rules-accurate timing
    this.respawnManager.startRespawnTimer(
      this.world.currentTick,
      deathPosition,
    );

    // Update config state for network sync
    this.config.aiState = MobAIState.DEAD;
    this.config.deathTime = currentTime;
    this.config.targetPlayerId = null;
    this.config.currentHealth = 0;

    // Clear aggro target
    this.aggroManager.clearTarget();

    // Update base health property for isDead() check
    this.setHealth(0);

    // CRITICAL FIX FOR ISSUE #269: Don't end combat immediately when mob dies
    // Let combat timeout naturally after 4.8 seconds (8 ticks) to keep health bars visible
    // This matches classic fantasy MMORPG behavior where combat state persists briefly after death
    // CombatSystem.handleEntityDied() already removes the dead mob's combat state
    // The attacker's combat will timeout naturally via the 4.8 second timer
    //
    // NOTE: Issue #275 fix (not resetting target's emote) is still preserved because
    // we're not calling endCombat() at all - the emote will finish naturally

    // Play death animation via server emote broadcast
    this.setServerEmote(Emotes.DEATH);

    // Mark for network update to sync death state to clients
    this.markNetworkDirty();

    // Emit death event with last attacker
    const lastAttackerId = this.combatManager.getLastAttackerId();
    if (lastAttackerId) {
      // Freeze the existing kill-XP inputs into the same authenticated death
      // identity as loot and quest progress. Skills are reconciled only after
      // that complete database transaction commits; this entity must never
      // grant progression from the transient pre-commit event.
      const playerSystem = this.world.getSystem("player") as {
        getPlayerAttackStyle?: (playerId: string) => { id: string } | null;
      } | null;

      // Check equipped weapon type to determine if using ranged/magic
      const equipmentSystem = this.world.getSystem("equipment") as {
        getPlayerEquipment?: (playerId: string) => {
          weapon?: {
            item: { attackType?: string; weaponType?: string };
          };
        } | null;
      } | null;
      const equipment = equipmentSystem?.getPlayerEquipment?.(lastAttackerId);
      const weapon = equipment?.weapon?.item;
      let attackStyle = "aggressive"; // Default

      // Check if player has a spell selected (needed for magic detection)
      const playerEntity = this.world.getPlayer?.(lastAttackerId);
      const selectedSpell = (playerEntity?.data as { selectedSpell?: string })
        ?.selectedSpell;

      if (weapon) {
        // Check attackType first (preferred), then weaponType (legacy)
        // Values may be uppercase (from JSON) or lowercase (from enum)
        const attackType = weapon.attackType?.toLowerCase();
        const weaponType = weapon.weaponType?.toLowerCase();

        if (
          attackType === "ranged" ||
          weaponType === "bow" ||
          weaponType === "crossbow"
        ) {
          // Ranged weapon - use "ranged" style for Ranged XP
          attackStyle = "ranged";
        } else if (
          (attackType === "magic" ||
            weaponType === "staff" ||
            weaponType === "wand") &&
          selectedSpell
        ) {
          // Magic weapon WITH active spell - use "magic" style for Magic XP
          // rules-accurate: staffs used for melee (no spell) grant melee XP
          attackStyle = "magic";
        } else {
          // Melee attack (or staff/wand without a spell) - use player's selected attack style
          // but only if it's a valid melee style; non-melee styles (longrange, autocast, rapid)
          // would grant wrong XP type
          const attackStyleData =
            playerSystem?.getPlayerAttackStyle?.(lastAttackerId);
          const playerStyle = attackStyleData?.id;
          attackStyle =
            playerStyle && MELEE_STYLES.has(playerStyle)
              ? playerStyle
              : "aggressive";
        }
      } else {
        // No weapon (unarmed) - check if player has a spell selected
        // rules-accurate: You can cast spells without a staff
        if (selectedSpell) {
          // Player has a spell selected - use "magic" for Magic XP
          attackStyle = "magic";
        } else {
          // No spell, no weapon - use player's melee attack style
          const attackStyleData =
            playerSystem?.getPlayerAttackStyle?.(lastAttackerId);
          const playerStyle = attackStyleData?.id;
          attackStyle =
            playerStyle && MELEE_STYLES.has(playerStyle)
              ? playerStyle
              : "aggressive";
        }
      }

      const damageDealt = this.config.maxHealth;
      if (
        !Number.isSafeInteger(damageDealt) ||
        damageDealt <= 0 ||
        damageDealt > MAX_MOB_COMBAT_DAMAGE
      ) {
        console.error(
          `[MobEntity] Refused death event with invalid XP authority for ${this.id}`,
        );
        return;
      }
      const timestamp = Date.now();
      const lootOperationId = generateGroundItemMobLootOperationId();
      const deathEvent = {
        mobId: this.id,
        mobType: this.config.mobType,
        level: this.config.level,
        killedBy: lastAttackerId,
        position: deathPosition,
        timestamp,
        lootOperationId,
        attackStyle,
        damageDealt,
      };
      void generateKillToken(
        deathEvent.mobId,
        deathEvent.killedBy,
        deathEvent.timestamp,
        deathEvent.lootOperationId,
        deathEvent.attackStyle,
        deathEvent.damageDealt,
      )
        .then((killToken) => {
          this.world.emit(EventType.NPC_DIED, { ...deathEvent, killToken });
        })
        .catch((error) => {
          console.error(
            `[MobEntity] Refused unsigned death event for ${this.id}: ${String(error)}`,
          );
        });

      // NOTE: Loot is handled by LootSystem via NPC_DIED event (emitted above)
      // Do NOT call dropLoot() here - it would cause duplicate drops
    } else {
      console.warn(`[MobEntity] ${this.id} died but no lastAttackerId found`);
    }
  }

  private generatePatrolPoints(): void {
    // Use CURRENT spawn point (changes on respawn), not fixed config.spawnPoint
    const spawnPos = this._currentSpawnPoint;
    const patrolRadius = 5; // 5 meter patrol radius

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const x = spawnPos.x + Math.cos(angle) * patrolRadius;
      const z = spawnPos.z + Math.sin(angle) * patrolRadius;
      this.patrolPoints.push({ x, z });
    }
  }

  private moveTowardsTarget(targetPos: Position3D, deltaTime: number): void {
    const currentPos = this.getPosition();
    const direction = {
      x: targetPos.x - currentPos.x,
      y: 0,
      z: targetPos.z - currentPos.z,
    };

    const length = Math.sqrt(
      direction.x * direction.x + direction.z * direction.z,
    );
    if (length > 0) {
      direction.x /= length;
      direction.z /= length;

      const moveDistance = this.config.moveSpeed * deltaTime;
      const newPos = {
        x: currentPos.x + direction.x * moveDistance,
        y: currentPos.y,
        z: currentPos.z + direction.z * moveDistance,
      };

      // Snap to terrain height (only if terrain system is ready)
      const terrain = this.world.getSystem("terrain");
      if (terrain && "getHeightAt" in terrain) {
        try {
          // CRITICAL: Must call method on terrain object to preserve 'this' context
          const terrainHeight = (
            terrain as { getHeightAt: (x: number, z: number) => number }
          ).getHeightAt(newPos.x, newPos.z);
          if (Number.isFinite(terrainHeight)) {
            newPos.y = terrainHeight;
          } else if (!this._terrainWarningLogged) {
            console.warn(
              `[MobEntity] Server terrain height not finite at (${newPos.x.toFixed(1)}, ${newPos.z.toFixed(1)})`,
            );
            this._terrainWarningLogged = true;
          }
        } catch (err) {
          if (!this._terrainWarningLogged) {
            console.warn(`[MobEntity] Server terrain getHeightAt failed:`, err);
            this._terrainWarningLogged = true;
          }
        }
      } else if (!this._terrainWarningLogged) {
        console.warn(`[MobEntity] Server has no terrain system`);
        this._terrainWarningLogged = true;
      }

      // Calculate rotation to face movement direction using pre-allocated temps
      // VRM 1.0+ models are rotated 180° by the factory (see createVRMFactory.ts:264)
      // so we need to add PI to compensate and face the correct direction
      const angle = Math.atan2(direction.x, direction.z) + Math.PI;
      this._targetQuat.setFromAxisAngle(this._targetAxis, angle);

      // Smoothly rotate towards target direction
      this.node.quaternion.slerp(this._targetQuat, 0.1);

      // Stuck detection: Only check when actively moving (classic fantasy MMORPG-style: give up if stuck)
      // This prevents false positives during IDLE and ATTACK states
      const isMovingState =
        this.config.aiState === MobAIState.WANDER ||
        this.config.aiState === MobAIState.CHASE ||
        this.config.aiState === MobAIState.RETURN;

      if (isMovingState) {
        if (this._lastPositionValid) {
          const moved = this.position.distanceTo(this._lastPosition);
          if (moved < 0.01) {
            // Barely moved - increment stuck timer
            this._stuckTimer += deltaTime;
            if (this._stuckTimer > this.STUCK_TIMEOUT) {
              // Stuck for too long - give up and return home (production safety)
              console.warn(
                `[MobEntity] ${this.config.mobType} stuck for ${(this.STUCK_TIMEOUT / 1000).toFixed(1)}s at (${currentPos.x.toFixed(1)}, ${currentPos.z.toFixed(1)}), returning to spawn`,
              );
              this.config.aiState = MobAIState.RETURN;
              this.config.targetPlayerId = null;
              this.aggroManager.clearTarget();
              this._wanderTarget = null;
              this._stuckTimer = 0;
              this._lastPositionValid = false;
              this.markNetworkDirty();
              return;
            }
          } else {
            // Moving normally - reset stuck timer
            this._stuckTimer = 0;
          }
        }
        this._lastPosition.copy(this.position);
        this._lastPositionValid = true;
      }

      // Update position (will be synced to clients via network)
      this.setPosition(newPos.x, newPos.y, newPos.z);
      this.markNetworkDirty();
    }
  }

  /**
   * Find nearby player within aggro range (classic fantasy MMORPG-style)
   * Delegates to AggroManager component
   *
   * IMPORTANT: Only scans for players if mob is aggressive.
   * Non-aggressive mobs won't attack on sight.
   * Retaliation when attacked is controlled by the separate `retaliates` flag.
   */
  private findNearbyPlayer(): { id: string; position: Position3D } | null {
    // Non-aggressive mobs don't scan for players
    if (!this.config.aggressive) {
      return null;
    }

    const currentPos = this.getPosition();

    // Use spatial player index for O(k) lookup instead of O(P) iteration
    // AggroSystem maintains a playersByRegion index using 21x21 tile regions
    // This queries a 3x3 grid of regions (63x63 tiles) which covers any aggro range
    const aggroSystem = this.world.getSystem("aggro") as
      AggroSystem | undefined;
    const players = aggroSystem
      ? aggroSystem.getPlayersInNearbyRegions(currentPos)
      : this.world.getPlayers(); // Fallback if AggroSystem not available

    // Rules-Accurate Aggression Range:
    // The aggression range origin is the static spawn point of the NPC.
    // Aggression range = max range (leash) + attack range (combat range)
    // Players must be within this distance of SPAWN to be attacked.
    const leashRange =
      this.config.leashRange ?? COMBAT_CONSTANTS.DEFAULTS.NPC.LEASH_RANGE;
    const attackRange = Math.max(1, this.config.combatRange);
    const aggressionRange = leashRange + attackRange;

    return this.aggroManager.findNearbyPlayer(
      currentPos,
      players,
      this._currentSpawnPoint, // Spawn point for rules-accurate aggression check
      aggressionRange, // Max attack distance from spawn
    );
  }

  /**
   * Get player by ID (delegates to AggroManager)
   */
  private getPlayer(
    playerId: string,
  ): { id: string; position: Position3D } | null {
    return this.aggroManager.getPlayer(playerId, (id) =>
      this.world.getPlayer(id),
    );
  }

  /**
   * Clear current target and exit combat (called when target dies or becomes invalid)
   * classic fantasy MMORPG-style: Mob immediately disengages and returns to spawn area
   */
  private clearTargetAndExitCombat(): void {
    // Clear target
    this.config.targetPlayerId = null;
    this.aggroManager.clearTarget();

    // Exit combat state
    this.combatManager.exitCombat();

    // Force AI state based on movement type
    const context = this.getAIContext();
    if (this.config.movementType === "stationary") {
      // Stationary mobs go directly to IDLE
      this.aiStateMachine.forceState(MobAIState.IDLE, context);
    } else {
      // Wandering mobs go to RETURN to walk back to spawn area
      this.aiStateMachine.forceState(MobAIState.RETURN, context);
    }
  }

  /**
   * Called by CombatSystem when this mob's current target dies
   * Resets combat state so mob can immediately attack new targets (e.g., respawned player)
   * @param targetId - ID of the target that died (for validation)
   */
  onTargetDied(targetId: string): void {
    // Only reset if this was actually our target
    if (this.config.targetPlayerId === targetId) {
      this.clearTargetAndExitCombat();
    }
  }

  // Map internal AI states to interface expected states (classic fantasy MMORPG-style)
  private mapAIStateToInterface(
    internalState: string,
  ): "idle" | "wander" | "chase" | "attack" | "return" | "dead" {
    // Direct mapping - internal states match interface states
    return (
      (internalState as
        "idle" | "wander" | "chase" | "attack" | "return" | "dead") || "idle"
    );
  }

  // Get mob data for systems
  getMobData(): MobEntityData {
    return {
      id: this.id,
      name: this.config.name,
      type: this.config.mobType,
      level: this.config.level,
      health: this.config.currentHealth,
      maxHealth: this.config.maxHealth,
      attack: this.config.attack,
      attackPower: this.config.attackPower,
      defense: this.config.defense,
      defenseBonus: this.config.defenseBonus ?? 0,
      attackSpeedTicks: this.config.attackSpeedTicks,
      xpReward: this.config.xpReward,
      aiState: this.mapAIStateToInterface(this.config.aiState),
      targetPlayerId: this.config.targetPlayerId || null,
      spawnPoint: this.config.spawnPoint,
      position: this.getPosition(),
    };
  }

  /**
   * Check if this mob can be attacked by players
   * Controlled by combat.attackable in the manifest
   */
  isAttackable(): boolean {
    return this.config.attackable;
  }

  /**
   * Get this mob's combat range in tiles
   * Controlled by combat.combatRange in the manifest (meters, 1 tile = 1 meter)
   * @returns Combat range in tiles (minimum 1)
   */
  getCombatRange(): number {
    return Math.max(1, Math.floor(this.config.combatRange));
  }

  // Override serialize to include model path for client
  override serialize(): EntityData {
    const baseData = super.serialize();
    return {
      ...baseData,
      model: this.config.model, // CRITICAL: Include model path for client VRM loading
      mobType: this.config.mobType,
      level: this.config.level,
      currentHealth: this.config.currentHealth,
      maxHealth: this.config.maxHealth,
      aiState: this.config.aiState,
      targetPlayerId: this.config.targetPlayerId,
      scale: [
        this.config.scale.x,
        this.config.scale.y,
        this.config.scale.z,
      ] as [number, number, number], // CRITICAL: Include scale for client model sizing
    };
  }

  // PERF: Pre-allocated buffer for death position to avoid array allocation
  private readonly _deathPositionBuffer: [number, number, number] = [0, 0, 0];
  // PERF: Pre-allocated buffer for position to avoid array allocation
  private readonly _mobPositionBuffer: [number, number, number] = [0, 0, 0];

  // Network data override
  // PERF: Mutates buffer in-place instead of creating new objects
  getNetworkData(): Record<string, unknown> {
    // Get base data (returns parent's pre-allocated buffer)
    const buf = super.getNetworkData();

    // Handle death state separately
    if (this.deathManager.isCurrentlyDead()) {
      // Remove ALL position data from buffer
      delete buf.x;
      delete buf.y;
      delete buf.z;
      delete buf.p;
      delete buf.position;

      // Add mob-specific fields directly to buffer (no spread/new object)
      buf.model = this.config.model;
      buf.mobType = this.config.mobType;
      buf.level = this.config.level;
      buf.currentHealth = this.config.currentHealth;
      buf.maxHealth = this.config.maxHealth;
      buf.aiState = this.config.aiState;
      buf.targetPlayerId = this.config.targetPlayerId;
      buf.deathTime = this.deathManager.getDeathTime();
      buf.scale = this.config.scale;

      // Send death emote once
      if (this._serverEmote) {
        buf.e = this._serverEmote;
        this._serverEmote = null;
      }

      // ALWAYS send death position when dead (handles packet loss, late-joining clients)
      const deathPos = this.deathManager.getDeathPosition();
      if (deathPos) {
        // Use pre-allocated buffer for death position
        this._deathPositionBuffer[0] = deathPos.x;
        this._deathPositionBuffer[1] = deathPos.y;
        this._deathPositionBuffer[2] = deathPos.z;
        buf.p = this._deathPositionBuffer;
        this.deathManager.markDeathStateSent();
      }

      return buf;
    }

    // Normal path for living mobs
    // Query CombatSystem for combat state (like players send 'c')
    const combatSystem = this.world.getSystem("combat") as {
      isInCombat?: (entityId: string) => boolean;
    } | null;
    const inCombat = combatSystem?.isInCombat?.(this.id) ?? false;

    // Add mob-specific fields directly to buffer (no spread/new object)
    buf.model = this.config.model;
    buf.mobType = this.config.mobType;
    buf.level = this.config.level;
    buf.currentHealth = this.config.currentHealth;
    buf.maxHealth = this.config.maxHealth;
    buf.aiState = this.config.aiState;
    buf.targetPlayerId = this.config.targetPlayerId;
    buf.c = inCombat;
    buf.scale = this.config.scale;

    // CRITICAL: Force position to be included if not present
    if (!buf.p || !Array.isArray(buf.p)) {
      const pos = this.getPosition();
      // Use pre-allocated buffer for position
      this._mobPositionBuffer[0] = pos.x;
      this._mobPositionBuffer[1] = pos.y;
      this._mobPositionBuffer[2] = pos.z;
      buf.p = this._mobPositionBuffer;
    }

    // Only broadcast server-forced emotes
    if (this._serverEmote) {
      buf.e = this._serverEmote;
      this._serverEmote = null;
    }

    // Clear respawn flag after first network sync
    if (this._justRespawned) {
      this._justRespawned = false;
    }

    return buf;
  }

  /**
   * Set a one-shot emote from server (e.g., combat animation)
   * This will be broadcast once, then cleared automatically
   */
  setServerEmote(emote: string): void {
    this._serverEmote = emote;
    this.markNetworkDirty();
  }

  /**
   * Override modify to handle network updates from server
   */
  override modify(data: Partial<EntityData>): void {
    // Handle AI state changes
    if ("aiState" in data) {
      const newState = data.aiState as MobAIState;

      // If entering DEAD state on client, lock position to CURRENT VISUAL position
      if (
        newState === MobAIState.DEAD &&
        !this.deathManager.isCurrentlyDead()
      ) {
        // CRITICAL: Clear the death timer so clientUpdate() can set a fresh timestamp
        // Without this, stale timestamps from previous deaths cause immediate reset
        this.clientDeathStartTime = null;

        // CRITICAL: Use current VISUAL position (this.position), NOT server position (data.p)
        // TileInterpolator may be mid-interpolation, showing the mob at a different location
        // than the server's authoritative position. The mob should die WHERE THE PLAYER SEES IT,
        // not teleport to the server position. This matches modern MMORPG's smooth movement philosophy.
        const visualDeathPos = new THREE.Vector3(
          this.position.x,
          this.position.y,
          this.position.z,
        );
        this.deathManager.applyDeathPositionFromServer(visualDeathPos);

        // Clear TileInterpolator control flag so it stops updating this entity
        this.data.tileInterpolatorControlled = false;

        // Position VRM scene at current visual position for death animation
        if (this._avatarInstance) {
          this.node.updateMatrix();
          this.node.updateMatrixWorld(true);
          this._avatarInstance.move(this.node.matrixWorld);
        }
      }

      // CRITICAL: ALWAYS check if death manager should be reset (not just on state change!)
      // Server might send multiple updates with same state (aiState=idle, idle, idle...)
      // We need to reset death manager on ANY update where server says NOT DEAD
      // BUT: Don't reset until death animation is complete (4.5 seconds)
      const deathManagerDead = this.deathManager.isCurrentlyDead();

      if (newState !== MobAIState.DEAD && deathManagerDead) {
        // CRITICAL: If clientDeathStartTime is null, death just happened but
        // clientUpdate() hasn't run yet to set the timestamp. DON'T reset in this case!
        if (this.clientDeathStartTime) {
          const timeSinceDeath = Date.now() - this.clientDeathStartTime;
          const deathAnimationDurationMs =
            this.DEATH_ANIMATION_TICKS * TICK_DURATION_MS;

          if (timeSinceDeath >= deathAnimationDurationMs) {
            // Death animation is complete, safe to reset
            this.clientDeathStartTime = null;
            this.deathManager.reset();
            // Reset death terrain snap flag for next death (Issue #244)
            this._deathPositionTerrainSnapped = false;

            // CRITICAL: Clear stale 'death' emote — without this,
            // onEntityModified thinks mob is still dead on subsequent packets
            // (it checks entity.data.e for 'death' in isDeadMob calculation)
            // (also cleared in ClientNetwork.onEntityModified respawn path as defense in depth)
            (this.data as Record<string, unknown>).e = undefined;
            (this.data as Record<string, unknown>).emote = undefined;

            // CRITICAL: Snap position immediately to server's new spawn point
            // This prevents interpolation from starting at death location
            if ("p" in data && Array.isArray(data.p) && data.p.length === 3) {
              const spawnPos = data.p as [number, number, number];
              this.position.set(spawnPos[0], spawnPos[1], spawnPos[2]);
              this.node.position.set(spawnPos[0], spawnPos[1], spawnPos[2]);
            }

            // Mark that we need to restore visibility AFTER position update
            this._pendingRespawnRestore = true;
          }
        }
      }

      this.config.aiState = newState;
    }

    // Handle combat state for health bar visibility (like players)
    // Show health bar when in combat (including 0 damage hits), hide after timeout
    if ("c" in data) {
      const inCombat = data.c as boolean;
      if (inCombat && this._healthBarHandle) {
        // In combat - show health bar and set/extend timeout
        this._healthBarHandle.show();
        this._healthBarVisibleUntil =
          Date.now() + ticksToMs(COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS);
      }
      // Note: Hiding is handled by clientUpdate() when timeout expires
    }

    // Update health from server
    if ("currentHealth" in data) {
      const newHealth = data.currentHealth as number;
      this._lastKnownHealth = newHealth;
      this.config.currentHealth = newHealth;
      this.setHealth(newHealth);
    }

    // Update max health from server
    if ("maxHealth" in data) {
      const newMaxHealth = data.maxHealth as number;
      this.config.maxHealth = newMaxHealth;
      this.maxHealth = newMaxHealth;
      // Update entity data for consistency
      (this.data as { maxHealth?: number }).maxHealth = newMaxHealth;
      // Refresh health bar to show updated max health
      this.updateHealthBar();
    }

    // Update target from server
    if ("targetPlayerId" in data) {
      this.config.targetPlayerId = data.targetPlayerId as string | null;
    }

    // Update death time from server
    if ("deathTime" in data) {
      this.config.deathTime = data.deathTime as number | null;
      this.deathManager.setDeathTime(data.deathTime as number | null);
    }

    // Handle emote from server (like PlayerRemote does)
    if ("e" in data && data.e !== undefined) {
      const serverEmote = data.e as string;

      // If avatar not loaded yet, store as pending - will be applied when VRM loads
      if (!this._avatarInstance) {
        this._pendingServerEmote = serverEmote;
      } else {
        // Avatar ready - apply emote immediately
        this.applyServerEmote(serverEmote);
      }
    }

    // Handle position for living mobs (non-death, non-respawn cases)
    if (!this.deathManager.shouldLockPosition()) {
      // Check if TileInterpolator is controlling position - if so, skip position updates
      // TileInterpolator handles position smoothly for tile-based movement
      // This prevents entityModified packets from overriding smooth interpolation
      const tileControlled = this.data.tileInterpolatorControlled === true;
      if (!tileControlled) {
        // Not dead and not tile-controlled - apply position updates from server
        if ("p" in data && Array.isArray(data.p) && data.p.length === 3) {
          const pos = data.p as [number, number, number];
          this.position.set(pos[0], pos[1], pos[2]);
          this.node.position.set(pos[0], pos[1], pos[2]);
          // Mark that we've received authoritative server position (Issue #416 fix)
          // This ensures all clients have consistent XZ before terrain snapping Y
          this._hasReceivedServerPosition = true;
        }
      }
    } else {
      // Dead - enforce locked position (defense in depth)
      const lockedPos = this.deathManager.getLockedPosition();
      if (lockedPos) {
        this.node.position.copy(lockedPos);
        this.position.copy(lockedPos);
      }
    }

    // Call parent modify for standard properties (non-transform data like entity data)
    // Strip position from data since we handled it above
    const dataWithoutPosition = { ...data };
    delete dataWithoutPosition.p;
    delete dataWithoutPosition.x;
    delete dataWithoutPosition.y;
    delete dataWithoutPosition.z;
    delete dataWithoutPosition.position;
    super.modify(dataWithoutPosition);

    // CRITICAL: Restore visibility AFTER position has been updated from server
    // This ensures VRM is moved to the correct spawn location, not death location
    if (this._pendingRespawnRestore) {
      this._pendingRespawnRestore = false;

      // CRITICAL: Update client's _currentSpawnPoint to match new position from server
      // This ensures client and server are in sync (defense in depth)
      this._currentSpawnPoint = {
        x: this.node.position.x,
        y: this.node.position.y,
        z: this.node.position.z,
      };

      // Restore node visibility
      if (this.node && !this.node.visible) {
        this.node.visible = true;
      }

      // Restore mesh visibility
      if (this.mesh && !this.mesh.visible) {
        this.mesh.visible = true;
      }

      // Update health bar now that mesh is visible again
      // This ensures the health bar shows the correct health after respawn
      this.setHealth(this.config.currentHealth);

      // Reset VRM animation and move to UPDATED position (from server)
      if (this._avatarInstance) {
        this._currentEmote = Emotes.IDLE;
        this._avatarInstance.setEmote(Emotes.IDLE);
        this._manualEmoteOverrideUntil = 0;

        // Position has been updated above in the position handling section
        // So this.node.position is the NEW spawn point from server, not death location
        this.node.updateMatrix();
        this.node.updateMatrixWorld(true);
        this._avatarInstance.move(this.node.matrixWorld);
      }
    }
  }

  /**
   * Override destroy to clean up animations, health bar, and placeholder
   */
  override destroy(): void {
    // Unregister entity from hot updates
    this.world.setHot(this, false);

    // Clean up PLAYER_SET_DEAD listener
    if (this._playerDeadHandler) {
      this.world.off(EventType.PLAYER_SET_DEAD, this._playerDeadHandler);
      this._playerDeadHandler = null;
    }

    // Clean up placeholder hitbox (if VRM never loaded)
    this.destroyRaycastProxy();

    // Clean up health bar handle (HealthBars system)
    if (this._healthBarHandle) {
      this._healthBarHandle.destroy();
      this._healthBarHandle = null;
    }

    // Clean up VRM instance
    if (this._avatarInstance) {
      this._avatarInstance.destroy();
      this._avatarInstance = null;
    }

    // Clean up animation mixer (for GLB models)
    const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
    if (mixer) {
      mixer.stopAllAction();
      (this as { mixer?: THREE.AnimationMixer }).mixer = undefined;
    }

    // Parent will handle mesh removal (mesh is child of node)
    super.destroy();
  }
}
