import type { EmbeddedAgentConfig } from "./types.js";

export const ORDINARY_COMBAT_SPECIALIZATIONS = [
  "melee",
  "ranged",
  "mage",
] as const;

export type OrdinaryCombatSpecialization =
  (typeof ORDINARY_COMBAT_SPECIALIZATIONS)[number];

/**
 * A full ranged readiness reserve must outlast the launch food reserve. Live
 * joined-duel evidence exhausted 50 arrows per contestant with both fighters
 * still alive after all food was consumed; 100 preserves a bounded second
 * combat reserve without requiring private-bank access after the market opens.
 */
export const ORDINARY_COMBAT_AMMUNITION_TARGET = 100;
export const ORDINARY_COMBAT_MAGIC_CAST_TARGET = 20;

const SPECIALIZATIONS = new Set<string>(ORDINARY_COMBAT_SPECIALIZATIONS);

function normalizeSpecialization(
  value: unknown,
): OrdinaryCombatSpecialization | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return SPECIALIZATIONS.has(normalized)
    ? (normalized as OrdinaryCombatSpecialization)
    : null;
}

/**
 * Resolve one stable preparation identity without relying on process-random
 * state. Explicit agent configuration wins; character-profile settings allow
 * the same identity to live with an ElizaOS profile; otherwise FNV-1a spreads
 * ordinary agents across all authored combat styles deterministically.
 */
export function resolveOrdinaryCombatSpecialization(
  config: Pick<
    EmbeddedAgentConfig,
    "characterId" | "combatSpecialization" | "characterConfig"
  >,
): OrdinaryCombatSpecialization {
  const explicit = normalizeSpecialization(config.combatSpecialization);
  if (explicit) return explicit;

  const profile = normalizeSpecialization(
    config.characterConfig?.settings?.combatSpecialization,
  );
  if (profile) return profile;

  let hash = 0x811c9dc5;
  for (let index = 0; index < config.characterId.length; index += 1) {
    hash ^= config.characterId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ORDINARY_COMBAT_SPECIALIZATIONS[
    hash % ORDINARY_COMBAT_SPECIALIZATIONS.length
  ];
}
