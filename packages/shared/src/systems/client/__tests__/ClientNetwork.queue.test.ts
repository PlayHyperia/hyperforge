import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../types";
import { ClientNetwork } from "../ClientNetwork";

function createWorld() {
  return {
    entities: {
      get: vi.fn(() => null),
      player: undefined,
    },
    getSystem: vi.fn(() => null),
    frameBudget: null,
  } as unknown as World;
}

describe("ClientNetwork inbound queue", () => {
  it("preserves unread packets while compacting a sustained burst", async () => {
    const network = new ClientNetwork(createWorld());
    const handled: number[] = [];

    network.ws = { readyState: WebSocket.OPEN } as WebSocket;
    Object.assign(network, {
      onQueueProbe: (value: number) => handled.push(value),
    });

    for (let value = 0; value < 1_100; value += 1) {
      network.enqueue("queueProbe", value);
    }

    // flush() intentionally handles at most 50 packets per frame. The 21st
    // pass crosses the compaction threshold with 50 packets still unread.
    for (let frame = 0; frame < 22; frame += 1) {
      await network.flush();
    }

    expect(handled).toHaveLength(1_100);
    expect(handled).toEqual(Array.from({ length: 1_100 }, (_, index) => index));
  });
});
