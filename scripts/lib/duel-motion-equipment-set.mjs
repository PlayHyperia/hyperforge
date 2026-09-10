const SAFE_ID = /^[a-zA-Z0-9_-]+$/u;
const SAFE_ASSET_PATH = /^[a-zA-Z0-9._/-]+$/u;
const ROOT_KEYS = new Set(["schemaVersion", "title", "equipments"]);
const EQUIPMENT_KEYS = new Set(["asset", "itemId", "avatarId", "slot", "grip"]);

function assertExactKeys(value, allowedKeys, label) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown fields: ${unknownKeys.join(", ")}`);
  }
}

function validateAssetPath(asset, index) {
  if (
    typeof asset !== "string" ||
    asset.length === 0 ||
    asset.startsWith("/") ||
    asset.includes("\\") ||
    !SAFE_ASSET_PATH.test(asset) ||
    asset
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Equipment-set entry ${index} asset must be a safe relative asset path`,
    );
  }
}

export function validateDuelMotionEquipmentSetManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Equipment-set manifest must be an object");
  }
  assertExactKeys(manifest, ROOT_KEYS, "Equipment-set manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("Equipment-set manifest must use schemaVersion 1");
  }
  if (
    manifest.title !== undefined &&
    (typeof manifest.title !== "string" || manifest.title.trim().length === 0)
  ) {
    throw new Error("Equipment-set title must be a non-empty string");
  }
  if (
    !Array.isArray(manifest.equipments) ||
    manifest.equipments.length === 0 ||
    manifest.equipments.length > 10
  ) {
    throw new Error("Equipment-set manifest must contain 1-10 equipments");
  }

  const itemIds = new Set();
  const slots = new Set();
  const equipments = manifest.equipments.map((equipment, index) => {
    if (
      !equipment ||
      typeof equipment !== "object" ||
      Array.isArray(equipment)
    ) {
      throw new Error(`Equipment-set entry ${index} must be an object`);
    }
    assertExactKeys(equipment, EQUIPMENT_KEYS, `Equipment-set entry ${index}`);
    validateAssetPath(equipment.asset, index);
    if (
      typeof equipment.itemId !== "string" ||
      !SAFE_ID.test(equipment.itemId)
    ) {
      throw new Error(`Equipment-set entry ${index} has an invalid itemId`);
    }
    if (
      typeof equipment.avatarId !== "string" ||
      !SAFE_ID.test(equipment.avatarId)
    ) {
      throw new Error(`Equipment-set entry ${index} has an invalid avatarId`);
    }
    if (
      equipment.slot !== "weapon" &&
      equipment.slot !== "shield" &&
      equipment.slot !== "gatheringtool"
    ) {
      throw new Error(`Equipment-set entry ${index} has an invalid slot`);
    }
    if (equipment.grip !== "one-hand" && equipment.grip !== "two-hand") {
      throw new Error(`Equipment-set entry ${index} has an invalid grip`);
    }
    if (equipment.slot === "shield" && equipment.grip !== "one-hand") {
      throw new Error("A shield equipment-set entry must use a one-hand grip");
    }
    if (itemIds.has(equipment.itemId)) {
      throw new Error(`Duplicate equipment-set itemId: ${equipment.itemId}`);
    }
    if (slots.has(equipment.slot)) {
      throw new Error(`Duplicate equipment-set slot: ${equipment.slot}`);
    }
    itemIds.add(equipment.itemId);
    slots.add(equipment.slot);
    return {
      asset: equipment.asset,
      itemId: equipment.itemId,
      avatarId: equipment.avatarId,
      slot: equipment.slot,
      grip: equipment.grip,
    };
  });

  const weapon = equipments.find((equipment) => equipment.slot === "weapon");
  if (slots.has("shield") && weapon?.grip === "two-hand") {
    throw new Error("A two-hand weapon cannot be audited with a shield");
  }
  const avatarIds = new Set(equipments.map((equipment) => equipment.avatarId));
  if (avatarIds.size !== 1) {
    throw new Error("Every equipment-set entry must target the same avatarId");
  }

  return {
    schemaVersion: 1,
    ...(manifest.title ? { title: manifest.title.trim() } : {}),
    equipments,
  };
}
