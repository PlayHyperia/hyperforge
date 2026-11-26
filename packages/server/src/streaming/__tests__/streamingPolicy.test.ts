import { describe, expect, it } from "vitest";

import { resolveStreamingCanonicalPolicy } from "../streaming-policy.js";

describe("canonical streaming policy", () => {
  it("defaults every public surface to the owned HLS output", () => {
    expect(resolveStreamingCanonicalPolicy({})).toEqual({
      platform: "hls",
      sourceUrl: "/live/stream.m3u8",
      publicDelayDefaultMs: 4000,
      publicDelayMs: 4000,
      publicDelayOverridden: false,
    });
  });

  it.each([
    ["youtube", 15000],
    ["twitch", 12000],
  ] as const)(
    "requires an explicit public source for the %s platform",
    (platform, expectedDelayMs) => {
      expect(() =>
        resolveStreamingCanonicalPolicy({
          STREAMING_CANONICAL_PLATFORM: platform,
        }),
      ).toThrow("STREAMING_CANONICAL_SOURCE_URL is required");

      expect(
        resolveStreamingCanonicalPolicy({
          STREAMING_CANONICAL_PLATFORM: platform,
          STREAMING_CANONICAL_SOURCE_URL: `https://video.example/${platform}/hyperia`,
        }),
      ).toEqual({
        platform,
        sourceUrl: `https://video.example/${platform}/hyperia`,
        publicDelayDefaultMs: expectedDelayMs,
        publicDelayMs: expectedDelayMs,
        publicDelayOverridden: false,
      });
    },
  );

  it("accepts an explicit public HTTP source and exact zero-delay override", () => {
    expect(
      resolveStreamingCanonicalPolicy({
        STREAMING_CANONICAL_PLATFORM: "hls",
        STREAMING_CANONICAL_SOURCE_URL:
          "http://127.0.0.1:5555/live/stream.m3u8?quality=source",
        STREAMING_PUBLIC_DELAY_MS: "0",
      }),
    ).toEqual({
      platform: "hls",
      sourceUrl: "http://127.0.0.1:5555/live/stream.m3u8?quality=source",
      publicDelayDefaultMs: 4000,
      publicDelayMs: 0,
      publicDelayOverridden: true,
    });
  });

  it.each([
    [
      { STREAMING_CANONICAL_PLATFORM: "automatic" },
      "STREAMING_CANONICAL_PLATFORM",
    ],
    [
      { STREAMING_CANONICAL_SOURCE_URL: "rtmp://private.example/live" },
      "public HTTP(S) URL",
    ],
    [
      {
        STREAMING_CANONICAL_SOURCE_URL:
          "https://operator:secret@video.example/live.m3u8",
      },
      "without credentials",
    ],
    [
      { STREAMING_CANONICAL_SOURCE_URL: "/live/stream.m3u8#stale" },
      "without a fragment",
    ],
    [{ STREAMING_PUBLIC_DELAY_MS: "4.5" }, "non-negative integer"],
    [{ STREAMING_PUBLIC_DELAY_MS: "-1" }, "non-negative integer"],
  ] as const)(
    "fails closed on invalid explicit policy %#",
    (environment, message) => {
      expect(() => resolveStreamingCanonicalPolicy(environment)).toThrow(
        message,
      );
    },
  );
});
