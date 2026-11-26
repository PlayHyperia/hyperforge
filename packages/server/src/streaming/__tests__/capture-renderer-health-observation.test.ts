import { describe, expect, it } from "vitest";

import { observeRendererHealth } from "../capture-renderer-health-observation.js";

describe("capture renderer health observation", () => {
  it("refreshes a stable healthy declaration at every successful page probe", () => {
    expect(
      observeRendererHealth({
        declared: {
          ready: true,
          degradedReason: null,
          updatedAt: 1_000,
          phase: "IDLE",
        },
        probedAt: 61_000,
        criticalUiVisible: false,
        criticalReason: "initialization_failed",
      }),
    ).toEqual({
      ready: true,
      degradedReason: null,
      updatedAt: 61_000,
      phase: "IDLE",
    });
  });

  it("keeps an explicitly degraded renderer degraded while refreshing observation time", () => {
    expect(
      observeRendererHealth({
        declared: {
          ready: false,
          degradedReason: "camera_target_unresolved",
          updatedAt: 1_000,
          phase: "FIGHTING",
        },
        probedAt: 2_000,
        criticalUiVisible: false,
        criticalReason: "initialization_failed",
      }),
    ).toEqual({
      ready: false,
      degradedReason: "camera_target_unresolved",
      updatedAt: 2_000,
      phase: "FIGHTING",
    });
  });

  it("makes a visible critical error dominant and rejects invalid probe authority", () => {
    expect(
      observeRendererHealth({
        declared: {
          ready: true,
          degradedReason: null,
          updatedAt: 1_000,
          phase: "IDLE",
        },
        probedAt: 2_000,
        criticalUiVisible: true,
        criticalReason: "initialization_failed",
      }),
    ).toEqual({
      ready: false,
      degradedReason: "initialization_failed",
      updatedAt: 2_000,
      phase: "IDLE",
    });
    expect(() =>
      observeRendererHealth({
        declared: { ready: true },
        probedAt: Number.NaN,
        criticalUiVisible: false,
        criticalReason: "initialization_failed",
      }),
    ).toThrow("positive safe integer");
  });
});
