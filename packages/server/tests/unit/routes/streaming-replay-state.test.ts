import { describe, expect, it } from "vitest";

import {
  parseStreamingReplayFramePayload,
  parseStreamingReplayFrameState,
  shouldDeliverStreamingFrameToClient,
} from "../../../src/routes/streaming.js";

describe("streaming delayed replay state", () => {
  it("preserves the terminal notice used by the delayed public stream", () => {
    const terminalNotice = {
      cycleId: "cycle-12",
      duelId: "duel-12",
      outcome: "cancelled",
      reason: "no_combat_activity",
      occurredAt: 12_000,
      expiresAt: 18_000,
    };

    expect(
      parseStreamingReplayFrameState({
        payload: JSON.stringify({
          cycle: {
            id: "cycle-12",
            phase: "IDLE",
            rendererHealth: {
              ready: false,
              degradedReason: "camera_target_unresolved",
              updatedAt: 12_500,
            },
          },
          leaderboard: [],
          terminalNotice,
          cameraTarget: "fighter-a",
        }),
      }),
    ).toEqual({
      cycle: {
        id: "cycle-12",
        phase: "IDLE",
        rendererHealth: {
          ready: false,
          degradedReason: "camera_target_unresolved",
          updatedAt: 12_500,
        },
      },
      leaderboard: [],
      terminalNotice,
      cameraTarget: "fighter-a",
    });
  });

  it("normalizes legacy replay frames without a terminal notice to null", () => {
    expect(
      parseStreamingReplayFrameState({
        payload: JSON.stringify({
          cycle: { id: "cycle-legacy" },
          leaderboard: [],
        }),
      }),
    ).toMatchObject({ terminalNotice: null, cameraTarget: null });
  });

  it("returns an exact REST snapshot only when its cursor matches the SSE frame", () => {
    const payload = {
      type: "STREAMING_STATE_UPDATE",
      cycle: { cycleId: "cycle-cursor", phase: "ANNOUNCEMENT" },
      leaderboard: [],
      terminalNotice: null,
      cameraTarget: null,
      seq: 42,
      emittedAt: 1_700_000_000_000,
    };
    const frame = {
      seq: payload.seq,
      emittedAt: payload.emittedAt,
      payload: JSON.stringify(payload),
      payloadBytes: 1,
    };

    expect(parseStreamingReplayFramePayload(frame)).toEqual(payload);
    expect(
      parseStreamingReplayFramePayload({ ...frame, seq: frame.seq + 1 }),
    ).toBeNull();
    expect(
      parseStreamingReplayFramePayload({
        ...frame,
        emittedAt: frame.emittedAt + 1,
      }),
    ).toBeNull();
  });

  it("keeps authenticated authoritative SSE delivery separate from delayed public delivery", () => {
    expect(shouldDeliverStreamingFrameToClient("all", false)).toBe(true);
    expect(shouldDeliverStreamingFrameToClient("all", true)).toBe(true);
    expect(shouldDeliverStreamingFrameToClient("authoritative", true)).toBe(
      true,
    );
    expect(shouldDeliverStreamingFrameToClient("authoritative", false)).toBe(
      false,
    );
    expect(shouldDeliverStreamingFrameToClient("public", false)).toBe(true);
    expect(shouldDeliverStreamingFrameToClient("public", true)).toBe(false);
  });
});
