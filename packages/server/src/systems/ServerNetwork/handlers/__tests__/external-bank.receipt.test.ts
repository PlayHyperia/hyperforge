import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  execute: vi.fn(),
  recover: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../../../eliza/externalAgentBanking.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../../eliza/externalAgentBanking.js")
    >();
  return {
    ...original,
    acknowledgeExternalAgentBankOperation: mocks.acknowledge,
    executeExternalAgentBankOperation: mocks.execute,
    normalizeExternalAgentBankEnvelope: (value: unknown) => value,
    recoverExternalAgentBankOperation: mocks.recover,
  };
});

vi.mock("../bank/core.js", () => ({
  handleRequestBankState: mocks.refresh,
}));

import {
  handleExternalAgentBankRecovery,
  handleExternalAgentBankTransfer,
} from "../bank/agent";

const requestId = "00000000-0000-4000-8000-000000000001";
const operationId = "11111111-1111-4111-8111-111111111111";
const envelope = {
  action: "deposit" as const,
  bankId: "bank-live",
  itemId: "logs",
  quantity: 2,
  retainedItems: [],
};
const receipt = {
  success: true,
  operationId,
  commitState: "committed" as const,
  replayed: false,
  action: "deposit" as const,
  playerId: "external-bank-player",
  bankId: "bank-live",
  itemId: "logs",
  requestedQuantity: 2,
  committedQuantity: 2,
  inventoryQuantityAfter: 0,
  bankQuantityAfter: 2,
};

function harness() {
  const send = vi.fn();
  return {
    send,
    socket: { player: { id: "external-bank-player" }, send } as never,
    world: {} as never,
  };
}

describe("ordinary external-agent bank network receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue(receipt);
    mocks.recover.mockResolvedValue(null);
    mocks.acknowledge.mockResolvedValue(true);
    mocks.refresh.mockResolvedValue(undefined);
  });

  it("keeps correlation separate from the exact server operation receipt", async () => {
    const state = harness();
    await handleExternalAgentBankTransfer(
      state.socket,
      { requestId, envelope },
      state.world,
    );

    expect(mocks.execute).toHaveBeenCalledWith(
      state.world,
      "external-bank-player",
      envelope,
    );
    expect(mocks.refresh).toHaveBeenCalledBefore(state.send);
    expect(state.send).toHaveBeenCalledWith("externalAgentBankTransfer", {
      requestId,
      receipt,
    });
  });

  it("returns the one authenticated recovery head and acknowledges only its UUID", async () => {
    const state = harness();
    mocks.recover.mockResolvedValue({
      version: 1,
      operationId,
      envelope,
      status: "committed",
      receipt,
      acceptedAt: 1,
      terminalAt: 2,
      acknowledgedAt: null,
    });

    await handleExternalAgentBankRecovery(
      state.socket,
      { action: "query", queryId: requestId },
      state.world,
    );
    expect(state.send).toHaveBeenCalledWith("externalAgentBankRecovery", {
      action: "state",
      queryId: requestId,
      available: true,
      operation: { operationId, status: "committed", receipt },
    });

    const ackQueryId = "00000000-0000-4000-8000-000000000002";
    await handleExternalAgentBankRecovery(
      state.socket,
      { action: "ack", queryId: ackQueryId, operationId },
      state.world,
    );
    expect(mocks.acknowledge).toHaveBeenCalledWith(
      state.world,
      "external-bank-player",
      operationId,
    );
    expect(state.send).toHaveBeenCalledWith("externalAgentBankRecovery", {
      action: "acknowledged",
      queryId: ackQueryId,
      operationId,
      acknowledged: true,
    });
  });

  it("ignores malformed correlation IDs without entering custody code", async () => {
    const state = harness();
    await handleExternalAgentBankTransfer(
      state.socket,
      { requestId: "not-a-uuid", envelope },
      state.world,
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });
});
