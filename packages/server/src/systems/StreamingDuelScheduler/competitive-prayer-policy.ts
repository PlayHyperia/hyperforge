import { prayerDataProvider } from "@hyperforge/shared";

import {
  COMPETITIVE_TACTICAL_PRAYERS,
  type CompetitiveTacticalPrayer,
} from "./competitive-tactical-strategy.js";

/**
 * Resolve Prayer actions from the runtime-authored manifest and the contestant's
 * frozen level. Missing manifest data fails closed instead of advertising or
 * executing a Prayer that the authoritative system will reject.
 */
export function getAvailablePrayerIdsForLevel(prayerLevel: number): string[] {
  if (
    !prayerDataProvider.hasPrayerManifest() ||
    !Number.isSafeInteger(prayerLevel) ||
    prayerLevel < 1
  ) {
    return [];
  }

  return prayerDataProvider
    .getAllPrayers()
    .filter((prayer) => prayer.level <= prayerLevel)
    .map((prayer) => prayer.id)
    .sort((left, right) => left.localeCompare(right));
}

export function getAvailableCompetitiveTacticalPrayerIds(
  prayerLevel: number,
): CompetitiveTacticalPrayer[] {
  const available = new Set(getAvailablePrayerIdsForLevel(prayerLevel));
  return COMPETITIVE_TACTICAL_PRAYERS.filter((prayerId) =>
    available.has(prayerId),
  );
}
