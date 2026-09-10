import { describe, expect, it, vi } from "vitest";

import { DatabaseSystem } from "../index";

describe("DatabaseSystem player save ordering", () => {
  function createOrderingSystem(playerRepository: object): DatabaseSystem {
    const system = Object.create(DatabaseSystem.prototype) as DatabaseSystem;
    Object.assign(system as object, {
      isDestroying: false,
      pendingOperations: new Set<Promise<unknown>>(),
      pendingSaveBuffer: new Map(),
      pendingSaveFieldRevisions: new Map(),
      playerSaveRevision: 0,
      saveFlushScheduled: false,
      saveFlushTimer: undefined,
      playerSaveFlushInFlight: false,
      directPlayerSaveInFlight: 0,
      PLAYER_SAVE_RETRY_MS: 1,
      lastPlayerSaveRetryLogTime: 0,
      playerSaveWriteTail: Promise.resolve(),
      playerRepository,
    });
    return system;
  }

  it("retains and retries the latest generic snapshot after a transient write failure", async () => {
    const writes: Array<Map<string, { health?: number; maxHealth?: number }>> =
      [];
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async (players) => {
        writes.push(
          new Map(
            Array.from(players, ([playerId, update]) => [
              playerId,
              { ...update },
            ]),
          ),
        );
        if (writes.length === 1) throw new Error("database unavailable");
      }),
    };
    const system = createOrderingSystem(playerRepository);

    system.savePlayer("player-1", { health: 3, maxHealth: 10 });

    await vi.waitFor(() =>
      expect(playerRepository.batchSavePlayersAsync).toHaveBeenCalledTimes(2),
    );
    expect(writes).toEqual([
      new Map([["player-1", { health: 3, maxHealth: 10 }]]),
      new Map([["player-1", { health: 3, maxHealth: 10 }]]),
    ]);
    expect(
      (system as unknown as { pendingSaveBuffer: Map<string, unknown> })
        .pendingSaveBuffer.size,
    ).toBe(0);
  });

  it("coalesces a newer generic snapshot over a failed in-flight batch", async () => {
    let releaseFailure!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const writes: Array<Map<string, { health?: number; maxHealth?: number }>> =
      [];
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async (players) => {
        writes.push(
          new Map(
            Array.from(players, ([playerId, update]) => [
              playerId,
              { ...update },
            ]),
          ),
        );
        if (writes.length === 1) {
          await firstBlocked;
          throw new Error("database unavailable");
        }
      }),
    };
    const system = createOrderingSystem(playerRepository);

    system.savePlayer("player-1", { health: 3, maxHealth: 10 });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    system.savePlayer("player-1", { health: 4, maxHealth: 10 });
    releaseFailure();

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      new Map([["player-1", { health: 3, maxHealth: 10 }]]),
      new Map([["player-1", { health: 4, maxHealth: 10 }]]),
    ]);
  });

  it("does not replay an older failed field after a newer awaited save commits", async () => {
    const calls: string[] = [];
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async () => {
        calls.push("older-failed");
        throw new Error("database unavailable");
      }),
      savePlayerAsync: vi.fn(async () => {
        calls.push("newer-commit");
      }),
    };
    const system = createOrderingSystem(playerRepository);

    system.savePlayer("player-1", { health: 3, maxHealth: 10 });
    await system.savePlayerAsync("player-1", {
      health: 4,
      maxHealth: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual(["older-failed", "newer-commit"]);
    expect(playerRepository.batchSavePlayersAsync).toHaveBeenCalledOnce();
    expect(
      (system as unknown as { pendingSaveBuffer: Map<string, unknown> })
        .pendingSaveBuffer.size,
    ).toBe(0);
  });

  it("retries distinct failed fields without overwriting fields covered by a newer awaited save", async () => {
    const writes: Array<Map<string, Record<string, number>>> = [];
    const calls: string[] = [];
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async (players) => {
        writes.push(
          new Map(
            Array.from(players, ([playerId, update]) => [
              playerId,
              { ...update } as Record<string, number>,
            ]),
          ),
        );
        calls.push(`batch-${writes.length}`);
        if (writes.length === 1) throw new Error("database unavailable");
      }),
      savePlayerAsync: vi.fn(async () => {
        calls.push("direct");
      }),
    };
    const system = createOrderingSystem(playerRepository);

    system.savePlayer("player-1", {
      health: 3,
      maxHealth: 10,
      positionX: 12,
    });
    await system.savePlayerAsync("player-1", {
      health: 4,
      maxHealth: 10,
    });

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(calls).toEqual(["batch-1", "direct", "batch-2"]);
    expect(writes).toEqual([
      new Map([["player-1", { health: 3, maxHealth: 10, positionX: 12 }]]),
      new Map([["player-1", { positionX: 12 }]]),
    ]);
  });

  it("drains an older generic snapshot before an awaited newer snapshot", async () => {
    let releaseOlder!: () => void;
    const olderBlocked = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const calls: string[] = [];
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async () => {
        calls.push("older-start");
        await olderBlocked;
        calls.push("older-commit");
      }),
      savePlayerAsync: vi.fn(async () => {
        calls.push("newer-commit");
      }),
    };
    const system = createOrderingSystem(playerRepository);

    system.savePlayer("player-1", { health: 3, maxHealth: 10 });
    const newerSave = system.savePlayerAsync("player-1", {
      health: 4,
      maxHealth: 10,
    });

    await vi.waitFor(() => expect(calls).toEqual(["older-start"]));
    expect(playerRepository.savePlayerAsync).not.toHaveBeenCalled();

    releaseOlder();
    await newerSave;

    expect(calls).toEqual(["older-start", "older-commit", "newer-commit"]);
    expect(playerRepository.batchSavePlayersAsync).toHaveBeenCalledWith(
      new Map([["player-1", { health: 3, maxHealth: 10 }]]),
    );
    expect(playerRepository.savePlayerAsync).toHaveBeenCalledWith("player-1", {
      health: 4,
      maxHealth: 10,
    });
  });

  it("flushes a zero-delay player buffer before repositories enter shutdown", async () => {
    const calls: string[] = [];
    const passiveRepository = { markDestroying: vi.fn() };
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async () => {
        calls.push("write");
      }),
      markDestroying: vi.fn(() => {
        calls.push("destroy");
      }),
    };
    const system = createOrderingSystem(playerRepository);
    Object.assign(system as object, {
      characterRepository: passiveRepository,
      inventoryRepository: passiveRepository,
      equipmentRepository: passiveRepository,
      sessionRepository: passiveRepository,
      worldChunkRepository: passiveRepository,
      npcKillRepository: passiveRepository,
      deathRepository: passiveRepository,
      templateRepository: passiveRepository,
      questRepository: passiveRepository,
      activityLogRepository: passiveRepository,
      bankRepository: passiveRepository,
    });

    system.savePlayer("player-1", { health: 4, maxHealth: 10 });
    await system.waitForPendingOperations();

    expect(calls).toEqual(["write", "destroy"]);
    expect(playerRepository.batchSavePlayersAsync).toHaveBeenCalledWith(
      new Map([["player-1", { health: 4, maxHealth: 10 }]]),
    );
  });

  it("retries a transient player save failure before repositories enter shutdown", async () => {
    const calls: string[] = [];
    const passiveRepository = { markDestroying: vi.fn() };
    const playerRepository = {
      batchSavePlayersAsync: vi.fn(async () => {
        calls.push("write");
        if (calls.filter((call) => call === "write").length === 1) {
          throw new Error("database unavailable");
        }
      }),
      markDestroying: vi.fn(() => {
        calls.push("destroy");
      }),
    };
    const system = createOrderingSystem(playerRepository);
    Object.assign(system as object, {
      characterRepository: passiveRepository,
      inventoryRepository: passiveRepository,
      equipmentRepository: passiveRepository,
      sessionRepository: passiveRepository,
      worldChunkRepository: passiveRepository,
      npcKillRepository: passiveRepository,
      deathRepository: passiveRepository,
      templateRepository: passiveRepository,
      questRepository: passiveRepository,
      activityLogRepository: passiveRepository,
      bankRepository: passiveRepository,
    });

    system.savePlayer("player-1", { health: 4, maxHealth: 10 });
    await system.waitForPendingOperations();

    expect(calls).toEqual(["write", "write", "destroy"]);
    expect(playerRepository.batchSavePlayersAsync).toHaveBeenCalledTimes(2);
    expect(
      (system as unknown as { pendingSaveBuffer: Map<string, unknown> })
        .pendingSaveBuffer.size,
    ).toBe(0);
  });
});
