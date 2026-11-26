export const GENERIC_PLAYER_UPDATE_PROTECTED_PRAYER_FIELDS = [
  "prayerLevel",
  "prayerXp",
  "prayerPoints",
  "prayerPointUnits",
  "prayerMaxPoints",
  "activePrayers",
] as const;

export const GENERIC_PLAYER_UPDATE_PROTECTED_ATTACK_STYLE_FIELDS = [
  "attackStyle",
] as const;

/**
 * Prayer progression and resource custody are atomic, receipt-backed state.
 * Generic player saves must never overwrite either from a stale snapshot.
 */
export function assertGenericPlayerUpdateExcludesPrayerAuthority(
  data: object,
  boundary: string,
): void {
  const forbidden = GENERIC_PLAYER_UPDATE_PROTECTED_PRAYER_FIELDS.filter(
    (field) => Object.prototype.hasOwnProperty.call(data, field),
  );
  if (forbidden.length === 0) return;

  throw new Error(
    `generic_player_update_prayer_custody_forbidden:${boundary}:${forbidden.join(",")}`,
  );
}

/**
 * Attack style is an atomic, weapon-validated preference. A generic snapshot
 * must not overwrite a newer style operation after its receipt commits.
 */
export function assertGenericPlayerUpdateExcludesAttackStyleAuthority(
  data: object,
  boundary: string,
): void {
  const forbidden = GENERIC_PLAYER_UPDATE_PROTECTED_ATTACK_STYLE_FIELDS.filter(
    (field) => Object.prototype.hasOwnProperty.call(data, field),
  );
  if (forbidden.length === 0) return;

  throw new Error(
    `generic_player_update_attack_style_custody_forbidden:${boundary}:${forbidden.join(",")}`,
  );
}
