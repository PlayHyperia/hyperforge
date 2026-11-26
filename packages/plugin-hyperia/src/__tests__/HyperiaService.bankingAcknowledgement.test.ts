import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperiaService } from "../services/HyperiaService";

vi.mock("../systems/liveKit.js", () => ({
  AgentLiveKit: class {
    async stop(): Promise<void> {}
  },
}));

type BankTestInternals = {
  activeBankId: string | null;
  bankOperationInFlight: boolean;
  externalBankRecoveryReady: boolean;
  cancelPendingBankResponses: () => void;
  connectionState: { connected: boolean };
  gameState: {
    playerEntity: {
      id: string;
      items: Array<{
        id: string;
        itemId: string;
        name: string;
        quantity: number;
      }>;
    } | null;
    bankItems: Array<{ itemId: string; quantity: number }>;
  };
  sendCommand: (command: string, data: unknown) => void;
  updateGameStateFromPacket: (packetName: string, data: unknown) => void;
  ws: object | null;
};

function createService() {
  const service = new HyperiaService({
    agentId: "bank-ack-agent",
    getSetting: vi.fn().mockReturnValue(null),
  } as never);
  const internals = service as unknown as BankTestInternals;
  const sendCommand = vi.fn();
  internals.connectionState.connected = true;
  internals.externalBankRecoveryReady = true;
  internals.ws = {};
  internals.gameState.playerEntity = {
    id: "bank-ack-agent",
    items: [],
  };
  internals.gameState.bankItems = [];
  internals.sendCommand = sendCommand;
  return { service, internals, sendCommand };
}

function settleExternalTransfer(
  internals: BankTestInternals,
  request: { requestId: string; envelope: Record<string, unknown> },
  overrides: Record<string, unknown> = {},
): void {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const envelope = request.envelope;
  internals.updateGameStateFromPacket("externalAgentBankTransfer", {
    requestId: request.requestId,
    receipt: {
      success: true,
      operationId,
      commitState: "committed",
      replayed: false,
      action: envelope.action,
      playerId: "bank-ack-agent",
      bankId: envelope.bankId,
      itemId: envelope.itemId,
      requestedQuantity:
        envelope.action === "deposit_all" ? 1 : envelope.quantity,
      committedQuantity:
        envelope.action === "deposit_all" ? 1 : envelope.quantity,
      inventoryQuantityAfter: 1,
      bankQuantityAfter: 4,
      ...overrides,
    },
  });
}

function acknowledgeRecovery(
  internals: BankTestInternals,
  data: unknown,
): void {
  const request = data as { queryId: string; operationId: string };
  internals.updateGameStateFromPacket("externalAgentBankRecovery", {
    action: "acknowledged",
    queryId: request.queryId,
    operationId: request.operationId,
    acknowledged: true,
  });
}

function acknowledgeOpen(
  internals: BankTestInternals,
  data: unknown,
  items: Array<{ itemId: string; quantity: number }> = [],
): void {
  const requestId = (data as { requestId: string }).requestId;
  internals.updateGameStateFromPacket("bankState", {
    bankId: "bank-live",
    isOpen: true,
    requestId,
    items,
  });
}

describe("HyperiaService bank acknowledgements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens only after the exact correlated bank response", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();

    const pending = service.openBank("bank-live");
    const request = sendCommand.mock.calls[0]?.[1] as { requestId: string };
    internals.updateGameStateFromPacket("bankState", {
      bankId: "bank-live",
      isOpen: true,
      requestId: "00000000-0000-4000-8000-000000000001",
      items: [],
    });

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    internals.updateGameStateFromPacket("bankState", {
      bankId: "bank-live",
      isOpen: true,
      requestId: request.requestId,
      items: [],
    });
    await expect(pending).resolves.toBe(true);
  });

  it("drains durable custody state before opening a new bank session", async () => {
    const { service, internals, sendCommand } = createService();
    internals.externalBankRecoveryReady = false;
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "externalAgentBankRecovery") {
        const request = data as { action: string; queryId: string };
        queueMicrotask(() =>
          internals.updateGameStateFromPacket("externalAgentBankRecovery", {
            action: "state",
            queryId: request.queryId,
            available: true,
            operation: null,
          }),
        );
      } else if (command === "bankOpen") {
        queueMicrotask(() => acknowledgeOpen(internals, data));
      }
    });

    await expect(service.openBank("bank-live")).resolves.toBe(true);
    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
      "externalAgentBankRecovery",
      "bankOpen",
    ]);
  });

  it("fails a timed-out open closed without retaining an unrelated session", async () => {
    vi.useFakeTimers();
    const { service, internals } = createService();

    const pending = service.openBank("bank-live");
    internals.updateGameStateFromPacket("bankState", {
      bankId: "bank-other",
      isOpen: true,
      requestId: "00000000-0000-4000-8000-000000000001",
      items: [],
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBe(false);
    expect(internals.activeBankId).toBeNull();
  });

  it("requires the correlated response and exact conserved deposit deltas", async () => {
    const { service, internals, sendCommand } = createService();
    internals.gameState.playerEntity!.items = [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 3 },
    ];
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "bankOpen") {
        queueMicrotask(() =>
          acknowledgeOpen(internals, data, [{ itemId: "logs", quantity: 2 }]),
        );
      } else if (command === "externalAgentBankTransfer") {
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("inventoryUpdated", {
            items: [
              {
                itemId: "logs",
                quantity: 1,
                item: { id: "logs", name: "Logs" },
              },
            ],
          });
          internals.updateGameStateFromPacket("bankState", {
            items: [{ itemId: "logs", quantity: 4 }],
          });
          settleExternalTransfer(
            internals,
            data as { requestId: string; envelope: Record<string, unknown> },
          );
        });
      } else if (command === "externalAgentBankRecovery") {
        queueMicrotask(() => acknowledgeRecovery(internals, data));
      }
    });

    await expect(service.openBank("bank-live")).resolves.toBe(true);
    await expect(service.bankDeposit("logs", 2)).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith("externalAgentBankTransfer", {
      requestId: expect.any(String),
      envelope: {
        action: "deposit",
        bankId: "bank-live",
        itemId: "logs",
        quantity: 2,
        retainedItems: [],
      },
    });
  });

  it("does not mistake unrelated inventory activity for a committed deposit", async () => {
    vi.useFakeTimers();
    const { service, internals, sendCommand } = createService();
    internals.gameState.playerEntity!.items = [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 3 },
    ];
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "bankOpen") {
        queueMicrotask(() =>
          acknowledgeOpen(internals, data, [{ itemId: "logs", quantity: 2 }]),
        );
      } else if (command === "externalAgentBankTransfer") {
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("inventoryUpdated", {
            items: [
              {
                itemId: "logs",
                quantity: 3,
                item: { id: "logs", name: "Logs" },
              },
              {
                itemId: "shrimp",
                quantity: 1,
                item: { id: "shrimp", name: "Shrimp" },
              },
            ],
          });
          internals.updateGameStateFromPacket("bankState", {
            items: [{ itemId: "logs", quantity: 2 }],
          });
          settleExternalTransfer(
            internals,
            data as { requestId: string; envelope: Record<string, unknown> },
          );
        });
      } else if (command === "externalAgentBankRecovery") {
        queueMicrotask(() => acknowledgeRecovery(internals, data));
      }
    });

    await expect(service.openBank("bank-live")).resolves.toBe(true);
    const pending = service.bankDeposit("logs", 2);
    await vi.advanceTimersByTimeAsync(2_600);
    await expect(pending).resolves.toBe(false);
  });

  it("accepts an exact withdrawal only when bank and inventory conserve", async () => {
    const { service, internals, sendCommand } = createService();
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "bankOpen") {
        queueMicrotask(() =>
          acknowledgeOpen(internals, data, [{ itemId: "shark", quantity: 5 }]),
        );
      } else if (command === "externalAgentBankTransfer") {
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("inventoryUpdated", {
            items: [
              {
                itemId: "shark",
                quantity: 5,
                item: { id: "shark", name: "Shark" },
              },
            ],
          });
          internals.updateGameStateFromPacket("bankState", {
            items: [{ itemId: "shark", quantity: 0 }],
          });
          settleExternalTransfer(
            internals,
            data as { requestId: string; envelope: Record<string, unknown> },
            {
              requestedQuantity: 5,
              committedQuantity: 5,
              inventoryQuantityAfter: 5,
              bankQuantityAfter: 0,
            },
          );
        });
      } else if (command === "externalAgentBankRecovery") {
        queueMicrotask(() => acknowledgeRecovery(internals, data));
      }
    });

    await expect(service.openBank("bank-live")).resolves.toBe(true);
    await expect(service.bankWithdraw("shark", 5)).resolves.toBe(true);
  });

  it("serializes bank operations and cancels a waiter when transport closes", async () => {
    const { service, internals, sendCommand } = createService();
    const first = service.openBank("bank-live");

    await expect(service.openBank("bank-other")).resolves.toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(1);

    internals.connectionState.connected = false;
    internals.ws = null;
    internals.cancelPendingBankResponses();
    await expect(first).resolves.toBe(false);
    expect(internals.bankOperationInFlight).toBe(false);
  });

  it("drains and acknowledges a durable prior receipt before sending a new transfer", async () => {
    const { service, internals, sendCommand } = createService();
    internals.externalBankRecoveryReady = false;
    internals.activeBankId = "bank-live";
    internals.gameState.playerEntity!.items = [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 2 },
    ];
    internals.gameState.bankItems = [{ itemId: "logs", quantity: 1 }];
    let queryCount = 0;
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "externalAgentBankRecovery") {
        const request = data as {
          action: string;
          queryId: string;
          operationId?: string;
        };
        if (request.action === "ack") {
          queueMicrotask(() => acknowledgeRecovery(internals, data));
          return;
        }
        queryCount += 1;
        queueMicrotask(() =>
          internals.updateGameStateFromPacket("externalAgentBankRecovery", {
            action: "state",
            queryId: request.queryId,
            available: true,
            operation:
              queryCount === 1
                ? {
                    operationId: "22222222-2222-4222-8222-222222222222",
                    status: "committed",
                    receipt: {
                      success: true,
                      operationId: "22222222-2222-4222-8222-222222222222",
                      commitState: "committed",
                      replayed: true,
                      action: "withdraw",
                      playerId: "bank-ack-agent",
                      bankId: "bank-live",
                      itemId: "shrimp",
                      requestedQuantity: 1,
                      committedQuantity: 1,
                      inventoryQuantityAfter: 1,
                      bankQuantityAfter: 0,
                    },
                  }
                : null,
          }),
        );
        return;
      }
      if (command === "externalAgentBankTransfer") {
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("inventoryUpdated", {
            items: [],
          });
          internals.updateGameStateFromPacket("bankState", {
            items: [{ itemId: "logs", quantity: 3 }],
          });
          settleExternalTransfer(
            internals,
            data as { requestId: string; envelope: Record<string, unknown> },
            {
              requestedQuantity: 2,
              committedQuantity: 2,
              inventoryQuantityAfter: 0,
              bankQuantityAfter: 3,
            },
          );
        });
      }
    });

    await expect(service.bankDeposit("logs", 2)).resolves.toBe(true);
    expect(queryCount).toBe(2);
    const commands = sendCommand.mock.calls.map(([command]) => command);
    const transferIndex = commands.indexOf("externalAgentBankTransfer");
    expect(commands.slice(0, transferIndex)).toEqual([
      "externalAgentBankRecovery",
      "externalAgentBankRecovery",
      "externalAgentBankRecovery",
    ]);
  });

  it("marks the durable recovery gate unready when a transfer response is lost", async () => {
    vi.useFakeTimers();
    const { service, internals } = createService();
    internals.activeBankId = "bank-live";
    internals.gameState.playerEntity!.items = [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 2 },
    ];

    const pending = service.bankDeposit("logs", 2);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(false);
    expect(internals.externalBankRecoveryReady).toBe(false);
  });

  it("recovers the prior durable head before retrying after recovery_required", async () => {
    const { service, internals, sendCommand } = createService();
    internals.activeBankId = "bank-live";
    internals.gameState.playerEntity!.items = [
      { id: "logs", itemId: "logs", name: "Logs", quantity: 2 },
    ];
    internals.gameState.bankItems = [{ itemId: "logs", quantity: 1 }];
    let transferCount = 0;
    let queryCount = 0;
    sendCommand.mockImplementation((command: string, data: unknown) => {
      if (command === "externalAgentBankTransfer") {
        transferCount += 1;
        if (transferCount === 1) {
          queueMicrotask(() =>
            settleExternalTransfer(
              internals,
              data as {
                requestId: string;
                envelope: Record<string, unknown>;
              },
              {
                success: false,
                operationId: "33333333-3333-4333-8333-333333333333",
                commitState: "not_committed",
                committedQuantity: 0,
                inventoryQuantityAfter: null,
                bankQuantityAfter: null,
                failureReason: "recovery_required",
              },
            ),
          );
          return;
        }
        queueMicrotask(() => {
          internals.updateGameStateFromPacket("inventoryUpdated", {
            items: [],
          });
          internals.updateGameStateFromPacket("bankState", {
            items: [{ itemId: "logs", quantity: 3 }],
          });
          settleExternalTransfer(
            internals,
            data as {
              requestId: string;
              envelope: Record<string, unknown>;
            },
            {
              requestedQuantity: 2,
              committedQuantity: 2,
              inventoryQuantityAfter: 0,
              bankQuantityAfter: 3,
            },
          );
        });
        return;
      }
      if (command !== "externalAgentBankRecovery") return;
      const request = data as {
        action: string;
        queryId: string;
        operationId?: string;
      };
      if (request.action === "ack") {
        queueMicrotask(() => acknowledgeRecovery(internals, data));
        return;
      }
      queryCount += 1;
      queueMicrotask(() =>
        internals.updateGameStateFromPacket("externalAgentBankRecovery", {
          action: "state",
          queryId: request.queryId,
          available: true,
          operation:
            queryCount === 1
              ? {
                  operationId: "44444444-4444-4444-8444-444444444444",
                  status: "committed",
                  receipt: {
                    success: true,
                    operationId: "44444444-4444-4444-8444-444444444444",
                    commitState: "committed",
                    replayed: true,
                    action: "withdraw",
                    playerId: "bank-ack-agent",
                    bankId: "bank-live",
                    itemId: "shrimp",
                    requestedQuantity: 1,
                    committedQuantity: 1,
                    inventoryQuantityAfter: 1,
                    bankQuantityAfter: 0,
                  },
                }
              : null,
        }),
      );
    });

    await expect(service.bankDeposit("logs", 2)).resolves.toBe(false);
    expect(internals.externalBankRecoveryReady).toBe(false);
    await expect(service.bankDeposit("logs", 2)).resolves.toBe(true);
    expect(transferCount).toBe(2);
    expect(queryCount).toBe(2);
  });
});
