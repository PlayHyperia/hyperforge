/**
 * createClientWorld.ts - Client World Factory
 *
 * Creates and configures a World instance for client-side (browser) execution.
 * This factory function registers all client-specific systems in the correct order
 * to ensure proper dependency resolution and initialization.
 *
 * Architecture:
 * - Client receives authoritative state from server
 * - No client-side prediction or interpolation (server is authoritative)
 * - Client handles rendering, input, audio, and UI
 * - Uses WebGPU for graphics via three.js
 * - Interactive clients run local PhysX feedback validated by the server
 * - Streaming/spectator clients omit PhysX and render authoritative state only
 *
 * Systems Registered:
 * 1. Core Systems: ClientRuntime, Stage, ClientNetwork
 * 2. Media: ClientLiveKit (voice), ClientAudio, MusicSystem
 * 3. Rendering: ClientGraphics, Environment, ClientCameraSystem
 * 4. Input: ClientInput (keyboard, mouse, touch)
 * 5. UI: ClientInterface (preferences, UI state)
 * 6. Loading: ClientLoader (asset management)
 * 7. Physics: Physics (PhysX via WASM, interactive clients only)
 * 8. Terrain: TerrainSystem (heightmap rendering)
 * 9. Visual Effects: LODs, HealthBars, Particles, Wind
 * 10. Actions: ClientActions (executable actions from UI/keybinds)
 * 11. RPG Systems: All game logic systems (shared with server)
 *
 * Browser Integration:
 * - Exposes `window.world` for debugging and testing
 * - Exposes `window.THREE` for console access to three.js
 * - Exposes `window.Hyperia.CircularSpawnArea` for tests
 *
 * Usage:
 * ```typescript
 * const world = createClientWorld();
 * await world.init({
 *   assetsUrl: 'https://cdn.example.com/assets/',
 *   storage: localStorage
 * });
 * // Client is now running and ready to connect to server
 * ```
 *
 * Used by: Client package (packages/client/src/index.tsx)
 * References: World.ts, registerSystems() in SystemLoader.ts
 */

import { World } from "../core/World";
import { DataManager } from "../data/DataManager";
import { isCompactSculptProfile } from "../systems/shared/world/WorldTerrainProfile";
import { FrameBudgetManager } from "../utils/FrameBudgetManager";

// Core client systems
import { ClientActions } from "../systems/client/ClientActions";
import { ClientAudio } from "../systems/client/ClientAudio";
import { CombatAudioSystem } from "../systems/client/CombatAudioSystem";
import { ClientCameraSystem } from "../systems/client/ClientCameraSystem";
import { DevStats } from "../systems/client/DevStats";
import { PathfindingDebugSystem } from "../systems/client/PathfindingDebugSystem";
import { BFSPathDebugSystem } from "../systems/client/BFSPathDebugSystem";
import { WalkableTileDebugSystem } from "../systems/client/WalkableTileDebugSystem";
import { Environment } from "../systems/shared";
import { ClientGraphics } from "../systems/client/ClientGraphics";
import { ClientInput } from "../systems/client/ClientInput";
import { ClientLiveKit } from "../systems/client/ClientLiveKit";
import { ClientLoader } from "../systems/client/ClientLoader";
import { ClientNetwork } from "../systems/client/ClientNetwork";
import { ClientRuntime } from "../systems/client/ClientRuntime";
import { ClientInterface } from "../systems/client/ClientInterface";
import { MusicSystem } from "../systems/shared";
import { Stage } from "../systems/shared";

import * as THREE from "../extras/three/three";

// Terrain, vegetation, grass, towns, roads, POIs, buildings, and physics
import { TerrainSystem } from "../systems/shared";
import { TownSystem } from "../systems/shared";
import { POISystem } from "../systems/shared";
import { RoadNetworkSystem } from "../systems/shared";
import { VegetationSystem } from "../systems/shared";
import { ProceduralGrassSystem } from "../systems/shared";
import { ProceduralFlowerSystem } from "../systems/shared";
import { ProceduralDocks } from "../systems/shared";
import { BuildingRenderingSystem } from "../systems/shared";
import { ProceduralTownLandmarksSystem } from "../systems/shared";
import { Physics } from "../systems/shared";

// Tree cache pre-warming for faster world loading
import {
  prewarmCache as prewarmTreeCache,
  TREE_PRESETS,
} from "../systems/shared/world/ProcgenTreeCache";
import {
  initGLBTreeInstancer,
  destroyGLBTreeInstancer,
} from "../systems/shared/world/GLBTreeInstancer";
import {
  initGLBTreeBatchedInstancer,
  destroyGLBTreeBatchedInstancer,
} from "../systems/shared/world/GLBTreeBatchedInstancer";
import { clearProxyGeometryCache } from "../entities/world/visuals/TreeGLBVisualStrategy";
import {
  initPlaceholderInstancer,
  destroyPlaceholderInstancer,
} from "../systems/shared/world/PlaceholderInstancer";
import {
  initGLBResourceInstancer,
  destroyGLBResourceInstancer,
} from "../systems/shared/world/GLBResourceInstancer";

// PhysX loading - used to defer heavy work until WASM is loaded
import { waitForPhysX } from "../physics/PhysXManager";

// RPG systems are registered via SystemLoader to keep them modular
import { registerSystems } from "../systems/shared";
import { ParticleSystem } from "../systems/shared/presentation/ParticleSystem";

// Test utilities exposed to browser console
import { CircularSpawnArea } from "../utils/physics/CircularSpawnArea";
import { modelCache } from "../utils/rendering/ModelCache";

import type { StageSystem } from "../types/systems/system-interfaces";
import { LODs } from "../systems/shared";
import { HealthBars } from "../systems/client/HealthBars";
import { EquipmentVisualSystem } from "../systems/client/EquipmentVisualSystem";
import { registerCompactPreparationLodgeVisuals } from "../systems/client/CompactPreparationLodgeVisualsSystem";
import { ZoneVisualsSystem } from "../systems/client/ZoneVisualsSystem";
import { WaterfallVisualsSystem } from "../systems/client/WaterfallVisualsSystem";
import { BridgeSystem } from "../systems/shared/world/BridgeSystem";
// ResourceTileDebugSystem available for debugging: import { ResourceTileDebugSystem } from "../systems/client/ResourceTileDebugSystem";
import { ZoneDetectionSystem } from "../systems/shared/death/ZoneDetectionSystem";
import { InteractionRouter } from "../systems/client/interaction";
import { Particles } from "../systems/shared";
import { Wind } from "../systems/shared";
import { ClientTeleportEffectsSystem } from "../systems/client/ClientTeleportEffectsSystem";
import type { SystemConstructor } from "../systems/shared/infrastructure/System";
import { resolveClientViewportRuntimeProfile } from "./clientViewportMode";

/**
 * Window extension for browser testing and debugging.
 * Exposes world instance and THREE.js for console access.
 */
interface WindowWithWorld extends Window {
  world?: World;
  THREE?: typeof THREE;
  __HYPERIA_EMBEDDED__?: boolean;
  __HYPERIA_CONFIG__?: {
    mode?: string;
  };
}

function isInitTraceEnabled(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return new URLSearchParams(window.location.search).get("traceInit") === "1";
  } catch {
    return false;
  }
}

function removeSystem(world: World, key: string): void {
  const existingSystem = world.systemsByName.get(key);
  if (!existingSystem) return;

  world.systems = world.systems.filter((system) => system !== existingSystem);
  world.systemsByName.delete(key);
  delete (world as unknown as Record<string, unknown>)[key];
}

function replaceSystem(
  world: World,
  key: string,
  SystemClass: SystemConstructor,
): void {
  removeSystem(world, key);
  world.register(key, SystemClass);
}

/**
 * Creates and configures a client-side World instance.
 *
 * The client world handles rendering, input, audio, and UI while receiving
 * authoritative game state from the server. Interactive clients run local
 * physics feedback validated by the server; stream/spectator clients omit it.
 *
 * @returns A fully configured World instance ready for client initialization
 */
export function createClientWorld() {
  const world = new World();
  const viewportProfile = resolveClientViewportRuntimeProfile();
  // ============================================================================
  // FRAME BUDGET MANAGER
  // ============================================================================
  // Initialize frame budget manager for reducing main thread jank.
  // This tracks frame time and allows deferring heavy work when over budget.
  world.frameBudget = FrameBudgetManager.getInstance({
    targetFrameTime: 16.67, // 60 FPS default
    renderReserve: 4, // Reserve 4ms for GPU work
    useIdleCallbacks: true, // Use requestIdleCallback for deferred work
  });

  // ============================================================================
  // CLEAR MODEL CACHE
  // ============================================================================
  // Clear model cache on world creation to prevent stale HyperForge Nodes
  // from being returned instead of pure THREE.Object3D
  modelCache.resetAndVerify();

  // Clean up any previous instancer state from prior world
  destroyGLBTreeInstancer();
  destroyGLBTreeBatchedInstancer();
  clearProxyGeometryCache();
  destroyPlaceholderInstancer();
  destroyGLBResourceInstancer();

  // ============================================================================
  // BROWSER TEST UTILITIES
  // ============================================================================
  // Expose utilities to window immediately (before async RPG systems load)
  // This allows Playwright tests to access constructors synchronously

  if (typeof window !== "undefined") {
    const anyWin = window as unknown as {
      Hyperia?: Record<string, unknown>;
      world?: World;
    };
    anyWin.Hyperia = anyWin.Hyperia || {};
    anyWin.Hyperia.CircularSpawnArea = CircularSpawnArea;
    anyWin.world = world;
  }

  // ============================================================================
  // CORE CLIENT SYSTEMS
  // ============================================================================
  // Order matters! Systems are initialized in registration order.
  // Dependencies must be registered before systems that depend on them.

  // Lifecycle and networking
  world.register("client-runtime", ClientRuntime); // Client lifecycle, diagnostics
  replaceSystem(world, "stage", Stage); // Three.js scene graph root
  world.register("livekit", ClientLiveKit); // Voice chat client
  world.register("network", ClientNetwork); // WebSocket connection to server
  world.register("loader", ClientLoader); // Asset loading and caching

  // Rendering systems
  world.register("graphics", ClientGraphics); // WebGPU renderer
  world.register("environment", Environment); // Lighting, shadows, CSM

  // Dev tools (only active in dev mode)
  world.register("devStats", DevStats); // FPS counter and performance telemetry
  world.register("pathfindingDebug", PathfindingDebugSystem); // Press 'P' to toggle
  world.register("bfsPathDebug", BFSPathDebugSystem); // Press 'B' (with F5 open) to toggle
  world.register("walkableDebug", WalkableTileDebugSystem); // Press 'W' (with F5 open) to toggle

  // Audio systems
  world.register("audio", ClientAudio); // 3D spatial audio
  world.register("music", MusicSystem); // Background music player
  world.register("combat-audio", CombatAudioSystem); // Authoritative positional hit feedback

  // Input and interaction
  world.register("controls", ClientInput); // Keyboard, mouse, touch input
  world.register("actions", ClientActions); // Executable player actions

  // UI and preferences
  world.register("prefs", ClientInterface); // User preferences and UI state

  // Physics (local simulation, validated by server)
  // Streaming/spectator viewports skip physics entirely — they don't need
  // collision detection and PhysX WASM can crash in the Playwright capture
  // browser. RigidBody/Collider nodes already guard against missing PHYSX.
  if (viewportProfile.enableLocalPhysics) {
    replaceSystem(world, "physics", Physics);
  } else {
    // The World constructor registers a default PhysicsSystem whose init()
    // calls waitForPhysX() with a 120s timeout.  If we leave it registered
    // the entire init chain stalls waiting for PhysX WASM that will never
    // arrive.  Remove it so the init pipeline proceeds immediately.
    removeSystem(world, "physics");
  }

  // Interaction system - handles clicks, raycasting, context menus
  // MUST be registered before ClientCameraSystem which uses its RaycastService
  world.register("interaction", InteractionRouter);

  // Camera
  world.register("client-camera-system", ClientCameraSystem); // Camera controller

  // ============================================================================
  // TERRAIN SYSTEM
  // ============================================================================
  // Renders heightmap-based terrain with LOD

  world.register("terrain", TerrainSystem);
  if (viewportProfile.enableExplorationScenery) {
    world.register("bridges", BridgeSystem);
  }

  // ============================================================================
  // VEGETATION SYSTEM
  // ============================================================================
  // GPU-instanced exploration vegetation (trees, bushes, grass, rocks, flowers)
  // is part of the interactive world, but not the authored arena broadcast set.
  // It must be registered after terrain and before towns so it can respond to
  // terrain generation and flat-zone regeneration events. Stream/spectator
  // viewports retain DuelArenaVisualsSystem's deliberate set dressing while
  // avoiding world-scale procedural meshes that never contribute to the duel.
  if (viewportProfile.enableExplorationVegetation) {
    world.register("vegetation", VegetationSystem);
  } else {
    console.log(
      "[createClientWorld] Skipping exploration vegetation for stream/spectator viewport",
    );
  }

  // ============================================================================
  // TOWN AND ROAD SYSTEMS
  // ============================================================================
  // Procedural town generation with flatness-based placement
  // Road network connects towns using A* pathfinding with terrain costs
  // Roads are rendered via vertex coloring in the terrain shader
  // NOTE: Towns register flat zones which emit TERRAIN_TILE_REGENERATED events
  // that VegetationSystem receives to regenerate grass at correct heights

  if (viewportProfile.enableProceduralExplorationSystems) {
    world.register("towns", TownSystem);
    world.register("pois", POISystem);
  } else {
    // The arena-only broadcast uses explicit world-area/arena flat zones and
    // authoritative server movement. Generating the entire exploration world's
    // towns, building collision, and POIs blocks first paint without producing
    // any visible arena content.
    console.log(
      "[createClientWorld] Skipping procedural towns and POIs for stream/spectator viewport",
    );
  }
  // world.register("roads", RoadNetworkSystem);

  // ============================================================================
  // BUILDING RENDERING SYSTEM
  // ============================================================================
  // Procedural building mesh rendering for towns
  // Must be registered after towns system as it depends on town data
  // world.register("building-rendering", BuildingRenderingSystem);

  // ============================================================================
  // TOWN LANDMARKS SYSTEM
  // ============================================================================
  // Procedural town landmarks (fences, lampposts, wells, signposts)
  // Must be registered after towns and roads as it depends on both
  // TEMPORARILY DISABLED
  // world.register("town-landmarks", ProceduralTownLandmarksSystem);

  // ============================================================================
  // VISUAL EFFECTS SYSTEMS
  // ============================================================================
  // These systems enhance visual fidelity and user experience

  world.register("lods", LODs); // Level-of-detail mesh management
  // Nametags disabled - classic MMORPG pattern: names shown in right-click menu only
  world.register("healthbars", HealthBars); // Entity health bars
  world.register("equipment-visual", EquipmentVisualSystem); // Visual weapon/equipment attachment
  world.register("zone-detection", ZoneDetectionSystem); // Zone type detection (safe/pvp/wilderness)
  world.register("zone-visuals", ZoneVisualsSystem); // PvP zone ground overlays and warnings
  world.register("waterfall-visuals", WaterfallVisualsSystem); // River waterfall rendering
  // TEMPORARILY DISABLED - debugging terrain rendering
  // world.register("resource-tile-debug", ResourceTileDebugSystem); // Debug: shows resource tile occupancy
  world.register("particles", Particles); // Particle effects system
  world.register("particle", ParticleSystem); // GPU-instanced glow/fire particles
  world.register("wind", Wind); // Environmental wind effects
  world.register("teleport-effects", ClientTeleportEffectsSystem); // Teleportation animations

  // ============================================================================
  // GRASS SYSTEM
  // ============================================================================
  // GPU Procedural grass with heightmap sampling
  // TEMPORARILY DISABLED - performance optimization
  // world.register("grass", ProceduralGrassSystem);

  // ============================================================================
  // FLOWER SYSTEM
  // GPU Procedural flowers using SpriteNodeMaterial
  // Has its own lightweight heightmap fallback when grass system is disabled.
  // TEMPORARILY DISABLED - investigating spawn blocking issue
  // if (!isEmbeddedSpectatorMode()) {
  //   world.register("flowers", ProceduralFlowerSystem);
  // }

  // ============================================================================
  // DOCK SYSTEM
  // ============================================================================
  if (viewportProfile.enableExplorationScenery) {
    world.register("docks", ProceduralDocks);
  }

  // ============================================================================
  // THREE.JS SETUP
  // ============================================================================
  // Expose THREE.js to the stage system after a short delay
  // This ensures stage.scene is ready before we try to access it

  const setupStageWithTHREE = () => {
    const stageSystem = world.stage as unknown as StageSystem;
    if (stageSystem && stageSystem.scene) {
      stageSystem.THREE = THREE as unknown as StageSystem["THREE"];
      initGLBTreeInstancer(stageSystem.scene as unknown as THREE.Scene, world);
      initGLBTreeBatchedInstancer(
        stageSystem.scene as unknown as THREE.Scene,
        world,
      );
      initPlaceholderInstancer(stageSystem.scene as unknown as THREE.Scene);
      initGLBResourceInstancer(
        stageSystem.scene as unknown as THREE.Scene,
        world,
      );
    }
  };

  setTimeout(setupStageWithTHREE, 200);

  // ============================================================================
  // RPG GAME SYSTEMS (ASYNC)
  // ============================================================================
  // RPG systems are loaded asynchronously to avoid blocking world creation.
  // CRITICAL: Create a promise that tracks when registerSystems() completes
  // This ensures DataManager is initialized before world.init() is called

  let systemsLoadedResolve!: () => void;
  const systemsLoadedPromise = new Promise<void>((resolve) => {
    systemsLoadedResolve = resolve;
  });

  // Attach promise to world so GameClient can wait for it
  world.systemsLoadedPromise = systemsLoadedPromise;

  (async () => {
    try {
      const traceInit = isInitTraceEnabled();

      if (traceInit) {
        console.log("[createClientWorld] -> registerSystems");
      }
      await registerSystems(world, "client", {
        enableExplorationResourceNodes:
          viewportProfile.enableExplorationResourceNodes,
        enableExplorationWorldEntities:
          viewportProfile.enableExplorationWorldEntities,
      });
      // Authored compact paths are shared by terrain and grass in every viewport;
      // this does not activate procedural town/POI generation for broadcasts.
      if (isCompactSculptProfile(DataManager.getWorldTerrainProfile())) {
        world.register("roads", RoadNetworkSystem);
      }
      registerCompactPreparationLodgeVisuals(world);
      if (traceInit) {
        console.log("[createClientWorld] <- registerSystems");
      }

      if (viewportProfile.prewarmTreeCache) {
        // Pre-warm procgen tree cache AFTER PhysX is loaded (prevents WASM timeout)
        // Tree generation is CPU-intensive and can block WASM instantiation if run in parallel.
        // By waiting for PhysX first, we ensure critical physics initialization completes
        // before starting the heavy tree pre-warming work.
        // This runs async and doesn't block other init - trees will be ready when needed.
        (async () => {
          try {
            // Wait for PhysX to be loaded first (with generous timeout for retries)
            await waitForPhysX("TreePrewarm", 120000);
            console.log(
              "[createClientWorld] PhysX loaded, starting tree cache pre-warm...",
            );

            // Now safe to run heavy tree generation
            await prewarmTreeCache([...TREE_PRESETS]);
          } catch (err) {
            console.warn(
              "[createClientWorld] Tree cache pre-warm failed:",
              err,
            );
          }
        })();
      } else {
        console.log(
          "[createClientWorld] Skipping tree cache pre-warm and PhysX for stream/spectator viewport",
        );
        // The default physics system was removed above, arena visuals omit local
        // collision in this non-interactive mode, and movement remains entirely
        // server-authoritative. Loading the WASM anyway only adds cold-start
        // network/compile work and can stall the first broadcast frames.
      }

      // Mob impostor pre-warming disabled — VRM mobs use on-demand baking.

      // CRITICAL: Initialize newly registered systems
      const worldOptions = {
        storage: world.storage,
        assetsUrl: world.assetsUrl,
        assetsDir: world.assetsDir,
      };

      const equipmentSystem = world.getSystem("equipment");
      if (equipmentSystem && !equipmentSystem.isInitialized()) {
        if (traceInit) {
          console.log("[createClientWorld] -> init equipment");
        }
        await equipmentSystem.init(worldOptions);
        if (traceInit) {
          console.log("[createClientWorld] <- init equipment");
        }
      }

      const damageSplatSystem = world.getSystem("damage-splat");
      if (damageSplatSystem && !damageSplatSystem.isInitialized()) {
        if (traceInit) {
          console.log("[createClientWorld] -> init damage-splat");
        }
        await damageSplatSystem.init(worldOptions);
        if (traceInit) {
          console.log("[createClientWorld] <- init damage-splat");
        }
      }

      const duelCountdownSplat = world.getSystem("duel-countdown-splat");
      if (duelCountdownSplat && !duelCountdownSplat.isInitialized()) {
        if (traceInit) {
          console.log("[createClientWorld] -> init duel-countdown-splat");
        }
        await duelCountdownSplat.init(worldOptions);
        if (traceInit) {
          console.log("[createClientWorld] <- init duel-countdown-splat");
        }
      }

      const projectileRenderer = world.getSystem("projectile-renderer");
      if (projectileRenderer && !projectileRenderer.isInitialized()) {
        if (traceInit) {
          console.log("[createClientWorld] -> init projectile-renderer");
        }
        await projectileRenderer.init(worldOptions);
        if (traceInit) {
          console.log("[createClientWorld] <- init projectile-renderer");
        }
      }

      // Re-expose utilities after RPG systems load (in case they were cleared)
      const anyWin = window as unknown as {
        Hyperia?: Record<string, unknown>;
      };
      anyWin.Hyperia = anyWin.Hyperia || {};
      anyWin.Hyperia.CircularSpawnArea = CircularSpawnArea;

      // Update window.world and window.THREE references
      if (typeof window !== "undefined") {
        const windowWithWorld = window as WindowWithWorld;
        windowWithWorld.world = world;

        const stageSystem = world.stage as unknown as StageSystem;
        windowWithWorld.THREE =
          stageSystem.THREE as unknown as typeof windowWithWorld.THREE;
      }
    } catch (error) {
      console.error("[createClientWorld] Error loading RPG systems:", error);
      throw error;
    } finally {
      // Always resolve the promise, even if there was an error
      systemsLoadedResolve();
    }
  })();

  return world;
}
