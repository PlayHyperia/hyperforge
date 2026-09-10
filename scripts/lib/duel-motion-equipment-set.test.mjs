import assert from "node:assert/strict";
import test from "node:test";

import { validateDuelMotionEquipmentSetManifest } from "./duel-motion-equipment-set.mjs";

const validManifest = {
  schemaVersion: 1,
  title: "Supported sword and shield loadout",
  equipments: [
    {
      asset: "fitted-role-kit/sword.glb",
      itemId: "sword",
      avatarId: "duelist",
      slot: "weapon",
      grip: "one-hand",
    },
    {
      asset: "fitted-role-kit/shield.glb",
      itemId: "shield",
      avatarId: "duelist",
      slot: "shield",
      grip: "one-hand",
    },
  ],
};

test("accepts and copies one item per compatible production slot", () => {
  const result = validateDuelMotionEquipmentSetManifest(validManifest);
  assert.deepEqual(result, validManifest);
  assert.notEqual(result.equipments, validManifest.equipments);
});

test("accepts an isolated transient gathering-tool certificate", () => {
  const result = validateDuelMotionEquipmentSetManifest({
    schemaVersion: 1,
    equipments: [
      {
        asset: "tools/bronze-pickaxe.glb",
        itemId: "bronze_pickaxe",
        avatarId: "kaykit-knight",
        slot: "gatheringtool",
        grip: "one-hand",
      },
    ],
  });
  assert.deepEqual(result.equipments, [
    {
      asset: "tools/bronze-pickaxe.glb",
      itemId: "bronze_pickaxe",
      avatarId: "kaykit-knight",
      slot: "gatheringtool",
      grip: "one-hand",
    },
  ]);
});

test("rejects unknown fields, unsafe paths, duplicate slots, and mixed avatars", () => {
  assert.throws(
    () =>
      validateDuelMotionEquipmentSetManifest({
        ...validManifest,
        unsupported: true,
      }),
    /unknown fields/u,
  );
  assert.throws(
    () =>
      validateDuelMotionEquipmentSetManifest({
        ...validManifest,
        equipments: [
          { ...validManifest.equipments[0], asset: "../outside.glb" },
        ],
      }),
    /safe relative asset path/u,
  );
  assert.throws(
    () =>
      validateDuelMotionEquipmentSetManifest({
        ...validManifest,
        equipments: [
          validManifest.equipments[0],
          {
            ...validManifest.equipments[1],
            itemId: "second_weapon",
            slot: "weapon",
          },
        ],
      }),
    /Duplicate equipment-set slot/u,
  );
  assert.throws(
    () =>
      validateDuelMotionEquipmentSetManifest({
        ...validManifest,
        equipments: [
          validManifest.equipments[0],
          { ...validManifest.equipments[1], avatarId: "other_duelist" },
        ],
      }),
    /same avatarId/u,
  );
});

test("rejects a shield beside a two-hand weapon", () => {
  assert.throws(
    () =>
      validateDuelMotionEquipmentSetManifest({
        ...validManifest,
        equipments: [
          { ...validManifest.equipments[0], grip: "two-hand" },
          validManifest.equipments[1],
        ],
      }),
    /two-hand weapon cannot be audited with a shield/u,
  );
});
