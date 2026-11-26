/**
 * PhysXManager.ts - Centralized PhysX Physics Engine Lifecycle Management
 *
 * This singleton manager handles loading and initialization of the PhysX WASM module.
 * PhysX is a high-performance physics engine used for collision detection, raycasting,
 * and character controllers in both browser and Node.js environments.
 *
 * Key Features:
 * - Singleton pattern ensures PhysX is only loaded once globally
 * - Async loading with promise-based waiting for dependent systems
 * - Environment detection (browser vs Node.js) for appropriate loading strategy
 * - State tracking (NOT_LOADED, LOADING, LOADED, FAILED)
 * - Dependency notification system for systems that need PhysX
 * - Automatic retry with exponential backoff on failure
 * - Configurable timeouts for different environments
 *
 * Usage:
 * ```ts
 * // Load PhysX (idempotent - safe to call multiple times)
 * await loadPhysX();
 *
 * // Wait for PhysX in a system
 * await waitForPhysX('MySystem', 10000); // 10 second timeout
 *
 * // Get PhysX module once loaded
 * const PHYSX = getPhysX();
 * ```
 *
 * Environment-Specific Loading:
 * - Browser: Loads via script tag from CDN at /web/physx-js-webidl.js
 * - Node.js: Loads WASM binary from assets/web/ or fetches from CDN with caching
 *
 * Referenced by: Physics system, Node-based colliders, Character controllers
 */

import { EventEmitter } from "eventemitter3";
import type { PhysXInfo, PhysXModule } from "../types/systems/physics";
import * as THREE from "../extras/three/three";
import loadPhysXScript from "./physx-script-loader";

/**
 * PhysX Loading States
 *
 * Tracks the current state of PhysX module loading.
 */
export enum PhysXState {
  /** PhysX has not been requested yet */
  NOT_LOADED = "not_loaded",

  /** PhysX WASM is currently loading */
  LOADING = "loading",

  /** PhysX is loaded and ready to use */
  LOADED = "loaded",

  /** PhysX loading failed with an error */
  FAILED = "failed",
}

/**
 * PhysXManager Class (Singleton)
 *
 * Manages PhysX lifecycle and provides async waiting API for dependent systems.
 * Uses EventEmitter to notify waiting systems when PhysX becomes available.
 *
 * The manager handles the complexity of:
 * - Environment detection (browser vs Node.js)
 * - WASM loading and initialization
 * - Foundation/Physics/Scene object creation
 * - Preventing duplicate loads
 * - Coordinating multiple systems waiting for PhysX
 */
class PhysXManager extends EventEmitter {
  private static instance: PhysXManager;
  private state: PhysXState = PhysXState.NOT_LOADED;
  private loadPromise: Promise<PhysXInfo> | null = null;
  private physxInfo: PhysXInfo | null = null;
  private error: Error | null = null;

  /** Map of system names to cleanup functions for systems waiting on PhysX */
  private waitingDependencies = new Map<string | symbol, () => void>();

  /**
   * Private constructor for singleton pattern.
   * Use PhysXManager.getInstance() instead.
   */
  private constructor() {
    super();

    // Set up THREE global for Node.js environments
    // PhysX may need THREE for certain utilities
    if (typeof window === "undefined" && !("THREE" in globalThis)) {
      Object.defineProperty(globalThis, "THREE", {
        value: THREE,
        writable: true,
        configurable: true,
      });
    }
  }

  /**
   * Get singleton instance of PhysXManager.
   * Creates the instance on first call.
   *
   * @returns The global PhysXManager instance
   */
  static getInstance(): PhysXManager {
    if (!PhysXManager.instance) {
      PhysXManager.instance = new PhysXManager();
    }
    return PhysXManager.instance;
  }

  /** @returns Current loading state */
  getState(): PhysXState {
    return this.state;
  }

  /** @returns true if PhysX is loaded and ready to use */
  isReady(): boolean {
    return this.state === PhysXState.LOADED && this.physxInfo !== null;
  }

  /** @returns PhysX info object (foundation, physics, etc.) if loaded */
  getPhysXInfo(): PhysXInfo | null {
    return this.physxInfo;
  }

  /**
   * Get Global PhysX Module
   *
   * Accesses the global PHYSX object set by the loading process.
   * Returns null if PhysX hasn't been loaded yet.
   *
   * @returns PhysX module instance or null
   */
  getPhysX(): PhysXModule | null {
    const g = globalThis as { PHYSX?: PhysXModule };
    return g.PHYSX ?? null;
  }

  /**
   * Load PhysX (Idempotent)
   *
   * Initiates PhysX loading if not already loaded or in progress.
   * Safe to call multiple times - returns existing promise if already loading.
   *
   * Loading Process:
   * 1. Detect environment (browser vs Node.js)
   * 2. Load WASM module using appropriate strategy
   * 3. Initialize PhysX foundation and physics objects
   * 4. Set global PHYSX object
   * 5. Notify all waiting dependencies
   *
   * Features:
   * - Automatic retry on failure (via script loader for browser)
   * - Proper state management on success/failure
   * - Event emission for dependent systems
   *
   * @returns Promise that resolves with PhysX foundation/physics objects
   * @throws Error if loading fails after all retries
   */
  async load(): Promise<PhysXInfo> {
    // If already loaded, return immediately
    if (this.state === PhysXState.LOADED && this.physxInfo) {
      return this.physxInfo;
    }

    // If currently loading, return the existing promise
    if (this.state === PhysXState.LOADING && this.loadPromise) {
      return this.loadPromise;
    }

    // If failed previously, allow retry
    if (this.state === PhysXState.FAILED) {
      console.log("[PhysXManager] Previous load failed, retrying...");
      this.state = PhysXState.NOT_LOADED;
      this.error = null;
      this.loadPromise = null;
    }

    // Start loading
    this.state = PhysXState.LOADING;
    this.emit("loading");

    // Create a new promise that wraps loadPhysXInternal with proper error handling
    this.loadPromise = (async () => {
      try {
        const info = await this.loadPhysXInternal();
        this.physxInfo = info;
        this.state = PhysXState.LOADED;
        this.emit("loaded", info);

        // Notify all waiting dependencies
        this.notifyWaitingDependencies();

        return info;
      } catch (error) {
        // State is already set to FAILED in loadPhysXInternal, but ensure it here too
        this.state = PhysXState.FAILED;
        this.error = error instanceof Error ? error : new Error(String(error));
        this.loadPromise = null; // Clear promise to allow retry

        console.error("[PhysXManager] Load failed:", this.error.message);
        this.emit("failed", this.error);

        throw this.error;
      }
    })();

    return this.loadPromise;
  }

  /**
   * Wait for PhysX to be Ready
   *
   * Async method for systems to wait until PhysX is loaded.
   * Automatically triggers loading if not already in progress.
   *
   * @param systemName - Name of calling system (for debugging and tracking)
   * @param timeout - Optional timeout in milliseconds (throws on timeout)
   * @returns Promise that resolves when PhysX is loaded
   * @throws Error if PhysX loading failed or timeout reached
   */
  async waitForPhysX(
    systemName: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<PhysXInfo> {
    if (signal?.aborted) throw signal.reason;
    // If already loaded, return immediately
    if (this.isReady()) {
      return this.physxInfo!; // Non-null assertion safe here because isReady() checks this.physxInfo !== null
    }

    // If failed, throw the error
    if (this.state === PhysXState.FAILED) {
      throw this.error || new Error("PhysX loading failed with unknown error");
    }

    return new Promise<PhysXInfo>((resolve, reject) => {
      // A caller owns its timer and listeners, never the shared module load.
      // Symbols distinguish concurrent consumers with the same diagnostic name.
      const owner = Symbol(systemName);
      const deadline = timeout ? performance.now() + timeout : undefined;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        this.off("loaded", onLoaded);
        this.off("failed", onFailed);
        signal?.removeEventListener("abort", onAbort);
        this.waitingDependencies.delete(owner);
      };
      const onLoaded = (info: PhysXInfo) => {
        if (settled) return;
        // A synchronous WASM step can delay timer delivery; completion still
        // must meet this caller's original allowance, not a renewed timeout.
        if (deadline !== undefined && performance.now() >= deadline) {
          onFailed(new Error(`PhysX load timeout for ${systemName}`));
          return;
        }
        settled = true;
        cleanup();
        resolve(info);
      };

      const onFailed = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => onFailed(signal?.reason);

      this.once("loaded", onLoaded);
      this.once("failed", onFailed);
      this.waitingDependencies.set(owner, cleanup);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeout) {
        timeoutId = setTimeout(() => {
          onFailed(new Error(`PhysX load timeout for ${systemName}`));
        }, timeout);
      }
      // Install the deadline and rejection handler before triggering shared
      // loading; neither a slow load nor another caller renews this allowance.
      if (this.state === PhysXState.NOT_LOADED)
        void this.load().catch(onFailed);
    });
  }

  /**
   * Register Callback for When PhysX is Ready
   *
   * Alternative to waitForPhysX() for callback-based code.
   * If PhysX is already loaded, callback is invoked immediately.
   *
   * @param systemName - Name of system registering callback
   * @param callback - Function to call when PhysX is ready
   */
  onReady(systemName: string, callback: (info: PhysXInfo) => void): void {
    if (this.isReady() && this.physxInfo) {
      // Already ready, call immediately
      callback(this.physxInfo);
    } else {
      // Wait for ready
      this.once("loaded", callback);
      this.waitingDependencies.set(systemName, () =>
        this.off("loaded", callback),
      );
    }
  }

  /**
   * Internal PhysX Loading Implementation
   *
   * Handles environment-specific loading logic:
   *
   * Browser Environment:
   * - Loads physx-js-webidl.js script tag from CDN
   * - Uses locateFile to find .wasm at CDN/web/physx-js-webidl.wasm
   * - Includes retry logic for resilience
   *
   * Node.js/Server Environment:
   * - Dynamically imports PhysXManager.server.ts (to avoid bundling Node modules)
   * - First tries loading WASM from local assets/web/ directory
   * - Falls back to fetching from CDN and caching to temp directory
   * - Provides binary directly to PhysX via wasmBinary option
   *
   * After loading, creates:
   * - PxFoundation (memory allocator and error callback)
   * - PxPhysics (main physics simulation object)
   *
   * @returns PhysX foundation and physics objects
   * @throws Error if loading fails or times out (90 seconds in browser, includes retries)
   */
  private async loadPhysXInternal(): Promise<PhysXInfo> {
    const isServer =
      typeof process !== "undefined" &&
      process.versions &&
      (process.versions.node || (process.versions as { bun?: string }).bun);
    const isBrowser =
      !isServer &&
      typeof window !== "undefined" &&
      typeof window.document !== "undefined";
    const isTest =
      typeof process !== "undefined" &&
      (process.env.NODE_ENV === "test" || process.env.VITEST);

    // Timeout is longer for browser to account for:
    // 1. Network latency fetching WASM file
    // 2. Heavy computation (tree generation) blocking main thread
    // 3. Retry attempts with exponential backoff
    // The script loader has its own internal timeout for WASM instantiation
    const LOAD_TIMEOUT_MS = isBrowser ? 90000 : 60000; // 90s browser, 60s server

    // Create timeout tracking for detecting stuck WASM loading
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const envType = isBrowser ? "browser" : "server";
        reject(
          new Error(
            `PhysX WASM loading timeout after ${LOAD_TIMEOUT_MS / 1000} seconds (${envType} environment)`,
          ),
        );
      }, LOAD_TIMEOUT_MS);
    });

    // Configure WASM loading
    const moduleOptions: Record<string, unknown> = {
      onAbort: (what: unknown) => {
        const errorText = String(what);
        const isNodeEnvError = errorText.includes(
          "node environment detected but not enabled at build time",
        );
        if (isNodeEnvError) {
          throw new Error(
            `PhysX WASM requires Node.js-compatible build. Current build only supports browser environments. ${errorText}`,
          );
        }
        throw new Error(`PhysX WASM aborted: ${errorText}`);
      },
    };

    // In Node.js environments, we need to handle WASM loading differently
    if (isServer || isTest) {
      // Dynamically import server-specific loading utilities
      // This keeps Node.js modules out of the client bundle
      // Use dynamic path construction to prevent bundler from trying to resolve this

      // Use a variable to prevent Vite/bundlers from statically analyzing and bundling
      // this server-only module into client builds. The @vite-ignore comment suppresses
      // Vite's dynamic import warnings.
      const serverPath = "./PhysXManager.server";
      const serverModule = await import(/* @vite-ignore */ serverPath);
      const wasmBuffer = await serverModule.loadPhysXWasmForNode();

      // Provide the WASM module directly
      moduleOptions.wasmBinary = wasmBuffer;
    } else if (isBrowser) {
      // For browser, the script loader handles CDN URL resolution and locateFile
      // We pass locateFile here as a fallback for options merging
      moduleOptions.locateFile = (wasmFileName: string) => {
        if (wasmFileName.endsWith(".wasm")) {
          // Use window.__CDN_URL if set by the application
          // Falls back to current origin (works for dev and production)
          const windowWithCdn = window as Window & { __CDN_URL?: string };
          const cdnBaseUrl = windowWithCdn.__CDN_URL || window.location.origin;
          // Use static version for cache key - only change this when PhysX WASM is updated
          // This allows browser caching between page loads
          const url = `${cdnBaseUrl}/web/${wasmFileName}?v=1.0.0`;
          console.log(
            `[PhysXManager] locateFile called for ${wasmFileName}, returning: ${url}`,
          );
          return url;
        }
        return wasmFileName;
      };
    }

    // Use appropriate loader based on environment
    let PHYSX: PhysXModule;

    // Wrap loading in Promise.race to properly handle timeout
    // The script loader has its own retry logic for browser environments
    const loadingPromise = (async () => {
      if (isBrowser) {
        // Browser environment - use script loader (has built-in retry)
        console.log(
          "[PhysXManager] Starting browser PhysX load with retry support...",
        );
        return await loadPhysXScript(moduleOptions);
      } else {
        // Node.js/server environment - use dynamic import for ESM compatibility
        console.log("[PhysXManager] Starting server PhysX load...");
        const physxModule = await import("@hyperforge/physx-js-webidl");
        const PhysXLoader = physxModule.default || physxModule;

        // Strong type assumption - PhysXLoader is a function that returns PhysXModule
        return await (
          PhysXLoader as (
            options: Record<string, unknown>,
          ) => Promise<PhysXModule>
        )(moduleOptions);
      }
    })();

    // Race between loading and timeout
    try {
      PHYSX = await Promise.race([loadingPromise, timeoutPromise]);
    } catch (error) {
      // Clear timeout if loading failed for other reasons
      if (timeoutId) clearTimeout(timeoutId);

      // Update state to FAILED
      this.state = PhysXState.FAILED;
      this.error = error instanceof Error ? error : new Error(String(error));
      this.emit("failed", this.error);

      throw error;
    }

    // Clear the timeout on successful load
    if (timeoutId) clearTimeout(timeoutId);

    console.log(
      "[PhysXManager] PhysX module loaded, initializing foundation...",
    );

    // Set global PHYSX for compatibility
    Object.defineProperty(globalThis, "PHYSX", {
      value: PHYSX,
      writable: true,
      configurable: true,
    });

    // Create PhysX foundation objects - PHYSX already has the correct type
    const physxWithConstants = PHYSX as PhysXModule & {
      PHYSICS_VERSION: number;
      CreateFoundation: (
        version: number,
        allocator: InstanceType<PhysXModule["PxDefaultAllocator"]>,
        errorCb: InstanceType<PhysXModule["PxDefaultErrorCallback"]>,
      ) => InstanceType<PhysXModule["PxFoundation"]>;
      CreatePhysics: (
        version: number,
        foundation: InstanceType<PhysXModule["PxFoundation"]>,
        tolerances: InstanceType<PhysXModule["PxTolerancesScale"]>,
      ) => InstanceType<PhysXModule["PxPhysics"]>;
    };

    const version = physxWithConstants.PHYSICS_VERSION;
    const allocator = new PHYSX.PxDefaultAllocator();
    const errorCb = new PHYSX.PxDefaultErrorCallback();
    const foundation = physxWithConstants.CreateFoundation(
      version,
      allocator,
      errorCb,
    );

    // Create physics instance for general use
    const tolerances = new PHYSX.PxTolerancesScale();
    const physics = physxWithConstants.CreatePhysics(
      version,
      foundation,
      tolerances,
    );

    console.log(
      "[PhysXManager] PhysX foundation and physics initialized successfully",
    );

    return { version, allocator, errorCb, foundation, physics };
  }

  /**
   * Notify Waiting Dependencies
   *
   * Called after PhysX is loaded to clean up waiting system registrations.
   */
  private notifyWaitingDependencies(): void {
    this.waitingDependencies.clear();
  }

  /**
   * Reset Manager State
   *
   * Resets the manager to NOT_LOADED state.
   * Primarily used for testing to clean up between test runs.
   */
  reset(): void {
    this.state = PhysXState.NOT_LOADED;
    this.loadPromise = null;
    this.physxInfo = null;
    this.error = null;
    this.waitingDependencies.clear();
    this.removeAllListeners();
  }
}

// ============================================================================
// SINGLETON INSTANCE AND CONVENIENCE FUNCTIONS
// ============================================================================

/** Global singleton instance of PhysXManager */
export const physxManager = PhysXManager.getInstance();

/**
 * Load PhysX (Convenience Function)
 *
 * Delegates to singleton instance.
 * Idempotent - safe to call multiple times.
 *
 * @returns Promise that resolves when PhysX is loaded
 */
export async function loadPhysX(): Promise<PhysXInfo> {
  return physxManager.load();
}

/**
 * Wait for PhysX to be Ready (Convenience Function)
 *
 * Delegates to singleton instance.
 *
 * @param systemName - Name of calling system
 * @param timeout - Optional timeout in milliseconds
 * @returns Promise that resolves when PhysX is ready
 */
export async function waitForPhysX(
  systemName: string,
  timeout?: number,
  signal?: AbortSignal,
): Promise<PhysXInfo> {
  return physxManager.waitForPhysX(systemName, timeout, signal);
}

/**
 * Get PhysX Module (Convenience Function)
 *
 * @returns Global PhysX module or null if not loaded
 */
export function getPhysX(): PhysXModule | null {
  return physxManager.getPhysX();
}

/**
 * Check if PhysX is Ready (Convenience Function)
 *
 * @returns true if PhysX is loaded and ready to use
 */
export function isPhysXReady(): boolean {
  return physxManager.isReady();
}
