import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import { EventBus } from "../EventBus";
import { SystemBase } from "../SystemBase";

const REQUEST_ID = "4ef03119-d01c-4ed1-a1ff-3cf9ba0ce208";

class ProcessingLifecycleTestSystem extends SystemBase {
  constructor(world: ConstructorParameters<typeof SystemBase>[0]) {
    super(world, { name: "processing-lifecycle-test" });
  }

  reject(): void {
    this.rejectProcessingRequest(
      "player-1",
      REQUEST_ID,
      "crafting",
      "resources_unavailable",
      false,
    );
  }

  progress(): void {
    this.reportProcessingRequestProgress(
      "player-1",
      REQUEST_ID,
      "crafting",
      "working",
      true,
    );
  }
}

function setup(database: Record<string, unknown>) {
  const eventBus = new EventBus();
  const emitEvent = vi.spyOn(eventBus, "emitEvent");
  const world = {
    $eventBus: eventBus,
    currentTick: 100,
    getSystem: (name: string) => (name === "database" ? database : undefined),
  } as never;
  return {
    emitEvent,
    system: new ProcessingLifecycleTestSystem(world),
  };
}

describe("SystemBase durable processing lifecycle publication", () => {
  it("publishes a terminal rejection only after its owner persists it", async () => {
    const rejectProcessingRequestAsync = vi.fn().mockResolvedValue(true);
    const { emitEvent, system } = setup({ rejectProcessingRequestAsync });

    system.reject();
    expect(emitEvent).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(rejectProcessingRequestAsync).toHaveBeenCalledWith(
      "player-1",
      `processing-request:crafting:${REQUEST_ID}`,
      REQUEST_ID,
      "crafting",
      "resources_unavailable",
      false,
    );
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      {
        playerId: "player-1",
        requestId: REQUEST_ID,
        skill: "crafting",
        reason: "resources_unavailable",
        retryable: false,
      },
      "processing-lifecycle-test",
    );
  });

  it("keeps a stale owner silent", async () => {
    const { emitEvent, system } = setup({
      rejectProcessingRequestAsync: vi.fn().mockResolvedValue(false),
      heartbeatProcessingRequestAsync: vi.fn().mockResolvedValue(false),
    });

    system.reject();
    system.progress();
    await Promise.resolve();

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("reports persistence failure without claiming the original rejection", async () => {
    const { emitEvent, system } = setup({
      rejectProcessingRequestAsync: vi
        .fn()
        .mockRejectedValue(new Error("database offline")),
    });

    system.reject();
    await Promise.resolve();
    await Promise.resolve();

    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_REJECTED,
      {
        playerId: "player-1",
        requestId: REQUEST_ID,
        skill: "crafting",
        reason: "persistence_rejected",
        retryable: true,
      },
      "processing-lifecycle-test",
    );
  });

  it("publishes progress only while durable ownership is current", async () => {
    const heartbeatProcessingRequestAsync = vi.fn().mockResolvedValue(true);
    const { emitEvent, system } = setup({ heartbeatProcessingRequestAsync });

    system.progress();
    expect(emitEvent).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(heartbeatProcessingRequestAsync).toHaveBeenCalledWith(
      "player-1",
      `processing-request:crafting:${REQUEST_ID}`,
      REQUEST_ID,
      "crafting",
    );
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.PROCESSING_REQUEST_PROGRESS,
      {
        playerId: "player-1",
        requestId: REQUEST_ID,
        skill: "crafting",
        phase: "working",
      },
      "processing-lifecycle-test",
    );
  });
});
