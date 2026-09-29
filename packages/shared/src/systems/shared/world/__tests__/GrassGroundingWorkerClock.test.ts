import { describe, expect, it } from "vitest";
import {
  captureGrassGroundingWorkerClock,
  translateGrassGroundingWorkerExecution,
  GRASS_GROUNDING_CLOCK_MAXIMUM_ROUND_TRIP_MS,
} from "../../../../utils/workers/GrassGroundingWorkerClock";

describe("grounding worker conservative clock translation", () => {
  it("handles observed and larger realm offsets without extending the original lifetime", () => {
    const epoch = 1_790_704_353_391.7;
    for (const offset of [-5000, -44.4, 0, 44.4, 5000]) {
      for (const outbound of [0, 1, 125]) {
        for (const inbound of [0, 1, 125]) {
          const received = epoch + outbound + inbound;
          const bridge = captureGrassGroundingWorkerClock(
            epoch,
            received,
            epoch + outbound + offset,
          );
          const execution = Object.freeze({
            policy: "soft-cost-finite-lifetime-v1" as const,
            deadlineEpochMs: received + 10_000,
          });
          const wire = translateGrassGroundingWorkerExecution(
            execution,
            bridge,
          );
          expect(Object.isFrozen(bridge)).toBe(true);
          expect(Object.isFrozen(wire)).toBe(true);
          expect(wire).not.toBe(execution);
          // Convert back only in the assertion using this explicit input's
          // known offset. No clocks or production functions are replaced.
          expect(wire.deadlineEpochMs - offset).toBe(
            execution.deadlineEpochMs - inbound,
          );
          expect(execution.deadlineEpochMs).toBe(received + 10_000);
          expect(bridge.roundTripMs).toBe(outbound + inbound);
        }
      }
    }
  });

  it("reuses exactly one translated deadline for every stage and queued dispatch", () => {
    const bridge = captureGrassGroundingWorkerClock(1000, 1004, 1052);
    const original = Object.freeze({
      policy: "soft-cost-finite-lifetime-v1" as const,
      deadlineEpochMs: 11004,
    });
    const expected = translateGrassGroundingWorkerExecution(original, bridge);
    for (let stage = 0; stage < 10; stage++) {
      expect(translateGrassGroundingWorkerExecution(original, bridge)).toEqual(
        expected,
      );
    }
    expect(original.deadlineEpochMs).toBe(11004);
  });

  it("admits the finite quality boundary and rejects stale or malformed observations", () => {
    expect(
      captureGrassGroundingWorkerClock(
        1000,
        1000 + GRASS_GROUNDING_CLOCK_MAXIMUM_ROUND_TRIP_MS,
        5000,
      ).roundTripMs,
    ).toBe(250);
    expect(() =>
      captureGrassGroundingWorkerClock(1000, 1250.001, 5000),
    ).toThrow("round trip");
    expect(() => captureGrassGroundingWorkerClock(1000, 999, 5000)).toThrow(
      "observations",
    );
    for (const invalid of [NaN, Infinity, -Infinity, -1]) {
      for (const field of [0, 1, 2]) {
        const values: [number, number, number] = [1000, 1004, 1052];
        values[field] = invalid;
        expect(() => captureGrassGroundingWorkerClock(...values)).toThrow(
          "observations",
        );
      }
    }
  });

  it("keeps expired translated execution expired rather than issuing another TTL", () => {
    const bridge = captureGrassGroundingWorkerClock(1000, 1010, 100);
    const expired = translateGrassGroundingWorkerExecution(
      { policy: "soft-cost-finite-lifetime-v1", deadlineEpochMs: 500 },
      bridge,
    );
    expect(expired.deadlineEpochMs).toBe(0);
  });
});
