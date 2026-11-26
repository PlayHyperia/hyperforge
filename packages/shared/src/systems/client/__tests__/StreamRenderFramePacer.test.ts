import { describe, expect, it } from "vitest";

import { StreamRenderFramePacer } from "../StreamRenderFramePacer";

describe("stream render frame pacing", () => {
  it("renders the first frame immediately and caps later work", () => {
    const pacer = new StreamRenderFramePacer(30);
    expect(pacer.shouldRun(0)).toBe(true);
    expect(pacer.shouldRun(8)).toBe(false);
    expect(pacer.shouldRun(16)).toBe(false);
    expect(pacer.shouldRun(25)).toBe(false);
    expect(pacer.shouldRun(33)).toBe(true);
  });

  it("does not accumulate catch-up work after a delayed frame", () => {
    const pacer = new StreamRenderFramePacer(30);
    expect(pacer.shouldRun(0)).toBe(true);
    expect(pacer.shouldRun(500)).toBe(true);
    expect(pacer.shouldRun(510)).toBe(false);
    expect(pacer.shouldRun(534)).toBe(true);
  });

  it("allows an immediate frame after visibility-loop replacement", () => {
    const pacer = new StreamRenderFramePacer(30);
    expect(pacer.shouldRun(100)).toBe(true);
    pacer.reset();
    expect(pacer.shouldRun(101)).toBe(true);
  });

  it("does not drift when callbacks arrive slightly after the target", () => {
    const pacer = new StreamRenderFramePacer(60);
    expect(pacer.shouldRun(0)).toBe(true);
    expect(pacer.shouldRun(17)).toBe(true);
    expect(pacer.shouldRun(33)).toBe(true);
    expect(pacer.shouldRun(50)).toBe(true);
  });

  it("selects every second 120 Hz callback for a true 60 FPS stream", () => {
    const pacer = new StreamRenderFramePacer(60);
    expect(pacer.shouldRun(0)).toBe(true);
    expect(pacer.shouldRun(8)).toBe(false);
    expect(pacer.shouldRun(16)).toBe(true);
    expect(pacer.shouldRun(24)).toBe(false);
    expect(pacer.shouldRun(32)).toBe(true);
  });
});
