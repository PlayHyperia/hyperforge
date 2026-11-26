import {
  STREAMING_DUEL_TIMEOUT_POLICY,
  STREAMING_DUEL_TIMING_CONTRACT_VERSION,
} from "../competitive-timing-policy.js";
import type { CompetitiveSnapshotTimingInput } from "../competitive-snapshot.js";

/** Explicit sporting clock for snapshot/unit fixtures; never a production value. */
export const COMPETITIVE_SNAPSHOT_TIMING_FIXTURE = Object.freeze({
  contractVersion: STREAMING_DUEL_TIMING_CONTRACT_VERSION,
  timeoutPolicy: STREAMING_DUEL_TIMEOUT_POLICY,
  countdownDurationMs: 4_000,
  fightingDurationMs: 30_000,
  endWarningDurationMs: 5_000,
  maxFightDurationMs: 35_000,
}) satisfies CompetitiveSnapshotTimingInput;
