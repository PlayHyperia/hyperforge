import { describe, expect, it, vi } from "vitest";

import {
  resolveStreamingDuelShutdownAckConfig,
  waitForStreamingDuelShutdownAcknowledgement,
} from "../streaming-shutdown-contract.js";

describe("streaming duel shutdown acknowledgement contract", () => {
  it("rejects unsafe URLs and invalid timeouts before shutdown", () => {
    expect(() =>
      resolveStreamingDuelShutdownAckConfig({
        STREAMING_DUEL_SHUTDOWN_ACK_URL: "file:///tmp/status.json",
      }),
    ).toThrow("credential-free HTTP(S)");
    expect(() =>
      resolveStreamingDuelShutdownAckConfig({
        STREAMING_DUEL_SHUTDOWN_ACK_URL:
          "https://user:pass@example.test/status",
      }),
    ).toThrow("credential-free HTTP(S)");
    expect(() =>
      resolveStreamingDuelShutdownAckConfig({
        STREAMING_DUEL_SHUTDOWN_ACK_URL: "https://example.test/status",
        STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS: "999",
      }),
    ).toThrow("1000..20000");
    expect(() =>
      resolveStreamingDuelShutdownAckConfig({
        NODE_ENV: "production",
        HYPERIA_EXTERNAL_VALUE_ENABLED: "true",
        STREAMING_DUEL_ENABLED: "true",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      }),
    ).toThrow(
      "STREAMING_DUEL_SHUTDOWN_ACK_URL is required for an external-value production authority",
    );
  });

  it("waits for the exact duel to reach CANCELLED", async () => {
    let nowMs = 1_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            running: true,
            health: {
              markets: [{ duelId: "other-duel", lifecycleStatus: "CANCELLED" }],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            running: true,
            health: {
              markets: [{ duelId: "duel-1", lifecycleStatus: "CANCELLED" }],
            },
          }),
          { status: 200 },
        ),
      );

    await expect(
      waitForStreamingDuelShutdownAcknowledgement({
        config: {
          url: "https://example.test/api/keeper/bot-health",
          timeoutMs: 5_000,
        },
        duelId: "duel-1",
        fetchImpl,
        now: () => nowMs,
        sleep: async (durationMs) => {
          nowMs += durationMs;
        },
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts a degraded keeper response only after it proves the exact duel is CANCELLED", async () => {
    let nowMs = 1_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            running: true,
            health: {
              markets: [{ duelId: "other-duel", lifecycleStatus: "CANCELLED" }],
            },
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            running: true,
            health: {
              markets: [{ duelId: "duel-1", lifecycleStatus: "CANCELLED" }],
            },
          }),
          { status: 503 },
        ),
      );

    await expect(
      waitForStreamingDuelShutdownAcknowledgement({
        config: {
          url: "https://example.test/api/keeper/bot-health",
          timeoutMs: 5_000,
        },
        duelId: "duel-1",
        fetchImpl,
        now: () => nowMs,
        sleep: async (durationMs) => {
          nowMs += durationMs;
        },
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns false only when no downstream acknowledgement URL is configured", async () => {
    await expect(
      waitForStreamingDuelShutdownAcknowledgement({
        config: { url: null, timeoutMs: 15_000 },
        duelId: "duel-1",
      }),
    ).resolves.toBe(false);
  });
});
