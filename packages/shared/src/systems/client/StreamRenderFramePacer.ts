const DEFAULT_STREAM_RENDER_FPS = 30;
const MAX_STREAM_RENDER_FPS = 60;

/**
 * Gates the expensive client world/render tick while leaving the browser's
 * animation callback installed. A 30 FPS broadcast does not benefit from a
 * 120 Hz WebGPU render loop, and the excess work can starve co-located server
 * and encoder processes during scene transitions.
 */
export class StreamRenderFramePacer {
  // A 120 Hz callback nearest a 60 FPS target can arrive about 0.7 ms before
  // the ideal deadline after browser timer quantization. Accepting within this
  // narrow window prevents a third-callback (~25 ms) wait without admitting
  // the preceding 8 ms callback or materially raising lower requested rates.
  private static readonly SCHEDULER_TOLERANCE_MS = 1.5;
  private readonly intervalMs: number;
  private nextFrameAt: number | null = null;

  constructor(framesPerSecond = DEFAULT_STREAM_RENDER_FPS) {
    const safeFps = Number.isFinite(framesPerSecond)
      ? Math.min(
          MAX_STREAM_RENDER_FPS,
          Math.max(1, Math.round(framesPerSecond)),
        )
      : DEFAULT_STREAM_RENDER_FPS;
    this.intervalMs = 1000 / safeFps;
  }

  shouldRun(now: number): boolean {
    if (this.nextFrameAt === null) {
      this.nextFrameAt = now + this.intervalMs;
      return true;
    }
    if (
      now + StreamRenderFramePacer.SCHEDULER_TOLERANCE_MS <
      this.nextFrameAt
    ) {
      return false;
    }
    if (now - this.nextFrameAt >= this.intervalMs) {
      this.nextFrameAt = now + this.intervalMs;
    } else {
      this.nextFrameAt += this.intervalMs;
    }
    return true;
  }

  reset(): void {
    this.nextFrameAt = null;
  }
}
