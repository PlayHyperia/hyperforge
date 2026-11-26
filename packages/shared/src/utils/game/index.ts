/**
 * Game logic utilities
 * Combat, entity, component helpers
 */

// Export all from CombatCalculations except calculateDistance* (re-exported from MathUtils)
export {
  type CombatStats,
  type HitCalculationResult,
  type CombatStyle,
  type StyleBonus,
  getStyleBonus,
  calculateDamage,
  isInAttackRange,
  calculateDistance3D,
  isAttackOnCooldownTicks,
  shouldCombatTimeoutTicks,
  ticksToMs,
  msToTicks,
} from "./CombatCalculations";

export * from "./CombatUtils";
export * from "./CombatValidation";
export * from "./HitDelayCalculator";

// Export all from EntityUtils except calculateDistance* (to avoid duplicates)
export {
  getEntity,
  getComponent,
  getEntityWithComponent,
  getEntitiesInRange,
  getPlayer,
  groundToTerrain,
} from "./EntityUtils";

export * from "./ComponentUtils";
export * from "./ProcessingFireExtinguishRegistration";
export * from "./AmmunitionShotRegistration";

// Combat level calculation (rules-accurate)
export * from "./CombatLevelCalculator";
