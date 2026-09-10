import {
  MAX_ACTIVE_PRAYERS,
  parseStreamingDuelPrayerObservationContext,
} from "@hyperforge/shared";
import type { StreamingDuelPrayerObservationContext } from "@hyperforge/shared";
import { createHash } from "node:crypto";

import type {
  PrayerPersistenceSnapshot,
  PrayerStateTransitionKind,
} from "../shared/types";

export const PRAYER_POINT_UNITS_PER_POINT = 1_000_000;
const MAX_PRAYER_POINTS = 99;

export const PRAYER_TRANSITIONS = new Set<PrayerStateTransitionKind>([
  "toggle",
  "drain",
  "deactivate_all",
  "restore",
  "set_max",
  "repair",
]);

export type StoredPrayerStateOperation = {
  version: 1;
  requestFingerprint: string;
  transition: PrayerStateTransitionKind;
  expected: PrayerPersistenceSnapshot;
  committed: PrayerPersistenceSnapshot;
  publicActionObservation?: StreamingDuelPrayerObservationContext;
};

export type CompactedPrayerStateReceiptIdentity = Readonly<{
  playerId: string;
  requestFingerprint: string;
  transition: string;
  publicObservationOperationId: string | null;
}>;

export function assertCompactedPrayerStateReceiptMatches(
  receipt: CompactedPrayerStateReceiptIdentity,
  request: Readonly<{
    playerId: string;
    requestFingerprint: string;
    transition: PrayerStateTransitionKind;
    publicObservationOperationId: string | null;
  }>,
): void {
  if (
    receipt.playerId !== request.playerId ||
    receipt.requestFingerprint !== request.requestFingerprint ||
    receipt.transition !== request.transition ||
    receipt.publicObservationOperationId !==
      request.publicObservationOperationId
  ) {
    throw new Error("prayer_state_operation_id_conflict");
  }
}

export function normalizePrayerSnapshot(
  value: PrayerPersistenceSnapshot,
  errorPrefix: string,
): PrayerPersistenceSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error(`${errorPrefix}_state_invalid`);
  }
  const pointUnits = Number(value.pointUnits);
  const maxPoints = Number(value.maxPoints);
  if (
    !Number.isSafeInteger(maxPoints) ||
    maxPoints < 1 ||
    maxPoints > MAX_PRAYER_POINTS ||
    !Number.isSafeInteger(pointUnits) ||
    pointUnits < 0 ||
    pointUnits > maxPoints * PRAYER_POINT_UNITS_PER_POINT ||
    !Array.isArray(value.activePrayers) ||
    value.activePrayers.length > MAX_ACTIVE_PRAYERS
  ) {
    throw new Error(`${errorPrefix}_state_invalid`);
  }
  const activePrayers = value.activePrayers.map((raw) => {
    const prayerId = String(raw ?? "").trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(prayerId)) {
      throw new Error(`${errorPrefix}_state_invalid`);
    }
    return prayerId;
  });
  if (new Set(activePrayers).size !== activePrayers.length) {
    throw new Error(`${errorPrefix}_state_invalid`);
  }
  activePrayers.sort((left, right) => left.localeCompare(right));
  if (pointUnits === 0 && activePrayers.length > 0) {
    throw new Error(`${errorPrefix}_state_invalid`);
  }
  return { pointUnits, maxPoints, activePrayers };
}

export function prayerSnapshotsEqual(
  left: PrayerPersistenceSnapshot,
  right: PrayerPersistenceSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function prayerStateFingerprint(
  playerId: string,
  transition: PrayerStateTransitionKind,
  expected: PrayerPersistenceSnapshot,
  committed: PrayerPersistenceSnapshot,
  publicActionObservation?: StreamingDuelPrayerObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        transition,
        expected,
        committed,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

export function prayerPublicObservationMatchesTransition(
  context: StreamingDuelPrayerObservationContext,
  transition: PrayerStateTransitionKind,
  expected: PrayerPersistenceSnapshot,
  committed: PrayerPersistenceSnapshot,
): boolean {
  return (
    transition === "toggle" &&
    expected.activePrayers.includes(context.prayer) !==
      committed.activePrayers.includes(context.prayer)
  );
}

export function validatePrayerTransition(
  transition: PrayerStateTransitionKind,
  expected: PrayerPersistenceSnapshot,
  committed: PrayerPersistenceSnapshot,
): void {
  const sameMax = committed.maxPoints === expected.maxPoints;
  const sameUnits = committed.pointUnits === expected.pointUnits;
  const sameActive =
    JSON.stringify(committed.activePrayers) ===
    JSON.stringify(expected.activePrayers);
  let valid = false;
  switch (transition) {
    case "toggle":
      valid = sameMax && sameUnits && !sameActive;
      break;
    case "drain":
      valid =
        sameMax &&
        expected.activePrayers.length > 0 &&
        committed.pointUnits < expected.pointUnits &&
        (sameActive ||
          (committed.pointUnits === 0 && committed.activePrayers.length === 0));
      break;
    case "deactivate_all":
      valid =
        sameMax &&
        sameUnits &&
        expected.activePrayers.length > 0 &&
        committed.activePrayers.length === 0;
      break;
    case "restore":
      valid =
        sameMax && sameActive && committed.pointUnits > expected.pointUnits;
      break;
    case "set_max":
      valid =
        committed.maxPoints !== expected.maxPoints &&
        sameActive &&
        committed.pointUnits ===
          Math.min(
            expected.pointUnits,
            committed.maxPoints * PRAYER_POINT_UNITS_PER_POINT,
          );
      break;
    case "repair":
      valid =
        sameMax &&
        committed.pointUnits <= expected.pointUnits &&
        (!sameUnits || !sameActive) &&
        committed.activePrayers.every((id) =>
          expected.activePrayers.includes(id),
        );
      break;
  }
  if (!valid) throw new Error("prayer_state_transition_invalid");
}

/**
 * Parse and cryptographically re-derive a live v1 receipt before it is ever
 * reduced to its permanent replay identity. Compaction must fail closed on a
 * malformed or historically inconsistent row.
 */
export function parseStoredPrayerStateOperation(
  value: unknown,
  playerId: string,
  operationId: string,
): StoredPrayerStateOperation {
  if (
    !operationId ||
    operationId.length > 256 ||
    !playerId ||
    playerId.length > 128 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("prayer_receipt_compaction_state_invalid");
  }
  const state = value as Partial<StoredPrayerStateOperation>;
  const expectedKeys = [
    "committed",
    "expected",
    ...(state.publicActionObservation === undefined
      ? []
      : ["publicActionObservation"]),
    "requestFingerprint",
    "transition",
    "version",
  ].sort();
  const actualKeys = Object.keys(state).sort();
  const requestFingerprint = String(state.requestFingerprint ?? "").trim();
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key, index) => actualKeys[index] === key) ||
    state.version !== 1 ||
    !PRAYER_TRANSITIONS.has(state.transition as PrayerStateTransitionKind) ||
    !/^[a-f0-9]{64}$/.test(requestFingerprint)
  ) {
    throw new Error("prayer_receipt_compaction_state_invalid");
  }

  const transition = state.transition as PrayerStateTransitionKind;
  let expected: PrayerPersistenceSnapshot;
  let committed: PrayerPersistenceSnapshot;
  try {
    expected = normalizePrayerSnapshot(
      state.expected as PrayerPersistenceSnapshot,
      "prayer_receipt_compaction",
    );
    committed = normalizePrayerSnapshot(
      state.committed as PrayerPersistenceSnapshot,
      "prayer_receipt_compaction",
    );
    validatePrayerTransition(transition, expected, committed);
  } catch {
    throw new Error("prayer_receipt_compaction_state_invalid");
  }
  const publicActionObservation =
    state.publicActionObservation === undefined
      ? undefined
      : parseStreamingDuelPrayerObservationContext(
          state.publicActionObservation,
        );
  if (
    (state.publicActionObservation !== undefined &&
      (!publicActionObservation ||
        publicActionObservation.actorId !== playerId ||
        !prayerPublicObservationMatchesTransition(
          publicActionObservation,
          transition,
          expected,
          committed,
        ))) ||
    requestFingerprint !==
      prayerStateFingerprint(
        playerId,
        transition,
        expected,
        committed,
        publicActionObservation ?? undefined,
      )
  ) {
    throw new Error("prayer_receipt_compaction_state_invalid");
  }

  return {
    version: 1,
    requestFingerprint,
    transition,
    expected,
    committed,
    ...(publicActionObservation ? { publicActionObservation } : {}),
  };
}
