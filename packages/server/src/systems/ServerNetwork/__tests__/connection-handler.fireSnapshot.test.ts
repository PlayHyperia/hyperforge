import { describe, expect, it, vi } from "vitest";

import type { World } from "@hyperforge/shared";
import type { BroadcastManager } from "../broadcast";
import { ConnectionHandler } from "../connection-handler";
import type { ServerSocket } from "../../../shared/types";

describe("ConnectionHandler active-fire snapshot", () => {
  it("sends authoritative fires directly before a socket is registered", () => {
    const fire = {
      fireId: "fire_late-viewer",
      playerId: "agent-1",
      position: { x: 4.5, y: 0, z: 7.5 },
      createdAt: 1_000,
      expiresAt: 61_000,
    };
    const world = {
      getSystem: vi.fn((name: string) =>
        name === "processing"
          ? { getActiveFirePayloads: () => [fire] }
          : undefined,
      ),
    } as unknown as World;
    const sockets = new Map<string, ServerSocket>();
    const handler = new ConnectionHandler(
      world,
      sockets,
      {} as BroadcastManager,
      (() => undefined) as never,
    );
    const socket = { send: vi.fn() } as unknown as ServerSocket;

    (
      handler as unknown as {
        sendFireSnapshot: (target: ServerSocket) => void;
      }
    ).sendFireSnapshot(socket);

    expect(sockets.size).toBe(0);
    expect(socket.send).toHaveBeenCalledWith("fireCreated", {
      ...fire,
      serverObservedAt: expect.any(Number),
    });
  });
});
