import { System } from "../shared/infrastructure/System";
import * as THREE from "../../extras/three/three";
import { initYoga } from "../../extras/ui/yoga";
import type { World, WorldOptions } from "../../types";
import type { Entity } from "../../entities/Entity";
import type { Entities } from "../shared";
import {
  isStreamPageRoute,
  isStreamingLikeViewport,
  resolveStreamingRenderFrameRate,
} from "../../runtime/clientViewportMode";
import { StreamRenderFramePacer } from "./StreamRenderFramePacer";

// Pre-allocated temp objects to avoid allocations
const _diagnosticPos = new THREE.Vector3();

// Single worker instance shared across all ClientRuntime instances
let sharedWorker: Worker | null = null;
let sharedWorkerUrl: string | null = null;

// Optimized player search interface
interface PlayerEntity extends Entity {
  isLocal?: boolean;
  isPlayer: boolean;
  base?: THREE.Object3D & { visible: boolean; children: THREE.Object3D[] };
  avatar?: {
    position?: THREE.Vector3;
    visible?: boolean;
    parent: THREE.Object3D | null;
    vrm?: unknown;
    children?: THREE.Object3D[];
    traverse?(callback: (child: THREE.Object3D) => void): void;
  };
  avatarUrl?: string;
  capsule?: { getGlobalPose?(): { p: { x: number; y: number; z: number } } };
  moving?: boolean;
  clickMoveTarget?: { x: number; z: number };
}

type RuntimeWindowEnv = {
  env?: {
    PUBLIC_DISABLE_VISIBILITY_THROTTLE?: string;
  };
};

/**
 * Client Runtime System
 *
 * Manages client-side initialization, game loop, and diagnostics
 */
export class ClientRuntime extends System {
  // Diagnostics state
  private diagnosticsEnabled = false;
  private diagnosticsInterval = 5000; // Report every 5 seconds
  private lastDiagnosticTime = 0;
  private localPlayer: PlayerEntity | null = null;

  // Scene stats tracking
  private sceneStats = {
    totalObjects: 0,
    totalMeshes: 0,
    visibleMeshes: 0,
  };
  private disableVisibilityThrottle = false;
  private forcedTickInterval: ReturnType<typeof setInterval> | null = null;
  private readonly FORCED_TICK_INTERVAL_MS = 33; // ~30 FPS fallback for stream capture
  private streamRenderFramePacer: StreamRenderFramePacer | null = null;

  constructor(world: World) {
    super(world);

    // Only set window properties in development
    if (
      typeof window !== "undefined" &&
      process.env.NODE_ENV === "development"
    ) {
      type WindowWithDebug = { world?: World; THREE?: typeof THREE };
      (window as WindowWithDebug).world = world;
      (window as WindowWithDebug).THREE = THREE;
    }
  }

  async init(
    options: WorldOptions & {
      loadYoga?: Promise<void>;
      enableDiagnostics?: boolean;
    },
  ): Promise<void> {
    if (options.loadYoga) {
      await options.loadYoga;
    }
    initYoga();

    this.diagnosticsEnabled = options.enableDiagnostics ?? false;
  }

  start() {
    this.streamRenderFramePacer = isStreamingLikeViewport()
      ? new StreamRenderFramePacer(resolveStreamingRenderFrameRate())
      : null;
    // Start render loop
    if (this.world.graphics?.renderer) {
      (
        this.world.graphics.renderer as {
          setAnimationLoop: (fn: (time?: number) => void | null) => void;
        }
      ).setAnimationLoop(this.onAnimationFrame);
    }

    this.disableVisibilityThrottle = this.shouldDisableVisibilityThrottle();

    // Setup visibility change handler unless stream/spectator explicitly opts out.
    if (!this.disableVisibilityThrottle) {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    } else {
      // Ensure we stay on the render loop in capture environments.
      this.onVisibilityChange();
    }

    // Listen for settings changes
    this.world.settings.on("change", this.onSettingsChange);

    // Start diagnostics if enabled
    if (this.diagnosticsEnabled) {
      setTimeout(() => this.findLocalPlayer(), 2000);
    }
  }

  update(delta: number): void {
    // Run diagnostics periodically
    if (this.diagnosticsEnabled && this.localPlayer) {
      this.lastDiagnosticTime += delta * 1000;
      if (this.lastDiagnosticTime >= this.diagnosticsInterval) {
        this.runDiagnostics();
        this.lastDiagnosticTime = 0;
      }
    }
  }

  private findLocalPlayer(): void {
    const entities = this.world.entities as Entities;

    // Direct iteration without allocations
    if (entities.items instanceof Map) {
      for (const [_id, entity] of entities.items) {
        const player = entity as PlayerEntity;
        if (player.isLocal && player.isPlayer) {
          this.localPlayer = player;
          return;
        }
      }
    }

    // Retry if not found
    if (!this.localPlayer) {
      setTimeout(() => this.findLocalPlayer(), 1000);
    }
  }

  private runDiagnostics(): void {
    if (!this.localPlayer) return;

    console.group("[ClientRuntime Diagnostics]");

    // Player position (reuse temp vector)
    _diagnosticPos.copy(this.localPlayer.position);

    // Base object status
    const base = this.localPlayer.base;
    if (base) {
      // Check scene hierarchy efficiently
      let parent = base.parent;
      let depth = 0;
      while (parent && depth < 10) {
        if (parent === this.world.stage?.scene) {
          break;
        }
        parent = parent.parent;
        depth++;
      }
    }

    // Avatar status
    // Camera position (reserved for future use)
    const _camera = this.world.camera;

    // Scene statistics (cache and update periodically)
    if (this.world.stage?.scene) {
      this.sceneStats.totalObjects = 0;
      this.sceneStats.totalMeshes = 0;
      this.sceneStats.visibleMeshes = 0;

      this.world.stage.scene.traverse((obj) => {
        this.sceneStats.totalObjects++;
        if (obj instanceof THREE.Mesh) {
          this.sceneStats.totalMeshes++;
          if (obj.visible) this.sceneStats.visibleMeshes++;
        }
      });
    }

    console.groupEnd();
  }

  private onSettingsChange = (changes: { title?: { value?: string } }) => {
    if (changes.title) {
      document.title = changes.title.value || "World";
    }
  };

  private onAnimationFrame = (time?: number) => {
    const now = time ?? performance.now();
    if (
      this.streamRenderFramePacer &&
      !this.streamRenderFramePacer.shouldRun(now)
    ) {
      return;
    }
    this.world.tick(now);
  };

  private onVisibilityChange = () => {
    if (this.disableVisibilityThrottle) {
      // In capture sessions Chromium may treat the page as hidden/occluded and
      // throttle rAF heavily. Use an interval-driven fallback while hidden.
      if (document.hidden) {
        if (this.world.graphics?.renderer) {
          (
            this.world.graphics.renderer as {
              setAnimationLoop: (fn: ((time?: number) => void) | null) => void;
            }
          ).setAnimationLoop(null);
        }
        this.startForcedTickLoop();
      } else {
        this.stopForcedTickLoop();
        if (this.world.graphics?.renderer) {
          (
            this.world.graphics.renderer as {
              setAnimationLoop: (fn: (time?: number) => void) => void;
            }
          ).setAnimationLoop(this.onAnimationFrame);
        }
      }
      return;
    }

    // Use shared worker for background ticking to save resources
    if (!sharedWorker) {
      const script = `
        const rate = 1000 / 5 // 5 FPS
        let intervalId = null;
        self.onmessage = (e) => {
          if (e.data === 'start' && !intervalId) {
            intervalId = setInterval(() => {
              self.postMessage(1);
            }, rate);
          }
          if (e.data === 'stop' && intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      `;
      const blob = new Blob([script], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      sharedWorkerUrl = url;
      sharedWorker = new Worker(url);
      sharedWorker.onmessage = () => {
        const time = performance.now();
        this.world.tick(time);
      };
    }

    if (document.hidden) {
      // Stop rAF
      if (this.world.graphics?.renderer) {
        (
          this.world.graphics.renderer as {
            setAnimationLoop: (fn: ((time?: number) => void) | null) => void;
          }
        ).setAnimationLoop(null);
      }
      // Start worker
      sharedWorker.postMessage("start");
    } else {
      // Stop worker
      sharedWorker.postMessage("stop");
      // Resume rAF
      this.streamRenderFramePacer?.reset();
      if (this.world.graphics?.renderer) {
        (
          this.world.graphics.renderer as {
            setAnimationLoop: (fn: (time?: number) => void) => void;
          }
        ).setAnimationLoop(this.onAnimationFrame);
      }
    }
  };

  private shouldDisableVisibilityThrottle(): boolean {
    if (typeof window === "undefined") return false;

    const parseTruthy = (raw: string | null | undefined): boolean => {
      if (!raw) return false;
      const normalized = raw.trim().toLowerCase();
      return (
        normalized === "1" ||
        normalized === "true" ||
        normalized === "yes" ||
        normalized === "on"
      );
    };

    try {
      const searchParams = new URLSearchParams(window.location.search);
      const page = (searchParams.get("page") || "").trim().toLowerCase();
      const mode = (searchParams.get("mode") || "").trim().toLowerCase();
      if (page === "stream" || mode === "spectator" || isStreamPageRoute()) {
        return true;
      }
      if (parseTruthy(searchParams.get("disableVisibilityThrottle"))) {
        return true;
      }
    } catch {
      // Ignore malformed URL/search parsing and fall through to env checks.
    }

    const runtimeEnv = (window as unknown as RuntimeWindowEnv).env;
    if (parseTruthy(runtimeEnv?.PUBLIC_DISABLE_VISIBILITY_THROTTLE)) {
      return true;
    }

    return false;
  }

  private startForcedTickLoop(): void {
    if (this.forcedTickInterval) return;
    this.forcedTickInterval = setInterval(() => {
      this.world.tick(performance.now());
    }, this.FORCED_TICK_INTERVAL_MS);
  }

  private stopForcedTickLoop(): void {
    if (!this.forcedTickInterval) return;
    clearInterval(this.forcedTickInterval);
    this.forcedTickInterval = null;
  }

  destroy() {
    if (this.world.graphics?.renderer) {
      (
        this.world.graphics.renderer as {
          setAnimationLoop: (fn: ((time?: number) => void) | null) => void;
        }
      ).setAnimationLoop(null);
    }
    // Stop background worker and revoke URL
    if (sharedWorker) {
      sharedWorker.postMessage("stop");
      (sharedWorker as unknown as { terminate: () => void }).terminate();
      if (sharedWorkerUrl) URL.revokeObjectURL(sharedWorkerUrl);
      sharedWorker = null;
      sharedWorkerUrl = null;
    }
    // Unsubscribe settings listener
    this.world.settings.off("change", this.onSettingsChange);
    if (!this.disableVisibilityThrottle) {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.stopForcedTickLoop();
    this.streamRenderFramePacer = null;
    this.localPlayer = null;
  }
}
