/**
 * ElizaDuelBot - ElizaOS-powered duel bot
 *
 * Drop-in replacement for DuelBot that uses a real ElizaOS AgentRuntime
 * with hyperiaPlugin. Each bot uses a different AI model for TEXT_LARGE
 * decisions and a cheap small model for TEXT_SMALL.
 *
 * The HyperiaService's AutonomousBehaviorManager handles the LLM decision
 * loop (movement, combat, prayer switching, etc.). The matchmaker just
 * initiates challenges between bots.
 */

import {
  AgentRuntime,
  type Plugin,
  // @ts-ignore — InMemoryDatabaseAdapter is exported at runtime but not in .d.ts
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { EventEmitter } from "events";
import { hyperiaPlugin } from "@hyperforge/plugin-hyperia";
import { createJWT } from "../shared/utils.js";
import { errMsg } from "../shared/errMsg.js";
import type { ModelProviderConfig } from "./ModelAgentSpawner.js";
import { loadModelPlugin, createAgentCharacter } from "./agentHelpers.js";
import { duelLogError, duelLogInfo, duelLogWarn } from "./logging.js";
import { isLocalDiagnosticDuelRuntime } from "../systems/StreamingDuelScheduler/managers/DuelOrchestrator.js";

// Re-export for convenience
export { MODEL_AGENTS } from "./ModelAgentSpawner.js";

/** Minimal interface for the HyperiaService accessed through the runtime. */
interface HyperiaServiceHandle {
  executeDuelChallenge?: (params: { targetPlayerId: string }) => Promise<void>;
  getPlayerEntity?: () => {
    position?: [number, number, number] | { x: number; y: number; z: number };
  } | null;
  startAutonomousBehavior?: () => void;
  stopAutonomousBehavior?: () => void;
  setAutonomousBehaviorEnabled?: (enabled: boolean) => void;
  onGameEvent?: (
    event: string,
    handler: (data: Record<string, unknown>) => void,
  ) => void;
  offGameEvent?: (
    event: string,
    handler: (data: Record<string, unknown>) => void,
  ) => void;
}

/** Timeout for a single runtime.initialize() attempt (ms) */
const INIT_TIMEOUT_MS = 45_000;
/** Max retries for runtime initialization */
const MAX_INIT_RETRIES = 2;

export type ElizaDuelBotConfig = {
  /** WebSocket URL for the game server */
  wsUrl: string;
  /** Display name for this bot */
  name: string;
  /** Model provider configuration */
  modelConfig: ModelProviderConfig;
  /** Small model override for TEXT_SMALL (cheap/fast model) */
  smallModel?: string;
  /** Connection timeout in ms */
  connectTimeoutMs?: number;
  /** Account ID for JWT auth */
  accountId?: string;
};

export type ElizaDuelBotState =
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

export type ElizaDuelBotMetrics = {
  wins: number;
  losses: number;
  totalDuels: number;
  connectedAt: number;
  lastDuelAt: number;
  isConnected: boolean;
};

export class ElizaDuelBot extends EventEmitter {
  private config: Required<
    Pick<
      ElizaDuelBotConfig,
      "wsUrl" | "name" | "modelConfig" | "connectTimeoutMs" | "accountId"
    >
  > & { smallModel?: string };
  private runtime: AgentRuntime | null = null;
  private _connected = false;
  private _id: string | null = null;

  /** Retry timer for setupDuelEventListeners when service isn't ready */
  private setupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether duel event listeners have been registered (prevents duplicates) */
  private duelListenersRegistered = false;
  /** Stable handler refs for proper listener teardown */
  private duelFightStartHandler:
    ((data: Record<string, unknown>) => void) | null = null;
  private duelCompletedHandler:
    ((data: Record<string, unknown>) => void) | null = null;

  state: ElizaDuelBotState = "disconnected";
  currentDuelId: string | null = null;
  currentOpponentId: string | null = null;

  readonly metrics: ElizaDuelBotMetrics = {
    wins: 0,
    losses: 0,
    totalDuels: 0,
    connectedAt: 0,
    lastDuelAt: 0,
    isConnected: false,
  };

  constructor(config: ElizaDuelBotConfig) {
    super();
    this.config = {
      wsUrl: config.wsUrl,
      name: config.name,
      modelConfig: config.modelConfig,
      smallModel: config.smallModel,
      connectTimeoutMs: config.connectTimeoutMs || 30000,
      accountId: config.accountId || "eliza-duel-bots-account",
    };
  }

  get name(): string {
    return this.config.name;
  }

  get connected(): boolean {
    return this._connected;
  }

  getId(): string | null {
    return this._id;
  }

  private getHyperiaService(): HyperiaServiceHandle | null {
    if (!this.runtime) return null;
    return this.runtime.getService(
      "hyperiaService",
    ) as HyperiaServiceHandle | null;
  }

  private async waitForPlayerSpawnReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const playerEntity = this.getHyperiaService()?.getPlayerEntity?.();
      if (playerEntity) {
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `player entity not ready within ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  async connect(): Promise<void> {
    if (!isLocalDiagnosticDuelRuntime(process.env)) {
      throw new Error(
        "Standalone Eliza duel bots are restricted to the exact local no-money diagnostic runtime",
      );
    }
    this.state = "connecting";
    const { modelConfig, wsUrl, name, accountId } = this.config;
    const tag = `ElizaDuelBot:${name}`;

    duelLogInfo(
      "ElizaDuelBot",
      `${name} connecting (${modelConfig.displayName} / ${modelConfig.model})...`,
    );

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          duelLogWarn(
            "ElizaDuelBot",
            `${name} retry ${attempt}/${MAX_INIT_RETRIES}...`,
          );
          // Small delay before retry
          await new Promise((r) => setTimeout(r, 2000));
        }

        // Load model-specific plugin (shared helper)
        const modelPlugin = await loadModelPlugin(modelConfig, tag);
        if (!modelPlugin) {
          throw new Error(
            `Failed to load model plugin for ${modelConfig.displayName}`,
          );
        }

        // Generate JWT for authentication
        const authToken = await createJWT({ userId: accountId });

        // Create character using shared helper
        const { character, characterId } = createAgentCharacter(modelConfig, {
          idPrefix: "agent",
          name,
          smallModel: this.config.smallModel,
          secrets: {
            HYPERIA_SERVER_URL: wsUrl,
            HYPERIA_AUTH_TOKEN: authToken,
            HYPERIA_PRIVY_USER_ID: accountId,
            HYPERIA_CHARACTER_ID: "",
            HYPERIA_AUTONOMY_MODE: "llm",
            HYPERIA_AUTO_ACCEPT_DUELS: "true",
          },
        });
        if (character.settings?.secrets) {
          (
            character.settings.secrets as Record<string, string>
          ).HYPERIA_CHARACTER_ID = characterId;
        }

        // Build plugins (no SQL plugin — InMemoryDatabaseAdapter replaces PGLite WASM)
        const plugins: Plugin[] = [modelPlugin, hyperiaPlugin];

        // Create a memory-safe adapter (cap logs)
        const adapter = new InMemoryDatabaseAdapter();
        const adapterWithLogs = adapter as unknown as {
          log?: (params: unknown) => Promise<unknown>;
          logs?: unknown[];
        };
        const MAX_LOGS = 20;
        const origLog = adapterWithLogs.log?.bind(adapter);
        if (origLog) {
          adapterWithLogs.log = async (params: unknown) => {
            await origLog(params);
            const logs = adapterWithLogs.logs;
            if (Array.isArray(logs) && logs.length > MAX_LOGS) {
              logs.splice(0, logs.length - MAX_LOGS);
            }
          };
        }

        // Create runtime with lightweight in-memory adapter (no PGLite WASM overhead)
        this.runtime = new AgentRuntime({
          character,
          plugins,
          adapter,
        });

        // Initialize with timeout to prevent hanging
        const initPromise = this.runtime.initialize();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new Error(
                  `runtime.initialize() timed out after ${INIT_TIMEOUT_MS / 1000}s`,
                ),
              ),
            INIT_TIMEOUT_MS,
          );
        });

        try {
          await Promise.race([initPromise, timeoutPromise]);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        }

        // ElizaOS v2 lazy-starts services — they aren't started during
        // runtime.initialize().  Explicitly ensure HyperiaService is
        // started so the WebSocket connection + player spawn can proceed.
        const runtimeWithService = this.runtime as unknown as {
          _ensureServiceStarted?: (serviceName: string) => Promise<unknown>;
        };
        if (typeof runtimeWithService._ensureServiceStarted === "function") {
          await runtimeWithService._ensureServiceStarted("hyperiaService");
        }

        await this.waitForPlayerSpawnReady(this.config.connectTimeoutMs);

        // Start autonomous behavior so agents mine/chop/fish between duels
        const service = this.getHyperiaService();
        if (service?.startAutonomousBehavior) {
          service.startAutonomousBehavior();
        }

        this._id = characterId;
        this._connected = true;
        this.metrics.isConnected = true;
        this.metrics.connectedAt = Date.now();
        this.state = "idle";

        // Listen for duel events from HyperiaService
        this.setupDuelEventListeners();

        duelLogInfo(
          "ElizaDuelBot",
          `✅ ${name} connected (${modelConfig.displayName}, model: ${modelConfig.model}, id: ${characterId})`,
        );
        this.emit("connected", { name: this.config.name, id: this._id });
        return; // Success — exit retry loop
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        duelLogError(
          "ElizaDuelBot",
          `❌ ${name} init attempt ${attempt + 1} failed: ${lastError.message}`,
        );

        // Stop any partially-initialized runtime
        if (this.runtime) {
          try {
            await this.runtime.stop();
          } catch {
            /* ignore */
          }
          this.runtime = null;
        }
        this._id = null;
      }
    }

    // All retries exhausted
    this.state = "disconnected";
    this._connected = false;
    this.metrics.isConnected = false;
    duelLogError(
      "ElizaDuelBot",
      `❌ ${name} failed to connect after ${MAX_INIT_RETRIES + 1} attempts`,
    );
    throw lastError || new Error(`${name} failed to connect`);
  }

  disconnect(): void {
    this.state = "disconnected";
    this._connected = false;
    this.metrics.isConnected = false;

    // Cancel pending setupDuelEventListeners retry
    if (this.setupRetryTimer) {
      clearTimeout(this.setupRetryTimer);
      this.setupRetryTimer = null;
    }
    this.unregisterDuelEventListeners();

    if (this.runtime) {
      this.runtime.stop().catch((err) => {
        duelLogWarn(
          "ElizaDuelBot",
          `Error stopping runtime for ${this.config.name}:`,
          errMsg(err),
        );
      });
      this.runtime = null;
    }

    this.emit("disconnected", { name: this.config.name });
  }

  /**
   * Challenge another player to a duel.
   * Uses HyperiaService.executeDuelChallenge() via the runtime.
   */
  challengePlayer(targetId: string): void {
    if (this.state !== "idle") {
      duelLogWarn(
        "ElizaDuelBot",
        `${this.config.name} cannot challenge: state=${this.state}`,
      );
      return;
    }

    if (!this.runtime) {
      duelLogWarn("ElizaDuelBot", `${this.config.name} has no runtime`);
      return;
    }

    const service = this.getHyperiaService();
    if (!service?.executeDuelChallenge) {
      duelLogWarn(
        "ElizaDuelBot",
        `${this.config.name} - HyperiaService not available yet`,
      );
      this.state = "idle";
      return;
    }

    if (!service.getPlayerEntity?.()) {
      duelLogWarn(
        "ElizaDuelBot",
        `${this.config.name} cannot challenge before spawn is ready`,
      );
      return;
    }

    this.state = "challenged";
    duelLogInfo("ElizaDuelBot", `${this.config.name} challenging ${targetId}`);

    service
      .executeDuelChallenge({ targetPlayerId: targetId })
      .catch((err: Error) => {
        duelLogWarn(
          "ElizaDuelBot",
          `${this.config.name} challenge failed:`,
          err.message,
        );
        this.state = "idle";
      });
  }

  getPosition(): { x: number; y: number; z: number } | null {
    const service = this.getHyperiaService();
    const playerEntity = service?.getPlayerEntity?.();
    if (!playerEntity) return null;
    const pos = playerEntity.position;
    if (!pos) return null;
    if (Array.isArray(pos)) {
      return { x: pos[0], y: pos[1], z: pos[2] };
    }
    return pos;
  }

  private setupDuelEventListeners(): void {
    if (!this.runtime) return;

    // Guard against duplicate listener registration across reconnects
    if (this.duelListenersRegistered) return;

    const service = this.getHyperiaService();
    if (!service) {
      // Service may not be ready yet — retry after a short delay.
      // Track the timer so disconnect() can cancel it.
      if (this.setupRetryTimer) {
        clearTimeout(this.setupRetryTimer);
      }
      this.setupRetryTimer = setTimeout(() => {
        this.setupRetryTimer = null;
        this.setupDuelEventListeners();
      }, 2000);
      return;
    }

    // Listen for duel state changes via the service's event system.
    // Dedicated duel bots rely on the server-side duel scheduler for prep and
    // combat flow, so do not bootstrap open-world autonomy here.
    if (service.onGameEvent) {
      if (!this.duelFightStartHandler) {
        this.duelFightStartHandler = (data: Record<string, unknown>) => {
          if (this.state === "disconnected") return;
          this.state = "in_duel_fighting";
          this.currentDuelId = (data?.duelId as string) || null;
          this.currentOpponentId = (data?.opponentId as string) || null;
          this.metrics.lastDuelAt = Date.now();
          this.emit("duelStarted", {
            botName: this.config.name,
            duelId: this.currentDuelId,
          });
        };
      }

      if (!this.duelCompletedHandler) {
        this.duelCompletedHandler = (data: Record<string, unknown>) => {
          if (this.state === "disconnected") return;
          const won = data?.winnerId === this._id;
          if (won) {
            this.metrics.wins++;
          } else {
            this.metrics.losses++;
          }
          this.metrics.totalDuels++;
          this.state = "idle";

          this.emit("duelEnded", {
            botName: this.config.name,
            duelId: this.currentDuelId,
            won,
            winnerId: (data?.winnerId as string) || "",
            loserId: (data?.loserId as string) || "",
          });

          this.currentDuelId = null;
          this.currentOpponentId = null;
        };
      }

      service.onGameEvent("DUEL_FIGHT_START", this.duelFightStartHandler);
      service.onGameEvent("DUEL_COMPLETED", this.duelCompletedHandler);
      this.duelListenersRegistered = true;
    }
  }

  private unregisterDuelEventListeners(): void {
    if (!this.runtime || !this.duelListenersRegistered) {
      this.duelListenersRegistered = false;
      return;
    }

    const service = this.getHyperiaService();
    if (service?.offGameEvent) {
      if (this.duelFightStartHandler) {
        service.offGameEvent("DUEL_FIGHT_START", this.duelFightStartHandler);
      }
      if (this.duelCompletedHandler) {
        service.offGameEvent("DUEL_COMPLETED", this.duelCompletedHandler);
      }
    }

    this.duelListenersRegistered = false;
  }
}
