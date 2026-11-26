import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDuelEquipmentSwitchAuditManifest } from "./duel-equipment-switch-audit.mjs";

function validManifest() {
  return {
    schemaVersion: 1,
    title: "Atomic equipment audit",
    avatar: "avatar.vrm",
    equipment: {
      weapon: { asset: "kit/sword.glb", itemId: "sword", slot: "weapon" },
      shield: { asset: "kit/shield.glb", itemId: "shield", slot: "shield" },
      hatchet: {
        asset: "kit/hatchet.glb",
        itemId: "hatchet",
        slot: "gatheringtool",
      },
      pickaxe: {
        asset: "kit/pickaxe.glb",
        itemId: "pickaxe",
        slot: "gatheringtool",
      },
    },
    rapidSwitchIterations: 60,
  };
}

function validActiveManifest() {
  const manifest = validManifest();
  manifest.schemaVersion = 2;
  manifest.avatarId = "steve";
  manifest.pose = "emotes/idle.glb";
  delete manifest.equipment.shield;
  return manifest;
}

test("accepts the exact bounded switching-audit schema", () => {
  const manifest = validManifest();
  assert.equal(validateDuelEquipmentSwitchAuditManifest(manifest), manifest);
});

test("accepts an exact active-avatar schema without inventing a shield", () => {
  const manifest = validActiveManifest();
  assert.equal(validateDuelEquipmentSwitchAuditManifest(manifest), manifest);

  const explicitShield = validActiveManifest();
  explicitShield.equipment.shield = {
    asset: "kit/shield.glb",
    itemId: "shield",
    slot: "shield",
  };
  assert.equal(
    validateDuelEquipmentSwitchAuditManifest(explicitShield),
    explicitShield,
  );
});

test("rejects traversal, extra authority, and unbounded iteration counts", () => {
  const traversal = validManifest();
  traversal.avatar = "../avatar.vrm";
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(traversal));

  const extra = { ...validManifest(), canonical: true };
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(extra));

  const unbounded = validManifest();
  unbounded.rapidSwitchIterations = 501;
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(unbounded));

  const missingAvatarAuthority = validActiveManifest();
  delete missingAvatarAuthority.avatarId;
  assert.throws(() =>
    validateDuelEquipmentSwitchAuditManifest(missingAvatarAuthority),
  );
});

test("rejects wrong slots and duplicate item or asset identities", () => {
  const wrongSlot = validManifest();
  wrongSlot.equipment.hatchet.slot = "weapon";
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(wrongSlot));

  const duplicateItem = validManifest();
  duplicateItem.equipment.pickaxe.itemId = "hatchet";
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(duplicateItem));

  const duplicateAsset = validManifest();
  duplicateAsset.equipment.pickaxe.asset = "kit/hatchet.glb";
  assert.throws(() => validateDuelEquipmentSwitchAuditManifest(duplicateAsset));
});
