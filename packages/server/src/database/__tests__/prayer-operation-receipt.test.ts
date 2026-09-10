import type { StreamingDuelPrayerObservationContext } from "@hyperforge/shared";
import { describe, expect, it } from "vitest";

import {
  assertCompactedPrayerStateReceiptMatches,
  normalizePrayerSnapshot,
  parseStoredPrayerStateOperation,
  prayerStateFingerprint,
  validatePrayerTransition,
} from "../prayer-operation-receipt";

const operationId = "7af1982d-44e7-4d50-bb4f-e5ea87742f1d";
const playerId = "prayer-compaction-player";
const expected = {
  pointUnits: 39_000_000,
  maxPoints: 39,
  activePrayers: [] as string[],
};
const committed = {
  pointUnits: 39_000_000,
  maxPoints: 39,
  activePrayers: ["hawk_eye"],
};
const publicActionObservation: StreamingDuelPrayerObservationContext = {
  operationId,
  tick: 10,
  observedAt: 1_788_076_800_000,
  cycleId: "cycle-prayer-compaction",
  duelId: "duel-prayer-compaction",
  actorId: playerId,
  opponentId: "prayer-compaction-opponent",
  phase: "FIGHTING",
  combatRole: "ranged",
  tacticalMacro: "kite",
  prayer: "hawk_eye",
};

function makeState() {
  return {
    version: 1 as const,
    requestFingerprint: prayerStateFingerprint(
      playerId,
      "toggle",
      expected,
      committed,
      publicActionObservation,
    ),
    transition: "toggle" as const,
    expected,
    committed,
    publicActionObservation,
  };
}

describe("prayer operation receipt semantics", () => {
  it("normalizes active prayer order before fingerprinting", () => {
    expect(
      normalizePrayerSnapshot(
        {
          pointUnits: 10_000_000,
          maxPoints: 10,
          activePrayers: ["rock_skin", "hawk_eye"],
        },
        "test",
      ).activePrayers,
    ).toEqual(["hawk_eye", "rock_skin"]);
  });

  it("re-derives an exact public toggle receipt before compaction", () => {
    expect(
      parseStoredPrayerStateOperation(makeState(), playerId, operationId),
    ).toEqual(makeState());
  });

  it.each([
    ["fingerprint", { requestFingerprint: "0".repeat(64) }],
    [
      "committed state",
      { committed: { ...committed, pointUnits: 38_000_000 } },
    ],
    [
      "operation identity",
      {
        publicActionObservation: {
          ...publicActionObservation,
          operationId: "0e29e126-df9b-4b43-acbf-45d52d49bb31",
        },
      },
    ],
    ["unexpected private field", { privateReasoning: "must-not-survive" }],
  ])("rejects a changed %s", (_label, change) => {
    expect(() =>
      parseStoredPrayerStateOperation(
        { ...makeState(), ...change },
        playerId,
        operationId,
      ),
    ).toThrow("prayer_receipt_compaction_state_invalid");
  });

  it("rejects a transition whose custody semantics do not match its name", () => {
    expect(() =>
      validatePrayerTransition("restore", expected, committed),
    ).toThrow("prayer_state_transition_invalid");
  });

  it("accepts only the exact compacted semantic and observation identity", () => {
    const request = {
      playerId,
      requestFingerprint: makeState().requestFingerprint,
      transition: "toggle" as const,
      publicObservationOperationId: publicActionObservation.operationId,
    };
    expect(() =>
      assertCompactedPrayerStateReceiptMatches(request, request),
    ).not.toThrow();
    for (const changed of [
      { playerId: "another-player" },
      { requestFingerprint: "0".repeat(64) },
      { transition: "drain" },
      { publicObservationOperationId: null },
    ]) {
      expect(() =>
        assertCompactedPrayerStateReceiptMatches(
          { ...request, ...changed },
          request,
        ),
      ).toThrow("prayer_state_operation_id_conflict");
    }
  });
});
