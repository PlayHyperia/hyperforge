import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { ClientNetwork } from "../ClientNetwork";

describe("ClientNetwork processing rejection", () => {
  it("restores the local player identity and emits the typed rejection", () => {
    const emit = vi.fn();
    const world = {
      emit,
      entities: { player: { id: "agent-1" } },
    } as unknown as World;
    const network = new ClientNetwork(world);
    const requestId = "28a353ce-20d4-440b-b7fd-bfd07384685c";

    network.onProcessingRejected({
      requestId,
      skill: "cooking",
      reason: "not_authorized",
      retryable: true,
    });

    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_REJECTED, {
      playerId: "agent-1",
      requestId,
      skill: "cooking",
      reason: "not_authorized",
      retryable: true,
    });
  });

  it("restores the local player identity for authority progress", () => {
    const emit = vi.fn();
    const world = {
      emit,
      entities: { player: { id: "agent-1" } },
    } as unknown as World;
    const network = new ClientNetwork(world);
    const requestId = "199f79ab-c0e4-410e-a785-e27411765f11";

    network.onProcessingProgress({
      requestId,
      skill: "runecrafting",
      phase: "reconciling",
    });

    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_PROGRESS, {
      playerId: "agent-1",
      requestId,
      skill: "runecrafting",
      phase: "reconciling",
    });
  });

  it("restores the local player identity for durable receipt status", () => {
    const emit = vi.fn();
    const world = {
      emit,
      entities: { player: { id: "agent-1" } },
    } as unknown as World;
    const network = new ClientNetwork(world);
    const requestId = "d7ab845f-4d48-4a36-b1df-b677a0f72383";
    const queryId = "7b5c5327-567d-4944-b3e0-70a54c2510cf";

    network.onProcessingRequestStatus({
      requestId,
      queryId,
      skill: "tanning",
      status: "committed",
    });

    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_STATUS, {
      playerId: "agent-1",
      requestId,
      queryId,
      skill: "tanning",
      status: "committed",
    });
  });
});
