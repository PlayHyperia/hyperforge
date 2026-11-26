/** Minimum XP for a generated local diagnostic level, not a player XP grant.
 * Matches SkillsSystem.generateXPTable and durable damage's skillLevelForXp.
 * Keep per-level flooring: flooring only the final sum yields a different curve.
 */
export function sparbotSkillXpForLevel(level: number): number {
  if (!Number.isSafeInteger(level) || level < 1 || level > 99) {
    throw new Error(
      "Diagnostic sparbot skill level must be an integer from 1 to 99",
    );
  }
  let xp = 0;
  for (let current = 2; current <= level; current++) {
    const increment =
      Math.floor(current - 1 + 300 * Math.pow(2, (current - 1) / 7)) / 4;
    xp = Math.floor(xp + increment);
  }
  return xp;
}
