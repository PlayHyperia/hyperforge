const COMPETITIVE_ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;

export type CompetitiveRigidEquipmentSlot = "weapon" | "shield";

export interface CompetitiveRigidEquipmentMetadata {
  version: 2;
  vrmBoneName: "leftHand" | "rightHand";
  relativeMatrix: number[];
  originalSlot: CompetitiveRigidEquipmentSlot;
  avatarId: string;
  avatarHeight: number;
  weaponType: string;
  exportedFrom: "asset-forge-equipment-fitting-v2";
  exportedAt: string;
  duelFit: {
    schemaVersion: 1;
    itemId: string;
    slot: CompetitiveRigidEquipmentSlot;
    compatibleAvatarIds: string[];
  };
}

export function getCompetitiveRigidEquipmentSlot(
  weaponType: string | undefined,
): CompetitiveRigidEquipmentSlot {
  return weaponType?.toLowerCase() === "shield" ? "shield" : "weapon";
}

export function createCompetitiveRigidEquipmentMetadata(options: {
  itemId: string;
  avatarId: string;
  slot: CompetitiveRigidEquipmentSlot;
  vrmBoneName: string;
  relativeMatrix: number[];
  avatarHeight: number;
  weaponType: string;
}): CompetitiveRigidEquipmentMetadata {
  if (
    options.itemId !== options.itemId.trim() ||
    !COMPETITIVE_ASSET_ID_PATTERN.test(options.itemId) ||
    options.avatarId !== options.avatarId.trim() ||
    !COMPETITIVE_ASSET_ID_PATTERN.test(options.avatarId)
  ) {
    throw new Error("Competitive item and avatar IDs must be canonical");
  }
  const allowedBones =
    options.slot === "shield"
      ? new Set(["leftHand"])
      : new Set(["leftHand", "rightHand"]);
  if (!allowedBones.has(options.vrmBoneName)) {
    throw new Error(
      `${options.slot} cannot be certified on ${options.vrmBoneName}`,
    );
  }
  if (
    options.relativeMatrix.length !== 16 ||
    options.relativeMatrix.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      "Competitive attachment matrix must contain 16 finite values",
    );
  }
  if (!Number.isFinite(options.avatarHeight) || options.avatarHeight <= 0) {
    throw new Error(
      "Competitive avatar height must be a positive finite value",
    );
  }

  return {
    version: 2,
    vrmBoneName: options.vrmBoneName as "leftHand" | "rightHand",
    relativeMatrix: [...options.relativeMatrix],
    originalSlot: options.slot,
    avatarId: options.avatarId,
    avatarHeight: options.avatarHeight,
    weaponType: options.weaponType,
    exportedFrom: "asset-forge-equipment-fitting-v2",
    exportedAt: new Date().toISOString(),
    duelFit: {
      schemaVersion: 1,
      itemId: options.itemId,
      slot: options.slot,
      compatibleAvatarIds: [options.avatarId],
    },
  };
}
