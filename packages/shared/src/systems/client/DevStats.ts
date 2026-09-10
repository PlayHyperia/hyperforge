/**
 * DevStats.ts - Development Performance Monitoring System
 *
 * Provides real-time performance telemetry in dev mode:
 * - FPS counter with frame time
 * - Memory usage (if available)
 * - Draw calls, triangles, textures
 * - Per-system timing breakdown
 *
 * Displays as a stylish overlay in the top-left corner.
 * Toggle with \ (backslash) key or world.devStats.toggle()
 *
 * @client-only
 */

import type { World } from "../../core/World";
import type { WorldOptions } from "../../types";
import { System } from "../shared/infrastructure/System";
import { BIOMES } from "../../data/world-structure";
import type { TerrainSystem } from "../shared/world/TerrainSystem";
import type { WaterSystem } from "../shared/world/WaterSystem";
import { getTreeInstanceStats } from "../shared/world/ProcgenTreeCache";
import THREE from "../../extras/three/three";
import { isStreamingLikeViewport } from "../../runtime/clientViewportMode";
import {
  classifyStreamResourceCategory,
  StreamPerformanceTelemetry,
  type StreamingPerformanceSnapshot,
} from "./StreamPerformanceTelemetry";

/** Performance sample for rolling averages */
type FrameSample = {
  fps: number;
  frameTime: number;
  timestamp: number;
};

/** Per-system timing data */
type SystemTiming = {
  name: string;
  updateTime: number;
  fixedUpdateTime: number;
  samples: number[];
  avgTime: number;
};

/** Renderer info snapshot (matches WebGPURenderer.info structure) */
type RenderInfo = {
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
};

type StreamSceneComplexityContributor = {
  name: string;
  category: string;
  type: string;
  triangles: number;
  instances: number;
  visible: boolean;
};

type StreamSceneComplexitySnapshot = {
  schemaVersion: 1;
  capturedAt: number;
  objectCount: number;
  visibleObjectCount: number;
  triangles: number;
  visibleTriangles: number;
  categories: Array<{
    category: string;
    objectCount: number;
    visibleObjectCount: number;
    triangles: number;
    visibleTriangles: number;
  }>;
  topObjects: StreamSceneComplexityContributor[];
};

type StreamingTelemetryWindow = Window & {
  __HYPERIA_STREAM_RENDERER_HEALTH__?: {
    phase?: string | null;
  } | null;
  __HYPERIA_STREAM_PERFORMANCE__?: StreamingPerformanceSnapshot | null;
  __HYPERIA_RESET_STREAM_PERFORMANCE__?: () => boolean;
  __HYPERIA_GET_STREAM_SCENE_COMPLEXITY__?: () => StreamSceneComplexitySnapshot | null;
};

/**
 * DevStats System
 *
 * Lightweight performance monitoring for development.
 * Attaches to the renderer and tracks frame timing.
 */
export class DevStats extends System {
  // UI Elements
  private container: HTMLDivElement | null = null;
  private fpsElement: HTMLElement | null = null;
  private frameTimeElement: HTMLElement | null = null;
  private memoryElement: HTMLDivElement | null = null;
  private rendererElement: HTMLDivElement | null = null;
  private sceneElement: HTMLDivElement | null = null;
  private systemsElement: HTMLDivElement | null = null;
  private playerElement: HTMLDivElement | null = null;
  private biomeElement: HTMLDivElement | null = null;
  private timingElement: HTMLDivElement | null = null;
  private waterElement: HTMLDivElement | null = null;
  private treeElement: HTMLDivElement | null = null;
  private cullingElement: HTMLDivElement | null = null;
  private cullingDetailElement: HTMLDivElement | null = null;
  private tickHealthElement: HTMLDivElement | null = null;
  private showCullingDetails = false;

  // State
  private enabled = false;
  private visible = false;
  private lastFrameTime = 0;
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private currentFps = 0;
  private currentFrameTime = 0;
  private streamTelemetryEnabled = false;
  private streamSystemProfilingEnabled = false;
  private streamTelemetry: StreamPerformanceTelemetry | null = null;
  private streamResourceTimingObserver: PerformanceObserver | null = null;
  private lastStreamTelemetryPublish = 0;

  // Rolling samples for smooth display
  private frameSamples: FrameSample[] = [];
  private maxSamples = 60;

  // System timing
  private systemTimings = new Map<string, SystemTiming>();
  private measureSystems = false;
  private tickStartTime = 0;

  // Update frequency
  private updateInterval = 100; // ms
  private lastUIUpdate = 0;

  // Per-frame render stats (reset each frame for accurate counts)
  private frameDrawCalls = 0;
  private frameTriangles = 0;
  /** WebGPU exposes cumulative render calls and no renderer.info.reset(). */
  private previousCumulativeDrawCalls: number | null = null;

  // CPU/Render timing
  private renderStartTime = 0;
  private lastRenderTime = 0;
  private lastCpuTime = 0;
  private renderTimeSamples: number[] = [];
  private cpuTimeSamples: number[] = [];

  constructor(world: World) {
    super(world);
  }

  getDependencies() {
    return {
      required: ["graphics"],
      optional: [],
    };
  }

  override async init(options: WorldOptions): Promise<void> {
    // Check if dev mode (from env or options)
    const enableByDefault =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.search.includes("devstats=true"));

    this.enabled = enableByDefault;
    this.streamTelemetryEnabled = isStreamingLikeViewport();
    if (this.streamTelemetryEnabled) {
      this.streamTelemetry = new StreamPerformanceTelemetry(Date.now());
      const telemetryWindow = window as StreamingTelemetryWindow;
      telemetryWindow.__HYPERIA_STREAM_PERFORMANCE__ = null;
      telemetryWindow.__HYPERIA_RESET_STREAM_PERFORMANCE__ = () =>
        this.resetStreamingPerformanceTelemetry();
      telemetryWindow.__HYPERIA_GET_STREAM_SCENE_COMPLEXITY__ = () =>
        this.collectStreamSceneComplexity();
      this.setupStreamResourceTimingObserver();
      this.streamSystemProfilingEnabled =
        new URLSearchParams(window.location.search).get("streamProfile") ===
        "systems";
      if (this.streamSystemProfilingEnabled) {
        this.world.enableSystemTiming();
      }
    }
    this.lastFpsUpdate = performance.now();

    if (this.enabled && typeof document !== "undefined") {
      this.createUI();
      this.setupKeyboardToggle();
      this.setupDevHotkeys();
    }

    await super.init(options);
  }

  override start(): void {
    // Do not auto-show by default unless explicitly requested via URL
    if (
      this.enabled &&
      typeof window !== "undefined" &&
      window.location.search.includes("devstats=true")
    ) {
      this.show();
      // Auto-enable system timing in dev mode for immediate visibility
      this.enableSystemTiming();
    }
    super.start();
  }

  /**
   * Create the stats UI overlay
   */
  private createUI(): void {
    // Container
    this.container = document.createElement("div");
    this.container.id = "hyperia-dev-stats";
    this.container.style.cssText = `
      position: fixed;
      top: 12px;
      left: 12px;
      max-height: calc(100vh - 24px);
      overflow-y: auto;
      z-index: 99999;
      font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Monaco', monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #e0e0e0;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.92) 0%, rgba(25, 25, 35, 0.88) 100%);
      border: 1px solid rgba(100, 200, 255, 0.2);
      border-radius: 8px;
      padding: 10px 14px;
      min-width: 180px;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      pointer-events: none;
      user-select: none;
      display: none;
      transition: opacity 0.15s ease;
    `;

    // Header with FPS
    const header = document.createElement("div");
    header.style.cssText = `
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(100, 200, 255, 0.15);
    `;

    this.fpsElement = document.createElement("span");
    this.fpsElement.style.cssText = `
      font-size: 20px;
      font-weight: 700;
      color: #4ade80;
      text-shadow: 0 0 10px rgba(74, 222, 128, 0.3);
    `;
    this.fpsElement.textContent = "-- ";

    const fpsLabel = document.createElement("span");
    fpsLabel.style.cssText = `color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;`;
    fpsLabel.textContent = "FPS";

    this.frameTimeElement = document.createElement("span");
    this.frameTimeElement.style.cssText = `
      margin-left: auto;
      color: #94a3b8;
      font-size: 10px;
    `;
    this.frameTimeElement.textContent = "-- ms";

    header.appendChild(this.fpsElement);
    header.appendChild(fpsLabel);
    header.appendChild(this.frameTimeElement);
    this.container.appendChild(header);

    // Memory section
    this.memoryElement = document.createElement("div");
    this.memoryElement.style.cssText = `
      margin-bottom: 6px;
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.memoryElement);

    // Renderer info section
    this.rendererElement = document.createElement("div");
    this.rendererElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.rendererElement);

    // Scene stats section
    this.sceneElement = document.createElement("div");
    this.sceneElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.sceneElement);

    // Player position section
    this.playerElement = document.createElement("div");
    this.playerElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.playerElement);

    // Biome section
    this.biomeElement = document.createElement("div");
    this.biomeElement.style.cssText = `
      margin-bottom: 6px;
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.biomeElement);

    // CPU/GPU timing section
    this.timingElement = document.createElement("div");
    this.timingElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.timingElement);

    // Water/Reflection section
    this.waterElement = document.createElement("div");
    this.waterElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.waterElement);

    // Tree instancing section
    this.treeElement = document.createElement("div");
    this.treeElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.treeElement);

    // Server tick health section
    this.tickHealthElement = document.createElement("div");
    this.tickHealthElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.tickHealthElement);

    // Frustum culling section
    this.cullingElement = document.createElement("div");
    this.cullingElement.style.cssText = `
      margin-bottom: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 10px;
    `;
    this.container.appendChild(this.cullingElement);

    // Culling detail list (collapsible, initially hidden)
    this.cullingDetailElement = document.createElement("div");
    this.cullingDetailElement.style.cssText = `
      margin-top: 4px;
      max-height: 300px;
      overflow-y: auto;
      font-size: 9px;
      display: none;
    `;
    this.container.appendChild(this.cullingDetailElement);

    // Systems section (collapsible, initially hidden)
    this.systemsElement = document.createElement("div");
    this.systemsElement.style.cssText = `
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      color: #94a3b8;
      font-size: 9px;
      display: none;
      max-height: 400px;
      overflow-y: auto;
    `;
    this.container.appendChild(this.systemsElement);

    // Keybinds reference section
    const keybindsSection = document.createElement("div");
    keybindsSection.style.cssText = `
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(100, 200, 255, 0.15);
      font-size: 9px;
      line-height: 1.6;
    `;

    const keybindsHeader = document.createElement("div");
    keybindsHeader.style.cssText = `
      color: rgba(100, 200, 255, 0.7);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    `;
    keybindsHeader.textContent = "Debug Keybinds";
    keybindsSection.appendChild(keybindsHeader);

    const keybinds: Array<[string, string, string]> = [
      // [key, description, scope]
      ["F5 / \\", "Toggle this panel", "global"],
      ["S", "System timing breakdown", "panel"],
      ["C", "Culling details list", "panel"],
      ["B", "BFS path overlay", "panel"],
      ["W", "Walkable tile overlay", "panel"],
      ["P", "Pathfinding debug (buildings)", "global"],
      ["T", "Log triangle breakdown (console)", "global"],
      ["Delete", "Teleport to origin", "global"],
    ];

    for (const [key, desc, scope] of keybinds) {
      const row = document.createElement("div");
      row.style.cssText = `display: flex; justify-content: space-between; gap: 8px;`;

      const keySpan = document.createElement("span");
      keySpan.style.cssText = `
        color: #e2e8f0;
        background: rgba(100, 200, 255, 0.1);
        border: 1px solid rgba(100, 200, 255, 0.2);
        border-radius: 3px;
        padding: 0 4px;
        font-size: 9px;
        min-width: 36px;
        text-align: center;
        flex-shrink: 0;
      `;
      keySpan.textContent = key;

      const descSpan = document.createElement("span");
      descSpan.style.cssText = `color: #94a3b8; flex: 1;`;
      descSpan.textContent = desc;

      const scopeSpan = document.createElement("span");
      scopeSpan.style.cssText = `color: ${scope === "panel" ? "rgba(100, 200, 255, 0.4)" : "#555"}; font-size: 8px; flex-shrink: 0;`;
      scopeSpan.textContent = scope === "panel" ? "(panel)" : "";

      row.appendChild(keySpan);
      row.appendChild(descSpan);
      row.appendChild(scopeSpan);
      keybindsSection.appendChild(row);
    }

    this.container.appendChild(keybindsSection);

    // Copy button at the very bottom
    const footer = document.createElement("div");
    footer.style.cssText = `
      margin-top: 6px;
      padding-top: 4px;
      border-top: 1px solid rgba(100, 200, 255, 0.1);
      text-align: center;
    `;

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Stats";
    copyBtn.style.cssText = `
      background: rgba(100, 200, 255, 0.15);
      border: 1px solid rgba(100, 200, 255, 0.3);
      border-radius: 4px;
      color: #94a3b8;
      font-family: inherit;
      font-size: 9px;
      padding: 2px 8px;
      cursor: pointer;
      pointer-events: auto;
    `;
    copyBtn.addEventListener("click", () => {
      const text = this.getPlainTextStats();
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        copyBtn.style.color = "#4ade80";
        setTimeout(() => {
          copyBtn.textContent = "Copy Stats";
          copyBtn.style.color = "#94a3b8";
        }, 1500);
      });
    });
    footer.appendChild(copyBtn);

    this.container.appendChild(footer);

    // Enable pointer-events on hover so the panel can be scrolled,
    // but otherwise let clicks pass through to the game canvas.
    this.container.addEventListener("mouseenter", () => {
      if (this.container) this.container.style.pointerEvents = "auto";
    });
    this.container.addEventListener("mouseleave", () => {
      if (this.container) this.container.style.pointerEvents = "none";
    });

    document.body.appendChild(this.container);
  }

  /**
   * Setup keyboard toggle (F5 or backslash key)
   * F5 matches Minecraft's debug screen keybind
   * S toggles system timing display
   */
  private setupKeyboardToggle(): void {
    document.addEventListener("keydown", (e) => {
      // Prevent typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const isToggleKey =
        e.key === "F5" ||
        (e.key === "\\" && !e.ctrlKey && !e.metaKey && !e.altKey);

      if (isToggleKey) {
        e.preventDefault();
        this.toggle();
      }

      // S key toggles system timing (only when stats are visible)
      if (
        (e.key === "s" || e.key === "S") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        this.visible
      ) {
        e.preventDefault();
        if (this.measureSystems) {
          this.disableSystemTiming();
        } else {
          this.enableSystemTiming();
        }
      }

      // C key toggles culling details (only when stats are visible)
      if (
        (e.key === "c" || e.key === "C") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        this.visible
      ) {
        e.preventDefault();
        this.showCullingDetails = !this.showCullingDetails;
        if (this.cullingDetailElement) {
          this.cullingDetailElement.style.display = this.showCullingDetails
            ? "block"
            : "none";
        }
      }
    });
  }

  /**
   * Setup dev hotkeys (only in dev mode)
   * - Delete: Teleport player to origin (0, 0, 0)
   * - T: Log triangle breakdown to console
   */
  private setupDevHotkeys(): void {
    console.log("[DevStats] Setting up dev hotkeys (T = triangle breakdown)");
    document.addEventListener("keydown", (e) => {
      // Skip if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Delete key: Teleport to origin
      if (e.key === "Delete") {
        console.log("[DevStats] Delete key pressed - triggering teleport");
        e.preventDefault();
        this.teleportToOrigin();
      }

      // T key: Log triangle breakdown
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        this.logTriangleBreakdown();
      }
    });
  }

  /**
   * Log a detailed breakdown of triangles by object to the console
   * Press 'T' to trigger this
   */
  private logTriangleBreakdown(): void {
    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    const scene = stage?.scene;

    if (!scene) {
      console.warn("[DevStats] No scene found");
      return;
    }

    console.log("\n========== TRIANGLE BREAKDOWN ==========");

    type ObjectStats = {
      name: string;
      type: string;
      triangles: number;
      instances: number;
      visible: boolean;
    };

    const stats: ObjectStats[] = [];
    let totalTriangles = 0;
    let totalVisible = 0;

    scene.traverse((obj: THREE.Object3D) => {
      const mesh = obj as THREE.Mesh | THREE.InstancedMesh;
      if (!mesh.geometry) return;

      const geo = mesh.geometry;
      const indexCount = geo.index?.count ?? 0;
      const posCount = geo.attributes.position?.count ?? 0;
      const trisPerInstance = geo.index ? indexCount / 3 : posCount / 3;

      const isInstanced = "isInstancedMesh" in mesh && mesh.isInstancedMesh;
      const instanceCount = isInstanced
        ? (mesh as THREE.InstancedMesh).count
        : 1;
      const objTriangles = Math.floor(trisPerInstance * instanceCount);

      totalTriangles += objTriangles;
      if (mesh.visible) totalVisible += objTriangles;

      // Only track objects with significant triangles
      if (objTriangles >= 1000) {
        stats.push({
          name: obj.name || "(unnamed)",
          type: obj.type,
          triangles: objTriangles,
          instances: instanceCount,
          visible: mesh.visible,
        });
      }
    });

    // Sort by triangle count descending
    stats.sort((a, b) => b.triangles - a.triangles);

    // Log top 30 contributors
    console.log("TOP TRIANGLE CONTRIBUTORS (>1K triangles):");
    console.log("-------------------------------------------");
    stats.slice(0, 30).forEach((s, i) => {
      const visFlag = s.visible ? "✓" : "✗";
      const instStr = s.instances > 1 ? ` (${s.instances} instances)` : "";
      console.log(
        `${String(i + 1).padStart(2)}. ${visFlag} ${(s.triangles / 1000).toFixed(1).padStart(8)}K  ${s.name}${instStr} [${s.type}]`,
      );
    });

    console.log("-------------------------------------------");
    console.log(`TOTAL TRIANGULAR OBJECTS: ${stats.length}`);
    console.log(`TOTAL TRIANGLES: ${(totalTriangles / 1_000_000).toFixed(2)}M`);
    console.log(`VISIBLE TRIANGLES: ${(totalVisible / 1_000_000).toFixed(2)}M`);
    console.log("==========================================\n");
  }

  /**
   * Produce an on-demand, serializable render-cost inventory for production
   * stream verification. It is never traversed per frame; the verifier calls
   * the hook once at teardown so profiling cannot perturb cadence evidence.
   */
  private collectStreamSceneComplexity(): StreamSceneComplexitySnapshot | null {
    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    const scene = stage?.scene;
    if (!scene) return null;

    const contributors: StreamSceneComplexityContributor[] = [];
    const categoryTotals = new Map<
      string,
      {
        category: string;
        objectCount: number;
        visibleObjectCount: number;
        triangles: number;
        visibleTriangles: number;
      }
    >();
    let objectCount = 0;
    let visibleObjectCount = 0;
    let triangles = 0;
    let visibleTriangles = 0;

    scene.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh | THREE.InstancedMesh;
      const geometry = mesh.geometry;
      if (!geometry) return;
      const elementCount =
        geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
      const instances =
        "isInstancedMesh" in mesh && mesh.isInstancedMesh
          ? Math.max(0, Math.floor((mesh as THREE.InstancedMesh).count))
          : 1;
      const objectTriangles = Math.max(
        0,
        Math.floor((elementCount / 3) * instances),
      );
      let visible = true;
      let ancestor: THREE.Object3D | null = object;
      while (ancestor) {
        if (ancestor.visible === false) {
          visible = false;
          break;
        }
        ancestor = ancestor.parent;
      }
      const rawCategory =
        typeof mesh.userData?.type === "string"
          ? mesh.userData.type
          : object.name.split("_", 1)[0] || object.type;
      const category = rawCategory.slice(0, 80);
      const name = (object.name || "(unnamed)").slice(0, 160);
      const contributor = {
        name,
        category,
        type: object.type.slice(0, 80),
        triangles: objectTriangles,
        instances,
        visible,
      };
      contributors.push(contributor);
      objectCount += 1;
      triangles += objectTriangles;
      if (visible) {
        visibleObjectCount += 1;
        visibleTriangles += objectTriangles;
      }
      const totals = categoryTotals.get(category) ?? {
        category,
        objectCount: 0,
        visibleObjectCount: 0,
        triangles: 0,
        visibleTriangles: 0,
      };
      totals.objectCount += 1;
      totals.triangles += objectTriangles;
      if (visible) {
        totals.visibleObjectCount += 1;
        totals.visibleTriangles += objectTriangles;
      }
      categoryTotals.set(category, totals);
    });

    return {
      schemaVersion: 1,
      capturedAt: Date.now(),
      objectCount,
      visibleObjectCount,
      triangles,
      visibleTriangles,
      categories: [...categoryTotals.values()].sort(
        (left, right) =>
          right.visibleTriangles - left.visibleTriangles ||
          left.category.localeCompare(right.category),
      ),
      topObjects: contributors
        .sort(
          (left, right) =>
            Number(right.visible) - Number(left.visible) ||
            right.triangles - left.triangles ||
            left.name.localeCompare(right.name),
        )
        .slice(0, 40),
    };
  }

  /**
   * Teleport the local player to origin (0, 0, 0)
   * Sends a server command to perform the teleport authoritatively
   */
  private teleportToOrigin(): void {
    const player = this.world.getPlayer();
    if (!player) {
      console.warn("[DevStats] No player found to teleport");
      return;
    }

    console.log("[DevStats] Requesting server teleport to origin (0, 0, 0)");

    // Check if network is available
    const network = this.world.network;
    console.log("[DevStats] Network state:", {
      hasNetwork: !!network,
      isClient: network?.isClient,
      hasSend: !!(network as { send?: unknown })?.send,
    });

    // Send teleport command to server - server sends playerTeleport packet
    // which properly resets tile movement state on the client
    this.world.chat.command("/teleport 0 0 0");
    console.log("[DevStats] Command sent");
  }

  /**
   * Toggle stats visibility
   */
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Show stats overlay
   */
  show(): void {
    if (!this.container) {
      this.createUI();
    }
    if (this.container) {
      this.container.style.display = "block";
      this.visible = true;
    }
  }

  /**
   * Hide stats overlay
   */
  hide(): void {
    if (this.container) {
      this.container.style.display = "none";
      this.visible = false;
    }
  }

  /**
   * Enable system timing measurements (more detailed but slightly slower)
   */
  enableSystemTiming(): void {
    this.measureSystems = true;
    // Enable timing in World's tick loop
    this.world.enableSystemTiming();
    if (this.systemsElement) {
      this.systemsElement.style.display = "block";
    }
  }

  /**
   * Disable system timing measurements
   */
  disableSystemTiming(): void {
    this.measureSystems = false;
    // Disable timing in World's tick loop
    this.world.disableSystemTiming();
    if (this.systemsElement) {
      this.systemsElement.style.display = "none";
    }
  }

  private preCommitTime = 0;

  override preTick(): void {
    this.tickStartTime = performance.now();
  }

  override postLateUpdate(_delta: number): void {
    // Record time right before commit phase (render)
    this.preCommitTime = performance.now();
  }

  override postTick(): void {
    if (!this.enabled && !this.streamTelemetryEnabled) return;

    const now = performance.now();
    const frameWorkTime = Math.max(0, now - this.tickStartTime);
    const frameIntervalTime =
      this.lastFrameTime > 0 ? Math.max(0, now - this.lastFrameTime) : null;
    const frameTime = frameIntervalTime ?? frameWorkTime;

    // Calculate CPU vs render time
    // CPU time = time from tick start until commit phase
    // Render time = time spent in commit phase (render submission)
    const cpuTime = Math.max(0, this.preCommitTime - this.tickStartTime);
    const renderTime = Math.max(0, now - this.preCommitTime);

    // Store samples for averaging
    if (this.enabled) {
      this.cpuTimeSamples.push(cpuTime);
      this.renderTimeSamples.push(renderTime);
      if (this.cpuTimeSamples.length > this.maxSamples) {
        this.cpuTimeSamples.shift();
        this.renderTimeSamples.shift();
      }
    }
    this.lastCpuTime = cpuTime;
    this.lastRenderTime = renderTime;

    // Update frame counter
    this.frameCount++;

    // Calculate FPS every second
    if (now - this.lastFpsUpdate >= 1000) {
      this.currentFps = Math.round(
        (this.frameCount * 1000) / (now - this.lastFpsUpdate),
      );
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }

    // Capture per-frame render stats and reset for next frame
    this.updatePerFrameRenderStats();

    // Store the actual inter-frame cadence for the developer UI. CPU and
    // render-submission work are reported separately above.
    this.currentFrameTime = frameTime;
    if (this.enabled) {
      this.frameSamples.push({
        fps: this.currentFps,
        frameTime,
        timestamp: now,
      });

      // Trim old samples
      if (this.frameSamples.length > this.maxSamples) {
        this.frameSamples.shift();
      }
    }

    this.recordStreamPerformance({
      now,
      frameIntervalMs: frameIntervalTime,
      frameWorkMs: frameWorkTime,
      cpuMs: cpuTime,
      renderSubmitMs: renderTime,
    });

    // Update UI at fixed interval
    if (this.visible && now - this.lastUIUpdate >= this.updateInterval) {
      this.updateUI();
      this.lastUIUpdate = now;
    }

    this.lastFrameTime = now;
  }

  private recordStreamPerformance(input: {
    now: number;
    frameIntervalMs: number | null;
    frameWorkMs: number;
    cpuMs: number;
    renderSubmitMs: number;
  }): void {
    if (!this.streamTelemetryEnabled || !this.streamTelemetry) return;

    const win = window as StreamingTelemetryWindow;
    const rendererInfo = this.getRendererInfo();
    const graphics = this.world.graphics;
    const renderer = graphics?.renderer as
      { getPixelRatio?: () => number } | undefined;
    const width = graphics?.width ?? window.innerWidth;
    const height = graphics?.height ?? window.innerHeight;
    const devicePixelRatio =
      renderer?.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;

    this.streamTelemetry.record({
      phase: win.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase ?? null,
      frameIntervalMs: input.frameIntervalMs,
      frameWorkMs: input.frameWorkMs,
      cpuMs: input.cpuMs,
      renderSubmitMs: input.renderSubmitMs,
      drawCalls: rendererInfo?.drawCalls ?? 0,
      triangles: rendererInfo?.triangles ?? 0,
      textures: rendererInfo?.textures ?? 0,
      geometries: rendererInfo?.geometries ?? 0,
      systemTimings: this.streamSystemProfilingEnabled
        ? this.world.getSystemTimings()
        : undefined,
      observedAt: Date.now(),
      jsHeap: this.getJsHeapInfo(),
      viewport: { width, height, devicePixelRatio },
    });

    if (
      this.lastStreamTelemetryPublish === 0 ||
      input.now - this.lastStreamTelemetryPublish >= 1_000
    ) {
      win.__HYPERIA_STREAM_PERFORMANCE__ = this.streamTelemetry.snapshot();
      this.lastStreamTelemetryPublish = input.now;
    }
  }

  private setupStreamResourceTimingObserver(): void {
    if (
      !this.streamTelemetry ||
      typeof globalThis.PerformanceObserver === "undefined"
    ) {
      return;
    }

    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (entry.entryType !== "resource") continue;
          const resource = entry as PerformanceResourceTiming;
          const transferBytes = Math.max(0, Math.round(resource.transferSize));
          const encodedBodyBytes = Math.max(
            0,
            Math.round(resource.encodedBodySize),
          );
          const decodedBodyBytes = Math.max(
            0,
            Math.round(resource.decodedBodySize),
          );
          this.streamTelemetry?.recordResource({
            category: classifyStreamResourceCategory(
              resource.name,
              resource.initiatorType,
            ),
            durationMs: resource.duration,
            responseWaitMs: Math.max(
              0,
              resource.responseStart - resource.requestStart,
            ),
            transferBytes,
            encodedBodyBytes,
            decodedBodyBytes,
            // A non-empty decoded body with no wire bytes is the reliable
            // Resource Timing signal for a local memory/disk cache response.
            cacheHit: transferBytes === 0 && decodedBodyBytes > 0,
          });
        }
      });
      observer.observe({ type: "resource", buffered: true });
      this.streamTelemetry.enableResourceTimingCollection();
      this.streamResourceTimingObserver = observer;
    } catch {
      // Resource Timing is supplemental. Older browsers may expose the
      // constructor without accepting buffered resource observation.
      observer?.disconnect();
      this.streamResourceTimingObserver = null;
    }
  }

  /**
   * Capture per-frame render statistics and reset for next frame
   * Three.js renderer.info accumulates until reset() is called
   */
  private updatePerFrameRenderStats(): void {
    const graphics = this.world.graphics;
    if (!graphics?.renderer) return;

    const renderer = graphics.renderer as {
      info: {
        render: { triangles: number; calls: number };
        memory: { geometries: number; textures: number };
        reset?: () => void;
      };
    };

    const info = renderer.info;
    if (!info) return;

    const rawDrawCalls = Math.max(0, info.render.calls);
    const rawTriangles = Math.max(0, info.render.triangles);
    // WebGL supplies reset(); WebGPU currently does not and its call counter is
    // process-cumulative. Convert that cumulative counter to a per-frame delta
    // without changing the per-frame triangle value WebGPU already exposes.
    let rendererResetWorked = false;
    if (info.reset) {
      info.reset();
      rendererResetWorked = info.render.calls === 0;
    }
    if (rendererResetWorked) {
      this.frameDrawCalls = rawDrawCalls;
      this.previousCumulativeDrawCalls = null;
    } else if (this.previousCumulativeDrawCalls === null) {
      this.frameDrawCalls = 0;
      this.previousCumulativeDrawCalls = rawDrawCalls;
    } else {
      this.frameDrawCalls =
        rawDrawCalls >= this.previousCumulativeDrawCalls
          ? rawDrawCalls - this.previousCumulativeDrawCalls
          : rawDrawCalls;
      this.previousCumulativeDrawCalls = rawDrawCalls;
    }
    this.frameTriangles = rawTriangles;
  }

  /**
   * Update the UI elements with current stats
   */
  private updateUI(): void {
    if (!this.container) return;

    // FPS with color coding
    if (this.fpsElement) {
      const fps = this.currentFps;
      this.fpsElement.textContent = String(fps);

      // Color based on performance
      if (fps >= 55) {
        this.fpsElement.style.color = "#4ade80"; // Green
        this.fpsElement.style.textShadow = "0 0 10px rgba(74, 222, 128, 0.3)";
      } else if (fps >= 30) {
        this.fpsElement.style.color = "#fbbf24"; // Yellow
        this.fpsElement.style.textShadow = "0 0 10px rgba(251, 191, 36, 0.3)";
      } else {
        this.fpsElement.style.color = "#ef4444"; // Red
        this.fpsElement.style.textShadow = "0 0 10px rgba(239, 68, 68, 0.3)";
      }
    }

    // Frame time
    if (this.frameTimeElement) {
      const avgFrameTime = this.getAverageFrameTime();
      this.frameTimeElement.textContent = `${avgFrameTime.toFixed(1)} ms`;
    }

    // Memory info (if available)
    if (this.memoryElement) {
      const memory = this.getMemoryInfo();
      if (memory) {
        this.memoryElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Memory:</span>
            <span style="color: #e0e0e0;">${memory.usedMB.toFixed(0)} / ${memory.totalMB.toFixed(0)} MB</span>
          </div>
        `;
        this.memoryElement.style.display = "block";
      } else {
        this.memoryElement.style.display = "none";
      }
    }

    // Renderer info
    if (this.rendererElement) {
      const info = this.getRendererInfo();
      if (info) {
        this.rendererElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Draw calls:</span>
            <span style="color: #e0e0e0;">${info.drawCalls.toLocaleString()}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Triangles:</span>
            <span style="color: #e0e0e0;">${this.formatNumber(info.triangles)}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Textures:</span>
            <span style="color: #e0e0e0;">${info.textures}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Geometries:</span>
            <span style="color: #e0e0e0;">${info.geometries}</span>
          </div>
        `;
      }
    }

    // Scene info
    if (this.sceneElement) {
      const sceneInfo = this.getSceneInfo();
      if (sceneInfo) {
        this.sceneElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Objects:</span>
            <span style="color: #e0e0e0;">${this.formatNumber(sceneInfo.totalObjects)}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Lights:</span>
            <span style="color: #fbbf24;">${sceneInfo.lightCount}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Entities:</span>
            <span style="color: #e0e0e0;">${sceneInfo.entityCount}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Systems:</span>
            <span style="color: #e0e0e0;">${sceneInfo.systemCount}</span>
          </div>
        `;
      }
    }

    // Player position
    if (this.playerElement) {
      const player = this.world.getPlayer();
      if (player) {
        const pos = player.position;
        this.playerElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Position:</span>
            <span style="color: #60a5fa; font-family: monospace;">${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}</span>
          </div>
        `;
        this.playerElement.style.display = "block";

        // Update biome based on player position
        if (this.biomeElement) {
          const biomeInfo = this.getBiomeInfo(pos.x, pos.z);
          if (biomeInfo) {
            this.biomeElement.innerHTML = `
              <div style="display: flex; justify-content: space-between;">
                <span>Biome:</span>
                <span style="color: ${biomeInfo.color};">${biomeInfo.name}</span>
              </div>
            `;
            this.biomeElement.style.display = "block";
          } else {
            this.biomeElement.style.display = "none";
          }
        }
      } else {
        this.playerElement.style.display = "none";
        if (this.biomeElement) {
          this.biomeElement.style.display = "none";
        }
      }
    }

    // CPU/Render timing
    if (this.timingElement) {
      const avgCpu = this.getAverageCpuTime();
      const avgRender = this.getAverageRenderTime();
      // Color coding: green < 8ms, yellow 8-16ms, red > 16ms
      const cpuColor =
        avgCpu < 8 ? "#4ade80" : avgCpu < 16 ? "#fbbf24" : "#ef4444";
      const renderColor =
        avgRender < 8 ? "#4ade80" : avgRender < 16 ? "#fbbf24" : "#ef4444";
      this.timingElement.innerHTML = `
        <div style="display: flex; justify-content: space-between;">
          <span>CPU:</span>
          <span style="color: ${cpuColor};">${avgCpu.toFixed(1)} ms</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Render:</span>
          <span style="color: ${renderColor};">${avgRender.toFixed(1)} ms</span>
        </div>
      `;
    }

    // Water/Reflection info
    if (this.waterElement) {
      const waterInfo = this.getWaterInfo();
      if (waterInfo) {
        const reflectionColor = waterInfo.reflectionActive
          ? "#4ade80"
          : "#ef4444";
        const reflectionStatus = waterInfo.reflectionActive ? "ON" : "OFF";
        this.waterElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Reflection Cameras:</span>
            <span style="color: ${reflectionColor};">${waterInfo.activeReflectionCameras}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Reflection:</span>
            <span style="color: ${reflectionColor};">${reflectionStatus}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Water Meshes:</span>
            <span style="color: #e0e0e0;">${waterInfo.visibleWaterMeshes} / ${waterInfo.totalWaterMeshes}</span>
          </div>
        `;
        this.waterElement.style.display = "block";
      } else {
        this.waterElement.style.display = "none";
      }
    }

    // Tree instancing stats
    if (this.treeElement) {
      const treeStats = getTreeInstanceStats();
      if (treeStats && treeStats.totalInstances > 0) {
        // globalLeaves is optional in stats return type
        const globalLeaves = (treeStats as { globalLeaves?: { count: number } })
          .globalLeaves;
        this.treeElement.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span>Trees (Instanced):</span>
            <span style="color: #4ade80;">${treeStats.totalInstances}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Tree Draw Calls:</span>
            <span style="color: #4ade80;">${treeStats.drawCalls}</span>
          </div>
          ${
            globalLeaves
              ? `
          <div style="display: flex; justify-content: space-between;">
            <span>Global Leaves:</span>
            <span style="color: #4ade80;">${globalLeaves.count}</span>
          </div>
          `
              : ""
          }
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #64748b;">
            <span>LOD:</span>
            <span>L0:${treeStats.byLOD.lod0} L1:${treeStats.byLOD.lod1} L2:${treeStats.byLOD.lod2} Imp:${treeStats.byLOD.impostor}</span>
          </div>
        `;
        this.treeElement.style.display = "block";
      } else {
        this.treeElement.style.display = "none";
      }
    }

    // Server tick health
    if (this.tickHealthElement) {
      const tickHealth = (
        this.world as {
          tickHealth?: {
            currentTick: number;
            missedTicks: number;
            lateTicks: number;
            maxLateness: number;
            lastTickDuration: number;
            tickDurations?: {
              samples: number;
              average: number;
              p50: number;
              p95: number;
              p99: number;
              max: number;
            };
            isHealthy: boolean;
            phaseTimings?: { mobAI: number; mobMove: number; combat: number };
            eventLoopLag?: number;
            transport?: string;
            connections?: number;
            broadcastMs?: number;
            pubsubPublishes?: number;
          };
        }
      ).tickHealth;
      if (tickHealth) {
        const healthColor = tickHealth.isHealthy ? "#4ade80" : "#ef4444";
        const healthLabel = tickHealth.isHealthy ? "OK" : "DEGRADED";
        // Color tick duration: green < 300ms, yellow 300-500ms, red > 500ms
        const durationColor =
          tickHealth.lastTickDuration < 300
            ? "#4ade80"
            : tickHealth.lastTickDuration < 500
              ? "#fbbf24"
              : "#ef4444";
        const pt = tickHealth.phaseTimings;
        const phaseColor = (ms: number) =>
          ms < 50 ? "#4ade80" : ms < 150 ? "#fbbf24" : "#ef4444";
        const phaseRows = pt
          ? `
          <div style="display: flex; justify-content: space-between; margin-top: 4px; font-weight: 600;">
            <span>Phase Breakdown</span>
            <span></span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>  Mob AI:</span>
            <span style="color: ${phaseColor(pt.mobAI)};">${pt.mobAI}ms</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>  Mob Move:</span>
            <span style="color: ${phaseColor(pt.mobMove)};">${pt.mobMove}ms</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>  Combat:</span>
            <span style="color: ${phaseColor(pt.combat)};">${pt.combat}ms</span>
          </div>
        `
          : "";
        const transportLabel =
          tickHealth.transport === "uws"
            ? "uWS"
            : tickHealth.transport === "ws"
              ? "ws"
              : "—";
        const transportColor =
          tickHealth.transport === "uws" ? "#4ade80" : "#94a3b8";
        const broadcastColor =
          (tickHealth.broadcastMs ?? 0) < 5
            ? "#4ade80"
            : (tickHealth.broadcastMs ?? 0) < 20
              ? "#fbbf24"
              : "#ef4444";
        this.tickHealthElement.innerHTML = `
          <div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 4px;">
            <span>Server Tick</span>
            <span style="color: ${healthColor};">${healthLabel}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Transport:</span>
            <span style="color: ${transportColor}; font-weight: 600;">${transportLabel}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Connections:</span>
            <span style="color: #e0e0e0;">${tickHealth.connections ?? "—"}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Tick #:</span>
            <span style="color: #e0e0e0;">${tickHealth.currentTick}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Tick Duration:</span>
            <span style="color: ${durationColor};">${tickHealth.lastTickDuration}ms / 600ms</span>
          </div>
          ${
            tickHealth.tickDurations
              ? `<div style="display: flex; justify-content: space-between;">
            <span>Tick p50/p95/p99:</span>
            <span style="color: #e0e0e0;">${tickHealth.tickDurations.p50}/${tickHealth.tickDurations.p95}/${tickHealth.tickDurations.p99}ms</span>
          </div>`
              : ""
          }
          <div style="display: flex; justify-content: space-between;">
            <span>Late Ticks:</span>
            <span style="color: ${tickHealth.lateTicks > 0 ? "#fbbf24" : "#e0e0e0"};">${tickHealth.lateTicks}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Missed Ticks:</span>
            <span style="color: ${tickHealth.missedTicks > 0 ? "#ef4444" : "#e0e0e0"};">${tickHealth.missedTicks}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Max Lateness:</span>
            <span style="color: #e0e0e0;">${tickHealth.maxLateness}ms</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Broadcast:</span>
            <span style="color: ${broadcastColor};">${tickHealth.broadcastMs ?? "—"}ms</span>
          </div>
          ${
            tickHealth.pubsubPublishes !== undefined &&
            tickHealth.pubsubPublishes > 0
              ? `
          <div style="display: flex; justify-content: space-between;">
            <span>Publishes:</span>
            <span style="color: #4ade80;">${tickHealth.pubsubPublishes}</span>
          </div>
          `
              : ""
          }
          ${phaseRows}
          ${
            tickHealth.eventLoopLag !== undefined
              ? `
          <div style="display: flex; justify-content: space-between; margin-top: 4px;">
            <span>Event Loop Lag:</span>
            <span style="color: ${tickHealth.eventLoopLag < 50 ? "#4ade80" : tickHealth.eventLoopLag < 200 ? "#fbbf24" : "#ef4444"};">${tickHealth.eventLoopLag}ms</span>
          </div>
          `
              : ""
          }
        `;
        this.tickHealthElement.style.display = "block";
      } else {
        this.tickHealthElement.style.display = "none";
      }
    }

    // Frustum culling stats
    if (this.cullingElement) {
      const cullingInfo = this.getCullingInfo();
      if (cullingInfo) {
        const culledPercent =
          cullingInfo.totalVertices > 0
            ? (
                (cullingInfo.culledVertices / cullingInfo.totalVertices) *
                100
              ).toFixed(1)
            : "0.0";
        // Color based on culling effectiveness (green = good culling)
        const culledColor =
          parseFloat(culledPercent) > 30 ? "#4ade80" : "#fbbf24";

        this.cullingElement.innerHTML = `
          <div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 4px;">
            <span>Frustum Culling</span>
            <span style="color: ${culledColor};">${culledPercent}% culled</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Visible:</span>
            <span style="color: #4ade80;">${cullingInfo.visibleObjects} objs (${this.formatNumber(cullingInfo.visibleVertices)} verts)</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Culled:</span>
            <span style="color: #ef4444;">${cullingInfo.culledObjects} objs (${this.formatNumber(cullingInfo.culledVertices)} verts)</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>No Culling:</span>
            <span style="color: #fbbf24;">${cullingInfo.notCulledObjects} objs</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 2px; padding-top: 2px; border-top: 1px dashed rgba(100, 200, 255, 0.1);">
            <span>Total:</span>
            <span style="color: #e0e0e0;">${cullingInfo.totalObjects} objs (${this.formatNumber(cullingInfo.totalVertices)} verts)</span>
          </div>
        `;
        this.cullingElement.style.display = "block";

        // Update detail view if visible
        if (this.showCullingDetails && this.cullingDetailElement) {
          this.updateCullingDetails(cullingInfo.objects);
        }
      } else {
        this.cullingElement.style.display = "none";
      }
    }

    // System timings (if enabled)
    if (this.measureSystems && this.systemsElement) {
      this.updateSystemTimings();
    }
  }

  /**
   * Get average frame time from samples
   */
  private getAverageFrameTime(): number {
    if (this.frameSamples.length === 0) return 0;
    const sum = this.frameSamples.reduce((a, b) => a + b.frameTime, 0);
    return sum / this.frameSamples.length;
  }

  /**
   * Get average CPU time from samples
   */
  private getAverageCpuTime(): number {
    if (this.cpuTimeSamples.length === 0) return 0;
    const sum = this.cpuTimeSamples.reduce((a, b) => a + b, 0);
    return sum / this.cpuTimeSamples.length;
  }

  /**
   * Get average render time from samples
   * Note: This measures render submission time, not actual GPU execution time
   */
  private getAverageRenderTime(): number {
    if (this.renderTimeSamples.length === 0) return 0;
    const sum = this.renderTimeSamples.reduce((a, b) => a + b, 0);
    return sum / this.renderTimeSamples.length;
  }

  /**
   * Build a plain-text snapshot of all visible stats for clipboard copy.
   */
  private getPlainTextStats(): string {
    const lines: string[] = [];
    lines.push(`=== Hyperia DevStats ===`);
    lines.push(
      `FPS: ${this.currentFps}  Frame: ${this.getAverageFrameTime().toFixed(1)}ms`,
    );
    lines.push(
      `CPU: ${this.getAverageCpuTime().toFixed(1)}ms  Render: ${this.getAverageRenderTime().toFixed(1)}ms`,
    );

    const mem = this.getMemoryInfo();
    if (mem)
      lines.push(
        `Memory: ${mem.usedMB.toFixed(0)} / ${mem.totalMB.toFixed(0)} MB`,
      );

    const info = this.getRendererInfo();
    if (info) {
      lines.push(
        `Draw Calls: ${info.drawCalls}  Tris: ${info.triangles.toLocaleString()}`,
      );
      lines.push(`Textures: ${info.textures}  Geometries: ${info.geometries}`);
    }

    const scene = this.getSceneInfo();
    if (scene) {
      lines.push(
        `Objects: ${scene.totalObjects}  Lights: ${scene.lightCount}  Entities: ${scene.entityCount}  Systems: ${scene.systemCount}`,
      );
    }

    const player = this.world.getPlayer();
    if (player) {
      const pos = player.position;
      lines.push(
        `Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
      );
    }

    const tickHealth = (
      this.world as {
        tickHealth?: {
          currentTick: number;
          missedTicks: number;
          lateTicks: number;
          maxLateness: number;
          lastTickDuration: number;
          tickDurations?: {
            samples: number;
            average: number;
            p50: number;
            p95: number;
            p99: number;
            max: number;
          };
          isHealthy: boolean;
          phaseTimings?: { mobAI: number; mobMove: number; combat: number };
          eventLoopLag?: number;
          transport?: string;
          connections?: number;
          broadcastMs?: number;
          pubsubPublishes?: number;
        };
      }
    ).tickHealth;
    if (tickHealth) {
      lines.push(`--- Server Tick ---`);
      lines.push(
        `Health: ${tickHealth.isHealthy ? "OK" : "DEGRADED"}  Transport: ${tickHealth.transport ?? "—"}  Conns: ${tickHealth.connections ?? "—"}`,
      );
      lines.push(
        `Tick #${tickHealth.currentTick}  Duration: ${tickHealth.lastTickDuration}ms/600ms`,
      );
      if (tickHealth.tickDurations) {
        lines.push(
          `Tick p50/p95/p99: ${tickHealth.tickDurations.p50}/${tickHealth.tickDurations.p95}/${tickHealth.tickDurations.p99}ms (${tickHealth.tickDurations.samples} samples)`,
        );
      }
      lines.push(
        `Late: ${tickHealth.lateTicks}  Missed: ${tickHealth.missedTicks}  Max Lateness: ${tickHealth.maxLateness}ms`,
      );
      if (tickHealth.broadcastMs !== undefined) {
        lines.push(`Broadcast: ${tickHealth.broadcastMs}ms`);
      }
      if (
        tickHealth.pubsubPublishes !== undefined &&
        tickHealth.pubsubPublishes > 0
      ) {
        lines.push(`Publishes: ${tickHealth.pubsubPublishes}`);
      }
      if (tickHealth.phaseTimings) {
        const pt = tickHealth.phaseTimings;
        lines.push(
          `Phases: MobAI=${pt.mobAI}ms  MobMove=${pt.mobMove}ms  Combat=${pt.combat}ms`,
        );
      }
      if (tickHealth.eventLoopLag !== undefined) {
        lines.push(`Event Loop Lag: ${tickHealth.eventLoopLag}ms`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get memory usage info if available
   */
  private getMemoryInfo(): { usedMB: number; totalMB: number } | null {
    const memory = this.getJsHeapInfo();
    if (memory) {
      return {
        usedMB: memory.usedBytes / 1024 / 1024,
        totalMB: memory.totalBytes / 1024 / 1024,
      };
    }
    return null;
  }

  private getJsHeapInfo(): {
    usedBytes: number;
    totalBytes: number;
    limitBytes: number;
  } | null {
    // performance.memory is Chromium-only, which matches the production
    // capture browser. Other browsers report a deliberate null snapshot.
    const perf = globalThis.performance as globalThis.Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };
    if (!perf.memory) return null;
    return {
      usedBytes: perf.memory.usedJSHeapSize,
      totalBytes: perf.memory.totalJSHeapSize,
      limitBytes: perf.memory.jsHeapSizeLimit,
    };
  }

  /**
   * Get renderer statistics
   * Draw calls and triangles are per-frame (reset each frame)
   * Textures and geometries are current allocations in GPU memory
   */
  private getRendererInfo(): RenderInfo | null {
    const graphics = this.world.graphics;
    if (!graphics?.renderer) return null;

    const renderer = graphics.renderer as {
      info: {
        render: { triangles: number; calls: number };
        memory: { geometries: number; textures: number };
      };
    };

    const info = renderer.info;
    if (!info) return null;

    // frameDrawCalls and frameTriangles are captured before reset in updatePerFrameRenderStats
    // memory.textures and memory.geometries are current GPU allocations
    return {
      drawCalls: this.frameDrawCalls,
      triangles: this.frameTriangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }

  /**
   * Get biome information at world position
   */
  private getBiomeInfo(
    x: number,
    z: number,
  ): { name: string; color: string } | null {
    const terrainSystem = this.world.getSystem<TerrainSystem>("terrain");
    if (!terrainSystem) return null;

    const biomeId = terrainSystem.getBiomeAtPosition(x, z);
    const biomeData = BIOMES[biomeId];

    if (!biomeData) {
      return { name: biomeId, color: "#94a3b8" };
    }

    return {
      name: biomeData.name,
      color: biomeData.colorScheme.primary,
    };
  }

  /**
   * Get scene and world statistics
   */
  private getSceneInfo(): {
    totalObjects: number;
    entityCount: number;
    systemCount: number;
    lightCount: number;
  } | null {
    const stage = this.world.stage;
    if (!stage?.scene) return null;

    // Count scene objects and lights
    let totalObjects = 0;
    let lightCount = 0;
    stage.scene.traverse((obj) => {
      totalObjects++;
      if (obj instanceof THREE.Light) {
        lightCount++;
      }
    });

    // Entity and system counts
    const entityCount = this.world.entities?.items?.size ?? 0;
    const systemCount = this.world.systems?.length ?? 0;

    return {
      totalObjects,
      entityCount,
      systemCount,
      lightCount,
    };
  }

  /**
   * Get water system and reflection camera statistics
   */
  private getWaterInfo(): {
    activeReflectionCameras: number;
    reflectionActive: boolean;
    totalWaterMeshes: number;
    visibleWaterMeshes: number;
  } | null {
    const waterSystem = this.world.getSystem("water") as
      WaterSystem | undefined;
    if (!waterSystem) return null;

    return {
      activeReflectionCameras: waterSystem.activeReflectionCameraCount,
      reflectionActive: waterSystem.isReflectionActive,
      totalWaterMeshes: waterSystem.waterMeshCount,
      visibleWaterMeshes: waterSystem.visibleWaterMeshCount,
    };
  }

  /** Object info for culling stats */
  private cullingObjectInfo: Array<{
    name: string;
    type: string;
    vertices: number;
    instances: number;
    visible: boolean;
    frustumCulled: boolean;
  }> = [];

  /**
   * Get frustum culling statistics
   * Analyzes scene objects to determine which are visible vs culled
   */
  private getCullingInfo(): {
    totalObjects: number;
    visibleObjects: number;
    culledObjects: number;
    notCulledObjects: number;
    totalVertices: number;
    visibleVertices: number;
    culledVertices: number;
    objects: Array<{
      name: string;
      type: string;
      vertices: number;
      instances: number;
      visible: boolean;
      frustumCulled: boolean;
    }>;
  } | null {
    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    const scene = stage?.scene;

    if (!scene) return null;

    let totalObjects = 0;
    let visibleObjects = 0;
    let culledObjects = 0;
    let notCulledObjects = 0;
    let totalVertices = 0;
    let visibleVertices = 0;
    let culledVertices = 0;

    this.cullingObjectInfo.length = 0;

    scene.traverse((obj: THREE.Object3D) => {
      const mesh = obj as THREE.Mesh | THREE.InstancedMesh;
      if (!mesh.geometry) return;
      if (!mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh)
        return;

      const geo = mesh.geometry;
      const posCount = geo.attributes.position?.count ?? 0;
      if (posCount === 0) return;

      const isInstanced = "isInstancedMesh" in mesh && mesh.isInstancedMesh;
      const instanceCount = isInstanced
        ? (mesh as THREE.InstancedMesh).count
        : 1;
      const objVertices = posCount * instanceCount;

      totalObjects++;
      totalVertices += objVertices;

      // Check if object is frustum culled
      // An object is "frustum culled" if:
      // 1. frustumCulled property is true AND
      // 2. visible is false (meaning it was culled this frame)
      //
      // Objects with frustumCulled=false bypass frustum testing entirely
      const isFrustumCulled = mesh.frustumCulled;

      // visible property represents if object passed visibility checks
      // This includes frustum culling, layers, and parent visibility
      const isVisible = mesh.visible && this.isParentChainVisible(mesh);

      if (!isFrustumCulled) {
        // Object bypasses frustum culling
        notCulledObjects++;
        if (isVisible) {
          visibleVertices += objVertices;
          visibleObjects++;
        }
      } else if (isVisible) {
        // Object has frustum culling enabled and is visible
        visibleObjects++;
        visibleVertices += objVertices;
      } else {
        // Object has frustum culling enabled and is not visible (culled)
        culledObjects++;
        culledVertices += objVertices;
      }

      // Track significant objects (>500 verts) for detail view
      if (objVertices >= 500) {
        this.cullingObjectInfo.push({
          name: obj.name || "(unnamed)",
          type: obj.type,
          vertices: objVertices,
          instances: instanceCount,
          visible: isVisible,
          frustumCulled: isFrustumCulled,
        });
      }
    });

    // Sort by vertex count descending
    this.cullingObjectInfo.sort((a, b) => b.vertices - a.vertices);

    return {
      totalObjects,
      visibleObjects,
      culledObjects,
      notCulledObjects,
      totalVertices,
      visibleVertices,
      culledVertices,
      objects: this.cullingObjectInfo,
    };
  }

  /**
   * Check if all parents in the chain are visible
   */
  private isParentChainVisible(obj: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = obj.parent;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  /**
   * Update the detailed culling object list
   */
  private updateCullingDetails(
    objects: Array<{
      name: string;
      type: string;
      vertices: number;
      instances: number;
      visible: boolean;
      frustumCulled: boolean;
    }>,
  ): void {
    if (!this.cullingDetailElement) return;

    // Show top 25 objects by vertex count
    const displayObjects = objects.slice(0, 25);

    let html = `
      <div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid rgba(100, 200, 255, 0.15);">
        <span>Top Objects by Vertices</span>
        <span style="color: #64748b;">C to close</span>
      </div>
    `;

    for (const obj of displayObjects) {
      // Status indicator
      const visIcon = obj.visible ? "✓" : "✗";
      const visColor = obj.visible ? "#4ade80" : "#ef4444";
      const cullIcon = obj.frustumCulled ? "F" : "-";
      const cullColor = obj.frustumCulled ? "#60a5fa" : "#64748b";

      // Instance suffix
      const instStr = obj.instances > 1 ? ` ×${obj.instances}` : "";

      // Format name (truncate if too long)
      const displayName =
        obj.name.length > 20 ? obj.name.substring(0, 18) + "…" : obj.name;

      html += `
        <div style="display: flex; align-items: center; gap: 4px; margin: 2px 0; padding: 2px;">
          <span style="width: 14px; color: ${visColor}; font-weight: bold;">${visIcon}</span>
          <span style="width: 14px; color: ${cullColor}; font-size: 8px;" title="Frustum culled: ${obj.frustumCulled}">${cullIcon}</span>
          <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${obj.name} [${obj.type}]">${displayName}</span>
          <span style="color: #94a3b8; font-size: 8px;">${instStr}</span>
          <span style="width: 50px; text-align: right; color: ${obj.visible ? "#e0e0e0" : "#64748b"};">${this.formatNumber(obj.vertices)}</span>
        </div>
      `;
    }

    // Legend
    html += `
      <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(100, 200, 255, 0.1); color: #64748b; font-size: 8px;">
        <span style="color: #4ade80;">✓</span>=visible 
        <span style="color: #ef4444;">✗</span>=hidden 
        <span style="color: #60a5fa;">F</span>=frustum culled
      </div>
    `;

    this.cullingDetailElement.innerHTML = html;
  }

  /**
   * Update system timing display
   * Uses World's built-in system timing infrastructure
   */
  private updateSystemTimings(): void {
    if (!this.systemsElement) return;

    // Get system timings from World
    const timings = this.world.getSystemTimings();

    if (timings.length === 0) {
      this.systemsElement.innerHTML =
        '<div style="color: #666;">No system data (waiting...)</div>';
      return;
    }

    // Calculate total frame time from systems
    const totalSystemTime = timings.reduce((sum, t) => sum + t.avg, 0);

    // Header with total
    let html = `
      <div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(100, 200, 255, 0.1);">
        <span>Systems (${timings.length})</span>
        <span style="color: ${totalSystemTime > 16 ? "#ef4444" : totalSystemTime > 8 ? "#fbbf24" : "#4ade80"};">${totalSystemTime.toFixed(1)}ms</span>
      </div>
    `;

    // Show all systems with > 0.1ms avg, or top 15 if more
    const significantSystems = timings.filter((t) => t.avg > 0.05);
    const displaySystems = significantSystems.slice(0, 20);

    // Category labels based on timing
    const getCategory = (
      avgMs: number,
    ): { label: string; color: string; bgColor: string } => {
      if (avgMs >= 4)
        return {
          label: "SLOW",
          color: "#ef4444",
          bgColor: "rgba(239, 68, 68, 0.2)",
        };
      if (avgMs >= 2)
        return {
          label: "WARN",
          color: "#fbbf24",
          bgColor: "rgba(251, 191, 36, 0.2)",
        };
      if (avgMs >= 0.5)
        return {
          label: "OK",
          color: "#4ade80",
          bgColor: "rgba(74, 222, 128, 0.1)",
        };
      return { label: "", color: "#94a3b8", bgColor: "transparent" };
    };

    for (const sys of displaySystems) {
      const category = getCategory(sys.avg);
      // Bar width: 8ms = 100%
      const barWidth = Math.min(100, (sys.avg / 8) * 100);

      html += `
        <div style="display: flex; align-items: center; gap: 4px; margin: 3px 0; padding: 2px 4px; background: ${category.bgColor}; border-radius: 3px;">
          <span style="width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px;" title="${sys.name}">${sys.name}</span>
          <div style="flex: 1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
            <div style="width: ${barWidth}%; height: 100%; background: ${category.color}; transition: width 0.1s;"></div>
          </div>
          <span style="width: 45px; text-align: right; color: ${category.color}; font-weight: ${sys.avg >= 2 ? "600" : "400"};">${sys.avg.toFixed(2)}ms</span>
        </div>
      `;
    }

    // Show count of hidden systems
    const hiddenCount = significantSystems.length - displaySystems.length;
    if (hiddenCount > 0) {
      html += `<div style="color: #666; font-size: 8px; text-align: center; margin-top: 4px;">+${hiddenCount} more systems</div>`;
    }

    // Footer with frame budget indicator
    const frameBudget = 16.67; // 60fps
    const budgetUsed = (totalSystemTime / frameBudget) * 100;
    const budgetColor =
      budgetUsed > 100 ? "#ef4444" : budgetUsed > 75 ? "#fbbf24" : "#4ade80";

    html += `
      <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(100, 200, 255, 0.1); font-size: 9px;">
        <div style="display: flex; justify-content: space-between;">
          <span>Frame Budget (60fps):</span>
          <span style="color: ${budgetColor};">${budgetUsed.toFixed(0)}%</span>
        </div>
        <div style="height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 2px; overflow: hidden;">
          <div style="width: ${Math.min(100, budgetUsed)}%; height: 100%; background: ${budgetColor};"></div>
        </div>
      </div>
    `;

    this.systemsElement.innerHTML = html;
  }

  /**
   * Format large numbers with K/M suffixes
   */
  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + "M";
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + "K";
    }
    return num.toString();
  }

  /**
   * Record timing for a specific system
   * Can be called by other systems to report their timing
   */
  recordSystemTime(systemName: string, timeMs: number): void {
    if (!this.measureSystems) return;

    let timing = this.systemTimings.get(systemName);
    if (!timing) {
      timing = {
        name: systemName,
        updateTime: 0,
        fixedUpdateTime: 0,
        samples: [],
        avgTime: 0,
      };
      this.systemTimings.set(systemName, timing);
    }

    timing.samples.push(timeMs);
    if (timing.samples.length > 30) {
      timing.samples.shift();
    }
    timing.avgTime =
      timing.samples.reduce((a, b) => a + b, 0) / timing.samples.length;
  }

  /**
   * Get current FPS
   */
  getFps(): number {
    return this.currentFps;
  }

  /**
   * Get current frame time in ms
   */
  getFrameTime(): number {
    return this.currentFrameTime;
  }

  getStreamingPerformanceSnapshot(): StreamingPerformanceSnapshot | null {
    return this.streamTelemetry?.snapshot() ?? null;
  }

  /**
   * Begin a fresh, explicitly bounded stream-performance observation window.
   * Capture verification calls this only after the production scene is fully
   * admitted so cold asset work cannot be mislabeled as steady-state combat.
   */
  private resetStreamingPerformanceTelemetry(): boolean {
    if (!this.streamTelemetryEnabled || typeof window === "undefined") {
      return false;
    }
    this.streamTelemetry = new StreamPerformanceTelemetry(Date.now());
    if (this.streamResourceTimingObserver) {
      this.streamTelemetry.enableResourceTimingCollection();
    }
    this.lastStreamTelemetryPublish = 0;
    (window as StreamingTelemetryWindow).__HYPERIA_STREAM_PERFORMANCE__ = null;
    return true;
  }

  /**
   * Check if stats are currently visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  override destroy(): void {
    this.streamResourceTimingObserver?.disconnect();
    this.streamResourceTimingObserver = null;
    if (this.streamTelemetryEnabled && typeof window !== "undefined") {
      const telemetryWindow = window as StreamingTelemetryWindow;
      telemetryWindow.__HYPERIA_STREAM_PERFORMANCE__ = null;
      delete telemetryWindow.__HYPERIA_RESET_STREAM_PERFORMANCE__;
      delete telemetryWindow.__HYPERIA_GET_STREAM_SCENE_COMPLEXITY__;
    }
    if (this.streamSystemProfilingEnabled) {
      this.world.disableSystemTiming();
      this.streamSystemProfilingEnabled = false;
    }
    if (this.container && this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container = null;
    this.fpsElement = null;
    this.frameTimeElement = null;
    this.memoryElement = null;
    this.rendererElement = null;
    this.sceneElement = null;
    this.systemsElement = null;
    this.playerElement = null;
    this.biomeElement = null;
    this.timingElement = null;
    this.waterElement = null;
    this.treeElement = null;
    this.cullingElement = null;
    this.cullingDetailElement = null;
    this.cullingObjectInfo.length = 0;
    this.systemTimings.clear();
    super.destroy();
  }
}
