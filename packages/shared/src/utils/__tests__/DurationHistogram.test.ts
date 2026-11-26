import { describe, expect, it } from "vitest";
import { DurationHistogram } from "../DurationHistogram";

describe("DurationHistogram", () => {
  it("reports full-window averages and percentiles at millisecond resolution", () => {
    const histogram = new DurationHistogram();

    for (let duration = 1; duration <= 100; duration++) {
      histogram.record(duration);
    }

    expect(histogram.snapshot()).toEqual({
      samples: 100,
      average: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it("bounds storage while preserving an exact overflow maximum", () => {
    const histogram = new DurationHistogram(10);

    histogram.record(1);
    histogram.record(12);
    histogram.record(25);

    expect(histogram.snapshot()).toEqual({
      samples: 3,
      average: 12.67,
      p50: 25,
      p95: 25,
      p99: 25,
      max: 25,
    });
  });

  it("normalizes invalid and negative samples and can be reset", () => {
    const histogram = new DurationHistogram(100);

    histogram.record(-5);
    histogram.record(Number.NaN);
    expect(histogram.snapshot()).toMatchObject({
      samples: 2,
      p50: 0,
      p95: 100,
      max: 100,
    });

    histogram.reset();
    expect(histogram.snapshot()).toEqual({
      samples: 0,
      average: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });

  it("rejects unsafe bucket sizes", () => {
    expect(() => new DurationHistogram(0)).toThrow(RangeError);
    expect(() => new DurationHistogram(1.5)).toThrow(RangeError);
  });
});
