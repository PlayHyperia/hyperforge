import { describe, expect, it } from "vitest";
import {
  STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
  parseStreamingDuelStrategySummary,
  type StreamingDuelStrategySummary,
} from "../streaming-duel-strategy-summary";

const summary = (): StreamingDuelStrategySummary => ({
  schemaVersion: STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
  approach: "balanced",
  tacticalMacro: "orbit",
  attackStyle: "accurate",
  prayer: "hawk_eye",
  preferredCombatRole: "ranged",
  foodThreshold: 40,
  switchDefensiveAt: 30,
  source: "model",
  policyVersion: "duel-preparation-role-v3",
});

describe("streaming duel strategy summary", () => {
  it("returns a fresh frozen copy of an exact public summary", () => {
    const input = summary();
    const parsed = parseStreamingDuelStrategySummary(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["approach", "reckless"],
    ["tacticalMacro", "teleport"],
    ["attackStyle", "rapid"],
    ["prayer", "unknown_prayer"],
    ["preferredCombatRole", "prayer"],
    ["foodThreshold", 61],
    ["switchDefensiveAt", 19],
    ["source", "operator"],
    ["policyVersion", "unsafe policy"],
  ] as const)("rejects an invalid %s", (key, value) => {
    expect(
      parseStreamingDuelStrategySummary({ ...summary(), [key]: value }),
    ).toBeNull();
  });

  it.each([
    "reasoning",
    "bank",
    "inventory",
    "opponentHistory",
    "modelProvider",
    "agentPolicyFingerprint",
    "wallet",
    "rawError",
  ])("rejects the private or uncontrolled %s field", (key) => {
    expect(
      parseStreamingDuelStrategySummary({ ...summary(), [key]: "private" }),
    ).toBeNull();
  });

  it("requires every field and supports explicit nullable choices", () => {
    const missing = { ...summary() } as Record<string, unknown>;
    delete missing.prayer;
    expect(parseStreamingDuelStrategySummary(missing)).toBeNull();
    expect(
      parseStreamingDuelStrategySummary({
        ...summary(),
        prayer: null,
        preferredCombatRole: null,
        source: "deterministic",
      }),
    ).not.toBeNull();
  });
});
