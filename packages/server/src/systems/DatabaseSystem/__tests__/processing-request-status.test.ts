import { describe, expect, it, vi } from "vitest";
import { DatabaseSystem } from "../index";

function createSystem(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const system = Object.create(DatabaseSystem.prototype) as DatabaseSystem;
  Object.assign(system as object, {
    db: { select },
    isDestroying: false,
    processingRequestOwnerId: "owner-current",
  });
  return { from, select, system, where };
}

describe("DatabaseSystem processing request status", () => {
  it("returns committed only for the exact player-owned completed processing receipt", async () => {
    const operationId =
      "processing-request:smelting:d8c72678-bcee-435a-bc04-e6de3fa739b6";
    const { system, where } = createSystem([
      {
        playerId: "player-1",
        operationType: "processing_action",
        completed: true,
      },
    ]);

    await expect(
      system.getProcessingActionCommitStatusAsync("player-1", operationId),
    ).resolves.toBe("committed");
    expect(where).toHaveBeenCalledOnce();
  });

  it.each([
    {
      playerId: "other-player",
      operationType: "processing_action",
      completed: true,
    },
    {
      playerId: "player-1",
      operationType: "inventory_debit",
      completed: true,
    },
    {
      playerId: "player-1",
      operationType: "processing_action",
      completed: false,
    },
  ])("does not disclose a foreign or non-terminal receipt: %o", async (row) => {
    const { system } = createSystem([row]);
    await expect(
      system.getProcessingActionCommitStatusAsync(
        "player-1",
        "processing-request:crafting:4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208",
      ),
    ).resolves.toBe("not_found");
  });

  it.each([
    {
      ownerId: "owner-current",
      expected: "pending",
    },
    {
      ownerId: "owner-replaced",
      expected: "interrupted",
    },
  ] as const)(
    "reports an exact incomplete receipt owned by $ownerId as $expected",
    async ({ expected, ownerId }) => {
      const requestId = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";
      const operationId = `processing-request:crafting:${requestId}`;
      const { system } = createSystem([
        {
          playerId: "player-1",
          operationType: "processing_request",
          completed: false,
          operationState: {
            version: 1,
            requestId,
            skill: "crafting",
            ownerId,
            acceptedAt: 100,
            heartbeatAt: 200,
          },
        },
      ]);

      await expect(
        system.getProcessingActionCommitStatusAsync("player-1", operationId),
      ).resolves.toBe(expected);
    },
  );

  it("reports only an exact terminal rejection", async () => {
    const requestId = "cb2ffba7-36ea-498c-9d6d-d05123bb91ad";
    const operationId = `processing-request:fletching:${requestId}`;
    const { system } = createSystem([
      {
        playerId: "player-1",
        operationType: "processing_request_rejected",
        completed: true,
        operationState: {
          version: 1,
          requestId,
          skill: "fletching",
          ownerId: "owner-current",
          acceptedAt: 100,
          heartbeatAt: 200,
          reason: "resources_unavailable",
          retryable: false,
          rejectedAt: 300,
        },
      },
    ]);

    await expect(
      system.getProcessingActionCommitStatusAsync("player-1", operationId),
    ).resolves.toBe("rejected");
  });

  it("fails closed when persistence is unavailable or the query is malformed", async () => {
    const unavailable = Object.create(
      DatabaseSystem.prototype,
    ) as DatabaseSystem;
    Object.assign(unavailable as object, { db: null, isDestroying: false });
    await expect(
      unavailable.getProcessingActionCommitStatusAsync("player-1", "receipt"),
    ).rejects.toThrow("processing_action_database_unavailable");

    const { system } = createSystem([]);
    await expect(
      system.getProcessingActionCommitStatusAsync("", "receipt"),
    ).rejects.toThrow("processing_action_request_invalid");
  });
});
