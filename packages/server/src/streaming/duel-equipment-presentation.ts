/**
 * Server-side authority for equipment that may appear in a public duel.
 *
 * Every visible item listed here has a frozen canonical-avatar GLB
 * certification in scripts/duel-rigid-equipment-certifications.json. The
 * renderer still validates the GLB metadata and skeleton at runtime; this
 * earlier gate prevents an unsupported loadout from reaching market open.
 */
export const STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT = Object.freeze({
  weapon: Object.freeze([
    "bronze_shortsword",
    "bronze_longsword",
    "bronze_scimitar",
    "shortbow",
    "magic_shortbow",
    "staff_of_air",
  ] as const),
  shield: Object.freeze([] as const),
  helmet: Object.freeze([] as const),
  body: Object.freeze([] as const),
  legs: Object.freeze([] as const),
  boots: Object.freeze([] as const),
  gloves: Object.freeze([] as const),
  cape: Object.freeze([] as const),
});

export type StreamingDuelVisibleEquipmentSlot =
  keyof typeof STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT;

/**
 * Ammunition has an authoritative projectile renderer. Jewellery is disclosed
 * in the public loadout but intentionally below the broadcast mesh contract.
 */
const STREAMING_DUEL_NON_MESH_EQUIPMENT_SLOTS = new Set([
  "arrows",
  "amulet",
  "ring",
]);

const STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS = new Map<string, Set<string>>(
  Object.entries(STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT).map(
    ([slot, itemIds]) => [slot, new Set<string>(itemIds)],
  ),
);

export function isStreamingDuelEquipmentPresentationEligible(
  itemId: unknown,
  slot: unknown,
): boolean {
  if (typeof itemId !== "string" || itemId.trim() !== itemId || !itemId) {
    return false;
  }
  if (typeof slot !== "string" || slot.trim() !== slot || !slot) {
    return false;
  }
  const normalizedSlot = slot.toLowerCase();
  if (STREAMING_DUEL_NON_MESH_EQUIPMENT_SLOTS.has(normalizedSlot)) return true;
  return Boolean(
    STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS.get(normalizedSlot)?.has(itemId),
  );
}

export function isStreamingDuelWeaponPresentationEligible(
  itemId: unknown,
): boolean {
  return isStreamingDuelEquipmentPresentationEligible(itemId, "weapon");
}
