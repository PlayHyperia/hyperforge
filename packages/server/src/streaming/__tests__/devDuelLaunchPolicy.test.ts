import { describe, expect, it } from "vitest";

import {
  assertMinimumConnectedDuelBots,
  resolveDevDuelAgentMode,
} from "../../../../../scripts/dev-duel-policy.mjs";

describe("dev duel launch policy", () => {
  it("selects deterministic local agents when no model credential exists", () => {
    expect(resolveDevDuelAgentMode({})).toBe("deterministic");
    expect(resolveDevDuelAgentMode({ OPENAI_API_KEY: "   " })).toBe(
      "deterministic",
    );
  });

  it("selects model agents when a supported credential exists", () => {
    expect(resolveDevDuelAgentMode({ GROQ_API_KEY: "configured" })).toBe(
      "model",
    );
  });

  it("accepts a ready two-agent pool and rejects 0/0 or partial startup", () => {
    expect(
      assertMinimumConnectedDuelBots({ connectedBots: 2, totalBots: 2 }),
    ).toEqual({ connectedBots: 2, totalBots: 2 });
    expect(() =>
      assertMinimumConnectedDuelBots({ connectedBots: 0, totalBots: 0 }),
    ).toThrow("requires at least 2 connected local agents; received 0/0");
    expect(() =>
      assertMinimumConnectedDuelBots({ connectedBots: 1, totalBots: 2 }),
    ).toThrow("received 1/2");
  });
});
