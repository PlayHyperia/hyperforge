import { describe, expect, it, vi } from "vitest";

import { setHlsStaticHeaders, setStaticHeaders } from "../http-server";

function collectHeaders(filePath: string): Record<string, string> {
  const headers: Record<string, string> = {};
  setStaticHeaders(
    {
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    },
    filePath,
  );
  return headers;
}

function collectHlsHeaders(filePath: string): Record<string, string> {
  const headers: Record<string, string> = {};
  setHlsStaticHeaders(
    {
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    },
    filePath,
  );
  return headers;
}

describe("HLS static response headers", () => {
  it("exposes cross-origin playlist transfer timing to the spectator app", () => {
    expect(collectHeaders("/runtime/live/stream.m3u8")).toMatchObject({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "Timing-Allow-Origin": "*",
    });
  });

  it("exposes cross-origin segment transfer timing to the spectator app", () => {
    expect(
      collectHlsHeaders("/private/tmp/generated-hls/stream-000000001.ts"),
    ).toMatchObject({
      "Content-Type": "video/MP2T",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "Timing-Allow-Origin": "*",
    });
  });

  it("does not expose transfer timing for unrelated TypeScript files", () => {
    expect(collectHeaders("/public/source.ts")).not.toHaveProperty(
      "Timing-Allow-Origin",
    );
  });
});
