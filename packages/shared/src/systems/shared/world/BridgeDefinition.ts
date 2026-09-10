/**
 * BridgeDefinition — data for bridge placements.
 *
 * Each bridge specifies start/end positions and style. The BridgeSystem
 * computes deck height from terrain + arch curve and generates collision.
 *
 * Devs assign exact start/end positions — no automatic river snapping.
 */

export type BridgeStyle = "stone" | "wood";

export interface BridgeDefinition {
  id: string;
  /** Start position (one bank) */
  startX: number;
  startZ: number;
  /** End position (other bank) */
  endX: number;
  endZ: number;
  /** Bridge deck width (meters) */
  width: number;
  /** Railing height above deck (meters) */
  railingHeight: number;
  /** Arch height above straight line between endpoints (meters, 0 = flat) */
  archHeight: number;
  /** Visual style */
  style: BridgeStyle;
}

/**
 * The compact island currently has no authored bridge placements.
 * Future placements must fit the admitted terrain profile.
 */
export const ISLAND_BRIDGES: BridgeDefinition[] = [];
