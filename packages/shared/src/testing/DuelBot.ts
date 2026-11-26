/**
 * DuelBot - Headless bot for automated dueling
 *
 * Extends the LoadTestBot pattern but handles the complete duel flow:
 * - Auto-accept incoming duel challenges
 * - Auto-confirm rules, stakes, and final screens
 * - Auto-attack during duel combat
 * - Auto-eat food with personality-driven thresholds and DPS tracking
 * - Emit events for matchmaker coordination
 */

import { createNodeClientWorld } from "../runtime/createNodeClientWorld";
import type { World as ClientWorld } from "../core/World";
import { EventEmitter } from "events";
import { EventType } from "../types/events/event-types";

// ============================================================================
// Food data
// ============================================================================

const FOOD_HEAL_AMOUNTS: Record<string, number> = {
  shrimp: 3,
  bread: 5,
  meat: 3,
  trout: 7,
  salmon: 9,
  tuna: 10,
  lobster: 12,
  bass: 13,
  swordfish: 14,
  monkfish: 16,
  karambwan: 18,
  shark: 20,
  manta: 22,
  anglerfish: 22,
  pie: 6,
  cake: 12,
  stew: 11,
  potato: 14,
  cooked: 5,
  fish: 5,
};

const FOOD_NAMES = Object.keys(FOOD_HEAL_AMOUNTS);

const EAT_COOLDOWN_MS = 1800;
const ENV_EAT_THRESHOLD = Math.max(
  10,
  Math.min(80, parseInt(process.env.DUEL_BOT_EAT_THRESHOLD || "40", 10) || 40),
);

// Number of recent ticks tracked for opponent DPS estimation
const DPS_WINDOW_TICKS = 8;

// ============================================================================
// Combat personalities
// ============================================================================

export type CombatPersonality =
  "aggressive" | "defensive" | "calculated" | "reckless";

interface PersonalityProfile {
  baseEatThreshold: number;
  desperateBonus: number;
  /** HP% below which the bot enters desperate mode (relative to base) */
  desperateMultiplier: number;
  /** When food is scarce (<=3 remaining), threshold is adjusted by this offset */
  scarceOffset: number;
  /** DPS reactivity: how much to raise threshold per estimated DPS point */
  dpsReactivity: number;
}

const PERSONALITIES: Record<CombatPersonality, PersonalityProfile> = {
  aggressive: {
    baseEatThreshold: 30,
    desperateBonus: 20,
    desperateMultiplier: 0.5,
    scarceOffset: -8,
    dpsReactivity: 0.4,
  },
  defensive: {
    baseEatThreshold: 55,
    desperateBonus: 10,
    desperateMultiplier: 0.7,
    scarceOffset: 5,
    dpsReactivity: 1.2,
  },
  calculated: {
    baseEatThreshold: 40,
    desperateBonus: 15,
    desperateMultiplier: 0.6,
    scarceOffset: -3,
    dpsReactivity: 0.8,
  },
  reckless: {
    baseEatThreshold: 20,
    desperateBonus: 25,
    desperateMultiplier: 0.4,
    scarceOffset: -10,
    dpsReactivity: 0.2,
  },
};

const PERSONALITY_NAMES: CombatPersonality[] = [
  "aggressive",
  "defensive",
  "calculated",
  "reckless",
];

export type DuelBotConfig = {
  wsUrl: string;
  name: string;
  /** Auto-accept any incoming duel challenge */
  autoAcceptChallenges?: boolean;
  /** Auto-confirm all duel screens (rules, stakes, final) */
  autoConfirmScreens?: boolean;
  /** Connection timeout in ms */
  connectTimeoutMs?: number;
  /** Explicit eat threshold override (ignores personality if set) */
  eatThresholdPct?: number;
  /** Combat personality (default: randomly assigned) */
  personality?: CombatPersonality;
};

export type DuelBotState =
  | "disconnected"
  | "connecting"
  | "idle"
  | "challenged"
  | "in_duel_rules"
  | "in_duel_stakes"
  | "in_duel_confirm"
  | "in_duel_countdown"
  | "in_duel_fighting"
  | "duel_finished";

export type DuelBotMetrics = {
  wins: number;
  losses: number;
  totalDuels: number;
  connectedAt: number;
  lastDuelAt: number;
  isConnected: boolean;
};

type Position = { x: number; y: number; z: number };
type NetworkSender = {
  send: (method: string, data: unknown) => void;
  connected?: boolean;
  id?: string | null;
  on?: (event: string, callback: (data: unknown) => void) => void;
};

type InventoryItem = { slot: number; itemId: string; quantity: number };

export class DuelBot extends EventEmitter {
  private config: Required<DuelBotConfig>;
  private clientWorld: ClientWorld | null = null;
  private connectionVerified = false;
  private isActive = false;
  private attackTimer: ReturnType<typeof setInterval> | null = null;
  private connectionCheckTimer: ReturnType<typeof setInterval> | null = null;
  private challengeTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Registered event handlers for cleanup to prevent memory leaks */
  private eventHandlers: Array<{
    event: string | symbol;
    handler: (...args: unknown[]) => void;
  }> = [];

  private inventory: InventoryItem[] = [];
  private lastEatTime = 0;
  private lastHealthPct = 100;
  private recentDamageTicks: number[] = [];
  readonly personality: CombatPersonality;

  state: DuelBotState = "disconnected";
  currentDuelId: string | null = null;
  currentOpponentId: string | null = null;
  pendingChallengeId: string | null = null;

  readonly metrics: DuelBotMetrics = {
    wins: 0,
    losses: 0,
    totalDuels: 0,
    connectedAt: 0,
    lastDuelAt: 0,
    isConnected: false,
  };

  /** Counter used to round-robin personalities across bot instances */
  private static personalityCounter = 0;

  constructor(config: DuelBotConfig) {
    super();

    this.personality =
      config.personality ??
      PERSONALITY_NAMES[
        DuelBot.personalityCounter++ % PERSONALITY_NAMES.length
      ];

    const profile = PERSONALITIES[this.personality];

    // Threshold priority: explicit config arg > env override > personality baseline.
    // ENV_EAT_THRESHOLD is only applied when the env var is actually set (not the default).
    const envOverride =
      process.env.DUEL_BOT_EAT_THRESHOLD !== undefined
        ? ENV_EAT_THRESHOLD
        : null;
    const eatThresholdPct =
      config.eatThresholdPct ?? envOverride ?? profile.baseEatThreshold;

    this.config = {
      autoAcceptChallenges: true,
      autoConfirmScreens: true,
      connectTimeoutMs: 15000,
      personality: this.personality,
      ...config,
      // Always use the resolved threshold — overrides anything in ...config spread
      eatThresholdPct,
    };

    console.log(
      `[DuelBot] ${config.name} personality=${this.personality} ` +
        `eat@${eatThresholdPct}% dpsReact=${profile.dpsReactivity}`,
    );
  }

  async connect(): Promise<void> {
    this.state = "connecting";
    const url = new URL(this.config.wsUrl);
    // Reuse load-test bot auth bypass path so duel bots can connect without
    // requiring user JWT credentials in local/dev environments.
    url.searchParams.set("loadTestBot", "true");
    url.searchParams.set("duelBot", "true");
    url.searchParams.set("botName", this.config.name);

    const clientWorld = createNodeClientWorld();
    await clientWorld.init({
      wsUrl: url.toString(),
      name: this.config.name,
    } as { wsUrl: string; name: string });

    this.clientWorld = clientWorld;
    this.metrics.connectedAt = Date.now();

    // Wait for network connection
    const startWait = Date.now();
    while (Date.now() - startWait < this.config.connectTimeoutMs) {
      if (this.getNetworkSystem()?.connected === true) {
        this.connectionVerified = true;
        this.metrics.isConnected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!this.connectionVerified) {
      this.state = "disconnected";
      throw new Error(`Connection timeout for ${this.config.name}`);
    }

    // Wait for network ID
    const startIdWait = Date.now();
    while (Date.now() - startIdWait < 5000) {
      if (this.getNetworkSystem()?.id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.getNetworkSystem()?.id) {
      this.disconnect();
      throw new Error(
        `${this.config.name} did not receive an authenticated network identity; ensure LOAD_TEST_MODE=true on both the local server and duel-bot process`,
      );
    }

    // Enter world
    this.sendPacket("enterWorld", {
      // Keep server-side enterWorld handling on the load-test bot path so
      // persistence/session logic doesn't require a DB-backed character row.
      loadTestBot: true,
      duelBot: true,
      botName: this.config.name,
    });
    await new Promise((r) => setTimeout(r, 500));

    if (this.getNetworkSystem()?.connected !== true) {
      this.metrics.isConnected = false;
      this.connectionVerified = false;
      this.state = "disconnected";
      throw new Error(`${this.config.name} disconnected after enterWorld`);
    }

    // Wait for player entity
    const startPlayerWait = Date.now();
    while (Date.now() - startPlayerWait < 5000) {
      if (this.getLocalPlayerEntity()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.getLocalPlayerEntity()) {
      this.disconnect();
      throw new Error(
        `${this.config.name} did not receive a spawned player entity after enterWorld`,
      );
    }

    // Mark the spawned player as active/targetable (mirrors browser client flow).
    if (this.getLocalPlayerEntity()) {
      this.sendPacket("clientReady", {});
    }

    this.isActive = true;
    this.state = "idle";
    this.setupPacketListeners();
    this.startConnectionMonitor();

    this.emit("connected", { name: this.config.name, id: this.getId() });
    console.log(
      `[DuelBot] ${this.config.name} connected (id: ${this.getId()})`,
    );
  }

  disconnect(): void {
    this.isActive = false;
    this.connectionVerified = false;
    this.state = "disconnected";
    if (this.attackTimer) clearInterval(this.attackTimer);
    if (this.connectionCheckTimer) clearInterval(this.connectionCheckTimer);
    if (this.challengeTimeout) clearTimeout(this.challengeTimeout);
    this.attackTimer = null;
    this.connectionCheckTimer = null;
    this.challengeTimeout = null;
    // Clean up event handlers BEFORE destroying world to prevent memory leaks
    this.cleanupEventHandlers();
    if (this.clientWorld) this.clientWorld.destroy();
    this.clientWorld = null;
    this.metrics.isConnected = false;
    this.emit("disconnected", { name: this.config.name });
  }

  getId(): string | null {
    return this.getNetworkSystem()?.id ?? null;
  }

  getPosition(): Position | null {
    const player = this.getLocalPlayerEntity();
    if (!player) return null;

    if (player.node?.position) return player.node.position;
    if (player.position) return player.position as Position;
    if (player.getPosition) return player.getPosition();

    const dataPos = player.data?.position;
    if (Array.isArray(dataPos) && dataPos.length === 3) {
      return { x: dataPos[0], y: dataPos[1], z: dataPos[2] };
    }
    if (dataPos && !Array.isArray(dataPos)) return dataPos as Position;

    return null;
  }

  /** Challenge another player to a duel */
  challengePlayer(targetId: string): void {
    if (this.state !== "idle") {
      console.log(
        `[DuelBot] ${this.config.name} cannot challenge: state=${this.state}`,
      );
      return;
    }
    this.state = "challenged";
    this.startChallengeTimeout();
    console.log(`[DuelBot] ${this.config.name} challenging ${targetId}`);
    this.sendPacket("duel:challenge", { targetPlayerId: targetId });
  }

  /** Move to a position */
  moveTo(x: number, z: number, runMode = false): void {
    this.sendPacket("moveRequest", { target: [x, 0, z], runMode });
  }

  /** Teleport to arena spawn (used by matchmaker) */
  teleportTo(x: number, y: number, z: number): void {
    // Server handles teleport via duel system, but we can request move
    this.sendPacket("moveRequest", { target: [x, y, z], runMode: true });
  }

  private setupPacketListeners(): void {
    const network = this.getNetworkSystem();
    if (!network?.on) {
      console.warn(`[DuelBot] ${this.config.name} - network.on not available`);
      return;
    }

    // Listen for duel packets by subscribing to world events
    const world = this.clientWorld;
    if (!world) return;

    // Helper to register and track event handlers for cleanup
    const on = (
      event: string | symbol,
      handler: (...args: unknown[]) => void,
    ) => {
      world.on(event as string, handler);
      this.eventHandlers.push({ event, handler });
    };

    // Track inventory from server updates
    on(EventType.INVENTORY_UPDATED, (data: unknown) => {
      const inv = data as {
        playerId?: string;
        items?: Array<{
          slot: number;
          itemId: string;
          quantity: number;
        }>;
      };
      const myId = this.getId();
      if (inv.playerId === myId && inv.items) {
        this.inventory = inv.items.map((i) => ({
          slot: i.slot,
          itemId: i.itemId,
          quantity: i.quantity,
        }));
      }
    });

    // Modern client networking emits duel lifecycle updates through UI_UPDATE.
    on(EventType.UI_UPDATE, (event: unknown) => {
      this.handleUiUpdate(event);
    });

    // Incoming duel challenge
    on("duelChallengeIncoming", (data: unknown) => {
      this.handleDuelChallengeIncoming(data);
    });

    // Duel session started (entering rules screen)
    on("duelSessionStarted", (data: unknown) => {
      this.handleDuelSessionStarted(data);
    });

    // Duel state changed (rules -> stakes -> confirm)
    on("duelStateChanged", (data: unknown) => {
      this.handleDuelStateChanged(data);
    });

    // Duel countdown starting
    on("duelCountdownStart", (data: unknown) => {
      this.handleDuelCountdownStart(data);
    });

    // Duel fight starting
    on("duelFightStart", (data: unknown) => {
      this.handleDuelFightStart(data);
    });

    on("duelFightBegin", (data: unknown) => {
      this.handleDuelFightStart(data);
    });

    // Duel ended
    on("duelEnded", (data: unknown) => {
      this.handleDuelEnded(data);
    });

    on("duelCompleted", (data: unknown) => {
      this.handleDuelEnded(data);
    });

    // Acceptance state updated
    on("duelAcceptanceUpdated", (data: unknown) => {
      this.handleDuelAcceptanceUpdated(data);
    });
  }

  /** Clean up all registered event handlers to prevent memory leaks */
  private cleanupEventHandlers(): void {
    if (!this.clientWorld) return;
    for (const { event, handler } of this.eventHandlers) {
      this.clientWorld.off(event as string, handler);
    }
    this.eventHandlers = [];
  }

  private handleUiUpdate(event: unknown): void {
    const update = event as { component?: string; data?: unknown } | undefined;
    const component = update?.component;
    const data = update?.data;
    if (!component) return;

    switch (component) {
      case "duelChallenge": {
        const challengeData = data as
          | {
              visible?: boolean;
              challengeId?: string;
              fromPlayer?: { id?: string; name?: string };
            }
          | undefined;
        if (
          challengeData?.visible &&
          challengeData.challengeId &&
          challengeData.fromPlayer?.id
        ) {
          this.handleDuelChallengeIncoming({
            challengeId: challengeData.challengeId,
            challengerId: challengeData.fromPlayer.id,
            challengerName:
              challengeData.fromPlayer.name || challengeData.fromPlayer.id,
          });
        } else if (
          challengeData?.visible === false &&
          this.state === "challenged" &&
          !this.currentDuelId
        ) {
          this.clearChallengeTimeout();
          this.state = "idle";
        }
        break;
      }
      case "duel": {
        const duelData = data as
          | {
              duelId?: string;
              opponent?: { id?: string; name?: string };
            }
          | undefined;
        if (duelData?.duelId && duelData.opponent?.id) {
          this.handleDuelSessionStarted({
            duelId: duelData.duelId,
            opponentId: duelData.opponent.id,
            opponentName: duelData.opponent.name || duelData.opponent.id,
          });
        }
        break;
      }
      case "duelStateChange": {
        const stateData = data as
          | {
              duelId?: string;
              state?: string;
            }
          | undefined;
        if (stateData?.duelId && stateData.state) {
          this.handleDuelStateChanged({
            duelId: stateData.duelId,
            newState: stateData.state,
          });
        }
        break;
      }
      case "duelAcceptanceUpdate": {
        const acceptanceData = data as
          | {
              challengerAccepted?: boolean;
              targetAccepted?: boolean;
            }
          | undefined;
        this.handleDuelAcceptanceUpdated({
          myAccepted: Boolean(acceptanceData?.challengerAccepted),
          opponentAccepted: Boolean(acceptanceData?.targetAccepted),
        });
        break;
      }
      case "duelCountdown":
      case "duelCountdownTick":
        this.handleDuelCountdownStart(data);
        break;
      case "duelFightBegin":
      case "duelFightStart":
        this.handleDuelFightStart(data);
        break;
      case "duelEnded":
        this.handleDuelEnded(data);
        break;
      default:
        break;
    }
  }

  private handleDuelChallengeIncoming(data: unknown): void {
    const challenge = data as {
      challengeId: string;
      challengerId: string;
      challengerName: string;
    };

    console.log(
      `[DuelBot] ${this.config.name} received challenge from ${challenge.challengerName}`,
    );

    this.pendingChallengeId = challenge.challengeId;
    this.state = "challenged";
    this.emit("challengeReceived", {
      botName: this.config.name,
      challengerId: challenge.challengerId,
      challengerName: challenge.challengerName,
    });

    if (this.config.autoAcceptChallenges) {
      // Small delay to simulate human reaction
      setTimeout(() => {
        this.acceptChallenge(challenge.challengeId);
      }, 500);
    }
  }

  private acceptChallenge(challengeId: string): void {
    console.log(`[DuelBot] ${this.config.name} accepting challenge`);
    this.sendPacket("duel:challenge:respond", {
      challengeId,
      accept: true,
    });
  }

  private handleDuelSessionStarted(data: unknown): void {
    const session = data as {
      duelId: string;
      opponentId: string;
      opponentName: string;
    };

    console.log(
      `[DuelBot] ${this.config.name} duel session started vs ${session.opponentName}`,
    );

    this.currentDuelId = session.duelId;
    this.currentOpponentId = session.opponentId;
    this.state = "in_duel_rules";
    this.pendingChallengeId = null;
    this.clearChallengeTimeout();

    this.emit("duelStarted", {
      botName: this.config.name,
      duelId: session.duelId,
      opponentId: session.opponentId,
    });

    if (this.config.autoConfirmScreens) {
      // Auto-accept rules after short delay
      setTimeout(() => {
        this.acceptRules();
      }, 1000);
    }
  }

  private handleDuelStateChanged(data: unknown): void {
    const stateChange = data as {
      duelId: string;
      newState: string;
    };

    console.log(
      `[DuelBot] ${this.config.name} duel state: ${stateChange.newState}`,
    );

    switch (stateChange.newState) {
      case "STAKES":
        this.state = "in_duel_stakes";
        if (this.config.autoConfirmScreens) {
          setTimeout(() => this.acceptStakes(), 1000);
        }
        break;
      case "CONFIRMING":
        this.state = "in_duel_confirm";
        if (this.config.autoConfirmScreens) {
          setTimeout(() => this.acceptFinal(), 1000);
        }
        break;
      case "COUNTDOWN":
        this.state = "in_duel_countdown";
        break;
      case "FIGHTING":
        this.state = "in_duel_fighting";
        this.startCombat();
        break;
      case "FINISHED":
        this.state = "duel_finished";
        this.stopCombat();
        break;
    }
  }

  private handleDuelCountdownStart(data: unknown): void {
    console.log(`[DuelBot] ${this.config.name} countdown starting`);
    this.state = "in_duel_countdown";
  }

  private handleDuelFightStart(data: unknown): void {
    console.log(`[DuelBot] ${this.config.name} FIGHT!`);
    this.state = "in_duel_fighting";
    this.startCombat();
  }

  private handleDuelEnded(data: unknown): void {
    const result = data as {
      duelId: string;
      winnerId: string;
      loserId: string;
      winnerName: string;
      loserName: string;
    };

    const myId = this.getId();
    const won = result.winnerId === myId;

    console.log(
      `[DuelBot] ${this.config.name} duel ended - ${won ? "WON!" : "LOST"}`,
    );

    this.metrics.totalDuels++;
    this.metrics.lastDuelAt = Date.now();
    if (won) {
      this.metrics.wins++;
    } else {
      this.metrics.losses++;
    }

    this.state = "idle";
    this.currentDuelId = null;
    this.currentOpponentId = null;
    this.inventory = [];
    this.lastEatTime = 0;
    this.lastHealthPct = 100;
    this.recentDamageTicks = [];
    this.stopCombat();
    this.clearChallengeTimeout();

    this.emit("duelEnded", {
      botName: this.config.name,
      duelId: result.duelId,
      won,
      winnerId: result.winnerId,
      loserId: result.loserId,
    });
  }

  private handleDuelAcceptanceUpdated(data: unknown): void {
    // Server sends acceptance updates - we can use this to know when opponent accepted
    const update = data as {
      myAccepted: boolean;
      opponentAccepted: boolean;
    };
    console.log(
      `[DuelBot] ${this.config.name} acceptance: me=${update.myAccepted}, opponent=${update.opponentAccepted}`,
    );
  }

  private acceptRules(): void {
    console.log(`[DuelBot] ${this.config.name} accepting rules`);
    if (!this.currentDuelId) return;
    this.sendPacket("duel:accept:rules", { duelId: this.currentDuelId });
  }

  private acceptStakes(): void {
    console.log(`[DuelBot] ${this.config.name} accepting stakes (no stakes)`);
    if (!this.currentDuelId) return;
    this.sendPacket("duel:accept:stakes", { duelId: this.currentDuelId });
  }

  private acceptFinal(): void {
    console.log(`[DuelBot] ${this.config.name} final confirmation`);
    if (!this.currentDuelId) return;
    this.sendPacket("duel:accept:final", { duelId: this.currentDuelId });
  }

  private startCombat(): void {
    if (this.attackTimer) return;

    console.log(`[DuelBot] ${this.config.name} starting combat loop`);

    this.attackTimer = setInterval(() => {
      if (this.state !== "in_duel_fighting" || !this.currentOpponentId) {
        this.stopCombat();
        return;
      }
      this.combatTick();
    }, 600);

    this.combatTick();
  }

  private combatTick(): void {
    if (this.tryEat()) return;
    this.attack();
  }

  /**
   * Check health and eat food if below the effective threshold.
   *
   * Effective threshold is computed from three layers:
   *  1. Base threshold (from personality or explicit config / env override)
   *  2. DPS reactivity: raises threshold proportionally to estimated opponent DPS
   *  3. Desperate mode: when HP falls below personality's critical multiplier,
   *     the base is raised by desperateBonus for aggressive emergency eating
   *  4. Scarcity: when food count ≤ 3, personality's scarceOffset shifts the
   *     threshold (negative = more conservative, positive = more aggressive)
   *
   * Returns true if an eat action was taken this tick (skips attack).
   */
  private tryEat(): boolean {
    const now = Date.now();
    if (now - this.lastEatTime < EAT_COOLDOWN_MS) return false;

    const player = this.getLocalPlayerEntity();
    if (!player) return false;

    const data = player.data as
      { health?: number; maxHealth?: number } | undefined;
    const health = data?.health;
    const maxHealth = data?.maxHealth;
    if (
      typeof health !== "number" ||
      typeof maxHealth !== "number" ||
      maxHealth <= 0
    ) {
      return false;
    }

    const healthPct = (health / maxHealth) * 100;

    // Update DPS estimation window using damage taken since last tick.
    // Only count positive damage (healing spikes don't count as negative DPS).
    const damageTaken = Math.max(0, this.lastHealthPct - healthPct);
    this.lastHealthPct = healthPct;
    if (damageTaken > 0) {
      this.recentDamageTicks.push(damageTaken);
      if (this.recentDamageTicks.length > DPS_WINDOW_TICKS) {
        this.recentDamageTicks.shift();
      }
    }

    const profile = PERSONALITIES[this.personality];

    // Average damage-per-tick over the sliding window
    const avgDps =
      this.recentDamageTicks.length > 0
        ? this.recentDamageTicks.reduce((a, b) => a + b, 0) /
          this.recentDamageTicks.length
        : 0;

    // Scarcity: if almost out of food, apply personality's scarce offset
    const foodItems = this.inventory.filter((item) => this.isFoodItem(item));
    const scarcityOffset = foodItems.length <= 3 ? profile.scarceOffset : 0;

    // DPS reactivity: raise threshold proportionally to incoming damage rate
    const dpsBonus = avgDps * profile.dpsReactivity;

    // Desperate phase: when critically low, eat much more aggressively
    const desperate =
      healthPct < this.config.eatThresholdPct * profile.desperateMultiplier;

    const effectiveThreshold = desperate
      ? Math.min(
          this.config.eatThresholdPct + profile.desperateBonus + dpsBonus,
          95,
        )
      : Math.min(this.config.eatThresholdPct + dpsBonus + scarcityOffset, 95);

    if (healthPct >= effectiveThreshold) return false;

    const food = this.findBestFood();
    if (!food) return false;

    console.log(
      `[DuelBot] ${this.config.name} eating ${food.itemId} ` +
        `hp=${healthPct.toFixed(1)}% thresh=${effectiveThreshold.toFixed(1)}% ` +
        `dps+=${dpsBonus.toFixed(1)} scarce=${scarcityOffset} desperate=${desperate}`,
    );

    this.sendPacket("useItem", { itemId: food.itemId, slot: food.slot });
    this.lastEatTime = now;

    // Optimistically remove the food from local tracking so we don't
    // try to eat the same item again before the server confirms.
    // The authoritative inventory update from the server will correct
    // any discrepancy on the next inventoryUpdated packet.
    this.inventory = this.inventory.filter((i) => i.slot !== food.slot);

    return true;
  }

  /** Returns true if the item is a recognisable food that heals HP. */
  private isFoodItem(item: InventoryItem): boolean {
    const name = item.itemId.toLowerCase();
    return FOOD_NAMES.some(
      (key) => name.includes(key) && FOOD_HEAL_AMOUNTS[key] > 0,
    );
  }

  /**
   * Find the best (highest-healing) food item in inventory.
   */
  private findBestFood(): InventoryItem | null {
    let bestFood: InventoryItem | null = null;
    let bestHeal = 0;

    for (const item of this.inventory) {
      const name = item.itemId.toLowerCase();
      let heal = 0;
      for (const key of FOOD_NAMES) {
        if (name.includes(key) && FOOD_HEAL_AMOUNTS[key] > heal) {
          heal = FOOD_HEAL_AMOUNTS[key];
        }
      }
      if (heal > bestHeal) {
        bestHeal = heal;
        bestFood = item;
      }
    }

    return bestFood;
  }

  private stopCombat(): void {
    if (this.attackTimer) {
      clearInterval(this.attackTimer);
      this.attackTimer = null;
    }
  }

  private attack(): void {
    if (!this.currentOpponentId) return;
    this.sendPacket("attackPlayer", {
      targetPlayerId: this.currentOpponentId,
    });
  }

  private startConnectionMonitor(): void {
    this.connectionCheckTimer = setInterval(() => {
      if (!this.isActive) return;
      const connected = this.getNetworkSystem()?.connected === true;
      if (!connected && this.metrics.isConnected) {
        this.metrics.isConnected = false;
        this.state = "disconnected";
        this.emit("disconnected", { name: this.config.name, reason: "lost" });
      }
    }, 2000);
  }

  private startChallengeTimeout(): void {
    this.clearChallengeTimeout();
    this.challengeTimeout = setTimeout(() => {
      if (this.state === "challenged" && !this.currentDuelId) {
        console.log(
          `[DuelBot] ${this.config.name} challenge timed out, returning to idle`,
        );
        this.state = "idle";
        this.pendingChallengeId = null;
      }
    }, 8000);
  }

  private clearChallengeTimeout(): void {
    if (this.challengeTimeout) {
      clearTimeout(this.challengeTimeout);
      this.challengeTimeout = null;
    }
  }

  private sendPacket(method: string, data: unknown): void {
    const network = this.getNetworkSystem();
    if (!network?.send || network.connected === false) {
      console.warn(`[DuelBot] ${this.config.name} cannot send: not connected`);
      return;
    }
    network.send(method, data);
  }

  private getNetworkSystem(): NetworkSender | null {
    if (!this.clientWorld) return null;
    const network = this.clientWorld.getSystem("network");
    return network ? (network as unknown as NetworkSender) : null;
  }

  private getLocalPlayerEntity(): {
    node?: { position?: Position };
    position?: unknown;
    getPosition?: () => Position;
    data?: Record<string, unknown>;
  } | null {
    const entities = this.clientWorld?.entities;
    if (!entities) return null;
    if ((entities as { player?: unknown }).player)
      return (entities as { player: unknown }).player as {
        node?: { position?: Position };
        position?: unknown;
        getPosition?: () => Position;
        data?: Record<string, unknown>;
      };

    const networkId = this.getNetworkSystem()?.id;
    if (!networkId) return null;
    const playerFromMap = (
      entities as { players?: Map<string, unknown> }
    ).players?.get(networkId);
    return playerFromMap as {
      node?: { position?: Position };
      position?: unknown;
      getPosition?: () => Position;
      data?: Record<string, unknown>;
    } | null;
  }

  get name(): string {
    return this.config.name;
  }

  get connected(): boolean {
    return (
      this.connectionVerified &&
      this.metrics.isConnected &&
      this.isActive &&
      this.getNetworkSystem()?.connected === true
    );
  }
}

export default DuelBot;
