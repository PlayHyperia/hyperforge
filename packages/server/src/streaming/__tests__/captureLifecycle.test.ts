import { describe, expect, it } from "vitest";

import { CaptureLifecycleTracker } from "../capture-lifecycle.js";

describe("CaptureLifecycleTracker", () => {
  it("records a monotonic startup timeline without duplicating a stage", () => {
    const tracker = new CaptureLifecycleTracker(42, 1_000);

    tracker.transition("bridge_starting", 1_010);
    tracker.transition("bridge_starting", 1_020);
    tracker.transition("browser_launching", 900);

    expect(tracker.snapshot()).toEqual({
      processId: 42,
      processStartedAt: 1_000,
      stage: "browser_launching",
      stageStartedAt: 1_010,
      updatedAt: 1_010,
      transitions: [
        { stage: "process_starting", at: 1_000 },
        { stage: "bridge_starting", at: 1_010 },
        { stage: "browser_launching", at: 1_010 },
      ],
    });
  });

  it("returns defensive transition copies", () => {
    const tracker = new CaptureLifecycleTracker(7, 2_000);
    const first = tracker.transition("page_loading", 2_100);
    first.transitions[0]!.stage = "failed";

    expect(tracker.snapshot().transitions[0]).toEqual({
      stage: "process_starting",
      at: 2_000,
    });
  });

  it("retains a bounded recent history during repeated recovery", () => {
    const tracker = new CaptureLifecycleTracker(9, 3_000);
    const stages = [
      "bridge_starting",
      "browser_launching",
      "page_loading",
      "renderer_waiting",
      "renderer_ready",
      "capture_warmup",
      "capture_starting",
      "streaming",
    ] as const;

    for (let index = 0; index < 24; index += 1) {
      tracker.transition(stages[index % stages.length]!, 3_001 + index);
    }

    const snapshot = tracker.snapshot();
    expect(snapshot.transitions).toHaveLength(16);
    expect(snapshot.transitions.at(-1)).toEqual({
      stage: "streaming",
      at: 3_024,
    });
    expect(snapshot.stage).toBe("streaming");
  });
});
