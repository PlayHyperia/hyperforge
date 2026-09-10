import { Emotes } from "./playerEmotes";

export type StreamingDuelPresentationData = Readonly<{
  inStreamingDuel?: unknown;
  streamingDuelCombatRole?: unknown;
  streamingDuelWeaponId?: unknown;
  [key: string]: unknown;
}>;

const STREAMING_DUEL_ONE_HAND_GUARD_WEAPON_IDS = new Set([
  "bronze_shortsword",
  "bronze_longsword",
  "bronze_scimitar",
]);

const STREAMING_DUEL_BOW_GUARD_WEAPON_IDS = new Set([
  "shortbow",
  "magic_shortbow",
]);

const STREAMING_DUEL_TWO_HAND_GUARD_WEAPON_IDS = new Set(["bronze_2h_sword"]);

/**
 * Resolve only fitted duel locomotion clips. Attacks, death, victory,
 * gathering, and ordinary world locomotion remain under their existing
 * authoritative emote mapping.
 */
export function resolveStreamingDuelLocomotionEmote(
  serverEmote: string | undefined,
  data: StreamingDuelPresentationData,
): string | null {
  if (
    data.inStreamingDuel !== true ||
    typeof data.streamingDuelWeaponId !== "string"
  ) {
    return null;
  }
  const isOneHandMelee =
    data.streamingDuelCombatRole === "melee" &&
    STREAMING_DUEL_ONE_HAND_GUARD_WEAPON_IDS.has(data.streamingDuelWeaponId);
  const isRangedBow =
    data.streamingDuelCombatRole === "ranged" &&
    STREAMING_DUEL_BOW_GUARD_WEAPON_IDS.has(data.streamingDuelWeaponId);
  const isTwoHandMelee =
    data.streamingDuelCombatRole === "melee" &&
    STREAMING_DUEL_TWO_HAND_GUARD_WEAPON_IDS.has(data.streamingDuelWeaponId);
  if (!isOneHandMelee && !isRangedBow && !isTwoHandMelee) return null;
  switch (serverEmote) {
    case "idle":
    case "2h_idle":
      if (isTwoHandMelee) return Emotes.TWO_HAND_DUEL_IDLE;
      if (serverEmote === "2h_idle") return null;
      return isRangedBow ? Emotes.BOW_DUEL_IDLE : Emotes.ONE_HAND_DUEL_IDLE;
    case "walk":
      if (isTwoHandMelee) return Emotes.TWO_HAND_DUEL_WALK;
      return isRangedBow ? Emotes.BOW_DUEL_WALK : Emotes.ONE_HAND_DUEL_WALK;
    case "run":
      if (isTwoHandMelee) return Emotes.TWO_HAND_DUEL_RUN;
      return isRangedBow ? Emotes.BOW_DUEL_RUN : Emotes.ONE_HAND_DUEL_RUN;
    default:
      return null;
  }
}

/** Resolve only certified streamed-duel attacks without changing world combat. */
export function resolveStreamingDuelAttackEmote(
  serverEmote: string | undefined,
  data: StreamingDuelPresentationData,
): string | null {
  return data.inStreamingDuel === true &&
    data.streamingDuelCombatRole === "melee" &&
    data.streamingDuelWeaponId === "bronze_2h_sword" &&
    serverEmote === "2h_slash"
    ? Emotes.TWO_HAND_DUEL_SLASH
    : null;
}
