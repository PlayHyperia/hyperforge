import { describe, expect, it, vi } from "vitest";
import { EventType } from "@hyperforge/shared";
import type { ServerSocket } from "../../../shared/types";
import {
  handleProcessingCrafting,
  handleProcessingFletching,
  handleProcessingRequestRecovery,
  handleProcessingRequestStatus,
  handleProcessingSmelting,
  handleProcessingSmithing,
  type ProcessingHandlerContext,
} from "../handlers/processing";

function setup(
  status:
    | "committed"
    | "pending"
    | "interrupted"
    | "rejected"
    | "not_found" = "committed",
) {
  const send = vi.fn();
  const emit = vi.fn();
  const getProcessingActionCommitStatusAsync = vi
    .fn()
    .mockResolvedValue(status);
  const getRecoverableProcessingRequestAsync = vi.fn().mockResolvedValue(null);
  const acknowledgeProcessingRequestAsync = vi.fn().mockResolvedValue(true);
  const database = {
    acknowledgeProcessingRequestAsync,
    getProcessingActionCommitStatusAsync,
    getRecoverableProcessingRequestAsync,
  };
  const world = {
    emit,
    getSystem: vi.fn((name: string) =>
      name === "database" ? database : undefined,
    ),
  };
  const socket = {
    player: { id: "player-1" },
    send,
  } as unknown as ServerSocket;
  const ctx = {
    world,
    canProcessRequest: () => true,
  } as unknown as ProcessingHandlerContext;
  return {
    ctx,
    acknowledgeProcessingRequestAsync,
    emit,
    getProcessingActionCommitStatusAsync,
    getRecoverableProcessingRequestAsync,
    send,
    socket,
  };
}

describe("processing request durable status", () => {
  it("resolves only the authenticated player's deterministic receipt", async () => {
    const { ctx, getProcessingActionCommitStatusAsync, send, socket } = setup();
    const requestId = "d8c72678-bcee-435a-bc04-e6de3fa739b6";
    const queryId = "aa4f70f6-60e3-45dd-8854-930609ed35e9";

    await handleProcessingRequestStatus(
      socket,
      {
        requestId: requestId.toUpperCase(),
        queryId: queryId.toUpperCase(),
        skill: "smelting",
      },
      ctx,
    );

    expect(getProcessingActionCommitStatusAsync).toHaveBeenCalledWith(
      "player-1",
      `processing-request:smelting:${requestId}`,
    );
    expect(send).toHaveBeenCalledWith("processingRequestStatus", {
      requestId,
      queryId,
      skill: "smelting",
      status: "committed",
    });
  });

  it("fails closed on database unavailability and does not reflect malformed IDs", async () => {
    const available = setup();
    available.getProcessingActionCommitStatusAsync.mockRejectedValueOnce(
      new Error("database offline"),
    );
    const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
    const queryId = "778a1614-bcf5-4c57-9752-9ece5fda7a10";
    await handleProcessingRequestStatus(
      available.socket,
      { requestId, queryId, skill: "tanning" },
      available.ctx,
    );
    expect(available.send).toHaveBeenCalledWith("processingRequestStatus", {
      requestId,
      queryId,
      skill: "tanning",
      status: "unavailable",
    });

    const malformed = setup();
    await handleProcessingRequestStatus(
      malformed.socket,
      { requestId: "not-a-uuid", queryId, skill: "tanning" },
      malformed.ctx,
    );
    await handleProcessingRequestStatus(
      malformed.socket,
      { requestId, queryId: "not-a-uuid", skill: "tanning" },
      malformed.ctx,
    );
    expect(
      malformed.getProcessingActionCommitStatusAsync,
    ).not.toHaveBeenCalled();
    expect(malformed.send).not.toHaveBeenCalled();
  });

  it.each(["pending", "interrupted", "rejected"] as const)(
    "propagates the authenticated request's durable %s lifecycle state",
    async (status) => {
      const { ctx, send, socket } = setup(status);
      const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
      const queryId = "778a1614-bcf5-4c57-9752-9ece5fda7a10";

      await handleProcessingRequestStatus(
        socket,
        { requestId, queryId, skill: "crafting" },
        ctx,
      );

      expect(send).toHaveBeenCalledWith("processingRequestStatus", {
        requestId,
        queryId,
        skill: "crafting",
        status,
      });
    },
  );

  it("returns and acknowledges only the authenticated player's durable recovery envelope", async () => {
    const state = setup();
    const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
    const queryId = "778a1614-bcf5-4c57-9752-9ece5fda7a10";
    const request = {
      requestId,
      skill: "smelting" as const,
      status: "interrupted" as const,
      envelope: {
        skill: "smelting" as const,
        barItemId: "bronze_bar",
        furnaceId: "furnace-live",
        quantity: 1 as const,
      },
      acceptedAt: 100,
      heartbeatAt: 200,
      terminalAt: null,
    };
    state.getRecoverableProcessingRequestAsync.mockResolvedValueOnce(request);

    await handleProcessingRequestRecovery(
      state.socket,
      { action: "query", queryId: queryId.toUpperCase() },
      state.ctx,
    );
    expect(state.getRecoverableProcessingRequestAsync).toHaveBeenCalledWith(
      "player-1",
    );
    expect(state.send).toHaveBeenCalledWith("processingRequestRecovery", {
      action: "state",
      queryId,
      available: true,
      request,
    });

    await handleProcessingRequestRecovery(
      state.socket,
      { action: "ack", queryId, requestId: requestId.toUpperCase() },
      state.ctx,
    );
    expect(state.acknowledgeProcessingRequestAsync).toHaveBeenCalledWith(
      "player-1",
      requestId,
    );
    expect(state.send).toHaveBeenCalledWith("processingRequestRecovery", {
      action: "acknowledged",
      queryId,
      requestId,
      acknowledged: true,
    });
  });

  it("fails recovery closed when persistence is unavailable or input is malformed", async () => {
    const unavailable = setup();
    unavailable.getRecoverableProcessingRequestAsync.mockRejectedValueOnce(
      new Error("database offline"),
    );
    const queryId = "778a1614-bcf5-4c57-9752-9ece5fda7a10";
    await handleProcessingRequestRecovery(
      unavailable.socket,
      { action: "query", queryId },
      unavailable.ctx,
    );
    expect(unavailable.send).toHaveBeenCalledWith("processingRequestRecovery", {
      action: "state",
      queryId,
      available: false,
      request: null,
    });

    const malformed = setup();
    await handleProcessingRequestRecovery(
      malformed.socket,
      { action: "query", queryId: "not-a-uuid" },
      malformed.ctx,
    );
    await handleProcessingRequestRecovery(
      malformed.socket,
      { action: "ack", queryId, requestId: "not-a-uuid" },
      malformed.ctx,
    );
    expect(
      malformed.getRecoverableProcessingRequestAsync,
    ).not.toHaveBeenCalled();
    expect(malformed.acknowledgeProcessingRequestAsync).not.toHaveBeenCalled();
    expect(malformed.send).not.toHaveBeenCalled();
  });

  it("rejects correlated multi-action batches while preserving legacy batching", () => {
    const { ctx, emit, socket } = setup();
    const requests = [
      {
        handle: handleProcessingSmelting,
        payload: { barItemId: "bronze_bar", furnaceId: "furnace-1" },
        skill: "smelting",
      },
      {
        handle: handleProcessingSmithing,
        payload: { recipeId: "bronze_dagger", anvilId: "anvil-1" },
        skill: "smithing",
      },
      {
        handle: handleProcessingCrafting,
        payload: { recipeId: "leather_gloves" },
        skill: "crafting",
      },
      {
        handle: handleProcessingFletching,
        payload: { recipeId: "arrow_shaft:logs" },
        skill: "fletching",
      },
    ] as const;

    requests.forEach(({ handle, payload, skill }, index) => {
      const requestId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      handle(socket, { ...payload, quantity: 2, requestId }, ctx);
      expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId: "player-1",
        requestId,
        skill,
        reason: "invalid_request",
        retryable: false,
      });
    });

    handleProcessingCrafting(
      socket,
      { recipeId: "leather_gloves", quantity: 2 },
      ctx,
    );
    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_CRAFTING_REQUEST, {
      playerId: "player-1",
      recipeId: "leather_gloves",
      quantity: 2,
    });
  });
});
