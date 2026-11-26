/**
 * ElizaDuelMatchmaker - Orchestrates continuous agent-vs-agent duels
 * using real ElizaOS LLM agents.
 *
 * Drop-in replacement for DuelMatchmaker that uses ElizaDuelBot
 * (ElizaOS AgentRuntime) instead of hardcoded DuelBot scripts.
 *
 * Each agent uses a different AI model for TEXT_LARGE decisions
 * and a cheap small model for TEXT_SMALL.
 */

import { EventEmitter } from "events";
import {
  ElizaDuelBot,
  type ElizaDuelBotConfig,
  type ElizaDuelBotMetrics,
  MODEL_AGENTS,
} from "./ElizaDuelBot.js";
import type { ModelProviderConfig } from "./ModelAgentSpawner.js";
import {
  duelLogError,
  duelLogInfo,
  duelLogWarn,
  isDuelLogLevelEnabled,
} from "./logging.js";

export type ElizaDuelMatchmakerConfig = {
  wsUrl: string;
  /** Number of bots to spawn (capped to available model configs) */
  botCount: number;
  /** Delay between bot connections during startup (ms) */
  rampUpDelayMs?: number;
  /** Connection timeout per bot (ms) */
  connectTimeoutMs?: number;
  /** Delay between scheduling new matches (ms) */
  matchIntervalMs?: number;
  /** Connect bots only and let the server own duel scheduling */
  connectOnly?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Override model configs (defaults to MODEL_AGENTS) */
  modelConfigs?: ModelProviderConfig[];
};

export type MatchResult = {
  matchId: string;
  bot1Name: string;
  bot2Name: string;
  bot1Id: string;
  bot2Id: string;
  winnerId: string;
  winnerName: string;
  loserId: string;
  loserName: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

type ActiveMatch = {
  matchId: string;
  bot1: ElizaDuelBot;
  bot2: ElizaDuelBot;
  startedAt: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Maximum match history entries to retain in memory */
const MAX_MATCH_HISTORY = 200;

/** Maximum reconnection attempts per bot before giving up */
const MAX_RECONNECT_ATTEMPTS = 8;

export class ElizaDuelMatchmaker extends EventEmitter {
  private config: Required<
    Pick<
      ElizaDuelMatchmakerConfig,
      | "wsUrl"
      | "botCount"
      | "rampUpDelayMs"
      | "connectTimeoutMs"
      | "matchIntervalMs"
      | "connectOnly"
      | "verbose"
    >
  > & { modelConfigs: ModelProviderConfig[] };
  private bots: ElizaDuelBot[] = [];
  private activeMatches: Map<string, ActiveMatch> = new Map();
  private matchHistory: MatchResult[] = [];
  private totalMatchesCompleted = 0;
  private isRunning = false;
  private startTime = 0;
  private matchSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private matchIdCounter = 0;
  /** Tracked reconnect timers per bot so they can be cancelled on stop */
  private reconnectTimers: Map<ElizaDuelBot, ReturnType<typeof setTimeout>> =
    new Map();
  /** Per-bot reconnect attempt counter */
  private reconnectAttempts: Map<ElizaDuelBot, number> = new Map();
  /** Tracked initial scheduling timeout */
  private initialScheduleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ElizaDuelMatchmakerConfig) {
    super();

    // Filter MODEL_AGENTS to only those with available API keys
    const availableModels = (config.modelConfigs || MODEL_AGENTS).filter(
      (m) => process.env[m.apiKeyEnv],
    );

    if (availableModels.length < 2) {
      throw new Error(
        `ElizaDuelMatchmaker requires at least 2 configured model agents; found ${availableModels.length}. Configure a supported provider credential or use the deterministic local duel-agent fallback.`,
      );
    }

    // Cap bot count to available models
    const effectiveBotCount = Math.min(config.botCount, availableModels.length);

    this.config = {
      wsUrl: config.wsUrl,
      botCount: effectiveBotCount,
      rampUpDelayMs: config.rampUpDelayMs ?? 1500,
      connectTimeoutMs: config.connectTimeoutMs ?? 30000,
      matchIntervalMs: config.matchIntervalMs ?? 10000,
      connectOnly: config.connectOnly ?? false,
      verbose: config.verbose ?? false,
      modelConfigs: availableModels.slice(0, effectiveBotCount),
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) throw new Error("Matchmaker is already running");

    this.isRunning = true;
    this.startTime = Date.now();
    this.bots = [];
    this.activeMatches.clear();
    this.matchHistory = [];
    this.totalMatchesCompleted = 0;

    duelLogInfo(
      "ElizaDuelMatchmaker",
      `Starting ${this.config.botCount} ElizaOS duel bots...`,
    );
    duelLogInfo(
      "ElizaDuelMatchmaker",
      `Models: ${this.config.modelConfigs.map((m) => m.displayName).join(", ")}`,
    );

    await this.spawnBots();
    if (!this.config.connectOnly) {
      this.startMatchScheduler();
    }
    this.statsTimer = setInterval(() => this.logStats(), 15000);

    const connectedCount = this.getConnectedBots().length;
    duelLogInfo(
      "ElizaDuelMatchmaker",
      `Ready. ${connectedCount}/${this.config.botCount} bots connected.`,
    );
    this.emit("ready", {
      connectedBots: connectedCount,
      totalBots: this.config.botCount,
    });
  }

  private async spawnBots(): Promise<void> {
    const { wsUrl, rampUpDelayMs, connectTimeoutMs, modelConfigs } =
      this.config;

    for (let i = 0; i < modelConfigs.length && this.isRunning; i++) {
      const modelConfig = modelConfigs[i];

      const botConfig: ElizaDuelBotConfig = {
        wsUrl,
        name: modelConfig.displayName,
        modelConfig,
        connectTimeoutMs,
      };

      const bot = new ElizaDuelBot(botConfig);
      this.setupBotListeners(bot);
      this.bots.push(bot);

      try {
        await bot.connect();
        duelLogInfo("ElizaDuelMatchmaker", `${bot.name} connected`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        duelLogError(
          "ElizaDuelMatchmaker",
          `${bot.name} failed: ${error.message}`,
        );
      }

      if (rampUpDelayMs > 0 && i < modelConfigs.length - 1) {
        await sleep(rampUpDelayMs);
      }
    }
  }

  private setupBotListeners(bot: ElizaDuelBot): void {
    bot.on("connected", (data: { name: string; id: string | null }) => {
      this.emit("botConnected", data);
    });

    bot.on("disconnected", (data: { name: string }) => {
      this.emit("botDisconnected", data);
      // Remove from active matches if involved
      for (const [matchId, match] of this.activeMatches) {
        if (match.bot1 === bot || match.bot2 === bot) {
          this.activeMatches.delete(matchId);
          duelLogWarn(
            "ElizaDuelMatchmaker",
            `Match ${matchId} cancelled: bot disconnected`,
          );
        }
      }

      // Connection recovery with exponential backoff.
      // Track the timer so stop() can cancel it.
      if (this.isRunning) {
        let backoff = 3000;
        const attempts = (this.reconnectAttempts.get(bot) ?? 0) + 1;
        this.reconnectAttempts.set(bot, attempts);

        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          duelLogError(
            "ElizaDuelMatchmaker",
            `${bot.name} exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts, giving up`,
          );
          this.reconnectTimers.delete(bot);
          this.reconnectAttempts.delete(bot);
          return;
        }

        const attemptReconnect = async () => {
          this.reconnectTimers.delete(bot);
          if (!this.isRunning || bot.connected) return;
          try {
            duelLogInfo(
              "ElizaDuelMatchmaker",
              `Attempting reconnect for ${bot.name} (${this.reconnectAttempts.get(bot) ?? 0}/${MAX_RECONNECT_ATTEMPTS})...`,
            );
            await bot.connect();
            // Reset counter on successful reconnect
            this.reconnectAttempts.delete(bot);
            duelLogInfo("ElizaDuelMatchmaker", `${bot.name} reconnected`);
          } catch (err) {
            if (!this.isRunning) return;
            const nextAttempts = (this.reconnectAttempts.get(bot) ?? 0) + 1;
            this.reconnectAttempts.set(bot, nextAttempts);

            if (nextAttempts > MAX_RECONNECT_ATTEMPTS) {
              duelLogError(
                "ElizaDuelMatchmaker",
                `${bot.name} exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts, giving up`,
              );
              this.reconnectAttempts.delete(bot);
              return;
            }

            duelLogWarn(
              "ElizaDuelMatchmaker",
              `${bot.name} reconnect failed (${nextAttempts}/${MAX_RECONNECT_ATTEMPTS}), retrying in ${backoff}ms`,
            );
            const timer = setTimeout(attemptReconnect, backoff);
            this.reconnectTimers.set(bot, timer);
            backoff = Math.min(backoff * 2, 30_000);
          }
        };
        const timer = setTimeout(attemptReconnect, backoff);
        this.reconnectTimers.set(bot, timer);
      }
    });

    bot.on(
      "duelStarted",
      (data: { botName: string; duelId: string | null }) => {
        if (this.config.verbose && isDuelLogLevelEnabled("info")) {
          duelLogInfo(
            "ElizaDuelMatchmaker",
            `${data.botName} started duel ${data.duelId}`,
          );
        }
      },
    );

    bot.on(
      "duelEnded",
      (data: {
        botName: string;
        duelId: string;
        won: boolean;
        winnerId: string;
        loserId: string;
      }) => {
        this.handleDuelEnded(bot, data);
      },
    );
  }

  private handleDuelEnded(
    bot: ElizaDuelBot,
    data: {
      botName: string;
      duelId: string;
      won: boolean;
      winnerId: string;
      loserId: string;
    },
  ): void {
    let matchResult: ActiveMatch | null = null;
    for (const [matchId, match] of this.activeMatches) {
      if (match.bot1 === bot || match.bot2 === bot) {
        matchResult = match;
        this.activeMatches.delete(matchId);
        break;
      }
    }

    if (matchResult) {
      const winner =
        matchResult.bot1.getId() === data.winnerId
          ? matchResult.bot1
          : matchResult.bot2;
      const loser =
        matchResult.bot1.getId() === data.loserId
          ? matchResult.bot1
          : matchResult.bot2;

      const result: MatchResult = {
        matchId: matchResult.matchId,
        bot1Name: matchResult.bot1.name,
        bot2Name: matchResult.bot2.name,
        bot1Id: matchResult.bot1.getId() || "",
        bot2Id: matchResult.bot2.getId() || "",
        winnerId: data.winnerId,
        winnerName: winner.name,
        loserId: data.loserId,
        loserName: loser.name,
        startedAt: matchResult.startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - matchResult.startedAt,
      };

      this.matchHistory.push(result);
      if (this.matchHistory.length > MAX_MATCH_HISTORY) {
        this.matchHistory = this.matchHistory.slice(-MAX_MATCH_HISTORY);
      }
      this.totalMatchesCompleted++;

      duelLogInfo(
        "ElizaDuelMatchmaker",
        `Match ${result.matchId}: ${result.winnerName} defeated ${result.loserName} (${Math.round(result.durationMs / 1000)}s)`,
      );

      this.emit("matchComplete", result);
    }
  }

  private startMatchScheduler(): void {
    if (this.config.connectOnly) return;
    if (this.matchSchedulerTimer) return;

    this.matchSchedulerTimer = setInterval(() => {
      this.scheduleMatches();
    }, this.config.matchIntervalMs);

    // Initial scheduling after a delay for bots to fully connect
    this.initialScheduleTimer = setTimeout(() => {
      this.initialScheduleTimer = null;
      this.scheduleMatches();
    }, 5000);
  }

  private scheduleMatches(): void {
    if (this.config.connectOnly) return;
    if (!this.isRunning) return;

    let idleBots = this.getIdleBots().filter((b) => b.getId() != null);

    // Sort by win rate for Elo-approximate matchmaking
    idleBots.sort((a, b) => {
      const aWr =
        a.metrics.totalDuels > 0 ? a.metrics.wins / a.metrics.totalDuels : 0.5;
      const bWr =
        b.metrics.totalDuels > 0 ? b.metrics.wins / b.metrics.totalDuels : 0.5;
      return bWr - aWr;
    });

    while (idleBots.length >= 2) {
      const bot1 = idleBots.shift()!;
      const bot2 = idleBots.shift()!;
      this.startMatch(bot1, bot2);
    }
  }

  private startMatch(bot1: ElizaDuelBot, bot2: ElizaDuelBot): void {
    const matchId = `match-${++this.matchIdCounter}`;

    duelLogInfo(
      "ElizaDuelMatchmaker",
      `Scheduling ${matchId}: ${bot1.name} vs ${bot2.name}`,
    );

    const match: ActiveMatch = {
      matchId,
      bot1,
      bot2,
      startedAt: Date.now(),
    };

    this.activeMatches.set(matchId, match);

    this.emit("matchScheduled", {
      matchId,
      bot1Name: bot1.name,
      bot1Id: bot1.getId(),
      bot2Name: bot2.name,
      bot2Id: bot2.getId(),
      bot1Stats: bot1.metrics,
      bot2Stats: bot2.metrics,
    });

    const targetId = bot2.getId();
    if (targetId) {
      bot1.challengePlayer(targetId);
    } else {
      duelLogWarn(
        "ElizaDuelMatchmaker",
        `Cannot start match: ${bot2.name} has no ID`,
      );
      this.activeMatches.delete(matchId);
    }
  }

  private getConnectedBots(): ElizaDuelBot[] {
    return this.bots.filter((bot) => bot.connected);
  }

  private getIdleBots(): ElizaDuelBot[] {
    return this.bots.filter((bot) => bot.connected && bot.state === "idle");
  }

  private logStats(): void {
    const stats = this.getStats();
    duelLogInfo("ElizaDuelMatchmaker", "Stats", {
      connected: `${stats.connectedBots}/${stats.totalBots}`,
      idle: stats.idleBots,
      inProgress: stats.duelsInProgress,
      completed: stats.totalMatchesCompleted,
      uptime: `${Math.round(stats.uptime / 1000)}s`,
    });
  }

  getStats(): {
    totalBots: number;
    connectedBots: number;
    idleBots: number;
    duelsInProgress: number;
    totalMatchesCompleted: number;
    matchHistory: MatchResult[];
    botStats: Map<string, ElizaDuelBotMetrics>;
    uptime: number;
  } {
    const connectedBots = this.getConnectedBots();
    const idleBots = this.getIdleBots();
    const botStats = new Map<string, ElizaDuelBotMetrics>();

    for (const bot of this.bots) {
      botStats.set(bot.name, bot.metrics);
    }

    return {
      totalBots: this.config.botCount,
      connectedBots: connectedBots.length,
      idleBots: idleBots.length,
      duelsInProgress: this.activeMatches.size,
      totalMatchesCompleted: this.totalMatchesCompleted,
      matchHistory: [...this.matchHistory],
      botStats,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
    };
  }

  getLeaderboard(): {
    name: string;
    wins: number;
    losses: number;
    winRate: number;
  }[] {
    return this.bots
      .map((bot) => ({
        name: bot.name,
        wins: bot.metrics.wins,
        losses: bot.metrics.losses,
        winRate:
          bot.metrics.totalDuels > 0
            ? (bot.metrics.wins / bot.metrics.totalDuels) * 100
            : 0,
      }))
      .sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        return b.winRate - a.winRate;
      });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    duelLogInfo("ElizaDuelMatchmaker", "Stopping...");
    this.isRunning = false;

    if (this.matchSchedulerTimer) {
      clearInterval(this.matchSchedulerTimer);
      this.matchSchedulerTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.initialScheduleTimer) {
      clearTimeout(this.initialScheduleTimer);
      this.initialScheduleTimer = null;
    }

    // Cancel all pending reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    // Disconnect bots and remove all listeners to break reference cycles
    for (const bot of this.bots) {
      bot.disconnect();
      bot.removeAllListeners();
    }

    this.bots = [];
    this.activeMatches.clear();

    duelLogInfo("ElizaDuelMatchmaker", "Stopped.");
    this.emit("stopped", { totalMatches: this.totalMatchesCompleted });
  }

  get running(): boolean {
    return this.isRunning;
  }
}

export default ElizaDuelMatchmaker;
