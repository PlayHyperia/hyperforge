export interface DurationPercentiles {
  samples: number;
  average: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Allocation-free, full-window duration histogram for runtime diagnostics.
 *
 * Durations are retained at one-millisecond resolution. The final bucket
 * contains values above the configured ceiling while `max` remains exact, so
 * memory stays bounded without hiding catastrophic stalls.
 */
export class DurationHistogram {
  private readonly buckets: Uint32Array;
  private sampleCount = 0;
  private total = 0;
  private maximum = 0;

  constructor(private readonly maxBucketMs: number = 10_000) {
    if (!Number.isSafeInteger(maxBucketMs) || maxBucketMs < 1) {
      throw new RangeError("maxBucketMs must be a positive safe integer");
    }
    this.buckets = new Uint32Array(maxBucketMs + 1);
  }

  record(durationMs: number): void {
    const duration = Number.isFinite(durationMs)
      ? Math.max(0, Math.round(durationMs))
      : this.maxBucketMs;
    const bucket = Math.min(duration, this.maxBucketMs);
    this.buckets[bucket]++;
    this.sampleCount++;
    this.total += duration;
    if (duration > this.maximum) this.maximum = duration;
  }

  snapshot(): DurationPercentiles {
    if (this.sampleCount === 0) {
      return { samples: 0, average: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }

    return {
      samples: this.sampleCount,
      average: Math.round((this.total / this.sampleCount) * 100) / 100,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      max: this.maximum,
    };
  }

  reset(): void {
    this.buckets.fill(0);
    this.sampleCount = 0;
    this.total = 0;
    this.maximum = 0;
  }

  private percentile(fraction: number): number {
    const target = Math.ceil(this.sampleCount * fraction);
    let observed = 0;
    for (let duration = 0; duration < this.buckets.length; duration++) {
      observed += this.buckets[duration];
      if (observed >= target) {
        return duration === this.maxBucketMs ? this.maximum : duration;
      }
    }
    return this.maximum;
  }
}
