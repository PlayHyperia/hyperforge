import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import {
  buildBettingFeedDedupKey,
  buildBettingFeedPayload,
  selectReplayDelivery,
} from "../../../src/routes/streaming-betting-feed.js";
import type { BettingFeedFrame } from "../../../src/routes/streaming-betting-feed.js";
import type { StreamingDuelCycle } from "../../../src/systems/StreamingDuelScheduler/types.js";
import { serializeBettingFeedSchemaV3ContractFixture } from "../../../scripts/generate-betting-feed-schema-v3-fixtures.js";
import { deriveBettingRendererHealth } from "../../../src/routes/streaming-betting-health.js";

function createCycle(
  overrides: Partial<StreamingDuelCycle> = {},
): StreamingDuelCycle {
  return {
    cycleId: "cycle-1",
    phase: "ANNOUNCEMENT",
    cycleStartTime: 1_000,
    phaseStartTime: 1_000,
    phaseVersion: 2,
    agent1: {
      characterId: "agent-a",
      name: "Agent A",
      provider: "provider-a",
      model: "model-a",
      combatLevel: 10,
      wins: 7,
      losses: 2,
      currentHp: 25,
      maxHp: 30,
      originalPosition: [1, 2, 3],
      damageDealtThisFight: 4,
      equipment: {},
      inventory: [],
      rank: 1,
      headToHeadWins: 3,
      headToHeadLosses: 1,
    },
    agent2: {
      characterId: "agent-b",
      name: "Agent B",
      provider: "provider-b",
      model: "model-b",
      combatLevel: 11,
      wins: 5,
      losses: 4,
      currentHp: 20,
      maxHp: 30,
      originalPosition: [4, 5, 6],
      damageDealtThisFight: 2,
      equipment: {},
      inventory: [],
      rank: 2,
      headToHeadWins: 1,
      headToHeadLosses: 3,
    },
    duelId: "duel-1",
    duelKeyHex: "0xabcdef",
    competitiveSnapshotVersion: null,
    competitiveSnapshotDigest: null,
    competitiveSnapshot: null,
    arenaId: null,
    betOpenTime: 1_000,
    betCloseTime: 2_000,
    countdownValue: null,
    fightStartTime: null,
    duelEndTime: null,
    arenaPositions: {
      agent1: [10, 11, 12],
      agent2: [20, 21, 22],
    },
    winnerId: null,
    loserId: null,
    outcome: null,
    winReason: null,
    seed: null,
    replayHash: null,
    ...overrides,
  };
}

function createFrame(seq: number): BettingFeedFrame {
  const payload = buildBettingFeedPayload({
    sourceEpoch: 9_999,
    seq,
    emittedAt: 10_000 + seq,
    rendererHealth: {
      ready: seq % 2 === 0,
      degradedReason: seq % 2 === 0 ? null : "loading_overlay_active",
      updatedAt: 10_500 + seq,
    },
    cycle: createCycle({
      phaseVersion: seq,
      winnerId: seq % 2 === 0 ? "agent-a" : "agent-b",
      duelEndTime: seq % 2 === 0 ? 20_000 : 21_000,
      winReason: seq % 2 === 0 ? "kill" : "hp_advantage",
    }),
  });
  return {
    seq,
    emittedAt: 10_000 + seq,
    payload,
    payloadJson: JSON.stringify(payload),
    payloadBytes: 0,
  };
}

describe("streaming-betting-feed", () => {
  it("retains frame-local health derivation without changing material deduplication", () => {
    const cycle = createCycle();
    const health = deriveBettingRendererHealth(cycle, {
      nowMs: 10_000,
      captureStats: { clientConnected: true, ffmpegRunning: true },
    });
    const payload = buildBettingFeedPayload({
      sourceEpoch: 9_999,
      seq: 1,
      emittedAt: 10_000,
      cycle,
      rendererHealth: health,
    });
    expect(
      JSON.parse(JSON.stringify(payload)).rendererHealth.derivation,
    ).toEqual(health.derivation);
    const refreshed = {
      ...payload,
      seq: 2,
      emittedAt: 11_000,
      rendererHealth: deriveBettingRendererHealth(cycle, {
        nowMs: 11_000,
        captureStats: { clientConnected: true, ffmpegRunning: true },
      }),
    };
    expect(buildBettingFeedDedupKey(refreshed)).toBe(
      buildBettingFeedDedupKey(payload),
    );
    expect(
      buildBettingFeedDedupKey({
        ...refreshed,
        rendererHealth: {
          ...refreshed.rendererHealth,
          ready: false,
          degradedReason: "capture_process_exited",
        },
      }),
    ).not.toBe(buildBettingFeedDedupKey(payload));
    expect(payload.rendererHealth?.derivation?.evaluatedAtMs).toBe(
      payload.emittedAt,
    );
    expect(refreshed.rendererHealth.derivation?.evaluatedAtMs).toBe(
      refreshed.emittedAt,
    );
  });

  it("keeps the checked-in Hyperbet schema-v3 contract fixture aligned with the production producer", () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../fixtures/hyperbet/betting-feed-schema-v3.json",
        import.meta.url,
      ),
    );

    expect(readFileSync(fixturePath, "utf8")).toBe(
      serializeBettingFeedSchemaV3ContractFixture(),
    );
  });

  it("publishes the exact frozen strategy without private planning fields", () => {
    const fixture = JSON.parse(
      serializeBettingFeedSchemaV3ContractFixture(),
    ) as {
      cases: Array<{
        name: string;
        payload: {
          agent1: { strategySummary: Record<string, unknown> | null } | null;
        };
      }>;
    };
    const announcement = fixture.cases.find(
      (entry) => entry.name === "announcement",
    );
    const strategySummary = announcement?.payload.agent1?.strategySummary;

    expect(strategySummary).toEqual({
      schemaVersion: 1,
      approach: "balanced",
      tacticalMacro: "pressure",
      attackStyle: "aggressive",
      prayer: "superhuman_strength",
      preferredCombatRole: null,
      foodThreshold: 40,
      switchDefensiveAt: 30,
      source: "deterministic",
      policyVersion: "fixture-policy-v1",
    });
    expect(Object.keys(strategySummary ?? {}).sort()).toEqual([
      "approach",
      "attackStyle",
      "foodThreshold",
      "policyVersion",
      "prayer",
      "preferredCombatRole",
      "schemaVersion",
      "source",
      "switchDefensiveAt",
      "tacticalMacro",
    ]);
    expect(strategySummary).not.toHaveProperty("reasoning");
    expect(strategySummary).not.toHaveProperty("agentPolicyFingerprint");
    expect(strategySummary).not.toHaveProperty("modelProvider");
  });

  it("builds betting payloads with stable schema and phase version data", () => {
    const payload = buildBettingFeedPayload({
      sourceEpoch: 42,
      seq: 7,
      emittedAt: 123_456,
      rendererHealth: {
        ready: false,
        degradedReason: "loading_overlay_active",
        updatedAt: 123_500,
      },
      cycle: createCycle({
        phase: "FIGHTING",
        phaseVersion: 9,
        winnerId: "agent-b",
        winReason: "damage_advantage",
      }),
    });

    expect(payload).toMatchObject({
      schemaVersion: 3,
      sourceEpoch: 42,
      seq: 7,
      emittedAt: 123_456,
      duelId: "duel-1",
      duelKey: "0xabcdef",
      phase: "FIGHTING",
      phaseVersion: 9,
      betOpenTime: 1_000,
      betCloseTime: 2_000,
      fightStartTime: null,
      duelEndTime: null,
      winnerId: "agent-b",
      winnerName: "Agent B",
      outcome: null,
      cancellationReason: null,
      winReason: "damage_advantage",
      seed: null,
      replayHash: null,
      arenaPositions: {
        agent1: [10, 11, 12],
        agent2: [20, 21, 22],
      },
      rendererHealth: {
        ready: false,
        degradedReason: "loading_overlay_active",
        updatedAt: 123_500,
      },
    });

    expect(payload.agent1?.id).toBe("agent-a");
    expect(payload.agent2?.hp).toBe(20);
  });

  it("builds a durable cancelled terminal payload from the captured cycle", () => {
    const payload = buildBettingFeedPayload({
      sourceEpoch: 42,
      seq: 8,
      emittedAt: 123_456,
      cycle: createCycle({ phase: "FIGHTING" }),
      terminal: {
        outcome: "cancelled",
        cancellationReason: "combat_engagement_failed",
        duelEndTime: 123_456,
      },
    });

    expect(payload).toMatchObject({
      schemaVersion: 3,
      duelId: "duel-1",
      duelKey: "0xabcdef",
      phase: "FIGHTING",
      duelEndTime: 123_456,
      winnerId: null,
      winnerName: null,
      outcome: "cancelled",
      cancellationReason: "combat_engagement_failed",
    });
  });

  it("selects replay, bootstrap, and reset delivery modes deterministically", () => {
    const frames = [createFrame(1), createFrame(2), createFrame(3)];

    expect(selectReplayDelivery(frames, 0)).toMatchObject({
      mode: "bootstrap",
      latestFrame: frames[2],
      oldestSeq: 1,
    });

    expect(selectReplayDelivery(frames, 2)).toMatchObject({
      mode: "replay",
      frames: [frames[2]],
      latestFrame: frames[2],
      oldestSeq: 1,
    });

    expect(selectReplayDelivery(frames, 3)).toMatchObject({
      mode: "live",
      latestFrame: frames[2],
      oldestSeq: 1,
    });

    expect(selectReplayDelivery(frames, 99)).toMatchObject({
      mode: "reset",
      latestFrame: frames[2],
      oldestSeq: 1,
    });
  });

  it("requests a reset when the replay gap is larger than the buffer", () => {
    const frames = [createFrame(10), createFrame(11), createFrame(12)];

    expect(selectReplayDelivery(frames, 2)).toMatchObject({
      mode: "reset",
      latestFrame: frames[2],
      oldestSeq: 10,
    });
  });

  it("deduplicates independently of transport sequence and timestamps", () => {
    const basePayload = buildBettingFeedPayload({
      sourceEpoch: 42,
      seq: 7,
      emittedAt: 123_456,
      cycle: createCycle(),
      rendererHealth: {
        ready: true,
        degradedReason: null,
        updatedAt: 123_400,
      },
    });
    const laterPayload = {
      ...basePayload,
      seq: 8,
      emittedAt: 999_999,
      rendererHealth: basePayload.rendererHealth
        ? {
            ...basePayload.rendererHealth,
            updatedAt: 555_555,
          }
        : null,
    };

    expect(buildBettingFeedDedupKey(basePayload)).toBe(
      buildBettingFeedDedupKey(laterPayload),
    );
  });

  it("handles empty replay buffers cleanly", () => {
    expect(selectReplayDelivery([], 0)).toMatchObject({
      mode: "bootstrap",
      latestFrame: null,
      oldestSeq: null,
    });
  });

  it("replays all buffered frames when the caller is exactly at the oldest boundary", () => {
    const frames = [createFrame(10), createFrame(11), createFrame(12)];

    expect(selectReplayDelivery(frames, 10)).toMatchObject({
      mode: "replay",
      frames: [frames[1], frames[2]],
      latestFrame: frames[2],
      oldestSeq: 10,
    });
  });
});
