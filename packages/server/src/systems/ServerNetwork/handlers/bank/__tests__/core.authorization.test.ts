import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../database/repositories/BankRepository", () => ({
  BankRepository: class {
    async getPlayerBank(): Promise<unknown[]> {
      return [];
    }

    async getPlayerTabs(): Promise<unknown[]> {
      return [];
    }

    async getAlwaysSetPlaceholder(): Promise<boolean> {
      return false;
    }
  },
}));

import { handleBankOpen } from "../core";
import { sendBankStateWithTabs } from "../utils";

function createRejectedOpenHarness(bank: {
  id: string;
  type: string;
  name: string;
  position: [number, number, number];
}) {
  const entities = new Map<string, unknown>([
    [
      "player-1",
      {
        id: "player-1",
        position: [0, 0, 0],
        data: { type: "player", position: [0, 0, 0] },
      },
    ],
    [
      bank.id,
      {
        id: bank.id,
        position: bank.position,
        data: {
          type: bank.type,
          name: bank.name,
          position: bank.position,
        },
      },
    ],
  ]);
  let databaseRequested = false;
  const world = {
    entities: { get: (id: string) => entities.get(id) },
    getSystem: (name: string) => {
      if (name === "duel") return { isPlayerInDuel: () => false };
      if (name === "database") databaseRequested = true;
      return null;
    },
  };
  const send = vi.fn();
  const socket = { player: { id: "player-1" }, send };
  return {
    world,
    socket,
    send,
    wasDatabaseRequested: () => databaseRequested,
  };
}

describe("bank-open physical authorization", () => {
  it("carries a mutation request ID on the resulting bank-state snapshot", async () => {
    const send = vi.fn();
    const requestId = "00000000-0000-4000-8000-000000000002";

    await sendBankStateWithTabs(
      { send } as never,
      "player-1",
      { drizzle: {}, pool: {} } as never,
      { requestId },
    );

    expect(send).toHaveBeenCalledWith(
      "bankState",
      expect.objectContaining({ requestId }),
    );
  });

  it("echoes a valid request ID only after opening the exact physical bank", async () => {
    const entities = new Map<string, unknown>([
      [
        "player-1",
        {
          id: "player-1",
          position: [0, 0, 0],
          data: { type: "player", position: [0, 0, 0] },
        },
      ],
      [
        "bank-live",
        {
          id: "bank-live",
          position: [2, 0, 2],
          data: { type: "bank", position: [2, 0, 2] },
        },
      ],
    ]);
    const send = vi.fn();
    const world = {
      drizzleDb: {},
      pgPool: {},
      entities: { get: (id: string) => entities.get(id) },
      emit: vi.fn(),
      getSystem: (name: string) => {
        if (name === "duel") return { isPlayerInDuel: () => false };
        return null;
      },
    };
    const requestId = "00000000-0000-4000-8000-000000000001";

    await handleBankOpen(
      { player: { id: "player-1" }, send } as never,
      { bankId: "bank-live", requestId },
      world as never,
    );

    expect(send).toHaveBeenCalledWith(
      "bankState",
      expect.objectContaining({
        bankId: "bank-live",
        isOpen: true,
        requestId,
      }),
    );
  });

  it("does not disclose bank state for a nearby display-name lookalike", async () => {
    const harness = createRejectedOpenHarness({
      id: "decorative-bank-sign",
      type: "decoration",
      name: "Bank",
      position: [1, 0, 0],
    });

    await handleBankOpen(
      harness.socket as never,
      { bankId: "decorative-bank-sign" },
      harness.world as never,
    );

    expect(harness.send).toHaveBeenCalledWith("showToast", {
      message: "Invalid bank",
      type: "error",
    });
    expect(
      harness.send.mock.calls.some(([packet]) => packet === "bankState"),
    ).toBe(false);
    expect(harness.wasDatabaseRequested()).toBe(false);
  });

  it("does not disclose bank state outside the shared two-tile boundary", async () => {
    const harness = createRejectedOpenHarness({
      id: "bank-live",
      type: "bank",
      name: "Bank",
      position: [3, 0, 0],
    });

    await handleBankOpen(
      harness.socket as never,
      { bankId: "bank-live" },
      harness.world as never,
    );

    expect(harness.send).toHaveBeenCalledWith("showToast", {
      message: "You need to be closer to the bank.",
      type: "error",
    });
    expect(
      harness.send.mock.calls.some(([packet]) => packet === "bankState"),
    ).toBe(false);
    expect(harness.wasDatabaseRequested()).toBe(false);
  });
});
