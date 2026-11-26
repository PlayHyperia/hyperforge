import type {
  AgentInfo,
  StreamingCombatRole,
} from "../../screens/StreamingMode";

const STREAMING_COMBAT_ROLES = ["melee", "ranged", "mage"] as const;

export function formatStreamingCombatRole(role: StreamingCombatRole): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

/**
 * Resolve the currently equipped role only from the frozen public duel
 * snapshot. Ambiguous, incomplete, or unfrozen payloads intentionally return
 * null instead of presenting a speculative style to viewers.
 */
export function resolveActiveStreamingCombatRole(
  agent: AgentInfo | null | undefined,
): StreamingCombatRole | null {
  if (!agent || agent.loadoutFrozen !== true) return null;

  const weaponId = agent.equipment?.weapon;
  if (typeof weaponId !== "string" || weaponId.trim().length === 0) {
    return null;
  }

  const allowedRoles = new Set(agent.availableCombatStyles ?? []);
  const matches = STREAMING_COMBAT_ROLES.filter((role) => {
    if (!allowedRoles.has(role)) return false;
    const loadout = agent.combatLoadouts?.[role];
    return (
      loadout?.role === role &&
      typeof loadout.weaponId === "string" &&
      loadout.weaponId === weaponId
    );
  });

  return matches.length === 1 ? matches[0] : null;
}
