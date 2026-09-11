import { isBoolean } from "lodash-es";
import * as THREE from "../../extras/three/three";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import { EventType } from "../../types/events";
import { ControlPriorities } from "../../systems/client/ControlPriorities";
import { storage } from "../../platform/shared/storage";
import StatsGL from "../../libs/stats-gl";
import Panel from "../../libs/stats-gl/panel";
import type { World, WorldOptions, ControlBinding, Entity } from "../../types";
import type { StreamingRenderPreferences } from "../../runtime/clientViewportMode";

// Pre-allocated temp objects
const _v3_1 = new THREE.Vector3();

// Constants
const PING_RATE = 1 / 2;
const TARGET_SVG = `
  <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="15" cy="15" r="13" stroke="#00FF7F" stroke-width="2" opacity="0.9"/>
    <circle cx="15" cy="15" r="3" fill="#00FF7F" opacity="0.9"/>
    <line x1="15" y1="0" x2="15" y2="6" stroke="#00FF7F" stroke-width="2" opacity="0.9"/>
    <line x1="15" y1="24" x2="15" y2="30" stroke="#00FF7F" stroke-width="2" opacity="0.9"/>
    <line x1="0" y1="15" x2="6" y2="15" stroke="#00FF7F" stroke-width="2" opacity="0.9"/>
    <line x1="24" y1="15" x2="30" y2="15" stroke="#00FF7F" stroke-width="2" opacity="0.9"/>
  </svg>
`;

// Interfaces
export interface ClientUIState {
  visible: boolean;
  active: boolean;
  app: Entity | null;
  pane: string | null;
}

export interface ClientPrefsData {
  ui?: number;
  actions?: boolean;
  stats?: boolean;
  dpr?: number;
  shadows?: string;
  postprocessing?: boolean;
  bloom?: boolean;
  colorGrading?: string;
  colorGradingIntensity?: number;
  /** Depth-based camera blur (classic fantasy MMORPG-style DoF) */
  depthBlur?: boolean;
  /** Depth blur intensity 0-1 */
  depthBlurIntensity?: number;
  /** Depth blur focus distance in world units */
  depthBlurDistance?: number;
  entityHighlighting?: boolean;
  music?: number;
  sfx?: number;
  voice?: number;
  voiceEnabled?: boolean;
  chatVisible?: boolean;
  waterReflections?: boolean;
  v?: number;
}

export type PrefsKey = keyof ClientPrefsData;
export type PrefsValue = ClientPrefsData[PrefsKey];

/**
 * Client Interface System
 *
 * Manages UI state, user preferences, stats display, and target indicators.
 * Provides centralized control over client-side interface elements and settings.
 */
export class ClientInterface extends SystemBase {
  // UI State
  state: ClientUIState = {
    visible: true,
    active: false,
    app: null,
    pane: null,
  };
  control: ControlBinding | null = null;

  // Preferences
  ui: number = 1;
  actions: boolean = true;
  stats: boolean = false;
  dpr: number = 1;
  shadows: string = "med";
  postprocessing: boolean = true;
  bloom: boolean = true;
  colorGrading: string = "none";
  colorGradingIntensity: number = 1;
  /** Depth-based camera blur (classic fantasy MMORPG-style DoF) - enabled by default */
  depthBlur: boolean = true;
  /** Depth blur intensity 0-1, default 0.85 for classic fantasy MMORPG-style heavy blur */
  depthBlurIntensity: number = 0.85;
  /** Depth blur focus distance in world units - how far before blur starts */
  depthBlurDistance: number = 60;
  entityHighlighting: boolean = true;
  music: number = 1;
  sfx: number = 1;
  voice: number = 1;
  voiceEnabled: boolean = false;
  chatVisible: boolean = true;
  waterReflections: boolean = true;
  v: number = 0;
  changes: Record<string, { prev: PrefsValue; value: PrefsValue }> | null =
    null;
  private streamingRenderPreferences: Readonly<StreamingRenderPreferences> | null =
    null;
  private persistedRenderPreferences: StreamingRenderPreferences | null = null;
  private preferencesInitialized = false;

  // Stats display
  statsPanel: {
    dom: HTMLElement;
    setMode?: (mode: number) => void;
    addPanel: (
      panel: { dom: HTMLElement },
      index?: number,
    ) => { dom: HTMLElement };
    begin: () => void;
    end: () => void;
    init?: (renderer: unknown, debug: boolean) => void;
    update?: () => void;
  } | null = null;
  statsActive: boolean = false;
  lastPingAt: number = 0;
  pingHistory: number[] = [];
  pingHistorySize: number = 30;
  maxPing: number = 0.01;
  ping: {
    dom: HTMLElement;
    update?: (
      value: number,
      max: number,
      graph: unknown[],
      index: number,
    ) => void;
    fg?: string;
  } | null = null; // Panel type not strictly typed

  // Target indicator
  targetGuide!: HTMLDivElement;
  targetVector: THREE.Vector3 | null = null;
  targetBounds: DOMRect | null = null;

  // DOM container
  uiContainer: HTMLElement | null = null;

  constructor(world: World) {
    super(world, {
      name: "client-interface",
      dependencies: { required: [], optional: [] },
      autoCleanup: true,
    });
  }

  async init(options: WorldOptions & { ui?: HTMLElement }): Promise<void> {
    this.uiContainer = options.ui || null;

    // Load preferences from storage (storage.get already returns parsed object)
    const stored = storage.get("prefs");
    if (stored) {
      const parsed = stored as ClientPrefsData;
      if (parsed.ui !== undefined) this.ui = parsed.ui;
      if (parsed.actions !== undefined) this.actions = parsed.actions;
      if (parsed.stats !== undefined) this.stats = parsed.stats;
      if (parsed.dpr !== undefined) this.dpr = parsed.dpr;
      if (parsed.shadows !== undefined) this.shadows = parsed.shadows;
      if (parsed.postprocessing !== undefined)
        this.postprocessing = parsed.postprocessing;
      if (parsed.bloom !== undefined) this.bloom = parsed.bloom;
      if (parsed.colorGrading !== undefined)
        this.colorGrading = parsed.colorGrading;
      if (parsed.colorGradingIntensity !== undefined)
        this.colorGradingIntensity = parsed.colorGradingIntensity;
      if (parsed.depthBlur !== undefined) this.depthBlur = parsed.depthBlur;
      if (parsed.depthBlurIntensity !== undefined)
        this.depthBlurIntensity = parsed.depthBlurIntensity;
      if (parsed.depthBlurDistance !== undefined)
        this.depthBlurDistance = parsed.depthBlurDistance;
      if (parsed.entityHighlighting !== undefined)
        this.entityHighlighting = parsed.entityHighlighting;

      if (parsed.chatVisible !== undefined)
        this.chatVisible = parsed.chatVisible;
      if (parsed.music !== undefined) this.music = parsed.music;
      if (parsed.sfx !== undefined) this.sfx = parsed.sfx;
      if (parsed.voice !== undefined) this.voice = parsed.voice;
      if (parsed.voiceEnabled !== undefined)
        this.voiceEnabled = parsed.voiceEnabled;
      if (parsed.waterReflections !== undefined)
        this.waterReflections = parsed.waterReflections;
      if (parsed.v !== undefined) this.v = parsed.v;
    }
    // onSetup runs before init. Stored ordinary-user preferences must not win
    // over the startup broadcast contract, nor be replaced by it on persist.
    if (this.streamingRenderPreferences && this.persistedRenderPreferences) {
      const parsed = stored as ClientPrefsData | null;
      for (const key of Object.keys(
        this.streamingRenderPreferences,
      ) as (keyof StreamingRenderPreferences)[]) {
        if (
          parsed &&
          Object.prototype.hasOwnProperty.call(parsed, key) &&
          parsed[key] !== undefined
        ) {
          Object.assign(this.persistedRenderPreferences, { [key]: this[key] });
        }
      }
      Object.assign(this, this.streamingRenderPreferences);
    }
    this.preferencesInitialized = true;
  }

  /** Startup-only, non-persistent render policy; it does not reload or create a renderer. */
  configureStreamingRenderPreferences(
    preferences: StreamingRenderPreferences,
  ): void {
    if (this.preferencesInitialized) {
      throw new Error(
        "Streaming render preferences must be configured before initialization",
      );
    }
    if (
      !Number.isFinite(preferences.dpr) ||
      preferences.dpr <= 0 ||
      preferences.dpr > 1
    ) {
      throw new Error("Invalid streaming render DPR");
    }
    if (!this.persistedRenderPreferences) {
      this.persistedRenderPreferences = {
        dpr: this.dpr,
        shadows: this.shadows,
        postprocessing: this.postprocessing,
        bloom: this.bloom,
        colorGrading: this.colorGrading,
        depthBlur: this.depthBlur,
        waterReflections: this.waterReflections,
        entityHighlighting: this.entityHighlighting,
      };
    }
    this.streamingRenderPreferences = Object.freeze({ ...preferences });
    Object.assign(this, this.streamingRenderPreferences);
  }

  start() {
    // UI control binding
    if (!this.world.controls) return;

    this.control = this.world.controls.bind({
      priority: ControlPriorities.CORE_UI,
    });

    // Setup key bindings - access via index to work around TypeScript narrowing
    const keyC = this.control.keyC as { onPress: () => void } | undefined;
    if (keyC) {
      keyC.onPress = () => this.toggleVisible();
    }
    const keyEscape = this.control.keyEscape as
      { onPress: () => void } | undefined;
    if (keyEscape) {
      keyEscape.onPress = () => this.toggleActive(false);
    }
    const keyV = this.control.keyV as { onPress: () => void } | undefined;
    if (keyV) {
      keyV.onPress = () => this.toggleVoiceEnabled();
    }

    // Setup target guide
    this.targetGuide = document.createElement("div");
    this.targetGuide.style.position = "absolute";
    this.targetGuide.style.width = "30px";
    this.targetGuide.style.height = "30px";
    this.targetGuide.style.display = "flex";
    this.targetGuide.style.alignItems = "center";
    this.targetGuide.style.justifyContent = "center";
    this.targetGuide.style.transform = "translate(-50%, -50%)";
    this.targetGuide.style.filter =
      "drop-shadow(0px 0px 4px rgba(0, 0, 0, 0.25))";
    this.targetGuide.innerHTML = TARGET_SVG;

    // Listen for events
    if (this.world.prefs) {
      this.world.prefs.on("change", this.onPrefsChange);
    }
    this.subscribe(EventType.READY, () => this.onReady());
  }

  preFixedUpdate() {
    // Apply preference changes
    if (this.changes) {
      this.emit("change", this.changes);
      this.changes = null;
      // Persist settings immediately when they change
      this.persist();
    }
  }

  update(delta: number) {
    // Update UI controls
    if (this.control && this.state.visible) {
      const keyB = this.control.keyB as { pressed: boolean } | undefined;
      if (keyB && keyB.pressed) {
        this.toggleActive();
      }
    }

    // Update stats ping
    if (this.statsActive) {
      this.lastPingAt += delta;
      if (this.lastPingAt > PING_RATE) {
        const time = performance.now();
        this.world.network.send("ping", time);
        this.lastPingAt = 0;
      }
    }
  }

  lateUpdate() {
    // Update target indicator
    if (!this.targetVector) return;

    _v3_1.copy(this.targetVector);
    _v3_1.project(this.world.camera);

    const x = ((_v3_1.x + 1) * (this.targetBounds?.width || 0)) / 2;
    const y = ((-_v3_1.y + 1) * (this.targetBounds?.height || 0)) / 2;

    // Behind camera
    if (_v3_1.z > 1) {
      this.targetGuide.style.display = "none";
      return;
    }

    // On screen
    if (_v3_1.x >= -1 && _v3_1.x <= 1 && _v3_1.y >= -1 && _v3_1.y <= 1) {
      this.targetGuide.style.left = `${x}px`;
      this.targetGuide.style.top = `${y}px`;
      this.targetGuide.style.display = "block";
    } else {
      // Off screen - pin to edge
      const centerX = (this.targetBounds?.width || 0) / 2;
      const centerY = (this.targetBounds?.height || 0) / 2;

      const pt = this.intersectLineWithRect(
        centerX,
        centerY,
        x,
        y,
        this.targetBounds?.width || 0,
        this.targetBounds?.height || 0,
        10,
      );

      if (!pt) {
        this.targetGuide.style.display = "none";
        return;
      }

      this.targetGuide.style.left = `${pt.x}px`;
      this.targetGuide.style.top = `${pt.y}px`;
      this.targetGuide.style.display = "block";
    }
  }

  preTick() {
    if (this.statsActive) {
      this.statsPanel?.begin();
    }
  }

  postTick() {
    if (this.statsActive) {
      this.statsPanel?.end();
      this.statsPanel?.update?.();
    }
  }

  // UI Methods
  toggleVisible(value?: boolean) {
    this.state.visible = isBoolean(value) ? value : !this.state.visible;
    if (!this.state.visible && this.state.active) {
      this.state.active = false;
    }
    this.broadcast();
  }

  toggleActive(value?: boolean) {
    this.state.active = isBoolean(value) ? value : !this.state.active;
    this.broadcast();
  }

  broadcast() {
    type UIUpdateEvent = "ui-update";
    this.emitTypedEvent("ui-update" as UIUpdateEvent, { ...this.state });
  }

  // Target Methods
  showTarget(vec3: THREE.Vector3) {
    this.targetVector = vec3;
    this.uiContainer?.appendChild(this.targetGuide);
    type ElementWithBounds = { getBoundingClientRect: () => DOMRect };
    this.targetBounds =
      (this.uiContainer as ElementWithBounds | null)?.getBoundingClientRect() ||
      null;
  }

  hideTarget() {
    if (this.targetVector) {
      this.targetVector = null;
      this.uiContainer?.removeChild(this.targetGuide);
    }
  }

  // Stats Methods
  toggleStats(value?: boolean) {
    value = isBoolean(value) ? value : !this.statsActive;
    if (this.statsActive === value) return;

    this.statsActive = value;

    if (this.statsActive) {
      if (!this.statsPanel) {
        const statsGL = new StatsGL({
          logsPerSecond: 20,
          samplesLog: 100,
          samplesGraph: 10,
          precision: 2,
          horizontal: true,
          minimal: false,
          mode: 0,
        });
        this.statsPanel = statsGL as unknown as {
          dom: HTMLElement;
          setMode?: (mode: number) => void;
          addPanel: (
            panel: { dom: HTMLElement },
            index?: number,
          ) => { dom: HTMLElement };
          begin: () => void;
          end: () => void;
          init?: (renderer: unknown, debug: boolean) => void;
          update?: () => void;
        };
        if (this.statsPanel && this.statsPanel.init) {
          this.statsPanel.init(this.world.graphics?.renderer, false);
        }
        type PanelConstructor = new (
          name: string,
          fg: string,
          bg: string,
        ) => {
          dom: HTMLElement;
          update?: (
            value: number,
            max: number,
            graph: unknown[],
            index: number,
          ) => void;
          fg?: string;
        };
        this.ping = new (Panel as unknown as PanelConstructor)(
          "PING",
          "#f00",
          "#200",
        );
        if (this.statsPanel && this.statsPanel.addPanel) {
          this.statsPanel.addPanel(this.ping, 3);
        }
      }
      if (this.uiContainer && this.statsPanel && this.statsPanel.dom) {
        this.uiContainer.appendChild(this.statsPanel.dom);
      }
    } else {
      if (this.statsPanel && this.uiContainer) {
        this.uiContainer.removeChild(this.statsPanel.dom);
      }
    }
  }

  onPong(time: number) {
    const rttMs = performance.now() - time;

    if (this.statsActive && this.ping) {
      this.pingHistory.push(rttMs);

      if (this.pingHistory.length > this.pingHistorySize) {
        this.pingHistory.shift();
      }

      this.maxPing = Math.max(this.maxPing, rttMs);

      let avgPing = 0;
      for (let i = 0; i < this.pingHistory.length; i++) {
        avgPing += this.pingHistory[i];
      }
      avgPing /= this.pingHistory.length;

      const graph: { min?: number; max?: number; avg?: number }[] = [];
      for (let i = 0; i < this.pingHistory.length; i++) {
        const ping = this.pingHistory[i];
        graph.push({
          min: ping,
          max: ping,
          avg: ping,
        });
      }

      this.ping.update?.(rttMs, this.maxPing, graph, 3);

      let color = "#0f0";
      if (avgPing > 100) color = "#f00";
      else if (avgPing > 50) color = "#ff0";

      if (this.ping.fg !== undefined) {
        this.ping.fg = color;
      }
      const firstChild = this.ping.dom.children[0] as HTMLElement | undefined;
      if (firstChild) firstChild.style.color = color;
    }
  }

  /**
   * Handle server-measured RTT received via the rtt packet.
   * This is the WebSocket-level ping/pong RTT measured by the server,
   * providing an independent latency measurement alongside the game-level ping.
   */
  onServerRTT(rttMs: number) {
    // Feed into the same ping history for consistent UI display
    if (this.statsActive && this.ping) {
      this.pingHistory.push(rttMs);
      if (this.pingHistory.length > this.pingHistorySize) {
        this.pingHistory.shift();
      }
      this.maxPing = Math.max(this.maxPing, rttMs);
    }
  }

  // Preference Methods
  private isTextInputFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    const tagName = active.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA") return true;
    return active instanceof HTMLElement && active.isContentEditable;
  }

  private toggleVoiceEnabled(): void {
    if (this.isTextInputFocused()) return;
    const livekitAvailable = this.world.livekit?.status?.available ?? false;
    if (!livekitAvailable) {
      this.world.emit(EventType.UI_TOAST, {
        message: "Voice chat is unavailable",
        type: "warning",
      });
      return;
    }
    const next = !this.voiceEnabled;
    this.setVoiceEnabled(next);
    this.world.emit(EventType.UI_TOAST, {
      message: next ? "Voice chat enabled" : "Voice chat disabled",
      type: "info",
    });
  }

  modify(key: PrefsKey, value: PrefsValue) {
    if (
      this.streamingRenderPreferences &&
      Object.prototype.hasOwnProperty.call(this.streamingRenderPreferences, key)
    ) {
      const expected =
        this.streamingRenderPreferences[
          key as keyof StreamingRenderPreferences
        ];
      if (value !== expected) {
        throw new Error(`Streaming render preference ${key} is startup-fixed`);
      }
      return;
    }
    if (!this.changes) this.changes = {};

    const prev = (this as any)[key];
    if (prev !== value) {
      (this as any)[key] = value;
      this.changes[key] = { prev, value };
    }
  }

  async persist() {
    const data: ClientPrefsData = {
      ui: this.ui,
      actions: this.actions,
      stats: this.stats,
      dpr: this.dpr,
      shadows: this.shadows,
      postprocessing: this.postprocessing,
      bloom: this.bloom,
      colorGrading: this.colorGrading,
      colorGradingIntensity: this.colorGradingIntensity,
      depthBlur: this.depthBlur,
      depthBlurIntensity: this.depthBlurIntensity,
      depthBlurDistance: this.depthBlurDistance,
      entityHighlighting: this.entityHighlighting,

      music: this.music,
      sfx: this.sfx,
      voice: this.voice,
      voiceEnabled: this.voiceEnabled,
      chatVisible: this.chatVisible,
      waterReflections: this.waterReflections,
      v: this.v,
    };

    // storage.set already does JSON.stringify internally
    storage.set("prefs", { ...data, ...this.persistedRenderPreferences });
  }

  // Preference setters
  setUI(value: number) {
    this.modify("ui", value);
  }
  setActions(value: boolean) {
    this.modify("actions", value);
  }
  setStats(value: boolean) {
    this.modify("stats", value);
  }
  setDPR(value: number) {
    this.modify("dpr", value);
  }
  setShadows(value: string) {
    this.modify("shadows", value);
  }
  setPostprocessing(value: boolean) {
    this.modify("postprocessing", value);
  }
  setBloom(value: boolean) {
    this.modify("bloom", value);
  }
  setColorGrading(value: string) {
    this.modify("colorGrading", value);
  }
  setColorGradingIntensity(value: number) {
    this.modify("colorGradingIntensity", value);
  }
  setDepthBlur(value: boolean) {
    this.modify("depthBlur", value);
  }
  setDepthBlurIntensity(value: number) {
    this.modify("depthBlurIntensity", value);
  }
  setDepthBlurDistance(value: number) {
    this.modify("depthBlurDistance", value);
  }
  setEntityHighlighting(value: boolean) {
    this.modify("entityHighlighting", value);
  }
  setMusic(value: number) {
    this.modify("music", value);
  }
  setSFX(value: number) {
    this.modify("sfx", value);
  }
  setVoice(value: number) {
    this.modify("voice", value);
  }
  setVoiceEnabled(value: boolean) {
    this.modify("voiceEnabled", value);
  }
  setChatVisible(value: boolean) {
    this.modify("chatVisible", value);
  }
  setWaterReflections(value: boolean) {
    this.modify("waterReflections", value);
  }

  // Event handlers
  private onReady = () => {
    if (this.stats) {
      this.toggleStats(true);
    }
  };

  private onPrefsChange = (changes: { stats?: { value: boolean } }) => {
    if (changes.stats) {
      this.toggleStats(changes.stats.value);
    }
  };

  // Helper methods
  private intersectLineWithRect(
    cx: number,
    cy: number,
    x: number,
    y: number,
    width: number,
    height: number,
    padding: number = 0,
  ): { x: number; y: number } | null {
    const dx = x - cx;
    const dy = y - cy;

    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;

    let t = Infinity;

    // Left edge
    if (dx < 0) {
      const tLeft = (padding - cx) / dx;
      if (tLeft > 0) {
        const yAtLeft = cy + tLeft * dy;
        if (yAtLeft >= padding && yAtLeft <= height - padding) {
          t = Math.min(t, tLeft);
        }
      }
    }

    // Right edge
    if (dx > 0) {
      const tRight = (width - padding - cx) / dx;
      if (tRight > 0) {
        const yAtRight = cy + tRight * dy;
        if (yAtRight >= padding && yAtRight <= height - padding) {
          t = Math.min(t, tRight);
        }
      }
    }

    // Top edge
    if (dy < 0) {
      const tTop = (padding - cy) / dy;
      if (tTop > 0) {
        const xAtTop = cx + tTop * dx;
        if (xAtTop >= padding && xAtTop <= width - padding) {
          t = Math.min(t, tTop);
        }
      }
    }

    // Bottom edge
    if (dy > 0) {
      const tBottom = (height - padding - cy) / dy;
      if (tBottom > 0) {
        const xAtBottom = cx + tBottom * dx;
        if (xAtBottom >= padding && xAtBottom <= width - padding) {
          t = Math.min(t, tBottom);
        }
      }
    }

    if (t === Infinity) return null;

    return {
      x: cx + t * dx,
      y: cy + t * dy,
    };
  }

  destroy() {
    this.control?.release();
    this.control = null;
    this.hideTarget();
    if (this.statsPanel && this.uiContainer) {
      this.uiContainer.removeChild(this.statsPanel.dom);
    }
    this.persist();
  }
}
