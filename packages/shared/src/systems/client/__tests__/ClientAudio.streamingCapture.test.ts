import { describe, expect, it, vi } from "vitest";

import { activateSilentStreamingAudioSink } from "../ClientAudio";

describe("streaming audio sink", () => {
  it("routes the dedicated capture context to Chrome's clocked silent sink", async () => {
    const setSinkId = vi.fn(async () => undefined);

    await activateSilentStreamingAudioSink({
      setSinkId,
    } as unknown as AudioContext);

    expect(setSinkId).toHaveBeenCalledExactlyOnceWith({ type: "none" });
  });

  it("fails closed when the browser cannot provide a clocked silent sink", async () => {
    await expect(
      activateSilentStreamingAudioSink({} as AudioContext),
    ).rejects.toThrow("requires a clocked silent output sink");
  });

  it("propagates a browser sink-routing failure", async () => {
    const failure = new Error("silent sink unavailable");
    await expect(
      activateSilentStreamingAudioSink({
        setSinkId: vi.fn(async () => {
          throw failure;
        }),
      } as unknown as AudioContext),
    ).rejects.toBe(failure);
  });
});
