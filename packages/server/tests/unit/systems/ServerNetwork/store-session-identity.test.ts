import { describe, expect, it, vi } from "vitest";
import {
  handleStoreBuy,
  handleStoreSell,
} from "../../../../src/systems/ServerNetwork/handlers/store";

function createHarness(playerId: string, targetStoreId: string) {
  const packets: Array<{ packet: string; payload: unknown }> = [];
  const getSystem = vi.fn().mockReturnValue(undefined);
  const targetEntity = {
    id: "store-npc",
    position: { x: 10, y: 0, z: 10 },
  };
  const world = {
    entities: new Map([[targetEntity.id, targetEntity]]),
    interactionSessionManager: {
      getSession: vi.fn().mockReturnValue({
        playerId,
        sessionType: "store",
        targetEntityId: targetEntity.id,
        targetStoreId,
        openedAtTick: 0,
      }),
    },
    drizzleDb: {},
    pgPool: {},
    getSystem,
  };
  const socket = {
    id: `socket-${playerId}`,
    player: {
      id: playerId,
      position: { x: 10, y: 0, z: 10 },
    },
    send: vi.fn((packet: string, payload: unknown) => {
      packets.push({ packet, payload });
    }),
  };
  return { world, socket, packets, getSystem };
}

describe("store transaction session identity", () => {
  it("rejects buying from a store other than the exact opened store", async () => {
    const { world, socket, packets, getSystem } = createHarness(
      "identity-mismatch-player",
      "general_store",
    );

    await handleStoreBuy(
      socket as never,
      {
        storeId: "sword_store",
        itemId: "bronze_shortsword",
        quantity: 1,
      },
      world as never,
    );

    expect(getSystem).not.toHaveBeenCalled();
    expect(packets).toContainEqual({
      packet: "showToast",
      payload: {
        message: "Store session does not match this shop",
        type: "error",
      },
    });
  });

  it("allows an exact session identity to reach authoritative store lookup", async () => {
    const { world, socket, packets, getSystem } = createHarness(
      "identity-match-player",
      "sword_store",
    );

    await handleStoreBuy(
      socket as never,
      {
        storeId: "sword_store",
        itemId: "bronze_shortsword",
        quantity: 1,
      },
      world as never,
    );

    expect(getSystem).toHaveBeenCalledWith("store");
    expect(packets).toContainEqual({
      packet: "showToast",
      payload: { message: "Store not found", type: "error" },
    });
  });

  it("rejects purchases after the player enters a duel", async () => {
    const { world, socket, packets, getSystem } = createHarness(
      "dueling-store-player",
      "sword_store",
    );
    getSystem.mockImplementation((systemName: string) =>
      systemName === "duel" ? { isPlayerInDuel: () => true } : undefined,
    );

    await handleStoreBuy(
      socket as never,
      {
        storeId: "sword_store",
        itemId: "bronze_shortsword",
        quantity: 1,
      },
      world as never,
    );

    expect(getSystem).not.toHaveBeenCalledWith("store");
    expect(packets).toContainEqual({
      packet: "showToast",
      payload: {
        message: "You can't buy items during a duel.",
        type: "error",
      },
    });
  });

  it("rejects selling to a store other than the exact opened store", async () => {
    const { world, socket, packets, getSystem } = createHarness(
      "sell-identity-mismatch-player",
      "general_store",
    );

    await handleStoreSell(
      socket as never,
      { storeId: "sword_store", itemId: "logs", quantity: 1 },
      world as never,
    );

    expect(getSystem).not.toHaveBeenCalled();
    expect(packets).toContainEqual({
      packet: "showToast",
      payload: {
        message: "Store session does not match this shop",
        type: "error",
      },
    });
  });

  it("rejects every sale after the player enters a duel", async () => {
    const { world, socket, packets, getSystem } = createHarness(
      "dueling-sell-player",
      "general_store",
    );
    getSystem.mockImplementation((systemName: string) =>
      systemName === "duel" ? { isPlayerInDuel: () => true } : undefined,
    );

    await handleStoreSell(
      socket as never,
      { storeId: "general_store", itemId: "logs", quantity: 1 },
      world as never,
    );

    expect(getSystem).not.toHaveBeenCalledWith("store");
    expect(packets).toContainEqual({
      packet: "showToast",
      payload: {
        message: "You can't sell items during a duel.",
        type: "error",
      },
    });
  });
});
