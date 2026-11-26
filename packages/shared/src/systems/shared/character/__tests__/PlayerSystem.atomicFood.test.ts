import { describe, expect, it, vi } from "vitest";

import { getItem } from "../../../../data/items";
import { PlayerMigration } from "../../../../types/core/core";
import type { StreamingDuelFoodObservationContext } from "../../../../types/game/streaming-duel-action-observation";
import { EventBus } from "../../infrastructure/EventBus";
import { PlayerSystem } from "../PlayerSystem";

function stagedFood(operationId: string, replayed = false) {
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    receipt: {
      playerId: "agent-a",
      operationId,
      requestFingerprint: "a".repeat(64),
      replayed,
      itemId: "lobster",
      healAmount: 12,
      status: "pending" as const,
      healedAmount: 0,
      healthAfter: null,
      committed: [],
    },
  };
}

function completedFood(
  operationId: string,
  healedAmount = 12,
  healthAfter = 42,
) {
  const staged = stagedFood(operationId, true);
  return {
    ...staged,
    receipt: {
      ...staged.receipt,
      status: "completed" as const,
      healedAmount,
      healthAfter,
    },
  };
}

describe("PlayerSystem atomic food consumption", () => {
  function createFixture(
    stagedImplementation?: (...args: any[]) => Promise<any>,
  ) {
    const eventBus = new EventBus();
    const healthComponent = {
      data: { current: 30, max: 60, isDead: false },
    };
    const entity = {
      setHealth: vi.fn((health: number) => {
        healthComponent.data.current = health;
      }),
      getComponent: vi.fn((name: string) =>
        name === "health" ? healthComponent : null,
      ),
    };
    const rawInventory = {
      playerId: "agent-a",
      coins: 0,
      items: [
        {
          slot: 4,
          itemId: "lobster",
          quantity: 2,
          item: getItem("lobster")!,
        },
      ],
    };
    const commitFoodConsumptionAtomic = vi.fn(
      stagedImplementation ??
        (async (
          playerId: string,
          operationId: string,
          itemId: string,
          healAmount: number,
        ) => ({
          ok: true,
          committed: true,
          liveInventoryApplied: true,
          receipt: {
            playerId,
            operationId,
            requestFingerprint: "a".repeat(64),
            replayed: false,
            itemId,
            healAmount,
            status: "pending",
            healedAmount: 0,
            healthAfter: null,
            committed: [],
          },
        })),
    );
    const inventory = {
      getInventory: vi.fn(() => rawInventory),
      commitFoodConsumptionAtomic,
    };
    let playerRef: ReturnType<typeof PlayerMigration.createNewPlayer>;
    const database = {
      savePlayer: vi.fn(),
      savePlayerAsync: vi.fn(async () => undefined),
      completeFoodConsumptionOperationAsync: vi.fn(async (request) => {
        const alive = playerRef.alive && playerRef.health.current > 0;
        return {
          ...request,
          replayed: false,
          itemId: "lobster",
          healAmount: 12,
          status: "completed" as const,
          healedAmount: alive ? 12 : 0,
          healthAfter: playerRef.health.current,
          ...(alive ? {} : { completionReason: "player_not_alive" as const }),
          committed: [],
        };
      }),
    };
    const world = {
      isServer: true,
      network: { isServer: true },
      currentTick: 100,
      $eventBus: eventBus,
      entities: new Map([["agent-a", entity]]),
      getPlayer: vi.fn(() => entity),
      getSystem: vi.fn((name: string) =>
        name === "inventory"
          ? inventory
          : name === "database"
            ? database
            : undefined,
      ),
    };
    const system = new PlayerSystem(world as never);
    const player = PlayerMigration.createNewPlayer(
      "agent-a",
      "agent-a",
      "Agent A",
    );
    player.health.current = 30;
    player.health.max = 60;
    player.alive = true;
    playerRef = player;
    (
      system as unknown as {
        players: Map<string, typeof player>;
      }
    ).players.set(player.id, player);
    (
      system as unknown as {
        databaseSystem: typeof database;
      }
    ).databaseSystem = database;

    return {
      world,
      system,
      player,
      entity,
      healthComponent,
      rawInventory,
      commitFoodConsumptionAtomic,
      database,
    };
  }

  it("does not heal, delay, or message before the durable debit receipt", async () => {
    let releaseDebit: ((receipt: any) => void) | undefined;
    const debitGate = new Promise<any>((resolve) => {
      releaseDebit = resolve;
    });
    const fixture = createFixture(async () => debitGate);
    const emitEvent = vi.spyOn(fixture.world.$eventBus, "emitEvent");

    const pending = fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-1",
    );
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce(),
    );

    expect(fixture.player.health.current).toBe(30);
    expect(fixture.entity.setHealth).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith(
      "ui:message",
      expect.anything(),
      expect.anything(),
    );

    releaseDebit?.(stagedFood("food-operation-1"));
    await expect(pending).resolves.toMatchObject({
      ok: true,
      committed: true,
      consumed: true,
      healedAmount: 12,
      newHealth: 42,
    });
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledWith(
      "agent-a",
      "food-operation-1",
      "lobster",
      12,
    );
    expect(fixture.player.health.current).toBe(42);
  });

  it("passes an immutable duel food observation identity through custody", async () => {
    const fixture = createFixture();
    const context = {
      operationId: "00000000-0000-4000-8000-000000000302",
      tick: 5,
      observedAt: 1_800_000_000_005,
      cycleId: "cycle-player-food",
      duelId: "duel-player-food",
      actorId: "agent-a",
      opponentId: "agent-b",
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
    } satisfies StreamingDuelFoodObservationContext;

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-context",
        context,
      ),
    ).resolves.toMatchObject({ ok: true, healedAmount: 12 });
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledWith(
      "agent-a",
      "food-operation-context",
      "lobster",
      12,
      context,
    );
  });

  it("preserves damage that lands while durable custody is pending", async () => {
    let releaseDebit: ((receipt: any) => void) | undefined;
    const fixture = createFixture(
      async () =>
        new Promise<any>((resolve) => {
          releaseDebit = resolve;
        }),
    );
    const pending = fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-damage",
    );
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce(),
    );

    fixture.player.health.current = 20;
    fixture.healthComponent.data.current = 20;
    releaseDebit?.(stagedFood("food-operation-damage"));

    await expect(pending).resolves.toMatchObject({
      ok: true,
      healedAmount: 12,
      newHealth: 32,
    });
    expect(fixture.player.health.current).toBe(32);
  });

  it("creates no heal when inventory custody fails", async () => {
    const fixture = createFixture(async () => ({
      ok: false,
      playerId: "agent-a",
      operationId: "food-operation-failed",
      changed: false,
      replayed: false,
      requirements: [{ itemId: "lobster", quantity: 1 }],
      reason: "insufficient_items",
    }));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-failed",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: false,
      consumed: false,
      reason: "insufficient_items",
    });
    expect(fixture.player.health.current).toBe(30);
    expect(fixture.entity.setHealth).not.toHaveBeenCalled();

    // A failed attempt does not consume the eat-delay budget.
    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce(
      stagedFood("food-operation-retry"),
    );
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-retry",
      ),
    ).resolves.toMatchObject({ ok: true, newHealth: 42 });
  });

  it("allows only one in-flight food action per player", async () => {
    let releaseDebit: ((receipt: any) => void) | undefined;
    const fixture = createFixture(
      async () =>
        new Promise<any>((resolve) => {
          releaseDebit = resolve;
        }),
    );
    const first = fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-first",
    );
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce(),
    );
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-second",
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "action_in_progress",
    });
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce();

    releaseDebit?.(stagedFood("food-operation-first"));
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("replays one operation without applying its heal twice", async () => {
    const fixture = createFixture();
    const first = await fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-replayed",
    );
    expect(first).toMatchObject({ ok: true, replayed: false, newHealth: 42 });

    const replay = await fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-replayed",
    );
    expect(replay).toMatchObject({ ok: true, replayed: true, newHealth: 42 });
    expect(fixture.player.health.current).toBe(42);
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce();
  });

  it("does not add the live heal twice when DB completion is retried", async () => {
    const fixture = createFixture();
    fixture.player.health.current = 48;
    fixture.healthComponent.data.current = 48;
    fixture.database.completeFoodConsumptionOperationAsync
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-pending-completion",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      consumed: true,
      healedAmount: 12,
      newHealth: 60,
      reason: "effect_completion_pending",
    });
    expect(fixture.player.health.current).toBe(60);
    fixture.rawInventory.items = [];
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-new-while-pending",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: false,
      reason: "action_in_progress",
    });

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-pending-completion",
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      consumed: true,
      healedAmount: 12,
      newHealth: 60,
    });
    expect(fixture.player.health.current).toBe(60);
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledTimes(2);
    expect(
      fixture.database.completeFoodConsumptionOperationAsync,
    ).toHaveBeenCalledTimes(3);
  });

  it("restores the eat delay when a pending live effect is discovered completed", async () => {
    const fixture = createFixture();
    fixture.database.completeFoodConsumptionOperationAsync
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-completed-replay",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      reason: "effect_completion_pending",
    });
    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce(
      completedFood("food-operation-completed-replay"),
    );

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-completed-replay",
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      replayed: true,
      healedAmount: 12,
      newHealth: 42,
    });
    expect(
      (
        fixture.system as unknown as {
          eatDelayManager: { canEat(playerId: string, tick: number): boolean };
        }
      ).eatDelayManager.canEat("agent-a", 100),
    ).toBe(false);
    expect(fixture.player.health.current).toBe(42);
  });

  it("defers generic health snapshots until the food effect settles", async () => {
    const fixture = createFixture();
    fixture.database.completeFoodConsumptionOperationAsync
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-deferred-health",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      healedAmount: 12,
      newHealth: 42,
      reason: "effect_completion_pending",
    });

    (
      fixture.system as unknown as {
        persistPlayerHealth(
          playerId: string,
          player: typeof fixture.player,
        ): void;
      }
    ).persistPlayerHealth("agent-a", fixture.player);
    expect(fixture.database.savePlayer).not.toHaveBeenCalled();

    await fixture.system.saveAllPlayersToDatabase();
    expect(fixture.database.savePlayerAsync).toHaveBeenCalledOnce();
    expect(
      fixture.database.savePlayerAsync.mock.calls[0]?.[1],
    ).not.toHaveProperty("health");
    expect(
      fixture.database.savePlayerAsync.mock.calls[0]?.[1],
    ).not.toHaveProperty("maxHealth");

    fixture.system.update(0.6);
    await vi.waitFor(() =>
      expect(fixture.database.savePlayer).toHaveBeenCalled(),
    );
    expect(fixture.database.savePlayer).toHaveBeenLastCalledWith(
      "agent-a",
      expect.objectContaining({ health: 42, maxHealth: 60 }),
    );
    expect(fixture.player.health.current).toBe(42);
  });

  it("reconciles a pending heal in the same live world after the database returns", async () => {
    const fixture = createFixture();
    fixture.database.completeFoodConsumptionOperationAsync
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-live-recovery",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      consumed: true,
      healedAmount: 12,
      newHealth: 42,
      reason: "effect_completion_pending",
    });

    fixture.system.update(0.6);
    await vi.waitFor(() =>
      expect(
        fixture.database.completeFoodConsumptionOperationAsync,
      ).toHaveBeenCalledTimes(3),
    );
    await vi.waitFor(() =>
      expect(
        (
          fixture.system as unknown as {
            pendingFoodOperationByPlayer: Map<string, string>;
          }
        ).pendingFoodOperationByPlayer.size,
      ).toBe(0),
    );

    expect(fixture.player.health.current).toBe(42);
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-live-recovery",
      ),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      healedAmount: 12,
      newHealth: 42,
    });
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous custody commit in the same live world", async () => {
    const fixture = createFixture(async () => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: "agent-a",
      operationId: "food-operation-ambiguous-stage",
      itemId: "lobster",
      healAmount: 12,
      reason: "persistence_failed",
    }));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-ambiguous-stage",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: false,
      consumed: false,
      reason: "persistence_failed",
    });
    expect(fixture.player.health.current).toBe(30);

    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce(
      stagedFood("food-operation-ambiguous-stage", true),
    );
    fixture.system.update(0.6);

    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(fixture.player.health.current).toBe(42));
    expect(
      (
        fixture.system as unknown as {
          pendingFoodCustodyAttempts: Map<string, unknown>;
        }
      ).pendingFoodCustodyAttempts.size,
    ).toBe(0);
    expect(
      fixture.database.completeFoodConsumptionOperationAsync,
    ).toHaveBeenCalledOnce();

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-ambiguous-stage",
      ),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      healedAmount: 12,
      newHealth: 42,
    });
    expect(fixture.player.health.current).toBe(42);
  });

  it("settles ambiguous custody after later full-health and slot changes", async () => {
    const fixture = createFixture(async () => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: "agent-a",
      operationId: "food-operation-later-state",
      itemId: "lobster",
      healAmount: 12,
      reason: "persistence_failed",
    }));

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-later-state",
      ),
    ).resolves.toMatchObject({ reason: "persistence_failed" });

    fixture.player.health.current = 60;
    fixture.healthComponent.data.current = 60;
    fixture.rawInventory.items = [];
    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce(
      stagedFood("food-operation-later-state", true),
    );
    fixture.database.completeFoodConsumptionOperationAsync.mockResolvedValueOnce(
      {
        ...stagedFood("food-operation-later-state", true).receipt,
        status: "completed" as const,
        healedAmount: 0,
        healthAfter: 60,
        completionReason: "full_health" as const,
      },
    );

    fixture.system.update(0.6);
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() =>
      expect(
        (
          fixture.system as unknown as {
            pendingFoodCustodyAttempts: Map<string, unknown>;
          }
        ).pendingFoodCustodyAttempts.size,
      ).toBe(0),
    );
    expect(fixture.player.health.current).toBe(60);
    expect(
      fixture.database.completeFoodConsumptionOperationAsync,
    ).toHaveBeenCalledOnce();
  });

  it("retains ambiguous custody through transient inventory contention", async () => {
    const fixture = createFixture(async () => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: "agent-a",
      operationId: "food-operation-inventory-busy",
      itemId: "lobster",
      healAmount: 12,
      reason: "persistence_failed",
    }));

    await fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-inventory-busy",
    );
    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: "agent-a",
      operationId: "food-operation-inventory-busy",
      itemId: "lobster",
      healAmount: 12,
      reason: "inventory_busy",
    });

    fixture.system.update(0.6);
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledTimes(2),
    );
    const pending = (
      fixture.system as unknown as {
        pendingFoodCustodyAttempts: Map<string, { retryAt: number }>;
      }
    ).pendingFoodCustodyAttempts;
    expect(pending.size).toBe(1);
    await vi.waitFor(() =>
      expect(
        (
          fixture.system as unknown as {
            foodRecoveryPlayersInFlight: Set<string>;
          }
        ).foodRecoveryPlayersInFlight.size,
      ).toBe(0),
    );

    fixture.commitFoodConsumptionAtomic.mockResolvedValueOnce(
      stagedFood("food-operation-inventory-busy", true),
    );
    pending.get("agent-a")!.retryAt = 0;
    fixture.system.update(0.6);
    await vi.waitFor(() => expect(fixture.player.health.current).toBe(42));
    expect(pending.size).toBe(0);
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledTimes(3);
  });

  it("makes a committed debit terminal when the player dies before healing", async () => {
    let releaseDebit: ((receipt: any) => void) | undefined;
    const fixture = createFixture(
      async () =>
        new Promise<any>((resolve) => {
          releaseDebit = resolve;
        }),
    );
    const pending = fixture.system.consumeFoodAtomic(
      "agent-a",
      "lobster",
      4,
      "food-operation-death",
    );
    await vi.waitFor(() =>
      expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce(),
    );

    fixture.player.alive = false;
    fixture.player.health.current = 0;
    releaseDebit?.(stagedFood("food-operation-death"));
    await expect(pending).resolves.toMatchObject({
      ok: false,
      committed: true,
      consumed: true,
      healedAmount: 0,
      newHealth: 0,
      reason: "player_not_alive",
    });

    fixture.player.alive = true;
    fixture.player.health.current = 30;
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-death",
      ),
    ).resolves.toMatchObject({
      ok: false,
      committed: true,
      consumed: true,
      replayed: true,
      healedAmount: 0,
      reason: "player_not_alive",
    });
    expect(fixture.player.health.current).toBe(30);
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce();
  });

  it("completes the durable heal even when live inventory needs reload", async () => {
    const staged = stagedFood("food-operation-apply-failed");
    staged.liveInventoryApplied = false;
    const fixture = createFixture(async () => staged);

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-apply-failed",
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      consumed: true,
      replayed: false,
      healedAmount: 12,
      newHealth: 42,
    });

    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-apply-failed",
      ),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      consumed: true,
      replayed: true,
      healedAmount: 12,
      newHealth: 42,
    });
    expect(fixture.player.health.current).toBe(42);
    expect(fixture.commitFoodConsumptionAtomic).toHaveBeenCalledOnce();
  });

  it("rejects full-health and wrong-slot requests before persistence", async () => {
    const fixture = createFixture();
    fixture.player.health.current = fixture.player.health.max;
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        4,
        "food-operation-full",
      ),
    ).resolves.toMatchObject({ ok: false, reason: "full_health" });

    fixture.player.health.current = 30;
    await expect(
      fixture.system.consumeFoodAtomic(
        "agent-a",
        "lobster",
        3,
        "food-operation-wrong-slot",
      ),
    ).resolves.toMatchObject({ ok: false, reason: "item_not_owned" });
    expect(fixture.commitFoodConsumptionAtomic).not.toHaveBeenCalled();
  });
});
