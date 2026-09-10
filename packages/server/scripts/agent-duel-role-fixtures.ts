import { AttackType } from "@hyperforge/shared";

export type AgentDuelCombatRole = "melee" | "ranged" | "mage";

export type AgentDuelRoleFixture = {
  role: AgentDuelCombatRole;
  weaponId: "bronze_longsword" | "shortbow" | "staff_of_air";
  prayerId: "superhuman_strength" | "hawk_eye" | "mystic_lore";
  attackType: AttackType;
  magicLevel: number;
  selectedSpellId: "fire_strike" | null;
  inventorySupplies: readonly {
    itemId: "fire_rune" | "mind_rune";
    quantity: number;
  }[];
  projectileInventoryCost: readonly {
    itemId: "fire_rune" | "mind_rune";
    quantity: number;
  }[];
  equippedAmmunition: {
    itemId: "bronze_arrow";
    quantity: number;
  } | null;
};

export const AGENT_DUEL_ROLE_FIXTURES: Record<
  AgentDuelCombatRole,
  AgentDuelRoleFixture
> = {
  melee: {
    role: "melee",
    weaponId: "bronze_longsword",
    prayerId: "superhuman_strength",
    attackType: AttackType.MELEE,
    magicLevel: 1,
    selectedSpellId: null,
    inventorySupplies: [],
    projectileInventoryCost: [],
    equippedAmmunition: null,
  },
  ranged: {
    role: "ranged",
    weaponId: "shortbow",
    prayerId: "hawk_eye",
    attackType: AttackType.RANGED,
    magicLevel: 1,
    selectedSpellId: null,
    inventorySupplies: [],
    projectileInventoryCost: [],
    // Seed more than one full-duration reserve so the preparation planner must
    // freeze its derived target and leave the conserved excess in the bank.
    equippedAmmunition: { itemId: "bronze_arrow", quantity: 500 },
  },
  mage: {
    role: "mage",
    weaponId: "staff_of_air",
    prayerId: "mystic_lore",
    attackType: AttackType.MAGIC,
    magicLevel: 40,
    selectedSpellId: "fire_strike",
    inventorySupplies: [
      // Match the scheduler's existing bounded projectile-supply provision so
      // this full-duration gate cannot deadlock after only twenty casts.
      { itemId: "fire_rune", quantity: 500 },
      { itemId: "mind_rune", quantity: 500 },
    ],
    projectileInventoryCost: [
      { itemId: "fire_rune", quantity: 3 },
      { itemId: "mind_rune", quantity: 1 },
    ],
    equippedAmmunition: null,
  },
};

// The full-topology multi-style fixture deliberately starts ranged and keeps
// the two alternative weapons plus magic supplies in private bank custody.
// This preserves the ordinary-play opening state while forcing the real
// preparation planner to assemble every available role without creating gear.
export const AGENT_DUEL_MULTI_STYLE_BANK_ITEMS = [
  {
    itemId: AGENT_DUEL_ROLE_FIXTURES.melee.weaponId,
    quantity: 1,
  },
  {
    itemId: AGENT_DUEL_ROLE_FIXTURES.mage.weaponId,
    quantity: 1,
  },
  ...AGENT_DUEL_ROLE_FIXTURES.mage.inventorySupplies,
] as const;

export function readAgentDuel3dE2eMultiStyle(
  value = process.env.AGENT_DUEL_3D_E2E_MULTI_STYLE,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined) return false;
  if (normalized !== "true" && normalized !== "false") {
    throw new Error("AGENT_DUEL_3D_E2E_MULTI_STYLE must be true or false");
  }
  return normalized === "true";
}

export function readAgentDuelCombatRole(
  value = process.env.AGENT_DUEL_CYCLE_CHAOS_ROLE,
): AgentDuelCombatRole {
  const normalized = value?.trim() || "ranged";
  if (
    normalized === "melee" ||
    normalized === "ranged" ||
    normalized === "mage"
  ) {
    return normalized;
  }
  throw new Error("AGENT_DUEL_CYCLE_CHAOS_ROLE must be melee, ranged, or mage");
}

export const AGENT_DUEL_COMBAT_ROLE = readAgentDuelCombatRole();
export const AGENT_DUEL_ROLE_FIXTURE =
  AGENT_DUEL_ROLE_FIXTURES[AGENT_DUEL_COMBAT_ROLE];
