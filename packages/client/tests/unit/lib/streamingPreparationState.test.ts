import { describe, expect, it } from "vitest";

import {
  normalizeStreamingPreparationState,
  sameStreamingPreparationState,
} from "../../../src/lib/streamingPreparationState";

const preparation = () => ({
  schemaVersion: 2 as const,
  status: "preparing" as const,
  selectedAt: 1_000,
  expiresAt: 61_000,
  agent1: {
    id: "agent-a",
    ready: true,
    activity: "training" as const,
    mode: "working" as const,
    activityTrail: ["planning", "training"] as const,
  },
  agent2: {
    id: "agent-b",
    ready: false,
    activity: null,
    mode: null,
    activityTrail: [],
  },
});

describe("streaming preparation state boundary", () => {
  it("retains only a fresh deeply frozen public summary", () => {
    const input = preparation();
    const normalized = normalizeStreamingPreparationState({
      type: "STREAMING_STATE_UPDATE",
      preparation: input,
    });

    expect(normalized.preparation).toEqual(input);
    expect(normalized.preparation).not.toBe(input);
    expect(Object.isFrozen(normalized.preparation)).toBe(true);
    expect(Object.isFrozen(normalized.preparation?.agent1)).toBe(true);
  });

  it("fails closed on private or malformed fields", () => {
    const normalized = normalizeStreamingPreparationState({
      preparation: { ...preparation(), preparationId: "private" },
    });

    expect(normalized.preparation).toBeNull();
  });

  it("detects exact readiness transitions without reacting to fresh clones", () => {
    const first = normalizeStreamingPreparationState({
      preparation: preparation(),
    }).preparation;
    const clone = normalizeStreamingPreparationState({
      preparation: preparation(),
    }).preparation;
    const ready = normalizeStreamingPreparationState({
      preparation: {
        ...preparation(),
        status: "ready",
        agent2: {
          id: "agent-b",
          ready: true,
          activity: null,
          mode: null,
          activityTrail: [],
        },
      },
    }).preparation;

    expect(sameStreamingPreparationState(first, clone)).toBe(true);
    expect(sameStreamingPreparationState(first, ready)).toBe(false);
    expect(
      sameStreamingPreparationState(first, {
        ...first!,
        agent1: {
          ...first!.agent1,
          activity: "crafting",
          activityTrail: ["planning", "crafting"],
        },
      }),
    ).toBe(false);
    expect(
      sameStreamingPreparationState(first, {
        ...first!,
        agent1: {
          ...first!.agent1,
          mode: "traveling",
        },
      }),
    ).toBe(false);
    expect(
      sameStreamingPreparationState(first, {
        ...first!,
        agent1: {
          ...first!.agent1,
          activityTrail: ["gathering", "training"],
        },
      }),
    ).toBe(false);
  });
});
