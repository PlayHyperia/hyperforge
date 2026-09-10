import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptureFramePump } from "../capture-frame-pump";

afterEach(() => {
  vi.useRealTimers();
});

describe("CDP capture frame pump", () => {
  it("holds the latest frame on a stable real-time output cadence", async () => {
    vi.useFakeTimers();
    const writeFrame = vi.fn<(frame: string) => Promise<boolean>>(
      async () => true,
    );
    const pump = new CaptureFramePump<string>(30, writeFrame);

    pump.pushFrame("frame-a");
    pump.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(34);
    pump.pushFrame("frame-b");
    await vi.advanceTimersByTimeAsync(34);

    expect(writeFrame.mock.calls.map(([frame]) => frame)).toEqual([
      "frame-a",
      "frame-a",
      "frame-b",
    ]);
    expect(pump.getStats()).toMatchObject({
      sourceFrames: 2,
      emittedFrames: 3,
      repeatedFrames: 1,
      rejectedFrames: 0,
      skippedFrames: 0,
    });

    await pump.stop();
  });

  it("can phase output behind compositor delivery without changing cadence", async () => {
    vi.useFakeTimers();
    const writeFrame = vi.fn<(frame: string) => Promise<boolean>>(
      async () => true,
    );
    const pump = new CaptureFramePump<string>(30, writeFrame);

    pump.pushFrame("frame-a");
    pump.start(16);
    await vi.advanceTimersByTimeAsync(15);
    expect(writeFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFrame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(34);
    expect(writeFrame).toHaveBeenCalledTimes(2);

    await pump.stop();
  });

  it("catches up after a brief encoder stall without overlapping writes", async () => {
    vi.useFakeTimers();
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writeFrame = vi
      .fn<(frame: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await firstWrite;
        activeWrites--;
        return true;
      })
      .mockImplementation(async () => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        activeWrites--;
        return true;
      });
    const pump = new CaptureFramePump<string>(30, writeFrame);

    pump.pushFrame("frame-a");
    pump.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(writeFrame).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(maxActiveWrites).toBe(1);
    expect(pump.getStats().skippedFrames).toBe(0);

    await pump.stop();
  });

  it("bounds catch-up after a process-scale suspension", async () => {
    vi.useFakeTimers();
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writeFrame = vi
      .fn<(frame: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstWrite;
        return true;
      })
      .mockResolvedValue(true);
    const pump = new CaptureFramePump<string>(30, writeFrame);

    pump.pushFrame("frame-a");
    pump.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_999);
    releaseFirstWrite();
    await vi.advanceTimersByTimeAsync(1);

    expect(pump.getStats().skippedFrames).toBeGreaterThan(0);
    expect(writeFrame.mock.calls.length).toBeLessThanOrEqual(32);

    await pump.stop();
  });

  it("stops its delivery timer without emitting another frame", async () => {
    vi.useFakeTimers();
    const writeFrame = vi.fn<(frame: string) => Promise<boolean>>(
      async () => true,
    );
    const pump = new CaptureFramePump<string>(30, writeFrame);

    pump.pushFrame("frame-a");
    pump.start();
    await vi.advanceTimersByTimeAsync(1);
    await pump.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(writeFrame).toHaveBeenCalledTimes(1);
  });
});
