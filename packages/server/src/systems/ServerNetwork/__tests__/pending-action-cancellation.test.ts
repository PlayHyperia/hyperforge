import { describe, expect, it, vi } from "vitest";

import { ServerNetwork } from "../index";

describe("ServerNetwork pending-action cancellation", () => {
  it("cancels pending gathering and correlated cooking when a new action supersedes them", () => {
    const cancelPendingAttack = vi.fn();
    const cancelPendingGather = vi.fn();
    const cancelPendingCook = vi.fn();
    const stopFollowing = vi.fn();
    const cancelPendingTrade = vi.fn();
    const cancelPendingChallenge = vi.fn();

    const network = Object.create(ServerNetwork.prototype) as {
      pendingAttackManager: { cancelPendingAttack: typeof cancelPendingAttack };
      pendingGatherManager: { cancelPendingGather: typeof cancelPendingGather };
      pendingCookManager: { cancelPendingCook: typeof cancelPendingCook };
      followManager: { stopFollowing: typeof stopFollowing };
      pendingTradeManager: { cancelPendingTrade: typeof cancelPendingTrade };
      pendingDuelChallengeManager: {
        cancelPendingChallenge: typeof cancelPendingChallenge;
      };
      cancelAllPendingActions: (playerId: string) => void;
    };

    network.pendingAttackManager = { cancelPendingAttack };
    network.pendingGatherManager = { cancelPendingGather };
    network.pendingCookManager = { cancelPendingCook };
    network.followManager = { stopFollowing };
    network.pendingTradeManager = { cancelPendingTrade };
    network.pendingDuelChallengeManager = { cancelPendingChallenge };

    network.cancelAllPendingActions("player-1");

    expect(cancelPendingAttack).toHaveBeenCalledWith("player-1");
    expect(cancelPendingGather).toHaveBeenCalledWith("player-1");
    expect(cancelPendingCook).toHaveBeenCalledWith("player-1", "interrupted");
    expect(stopFollowing).toHaveBeenCalledWith("player-1");
    expect(cancelPendingTrade).toHaveBeenCalledWith("player-1");
    expect(cancelPendingChallenge).toHaveBeenCalledWith("player-1");
  });

  it("cancels stale preparation approaches before embedded-agent movement", () => {
    const cancelPendingGather = vi.fn();
    const cancelPendingCook = vi.fn();
    const movePlayerToward = vi.fn(() => true);
    const network = Object.create(ServerNetwork.prototype) as {
      pendingGatherManager: { cancelPendingGather: typeof cancelPendingGather };
      pendingCookManager: { cancelPendingCook: typeof cancelPendingCook };
      tileMovementManager: { movePlayerToward: typeof movePlayerToward };
      world: { entities: Map<string, unknown> };
      requestServerMove: (
        playerId: string,
        target: [number, number, number],
        options?: { runMode?: boolean },
      ) => boolean;
    };
    network.pendingGatherManager = { cancelPendingGather };
    network.pendingCookManager = { cancelPendingCook };
    network.tileMovementManager = { movePlayerToward };
    network.world = { entities: new Map([["agent-1", {}]]) };

    expect(
      network.requestServerMove("agent-1", [4, 0, 7], { runMode: true }),
    ).toBe(true);

    expect(cancelPendingGather).toHaveBeenCalledWith("agent-1");
    expect(cancelPendingCook).toHaveBeenCalledWith("agent-1", "interrupted");
    expect(movePlayerToward).toHaveBeenCalledWith(
      "agent-1",
      { x: 4, y: 0, z: 7 },
      true,
      0,
      undefined,
      undefined,
    );
  });

  it("propagates a rejected embedded-agent path installation", () => {
    const network = Object.create(ServerNetwork.prototype) as {
      pendingGatherManager: { cancelPendingGather: () => void };
      pendingCookManager: { cancelPendingCook: () => void };
      tileMovementManager: { movePlayerToward: () => boolean };
      world: { entities: Map<string, unknown> };
      requestServerMove: (
        playerId: string,
        target: [number, number, number],
      ) => boolean;
    };
    network.pendingGatherManager = { cancelPendingGather: vi.fn() };
    network.pendingCookManager = { cancelPendingCook: vi.fn() };
    network.tileMovementManager = { movePlayerToward: vi.fn(() => false) };
    network.world = { entities: new Map([["agent-1", {}]]) };

    expect(network.requestServerMove("agent-1", [4, 0, 7])).toBe(false);
  });

  it("returns authoritative embedded pickup completion only inside range", async () => {
    const pickupGroundItem = vi.fn(async () => true);
    const player = { position: { x: 4, y: 0, z: 7 }, data: {} };
    const item = { position: { x: 5, y: 0, z: 7 } };
    const entities = new Map<string, unknown>([
      ["agent-1", player],
      ["ground-item-1", item],
    ]);
    const world = {
      entities,
      getPlayer: vi.fn((id: string) => entities.get(id)),
      getSystem: vi.fn((name: string) => {
        if (name === "inventory") return { pickupGroundItem };
        if (name === "duel") {
          return {
            isPlayerInDuel: () => false,
            isPlayerInActiveDuel: () => false,
          };
        }
        return undefined;
      }),
    };
    const network = Object.create(ServerNetwork.prototype) as {
      world: typeof world;
      requestServerPickup: (
        playerId: string,
        entityId: string,
      ) => Promise<boolean>;
    };
    network.world = world;

    await expect(
      network.requestServerPickup("agent-1", "ground-item-1"),
    ).resolves.toBe(true);
    expect(pickupGroundItem).toHaveBeenCalledWith({
      playerId: "agent-1",
      entityId: "ground-item-1",
    });

    item.position.x = 100;
    pickupGroundItem.mockClear();
    await expect(
      network.requestServerPickup("agent-1", "ground-item-1"),
    ).resolves.toBe(false);
    expect(pickupGroundItem).not.toHaveBeenCalled();
  });

  it("rejects embedded pickup while duel authority is active", async () => {
    const pickupGroundItem = vi.fn(async () => true);
    const player = { position: { x: 4, y: 0, z: 7 }, data: {} };
    const item = { position: { x: 5, y: 0, z: 7 } };
    const entities = new Map<string, unknown>([
      ["agent-1", player],
      ["ground-item-1", item],
    ]);
    const world = {
      entities,
      getPlayer: vi.fn((id: string) => entities.get(id)),
      getSystem: vi.fn((name: string) => {
        if (name === "inventory") return { pickupGroundItem };
        if (name === "duel") {
          return {
            isPlayerInDuel: () => true,
            isPlayerInActiveDuel: () => true,
          };
        }
        return undefined;
      }),
    };
    const network = Object.create(ServerNetwork.prototype) as {
      world: typeof world;
      requestServerPickup: (
        playerId: string,
        entityId: string,
      ) => Promise<boolean>;
    };
    network.world = world;

    await expect(
      network.requestServerPickup("agent-1", "ground-item-1"),
    ).resolves.toBe(false);
    expect(pickupGroundItem).not.toHaveBeenCalled();
  });
});
