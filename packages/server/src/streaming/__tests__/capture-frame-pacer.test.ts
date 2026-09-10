import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureFramePacer,
  parseCaptureFrameRate,
  resolveCaptureSourceFrameRate,
} from "../capture-frame-pacer";

afterEach(() => {
  vi.useRealTimers();
});

describe("CDP capture frame pacing", () => {
  it("defaults invalid input and clamps unsafe frame rates", () => {
    expect(parseCaptureFrameRate(undefined)).toBe(30);
    expect(parseCaptureFrameRate("invalid")).toBe(30);
    expect(parseCaptureFrameRate("0")).toBe(1);
    expect(parseCaptureFrameRate("240")).toBe(60);
  });

  it("allows the first frame immediately", () => {
    const pacer = new CaptureFramePacer(30);
    expect(pacer.getDelayMs(100)).toBe(0);
  });

  it("keeps the browser render source at or above the output cadence", () => {
    expect(resolveCaptureSourceFrameRate(30, undefined)).toBe(30);
    expect(resolveCaptureSourceFrameRate(30, "60")).toBe(60);
    expect(resolveCaptureSourceFrameRate(30, "15")).toBe(30);
    expect(resolveCaptureSourceFrameRate(240, "invalid")).toBe(60);
  });

  it("holds subsequent acknowledgements to the configured interval", () => {
    const pacer = new CaptureFramePacer(25);
    pacer.markFrameAcknowledged(100);
    expect(pacer.getDelayMs(110)).toBe(30);
    expect(pacer.getDelayMs(140)).toBe(0);
    expect(pacer.getDelayMs(160)).toBe(0);
  });

  it("keeps a stable schedule instead of adding processing time every frame", () => {
    const pacer = new CaptureFramePacer(50);
    pacer.markFrameAcknowledged(100);
    expect(pacer.getDelayMs(105)).toBe(15);
    pacer.markFrameAcknowledged(121);
    expect(pacer.getDelayMs(125)).toBe(15);
  });

  it("resets pacing for a replacement CDP session", () => {
    const pacer = new CaptureFramePacer(30);
    pacer.markFrameAcknowledged(100);
    pacer.reset();
    expect(pacer.getDelayMs(101)).toBe(0);
  });

  it("serializes bursty CDP callbacks onto the source cadence", async () => {
    vi.useFakeTimers();
    const pacer = new CaptureFramePacer(30);
    const observedAt: number[] = [];

    const callbacks = [1, 2, 3].map(() =>
      pacer.runPaced(() => {
        observedAt.push(performance.now());
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(observedAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(34);
    expect(observedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(34);
    expect(observedAt).toHaveLength(3);
    expect(observedAt[1]! - observedAt[0]!).toBeGreaterThanOrEqual(33);
    expect(observedAt[2]! - observedAt[1]!).toBeGreaterThanOrEqual(33);

    await Promise.all(callbacks);
    await pacer.drain();
  });
});
