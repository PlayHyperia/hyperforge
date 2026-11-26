const DEFAULT_CAPTURE_FPS = 30;
const MAX_CAPTURE_FPS = 60;

export function parseCaptureFrameRate(
  rawValue: string | undefined,
  fallback = DEFAULT_CAPTURE_FPS,
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(MAX_CAPTURE_FPS, Math.max(1, Math.round(fallback)))
    : DEFAULT_CAPTURE_FPS;
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(MAX_CAPTURE_FPS, Math.max(1, parsed));
}

/**
 * Resolves the render-source cadence independently from the encoder cadence.
 * A source may render faster for smoother CDP sampling, but it must never run
 * slower than the output clock or the constant-frame-rate pump will repeat
 * avoidable frames.
 */
export function resolveCaptureSourceFrameRate(
  outputFramesPerSecond: number,
  rawSourceFramesPerSecond: string | undefined,
): number {
  const outputFps = parseCaptureFrameRate(String(outputFramesPerSecond));
  if (!rawSourceFramesPerSecond?.trim()) return outputFps;
  return Math.max(
    outputFps,
    parseCaptureFrameRate(rawSourceFramesPerSecond, outputFps),
  );
}

/**
 * Limits CDP screencast acknowledgements to the configured delivery rate.
 * CDP produces another JPEG as soon as the previous frame is acknowledged, so
 * immediate acknowledgements can make a high-refresh compositor encode and
 * pipe 100+ frames per second even when FFmpeg is configured for 30 FPS.
 */
export class CaptureFramePacer {
  private readonly intervalMs: number;
  private nextFrameAt: number | null = null;
  private pacingTail: Promise<void> = Promise.resolve();

  constructor(framesPerSecond: number) {
    const safeFps = parseCaptureFrameRate(String(framesPerSecond));
    this.intervalMs = 1000 / safeFps;
  }

  getDelayMs(now: number): number {
    if (this.nextFrameAt === null) return 0;
    return Math.max(0, this.nextFrameAt - now);
  }

  markFrameAcknowledged(now: number): void {
    if (
      this.nextFrameAt === null ||
      now - this.nextFrameAt >= this.intervalMs
    ) {
      this.nextFrameAt = now + this.intervalMs;
      return;
    }
    this.nextFrameAt += this.intervalMs;
  }

  /**
   * Serializes CDP frame callbacks before applying the acknowledgement clock.
   * Chromium can deliver more than one screencast callback before an earlier
   * async listener finishes. Without this queue those callbacks observe the
   * same deadline, wake together, and publish a burst followed by a gap.
   */
  runPaced<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.pacingTail.then(async () => {
      const delayMs = this.getDelayMs(performance.now());
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        return await operation();
      } finally {
        this.markFrameAcknowledged(performance.now());
      }
    });
    this.pacingTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async drain(): Promise<void> {
    await this.pacingTail;
  }

  reset(): void {
    this.nextFrameAt = null;
  }
}
