import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RTMPBridge, STREAM_AUDIO_SAMPLE_RATE_HZ } from "../rtmp-bridge";

describe("RTMP bridge audio policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the 48 kHz browser master mix in the encoded stream", () => {
    const bridge = new RTMPBridge({ audioBitrate: 160 });
    const audioArgs = (bridge as any).buildAudioArgs() as string[];

    expect(STREAM_AUDIO_SAMPLE_RATE_HZ).toBe(48_000);
    expect(audioArgs).toContain("aresample=async=1000:first_pts=0");
    expect(
      audioArgs.slice(audioArgs.indexOf("-ar"), audioArgs.indexOf("-ar") + 2),
    ).toEqual(["-ar", "48000"]);
  });

  it("retains closed-pipe error guards while stopping FFmpeg", () => {
    const bridge = new RTMPBridge();
    const videoPipe = new PassThrough();
    const audioPipe = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: videoPipe,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [videoPipe, null, null, audioPipe],
      kill: vi.fn(),
    });
    const ignoreClosedPipe = (error: Error & { code?: string }) => {
      if (error.code !== "EPIPE") throw error;
    };
    videoPipe.on("error", ignoreClosedPipe);
    audioPipe.on("error", ignoreClosedPipe);
    (bridge as any).ffmpeg = child;

    (bridge as any).stopFFmpeg();

    expect(videoPipe.listenerCount("error")).toBeGreaterThan(0);
    expect(audioPipe.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      videoPipe.emit(
        "error",
        Object.assign(new Error("closed"), { code: "EPIPE" }),
      ),
    ).not.toThrow();
    expect(() =>
      audioPipe.emit(
        "error",
        Object.assign(new Error("closed"), { code: "EPIPE" }),
      ),
    ).not.toThrow();
  });

  it("holds the next browser PCM packet until the FFmpeg pipe drains", async () => {
    const bridge = new RTMPBridge();
    const pendingWrites: Array<() => void> = [];
    const audioPipe = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        pendingWrites.push(callback);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [new PassThrough(), null, null, audioPipe],
      kill: vi.fn(),
    });
    (bridge as any).ffmpeg = child;
    (bridge as any).browserAudioInput = {
      sampleRate: STREAM_AUDIO_SAMPLE_RATE_HZ,
      channels: 2,
    };

    expect(await bridge.feedBrowserAudioPcm(Buffer.alloc(32))).toBe(true);
    expect(audioPipe.writableNeedDrain).toBe(true);

    let secondWriteSettled = false;
    const secondWrite = bridge
      .feedBrowserAudioPcm(Buffer.alloc(32))
      .finally(() => {
        secondWriteSettled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(secondWriteSettled).toBe(false);
    expect(audioPipe.writableLength).toBe(32);

    pendingWrites.shift()?.();
    expect(await secondWrite).toBe(true);
    expect(audioPipe.writableLength).toBe(32);
    expect(bridge.getStatus().audioTrimmedChunks).toBe(0);

    pendingWrites.shift()?.();
    audioPipe.end();
  });
});
