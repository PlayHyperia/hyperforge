/**
 * Browser expressions are shipped as literal JavaScript strings because Bun
 * may add module-scoped helper references while serializing a large
 * TypeScript callback for Playwright. Those helpers do not exist in the page
 * realm. Keeping the entire installer inside this literal makes the browser
 * boundary explicit and self-contained.
 */
export const BROWSER_MASTER_AUDIO_CAPTURE_INSTALL_SOURCE = String.raw`
(async () => {
  const win = window;
  const capture = win.__HYPERIA_STREAM_AUDIO_CAPTURE__;
  const pushPcm = win.__HYPERIA_WRITE_AUDIO_PCM__;
  if (!capture || typeof pushPcm !== "function") {
    return { ready: false, reason: "master_mix_unavailable" };
  }

  if (typeof capture.activate !== "function") {
    return { ready: false, reason: "master_mix_activation_unavailable" };
  }
  try {
    await capture.activate();
  } catch (error) {
    return {
      ready: false,
      reason:
        "master_mix_activation_failed:" +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  if (capture.context.state === "suspended") {
    try {
      await capture.context.resume();
    } catch {}
  }
  if (capture.context.state !== "running") {
    return {
      ready: false,
      reason: "audio_context_" + capture.context.state,
    };
  }

  const stream = capture.stream;
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== "live") {
    return { ready: false, reason: "master_mix_track_unavailable" };
  }

  const context = capture.context;
  const masterNode = capture.node;
  if (!masterNode || typeof masterNode.connect !== "function") {
    return { ready: false, reason: "master_mix_node_unavailable" };
  }

  // Batch 42.7 ms of 48 kHz stereo Float32 PCM (16 KiB) per browser binding
  // call. This stays below the bridge's supported 50 ms minimum latency budget
  // while halving the previous 21.3 ms/8 KiB control-plane cadence. The Node
  // bridge propagates FFmpeg drain pressure and owns the bounded queue.
  const bufferFrames = 2048;
  const processorSource = [
    "class HyperiaMasterMixCaptureProcessor extends AudioWorkletProcessor {",
    "  constructor(options) {",
    "    super();",
    "    this.bufferFrames = options.processorOptions.bufferFrames;",
    "    this.left = new Float32Array(this.bufferFrames);",
    "    this.right = new Float32Array(this.bufferFrames);",
    "    this.offset = 0;",
    "  }",
    "  process(inputs, outputs) {",
    "    const input = inputs[0];",
    "    const left = input && input[0];",
    "    if (!left || left.length === 0) return true;",
    "    const right = input[1] || left;",
    "    const output = outputs[0];",
    "    if (output && output[0]) output[0].set(left);",
    "    if (output && output[1]) output[1].set(right);",
    "    let cursor = 0;",
    "    while (cursor < left.length) {",
    "      const count = Math.min(left.length - cursor, this.bufferFrames - this.offset);",
    "      this.left.set(left.subarray(cursor, cursor + count), this.offset);",
    "      this.right.set(right.subarray(cursor, cursor + count), this.offset);",
    "      this.offset += count;",
    "      cursor += count;",
    "      if (this.offset === this.bufferFrames) {",
    "        const interleaved = new Float32Array(this.bufferFrames * 2);",
    "        let peak = 0;",
    "        for (let frame = 0; frame < this.bufferFrames; frame += 1) {",
    "          const leftSample = this.left[frame];",
    "          const rightSample = this.right[frame];",
    "          interleaved[frame * 2] = leftSample;",
    "          interleaved[frame * 2 + 1] = rightSample;",
    "          peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));",
    "        }",
    "        this.port.postMessage({ pcm: interleaved.buffer, peak }, [interleaved.buffer]);",
    "        this.left = new Float32Array(this.bufferFrames);",
    "        this.right = new Float32Array(this.bufferFrames);",
    "        this.offset = 0;",
    "      }",
    "    }",
    "    return true;",
    "  }",
    "}",
    "registerProcessor(\"hyperia-master-mix-capture\", HyperiaMasterMixCaptureProcessor);",
  ].join("\n");
  const moduleUrl = URL.createObjectURL(
    new Blob([processorSource], { type: "text/javascript" }),
  );

  try {
    await context.audioWorklet.addModule(moduleUrl);
  } catch (error) {
    URL.revokeObjectURL(moduleUrl);
    return {
      ready: false,
      reason:
        "audio_worklet_unavailable:" +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  const processor = new AudioWorkletNode(
    context,
    "hyperia-master-mix-capture",
    {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: { bufferFrames },
    },
  );
  const renderClockOutput = context.createGain();
  // ClientAudio routes this context to Chrome's explicit none sink before
  // installation. Preserve unity gain here so Chromium cannot optimize away
  // the side-effecting AudioWorklet; the sink is clocked but never audible.
  renderClockOutput.gain.value = 1;
  masterNode.connect(processor);
  processor.connect(renderClockOutput);
  renderClockOutput.connect(context.destination);

  let stopped = false;
  let chunks = 0;
  let bytes = 0;
  const contentThreshold = 1e-4;
  let contentChunks = 0;
  let lastSamplePeak = null;
  let maxSamplePeak = null;
  let lastContentChunkAt = null;
  let droppedChunks = 0;
  let pendingWrites = 0;
  let lastChunkAt = null;
  let sendChain = Promise.resolve();

  processor.port.onmessage = (event) => {
    const packet = event.data;
    if (stopped || !packet || !(packet.pcm instanceof ArrayBuffer)) return;
    if (pendingWrites >= 64) {
      droppedChunks += 1;
      return;
    }
    const pcm = new Uint8Array(packet.pcm);
    const samplePeak = Number.isFinite(packet.peak)
      ? Math.max(0, packet.peak)
      : 0;
    let binary = "";
    const blockSize = 0x8000;
    for (let offset = 0; offset < pcm.length; offset += blockSize) {
      binary += String.fromCharCode(
        ...pcm.subarray(offset, offset + blockSize),
      );
    }
    const encoded = btoa(binary);
    pendingWrites += 1;
    sendChain = sendChain
      .then(async () => {
        if (stopped) return;
        const accepted = await pushPcm(encoded);
        if (accepted) {
          chunks += 1;
          bytes += pcm.byteLength;
          lastChunkAt = Date.now();
          lastSamplePeak = samplePeak;
          maxSamplePeak = Math.max(maxSamplePeak || 0, samplePeak);
          if (samplePeak >= contentThreshold) {
            contentChunks += 1;
            lastContentChunkAt = lastChunkAt;
          }
        } else {
          droppedChunks += 1;
        }
      })
      .catch(() => {
        droppedChunks += 1;
      })
      .finally(() => {
        pendingWrites -= 1;
      });
  };

  win.__HYPERIA_BROWSER_AUDIO_CONTROL__ = {
    getStatus: () => ({
      contextState: context.state,
      sourceContextState: capture.context.state,
      trackState: track.readyState,
      sampleRate: context.sampleRate,
      channels: 2,
      chunks,
      bytes,
      contentChunks,
      contentThreshold,
      lastSamplePeak,
      maxSamplePeak,
      lastContentChunkAt,
      droppedChunks,
      pendingWrites,
      lastChunkAt,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      processor.port.onmessage = null;
      processor.port.close();
      masterNode.disconnect(processor);
      processor.disconnect();
      renderClockOutput.disconnect();
      URL.revokeObjectURL(moduleUrl);
    },
  };

  return {
    ready: true,
    sampleRate: context.sampleRate,
    channels: 2,
  };
})()
`;

export const BROWSER_MASTER_AUDIO_CAPTURE_STATUS_SOURCE = String.raw`
(() => {
  const control = window.__HYPERIA_BROWSER_AUDIO_CONTROL__;
  return control && typeof control.getStatus === "function"
    ? control.getStatus()
    : null;
})()
`;

export const BROWSER_MASTER_AUDIO_CAPTURE_STOP_SOURCE = String.raw`
(async () => {
  const control = window.__HYPERIA_BROWSER_AUDIO_CONTROL__;
  if (control && typeof control.stop === "function") {
    await control.stop();
  }
  delete window.__HYPERIA_BROWSER_AUDIO_CONTROL__;
})()
`;

export type BrowserMasterAudioCaptureInstallResult = {
  ready: boolean;
  reason?: string;
  sampleRate?: number;
  channels?: 2;
};
