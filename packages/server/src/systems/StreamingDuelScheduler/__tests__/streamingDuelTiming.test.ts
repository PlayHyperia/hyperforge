import { describe, expect, it } from "vitest";

import {
  STREAMING_DUEL_TIMEOUT_POLICY,
  STREAMING_DUEL_TIMING_CONTRACT_VERSION,
  resolveStreamingDuelTiming,
  resolveStreamingPublicPreparationReleaseAt,
} from "../types";

describe("streaming duel timing contract", () => {
  it("publishes complete, internally consistent local defaults", () => {
    const timing = resolveStreamingDuelTiming({});

    expect(timing).toEqual({
      CONTRACT_VERSION: STREAMING_DUEL_TIMING_CONTRACT_VERSION,
      TIMEOUT_POLICY: STREAMING_DUEL_TIMEOUT_POLICY,
      PREPARATION_DURATION: null,
      CYCLE_DURATION: 359_000,
      ANNOUNCEMENT_DURATION: 60_000,
      FIGHTING_DURATION: 270_000,
      END_WARNING_DURATION: 15_000,
      MAX_FIGHT_DURATION: 285_000,
      RESOLUTION_DURATION: 10_000,
      COUNTDOWN_TICKS: 3,
      COUNTDOWN_DURATION: 4_000,
      STATE_BROADCAST_INTERVAL: 1_000,
      FIGHT_BROADCAST_INTERVAL: 200,
      INTER_CYCLE_DELAY_MS: 5_000,
    });
  });

  it("derives every aggregate from the exact configured values", () => {
    const timing = resolveStreamingDuelTiming({
      STREAMING_ANNOUNCEMENT_MS: "120000",
      STREAMING_DUEL_PREPARATION_MS: "90000",
      STREAMING_COUNTDOWN_TICKS: "5",
      STREAMING_FIGHTING_MS: "30000",
      STREAMING_END_WARNING_MS: "5000",
      STREAMING_RESOLUTION_MS: "3000",
      STREAMING_INTER_CYCLE_DELAY_MS: "65000",
    });

    expect(timing.COUNTDOWN_DURATION).toBe(6_000);
    expect(timing.PREPARATION_DURATION).toBe(90_000);
    expect(timing.MAX_FIGHT_DURATION).toBe(35_000);
    expect(timing.CYCLE_DURATION).toBe(164_000);
    expect(timing.INTER_CYCLE_DELAY_MS).toBe(65_000);
  });

  it.each([
    ["empty", { STREAMING_FIGHTING_MS: "   " }],
    ["non-numeric", { STREAMING_FIGHTING_MS: "fast" }],
    ["trailing content", { STREAMING_FIGHTING_MS: "30000ms" }],
    ["below minimum", { STREAMING_FIGHTING_MS: "4999" }],
    ["negative", { STREAMING_RESOLUTION_MS: "-1000" }],
    ["empty preparation", { STREAMING_DUEL_PREPARATION_MS: "   " }],
    [
      "preparation trailing content",
      { STREAMING_DUEL_PREPARATION_MS: "60000ms" },
    ],
    ["preparation below minimum", { STREAMING_DUEL_PREPARATION_MS: "999" }],
    ["unsafe integer", { STREAMING_ANNOUNCEMENT_MS: "9007199254740992" }],
  ])("rejects %s timing instead of silently using a fallback", (_name, env) => {
    expect(() => resolveStreamingDuelTiming(env)).toThrow();
  });

  it("rejects aggregate arithmetic that would overflow a safe integer", () => {
    expect(() =>
      resolveStreamingDuelTiming({
        STREAMING_ANNOUNCEMENT_MS: "9007199254740000",
        STREAMING_FIGHTING_MS: "5000",
      }),
    ).toThrow(/exceeds safe integers/u);
  });

  it("measures the public ready hold from the later readiness receipt without extending expiry", () => {
    const preparation = {
      selectedAt: 1_000,
      expiresAt: 60_000,
      agent1ReadyAt: 11_000,
      agent2ReadyAt: 15_000,
    };

    expect(resolveStreamingPublicPreparationReleaseAt(preparation, 2_000)).toBe(
      17_000,
    );
    expect(resolveStreamingPublicPreparationReleaseAt(preparation, 0)).toBe(
      15_000,
    );
    expect(
      resolveStreamingPublicPreparationReleaseAt(preparation, 50_000),
    ).toBe(60_000);
  });

  it("rejects incomplete or impossible ready presentation windows", () => {
    expect(() =>
      resolveStreamingPublicPreparationReleaseAt(
        {
          selectedAt: 1_000,
          expiresAt: 60_000,
          agent1ReadyAt: 11_000,
          agent2ReadyAt: null,
        },
        2_000,
      ),
    ).toThrow(/invalid ready preparation presentation window/u);
    expect(() =>
      resolveStreamingPublicPreparationReleaseAt(
        {
          selectedAt: 1_000,
          expiresAt: 60_000,
          agent1ReadyAt: 11_000,
          agent2ReadyAt: 15_000,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(/exceeds safe integers/u);
  });
});
