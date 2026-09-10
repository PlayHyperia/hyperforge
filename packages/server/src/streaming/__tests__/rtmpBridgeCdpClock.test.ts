import { describe, expect, it } from "vitest";

import {
  buildCdpMjpegInputArgs,
  resolveBrowserAudioMaxBufferMs,
} from "../rtmp-bridge";

describe("RTMP bridge CDP video clock", () => {
  it("uses the declared MJPEG framerate without wall-clock arrival jitter", () => {
    const args = buildCdpMjpegInputArgs(30);

    expect(args).toContain("mjpeg");
    expect(args).toContain("30");
    expect(args).not.toContain("-use_wallclock_as_timestamps");
    expect(args.slice(-2)).toEqual(["-i", "pipe:0"]);
  });

  it("bounds the browser-audio startup probe buffer", () => {
    expect(resolveBrowserAudioMaxBufferMs(undefined)).toBe(2_000);
    expect(resolveBrowserAudioMaxBufferMs("invalid")).toBe(2_000);
    expect(resolveBrowserAudioMaxBufferMs("0")).toBe(2_000);
    expect(resolveBrowserAudioMaxBufferMs("25")).toBe(50);
    expect(resolveBrowserAudioMaxBufferMs("2500")).toBe(2_500);
    expect(resolveBrowserAudioMaxBufferMs("50000")).toBe(10_000);
  });
});
