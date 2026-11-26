import { describe, expect, it, vi } from "vitest";
import { EventType } from "@hyperforge/shared";
import { PendingCookManager } from "../PendingCookManager";

describe("PendingCookManager processing correlation", () => {
  it("retains the request UUID while a player paths to the cooking source", () => {
    const requestId = "d39c75af-467a-40cc-8538-c4baaa78399b";
    const player = { position: { x: 0, y: 0, z: 0 } };
    const emitEvent = vi.fn();
    const movePlayerToward = vi.fn();
    const world = {
      $eventBus: { emitEvent },
      emit: vi.fn(),
      entities: new Map(),
      getPlayer: vi.fn(() => player),
      getSystem: vi.fn(() => undefined),
    };
    const manager = new PendingCookManager(
      world as never,
      {
        getIsRunning: vi.fn(() => false),
        movePlayerToward,
      } as never,
      {
        getActiveFires: () =>
          new Map([
            [
              "fire-1",
              {
                id: "fire-1",
                playerId: "owner",
                position: { x: 3, y: 0, z: 0 },
                createdAt: 1,
                duration: 120_000,
                isActive: true,
              },
            ],
          ]),
      },
    );

    manager.queuePendingCook(
      "player-1",
      "fire-1",
      { x: 999, y: 999, z: 999 },
      10,
      false,
      4,
      requestId,
    );
    expect(movePlayerToward).toHaveBeenCalledOnce();
    expect(emitEvent).not.toHaveBeenCalled();

    player.position.x = 2;
    manager.processTick(11);

    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_COOKING_REQUEST,
      {
        playerId: "player-1",
        fireId: "fire-1",
        rangeId: undefined,
        sourceType: "fire",
        fishSlot: 4,
        requestId,
      },
      "PendingCookManager",
    );
  });

  it("immediately rejects a correlated request for a missing source", () => {
    const requestId = "a33871a3-aa39-4605-a053-414fc3291b66";
    const emitEvent = vi.fn();
    const manager = new PendingCookManager(
      {
        $eventBus: { emitEvent },
        emit: vi.fn(),
        entities: new Map(),
        getPlayer: vi.fn(() => ({ position: { x: 0, y: 0, z: 0 } })),
        getSystem: vi.fn(() => undefined),
      } as never,
      { getIsRunning: vi.fn(), movePlayerToward: vi.fn() } as never,
      { getActiveFires: () => new Map() },
    );

    manager.queuePendingCook(
      "player-1",
      "missing-fire",
      { x: 0, y: 0, z: 0 },
      10,
      false,
      4,
      requestId,
    );

    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      {
        playerId: "player-1",
        requestId,
        skill: "cooking",
        reason: "not_authorized",
        retryable: false,
      },
      "PendingCookManager",
    );
  });

  it("rejects a correlated approach before movement when duel authority is active", () => {
    const requestId = "a770475e-6078-4324-a8bb-13d61317bc4c";
    const emitEvent = vi.fn();
    const movePlayerToward = vi.fn();
    const manager = new PendingCookManager(
      {
        $eventBus: { emitEvent },
        emit: vi.fn(),
        entities: new Map(),
        getPlayer: vi.fn(() => ({ position: { x: 0, y: 0, z: 0 } })),
        getSystem: vi.fn((name: string) =>
          name === "duel" ? { isPlayerInDuel: () => true } : undefined,
        ),
      } as never,
      { getIsRunning: vi.fn(), movePlayerToward } as never,
      { getActiveFires: () => new Map() },
    );

    manager.queuePendingCook(
      "player-1",
      "fire-1",
      { x: 0, y: 0, z: 0 },
      10,
      false,
      4,
      requestId,
    );

    expect(movePlayerToward).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      expect.objectContaining({
        playerId: "player-1",
        requestId,
        skill: "cooking",
        reason: "not_authorized",
      }),
      "PendingCookManager",
    );
  });
});
