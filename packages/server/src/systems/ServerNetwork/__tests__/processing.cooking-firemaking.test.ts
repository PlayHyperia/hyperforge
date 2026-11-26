import { describe, expect, it, vi } from "vitest";
import { CollisionMask, EventType } from "@hyperforge/shared";
import {
  handleCookingRequest,
  handleFiremakingRequest,
  handleProcessingCrafting,
  handleProcessingFletching,
  handleProcessingSmelting,
  handleProcessingSmithing,
  handleProcessingTanning,
} from "../handlers/processing";

function createContext(
  options: {
    inventory?: Array<Record<string, unknown>>;
    blocked?: boolean;
    position?: unknown;
    tanningAuthorized?: boolean;
    canProcess?: boolean;
    admissionResult?:
      "accepted" | "pending" | "committed" | "busy" | "rejected";
    admissionError?: boolean;
  } = {},
) {
  const emit = vi.fn();
  const stopPlayer = vi.fn();
  const queuePendingCook = vi.fn();
  const beginProcessingRequestAsync = options.admissionError
    ? vi.fn().mockRejectedValue(new Error("database offline"))
    : vi.fn().mockResolvedValue(options.admissionResult ?? "accepted");
  const hasFlags = vi.fn(() => options.blocked ?? false);
  const player = {
    id: "player1",
    position: "position" in options ? options.position : { x: 10, y: 0, z: 20 },
  };
  const socket = { player } as unknown as Parameters<
    typeof handleFiremakingRequest
  >[0];
  const ctx = {
    world: {
      emit,
      entities: new Map([["range1", { id: "range1", entityType: "range" }]]),
      getInventory: () =>
        options.inventory ?? [
          { slot: 2, itemId: "logs", quantity: 1 },
          { slot: 4, itemId: "tinderbox", quantity: 1 },
          { slot: 6, itemId: "raw_shrimp", quantity: 1 },
        ],
      collision: { hasFlags },
      getSystem: (name: string) => {
        if (name === "database") return { beginProcessingRequestAsync };
        if (name === "tanning") {
          return {
            canPlayerUseActiveTanner: () => options.tanningAuthorized ?? true,
            getActiveTannerSession: () =>
              options.tanningAuthorized === false
                ? null
                : { npcId: "tanner", npcEntityId: "tanner-live" },
          };
        }
        return undefined;
      },
    },
    pendingCookManager: { queuePendingCook },
    pendingGatherManager: {},
    tileMovementManager: { stopPlayer },
    tickSystem: { getCurrentTick: () => 123 },
    canProcessRequest: vi.fn(() => options.canProcess ?? true),
  } as unknown as Parameters<typeof handleFiremakingRequest>[2];
  return {
    ctx,
    beginProcessingRequestAsync,
    emit,
    hasFlags,
    player,
    queuePendingCook,
    socket,
    stopPlayer,
  };
}

describe("cooking and firemaking network authority", () => {
  const requestId = "8fe44274-5d27-4d43-b107-c5bcfcad9d14";

  it("emits a firemaking request only for exact authoritative slots on clear terrain", () => {
    const { socket, ctx, emit, hasFlags, stopPlayer } = createContext();

    handleFiremakingRequest(
      socket,
      { logsId: "logs", logsSlot: 2, tinderboxSlot: 4 },
      ctx,
    );

    expect(hasFlags).toHaveBeenCalledWith(10, 20, CollisionMask.BLOCKS_WALK);
    expect(stopPlayer).toHaveBeenCalledWith("player1");
    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_FIREMAKING_REQUEST, {
      playerId: "player1",
      logsId: "logs",
      logsSlot: 2,
      tinderboxSlot: 4,
    });
  });

  it.each([
    { logsId: "oak_logs", logsSlot: 2, tinderboxSlot: 4 },
    { logsId: "logs", logsSlot: 4, tinderboxSlot: 2 },
    { logsId: "logs", logsSlot: 2, tinderboxSlot: 2 },
    { logsId: "logs", logsSlot: 28, tinderboxSlot: 4 },
  ])("rejects forged firemaking payload %j", (payload) => {
    const { socket, ctx, emit, stopPlayer } = createContext();
    handleFiremakingRequest(socket, payload, ctx);
    expect(stopPlayer).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    { position: { x: Number.NaN, y: 0, z: 0 } },
    { position: undefined },
    { blocked: true },
  ])("rejects unsafe fire placement %j", (options) => {
    const { socket, ctx, emit, stopPlayer } = createContext(options);
    handleFiremakingRequest(
      socket,
      { logsId: "logs", logsSlot: 2, tinderboxSlot: 4 },
      ctx,
    );
    expect(stopPlayer).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("queues exact cooking inventory custody for server-side source lookup", () => {
    const { socket, ctx, queuePendingCook } = createContext();
    handleCookingRequest(
      socket,
      { rawFoodId: "raw_shrimp", rawFoodSlot: 6, fireId: "range1" },
      ctx,
    );

    expect(queuePendingCook).toHaveBeenCalledWith(
      "player1",
      "range1",
      { x: 0, y: 0, z: 0 },
      123,
      undefined,
      6,
    );
  });

  it("propagates a validated processing request UUID through movement and direct handlers", async () => {
    const firemaking = createContext();
    await handleFiremakingRequest(
      firemaking.socket,
      {
        logsId: "logs",
        logsSlot: 2,
        tinderboxSlot: 4,
        requestId,
      },
      firemaking.ctx,
    );
    expect(firemaking.emit).toHaveBeenCalledWith(
      EventType.PROCESSING_FIREMAKING_REQUEST,
      expect.objectContaining({ requestId }),
    );
    expect(firemaking.beginProcessingRequestAsync).toHaveBeenCalledWith(
      "player1",
      `processing-request:firemaking:${requestId}`,
      requestId,
      "firemaking",
      {
        skill: "firemaking",
        logsId: "logs",
        logsSlot: 2,
        tinderboxSlot: 4,
      },
    );

    const cooking = createContext();
    await handleCookingRequest(
      cooking.socket,
      {
        rawFoodId: "raw_shrimp",
        rawFoodSlot: 6,
        fireId: "range1",
        requestId,
      },
      cooking.ctx,
    );
    expect(cooking.queuePendingCook).toHaveBeenCalledWith(
      "player1",
      "range1",
      expect.any(Object),
      123,
      undefined,
      6,
      requestId,
    );
    expect(cooking.beginProcessingRequestAsync).toHaveBeenCalledWith(
      "player1",
      `processing-request:cooking:${requestId}`,
      requestId,
      "cooking",
      {
        skill: "cooking",
        rawFoodId: "raw_shrimp",
        rawFoodSlot: 6,
        sourceId: "range1",
        sourceType: "range",
      },
    );

    const tanning = createContext({ tanningAuthorized: true });
    await handleProcessingTanning(
      tanning.socket,
      { inputItemId: "cowhide", quantity: 2, requestId },
      tanning.ctx,
    );
    expect(tanning.emit).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      expect.objectContaining({ requestId, reason: "invalid_request" }),
    );
  });

  it("rejects malformed processing request identities before action dispatch", () => {
    const firemaking = createContext();
    handleFiremakingRequest(
      firemaking.socket,
      {
        logsId: "logs",
        logsSlot: 2,
        tinderboxSlot: 4,
        requestId: "not-a-uuid",
      },
      firemaking.ctx,
    );
    expect(firemaking.emit).not.toHaveBeenCalled();

    const cooking = createContext();
    handleCookingRequest(
      cooking.socket,
      {
        rawFoodId: "raw_shrimp",
        rawFoodSlot: 6,
        fireId: "range1",
        requestId: "not-a-uuid",
      },
      cooking.ctx,
    );
    expect(cooking.queuePendingCook).not.toHaveBeenCalled();
  });

  it("returns a correlated busy rejection when the request limiter denies work", () => {
    const { socket, ctx, emit } = createContext({ canProcess: false });
    handleProcessingFletching(
      socket,
      { recipeId: "arrow_shaft:logs", quantity: 1, requestId },
      ctx,
    );

    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_REJECTED, {
      playerId: "player1",
      requestId,
      skill: "fletching",
      reason: "busy",
      retryable: true,
    });
    expect(emit).not.toHaveBeenCalledWith(
      EventType.PROCESSING_FLETCHING_REQUEST,
      expect.anything(),
    );
  });

  it("correlates definitive pre-dispatch rejection across every direct handler", () => {
    const cases: Array<{
      skill: string;
      reason: string;
      invoke: (
        socket: Parameters<typeof handleFiremakingRequest>[0],
        ctx: Parameters<typeof handleFiremakingRequest>[2],
      ) => void;
    }> = [
      {
        skill: "firemaking",
        reason: "resources_unavailable",
        invoke: (socket, ctx) =>
          handleFiremakingRequest(
            socket,
            { logsId: "oak_logs", logsSlot: 2, tinderboxSlot: 4, requestId },
            ctx,
          ),
      },
      {
        skill: "cooking",
        reason: "resources_unavailable",
        invoke: (socket, ctx) =>
          handleCookingRequest(
            socket,
            {
              rawFoodId: "raw_shark",
              rawFoodSlot: 6,
              fireId: "range1",
              requestId,
            },
            ctx,
          ),
      },
      {
        skill: "smelting",
        reason: "invalid_request",
        invoke: (socket, ctx) =>
          handleProcessingSmelting(
            socket,
            { barItemId: 3, furnaceId: "furnace-live", requestId },
            ctx,
          ),
      },
      {
        skill: "smithing",
        reason: "invalid_request",
        invoke: (socket, ctx) =>
          handleProcessingSmithing(
            socket,
            { recipeId: 3, anvilId: "anvil-live", requestId },
            ctx,
          ),
      },
      {
        skill: "crafting",
        reason: "invalid_request",
        invoke: (socket, ctx) =>
          handleProcessingCrafting(
            socket,
            { recipeId: 3, quantity: 1, requestId },
            ctx,
          ),
      },
      {
        skill: "fletching",
        reason: "invalid_request",
        invoke: (socket, ctx) =>
          handleProcessingFletching(
            socket,
            { recipeId: 3, quantity: 1, requestId },
            ctx,
          ),
      },
    ];

    for (const testCase of cases) {
      const { socket, ctx, emit } = createContext();
      testCase.invoke(socket, ctx);
      expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "player1",
        requestId,
        skill: testCase.skill,
        reason: testCase.reason,
        retryable: false,
      });
    }

    const tanning = createContext({ tanningAuthorized: false });
    handleProcessingTanning(
      tanning.socket,
      { inputItemId: "cowhide", quantity: 1, requestId },
      tanning.ctx,
    );
    expect(tanning.emit).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      {
        playerId: "player1",
        requestId,
        skill: "tanning",
        reason: "not_authorized",
        retryable: false,
      },
    );
  });

  it.each([
    {
      handler: handleProcessingSmelting,
      payload: {
        barItemId: "bronze_bar",
        furnaceId: "furnace-live",
        quantity: 1,
      },
      eventType: EventType.PROCESSING_SMELTING_REQUEST,
      skill: "smelting",
      envelope: {
        skill: "smelting",
        barItemId: "bronze_bar",
        furnaceId: "furnace-live",
        quantity: 1,
      },
    },
    {
      handler: handleProcessingSmithing,
      payload: {
        recipeId: "bronze_dagger",
        anvilId: "anvil-live",
        quantity: 1,
      },
      eventType: EventType.PROCESSING_SMITHING_REQUEST,
      skill: "smithing",
      envelope: {
        skill: "smithing",
        recipeId: "bronze_dagger",
        anvilId: "anvil-live",
        quantity: 1,
      },
    },
    {
      handler: handleProcessingCrafting,
      payload: { recipeId: "leather_gloves", quantity: 1 },
      eventType: EventType.PROCESSING_CRAFTING_REQUEST,
      skill: "crafting",
      envelope: {
        skill: "crafting",
        recipeId: "leather_gloves",
        quantity: 1,
      },
    },
    {
      handler: handleProcessingFletching,
      payload: { recipeId: "arrow_shaft:logs", quantity: 1 },
      eventType: EventType.PROCESSING_FLETCHING_REQUEST,
      skill: "fletching",
      envelope: {
        skill: "fletching",
        recipeId: "arrow_shaft:logs",
        quantity: 1,
      },
    },
  ])(
    "validates request identity for $eventType",
    async ({ handler, payload, eventType, skill, envelope }) => {
      const valid = createContext();
      await handler(valid.socket, { ...payload, requestId }, valid.ctx);
      expect(valid.emit).toHaveBeenCalledWith(
        eventType,
        expect.objectContaining({ requestId }),
      );
      expect(valid.beginProcessingRequestAsync).toHaveBeenCalledWith(
        "player1",
        `processing-request:${skill}:${requestId}`,
        requestId,
        skill,
        envelope,
      );

      const invalid = createContext();
      handler(
        invalid.socket,
        { ...payload, requestId: "not-a-uuid" },
        invalid.ctx,
      );
      expect(invalid.emit).not.toHaveBeenCalled();
    },
  );

  it("durably admits a single correlated tanning action", async () => {
    const tanning = createContext({ tanningAuthorized: true });
    await handleProcessingTanning(
      tanning.socket,
      { inputItemId: "cowhide", quantity: 1, requestId },
      tanning.ctx,
    );

    expect(tanning.beginProcessingRequestAsync).toHaveBeenCalledWith(
      "player1",
      `processing-request:tanning:${requestId}`,
      requestId,
      "tanning",
      {
        skill: "tanning",
        inputItemId: "cowhide",
        quantity: 1,
        tannerEntityId: "tanner-live",
        tannerNpcId: "tanner",
      },
    );
    expect(tanning.emit).toHaveBeenCalledWith(EventType.TANNING_REQUEST, {
      playerId: "player1",
      inputItemId: "cowhide",
      quantity: 1,
      requestId,
    });
  });

  it.each([
    {
      options: { admissionResult: "pending" as const },
      rejection: null,
    },
    {
      options: { admissionResult: "busy" as const },
      rejection: { reason: "busy", retryable: true },
    },
    {
      options: { admissionResult: "rejected" as const },
      rejection: { reason: "persistence_rejected", retryable: false },
    },
    {
      options: { admissionError: true },
      rejection: { reason: "persistence_rejected", retryable: true },
    },
  ])(
    "fails closed before dispatch for durable admission outcome %#",
    async ({ options, rejection }) => {
      const current = createContext(options);
      await handleProcessingCrafting(
        current.socket,
        { recipeId: "leather_gloves", quantity: 1, requestId },
        current.ctx,
      );

      expect(current.emit).not.toHaveBeenCalledWith(
        EventType.PROCESSING_CRAFTING_REQUEST,
        expect.anything(),
      );
      if (rejection) {
        expect(current.emit).toHaveBeenCalledWith(
          EventType.PROCESSING_REQUEST_REJECTED,
          {
            playerId: "player1",
            requestId,
            skill: "crafting",
            ...rejection,
          },
        );
      } else {
        expect(current.emit).not.toHaveBeenCalledWith(
          EventType.PROCESSING_REQUEST_REJECTED,
          expect.anything(),
        );
      }
    },
  );

  it("reports an admission-race commit without dispatching gameplay twice", async () => {
    const current = createContext({ admissionResult: "committed" });
    await handleProcessingCrafting(
      current.socket,
      { recipeId: "leather_gloves", quantity: 1, requestId },
      current.ctx,
    );

    expect(current.emit).not.toHaveBeenCalledWith(
      EventType.PROCESSING_CRAFTING_REQUEST,
      expect.anything(),
    );
    expect(current.emit).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_PROGRESS,
      {
        playerId: "player1",
        requestId,
        skill: "crafting",
        phase: "committed",
      },
    );
    expect(current.emit).not.toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      expect.anything(),
    );
  });

  it("rejects a cooking slot whose authoritative item differs", () => {
    const { socket, ctx, queuePendingCook } = createContext();
    handleCookingRequest(
      socket,
      { rawFoodId: "raw_shark", rawFoodSlot: 6, fireId: "range1" },
      ctx,
    );
    expect(queuePendingCook).not.toHaveBeenCalled();
  });

  it("retains the find-first sentinel for authoritative server selection", () => {
    const { socket, ctx, queuePendingCook } = createContext();
    handleCookingRequest(
      socket,
      { rawFoodId: "raw_shrimp", rawFoodSlot: -1, fireId: "range1" },
      ctx,
    );
    expect(queuePendingCook).toHaveBeenCalledWith(
      "player1",
      "range1",
      expect.any(Object),
      123,
      undefined,
      -1,
    );
  });

  it("emits tanning only through an active authoritative Tanner session", () => {
    const { socket, ctx, emit } = createContext({ tanningAuthorized: true });
    handleProcessingTanning(
      socket,
      { inputItemId: "cowhide", quantity: 2 },
      ctx,
    );
    expect(emit).toHaveBeenCalledWith(EventType.TANNING_REQUEST, {
      playerId: "player1",
      inputItemId: "cowhide",
      quantity: 2,
    });
  });

  it("rejects tanning without an active authoritative Tanner session", () => {
    const { socket, ctx, emit } = createContext({ tanningAuthorized: false });
    handleProcessingTanning(
      socket,
      { inputItemId: "cowhide", quantity: 2 },
      ctx,
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
