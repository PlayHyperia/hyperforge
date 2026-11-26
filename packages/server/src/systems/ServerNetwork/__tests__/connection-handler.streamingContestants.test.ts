import { describe, expect, it, vi } from "vitest";

import type { World } from "@hyperforge/shared";
import type { ServerSocket } from "../../../shared/types";
import type { BroadcastManager } from "../broadcast";
import { ConnectionHandler } from "../connection-handler";

function contestant(id: string, position: [number, number, number]) {
  return {
    id,
    type: "player",
    data: { id, characterId: id, position },
    serialize: vi.fn(() => ({
      id,
      type: "player",
      position: [0, -100, 0],
    })),
  };
}

describe("ConnectionHandler streaming contestant reconciliation", () => {
  it("replaces stale canonical-stream contestants before their state is rendered", () => {
    const old = contestant("agent-old", [5, 8, 5]);
    const alpha = contestant("agent-alpha", [350.5, -100, 405.5]);
    const beta = contestant("agent-beta", [350.5, 12, 406.5]);
    const items = new Map([
      [old.id, old],
      [alpha.id, alpha],
      [beta.id, beta],
    ]);
    const world = {
      entities: { items, players: new Map() },
      getSystem: vi.fn((name: string) =>
        name === "terrain" ? { getHeightAt: () => 23.75 } : undefined,
      ),
    } as unknown as World;
    const streamSocket = {
      isSpectator: true,
      isStreamingViewer: true,
      spectatingDuelParticipantIds: [old.id],
      send: vi.fn(),
    } as unknown as ServerSocket;
    const pinnedSpectator = {
      isSpectator: true,
      isStreamingViewer: false,
      spectatingDuelParticipantIds: [old.id],
      send: vi.fn(),
    } as unknown as ServerSocket;
    const sockets = new Map<string, ServerSocket>([
      ["stream", streamSocket],
      ["pinned", pinnedSpectator],
    ]);
    const handler = new ConnectionHandler(
      world,
      sockets,
      {} as BroadcastManager,
      (() => undefined) as never,
    );

    handler.syncStreamingContestants([alpha.id, beta.id, alpha.id, ""]);

    expect(streamSocket.send).toHaveBeenNthCalledWith(
      1,
      "entityRemoved",
      old.id,
    );
    expect(streamSocket.send).toHaveBeenNthCalledWith(2, "entitiesBatchAdded", [
      {
        id: alpha.id,
        type: "player",
        position: [350.5, 23.85, 405.5],
      },
      {
        id: beta.id,
        type: "player",
        position: [350.5, 23.85, 406.5],
      },
    ]);
    expect(streamSocket.spectatingDuelParticipantIds).toEqual([
      alpha.id,
      beta.id,
    ]);
    expect(pinnedSpectator.send).not.toHaveBeenCalled();
    expect(pinnedSpectator.spectatingDuelParticipantIds).toEqual([old.id]);
  });
});
