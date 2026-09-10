import { describe, expect, it } from "vitest";

import {
  STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION,
  parseStreamingDuelPreparationSummary,
  type StreamingDuelPreparationSummary,
} from "../streaming-duel-preparation-summary";

function summary(): StreamingDuelPreparationSummary {
  return {
    schemaVersion: STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION,
    status: "preparing",
    selectedAt: 1_000,
    expiresAt: 61_000,
    agent1: {
      id: "agent-a",
      ready: true,
      activity: "training",
      mode: "working",
      activityTrail: ["training"],
    },
    agent2: {
      id: "agent-b",
      ready: false,
      activity: null,
      mode: null,
      activityTrail: [],
    },
  };
}

describe("parseStreamingDuelPreparationSummary", () => {
  it("returns a fresh deeply frozen bounded summary", () => {
    const input = summary();
    const parsed = parseStreamingDuelPreparationSummary(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.agent1).not.toBe(input.agent1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.agent1)).toBe(true);
    expect(Object.isFrozen(parsed?.agent2)).toBe(true);
    expect(Object.isFrozen(parsed?.agent1.activityTrail)).toBe(true);
  });

  it.each([
    ["private preparation identity", { preparationId: "private" }],
    ["bank detail", { bank: [{ itemId: "private", quantity: 9 }] }],
    ["goal text", { goal: "forge the hidden counter" }],
    ["model reasoning", { reasoning: "private" }],
  ])("rejects an extra %s field", (_label, extra) => {
    expect(
      parseStreamingDuelPreparationSummary({ ...summary(), ...extra }),
    ).toBeNull();
  });

  it("rejects malformed identity, timing, and contradictory readiness", () => {
    expect(
      parseStreamingDuelPreparationSummary({
        ...summary(),
        agent2: {
          id: "agent-a",
          ready: false,
          activity: null,
          mode: null,
          activityTrail: [],
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...summary(),
        expiresAt: 1_000,
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...summary(),
        status: "ready",
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...summary(),
        agent2: {
          id: "agent-b",
          ready: true,
          activity: null,
          mode: null,
          activityTrail: [],
        },
      }),
    ).toBeNull();
  });

  it("accepts ready only when both exact contestants are ready", () => {
    expect(
      parseStreamingDuelPreparationSummary({
        ...summary(),
        status: "ready",
        agent2: {
          id: "agent-b",
          ready: true,
          activity: null,
          mode: null,
          activityTrail: [],
        },
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("accepts only bounded public activity categories on each contestant", () => {
    const input = {
      ...summary(),
      agent1: {
        id: "agent-a",
        ready: true,
        activity: "training",
        mode: "working",
        activityTrail: ["training"],
      },
      agent2: {
        id: "agent-b",
        ready: false,
        activity: null,
        mode: null,
        activityTrail: [],
      },
    };

    expect(parseStreamingDuelPreparationSummary(input)).toEqual(input);
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activity: "smith an iron counter-build",
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          mode: "following route to hidden target",
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          mode: null,
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activity: "planning",
          mode: "traveling",
          activityTrail: ["planning"],
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          targetItemId: "private_item_id",
        },
      }),
    ).toBeNull();
  });

  it("retains a bounded ordered activity trail without accepting private detail", () => {
    const input = {
      ...summary(),
      agent1: {
        id: "agent-a",
        ready: true,
        activity: "provisioning",
        mode: "traveling",
        activityTrail: ["planning", "provisioning"],
      },
      agent2: {
        id: "agent-b",
        ready: false,
        activity: null,
        mode: null,
        activityTrail: [],
      },
    };

    expect(parseStreamingDuelPreparationSummary(input)).toEqual(input);
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activityTrail: ["planning", "inspect private item iron_sword"],
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activityTrail: ["planning", "planning"],
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activityTrail: [
            "planning",
            "gathering",
            "training",
            "crafting",
            "provisioning",
            "questing",
            "exploring",
            "reassessing",
            "planning",
          ],
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingDuelPreparationSummary({
        ...input,
        agent1: {
          ...input.agent1,
          activity: "training",
        },
      }),
    ).toBeNull();
  });
});
