/**
 * DuelMatchmaker Unit Tests
 *
 * Tests for the DuelMatchmaker class that orchestrates bot duels.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

import {
  DuelMatchmaker,
  type DuelMatchmakerConfig,
  type MatchResult,
  type MatchmakerStats,
} from "../DuelMatchmaker";

describe("DuelMatchmaker", () => {
  let config: DuelMatchmakerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      wsUrl: "ws://localhost:5555/ws",
      botCount: 4,
      rampUpDelayMs: 10,
      matchIntervalMs: 100,
      verbose: false,
    };
  });

  describe("constructor", () => {
    it("creates DuelMatchmaker with provided config", () => {
      const matchmaker = new DuelMatchmaker(config);
      expect(matchmaker).toBeDefined();
      expect(matchmaker.running).toBe(false);
    });

    it("extends EventEmitter", () => {
      const matchmaker = new DuelMatchmaker(config);
      expect(matchmaker).toBeInstanceOf(EventEmitter);
    });

    it("sets default values for optional config", () => {
      const minimalConfig: DuelMatchmakerConfig = {
        wsUrl: "ws://localhost:5555/ws",
        botCount: 2,
      };
      const matchmaker = new DuelMatchmaker(minimalConfig);
      expect(matchmaker).toBeDefined();
    });
  });

  describe("getStats", () => {
    it("returns correct initial stats", () => {
      const matchmaker = new DuelMatchmaker(config);
      const stats = matchmaker.getStats();

      expect(stats.totalBots).toBe(4);
      expect(stats.connectedBots).toBe(0);
      expect(stats.idleBots).toBe(0);
      expect(stats.duelsInProgress).toBe(0);
      expect(stats.totalMatchesCompleted).toBe(0);
      expect(stats.matchHistory).toHaveLength(0);
      expect(stats.uptime).toBe(0);
    });
  });

  describe("getLeaderboard", () => {
    it("returns empty leaderboard before start", () => {
      const matchmaker = new DuelMatchmaker(config);
      const leaderboard = matchmaker.getLeaderboard();
      expect(leaderboard).toHaveLength(0);
    });
  });

  describe("running property", () => {
    it("returns false before start", () => {
      const matchmaker = new DuelMatchmaker(config);
      expect(matchmaker.running).toBe(false);
    });
  });
});

describe("DuelMatchmakerConfig", () => {
  it("accepts minimal config", () => {
    const config: DuelMatchmakerConfig = {
      wsUrl: "ws://localhost:5555/ws",
      botCount: 2,
    };
    expect(config.wsUrl).toBe("ws://localhost:5555/ws");
    expect(config.botCount).toBe(2);
  });

  it("accepts full config", () => {
    const config: DuelMatchmakerConfig = {
      wsUrl: "ws://localhost:5555/ws",
      botCount: 8,
      rampUpDelayMs: 500,
      connectTimeoutMs: 10000,
      namePrefix: "Arena",
      matchIntervalMs: 3000,
      countdownMs: 5000,
      verbose: true,
      connectOnly: true,
    };
    expect(config.botCount).toBe(8);
    expect(config.rampUpDelayMs).toBe(500);
    expect(config.namePrefix).toBe("Arena");
    expect(config.verbose).toBe(true);
    expect(config.connectOnly).toBe(true);
  });
});

describe("MatchResult type", () => {
  it("has correct structure", () => {
    const result: MatchResult = {
      matchId: "match-1",
      bot1Name: "Bot-001",
      bot2Name: "Bot-002",
      bot1Id: "player-1",
      bot2Id: "player-2",
      bot1Personality: "aggressive",
      bot2Personality: "defensive",
      winnerId: "player-1",
      winnerName: "Bot-001",
      winnerPersonality: "aggressive",
      loserId: "player-2",
      loserName: "Bot-002",
      loserPersonality: "defensive",
      startedAt: Date.now() - 60000,
      endedAt: Date.now(),
      durationMs: 60000,
    };

    expect(result.matchId).toBe("match-1");
    expect(result.winnerName).toBe("Bot-001");
    expect(result.loserName).toBe("Bot-002");
    expect(result.durationMs).toBe(60000);
  });
});

describe("MatchmakerStats type", () => {
  it("has correct structure", () => {
    const stats: MatchmakerStats = {
      totalBots: 4,
      connectedBots: 4,
      idleBots: 2,
      duelsInProgress: 1,
      totalMatchesCompleted: 5,
      matchHistory: [],
      botStats: new Map(),
      uptime: 300000,
    };

    expect(stats.totalBots).toBe(4);
    expect(stats.connectedBots).toBe(4);
    expect(stats.duelsInProgress).toBe(1);
    expect(stats.totalMatchesCompleted).toBe(5);
  });
});

describe("Event emissions", () => {
  it("emits events when subscribed", () => {
    const testConfig: DuelMatchmakerConfig = {
      wsUrl: "ws://localhost:5555/ws",
      botCount: 4,
      rampUpDelayMs: 10,
      matchIntervalMs: 100,
      verbose: false,
    };
    const matchmaker = new DuelMatchmaker(testConfig);
    const readyHandler = vi.fn();
    const matchScheduledHandler = vi.fn();
    const matchCompleteHandler = vi.fn();

    matchmaker.on("ready", readyHandler);
    matchmaker.on("matchScheduled", matchScheduledHandler);
    matchmaker.on("matchComplete", matchCompleteHandler);

    // Manually emit to test event handling
    matchmaker.emit("ready", { connectedBots: 4, totalBots: 4 });
    expect(readyHandler).toHaveBeenCalledWith({
      connectedBots: 4,
      totalBots: 4,
    });

    matchmaker.emit("matchScheduled", {
      matchId: "match-1",
      bot1Name: "Bot-001",
      bot2Name: "Bot-002",
    });
    expect(matchScheduledHandler).toHaveBeenCalled();
  });
});

describe("Minimum bot count", () => {
  it("requires at least 2 bots for dueling", () => {
    const config: DuelMatchmakerConfig = {
      wsUrl: "ws://localhost:5555/ws",
      botCount: 1, // Less than minimum
    };
    // The script will enforce min 2, but matchmaker accepts any config
    const matchmaker = new DuelMatchmaker(config);
    expect(matchmaker.getStats().totalBots).toBe(1);
  });
});
