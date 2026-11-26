import { describe, expect, it, vi } from "vitest";
import { EventType } from "@hyperforge/shared";
import { handleRunecraftingAltarInteract } from "../handlers/processing";

function invoke(
  options: {
    inRange?: boolean;
    runeType?: string;
    position?: unknown;
    throwFromRangeCheck?: boolean;
    canProcess?: boolean;
    requestId?: unknown;
    entityType?: string;
  } = {},
) {
  const emit = vi.fn();
  const beginProcessingRequestAsync = vi.fn().mockResolvedValue("accepted");
  const isPlayerInRange = vi.fn(() => {
    if (options.throwFromRangeCheck) throw new Error("malformed altar");
    return options.inRange ?? true;
  });
  const player = {
    id: "player1",
    position: "position" in options ? options.position : { x: 1, y: 0, z: 1 },
  };
  const socket = { player } as unknown as Parameters<
    typeof handleRunecraftingAltarInteract
  >[0];
  const ctx = {
    canProcessRequest: vi.fn(() => options.canProcess ?? true),
    world: {
      entities: new Map([
        [
          "air_altar",
          {
            entityType: options.entityType ?? "runecrafting_altar",
            runeType: options.runeType ?? "air",
            isPlayerInRange,
          },
        ],
      ]),
      emit,
      getSystem: (name: string) =>
        name === "database" ? { beginProcessingRequestAsync } : undefined,
    },
  } as unknown as Parameters<typeof handleRunecraftingAltarInteract>[2];

  const pending = handleRunecraftingAltarInteract(
    socket,
    { altarId: "air_altar", requestId: options.requestId },
    ctx,
  );
  return {
    beginProcessingRequestAsync,
    emit,
    isPlayerInRange,
    pending,
    player,
  };
}

describe("runecrafting network authority", () => {
  it("emits only the altar-owned rune type for a nearby player", () => {
    const { emit, isPlayerInRange, player } = invoke({ runeType: "air" });

    expect(isPlayerInRange).toHaveBeenCalledWith(player.position);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(EventType.RUNECRAFTING_INTERACT, {
      playerId: "player1",
      altarId: "air_altar",
      runeType: "air",
    });
  });

  it("echoes a valid request identity and rejects malformed correlation", async () => {
    const requestId = "17f2b465-4937-47eb-9b2f-a62fd7d2ee8e";
    const valid = invoke({ requestId });
    await valid.pending;
    expect(valid.emit).toHaveBeenCalledWith(
      EventType.RUNECRAFTING_INTERACT,
      expect.objectContaining({ requestId }),
    );
    expect(valid.beginProcessingRequestAsync).toHaveBeenCalledWith(
      "player1",
      `processing-request:runecrafting:${requestId}`,
      requestId,
      "runecrafting",
      {
        skill: "runecrafting",
        altarId: "air_altar",
        runeType: "air",
      },
    );

    const invalid = invoke({ requestId: "not-a-uuid" });
    expect(invalid.isPlayerInRange).not.toHaveBeenCalled();
    expect(invalid.emit).not.toHaveBeenCalled();
  });

  it("rejects a remote altar before reaching the shared system", () => {
    const { emit, isPlayerInRange } = invoke({ inRange: false });

    expect(isPlayerInRange).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a lookalike entity that is not an authored runecrafting altar", () => {
    const { emit, isPlayerInRange } = invoke({ entityType: "furnace" });

    expect(isPlayerInRange).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    { x: Number.NaN, y: 0, z: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
    { x: 0, y: 0 },
  ])("rejects invalid authoritative player position %j", (position) => {
    const { emit, isPlayerInRange } = invoke({ position });

    expect(isPlayerInRange).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("fails closed if the altar range validator throws", () => {
    const { emit } = invoke({ throwFromRangeCheck: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("honors processing rate limiting before looking up the altar", () => {
    const requestId = "d2fa8e78-78dd-417c-b2c3-bd8515060294";
    const { emit, isPlayerInRange } = invoke({
      canProcess: false,
      requestId,
    });
    expect(isPlayerInRange).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(EventType.PROCESSING_REQUEST_REJECTED, {
      playerId: "player1",
      requestId,
      skill: "runecrafting",
      reason: "busy",
      retryable: true,
    });
  });
});
