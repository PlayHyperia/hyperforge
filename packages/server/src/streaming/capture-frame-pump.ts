import { parseCaptureFrameRate } from "./capture-frame-pacer";

export interface CaptureFramePumpStats {
  sourceFrames: number;
  emittedFrames: number;
  repeatedFrames: number;
  rejectedFrames: number;
  skippedFrames: number;
}

type CaptureFrameWriter<T> = (frame: T) => boolean | Promise<boolean>;

/**
 * Owns the real-time video delivery clock for CDP capture. The compositor can
 * pause while loading or render irregularly, but FFmpeg's declared MJPEG rate
 * still requires one frame per output interval to stay synchronized with the
 * browser's live audio clock. The pump therefore holds the latest complete
 * frame when no newer frame is available and never overlaps encoder writes.
 */
export class CaptureFramePump<T> {
  private static readonly MAX_CATCH_UP_INTERVALS = 30;
  private readonly intervalMs: number;
  private readonly writeFrame: CaptureFrameWriter<T>;
  private latestFrame: T | null = null;
  private latestRevision = 0;
  private lastEmittedRevision = 0;
  private nextFrameAt = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeWrite: Promise<void> | null = null;
  private stats: CaptureFramePumpStats = {
    sourceFrames: 0,
    emittedFrames: 0,
    repeatedFrames: 0,
    rejectedFrames: 0,
    skippedFrames: 0,
  };

  constructor(framesPerSecond: number, writeFrame: CaptureFrameWriter<T>) {
    const safeFps = parseCaptureFrameRate(String(framesPerSecond));
    this.intervalMs = 1000 / safeFps;
    this.writeFrame = writeFrame;
  }

  pushFrame(frame: T): void {
    this.latestFrame = frame;
    this.latestRevision += 1;
    this.stats.sourceFrames += 1;
  }

  start(initialDelayMs = 0): void {
    if (this.running) return;
    this.running = true;
    const safeInitialDelayMs = Number.isFinite(initialDelayMs)
      ? Math.min(this.intervalMs, Math.max(0, initialDelayMs))
      : 0;
    this.nextFrameAt = performance.now() + safeInitialDelayMs;
    this.schedule(safeInitialDelayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeWrite;
  }

  getStats(): CaptureFramePumpStats {
    return { ...this.stats };
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const write = this.emitScheduledFrame();
        this.activeWrite = write;
        void write.finally(() => {
          if (this.activeWrite === write) this.activeWrite = null;
        });
      },
      Math.max(0, delayMs),
    );
  }

  private async emitScheduledFrame(): Promise<void> {
    if (!this.running) return;

    const frame = this.latestFrame;
    const revision = this.latestRevision;
    if (frame !== null) {
      const repeated = this.lastEmittedRevision === revision;
      try {
        const accepted = await this.writeFrame(frame);
        if (accepted) {
          this.stats.emittedFrames += 1;
          if (repeated) this.stats.repeatedFrames += 1;
          this.lastEmittedRevision = revision;
        } else {
          this.stats.rejectedFrames += 1;
        }
      } catch {
        this.stats.rejectedFrames += 1;
      }
    }

    if (!this.running) return;

    this.nextFrameAt += this.intervalMs;
    const now = performance.now();
    const latenessMs = now - this.nextFrameAt;
    const overdueIntervals = Math.max(
      0,
      Math.floor(latenessMs / this.intervalMs),
    );
    if (overdueIntervals > CaptureFramePump.MAX_CATCH_UP_INTERVALS) {
      // Brief event-loop or encoder stalls must not shorten the declared CFR
      // video timeline relative to live audio. Emit the owed frames as fast as
      // the pipe accepts them. Bound catch-up to one second so a suspended
      // process cannot create an unbounded stale-video backlog.
      const skippedFrames =
        overdueIntervals - CaptureFramePump.MAX_CATCH_UP_INTERVALS;
      this.stats.skippedFrames += skippedFrames;
      this.nextFrameAt += skippedFrames * this.intervalMs;
    }
    this.schedule(this.nextFrameAt - now);
  }
}
