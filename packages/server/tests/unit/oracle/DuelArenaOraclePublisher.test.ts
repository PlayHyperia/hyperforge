import "../../../src/shared/polyfills.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuelArenaOraclePublisher } from "../../../src/oracle/DuelArenaOraclePublisher.js";
import type {
  DuelArenaOracleAbortEvent,
  DuelArenaOracleConfig,
  DuelArenaOracleResolutionEvent,
  DuelArenaOracleRecord,
} from "../../../src/oracle/types.js";
import type { World } from "@hyperforge/shared";

vi.mock("@hyperforge/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyperforge/shared")>();
  return {
    ...actual,
    AVATAR_OPTIONS: [{ id: "steve", url: "/avatars/steve.vrm" }],
    DEFAULT_AVATAR_URL: "/avatars/steve.vrm",
  };
});

vi.mock("@solana/web3.js", async () => ({
  Connection: vi.fn(),
  Keypair: {
    fromSecretKey: vi.fn(),
  },
  PublicKey: vi.fn(),
}));

vi.mock("../../../src/systems/ServerNetwork/services/index.js", () => ({
  Logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type OracleCycle = {
  cycleId: string;
  phase: string;
  duelId: string;
  duelKeyHex: string;
  agent1: { characterId: string; name: string };
  agent2: { characterId: string; name: string };
  betOpenTime: number;
  betCloseTime: number;
  phaseStartTime: number;
  duelEndTime: number | null;
  outcome: "win" | "draw" | null;
  winnerId: string | null;
  loserId: string | null;
  seed: string | null;
  replayHash: string | null;
};

type PublisherHarness = {
  records: Map<string, DuelArenaOracleRecord>;
  solanaTargets: Array<{
    key: string;
    label: string;
    publishResolution(record: DuelArenaOracleRecord): Promise<string>;
  }>;
  persistRecords(): Promise<void>;
  publishAcrossTargets(
    record: DuelArenaOracleRecord,
    action: "UPSERT" | "RESOLVE" | "CANCEL",
  ): Promise<void>;
  handleAnnouncement(payload: unknown): Promise<void>;
  handleFightStart(payload: unknown): Promise<void>;
  handleResolution(payload: unknown): Promise<void>;
  handleAbort(payload: unknown): Promise<void>;
};

const DUEL_KEY = "a".repeat(64);
const REPLAY_HASH = "b".repeat(64);

function makeCycle(overrides: Partial<OracleCycle> = {}): OracleCycle {
  return {
    cycleId: "cycle-123",
    phase: "RESOLUTION",
    duelId: "duel-123",
    duelKeyHex: DUEL_KEY,
    agent1: { characterId: "agent-a", name: "Agent A" },
    agent2: { characterId: "agent-b", name: "Agent B" },
    betOpenTime: 100,
    betCloseTime: 500,
    phaseStartTime: 600,
    duelEndTime: 1_000,
    outcome: "win",
    winnerId: "agent-a",
    loserId: "agent-b",
    seed: "123456789",
    replayHash: REPLAY_HASH,
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<DuelArenaOracleRecord> = {},
): DuelArenaOracleRecord {
  return {
    duelId: "duel-123",
    cycleId: "cycle-123",
    duelKeyHex: DUEL_KEY,
    status: "LOCKED",
    metadataUri: "http://localhost:5555/duels/duel-123",
    participantA: {
      id: "agent-a",
      name: "Agent A",
      hashHex: "c".repeat(64),
    },
    participantB: {
      id: "agent-b",
      name: "Agent B",
      hashHex: "d".repeat(64),
    },
    betOpenTime: 100,
    betCloseTime: 500,
    fightStartTime: 600,
    duelEndTime: null,
    winnerId: null,
    loserId: null,
    winnerSide: null,
    winnerName: null,
    loserName: null,
    winReason: null,
    seed: null,
    replayHashHex: null,
    resultHashHex: null,
    chainState: {},
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeResolution(
  overrides: Partial<DuelArenaOracleResolutionEvent> = {},
): DuelArenaOracleResolutionEvent {
  return {
    cycleId: "cycle-123",
    duelId: "duel-123",
    duelKeyHex: DUEL_KEY,
    duelEndTime: 1_000,
    outcome: "win",
    winnerId: "agent-a",
    loserId: "agent-b",
    winnerName: "Agent A",
    loserName: "Agent B",
    winReason: "kill",
    seed: "123456789",
    replayHash: REPLAY_HASH,
    ...overrides,
  };
}

function makeAbort(
  overrides: Partial<DuelArenaOracleAbortEvent> = {},
): DuelArenaOracleAbortEvent {
  return {
    cycleId: "cycle-123",
    duelId: "duel-123",
    duelKeyHex: DUEL_KEY,
    reason: "no_combat_activity",
    agent1Id: "agent-a",
    agent2Id: "agent-b",
    agent1Name: "Agent A",
    agent2Name: "Agent B",
    ...overrides,
  };
}

function asHarness(publisher: DuelArenaOraclePublisher): PublisherHarness {
  return publisher as unknown as PublisherHarness;
}

describe("DuelArenaOraclePublisher", () => {
  let mockWorld: World;
  let publisher: DuelArenaOraclePublisher;
  let harness: PublisherHarness;
  let config: DuelArenaOracleConfig;
  let cycle: OracleCycle;

  beforeEach(() => {
    mockWorld = {
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as World;
    cycle = makeCycle();
    config = {
      enabled: true,
      profile: "local",
      metadataBaseUrl: "http://localhost:5555",
      storePath: "/tmp/oracle-records.json",
      solanaTargets: [],
      settlementDelayMs: 0,
    };
    publisher = new DuelArenaOraclePublisher(mockWorld, config, {
      getStreamingDuelScheduler: () =>
        ({ getCurrentCycle: () => cycle }) as never,
    });
    harness = asHarness(publisher);
    vi.spyOn(harness, "persistRecords").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delays only an authoritative resolution by settlementDelayMs", async () => {
    vi.useFakeTimers();
    config.settlementDelayMs = 7_000;
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    const resolutionPromise = harness.handleResolution(makeResolution());
    await Promise.resolve();
    await Promise.resolve();

    expect(publishAcrossTargets).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(7_000);
    await resolutionPromise;

    expect(publishAcrossTargets).toHaveBeenCalledTimes(1);
    expect(publishAcrossTargets).toHaveBeenCalledWith(
      expect.objectContaining({ duelId: "duel-123", status: "RESOLVED" }),
      "RESOLVE",
    );
  });

  it("publishes an authoritative resolution immediately when delay is zero", async () => {
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleResolution(makeResolution());

    expect(publishAcrossTargets).toHaveBeenCalledTimes(1);
    expect(harness.records.get("duel-123")).toEqual(
      expect.objectContaining({
        status: "RESOLVED",
        winnerId: "agent-a",
        loserId: "agent-b",
        winnerSide: "A",
      }),
    );
  });

  it("advances only the exact authoritative announcement and fight-start identity", async () => {
    cycle = makeCycle({
      phase: "ANNOUNCEMENT",
      outcome: null,
      winnerId: null,
      loserId: null,
      duelEndTime: null,
      seed: null,
      replayHash: null,
    });
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleAnnouncement({
      cycleId: "cycle-123",
      duelId: "duel-123",
      duelKeyHex: DUEL_KEY,
      betOpenTime: 100,
      betCloseTime: 500,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
    });

    expect(harness.records.get("duel-123")?.status).toBe("BETTING_OPEN");

    cycle = makeCycle({
      phase: "FIGHTING",
      outcome: null,
      winnerId: null,
      loserId: null,
      duelEndTime: null,
      seed: null,
      replayHash: null,
    });
    await harness.handleFightStart({
      cycleId: "cycle-123",
      duelId: "duel-123",
      duelKeyHex: DUEL_KEY,
      betCloseTime: 500,
      fightStartTime: 600,
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      duration: 60_000,
    });

    expect(harness.records.get("duel-123")).toEqual(
      expect.objectContaining({
        status: "LOCKED",
        fightStartTime: 600,
        betCloseTime: 500,
      }),
    );
    expect(publishAcrossTargets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "BETTING_OPEN" }),
      "UPSERT",
    );
    expect(publishAcrossTargets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "LOCKED" }),
      "UPSERT",
    );
  });

  it("rejects valid-shaped winner events outside authoritative resolution", async () => {
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);
    const phases = ["IDLE", "ANNOUNCEMENT", "COUNTDOWN", "FIGHTING", "CORRUPT"];

    for (let index = 0; index < 256; index += 1) {
      cycle = makeCycle({ phase: phases[index % phases.length] });
      await harness.handleResolution(makeResolution());
      expect(harness.records.get("duel-123")?.status).toBe("LOCKED");
    }

    expect(publishAcrossTargets).not.toHaveBeenCalled();
  });

  it("rejects key, participant, result, and proof drift", async () => {
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    for (const payload of [
      makeResolution({ duelKeyHex: "e".repeat(64) }),
      makeResolution({ winnerId: "agent-outsider" }),
      makeResolution({ seed: "wrong-seed" }),
      makeResolution({ replayHash: "f".repeat(64) }),
    ]) {
      await harness.handleResolution(payload);
    }

    expect(harness.records.get("duel-123")?.status).toBe("LOCKED");
    expect(publishAcrossTargets).not.toHaveBeenCalled();
  });

  it("routes an authoritative draw only to cancellation", async () => {
    cycle = makeCycle({
      outcome: "draw",
      winnerId: null,
      loserId: null,
    });
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleResolution(
      makeResolution({
        outcome: "draw",
        winnerId: null,
        loserId: null,
        winnerName: null,
        loserName: null,
        winReason: "draw",
      }),
    );

    expect(harness.records.get("duel-123")).toEqual(
      expect.objectContaining({
        status: "CANCELLED",
        winnerId: null,
        loserId: null,
        winnerSide: null,
      }),
    );
    expect(publishAcrossTargets).toHaveBeenCalledTimes(1);
    expect(publishAcrossTargets).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
      "CANCEL",
    );
    expect(publishAcrossTargets).not.toHaveBeenCalledWith(
      expect.anything(),
      "RESOLVE",
    );
  });

  it("routes an authoritative no-contest abort only to cancellation", async () => {
    cycle = makeCycle({
      phase: "FIGHTING",
      outcome: null,
      winnerId: null,
      loserId: null,
      duelEndTime: null,
      seed: null,
      replayHash: null,
    });
    harness.records.set("duel-123", makeRecord());
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleAbort(makeAbort());

    expect(harness.records.get("duel-123")?.status).toBe("CANCELLED");
    expect(publishAcrossTargets).toHaveBeenCalledTimes(1);
    expect(publishAcrossTargets).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
      "CANCEL",
    );
    expect(publishAcrossTargets).not.toHaveBeenCalledWith(
      expect.anything(),
      "RESOLVE",
    );
  });

  it("never lets a later cancellation overwrite a resolved winner", async () => {
    const resolved = makeRecord({
      status: "RESOLVED",
      duelEndTime: 1_000,
      winnerId: "agent-a",
      loserId: "agent-b",
      winnerSide: "A",
      winnerName: "Agent A",
      loserName: "Agent B",
      winReason: "kill",
      seed: "123456789",
      replayHashHex: REPLAY_HASH,
      resultHashHex: "f".repeat(64),
    });
    harness.records.set("duel-123", resolved);
    cycle = makeCycle({
      outcome: "draw",
      winnerId: null,
      loserId: null,
    });
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleAbort(makeAbort({ reason: "draw" }));

    expect(harness.records.get("duel-123")).toBe(resolved);
    expect(harness.records.get("duel-123")?.status).toBe("RESOLVED");
    expect(publishAcrossTargets).not.toHaveBeenCalled();
  });

  it("does not let a repeated announcement rewrite or reopen a record", async () => {
    cycle = makeCycle({
      phase: "ANNOUNCEMENT",
      outcome: null,
      winnerId: null,
      loserId: null,
      duelEndTime: null,
      seed: null,
      replayHash: null,
    });
    const locked = makeRecord();
    harness.records.set("duel-123", locked);
    const publishAcrossTargets = vi
      .spyOn(harness, "publishAcrossTargets")
      .mockResolvedValue(undefined);

    await harness.handleAnnouncement({
      cycleId: "cycle-123",
      duelId: "duel-123",
      duelKeyHex: DUEL_KEY,
      betOpenTime: 100,
      betCloseTime: 500,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
    });

    expect(harness.records.get("duel-123")).toBe(locked);
    expect(harness.records.get("duel-123")?.status).toBe("LOCKED");
    expect(publishAcrossTargets).not.toHaveBeenCalled();
  });

  it("publishes resolution only to configured Solana targets", async () => {
    const solanaTarget = {
      key: "solanaDevnet",
      label: "Solana Devnet",
      publishResolution: vi.fn().mockResolvedValue("solana-signature"),
    };
    harness.solanaTargets = [solanaTarget];
    const record = makeRecord({ status: "RESOLVED" });
    harness.records.set(record.duelId, record);

    await harness.publishAcrossTargets(record, "RESOLVE");

    expect(solanaTarget.publishResolution).toHaveBeenCalledWith(record);
  });
});
