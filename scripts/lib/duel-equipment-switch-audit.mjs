const ITEM_ID_PATTERN = /^[a-z0-9_]+$/u;
const SAFE_ASSET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u;
const ROOT_KEYS_V1 = Object.freeze([
  "avatar",
  "equipment",
  "rapidSwitchIterations",
  "schemaVersion",
  "title",
]);
const ROOT_KEYS_V2 = Object.freeze([...ROOT_KEYS_V1, "avatarId", "pose"]);
const EQUIPMENT_SLOTS = Object.freeze({
  weapon: "weapon",
  shield: "shield",
  hatchet: "gatheringtool",
  pickaxe: "gatheringtool",
});
const DEFINITION_KEYS = Object.freeze(["asset", "itemId", "slot"]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function safeAssetPath(value) {
  return (
    typeof value === "string" &&
    SAFE_ASSET_PATTERN.test(value) &&
    !value.startsWith("/") &&
    !value.includes("//") &&
    !value
      .split("/")
      .some((component) => component === "." || component === "..")
  );
}

export function validateDuelEquipmentSwitchAuditManifest(input) {
  const schemaVersion = input?.schemaVersion;
  const rootKeys = schemaVersion === 2 ? ROOT_KEYS_V2 : ROOT_KEYS_V1;
  const requiredEquipmentKeys = ["weapon", "hatchet", "pickaxe"];
  const equipmentKeys = isRecord(input?.equipment)
    ? Object.keys(input.equipment)
    : [];
  const validEquipmentShape =
    schemaVersion === 1
      ? exactKeys(input.equipment, Object.keys(EQUIPMENT_SLOTS))
      : schemaVersion === 2 &&
        (exactKeys(input.equipment, requiredEquipmentKeys) ||
          exactKeys(input.equipment, [...requiredEquipmentKeys, "shield"]));
  if (
    !exactKeys(input, rootKeys) ||
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    typeof input.title !== "string" ||
    input.title.trim() !== input.title ||
    !input.title ||
    !safeAssetPath(input.avatar) ||
    (schemaVersion === 2 && !safeAssetPath(input.pose)) ||
    (schemaVersion === 2 &&
      (typeof input.avatarId !== "string" ||
        !ITEM_ID_PATTERN.test(input.avatarId))) ||
    !validEquipmentShape ||
    !Number.isInteger(input.rapidSwitchIterations) ||
    input.rapidSwitchIterations < 20 ||
    input.rapidSwitchIterations > 500
  ) {
    throw new Error("Invalid equipment-switch audit manifest");
  }

  const itemIds = new Set();
  const assets = new Set([input.avatar]);
  for (const key of equipmentKeys) {
    const expectedSlot = EQUIPMENT_SLOTS[key];
    const definition = input.equipment[key];
    if (
      !exactKeys(definition, DEFINITION_KEYS) ||
      !safeAssetPath(definition.asset) ||
      typeof definition.itemId !== "string" ||
      !ITEM_ID_PATTERN.test(definition.itemId) ||
      definition.slot !== expectedSlot ||
      itemIds.has(definition.itemId) ||
      assets.has(definition.asset)
    ) {
      throw new Error(`Invalid equipment-switch definition: ${key}`);
    }
    itemIds.add(definition.itemId);
    assets.add(definition.asset);
  }
  return input;
}
