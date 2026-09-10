import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE,
  BROWSER_MASTER_AUDIO_CAPTURE_STATUS_SOURCE,
  BROWSER_MASTER_AUDIO_CAPTURE_STOP_SOURCE,
} from "../browser-master-audio-capture-source";

describe("browser master-audio capture source", () => {
  it("ships self-contained browser expressions without server helper leakage", () => {
    for (const source of [
      BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE,
      BROWSER_MASTER_AUDIO_CAPTURE_STATUS_SOURCE,
      BROWSER_MASTER_AUDIO_CAPTURE_STOP_SOURCE,
    ]) {
      expect(() => new Script(source)).not.toThrow();
      expect(source).not.toContain("__name");
    }
  });

  it("captures only the game-owned master mix", () => {
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "__HYPERIA_STREAM_AUDIO_CAPTURE__",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "__HYPERIA_WRITE_AUDIO_PCM__",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "await capture.activate()",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "masterNode.connect(processor)",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "output[0].set(left)",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "contentThreshold = 1e-4",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "samplePeak >= contentThreshold",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).not.toContain(
      "createMediaStreamSource",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "AudioWorkletNode",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "renderClockOutput.gain.value = 1",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).not.toContain(
      "renderClockOutput.gain.value = 0",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).not.toMatch(
      /getUserMedia|getDisplayMedia|desktopCapture/,
    );
  });

  it("batches PCM below the browser binding throughput ceiling", () => {
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "const bufferFrames = 2048;",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).not.toContain(
      "const bufferFrames = 1024;",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "if (pendingWrites >= 64)",
    );
    expect(BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE).toContain(
      "sendChain = sendChain",
    );
  });
});
