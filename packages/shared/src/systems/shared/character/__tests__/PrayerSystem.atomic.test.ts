import EventEmitter from "eventemitter3";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { World } from "../../../../core/World";
import { prayerDataProvider } from "../../../../data/PrayerDataProvider";
import { EventType } from "../../../../types/events";
import type {
  PrayerPersistenceSnapshot,
  PrayerStateCommitRequest,
  PrayerStateCommitReceipt,
} from "../../../../types/network/database";
import type { StreamingDuelPrayerObservationContext } from "../../../../types/game/streaming-duel-action-observation";
import { EventBus } from "../../infrastructure/EventBus";
import { PRAYER_POINT_UNITS_PER_POINT, PrayerSystem } from "../PrayerSystem";

const PLAYER_ID = "atomic-prayer-player";

interface AtomicPrayerWorld extends EventEmitter<string | symbol, unknown> {
  isServer: boolean;
  $eventBus: EventBus;
  entities: { get: ReturnType<typeof vi.fn> };
  getPlayers: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFixture(initial: PrayerPersistenceSnapshot): {
  world: AtomicPrayerWorld;
  database: {
    getPlayerAsync: ReturnType<typeof vi.fn>;
    commitPrayerStateOperationAsync: ReturnType<typeof vi.fn>;
  };
  persisted: () => PrayerPersistenceSnapshot;
  setPersisted: (snapshot: PrayerPersistenceSnapshot) => void;
  commitNormally: (
    request: PrayerStateCommitRequest,
  ) => Promise<PrayerStateCommitReceipt>;
} {
  let persisted: PrayerPersistenceSnapshot = structuredClone(initial);
  const operations = new Map<
    string,
    { fingerprint: string; transition: PrayerStateCommitRequest["transition"] }
  >();

  const commitNormally = async (
    request: PrayerStateCommitRequest,
  ): Promise<PrayerStateCommitReceipt> => {
    const existing = operations.get(request.operationId);
    if (existing) {
      if (
        existing.fingerprint !== request.requestFingerprint ||
        existing.transition !== request.transition
      ) {
        throw new Error("prayer_state_operation_id_conflict");
      }
      return {
        operationId: request.operationId,
        playerId: request.playerId,
        requestFingerprint: request.requestFingerprint,
        transition: request.transition,
        replayed: true,
        committed: structuredClone(persisted),
      };
    }
    if (JSON.stringify(persisted) !== JSON.stringify(request.expected)) {
      throw new Error("prayer_state_conflict");
    }
    persisted = structuredClone(request.committed);
    operations.set(request.operationId, {
      fingerprint: request.requestFingerprint,
      transition: request.transition,
    });
    return {
      operationId: request.operationId,
      playerId: request.playerId,
      requestFingerprint: request.requestFingerprint,
      transition: request.transition,
      replayed: false,
      committed: structuredClone(persisted),
    };
  };

  const database = {
    getPlayerAsync: vi.fn(async () => {
      const current = persisted;
      return {
        prayerLevel: current.maxPoints,
        prayerMaxPoints: current.maxPoints,
        prayerPoints:
          current.pointUnits <= 0
            ? 0
            : Math.ceil(current.pointUnits / PRAYER_POINT_UNITS_PER_POINT),
        prayerPointUnits: current.pointUnits,
        activePrayers: [...current.activePrayers],
      };
    }),
    commitPrayerStateOperationAsync: vi.fn(commitNormally),
  };
  const emitter = new EventEmitter<string | symbol, unknown>();
  const world = emitter as AtomicPrayerWorld;
  world.isServer = true;
  world.$eventBus = new EventBus();
  world.entities = {
    get: vi.fn(() => ({
      id: PLAYER_ID,
      stats: {
        prayer: { level: initial.maxPoints, xp: 0 },
        combatBonuses: { prayerBonus: 0 },
      },
    })),
  };
  world.getPlayers = vi.fn(() => []);
  world.getSystem = vi.fn((name: string) =>
    name === "database" ? database : undefined,
  );

  return {
    world,
    database,
    persisted: () => structuredClone(persisted),
    setPersisted: (snapshot) => {
      persisted = structuredClone(snapshot);
    },
    commitNormally,
  };
}

async function initialize(world: AtomicPrayerWorld): Promise<PrayerSystem> {
  const system = new PrayerSystem(world as unknown as World);
  await system.init();
  world.emit(EventType.PLAYER_REGISTERED, { playerId: PLAYER_ID });
  await system.waitForPrayerIdle(PLAYER_ID);
  return system;
}

function processDrainTick(system: PrayerSystem): void {
  (
    system as unknown as {
      processDrainTick: () => void;
    }
  ).processDrainTick();
}

beforeAll(() => {
  prayerDataProvider.loadPrayers({
    prayers: [
      {
        id: "battle_focus",
        name: "Battle Focus",
        description: "Raises attack.",
        icon: "battle_focus.png",
        level: 1,
        category: "offensive",
        drainEffect: 1,
        bonuses: { attackMultiplier: 1.1 },
        conflicts: ["greater_focus"],
      },
      {
        id: "greater_focus",
        name: "Greater Focus",
        description: "Raises attack more.",
        icon: "greater_focus.png",
        level: 50,
        category: "offensive",
        drainEffect: 2,
        bonuses: { attackMultiplier: 1.2 },
        conflicts: ["battle_focus"],
      },
      {
        id: "hawk_eye",
        name: "Hawk Eye",
        description: "Raises ranged attack and strength.",
        icon: "hawk_eye.png",
        level: 26,
        category: "offensive",
        drainEffect: 6,
        bonuses: {
          rangedAttackMultiplier: 1.1,
          rangedStrengthMultiplier: 1.1,
        },
        conflicts: [],
      },
      {
        id: "mystic_lore",
        name: "Mystic Lore",
        description: "Raises magic attack and defence.",
        icon: "mystic_lore.png",
        level: 27,
        category: "offensive",
        drainEffect: 6,
        bonuses: {
          magicAttackMultiplier: 1.1,
          magicDefenseMultiplier: 1.1,
        },
        conflicts: [],
      },
    ],
  });
  prayerDataProvider.rebuild();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PrayerSystem atomic custody", () => {
  it("reloads current Prayer state after a committed quest reward instead of applying a stale snapshot", async () => {
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: [],
    });
    const system = await initialize(fixture.world);
    fixture.database.getPlayerAsync.mockClear();
    fixture.setPersisted({
      pointUnits: 3_000_000,
      maxPoints: 3,
      activePrayers: [],
    });

    fixture.world.$eventBus.emitEvent(EventType.QUEST_COMPLETION_COMMITTED, {
      playerId: PLAYER_ID,
      questId: "prayer_reward_quest",
      operationId: `quest-completion:${"a".repeat(64)}`,
      replayed: false,
      progress: [
        {
          skill: "prayer",
          xpAmount: 100,
          awardedXp: 100,
          operationCommittedXp: 100,
          currentXp: 100,
          currentLevel: 2,
        },
      ],
      prayer: {
        pointUnits: 2_000_000,
        maxPoints: 2,
        activePrayers: [],
      },
    });
    await vi.waitFor(() =>
      expect(fixture.database.getPlayerAsync).toHaveBeenCalledOnce(),
    );
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(system.getPrayerPoints(PLAYER_ID)).toBe(3);
    expect(system.getMaxPrayerPoints(PLAYER_ID)).toBe(3);
    system.destroy();
  });

  it("binds an exact duel prayer observation to the atomic toggle request", async () => {
    const fixture = createFixture({
      pointUnits: 99_000_000,
      maxPoints: 99,
      activePrayers: [],
    });
    const system = await initialize(fixture.world);
    const context = {
      operationId: "00000000-0000-4000-8000-000000000011",
      tick: 7,
      observedAt: 1_725_000_000_100,
      cycleId: "cycle-prayer",
      duelId: "duel-prayer",
      actorId: PLAYER_ID,
      opponentId: "prayer-opponent",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
      prayer: "hawk_eye",
    } as const satisfies StreamingDuelPrayerObservationContext;

    const receipt = await system.togglePrayer(
      PLAYER_ID,
      "hawk_eye",
      "atomic-duel-prayer",
      context,
    );

    expect(receipt).toMatchObject({
      success: true,
      committed: true,
      activePrayers: ["hawk_eye"],
    });
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "atomic-duel-prayer",
        playerId: PLAYER_ID,
        transition: "toggle",
        publicActionObservation: context,
      }),
    );

    const invalid = await system.togglePrayer(
      PLAYER_ID,
      "mystic_lore",
      "invalid-duel-prayer",
      { ...context, actorId: "another-player", prayer: "mystic_lore" },
    );
    expect(invalid).toMatchObject({
      success: false,
      committed: false,
      reason: "invalid_request",
    });
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(1);
    system.destroy();
  });

  it("retains authored ranged and magic bonuses after authoritative hydration", async () => {
    const fixture = createFixture({
      pointUnits: 99_000_000,
      maxPoints: 99,
      activePrayers: ["hawk_eye", "mystic_lore"],
    });
    const system = await initialize(fixture.world);

    expect(system.getCombinedBonuses(PLAYER_ID)).toMatchObject({
      rangedAttackMultiplier: 1.1,
      rangedStrengthMultiplier: 1.1,
      magicAttackMultiplier: 1.1,
      magicDefenseMultiplier: 1.1,
    });
    expect(system.getCombinedBonuses("missing-player")).toEqual({
      attackMultiplier: undefined,
      strengthMultiplier: undefined,
      defenseMultiplier: undefined,
      rangedAttackMultiplier: undefined,
      rangedStrengthMultiplier: undefined,
      magicAttackMultiplier: undefined,
      magicDefenseMultiplier: undefined,
    });
    system.destroy();
  });

  it("does not expose an active prayer or combat bonus before persistence commits", async () => {
    const fixture = createFixture({
      pointUnits: 10_000_000,
      maxPoints: 10,
      activePrayers: [],
    });
    const system = await initialize(fixture.world);
    const gate = deferred();
    fixture.database.commitPrayerStateOperationAsync.mockImplementationOnce(
      async (request: PrayerStateCommitRequest) => {
        await gate.promise;
        return fixture.commitNormally(request);
      },
    );

    const pending = system.togglePrayer(
      PLAYER_ID,
      "battle_focus",
      "toggle-before-visible",
    );
    await vi.waitFor(() => {
      expect(
        fixture.database.commitPrayerStateOperationAsync,
      ).toHaveBeenCalledTimes(1);
    });
    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);
    expect(system.getEffectiveAttackLevel(PLAYER_ID, 10)).toBe(10);

    gate.resolve();
    const receipt = await pending;
    expect(receipt).toMatchObject({
      success: true,
      committed: true,
      activePrayers: ["battle_focus"],
    });
    expect(system.getActivePrayers(PLAYER_ID)).toEqual(["battle_focus"]);
    expect(system.getEffectiveAttackLevel(PLAYER_ID, 10)).toBe(11);
    system.destroy();
  });

  it("does not spend toggle rate budget on a rejected strategy", async () => {
    const fixture = createFixture({
      pointUnits: 10_000_000,
      maxPoints: 10,
      activePrayers: [],
    });
    const system = await initialize(fixture.world);

    const rejected = await system.togglePrayer(
      PLAYER_ID,
      "greater_focus",
      "level-rejected",
    );
    const accepted = await system.togglePrayer(
      PLAYER_ID,
      "battle_focus",
      "valid-same-window",
    );

    expect(rejected.reason).toBe("level_requirement");
    expect(accepted.success).toBe(true);
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(1);
    system.destroy();
  });

  it("uses persisted prayer custody when the production entity projection has no top-level stats", async () => {
    const fixture = createFixture({
      pointUnits: 39_000_000,
      maxPoints: 39,
      activePrayers: [],
    });
    fixture.world.entities.get.mockReturnValue({
      id: PLAYER_ID,
      data: {
        skills: {
          prayer: { level: 39, xp: 0 },
        },
      },
    });
    const system = await initialize(fixture.world);

    const receipt = await system.togglePrayer(
      PLAYER_ID,
      "mystic_lore",
      "production-entity-level",
    );

    expect(receipt).toMatchObject({
      success: true,
      committed: true,
      activePrayers: ["mystic_lore"],
    });
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(1);
    system.destroy();
  });

  it("retries an ambiguous response with the same operation and converges on the receipt", async () => {
    const fixture = createFixture({
      pointUnits: 5_000_000,
      maxPoints: 5,
      activePrayers: [],
    });
    const system = await initialize(fixture.world);
    fixture.database.commitPrayerStateOperationAsync.mockImplementationOnce(
      async (request: PrayerStateCommitRequest) => {
        await fixture.commitNormally(request);
        throw new Error("connection_lost_after_commit");
      },
    );

    const receipt = await system.togglePrayer(
      PLAYER_ID,
      "battle_focus",
      "ambiguous-toggle",
    );

    expect(receipt.success).toBe(true);
    expect(receipt.replayed).toBe(true);
    expect(receipt.activePrayers).toEqual(["battle_focus"]);
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(2);
    system.destroy();
  });

  it("conserves every accumulated drain tick while one commit is delayed", async () => {
    const fixture = createFixture({
      pointUnits: 10_000_000,
      maxPoints: 10,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    const gate = deferred();
    fixture.database.commitPrayerStateOperationAsync.mockImplementationOnce(
      async (request: PrayerStateCommitRequest) => {
        await gate.promise;
        return fixture.commitNormally(request);
      },
    );

    processDrainTick(system);
    await vi.waitFor(() => {
      expect(
        fixture.database.commitPrayerStateOperationAsync,
      ).toHaveBeenCalledTimes(1);
    });
    processDrainTick(system);
    processDrainTick(system);
    gate.resolve();
    await system.waitForPrayerIdle(PLAYER_ID);

    const unitsPerTick = Math.ceil((1 / 60) * PRAYER_POINT_UNITS_PER_POINT);
    expect(fixture.persisted().pointUnits).toBe(10_000_000 - unitsPerTick * 3);
    expect(system.getPrayerPointUnits(PLAYER_ID)).toBe(
      10_000_000 - unitsPerTick * 3,
    );
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(2);
    system.destroy();
  });

  it("commits depletion and deactivation in the same transition", async () => {
    const fixture = createFixture({
      pointUnits: 10_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(fixture.persisted()).toEqual({
      pointUnits: 0,
      maxPoints: 1,
      activePrayers: [],
    });
    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(true);
    system.destroy();
  });

  it("fails closed when a drain cannot be persisted", async () => {
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    fixture.database.commitPrayerStateOperationAsync.mockRejectedValue(
      new Error("database_offline"),
    );

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);
    expect(system.getEffectiveAttackLevel(PLAYER_ID, 10)).toBe(10);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(false);
    expect(fixture.persisted().pointUnits).toBe(1_000_000);
    system.destroy();
  });

  it("automatically reloads exact database prayer truth after a failed drain", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    fixture.database.getPlayerAsync.mockClear();
    fixture.database.commitPrayerStateOperationAsync.mockRejectedValue(
      new Error("database_offline"),
    );

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(false);
    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);

    now.mockReturnValue(10_599);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(fixture.database.getPlayerAsync).not.toHaveBeenCalled();

    now.mockReturnValue(10_600);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(fixture.database.getPlayerAsync).toHaveBeenCalledOnce();
    expect(system.isPrayerReady(PLAYER_ID)).toBe(true);
    expect(system.getPrayerPointUnits(PLAYER_ID)).toBe(1_000_000);
    expect(system.getActivePrayers(PLAYER_ID)).toEqual(["battle_focus"]);
    system.destroy();
    now.mockRestore();
  });

  it("reconciles an ambiguous committed drain without replaying another debit", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    let commitAttempt = 0;
    fixture.database.commitPrayerStateOperationAsync.mockImplementation(
      async (request: PrayerStateCommitRequest) => {
        commitAttempt += 1;
        if (commitAttempt === 1) {
          await fixture.commitNormally(request);
          throw new Error("connection_lost_after_commit");
        }
        throw new Error("database_offline");
      },
    );
    fixture.database.getPlayerAsync.mockClear();

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(false);
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(2);
    const committedUnits = fixture.persisted().pointUnits;
    expect(committedUnits).toBeLessThan(1_000_000);

    now.mockReturnValue(20_600);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(system.isPrayerReady(PLAYER_ID)).toBe(true);
    expect(system.getPrayerPointUnits(PLAYER_ID)).toBe(committedUnits);
    expect(system.getActivePrayers(PLAYER_ID)).toEqual(["battle_focus"]);
    expect(
      fixture.database.commitPrayerStateOperationAsync,
    ).toHaveBeenCalledTimes(2);
    system.destroy();
    now.mockRestore();
  });

  it("backs off repeated reload failures and recovers at the next deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000);
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    fixture.database.commitPrayerStateOperationAsync.mockRejectedValue(
      new Error("database_offline"),
    );
    fixture.database.getPlayerAsync.mockClear();

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    fixture.database.getPlayerAsync.mockRejectedValueOnce(
      new Error("database_still_offline"),
    );

    now.mockReturnValue(30_600);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(fixture.database.getPlayerAsync).toHaveBeenCalledOnce();

    now.mockReturnValue(31_799);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(fixture.database.getPlayerAsync).toHaveBeenCalledOnce();

    now.mockReturnValue(31_800);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    expect(fixture.database.getPlayerAsync).toHaveBeenCalledTimes(2);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(true);
    system.destroy();
    now.mockRestore();
  });

  it("keeps combat bonuses closed when persisted reconciliation data is invalid", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(40_000);
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    fixture.database.commitPrayerStateOperationAsync.mockRejectedValue(
      new Error("database_offline"),
    );
    fixture.database.getPlayerAsync.mockClear();

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    fixture.database.getPlayerAsync.mockResolvedValueOnce({
      prayerLevel: 1,
      prayerMaxPoints: 1,
      prayerPoints: 2,
      prayerPointUnits: 2_000_000,
      activePrayers: ["battle_focus"],
    });

    now.mockReturnValue(40_600);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(fixture.database.getPlayerAsync).toHaveBeenCalledOnce();
    expect(system.isPrayerReady(PLAYER_ID)).toBe(false);
    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);
    expect(system.getEffectiveAttackLevel(PLAYER_ID, 10)).toBe(10);
    system.destroy();
    now.mockRestore();
  });

  it("does not resurrect prayer state after player cleanup", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const fixture = createFixture({
      pointUnits: 1_000_000,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);
    fixture.database.commitPrayerStateOperationAsync.mockRejectedValue(
      new Error("database_offline"),
    );
    fixture.database.getPlayerAsync.mockClear();

    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);
    await (
      system as unknown as {
        cleanupPlayerPrayer: (playerId: string) => Promise<void>;
      }
    ).cleanupPlayerPrayer(PLAYER_ID);

    now.mockReturnValue(60_000);
    processDrainTick(system);
    await system.waitForPrayerIdle(PLAYER_ID);

    expect(fixture.database.getPlayerAsync).not.toHaveBeenCalled();
    expect(system.getPrayerCustody(PLAYER_ID)).toMatchObject({
      ready: false,
      persistenceHealthy: false,
      activePrayers: [],
    });
    system.destroy();
    now.mockRestore();
  });

  it("durably deactivates every prayer and returns the authoritative state", async () => {
    const fixture = createFixture({
      pointUnits: 2_000_000,
      maxPoints: 2,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);

    const receipt = await system.deactivateAllPrayers(
      PLAYER_ID,
      "deactivate-all",
    );

    expect(receipt).toMatchObject({
      success: true,
      committed: true,
      activePrayers: [],
      pointUnits: 2_000_000,
    });
    expect(fixture.persisted().activePrayers).toEqual([]);
    system.destroy();
  });

  it("refuses to expose corrupted zero-point active state", async () => {
    const fixture = createFixture({
      pointUnits: 0,
      maxPoints: 1,
      activePrayers: ["battle_focus"],
    });
    const system = await initialize(fixture.world);

    expect(system.getActivePrayers(PLAYER_ID)).toEqual([]);
    expect(system.getEffectiveAttackLevel(PLAYER_ID, 10)).toBe(10);
    expect(system.isPrayerReady(PLAYER_ID)).toBe(false);
    system.destroy();
  });
});
