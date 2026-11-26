import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "@hyperforge/shared";
import { SocketManager } from "../socket-management.js";

vi.mock("../handlers/friends.js", () => ({
  notifyFriendsOfStatusChange: vi.fn(() => Promise.resolve()),
}));

describe("SocketManager reconnect grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes the exact grace boundary and preserves the entity after a successful reconnect", () => {
    const player = {
      id: "external-agent",
      data: { id: "external-agent", isAgent: true },
    };
    const remove = vi.fn();
    const world = {
      currentTick: 10,
      emit: vi.fn(),
      getSystem: vi.fn(() => null),
      entities: {
        get: vi.fn((id: string) =>
          id === "external-agent" ? player : undefined,
        ),
        remove,
      },
    };
    const socket = {
      id: "old-socket",
      accountId: "external-account",
      agentCredentialCharacterId: "external-agent",
      characterId: "external-agent",
      player,
      ws: {
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    const sockets = new Map([[socket.id, socket]]);
    const send = vi.fn();
    const manager = new SocketManager(sockets as never, world as never, send);

    manager.handleDisconnect(socket as never, 1006);

    expect(world.emit).toHaveBeenCalledWith(EventType.PLAYER_LEFT, {
      playerId: "external-agent",
      reconnectGraceActive: true,
      reconnectGraceExpiresAt: Date.now() + 30_000,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith("entityRemoved", "external-agent");

    const wrongCharacterSocket = {
      id: "wrong-character-socket",
      agentCredentialCharacterId: "different-agent",
      alive: true,
      createdAt: Date.now(),
      ping: vi.fn(),
      ws: {
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    expect(
      manager.tryReconnect(
        "external-account",
        wrongCharacterSocket as never,
        "different-agent",
      ),
    ).toBeNull();
    expect(sockets.has(wrongCharacterSocket.id)).toBe(false);

    const replacementSocket = {
      id: "replacement-socket",
      agentCredentialCharacterId: "external-agent",
      alive: true,
      createdAt: Date.now(),
      ping: vi.fn(),
      ws: {
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
    };
    expect(
      manager.tryReconnect(
        "external-account",
        replacementSocket as never,
        "external-agent",
      ),
    ).toBe("external-agent");
    expect(replacementSocket).toMatchObject({
      accountId: "external-account",
      characterId: "external-agent",
      player,
    });

    vi.advanceTimersByTime(30_000);
    expect(remove).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith("entityRemoved", "external-agent");
    manager.destroy();
  });
});
