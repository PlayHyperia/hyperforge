/**
 * Arena ownership shared by the ordinary duel system and streaming scheduler.
 *
 * The streaming scheduler deliberately keeps one stable arena so cameras,
 * spectators, and recovery always agree on the authoritative combat space.
 * Reserve that arena for the lifetime of a streaming-enabled server process so
 * a normal duel can never be allocated into the live broadcast.
 */
export const STREAMING_DUEL_ARENA_ID = 1;

export const STREAMING_DUEL_ARENA_RESERVATION_ID =
  "__streaming_duel_scheduler__";
