/**
 * Versioned sporting-clock identity shared by runtime timing and the immutable
 * pre-bet competitive snapshot. Values live here to avoid a runtime import
 * cycle between scheduler types and snapshot validation.
 */
export const STREAMING_DUEL_TIMING_CONTRACT_VERSION = 2 as const;

export const STREAMING_DUEL_TIMEOUT_POLICY =
  "hp_percentage_then_damage_then_draw_v1" as const;

export type StreamingDuelTimingContractVersion =
  typeof STREAMING_DUEL_TIMING_CONTRACT_VERSION;

export type StreamingDuelTimeoutPolicy = typeof STREAMING_DUEL_TIMEOUT_POLICY;
