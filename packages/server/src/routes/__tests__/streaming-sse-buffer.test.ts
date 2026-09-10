import { describe, expect, it } from "vitest";

import { shouldDeliverSseFrame } from "../streaming-sse-buffer.js";

describe("streaming SSE client delivery", () => {
  it("delivers only a strictly advancing positive sequence per client", () => {
    expect(shouldDeliverSseFrame(0, 1)).toBe(true);
    expect(shouldDeliverSseFrame(41, 42)).toBe(true);
    expect(shouldDeliverSseFrame(42, 42)).toBe(false);
    expect(shouldDeliverSseFrame(42, 41)).toBe(false);
    expect(shouldDeliverSseFrame(42, 0)).toBe(false);
    expect(shouldDeliverSseFrame(42, Number.NaN)).toBe(false);
  });
});
