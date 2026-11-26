/**
 * World.ts - Core Game World Container
 *
 * The World class is the central container for all game systems, entities, and state.
 * It manages the game loop, system lifecycle, and provides a unified API for game features.
 *
 * Architecture:
 * - Uses Entity Component System (ECS) pattern
 * - Fixed-timestep physics loop (30 FPS) with interpolation
 * - Event-driven inter-system communication via EventBus
 * - Dependency-based system initialization
 *
 * Lifecycle:
 * 1. Constructor: Creates world, registers core systems
 * 2. init(): Initializes systems in dependency order
 * 3. start(): Starts all systems
 * 4. tick(): Main game loop (called every frame)
 * 5. destroy(): Cleanup when world is destroyed
 *
 * Used by: createClientWorld(), createServerWorld(), createViewerWorld()
 */

import EventEmitter from "eventemitter3";
import THREE from "../extras/three/three";
import type { Position3D } from "../types/core/base-types";
import type { HyperiaObject3D } from "../types/rendering/three-extensions";
import type { ClientLiveKit } from "../systems/client/ClientLiveKit";
import type { ClientActions } from "../systems/client/ClientActions";
import { EventType } from "../types/events";
import {
  FrameBudgetManager,
  type FrameTimingStats,
} from "../utils/FrameBudgetManager";
import {
  DurationHistogram,
  type DurationPercentiles,
} from "../utils/DurationHistogram";

// NOTE: Import directly to avoid circular dependency through barrel file
// The barrel imports combat which imports MobEntity which extends Entity (circular)
import {
  Anchors,
  Anchors as AnchorsSystem,
} from "../systems/shared/presentation/Anchors";
import { Chat, Chat as ChatSystem } from "../systems/shared/presentation/Chat";
import {
  Entities,
  Entities as EntitiesSystem,
} from "../systems/shared/entities/Entities";
import {
  EventBus,
  type EventSubscription,
} from "../systems/shared/infrastructure/EventBus";
import {
  Events,
  Events as EventsSystem,
} from "../systems/shared/infrastructure/Events";
import {
  EntityOccupancyMap,
  type IEntityOccupancy,
} from "../systems/shared/movement/EntityOccupancyMap";
import {
  CollisionMatrix,
  type ICollisionMatrix,
} from "../systems/shared/movement/CollisionMatrix";
import { LODs } from "../systems/shared/presentation/LODs";
import { Particles } from "../systems/shared/presentation/Particles";
import {
  Physics,
  Physics as PhysicsSystem,
} from "../systems/shared/interaction/Physics";
import {
  Settings,
  Settings as SettingsSystem,
} from "../systems/shared/infrastructure/Settings";
import {
  Stage,
  Stage as StageSystem,
} from "../systems/shared/presentation/Stage";
import {
  System,
  SystemConstructor,
} from "../systems/shared/infrastructure/System";
import { Environment } from "../systems/shared/world/Environment";
import { HotReloadable, Player, RaycastHit, WorldOptions } from "../types";
import type {
  ClientAudio,
  ClientInput,
  ClientGraphics,
  ClientLoader,
  ClientInterface,
  ClientMonitor,
  ServerDB,
} from "../types";
import type { ServerRuntime } from "../systems/server/ServerRuntime";

/**
 * NetworkSystem Interface
 *
 * Common interface for both ClientNetwork and ServerNetwork systems.
 * Allows World to reference network functionality without knowing which implementation is active.
 *
 * The actual network system (client or server) is registered by create*World() functions.
 * ServerNetwork implements NetworkWithSocket (enqueue, onDisconnect, sockets),
 * while ClientNetwork does not.
 */
interface NetworkSystem extends System {
  id?: string;
  isServer?: boolean;
  isClient?: boolean;
  send: (type: string, data: unknown) => void;
  upload?: (file: File) => Promise<unknown>;
  onConnection?: (socket: unknown, query: unknown) => void;
  disconnect?: () => Promise<void>;
  // NetworkWithSocket methods (server-side only, optional for client)
  enqueue?: (socket: unknown, method: string, data: unknown) => void;
  onDisconnect?: (socket: unknown, code?: number | string) => void;
  sockets?: Map<string, unknown>;
}

// Type guard to check if network system implements NetworkWithSocket (reserved for future use)
function _isNetworkWithSocket(
  network: NetworkSystem,
): network is NetworkSystem & {
  enqueue: (socket: unknown, method: string, data: unknown) => void;
  onDisconnect: (socket: unknown, code?: number | string) => void;
  sockets: Map<string, unknown>;
} {
  return (
    typeof network.enqueue === "function" &&
    typeof network.onDisconnect === "function" &&
    network.sockets instanceof Map
  );
}

function isInitTraceEnabled(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return new URLSearchParams(window.location.search).get("traceInit") === "1";
  } catch {
    return false;
  }
}

function getSystemDebugName(
  systemNameMap: Map<System, string>,
  system: System,
): string {
  return systemNameMap.get(system) || system.constructor.name || "Unknown";
}

let hasLoggedMissingAssetBase = false;

interface AsyncTickCallMetric {
  label: string;
  phase: "fixedUpdate" | "update" | "lateUpdate";
  observed: number;
  inFlight: number;
  peakInFlight: number;
  rejections: number;
  lastSeenAt: number;
}

export interface WorldTickTimingPercentiles {
  total: DurationPercentiles;
  fixedUpdate: DurationPercentiles;
  update: DurationPercentiles;
  lateUpdate: DurationPercentiles;
  commit: DurationPercentiles;
  unmeasured: DurationPercentiles;
}

export interface WorldSystemTimingPercentiles extends DurationPercentiles {
  name: string;
}

/**
 * World - Central Game World Container
 *
 * The core class that manages all game systems, entities, and state.
 * Provides a unified API for accessing game functionality and coordinates
 * the game loop across all systems.
 *
 * **Key Responsibilities**:
 * - System registration and lifecycle management
 * - Fixed-timestep game loop with physics simulation
 * - Event routing via EventBus for type-safe inter-system communication
 * - Asset URL resolution for both local and CDN assets
 * - Three.js scene graph root (rig and camera)
 *
 * The World is environment-agnostic and can run on client, server, or headless (testing).
 *
 * @public
 */
export class World extends EventEmitter {
  // ============================================================================
  // TIME MANAGEMENT
  // ============================================================================

  /**
   * Maximum allowed delta time for physics accumulator to prevent spiral of death.
   * Caps physics delta at 33ms to prevent physics instability.
   * This ONLY affects physics - animations and movement use real delta time.
   */
  maxPhysicsDeltaTime = 1 / 30;

  /**
   * Maximum allowed delta time for animations and movement.
   * Caps at 500ms (2 FPS minimum effective rate) to prevent huge jumps
   * after tab unfocus or extreme lag, while still allowing real-time playback.
   */
  maxAnimationDeltaTime = 0.5;

  /**
   * Fixed timestep for physics simulation.
   * Physics runs at exactly 30 FPS for deterministic, stable simulation.
   */
  fixedDeltaTime = 1 / 30;

  /**
   * @deprecated Use maxPhysicsDeltaTime instead. Kept for backward compatibility.
   */
  get maxDeltaTime(): number {
    return this.maxPhysicsDeltaTime;
  }
  set maxDeltaTime(value: number) {
    this.maxPhysicsDeltaTime = value;
  }

  /** Current frame number (incremented each tick) */
  frame = 0;

  /** Current game time in seconds */
  time = 0;

  /** Accumulated time for fixed-step physics updates */
  accumulator = 0;

  /**
   * Current server tick number (classic MMORPG-style 600ms ticks).
   * Set by TickSystem on the server, used by mobs/NPCs for tick-aligned AI.
   * On client, this is 0 (client uses frame-based updates).
   *
   * @server-only Set by ServerNetwork's TickSystem
   */
  currentTick = 0;

  // ============================================================================
  // CORE PROPERTIES
  // ============================================================================

  /** Unique identifier for this world instance */
  id: string;

  /** Array of all registered systems (initialized in dependency order) */
  systems: System[] = [];

  /** Map of system names to system instances for fast lookup */
  systemsByName = new Map<string, System>();

  /** Network update rate in seconds (8Hz = 8 updates per second) */
  networkRate = 1 / 8;

  /** Base URL for loading assets from CDN (e.g., 'https://cdn.example.com/assets/') */
  assetsUrl!: string;

  /** Cached resolved CDN fallback URL (avoids repeated console.warn on every asset resolve) */
  private _resolvedCdnFallback: string | undefined = undefined;

  /** Local directory path for assets (server-side file loading) */
  assetsDir!: string;

  /** Set of entities/objects that need update() called every frame */
  hot = new Set<HotReloadable>();

  /** Prevents duplicate initialization */
  private _initialized = false;

  /** Movement state flag (used by builder/movement systems) */
  moving?: boolean;

  /**
   * Flag indicating if we're currently rendering for a reflection camera.
   * When true, LOD systems should force impostor mode for performance.
   * Set by WaterSystem's reflector callbacks.
   */
  isRenderingReflection = false;

  // ============================================================================
  // FRAME BUDGET MANAGEMENT
  // ============================================================================

  /**
   * Frame budget manager for reducing main thread jank.
   * Tracks frame time and allows deferring heavy work when over budget.
   * Only active on client (browser) - server does not use frame budget.
   */
  frameBudget: FrameBudgetManager | null = null;

  // ============================================================================
  // THREE.JS SCENE GRAPH
  // ============================================================================

  /** Root object for camera and rendering (parent of camera) */
  rig: HyperiaObject3D;

  /** Main perspective camera for rendering the 3D scene */
  camera: THREE.PerspectiveCamera;

  // ============================================================================
  // CORE SYSTEMS (Always present in client and server)
  // ============================================================================

  /** Game configuration and metadata (title, description, player limits, etc.) */
  settings!: Settings & {
    public?: boolean;
    playerLimit?: number;
    avatar?: { url: string };
    title?: string;
    desc?: string;
    image?: { url: string };
    model?: { url: string } | string | null;
    serialize?: () => unknown;
    deserialize?: (data: unknown) => void;
    on?: (event: string, callback: () => void) => void;
  };

  /** Manages spatial anchors for positioned objects */
  anchors!: Anchors;

  /** Legacy event system (being replaced by EventBus) */
  events!: Events;

  /** Chat message system for player communication */
  chat!: Chat & {
    add?: (message: unknown, sync?: boolean) => void;
    clear?: (sync: boolean) => void;
    serialize?: () => unknown;
    messages?: Array<{
      id?: string;
      from: string;
      body: string;
      text?: string;
      timestamp?: number;
    }>;
  };

  /** Entity Component System - manages all game entities (players, mobs, items, etc.) */
  entities!: Entities & {
    add?: (data: unknown, local?: boolean) => unknown;
    serialize?: () => unknown;
    getPlayer: (playerId: string) => Player;
    getLocalPlayer: () => Player;
    getPlayers: () => Player[];
    player?: {
      id?: string;
      name?: string;
      runMode?: boolean;
      stamina?: number;
      toggleRunMode?: () => void;
      position?: { x: number; y: number; z: number };
      playerData?: {
        health?: { current: number; max: number };
        stats?: { prayer?: { level: number; points: number } };
      };
    };
  };

  /** PhysX-based physics simulation (collisions, raycasts, character controllers) */
  physics!: Physics;

  /** Three.js scene management and rendering pipeline */
  stage!: Stage & {
    scene?: {
      add?: (obj: unknown) => void;
      remove?: (obj: unknown) => void;
    };
    THREE?: typeof THREE;
  };

  /** Particle effects system (GPU-accelerated particles) */
  particles?: Particles;

  /** Level-of-Detail system for optimizing distant objects */
  lods?: LODs;

  // ============================================================================
  // CLIENT-ONLY SYSTEMS (Only present in browser environments)
  // ============================================================================

  /** UI system for managing DOM-based user interface */
  ui?: ClientInterface & {
    active?: boolean;
    appendChild?: (element: HTMLElement) => void;
    removeChild?: (element: HTMLElement) => void;
    getBoundingClientRect?: () => DOMRect;
    applyTheme?: (theme: unknown) => void;
    toggleVisible?: () => void;
    state?: unknown;
  };

  /** Asset loader for models, textures, audio, and other resources */
  loader?: ClientLoader;

  /** Network system - ClientNetwork on client, ServerNetwork on server */
  network!: NetworkSystem & {
    id?: string;
    send?: (event: string, data?: unknown) => void;
    dropItem?: (itemId: string, slot?: number, quantity?: number) => string;
    lastInventoryByPlayerId?: Record<
      string,
      {
        playerId: string;
        items: Array<{ slot: number; itemId: string; quantity: number }>;
        coins: number;
        maxSlots: number;
      }
    >;
    lastSkillsByPlayerId?: Record<
      string,
      Record<string, { level: number; xp: number }>
    >;
    lastEquipmentByPlayerId?: Record<string, unknown>;
    lastAttackStyleByPlayerId?: Record<
      string,
      {
        currentStyle: { id: string };
        availableStyles: unknown;
        canChange: boolean;
      }
    >;
    lastPrayerStateByPlayerId?: Record<
      string,
      { points: number; maxPoints: number; active: string[] }
    >;
  };

  /** Environment system (lighting, skybox, fog, shadows) */
  environment?: Environment;

  /** Graphics rendering system (WebGPU renderer, post-processing) */
  graphics?: ClientGraphics & {
    renderer?: {
      domElement: HTMLCanvasElement;
      render?: (scene: unknown, camera: unknown) => void;
      setSize?: (width: number, height: number) => void;
    };
    width?: number;
    height?: number;
    isWebGPU?: boolean;
    hasRendered?: boolean;
  };

  /** Dev mode performance stats (FPS counter, system timing) */
  devStats?: {
    toggle: () => void;
    show: () => void;
    hide: () => void;
    getFps: () => number;
    getFrameTime: () => number;
    getStreamingPerformanceSnapshot: () => unknown | null;
    isVisible: () => boolean;
    enableSystemTiming: () => void;
    disableSystemTiming: () => void;
    recordSystemTime: (systemName: string, timeMs: number) => void;
  };

  /** Input handling system (keyboard, mouse, touch, gamepad) */
  controls?: ClientInput;

  /** User preferences and settings UI */
  prefs?: ClientInterface & {
    dpr?: number;
    shadows?: string;
    postprocessing?: boolean;
    bloom?: boolean;
    colorGrading?: string;
    colorGradingIntensity?: number;
    depthBlur?: boolean;
    depthBlurIntensity?: number;
    depthBlurDistance?: number;
    music?: number;
    sfx?: number;
    voice?: number;
    voiceEnabled?: boolean;
    ui?: number;
    stats?: boolean;
    chatVisible?: boolean;
    on?: (event: string, callback: (changes: unknown) => void) => void;
    off?: (event: string, callback: (changes: unknown) => void) => void;
    setDPR?: (value: number) => void;
    setShadows?: (value: string) => void;
    setPostprocessing?: (value: boolean) => void;
    setBloom?: (value: boolean) => void;
    setColorGrading?: (value: string) => void;
    setColorGradingIntensity?: (value: number) => void;
    setDepthBlur?: (value: boolean) => void;
    setDepthBlurIntensity?: (value: number) => void;
    setDepthBlurDistance?: (value: number) => void;
    setMusic?: (value: number) => void;
    setSFX?: (value: number) => void;
    setVoice?: (value: number) => void;
    setVoiceEnabled?: (value: boolean) => void;
    setUI?: (value: number) => void;
    setStats?: (value: boolean) => void;
  };

  /** Audio system for spatial and ambient sound */
  audio?: ClientAudio;

  /** Music system for background music playback */
  music?: import("../systems/shared").MusicSystem;

  /** Performance monitoring (CPU, memory, FPS) */
  monitor?: ClientMonitor & {
    getStats?: () => Promise<{
      currentCPU: number;
      currentMemory: number;
      maxMemory: number;
    }>;
  };

  /** LiveKit integration for voice chat */
  livekit?: ClientLiveKit & {
    getPlayerOpts?: (id: string) => Promise<unknown>;
    on?: (event: string, callback: (data: unknown) => void) => void;
    setScreenShareTarget?: (targetId: string) => void;
  };

  /** Statistics display system */
  stats?: ClientInterface;

  // ============================================================================
  // SERVER-ONLY SYSTEMS (Only present in Node.js environments)
  // ============================================================================

  /** Database system for persistence (SQLite or PostgreSQL) */
  db?: ServerDB;

  /** Server runtime lifecycle and monitoring */
  server?: ServerRuntime;

  /** Storage abstraction for file-based data */
  storage?: unknown;

  /** PostgreSQL connection pool (when using PostgreSQL backend) */
  pgPool?: unknown;

  /** Drizzle ORM database instance (when using Drizzle for queries) */
  drizzleDb?: unknown;

  // ============================================================================
  // DYNAMIC SYSTEMS (Added by specific game modes or features)
  // ============================================================================

  /** Builder tool system for world editing (client-only) */
  builder?: {
    enabled: boolean;
    mode?: string;
    tool?: string;
  };

  /** Player actions system for context-sensitive interactions */
  actions?: ClientActions & {
    btnDown?: boolean;
    execute?: (
      actionName: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
    getAvailable?: () => string[];
  };

  /** Terrain generation and heightmap system */
  terrain?: {
    getHeightAt: (x: number, z: number) => number;
    generate: (params: Record<string, unknown>) => void;
  };

  // ============================================================================
  // EVENT SYSTEM
  // ============================================================================

  /** Type-safe event bus for inter-system communication (preferred over EventEmitter) */
  $eventBus: EventBus;

  /** Maps event names to their EventBus subscriptions for cleanup */
  __busListenerMap: Map<
    string,
    Map<(...args: unknown[]) => void, EventSubscription>
  > = new Map();

  // ============================================================================
  // LEGACY/COMPATIBILITY PROPERTIES
  // ============================================================================

  /** Move app state (legacy, may be removed) */
  moveApp?: {
    enabled?: boolean;
  };

  /** Direct entity property access (legacy, prefer using entities system) */
  entity?: {
    id?: string;
    position?: { x: number; y: number; z: number };
    [key: string]: unknown;
  };

  // ============================================================================
  // RPG GAME API (Added by SystemLoader when RPG systems are registered)
  // ============================================================================

  /**
   * Unified collision matrix for tile-based collision.
   * Stores rules-accurate bitmask flags per tile in zone-based chunks.
   *
   * Key features:
   * - Static objects (trees, rocks, furnaces) set BLOCKED flag
   * - Entities set OCCUPIED_PLAYER or OCCUPIED_NPC flags
   * - Zone-based storage (8x8 tiles) for cache efficiency
   * - Directional wall support for complex obstacles
   *
   * @see CollisionFlags for flag definitions
   * @see CollisionMatrix for implementation
   */
  collision: ICollisionMatrix = new CollisionMatrix();

  /**
   * Entity occupancy tracking for tile-based collision.
   * Facade over CollisionMatrix for entity-specific queries.
   *
   * Key features:
   * - NPCs set collision flags when occupying tiles
   * - Collision is checked at movement execution time
   * - Bosses can ignore collision via `ignoresEntityCollision` flag
   * - Delegates blocking checks to CollisionMatrix
   *
   * @see NPC_ENTITY_COLLISION_PLAN.md
   */
  entityOccupancy: IEntityOccupancy = new EntityOccupancyMap();

  /** Action registry for context-based player actions */
  actionRegistry?: {
    getAll(): Array<{ name: string; [key: string]: unknown }>;
    getAvailable(
      context: Record<string, unknown>,
    ): Array<{ name: string; [key: string]: unknown }>;
    execute(
      name: string,
      context: Record<string, unknown>,
      params: Record<string, unknown>,
    ): Promise<unknown>;
  };

  /** Reference to all registered RPG systems (PlayerSystem, CombatSystem, etc.) */
  rpgSystems?: Record<string, { name: string; [key: string]: unknown }>;

  /** All available RPG actions that can be executed */
  rpgActions?: Record<
    string,
    {
      name: string;
      execute: (params: Record<string, unknown>) => Promise<unknown>;
      [key: string]: unknown;
    }
  >;

  /** Flattened action methods for direct world.actionName() calls */
  actionMethods?: Record<string, (...args: unknown[]) => unknown>;

  // ----------------------------------------------------------------------------
  // Player Management API (added by PlayerSystem)
  // ----------------------------------------------------------------------------

  /** Get RPG player data by ID */
  getRPGPlayer?(
    playerId: string,
  ): { id: string; [key: string]: unknown } | undefined;

  /** Save player data to database */
  savePlayer?(playerId: string, data: Record<string, unknown>): unknown;

  /** Get all active players in the world */
  getAllPlayers?(): unknown[];

  /** Heal a player by specified amount */
  healPlayer?(playerId: string, amount: number): unknown;

  /** Damage a player by specified amount */
  damagePlayer?(playerId: string, amount: number): unknown;

  /** Check if player is alive */
  isPlayerAlive?(playerId: string): boolean;

  /** Get player's current and max health */
  getPlayerHealth?(playerId: string): { current: number; max: number };

  /** Teleport player to a position */
  teleportPlayer?(playerId: string, position: Position3D): unknown;

  // ----------------------------------------------------------------------------
  // Combat API (added by CombatSystem)
  // ----------------------------------------------------------------------------

  /** Initiate combat between attacker and target */
  startCombat?(attackerId: string, targetId: string): unknown;

  /** End combat for an entity */
  stopCombat?(attackerId: string): unknown;

  /** Check if attacker can attack target (range, cooldown, state) */
  canAttack?(attackerId: string, targetId: string): boolean;

  /** Check if entity is currently in combat */
  isInCombat?(entityId: string): boolean;

  // ----------------------------------------------------------------------------
  // Skills API (added by SkillsSystem)
  // ----------------------------------------------------------------------------

  /** Get all skill levels and XP for a player */
  getSkills?(playerId: string): Record<string, { level: number; xp: number }>;

  /** Get level for a specific skill */
  getSkillLevel?(playerId: string, skill: string): number;

  /** Get XP for a specific skill */
  getSkillXP?(playerId: string, skill: string): number;

  /** Get calculated combat level based on combat skills */
  getCombatLevel?(playerId: string): number;

  /** Get XP needed to reach next level in a skill */
  getXPToNextLevel?(playerId: string, skill: string): number;

  // ----------------------------------------------------------------------------
  // Inventory API (added by InventorySystem)
  // ----------------------------------------------------------------------------

  /** Get player's inventory contents */
  getInventory?(
    playerId: string,
  ): Array<{ itemId: string; quantity: number; [key: string]: unknown }>;

  /** Get player's equipped items */
  getEquipment?(
    playerId: string,
  ): Record<string, { itemId: string; [key: string]: unknown }>;

  /** Check if player has item in inventory */
  hasItem?(
    playerId: string,
    itemId: string | number,
    quantity?: number,
  ): boolean;

  /** Get count of arrows equipped/in inventory (for ranged combat) */
  getArrowCount?(playerId: string): number;

  /** Check if item can be added to player's inventory */
  canAddItem?(playerId: string, item: unknown): boolean;

  // ----------------------------------------------------------------------------
  // Movement API (added by movement-related systems)
  // ----------------------------------------------------------------------------

  /** Check if player is currently moving */
  isPlayerMoving?(playerId: string): boolean;

  /** Get player's stamina (used for running) */
  getPlayerStamina?(playerId: string): {
    current: number;
    max: number;
    regenerating: boolean;
  };

  /** Command player to move to target position */
  movePlayer?(playerId: string, targetPosition: Position3D): unknown;

  // ----------------------------------------------------------------------------
  // Mob API (added by MobNPCSystem)
  // ----------------------------------------------------------------------------

  /** Get mob entity by ID */
  getMob?(mobId: string): unknown;

  /** Get all active mobs in the world */
  getAllMobs?(): unknown[];

  /** Get mobs within radius of a point */
  getMobsInArea?(center: Position3D, radius: number): unknown[];

  /** Spawn a mob at position */
  spawnMob?(type: string, position: Position3D): unknown;

  /** Get instanced renderer stats for debugging/testing */
  getMobInstancedRendererStats?(): {
    totalHandles: number;
    activeHandles: number;
    imposterHandles: number;
    totalInstances: number;
    modelCount: number;
    groupCount: number;
    instancedMeshCount: number;
    totalSkeletons: number;
    frozenGroups: number;
  } | null;

  /** Get ImpostorManager stats for debugging/testing */
  getImpostorManagerStats?(): {
    cacheHits: number;
    cacheMisses: number;
    totalBaked: number;
    totalFromIndexedDB: number;
    queueLength: number;
    memoryCacheSize: number;
  } | null;

  // ----------------------------------------------------------------------------
  // Equipment API (added by EquipmentSystem)
  // ----------------------------------------------------------------------------

  /** Get player's current equipment */
  getPlayerEquipment?(playerId: string): unknown;

  /** Get raw equipment data */
  getEquipmentData?(playerId: string): unknown;

  /** Get calculated equipment bonuses */
  getEquipmentStats?(playerId: string): unknown;

  /** Check if specific item is equipped */
  isItemEquipped?(playerId: string, itemId: number): boolean;

  /** Check if player can equip item (level requirements, etc.) */
  canEquipItem?(playerId: string, itemId: number): boolean;

  /** Consume one arrow (for ranged attacks) */
  consumeArrow?(playerId: string): unknown;

  // ----------------------------------------------------------------------------
  // Store and Banking API (added by StoreSystem and BankingSystem)
  // ----------------------------------------------------------------------------

  /** Get store data by ID */
  getStore?(storeId: string): unknown;

  /** Get all stores in the world */
  getAllStores?(): unknown[];

  /** Get all store locations */
  getStoreLocations?(): unknown[];

  /** Get player's bank data for a specific bank */
  getBankData?(playerId: string, bankId: string): unknown;

  /** Get all banks accessible to player */
  getAllPlayerBanks?(playerId: string): unknown[];

  /** Get all bank locations */
  getBankLocations?(): unknown[];

  // ----------------------------------------------------------------------------
  // Resource API (added by ResourceSystem)
  // ----------------------------------------------------------------------------

  /** Get resource (tree, fishing spot, etc.) by ID */
  getResource?(resourceId: string): unknown;

  /** Get all resources in the world */
  getAllResources?(): unknown[];

  /** Get resources of a specific type (e.g., all trees) */
  getResourcesByType?(type: string): unknown[];

  // ----------------------------------------------------------------------------
  // Item/Loot API (added by LootSystem and item-related systems)
  // ----------------------------------------------------------------------------

  /** Drop item at position (creates ground item entity) */
  dropItem?(item: unknown, position: Position3D, droppedBy?: string): unknown;

  /** Get items on ground within range of position */
  getItemsInRange?(position: Position3D, range?: number): unknown[];

  /** Get specific ground item by ID */
  getGroundItem?(itemId: string): unknown;

  /** Get all ground items */
  getAllGroundItems?(): unknown[];

  /** Clear all items from ground */
  clearAllItems?(): unknown;

  // ----------------------------------------------------------------------------
  // Testing Utilities (only available in test environments)
  // ----------------------------------------------------------------------------

  /** Color detection for visual testing (Playwright tests) */
  colorDetector?: {
    detectColor(
      x: number,
      y: number,
    ): { r: number; g: number; b: number; a: number };
    getPixels(): Uint8Array;
    registerEntityColor(
      entityType: string,
      config: { color: number | string; hex?: string; tolerance?: number },
    ): void;
  };

  /** Test player registry for test isolation */
  _testPlayers?: Map<string, unknown>;

  /** Allow material creation in tests */
  _allowMaterial?: boolean;

  /** Asset loader for dynamic model loading */
  assetLoader?: {
    loadModel?: (url: string) => void;
  };

  // ============================================================================
  // SYSTEM ACCESS METHODS
  // ============================================================================

  /**
   * Get a system by its registered name with type safety.
   *
   * Example:
   * ```ts
   * const physics = world.getSystem<Physics>('physics');
   * ```
   *
   * @param systemKey - The key used when registering the system
   * @returns The system instance or undefined if not found
   */
  getSystem<T extends System = any>(systemKey: string): T | undefined {
    return this.systemsByName.get(systemKey) as T | undefined;
  }

  /**
   * Find a system by name or constructor name.
   * Less efficient than getSystem() but useful when you don't know the exact key.
   *
   * @param nameOrConstructor - System name or class name to search for
   * @returns The system instance or undefined if not found
   */
  findSystem<T extends System = any>(nameOrConstructor: string): T | undefined {
    const system = this.systems.find((s) => {
      return (
        s.constructor.name === nameOrConstructor ||
        ("name" in s &&
          (s as Record<string, unknown>).name === nameOrConstructor)
      );
    });
    return system as T | undefined;
  }

  /**
   * Check if world is running on server.
   * Determined by the registered network system.
   */
  get isServer(): boolean {
    return this.network?.isServer ?? false;
  }

  /**
   * Check if world is running on client.
   * Determined by the registered network system.
   */
  get isClient(): boolean {
    return this.network?.isClient ?? true;
  }

  /**
   * World Constructor
   *
   * Creates a new World instance and registers core systems.
   * Additional systems (client/server-specific, RPG systems) are registered by create*World() functions.
   *
   * Core systems registered here:
   * - settings: Game configuration
   * - anchors: Spatial anchor management
   * - events: Legacy event system
   * - chat: Player communication
   * - entities: Entity Component System
   * - physics: PhysX physics simulation
   * - stage: Three.js scene management
   *
   * Network system is intentionally not registered here - it's added by:
   * - createClientWorld() → ClientNetwork
   * - createServerWorld() → ServerNetwork
   */
  constructor() {
    super();

    // Initialize type-safe event bus for inter-system communication
    // Preferred over EventEmitter for new code
    this.$eventBus = new EventBus();

    // Generate unique world ID using timestamp + random string
    this.id = `world_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create Three.js rig (camera parent) for rendering
    this.rig = new THREE.Object3D() as HyperiaObject3D;

    // Create perspective camera with carefully tuned near/far planes:
    // - near (0.2): Slightly smaller than spherecast to prevent clipping
    // - far (2000): Optimized draw distance for performance
    // Sky geometry is scaled to fit within this range (follows camera)
    // This prevents z-fighting without needing expensive logarithmic depth buffers
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.2, 10000);

    // Enable layer 1 for main camera (vegetation, water, grass, building walls are on layer 1)
    // Enable layer 2 for building floors (walkable surfaces for click-to-move)
    // Minimap camera only sees layer 0 for performance
    this.camera.layers.enable(1);
    this.camera.layers.enable(2);

    this.rig.add(this.camera);

    // Register core systems in dependency order
    // These systems are required for both client and server
    this.register("settings", SettingsSystem);
    this.register("anchors", AnchorsSystem);
    this.register("events", EventsSystem);
    this.register("chat", ChatSystem);
    this.register("entities", EntitiesSystem);

    // Physics is now supported on both client and server with Node.js-compatible PhysX
    this.register("physics", PhysicsSystem);

    this.register("stage", StageSystem);

    // Wire CollisionMatrix to EntityOccupancyMap for unified collision storage
    // EntityOccupancyMap will delegate entity collision flags to CollisionMatrix
    if (this.entityOccupancy instanceof EntityOccupancyMap) {
      this.entityOccupancy.setCollisionMatrix(this.collision);
    }

    // Network system is registered separately by createClientWorld() or createServerWorld()
    // This allows World to be environment-agnostic
  }

  // ============================================================================
  // SYSTEM REGISTRATION AND MANAGEMENT
  // ============================================================================

  /**
   * Register a system by creating an instance and adding it to the world.
   *
   * The system is both:
   * 1. Added to the systems array for lifecycle management
   * 2. Dynamically assigned to world[key] for direct access
   *
   * @param key - Name to register system under (e.g., 'physics')
   * @param SystemClass - System constructor to instantiate
   * @returns The created system instance
   */
  register(key: string, SystemClass: SystemConstructor): System {
    const system = new SystemClass(this);
    this.addSystem(key, system);
    return system;
  }

  /**
   * Add an already-instantiated system to the world.
   *
   * @param key - Name to register system under
   * @param system - System instance to add
   */
  addSystem(key: string, system: System): void {
    this.systems.push(system);
    this.systemsByName.set(key, system);

    // Dynamically assign system to world instance for convenient access
    // Allows: world.physics instead of world.getSystem('physics')
    Object.defineProperty(this, key, {
      value: system,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Topologically Sort Systems Based on Dependencies
   *
   * Ensures systems are initialized in the correct order based on their dependencies.
   * For example, if System B depends on System A, System A will be initialized first.
   *
   * Throws an error if:
   * - Circular dependencies are detected
   * - A required dependency is not registered
   *
   * @param systems - Array of systems to sort
   * @returns Systems sorted in dependency order (dependencies first)
   */
  topologicalSort(systems: System[]): System[] {
    const sorted: System[] = [];
    const visited = new Set<System>();
    const visiting = new Set<System>();

    const systemToName = new Map<System, string>();
    this.systemsByName.forEach((system, name) => {
      systemToName.set(system, name);
    });

    const visit = (system: System) => {
      if (visited.has(system)) return;
      if (visiting.has(system)) {
        const systemName = systemToName.get(system) || system.constructor.name;
        throw new Error(
          `Circular dependency detected involving system: ${systemName}`,
        );
      }

      visiting.add(system);

      const deps = system.getDependencies();
      if (deps.required) {
        for (const depName of deps.required) {
          const depSystem = this.systemsByName.get(depName);
          if (!depSystem) {
            const systemName =
              systemToName.get(system) || system.constructor.name;
            throw new Error(
              `System ${systemName} requires ${depName}, but ${depName} is not registered`,
            );
          }
          visit(depSystem);
        }
      }

      visiting.delete(system);
      visited.add(system);
      sorted.push(system);
    };

    for (const system of systems) {
      visit(system);
    }

    return sorted;
  }

  /**
   * Group Systems by Dependency Depth for Parallel Initialization
   *
   * Creates "waves" of systems that can be initialized in parallel.
   * Each wave contains systems whose dependencies have all been initialized
   * in previous waves.
   *
   * Example:
   * - Wave 0: [settings, anchors, events] - no dependencies
   * - Wave 1: [chat, physics] - depend on wave 0 systems
   * - Wave 2: [terrain, entities] - depend on wave 0-1 systems
   *
   * @param systems - Array of systems to group
   * @returns Array of waves, each wave is an array of systems that can init in parallel
   */
  groupSystemsByDepth(systems: System[]): System[][] {
    const waves: System[][] = [];
    const systemDepths = new Map<System, number>();
    const systemToName = new Map<System, string>();

    this.systemsByName.forEach((system, name) => {
      systemToName.set(system, name);
    });

    // Calculate depth for each system (max dependency depth + 1)
    const calculateDepth = (system: System, visited: Set<System>): number => {
      if (systemDepths.has(system)) {
        return systemDepths.get(system)!;
      }

      if (visited.has(system)) {
        const systemName = systemToName.get(system) || system.constructor.name;
        throw new Error(
          `Circular dependency detected involving system: ${systemName}`,
        );
      }

      visited.add(system);

      const deps = system.getDependencies();
      let maxDepth = -1;

      if (deps.required) {
        for (const depName of deps.required) {
          const depSystem = this.systemsByName.get(depName);
          if (depSystem) {
            const depDepth = calculateDepth(depSystem, new Set(visited));
            maxDepth = Math.max(maxDepth, depDepth);
          }
        }
      }

      const depth = maxDepth + 1;
      systemDepths.set(system, depth);
      visited.delete(system);
      return depth;
    };

    // Calculate depths for all systems
    for (const system of systems) {
      calculateDepth(system, new Set());
    }

    // Group systems by depth
    for (const system of systems) {
      const depth = systemDepths.get(system) || 0;
      while (waves.length <= depth) {
        waves.push([]);
      }
      waves[depth].push(system);
    }

    return waves;
  }

  /**
   * Initialize World and All Systems
   *
   * This is the second step in world lifecycle (after constructor).
   * Initializes all registered systems in dependency order and emits progress events.
   *
   * Process:
   * 1. Set up storage and asset paths from options
   * 2. Group systems by dependency depth for parallel initialization
   * 3. Initialize each wave of systems in parallel, emitting progress events
   * 4. Start all systems after initialization complete
   *
   * PERFORMANCE: Systems at the same dependency depth are initialized in parallel,
   * significantly reducing overall initialization time on multi-core systems.
   *
   * @param options - Configuration including storage, asset paths, etc.
   */
  async init(options: WorldOptions): Promise<void> {
    // Guard against multiple initialization (can happen in hot reload scenarios)
    if (this._initialized) {
      console.warn(
        "[World] init() called multiple times, skipping duplicate initialization",
      );
      return;
    }
    this._initialized = true;

    // Set up storage and asset paths
    this.storage = options.storage;
    this.assetsDir = options.assetsDir ?? "";
    this.assetsUrl = options.assetsUrl ?? "/assets/";

    // Group systems by dependency depth for parallel initialization
    // Systems in the same wave have no dependencies on each other and can init in parallel
    const systemWaves = this.groupSystemsByDepth(this.systems);

    const totalSystems = this.systems.length;
    let initializedSystems = 0;

    // Build reverse lookup map for progress reporting
    const systemNameMap = new Map<System, string>();
    for (const [name, system] of this.systemsByName) {
      systemNameMap.set(system, name);
    }
    const traceInit = isInitTraceEnabled();

    // Initialize systems wave by wave (systems in same wave run in parallel)
    for (let waveIndex = 0; waveIndex < systemWaves.length; waveIndex++) {
      const wave = systemWaves[waveIndex];
      const waveNames = wave
        .map((s) => systemNameMap.get(s) || "Unknown")
        .join(", ");

      // Emit progress before initializing wave
      this.emit(EventType.ASSETS_LOADING_PROGRESS, {
        progress: Math.floor((initializedSystems / totalSystems) * 100),
        stage:
          wave.length > 1
            ? `Initializing [${waveNames}]...`
            : `Initializing ${waveNames}...`,
        total: totalSystems,
        current: initializedSystems,
      });

      // Initialize all systems in this wave in parallel
      await Promise.all(
        wave.map(async (system) => {
          const systemName = getSystemDebugName(systemNameMap, system);
          if (traceInit) {
            console.log(`[World.init] -> init ${systemName}`);
          }
          await system.init(options);
          if (traceInit) {
            console.log(`[World.init] <- init ${systemName}`);
          }
        }),
      );
      initializedSystems += wave.length;
    }

    // Emit final progress event
    this.emit(EventType.ASSETS_LOADING_PROGRESS, {
      progress: 100,
      stage: "Starting world...",
      total: totalSystems,
      current: initializedSystems,
    });

    // Start all systems (transitions from 'initialized' to 'started' state)
    await this.start();
  }

  /**
   * Start All Systems
   *
   * Called after all systems are initialized.
   * Transitions systems from 'initialized' state to 'started' state.
   * Systems can begin their active operations (network connections, timers, etc.)
   *
   * ServerRuntime (the main tick-loop driver) is deferred until all other
   * systems have started. This prevents it from accumulating tick debt while
   * heavy synchronous systems (terrain, towns, physics) block the event loop
   * during their start() methods.
   *
   * Note: Some systems have async start() methods (e.g., TerrainSystem) that need
   * to wait for data loading. This method awaits all system starts to ensure
   * proper initialization order.
   */
  async start(): Promise<void> {
    const nameBySystem = new Map<System, string>();
    for (const [key, sys] of this.systemsByName) {
      nameBySystem.set(sys, key);
    }
    const traceInit = isInitTraceEnabled();

    const deferred: System[] = [];

    for (const system of this.systems) {
      if (nameBySystem.get(system) === "server") {
        deferred.push(system);
        continue;
      }
      const systemName = getSystemDebugName(nameBySystem, system);
      if (traceInit) {
        console.log(`[World.start] -> start ${systemName}`);
      }
      const startResult = system.start();
      if (startResult instanceof Promise) {
        await startResult;
      }
      if (traceInit) {
        console.log(`[World.start] <- start ${systemName}`);
      }
    }

    // Start tick-loop systems last so they begin with a clean clock
    for (const system of deferred) {
      const systemName = getSystemDebugName(nameBySystem, system);
      if (traceInit) {
        console.log(`[World.start] -> start ${systemName}`);
      }
      const startResult = system.start();
      if (startResult instanceof Promise) {
        await startResult;
      }
      if (traceInit) {
        console.log(`[World.start] <- start ${systemName}`);
      }
    }
  }

  // ============================================================================
  // GAME LOOP (Fixed Timestep with Interpolation)
  // ============================================================================

  /**
   * Main Game Loop - Called Every Frame
   *
   * Implements a fixed-timestep game loop with interpolation for smooth rendering.
   * This architecture ensures deterministic physics regardless of frame rate.
   *
   * DUAL DELTA ARCHITECTURE:
   * - Physics Delta (capped at 33ms): Prevents spiral of death in physics simulation
   * - Animation Delta (capped at 500ms): Real-time playback for animations/movement
   *
   * This separation ensures animations and movement play at correct real-world speed
   * even at low FPS, preventing the "slow motion then teleport" effect.
   *
   * Loop Structure:
   * 1. preTick(): Pre-frame setup (stats, monitoring)
   * 2. fixedUpdate(): Physics simulation at fixed 30 FPS (physics delta)
   * 3. update(): Animations, movement, input (animation delta - real-time)
   * 4. lateUpdate(): Camera, UI transformations (animation delta)
   * 5. commit(): Final rendering/network send
   * 6. postTick(): Post-frame cleanup (stats, profiling)
   *
   * Fixed Timestep Details:
   * - Physics runs at exactly 30 FPS (fixedDeltaTime = 1/30)
   * - Multiple physics steps may run per frame if frame time is long
   * - Interpolation (alpha) smooths visual updates between physics steps
   * - Animations/movement use real-time delta for correct playback speed
   *
   * @param time - Current time in milliseconds (from requestAnimationFrame)
   */
  tick = (time: number): void => {
    const _tickT0 = this.isServer ? performance.now() : 0;

    // Begin frame budget tracking (client only)
    if (this.frameBudget) {
      this.frameBudget.beginFrame();
    }

    // Begin performance monitoring
    this.preTick();

    // Convert time to seconds and calculate delta
    time /= 1000;
    const rawDelta = time - this.time;

    // Animation/movement delta: real-time playback, capped at 500ms (2 FPS minimum)
    // This ensures animations and movement run at correct real-world speed
    // even at low frame rates, preventing the "slow motion" effect
    const animationDelta =
      rawDelta < 0 ? 0 : Math.min(rawDelta, this.maxAnimationDeltaTime);

    // Physics delta: clamped to 33ms to prevent spiral of death
    // Physics simulation needs smaller timesteps for stability
    const physicsDelta =
      rawDelta < 0 ? 0 : Math.min(rawDelta, this.maxPhysicsDeltaTime);

    // Update frame counter and time
    this.frame++;
    this.time = time;
    this.accumulator += physicsDelta;

    // Prepare physics (notify systems if fixed step will occur)
    const willFixedStep = this.accumulator >= this.fixedDeltaTime;
    this.preFixedUpdate(willFixedStep);

    // Run fixed-timestep physics updates
    // May run 0, 1, or multiple times depending on accumulated time
    const _fixedT0 = this.isServer ? performance.now() : 0;
    let _fixedSteps = 0;
    while (this.accumulator >= this.fixedDeltaTime) {
      // Update game state at fixed intervals
      this.fixedUpdate(this.fixedDeltaTime);
      // Step physics simulation
      this.postFixedUpdate(this.fixedDeltaTime);
      // Consume fixed timestep from accumulator
      this.accumulator -= this.fixedDeltaTime;
      _fixedSteps++;
    }
    const _fixedMs = this.isServer ? performance.now() - _fixedT0 : 0;
    if (_fixedMs > 20) {
      console.warn(
        `[World.tick] fixedUpdate took ${_fixedMs.toFixed(0)}ms (${_fixedSteps} steps)`,
      );
    }

    // Calculate interpolation alpha for smooth rendering
    // Alpha = 0 means use previous physics state, 1 means use current state
    const alpha = this.accumulator / this.fixedDeltaTime;
    this.preUpdate(alpha);

    // Phase timing for server-side diagnostics
    const _phaseT = this.isServer ? performance.now() : 0;

    // Run frame-rate dependent updates using ANIMATION delta (real-time)
    // This ensures animations and movement play at correct speed regardless of FPS
    this.update(animationDelta, alpha);

    const _updateMs = this.isServer ? performance.now() - _phaseT : 0;
    const _phaseT2 = this.isServer ? performance.now() : 0;

    // Clean up transforms after updates
    this.postUpdate(animationDelta);

    // Run late updates (camera, UI that depends on transforms)
    this.lateUpdate(animationDelta, alpha);

    // Final transform cleanup before rendering
    this.postLateUpdate(animationDelta);

    const _lateMs = this.isServer ? performance.now() - _phaseT2 : 0;
    const _phaseT3 = this.isServer ? performance.now() : 0;

    // Commit changes (render on client, send network updates on server)
    this.commit();
    const _commitMs = this.isServer ? performance.now() - _phaseT3 : 0;

    // Process deferred work if we have budget remaining
    // This runs low-priority work that was deferred from previous frames
    if (this.frameBudget) {
      this.frameBudget.processDeferredWork();
    }

    // End performance monitoring
    this.postTick();

    if (this.isServer) {
      const _totalTickMs = performance.now() - _tickT0;
      const _measuredMs = _fixedMs + _updateMs + _lateMs + _commitMs;
      const _unmeasuredMs = Math.max(0, _totalTickMs - _measuredMs);
      this._serverTickTimingHistograms.total.record(_totalTickMs);
      this._serverTickTimingHistograms.fixedUpdate.record(_fixedMs);
      this._serverTickTimingHistograms.update.record(_updateMs);
      this._serverTickTimingHistograms.lateUpdate.record(_lateMs);
      this._serverTickTimingHistograms.commit.record(_commitMs);
      this._serverTickTimingHistograms.unmeasured.record(_unmeasuredMs);
      if (_totalTickMs > 50) {
        console.warn(
          `[World.tick] TOTAL=${_totalTickMs.toFixed(0)}ms fixed=${_fixedMs.toFixed(0)}ms(${_fixedSteps}st) update=${_updateMs.toFixed(0)}ms late=${_lateMs.toFixed(0)}ms commit=${_commitMs.toFixed(0)}ms unmeasured=${_unmeasuredMs.toFixed(0)}ms`,
        );
      }
    }

    // End frame budget tracking (client only)
    if (this.frameBudget) {
      this.frameBudget.endFrame();
    }
  };

  // ============================================================================
  // SYSTEM TIMING (Performance Monitoring)
  // ============================================================================

  /** Whether to measure individual system timing (enabled by DevStats) */
  private _measureSystemTiming = false;

  /** Per-system timing data for the current frame */
  private _systemTimings = new Map<
    string,
    { update: number; fixedUpdate: number; lateUpdate: number; total: number }
  >();

  /** Rolling averages for system timing (smoothed display) */
  private _systemTimingAverages = new Map<
    string,
    { samples: number[]; avg: number }
  >();

  /** Full-window server frame and per-system distributions for soak evidence. */
  private readonly _serverTickTimingHistograms = {
    total: new DurationHistogram(),
    fixedUpdate: new DurationHistogram(),
    update: new DurationHistogram(),
    lateUpdate: new DurationHistogram(),
    commit: new DurationHistogram(),
    unmeasured: new DurationHistogram(),
  };
  private readonly _serverSystemFrameTotals = new Map<string, number>();
  private readonly _serverSystemTimingHistograms = new Map<
    string,
    DurationHistogram
  >();

  /** Maximum samples to keep for averaging */
  private readonly _maxTimingSamples = 30;
  private _asyncTickCallMetrics = new Map<string, AsyncTickCallMetric>();

  /**
   * Enable system timing measurement
   * Called by DevStats when system timing is enabled
   */
  enableSystemTiming(): void {
    this._measureSystemTiming = true;
  }

  /**
   * Disable system timing measurement
   * Called by DevStats when system timing is disabled
   */
  disableSystemTiming(): void {
    this._measureSystemTiming = false;
    this._systemTimings.clear();
    this._systemTimingAverages.clear();
    this._serverSystemFrameTotals.clear();
    this._serverSystemTimingHistograms.clear();
  }

  getServerTickTimingPercentiles(): WorldTickTimingPercentiles {
    return {
      total: this._serverTickTimingHistograms.total.snapshot(),
      fixedUpdate: this._serverTickTimingHistograms.fixedUpdate.snapshot(),
      update: this._serverTickTimingHistograms.update.snapshot(),
      lateUpdate: this._serverTickTimingHistograms.lateUpdate.snapshot(),
      commit: this._serverTickTimingHistograms.commit.snapshot(),
      unmeasured: this._serverTickTimingHistograms.unmeasured.snapshot(),
    };
  }

  getSystemTimingPercentiles(): WorldSystemTimingPercentiles[] {
    return Array.from(this._serverSystemTimingHistograms.entries())
      .map(([name, histogram]) => ({ name, ...histogram.snapshot() }))
      .sort((left, right) => {
        if (right.p99 !== left.p99) return right.p99 - left.p99;
        if (right.max !== left.max) return right.max - left.max;
        return left.name.localeCompare(right.name);
      });
  }

  resetServerTimingPercentiles(): void {
    for (const histogram of Object.values(this._serverTickTimingHistograms)) {
      histogram.reset();
    }
    for (const histogram of this._serverSystemTimingHistograms.values()) {
      histogram.reset();
    }
  }

  /**
   * Get all system timing data for the current frame
   * Returns sorted array of system timings (slowest first)
   */
  getSystemTimings(): Array<{
    name: string;
    update: number;
    fixedUpdate: number;
    lateUpdate: number;
    total: number;
    avg: number;
  }> {
    const result: Array<{
      name: string;
      update: number;
      fixedUpdate: number;
      lateUpdate: number;
      total: number;
      avg: number;
    }> = [];

    for (const [name, timing] of this._systemTimings) {
      const avgData = this._systemTimingAverages.get(name);
      result.push({
        name,
        update: timing.update,
        fixedUpdate: timing.fixedUpdate,
        lateUpdate: timing.lateUpdate,
        total: timing.total,
        avg: avgData?.avg ?? timing.total,
      });
    }

    // Sort by average time (slowest first)
    result.sort((a, b) => b.avg - a.avg);
    return result;
  }

  getAsyncTickDiagnostics(limit: number = 20): AsyncTickCallMetric[] {
    return Array.from(this._asyncTickCallMetrics.values())
      .sort((a, b) => {
        if (b.inFlight !== a.inFlight) {
          return b.inFlight - a.inFlight;
        }
        if (b.peakInFlight !== a.peakInFlight) {
          return b.peakInFlight - a.peakInFlight;
        }
        return b.observed - a.observed;
      })
      .slice(0, limit)
      .map((metric) => ({ ...metric }));
  }

  private trackAsyncTickResult(
    phase: AsyncTickCallMetric["phase"],
    label: string,
    result: unknown,
  ): void {
    if (!result || typeof result !== "object" || !("then" in result)) {
      return;
    }

    const promiseLike = result as Promise<unknown>;
    const metricLabel = `${phase}:${label}`;
    const metric = this._asyncTickCallMetrics.get(metricLabel) ?? {
      label,
      phase,
      observed: 0,
      inFlight: 0,
      peakInFlight: 0,
      rejections: 0,
      lastSeenAt: 0,
    };

    metric.observed++;
    metric.inFlight++;
    metric.lastSeenAt = Date.now();
    if (metric.inFlight > metric.peakInFlight) {
      metric.peakInFlight = metric.inFlight;
    }
    this._asyncTickCallMetrics.set(metricLabel, metric);

    promiseLike
      .catch(() => {
        metric.rejections++;
      })
      .finally(() => {
        metric.inFlight = Math.max(0, metric.inFlight - 1);
      });
  }

  /**
   * Get frame budget statistics (client only)
   * Returns null on server or if frame budget manager is not initialized
   */
  getFrameBudgetStats(): FrameTimingStats | null {
    return this.frameBudget?.getStats() ?? null;
  }

  /**
   * Check if we have time remaining in the frame budget
   * Returns true on server or if frame budget is not initialized
   */
  hasFrameBudget(ms: number = 1): boolean {
    return this.frameBudget?.hasTimeRemaining(ms) ?? true;
  }

  /**
   * Record timing for a system and update rolling average
   */
  private recordSystemTiming(
    systemName: string,
    phase: "update" | "fixedUpdate" | "lateUpdate",
    timeMs: number,
  ): void {
    let timing = this._systemTimings.get(systemName);
    if (!timing) {
      timing = { update: 0, fixedUpdate: 0, lateUpdate: 0, total: 0 };
      this._systemTimings.set(systemName, timing);
    }
    timing[phase] += timeMs;
    timing.total = timing.update + timing.fixedUpdate + timing.lateUpdate;
    this.recordServerSystemTiming(systemName, timeMs);

    // Update rolling average
    let avgData = this._systemTimingAverages.get(systemName);
    if (!avgData) {
      avgData = { samples: [], avg: 0 };
      this._systemTimingAverages.set(systemName, avgData);
    }
  }

  /**
   * Finalize system timing averages at end of frame
   */
  private finalizeSystemTimings(): void {
    for (const [name, timing] of this._systemTimings) {
      let avgData = this._systemTimingAverages.get(name);
      if (!avgData) {
        avgData = { samples: [], avg: 0 };
        this._systemTimingAverages.set(name, avgData);
      }
      avgData.samples.push(timing.total);
      if (avgData.samples.length > this._maxTimingSamples) {
        avgData.samples.shift();
      }
      avgData.avg =
        avgData.samples.reduce((a, b) => a + b, 0) / avgData.samples.length;
    }

    if (this.isServer) {
      for (const [name, durationMs] of this._serverSystemFrameTotals) {
        let histogram = this._serverSystemTimingHistograms.get(name);
        if (!histogram) {
          histogram = new DurationHistogram();
          this._serverSystemTimingHistograms.set(name, histogram);
        }
        histogram.record(durationMs);
      }
    }
  }

  private recordServerSystemTiming(systemName: string, timeMs: number): void {
    if (!this.isServer || !this._measureSystemTiming) return;
    this._serverSystemFrameTotals.set(
      systemName,
      (this._serverSystemFrameTotals.get(systemName) ?? 0) + timeMs,
    );
  }

  /**
   * Clear per-frame timing data (called at start of each tick)
   */
  private clearFrameTimings(): void {
    for (const timing of this._systemTimings.values()) {
      timing.update = 0;
      timing.fixedUpdate = 0;
      timing.lateUpdate = 0;
      timing.total = 0;
    }
    this._serverSystemFrameTotals.clear();
  }

  /** Pre-tick phase: Initialize performance monitoring */
  private preTick(): void {
    // Clear per-frame timing data
    if (this._measureSystemTiming) {
      this.clearFrameTimings();
    }

    for (const system of this.systems) {
      if (this.isServer) {
        const _t = performance.now();
        system.preTick();
        const _e = performance.now() - _t;
        this.recordServerSystemTiming(this._getSystemName(system), _e);
        if (_e > 20) {
          console.warn(
            `[World.tick] system.preTick "${this._getSystemName(system)}" took ${_e.toFixed(0)}ms`,
          );
        }
      } else {
        system.preTick();
      }
    }
  }

  /**
   * Pre-fixed-update phase: Prepare for physics simulation
   * @param willFixedStep - Whether a fixed update will occur this frame
   */
  private preFixedUpdate(willFixedStep: boolean): void {
    for (const system of this.systems) {
      if (this.isServer) {
        const _t = performance.now();
        system.preFixedUpdate(willFixedStep);
        const _e = performance.now() - _t;
        this.recordServerSystemTiming(this._getSystemName(system), _e);
        if (_e > 20) {
          console.warn(
            `[World.tick] system.preFixedUpdate "${this._getSystemName(system)}" took ${_e.toFixed(0)}ms`,
          );
        }
      } else {
        system.preFixedUpdate(willFixedStep);
      }
    }
  }

  /**
   * Fixed update phase: Physics simulation at fixed timestep (30 FPS)
   * @param delta - Fixed timestep delta (always fixedDeltaTime)
   */
  private fixedUpdate(delta: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const item of this.hot) {
      if (item.fixedUpdate) {
        const result = item.fixedUpdate(delta);
        this.trackAsyncTickResult(
          "fixedUpdate",
          `hot:${item.constructor?.name || "anonymous"}`,
          result,
        );
      }
    }

    if (this._measureSystemTiming) {
      // Timed path: measure each system
      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        const start = performance.now();
        const result = system.fixedUpdate(delta);
        this.trackAsyncTickResult(
          "fixedUpdate",
          this._getSystemName(system),
          result,
        );
        const elapsed = performance.now() - start;
        const name = this._getSystemName(system);
        this.recordSystemTiming(name, "fixedUpdate", elapsed);
      }
    } else if (this.isServer) {
      // Server path: lightweight per-system timing to catch blockers
      for (const system of this.systems) {
        const _t = performance.now();
        const result = system.fixedUpdate(delta);
        this.trackAsyncTickResult(
          "fixedUpdate",
          this._getSystemName(system),
          result,
        );
        const _elapsed = performance.now() - _t;
        if (_elapsed > 20) {
          console.warn(
            `[World.tick] system.fixedUpdate "${this._getSystemName(system)}" took ${_elapsed.toFixed(0)}ms`,
          );
        }
      }
    } else {
      // Client fast path: no timing
      for (const system of this.systems) {
        const result = system.fixedUpdate(delta);
        this.trackAsyncTickResult(
          "fixedUpdate",
          this._getSystemName(system),
          result,
        );
      }
    }
  }

  /**
   * Post-fixed-update phase: Finalize physics step
   * @param delta - Fixed timestep delta
   */
  private postFixedUpdate(delta: number): void {
    for (const system of this.systems) {
      if (this.isServer && this._measureSystemTiming) {
        const start = performance.now();
        system.postFixedUpdate(delta);
        this.recordServerSystemTiming(
          this._getSystemName(system),
          performance.now() - start,
        );
      } else {
        system.postFixedUpdate(delta);
      }
    }
  }

  /**
   * Pre-update phase: Prepare for visual updates
   * @param alpha - Interpolation factor between physics steps
   */
  private preUpdate(alpha: number): void {
    for (const system of this.systems) {
      if (this.isServer) {
        const _t = performance.now();
        system.preUpdate(alpha);
        const _e = performance.now() - _t;
        this.recordServerSystemTiming(this._getSystemName(system), _e);
        if (_e > 20) {
          console.warn(
            `[World.tick] system.preUpdate "${this._getSystemName(system)}" took ${_e.toFixed(0)}ms`,
          );
        }
      } else {
        system.preUpdate(alpha);
      }
    }
  }

  /**
   * Update phase: Frame-rate dependent updates (rendering, input)
   * @param delta - Time since last frame in seconds
   * @param _alpha - Interpolation factor (unused but provided for consistency)
   */
  private update(delta: number, _alpha: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const item of this.hot) {
      const result = item.update(delta);
      this.trackAsyncTickResult(
        "update",
        `hot:${item.constructor?.name || "anonymous"}`,
        result,
      );
    }

    if (this._measureSystemTiming) {
      // Timed path: measure each system
      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        const start = performance.now();
        const result = system.update(delta);
        this.trackAsyncTickResult(
          "update",
          this._getSystemName(system),
          result,
        );
        const elapsed = performance.now() - start;
        const name = this._getSystemName(system);
        this.recordSystemTiming(name, "update", elapsed);
      }
    } else if (this.isServer) {
      // Server path: lightweight per-system timing to catch blockers
      for (const system of this.systems) {
        const _t = performance.now();
        const result = system.update(delta);
        this.trackAsyncTickResult(
          "update",
          this._getSystemName(system),
          result,
        );
        const _elapsed = performance.now() - _t;
        if (_elapsed > 20) {
          console.warn(
            `[World.tick] system.update "${this._getSystemName(system)}" took ${_elapsed.toFixed(0)}ms`,
          );
        }
      }
    } else {
      // Client fast path: no timing
      for (const system of this.systems) {
        const result = system.update(delta);
        this.trackAsyncTickResult(
          "update",
          this._getSystemName(system),
          result,
        );
      }
    }
  }

  /** Cached system name lookups for performance */
  private _systemNameCache = new Map<System, string>();

  /** Get system name with caching */
  private _getSystemName(system: System): string {
    let name = this._systemNameCache.get(system);
    if (!name) {
      // Find the registered name for this system
      for (const [key, sys] of this.systemsByName) {
        if (sys === system) {
          name = key;
          break;
        }
      }
      if (!name) {
        name = system.constructor.name;
      }
      this._systemNameCache.set(system, name);
    }
    return name;
  }

  /**
   * Post-update phase: Clean transforms after updates
   * @param delta - Time since last frame in seconds
   */
  private postUpdate(delta: number): void {
    for (const system of this.systems) {
      if (this.isServer && this._measureSystemTiming) {
        const start = performance.now();
        system.postUpdate(delta);
        this.recordServerSystemTiming(
          this._getSystemName(system),
          performance.now() - start,
        );
      } else {
        system.postUpdate(delta);
      }
    }
  }

  /**
   * Late update phase: Camera, UI that depends on transforms
   * @param delta - Time since last frame in seconds
   * @param _alpha - Interpolation factor (unused)
   */
  private lateUpdate(delta: number, _alpha: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const item of this.hot) {
      if (item.lateUpdate) {
        const result = item.lateUpdate(delta);
        this.trackAsyncTickResult(
          "lateUpdate",
          `hot:${item.constructor?.name || "anonymous"}`,
          result,
        );
      }
    }

    if (this._measureSystemTiming) {
      // Timed path: measure each system
      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        const start = performance.now();
        const result = system.lateUpdate(delta);
        this.trackAsyncTickResult(
          "lateUpdate",
          this._getSystemName(system),
          result,
        );
        const elapsed = performance.now() - start;
        const name = this._getSystemName(system);
        this.recordSystemTiming(name, "lateUpdate", elapsed);
      }
    } else {
      // Fast path: no timing
      for (const system of this.systems) {
        const result = system.lateUpdate(delta);
        this.trackAsyncTickResult(
          "lateUpdate",
          this._getSystemName(system),
          result,
        );
      }
    }
  }

  /**
   * Post-late-update phase: Final transform cleanup
   * @param delta - Time since last frame in seconds
   */
  private postLateUpdate(delta: number): void {
    // Iterate Set directly instead of Array.from to avoid allocation each frame
    for (const item of this.hot) {
      if (item.postLateUpdate) {
        item.postLateUpdate(delta);
      }
    }
    for (const system of this.systems) {
      if (this.isServer && this._measureSystemTiming) {
        const start = performance.now();
        system.postLateUpdate(delta);
        this.recordServerSystemTiming(
          this._getSystemName(system),
          performance.now() - start,
        );
      } else {
        system.postLateUpdate(delta);
      }
    }
  }

  /** Commit phase: Render on client, send network updates on server */
  private commit(): void {
    if (this.isServer) {
      for (const system of this.systems) {
        const _t = performance.now();
        system.commit();
        const _elapsed = performance.now() - _t;
        this.recordServerSystemTiming(this._getSystemName(system), _elapsed);
        if (_elapsed > 20) {
          console.warn(
            `[World.tick] system.commit "${this._getSystemName(system)}" took ${_elapsed.toFixed(0)}ms`,
          );
        }
      }
    } else {
      for (const system of this.systems) {
        system.commit();
      }
    }
  }

  /** Post-tick phase: Finalize performance monitoring */
  private postTick(): void {
    for (const system of this.systems) {
      if (this.isServer && this._measureSystemTiming) {
        const start = performance.now();
        system.postTick();
        this.recordServerSystemTiming(
          this._getSystemName(system),
          performance.now() - start,
        );
      } else {
        system.postTick();
      }
    }

    // Finalize system timing averages
    if (this._measureSystemTiming) {
      this.finalizeSystemTimings();
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Setup material for shadow receiving.
   * With WebGPU single directional light, this is mostly a no-op.
   * Materials receive shadows automatically when in the scene.
   *
   * @param material - Three.js material (no special setup needed for WebGPU)
   */
  setupMaterial = (_material: THREE.Material): void => {
    // No special setup needed for WebGPU single directional light shadows.
    // Materials receive shadows automatically based on mesh.receiveShadow.
  };

  /**
   * Register/Unregister HotReloadable Item
   *
   * Items in the 'hot' set get update() called every frame.
   * Used for entities and objects that need continuous updates (players, mobs, etc.)
   *
   * @param item - Object with update/fixedUpdate/lateUpdate methods
   * @param hot - true to add to hot set, false to remove
   */
  setHot(item: HotReloadable, hot: boolean): void {
    if (hot) {
      this.hot.add(item);
    } else {
      this.hot.delete(item);
    }
  }

  /**
   * Resolve Asset URL
   *
   * Converts asset:// URLs to actual URLs based on environment.
   * Supports multiple URL formats for maximum flexibility.
   *
   * URL Formats:
   * - asset://path → Uses assetsUrl (CDN) or assetsDir (local files)
   * - blob:... → Returns as-is (data URLs)
   * - http(s)://... → Returns as-is (absolute URLs)
   * - //domain/path → Prefixes with https:
   * - /path → Returns as-is (root-relative)
   * - domain/path → Prefixes with https://
   *
   * @param url - URL to resolve
   * @param allowLocal - If true, prefer assetsDir over assetsUrl (for server)
   * @returns Resolved URL
   */
  resolveURL(url: string, allowLocal?: boolean): string {
    if (!url) return url;
    url = url.trim();

    // Some persisted player records store shorthand avatar filenames like "ws-avatar.vrm".
    // Treat these as local avatar assets instead of mistaken bare hostnames.
    const legacyAvatarAliases: Record<string, string> = {
      "ws-avatar.vrm": "duel-candidates/duel-bandit.vrm",
      "avatar.vrm": "duel-candidates/duel-bandit.vrm",
    };
    const resolveLegacyAvatarFilename = (filename: string) =>
      legacyAvatarAliases[filename.toLowerCase()] ?? filename;

    const bareAvatarMatch = url.match(/^([A-Za-z0-9_.-]+\.vrm)([?#].*)?$/i);
    if (bareAvatarMatch) {
      const [, filenameRaw, suffix = ""] = bareAvatarMatch;
      const filename = resolveLegacyAvatarFilename(filenameRaw);
      url = `asset://avatars/${filename}${suffix}`;
    } else {
      const relativeAvatarMatch = url.match(
        /^(?:\.\/|\/)?(avatars\/[A-Za-z0-9_./-]+\.vrm)([?#].*)?$/i,
      );
      if (relativeAvatarMatch) {
        const [, relativePathRaw, suffix = ""] = relativeAvatarMatch;
        const relativePath = relativePathRaw.replace(
          /^avatars\/([^/]+\.vrm)$/i,
          (_match, filename: string) =>
            `avatars/${resolveLegacyAvatarFilename(filename)}`,
        );
        url = `asset://${relativePath}${suffix}`;
      }
    }

    // Blob URLs are already resolved
    if (url.startsWith("blob")) {
      return url;
    }

    // asset:// protocol - resolve based on environment
    if (url.startsWith("asset://")) {
      if (this.assetsDir && allowLocal) {
        // Server-side: Use local file path
        const assetsDir = this.assetsDir.endsWith("/")
          ? this.assetsDir
          : this.assetsDir + "/";
        return url.replace("asset://", assetsDir);
      } else if (this.assetsUrl) {
        // Client-side: Use CDN URL
        let finalAssetsUrl = this.assetsUrl;

        // Fallback: If assetsUrl points to a dead domain or production CDN that is failing,
        // fallback to the local origin's /game-assets/ directory (which Vite proxies to Fastify).
        if (
          typeof window !== "undefined" &&
          finalAssetsUrl.includes("assets.hyperia.club") &&
          window.location &&
          window.location.origin &&
          // Don't override if we are actually ON the production domain
          !window.location.hostname.includes("hyperia.club")
        ) {
          if (this._resolvedCdnFallback === undefined) {
            this._resolvedCdnFallback =
              (window as any).__CDN_URL ||
              `${window.location.origin}/game-assets`;
            console.warn(
              `[resolveURL] Origin is ${window.location.origin}, falling back from ${finalAssetsUrl} to local ${this._resolvedCdnFallback}`,
            );
          }
          finalAssetsUrl = this._resolvedCdnFallback!;
        }

        const assetsUrlStr = finalAssetsUrl.endsWith("/")
          ? finalAssetsUrl
          : finalAssetsUrl + "/";
        let resolved = url.replace("asset://", assetsUrlStr);
        // Cache-busting for localhost removed — IndexedDB handles persistence
        // and the server now uses short cache lifetimes for dev.
        return resolved;
      } else {
        if (!hasLoggedMissingAssetBase) {
          hasLoggedMissingAssetBase = true;
          console.error("resolveURL: no assetsUrl or assetsDir defined");
        }
        return url;
      }
    }

    // Absolute URLs with protocol
    if (url.match(/^https?:\/\//i)) {
      return url;
    }

    // Protocol-relative URLs
    if (url.startsWith("//")) {
      return `https:${url}`;
    }

    // Root-relative URLs
    if (url.startsWith("/")) {
      return url;
    }

    // Bare domain/path - assume HTTPS
    return `https://${url}`;
  }

  /**
   * Legacy injection method (no longer used).
   * Previously used for app runtime injection, now removed.
   */
  inject(_runtime: unknown): void {
    // No-op: apps system was removed
  }

  /**
   * Get Player by ID
   *
   * Convenience method that delegates to entities system.
   * If no ID provided, returns the local player.
   *
   * @param playerId - Optional player ID to fetch (accepts string or PlayerID)
   * @returns Player instance or null if not found
   */
  getPlayer(
    playerId?: string | import("../types/core/identifiers").PlayerID,
  ): Player | null {
    if (playerId) {
      // PlayerID is a branded string, safe to pass as string
      return this.entities.getPlayer(playerId as string);
    }
    return this.entities.getLocalPlayer();
  }

  // ============================================================================
  // LAW OF DEMETER HELPER METHODS
  // ============================================================================
  // These methods encapsulate deep property chain access to reduce coupling
  // between systems and improve testability.

  /**
   * Get a player's socket by their ID
   *
   * Encapsulates the network system lookup to avoid Law of Demeter violations.
   * Returns undefined if player is not connected or network system unavailable.
   *
   * @param playerId - The player ID to look up
   * @returns The player's socket or undefined if not found
   */
  getPlayerSocket(playerId: string): unknown | undefined {
    const network = this.getSystem("network");
    if (!network) return undefined;

    // Check for broadcastManager.getPlayerSocket (server-side pattern)
    const networkWithBroadcast = network as {
      broadcastManager?: {
        getPlayerSocket?: (id: string) => unknown;
      };
      sockets?: Map<string, unknown>;
    };

    if (networkWithBroadcast.broadcastManager?.getPlayerSocket) {
      return networkWithBroadcast.broadcastManager.getPlayerSocket(playerId);
    }

    // Fallback: iterate sockets map to find by player ID
    if (networkWithBroadcast.sockets) {
      for (const [, socket] of networkWithBroadcast.sockets) {
        const socketWithData = socket as { data?: { odaPlayerId?: string } };
        if (socketWithData.data?.odaPlayerId === playerId) {
          return socket;
        }
      }
    }

    return undefined;
  }

  /**
   * Get a player's display name by their ID
   *
   * Encapsulates the entity lookup with multiple fallback paths.
   * Returns "Unknown" if player not found.
   *
   * @param playerId - The player ID to look up
   * @returns The player's display name
   */
  getPlayerDisplayName(playerId: string): string {
    const player = this.entities.players?.get(playerId);
    if (!player) return "Unknown";

    // Try multiple property paths for name (different entity implementations)
    const playerWithName = player as {
      name?: string;
      characterName?: string;
      playerName?: string;
      data?: { name?: string };
    };

    return (
      playerWithName.name ||
      playerWithName.characterName ||
      playerWithName.playerName ||
      playerWithName.data?.name ||
      "Unknown"
    );
  }

  /**
   * Get a player's combat level by their ID
   *
   * Encapsulates the entity lookup with multiple fallback paths.
   * Returns 3 (minimum combat level) if player not found.
   *
   * @param playerId - The player ID to look up
   * @returns The player's combat level
   */
  getPlayerCombatLevel(playerId: string): number {
    const player = this.entities.players?.get(playerId);
    if (!player) return 3;

    // Try multiple property paths for combat level
    // Cast through unknown to avoid protected property conflict
    const playerWithLevel = player as unknown as {
      combatLevel?: number;
      data?: { combatLevel?: number };
      combat?: { combatLevel?: number };
    };

    return (
      playerWithLevel.combatLevel ||
      playerWithLevel.data?.combatLevel ||
      playerWithLevel.combat?.combatLevel ||
      3
    );
  }

  /**
   * Get All Players
   *
   * @returns Array of all player entities in the world
   */
  getPlayers(): Player[] {
    return this.entities?.getPlayers() || [];
  }

  /**
   * Perform Raycast
   *
   * Casts a ray through the physics world to detect hits.
   * Delegates to physics system.
   *
   * @param origin - Start position of ray
   * @param direction - Direction vector (should be normalized)
   * @param maxDistance - Maximum distance to check
   * @param layerMask - Bitmask of layers to check
   * @returns Hit information or null if no hit
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance?: number,
    layerMask?: number,
  ): RaycastHit | null {
    return (
      this.physics?.raycast(origin, direction, maxDistance, layerMask) || null
    );
  }

  /**
   * Create Layer Mask for Physics Queries
   *
   * Creates a bitmask for filtering physics raycasts/sweeps by layer.
   *
   * Example:
   * ```ts
   * const mask = world.createLayerMask('environment', 'player');
   * ```
   *
   * @param layers - Layer names to include in mask
   * @returns Bitmask for physics queries
   */
  createLayerMask(...layers: string[]): number {
    return this.physics?.createLayerMask(...layers) ?? 0;
  }

  /**
   * Get Current Game Time
   *
   * @returns Time in seconds since world started
   */
  getTime(): number {
    return this.time;
  }

  /**
   * Disconnect Network Connection
   *
   * Disconnects the network system gracefully before destroying the world.
   * This ensures proper cleanup of WebSocket connections and network resources.
   */
  async disconnect(): Promise<void> {
    if (this.network && this.network.disconnect) {
      await this.network.disconnect();
    }
  }

  /**
   * Destroy World and Cleanup
   *
   * Destroys all systems, clears event listeners, and resets state.
   * After calling destroy(), the world can be re-initialized if needed.
   *
   * Cleanup process:
   * 1. Destroy all systems (in any order)
   * 2. Clear systems arrays and hot set
   * 3. Unsubscribe all event listeners
   * 4. Reset initialization flag
   */
  destroy(): void {
    // Destroy all systems
    for (const system of this.systems) {
      system.destroy();
    }

    // Clear collision data
    if (this.collision instanceof CollisionMatrix) {
      this.collision.clear();
    }

    // Clear entity occupancy data
    if (this.entityOccupancy instanceof EntityOccupancyMap) {
      this.entityOccupancy.clear();
    }

    // Clear system references
    this.systems = [];
    this.hot.clear();

    // Cleanup EventBus subscriptions
    for (const map of this.__busListenerMap.values()) {
      for (const sub of map.values()) {
        sub.unsubscribe();
      }
    }
    this.__busListenerMap.clear();

    // Cleanup EventEmitter listeners
    this.removeAllListeners();

    // Allow re-initialization
    this._initialized = false;
  }

  // ============================================================================
  // EVENT SYSTEM OVERRIDES (EventEmitter → EventBus Bridge)
  // ============================================================================

  /**
   * Subscribe to an event
   *
   * String events are routed through EventBus for type safety.
   * Symbol events use the original EventEmitter.
   *
   * @param event - Event name or symbol
   * @param fn - Event handler function
   * @param _context - Optional context (unused, for compatibility)
   * @returns this for chaining
   *
   * @public
   */
  override on<T extends string | symbol>(
    event: T,
    fn: T extends keyof import("../types/events").EventMap
      ? (data: import("../types/events").EventMap[T]) => void
      : (...args: unknown[]) => void,
    _context?: unknown,
  ): this {
    if (typeof event === "string") {
      let mapForEvent = this.__busListenerMap.get(event);
      if (!mapForEvent) {
        mapForEvent = new Map();
        this.__busListenerMap.set(event, mapForEvent);
      }
      const sub = this.$eventBus.subscribe(event, (evt) => {
        (fn as (data: unknown) => void)(evt.data);
      });
      mapForEvent.set(fn as (...args: unknown[]) => void, sub);
      return this;
    }
    super.on(event, fn as (...args: unknown[]) => void, _context);
    return this;
  }

  /**
   * Unsubscribe from an event
   *
   * String events unsubscribe from EventBus.
   * Symbol events use the original EventEmitter.
   *
   * @param event - Event name or symbol
   * @param fn - Event handler function to remove
   * @param _context - Optional context (unused, for compatibility)
   * @param _once - Whether this was a once listener (unused, for compatibility)
   * @returns this for chaining
   *
   * @public
   */
  override off<T extends string | symbol>(
    event: T,
    fn?: T extends keyof import("../types/events").EventMap
      ? (data: import("../types/events").EventMap[T]) => void
      : (...args: unknown[]) => void,
    _context?: unknown,
    _once?: boolean,
  ): this {
    if (typeof event === "string") {
      if (!fn) {
        const mapForEvent = this.__busListenerMap.get(event);
        if (mapForEvent) {
          for (const sub of mapForEvent.values()) {
            sub.unsubscribe();
          }
          this.__busListenerMap.delete(event);
        }
        return this;
      }
      const mapForEvent = this.__busListenerMap.get(event);
      if (mapForEvent) {
        const sub = mapForEvent.get(fn as (...args: unknown[]) => void);
        if (sub) {
          sub.unsubscribe();
          mapForEvent.delete(fn as (...args: unknown[]) => void);
        }
        if (mapForEvent.size === 0) {
          this.__busListenerMap.delete(event);
        }
      }
      return this;
    }
    super.off(event, fn as (...args: unknown[]) => void, _context, _once);
    return this;
  }

  /**
   * Return the number of listeners registered for an event.
   *
   * String events are backed by the typed EventBus and tracked in
   * `__busListenerMap`, so relying on the base EventEmitter count returns false
   * negatives for world events.
   */
  override listenerCount(event: string | symbol): number {
    if (typeof event === "string") {
      const busListeners = this.__busListenerMap.get(event)?.size ?? 0;
      return busListeners + super.listenerCount(event);
    }
    return super.listenerCount(event);
  }

  /**
   * Emit an event
   *
   * String events are emitted through EventBus for type safety.
   * Symbol events use the original EventEmitter.
   *
   * @param event - Event name or symbol
   * @param args - Event arguments
   * @returns true if event had listeners
   *
   * @public
   */
  override emit<T extends string | symbol>(
    event: T,
    ...args: T extends keyof import("../types/events").EventMap
      ? [data: import("../types/events").EventMap[T]]
      : unknown[]
  ): boolean {
    if (typeof event === "string") {
      const [data] = args;
      this.$eventBus.emitEvent(
        event,
        (data as Record<string, unknown>) ?? {},
        "world",
      );
      return true;
    }
    return super.emit(event, ...args);
  }

  /**
   * Gets the EventBus for advanced event handling
   *
   * Use this to access type-safe event subscriptions and the request/response pattern.
   *
   * @returns The world's EventBus instance
   *
   * @example
   * ```typescript
   * const eventBus = world.getEventBus();
   * eventBus.subscribe(EventType.COMBAT_DAMAGE, (event) => {
   *   console.log('Damage:', event.data.damage);
   * });
   * ```
   *
   * @public
   */
  getEventBus(): EventBus {
    return this.$eventBus;
  }

  /**
   * Promise that resolves when all systems are loaded.
   * Can be overridden by createClientWorld to track async system loading.
   */
  systemsLoadedPromise: Promise<void> = Promise.resolve();
}
