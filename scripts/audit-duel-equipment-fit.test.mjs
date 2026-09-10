import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditDuelEquipmentFit,
  launchMinimumCertificationsFromManifest,
} from "./audit-duel-equipment-fit.mjs";
import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function createGlb(avatarId) {
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "EquipmentWrapper",
        children: [1],
        extras: {
          hyperia: {
            version: 2,
            vrmBoneName: "rightHand",
            relativeMatrix: MATRIX,
            avatarId,
          },
        },
      },
      { name: "EquipmentContent" },
    ],
    buffers: [{ byteLength: 4 }],
  };
  const encoded = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(json);
  const binary = Buffer.from([1, 2, 3, 4]);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  json.copy(output, 20);
  const binaryOffset = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryOffset);
  output.writeUInt32LE(BIN_CHUNK_TYPE, binaryOffset + 4);
  binary.copy(output, binaryOffset + 8);
  return output;
}

function createFixture() {
  const assetsRoot = mkdtempSync(path.join(tmpdir(), "hyperia-fit-audit-"));
  const manifests = path.join(assetsRoot, "manifests", "items");
  const models = path.join(assetsRoot, "models");
  mkdirSync(manifests, { recursive: true });
  mkdirSync(models, { recursive: true });

  const certified = certifyRigidDuelEquipmentGlb(
    createGlb("/api/assets/steve/model"),
    {
      itemId: "bronze_shortsword",
      avatarId: "steve",
      legacyAvatarId: "/api/assets/steve/model",
      slot: "weapon",
      gripContact: {
        schemaVersion: 1,
        contentNodeName: "EquipmentContent",
        sourceAxis: [0, 1, 0],
        actionEnd: "minimum",
        zones: [
          {
            id: "primary",
            boneName: "rightHand",
            minimumSourceProjection: 0.55,
            maximumSourceProjection: 0.95,
          },
        ],
      },
    },
  ).output;
  const certifiedSha256 = createHash("sha256").update(certified).digest("hex");
  writeFileSync(path.join(models, "shortsword.glb"), certified);
  writeFileSync(
    path.join(models, "shared-bow.glb"),
    createGlb("/api/assets/avatar-male-01/model"),
  );
  writeFileSync(
    path.join(manifests, "weapons.json"),
    JSON.stringify([
      {
        id: "bronze_shortsword",
        name: "Bronze Shortsword",
        type: "weapon",
        equipSlot: "weapon",
        attackType: "MELEE",
        equippedModelPath: "asset://models/shortsword.glb",
        equippedModelSha256: certifiedSha256,
      },
      {
        id: "shortbow",
        name: "Shortbow",
        type: "weapon",
        equipSlot: "2h",
        attackType: "RANGED",
        equippedModelPath: "asset://models/shared-bow.glb",
      },
      {
        id: "oak_shortbow",
        name: "Oak Shortbow",
        type: "weapon",
        equipSlot: "2h",
        attackType: "RANGED",
        equippedModelPath: "asset://models/shared-bow.glb",
      },
    ]),
  );
  writeFileSync(
    path.join(manifests, "armor.json"),
    JSON.stringify([
      {
        id: "bronze_platebody",
        name: "Bronze Platebody",
        type: "armor",
        equipSlot: "body",
      },
      {
        id: "gold_ring",
        name: "Gold Ring",
        type: "armor",
        equipSlot: "ring",
      },
    ]),
  );
  return assetsRoot;
}

test("classifies exact certification, shared refit work, and absent armor", () => {
  const assetsRoot = createFixture();
  try {
    const report = auditDuelEquipmentFit({ assetsRoot });
    assert.equal(report.summary.weaponCount, 3);
    assert.equal(report.summary.visibleArmorCount, 1);
    assert.equal(report.summary.nonvisualJewelryCount, 1);
    assert.equal(report.summary.readyCount, 1);
    assert.equal(report.summary.blockedCount, 3);

    const shortsword = report.items.find(
      (item) => item.itemId === "bronze_shortsword",
    );
    assert.equal(shortsword.ready, true);
    assert.deepEqual(shortsword.blockers, []);

    const shortbow = report.items.find((item) => item.itemId === "shortbow");
    assert.equal(shortbow.ready, false);
    assert.deepEqual(shortbow.sharedByItemIds, ["shortbow", "oak_shortbow"]);
    assert.ok(shortbow.blockers.includes("missing_fit_metadata"));
    assert.ok(shortbow.blockers.includes("requires_avatar_refit"));
    assert.ok(
      shortbow.blockers.includes("shared_asset_requires_unique_outputs"),
    );

    const armor = report.items.find(
      (item) => item.itemId === "bronze_platebody",
    );
    assert.deepEqual(armor.blockers, ["missing_equipped_model"]);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("reports absent launch-minimum item IDs without inventing readiness", () => {
  const assetsRoot = createFixture();
  try {
    const report = auditDuelEquipmentFit({ assetsRoot });
    const missing = report.launchMinimum.find(
      (item) => item.itemId === "staff_of_air",
    );
    assert.deepEqual(missing, {
      itemId: "staff_of_air",
      ready: false,
      blockers: ["missing_manifest_item"],
    });
    assert.equal(report.ready, false);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("audits the exact active launch weapon set", () => {
  const assetsRoot = createFixture();
  try {
    const certificationManifest = JSON.parse(
      readFileSync(
        new URL("./duel-rigid-equipment-certifications.json", import.meta.url),
        "utf8",
      ),
    );
    const report = auditDuelEquipmentFit({
      assetsRoot,
      launchMinimumCertifications: launchMinimumCertificationsFromManifest(
        certificationManifest,
      ),
    });
    assert.deepEqual(
      report.launchMinimum.map((item) => item.itemId),
      [
        "bronze_shortsword",
        "bronze_longsword",
        "bronze_scimitar",
        "shortbow",
        "magic_shortbow",
        "staff_of_air",
      ],
    );
    assert.equal(
      report.launchMinimum.some((item) => item.itemId === "bronze_2h_sword"),
      false,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("fails closed when certified launch slot, path, or hash drifts", () => {
  const assetsRoot = createFixture();
  try {
    const report = auditDuelEquipmentFit({
      assetsRoot,
      launchMinimumCertifications: [
        {
          itemId: "bronze_shortsword",
          slot: "shield",
          path: "packages/server/world/assets/models/different.glb",
          sha256: "0".repeat(64),
        },
      ],
    });
    assert.deepEqual(report.launchMinimum, [
      {
        itemId: "bronze_shortsword",
        ready: false,
        blockers: [
          "certification_slot_mismatch",
          "certification_path_mismatch",
          "certification_hash_mismatch",
        ],
      },
    ]);
    assert.equal(report.summary.launchMinimumBlockedCount, 1);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects malformed or duplicate launch certification authority", () => {
  const valid = {
    schemaVersion: 2,
    avatarId: "steve",
    legacyAvatarId: "/api/assets/steve/model",
    certifications: [
      {
        itemId: "bronze_shortsword",
        slot: "weapon",
        path: "packages/server/world/assets/models/shortsword.glb",
        sha256: "1".repeat(64),
      },
    ],
  };
  assert.deepEqual(launchMinimumCertificationsFromManifest(valid), [
    valid.certifications[0],
  ]);
  assert.throws(
    () =>
      launchMinimumCertificationsFromManifest({
        ...valid,
        certifications: [valid.certifications[0], valid.certifications[0]],
      }),
    /invalid_launch_certification_entry/,
  );
  assert.throws(
    () =>
      launchMinimumCertificationsFromManifest({
        ...valid,
        avatarId: "unapproved-avatar",
      }),
    /invalid_launch_certification_manifest/,
  );
});
