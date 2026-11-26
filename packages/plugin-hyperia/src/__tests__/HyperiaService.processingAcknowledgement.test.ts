import { afterEach, describe, expect, it, vi } from "vitest";
import { getPacketId } from "../../../shared/src/platform/shared/packets";
import {
  FALLBACK_PACKET_IDS,
  HyperiaService,
} from "../services/HyperiaService";
import type { EventType } from "../types";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

function createService() {
  const service = new HyperiaService({
    agentId: "processing-ack-agent",
    getSetting: vi.fn().mockReturnValue(null),
  } as never);
  const sendCommand = vi.fn();
  const internals = service as unknown as {
    characterId: string;
    connectionState: { connected: boolean };
    gameState: { playerEntity: { id: string } | null };
    ensureProcessingRecovery: () => Promise<boolean>;
    handleProcessingTransportClosure: (willReconnect: boolean) => void;
    processingRecoveryReady: boolean;
    sendCommand: (command: string, data: unknown) => void;
    ws: {
      removeAllListeners: () => void;
      close: () => void;
    };
    broadcastEvent: (eventType: EventType, data: unknown) => void;
    updateGameStateFromPacket: (packetName: string, data: unknown) => void;
  };
  internals.characterId = "processing-ack-agent";
  internals.connectionState.connected = true;
  internals.gameState.playerEntity = { id: "processing-ack-agent" };
  internals.processingRecoveryReady = true;
  internals.ws = { removeAllListeners: vi.fn(), close: vi.fn() };
  internals.sendCommand = sendCommand;
  sendCommand.mockImplementation((command: string, data: unknown) => {
    if (command !== "processingRequestRecovery") return;
    const payload = data as {
      action?: unknown;
      queryId?: unknown;
      requestId?: unknown;
    };
    if (
      payload.action !== "ack" ||
      typeof payload.queryId !== "string" ||
      typeof payload.requestId !== "string"
    ) {
      return;
    }
    queueMicrotask(() => {
      internals.updateGameStateFromPacket("processingRequestRecovery", {
        action: "acknowledged",
        queryId: payload.queryId,
        requestId: payload.requestId,
        acknowledged: true,
      });
    });
  });
  vi.spyOn(service, "interactWithEntity").mockImplementation(
    (entityId, interactionType) => {
      sendCommand("entityInteract", { entityId, interactionType });
    },
  );
  return { service, internals, sendCommand };
}

function sentRequestId(
  sendCommand: ReturnType<typeof vi.fn>,
  command: string,
): string {
  const call = sendCommand.mock.calls.find(([name]) => name === command);
  const requestId = (call?.[1] as { requestId?: unknown } | undefined)
    ?.requestId;
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return requestId as string;
}

function sentStatusQueryId(
  sendCommand: ReturnType<typeof vi.fn>,
  index = 0,
): string {
  const calls = sendCommand.mock.calls.filter(
    ([name]) => name === "processingRequestStatus",
  );
  const queryId = (calls[index]?.[1] as { queryId?: unknown } | undefined)
    ?.queryId;
  expect(queryId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return queryId as string;
}

describe("HyperiaService processing acknowledgements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps every emergency transport ID aligned with the shared protocol", () => {
    for (const [name, fallbackId] of Object.entries(FALLBACK_PACKET_IDS)) {
      expect(getPacketId(name), name).toBe(fallbackId);
    }
  });

  it("reconstructs an interrupted command from the durable server envelope before readiness", async () => {
    const { internals, sendCommand } = createService();
    internals.processingRecoveryReady = false;
    const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
    let recoveryQueries = 0;
    sendCommand.mockImplementation((command: string, data: unknown) => {
      const payload = data as {
        action?: unknown;
        queryId?: unknown;
        requestId?: unknown;
      };
      if (
        command === "processingRequestRecovery" &&
        payload.action === "query" &&
        typeof payload.queryId === "string"
      ) {
        const queryId = payload.queryId;
        const request =
          recoveryQueries++ === 0
            ? {
                requestId,
                skill: "fletching",
                status: "interrupted",
                envelope: {
                  skill: "fletching",
                  recipeId: "arrow_shaft:logs",
                  quantity: 1,
                },
                acceptedAt: 100,
                heartbeatAt: 200,
                terminalAt: null,
              }
            : null;
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("processingRequestRecovery", {
            action: "state",
            queryId,
            available: true,
            request,
          });
        });
      } else if (
        command === "processingRequestRecovery" &&
        payload.action === "ack" &&
        typeof payload.queryId === "string" &&
        payload.requestId === requestId
      ) {
        const queryId = payload.queryId;
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("processingRequestRecovery", {
            action: "acknowledged",
            queryId,
            requestId,
            acknowledged: true,
          });
        });
      } else if (command === "processingFletching") {
        queueMicrotask(() => {
          internals.broadcastEvent("CRAFTING_COMPLETE", {
            skill: "fletching",
            recipeId: "arrow_shaft:logs",
            totalCrafted: 1,
            requestId,
          });
        });
      }
    });

    await expect(internals.ensureProcessingRecovery()).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith("processingFletching", {
      recipeId: "arrow_shaft:logs",
      quantity: 1,
      requestId,
    });
    expect(internals.processingRecoveryReady).toBe(true);
    expect(recoveryQueries).toBe(2);
  });

  it("submits the exact ordered smelting commands and waits for its completion", async () => {
    const { service, internals, sendCommand } = createService();

    const pending = service.executeSmelting("furnace-live", "bronze_bar", 1);
    expect(sendCommand).toHaveBeenNthCalledWith(1, "entityInteract", {
      entityId: "furnace-live",
      interactionType: "smelt",
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, "processingSmelting", {
      barItemId: "bronze_bar",
      furnaceId: "furnace-live",
      quantity: 1,
      requestId: expect.any(String),
    });
    const requestId = sentRequestId(sendCommand, "processingSmelting");

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "smithing",
      recipeId: "bronze_bar",
      totalSmithed: 1,
      requestId,
    });
    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "smelting",
      barItemId: "iron_bar",
      totalSmelted: 1,
      totalFailed: 0,
      requestId,
    });
    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "smelting",
      barItemId: "bronze_bar",
      totalSmelted: 1,
      totalFailed: 0,
      requestId: "00000000-0000-4000-8000-000000000001",
    });

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "smelting",
      barItemId: "bronze_bar",
      totalSmelted: 1,
      totalFailed: 0,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("serializes processing and treats zero-work acknowledgement as failure", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeTanning("tanner-live", "cowhide", 2);

    await expect(
      service.executeSmithing("anvil-live", "bronze_dagger", 1),
    ).resolves.toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    const requestId = sentRequestId(sendCommand, "processingTanning");

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "tanning",
      inputItemId: "cowhide",
      totalTanned: 0,
      requestId,
    });
    await expect(pending).resolves.toBe(false);
  });

  it("ends immediately only for the exact correlated rejection", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    internals.updateGameStateFromPacket("processingRejected", {
      requestId: "00000000-0000-4000-8000-000000000001",
      skill: "fletching",
      reason: "resources_unavailable",
      retryable: false,
    });
    internals.updateGameStateFromPacket("processingRejected", {
      requestId,
      skill: "crafting",
      reason: "resources_unavailable",
      retryable: false,
    });

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.updateGameStateFromPacket("processingRejected", {
      requestId,
      skill: "fletching",
      reason: "resources_unavailable",
      retryable: false,
    });
    await expect(pending).resolves.toBe(false);
  });

  it("fails closed only after a durable receipt lookup proves no commit", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeSmithing("anvil-live", "bronze_dagger", 1);
    const requestId = sentRequestId(sendCommand, "processingSmithing");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendCommand).toHaveBeenCalledWith("processingRequestStatus", {
      requestId,
      queryId: expect.any(String),
      skill: "smithing",
    });
    const queryId = sentStatusQueryId(sendCommand);
    internals.updateGameStateFromPacket("processingRequestStatus", {
      requestId,
      queryId,
      skill: "smithing",
      status: "not_found",
    });
    await expect(pending).resolves.toBe(false);
  });

  it("recovers a lost completion from its durable receipt and retries unavailable lookup", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    await vi.advanceTimersByTimeAsync(30_000);
    const firstQueryId = sentStatusQueryId(sendCommand);
    internals.updateGameStateFromPacket("processingRequestStatus", {
      requestId,
      queryId: firstQueryId,
      skill: "fletching",
      status: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "processingRequestStatus",
      ),
    ).toHaveLength(2);
    const secondQueryId = sentStatusQueryId(sendCommand, 1);

    internals.updateGameStateFromPacket("processingRequestStatus", {
      requestId,
      queryId: secondQueryId,
      skill: "fletching",
      status: "committed",
    });
    await expect(pending).resolves.toBe(true);
  });

  it("resubmits the exact command after a replacement server reports interruption", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    await vi.advanceTimersByTimeAsync(30_000);
    const queryId = sentStatusQueryId(sendCommand);
    internals.updateGameStateFromPacket("processingRequestStatus", {
      requestId,
      queryId,
      skill: "fletching",
      status: "interrupted",
    });

    const submissions = sendCommand.mock.calls.filter(
      ([command]) => command === "processingFletching",
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.[1]).toEqual(submissions[1]?.[1]);

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "fletching",
      recipeId: "arrow_shaft:logs",
      totalCrafted: 1,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("ignores a stale negative lookup after newer authority progress", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    await vi.advanceTimersByTimeAsync(30_000);
    const staleQueryId = sentStatusQueryId(sendCommand);
    internals.updateGameStateFromPacket("processingProgress", {
      requestId,
      skill: "fletching",
      phase: "reconciling",
    });
    internals.updateGameStateFromPacket("processingRequestStatus", {
      requestId,
      queryId: staleQueryId,
      skill: "fletching",
      status: "not_found",
    });

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "fletching",
      recipeId: "arrow_shaft:logs",
      totalCrafted: 1,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("rejects multi-action correlated station batches", async () => {
    const { service } = createService();

    await expect(
      service.executeSmelting("furnace-live", "bronze_bar", 2),
    ).rejects.toThrow("Invalid smelting request");
    await expect(
      service.executeSmithing("anvil-live", "bronze_dagger", 2),
    ).rejects.toThrow("Invalid smithing request");
    await expect(
      service.executeFletching("arrow_shaft:logs", 2),
    ).rejects.toThrow("Invalid fletching request");
  });

  it("treats exact authority progress as liveness and resets the watchdog", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    await vi.advanceTimersByTimeAsync(20_000);
    internals.updateGameStateFromPacket("processingProgress", {
      requestId,
      skill: "fletching",
      phase: "reconciling",
    });
    await vi.advanceTimersByTimeAsync(20_000);

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "fletching",
      recipeId: "arrow_shaft:logs",
      totalCrafted: 1,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("acknowledges an admission-race commit without resubmitting gameplay", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    internals.updateGameStateFromPacket("processingProgress", {
      requestId,
      skill: "fletching",
      phase: "committed",
    });

    await expect(pending).resolves.toBe(true);
    expect(
      sendCommand.mock.calls.filter(
        ([command]) => command === "processingFletching",
      ),
    ).toHaveLength(1);
    expect(sendCommand).toHaveBeenCalledWith("processingRequestRecovery", {
      action: "ack",
      requestId,
      queryId: expect.any(String),
    });
  });

  it("cancels an in-flight acknowledgement on disconnect", async () => {
    const { service } = createService();
    const pending = service.executeTanning("tanner-live", "cowhide", 1);

    await service.disconnect();
    await expect(pending).resolves.toBe(false);
  });

  it("cancels an in-flight acknowledgement when transport will not reconnect", async () => {
    const { service, internals } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);

    internals.handleProcessingTransportClosure(false);

    await expect(pending).resolves.toBe(false);
    expect(internals.processingRecoveryReady).toBe(false);
  });

  it("preserves an in-flight acknowledgement across a reconnecting transport", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);
    const requestId = sentRequestId(sendCommand, "processingFletching");

    internals.connectionState.connected = false;
    internals.handleProcessingTransportClosure(true);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.connectionState.connected = true;
    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "fletching",
      recipeId: "arrow_shaft:logs",
      totalCrafted: 1,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("uses the dedicated exact-altar packet and waits for committed runes", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeRunecrafting("air-altar", "air");

    expect(sendCommand).toHaveBeenCalledWith("runecraftingAltarInteract", {
      altarId: "air-altar",
      requestId: expect.any(String),
    });
    const requestId = sentRequestId(sendCommand, "runecraftingAltarInteract");
    internals.updateGameStateFromPacket("runecraftingComplete", {
      runeType: "air",
      runeItemId: "air_rune",
      essenceConsumed: 4,
      runesProduced: 4,
      multiplier: 1,
      xpAwarded: 20,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("submits an exact fletching recipe and waits for committed output", async () => {
    const { service, internals, sendCommand } = createService();
    const pending = service.executeFletching("arrow_shaft:logs", 1);

    expect(sendCommand).toHaveBeenCalledWith("processingFletching", {
      recipeId: "arrow_shaft:logs",
      quantity: 1,
      requestId: expect.any(String),
    });
    const requestId = sentRequestId(sendCommand, "processingFletching");
    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "fletching",
      recipeId: "arrow_shaft:logs",
      totalCrafted: 1,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("binds a typed cooking source and waits for consumed-food output", async () => {
    const { service, internals, sendCommand } = createService();
    vi.spyOn(service, "getPlayerEntity").mockReturnValue({
      items: [
        {
          itemId: "raw_shrimp",
          name: "Raw shrimp",
          quantity: 1,
          slot: 3,
        },
      ],
    } as never);
    vi.spyOn(service, "getNearbyEntities").mockReturnValue([
      {
        id: "fire-live",
        name: "Fire",
        type: "fire",
        position: [1, 0, 0],
      },
    ]);

    const pending = service.executeCooking();
    expect(sendCommand).toHaveBeenCalledWith("cookingRequest", {
      rawFoodId: "raw_shrimp",
      rawFoodSlot: 3,
      fireId: "fire-live",
      requestId: expect.any(String),
    });
    const requestId = sentRequestId(sendCommand, "cookingRequest");
    internals.broadcastEvent("CRAFTING_COMPLETE", {
      skill: "cooking",
      rawItemId: "raw_shrimp",
      resultItemId: "shrimp",
      wasBurnt: false,
      xpGained: 10,
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("waits for the requesting player's created fire", async () => {
    const { service, internals, sendCommand } = createService();
    vi.spyOn(service, "getPlayerEntity").mockReturnValue({
      items: [
        { itemId: "tinderbox", name: "Tinderbox", quantity: 1, slot: 2 },
        { itemId: "logs", name: "Logs", quantity: 1, slot: 5 },
      ],
    } as never);

    const pending = service.executeFiremaking();
    expect(sendCommand).toHaveBeenCalledWith("firemakingRequest", {
      logsId: "logs",
      logsSlot: 5,
      tinderboxSlot: 2,
      requestId: expect.any(String),
    });
    const requestId = sentRequestId(sendCommand, "firemakingRequest");
    internals.updateGameStateFromPacket("fireCreated", {
      playerId: "processing-ack-agent",
      fireId: "fire-live",
      position: { x: 0, y: 0, z: 0 },
      requestId,
    });
    await expect(pending).resolves.toBe(true);
  });
});
