import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArmorPublishValidationError,
  validatePublishedArmorGlb,
  validatePublishedRigidEquipmentGlb,
} from "../../server/services/armor-pipeline/DuelFitMetadata";
import {
  createCompetitiveRigidEquipmentMetadata,
  getCompetitiveRigidEquipmentSlot,
} from "../../src/services/equipment/CompetitiveEquipmentMetadata";

const FINGERPRINT = "a".repeat(64);

function createGlb(json: Record<string, unknown>): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const totalLength = 12 + 8 + paddedLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20);
  glb.set(encoded, 20);
  return glb;
}

function createMetadata(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    originalSlot: "body",
    duelFit: {
      schemaVersion: 1,
      itemId: "bronze_platebody",
      slot: "body",
      compatibleAvatarIds: ["steve"],
      rigFingerprint: FINGERPRINT,
    },
    ...overrides,
  };
}

function createValidGlb(
  options: {
    sceneMetadata?: Record<string, unknown>;
    rootMetadata?: Record<string, unknown>;
  } = {},
) {
  const sceneMetadata = options.sceneMetadata ?? createMetadata();
  const rootMetadata = options.rootMetadata ?? sceneMetadata;
  return createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], extras: { hyperia: sceneMetadata } }],
    nodes: [{ extras: { hyperia: rootMetadata } }],
  });
}

describe("competitive armor GLB metadata", () => {
  it("accepts matching scene and root-node fit authority", () => {
    expect(
      validatePublishedArmorGlb(createValidGlb(), {
        itemId: "bronze_platebody",
        slot: "body",
      }),
    ).toEqual({
      schemaVersion: 1,
      itemId: "bronze_platebody",
      slot: "body",
      compatibleAvatarIds: ["steve"],
      rigFingerprint: FINGERPRINT,
    });
  });

  it("rejects a publish request that disagrees with embedded identity", () => {
    expect(() =>
      validatePublishedArmorGlb(createValidGlb(), {
        itemId: "steel_platebody",
        slot: "body",
      }),
    ).toThrow("Embedded item identity does not match the publish request");
  });

  it("rejects missing or contradictory loader-visible metadata", () => {
    const missingRoot = createGlb({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0], extras: { hyperia: createMetadata() } }],
      nodes: [{}],
    });
    expect(() =>
      validatePublishedArmorGlb(missingRoot, {
        itemId: "bronze_platebody",
        slot: "body",
      }),
    ).toThrow("first root node");

    const differentRoot = createMetadata({
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_platebody",
        slot: "body",
        compatibleAvatarIds: ["steve", "bandit"],
        rigFingerprint: FINGERPRINT,
      },
    });
    expect(() =>
      validatePublishedArmorGlb(
        createValidGlb({ rootMetadata: differentRoot }),
        { itemId: "bronze_platebody", slot: "body" },
      ),
    ).toThrow("do not agree");
  });

  it.each([
    ["malformed fingerprint", { rigFingerprint: "not-a-sha256" }],
    ["duplicate avatars", { compatibleAvatarIds: ["steve", "steve"] }],
    ["unsafe avatar", { compatibleAvatarIds: ["../steve"] }],
  ])("rejects %s", (_label, fitOverrides) => {
    const metadata = createMetadata({
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_platebody",
        slot: "body",
        compatibleAvatarIds: ["steve"],
        rigFingerprint: FINGERPRINT,
        ...fitOverrides,
      },
    });
    expect(() =>
      validatePublishedArmorGlb(
        createValidGlb({ sceneMetadata: metadata, rootMetadata: metadata }),
        { itemId: "bronze_platebody", slot: "body" },
      ),
    ).toThrow(ArmorPublishValidationError);
  });

  it("rejects malformed GLB framing", () => {
    const glb = createValidGlb();
    new DataView(glb.buffer).setUint32(8, glb.length + 4, true);
    expect(() =>
      validatePublishedArmorGlb(glb, {
        itemId: "bronze_platebody",
        slot: "body",
      }),
    ).toThrow("declared length");
  });
});

describe("competitive rigid equipment GLB metadata", () => {
  it.each([
    {
      itemId: "bronze_shortsword",
      assetPath:
        "packages/server/world/assets/models/swords/shortswords/shortsword-bronze-aligned.glb",
    },
    {
      itemId: "bronze_longsword",
      assetPath:
        "packages/server/world/assets/models/swords/long-swords/longsword-bronze-aligned.glb",
    },
    {
      itemId: "bronze_scimitar",
      assetPath:
        "packages/server/world/assets/models/swords/scimitars/scimitar-bronze-aligned.glb",
    },
    {
      itemId: "bronze_2h_sword",
      assetPath:
        "packages/server/world/assets/models/swords/2h-swords/2h-sword-bronze-aligned.glb",
    },
    {
      itemId: "shortbow",
      assetPath:
        "packages/server/world/assets/models/bows/bow-wood/shortbow-steve-fitted.glb",
    },
    {
      itemId: "staff_of_air",
      assetPath:
        "packages/server/world/assets/models/magic-staffs/air-staff/staff-of-air-steve-fitted.glb",
    },
  ])("accepts launch asset $itemId only for Steve", ({ itemId, assetPath }) => {
    const workspaceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const glb = fs.readFileSync(path.join(workspaceRoot, assetPath));
    expect(
      validatePublishedRigidEquipmentGlb(glb, {
        itemId,
      }),
    ).toEqual({
      schemaVersion: 1,
      itemId,
      slot: "weapon",
      compatibleAvatarIds: ["steve"],
    });
  });

  it("round-trips exact item and avatar authority through the publish gate", () => {
    const metadata = createCompetitiveRigidEquipmentMetadata({
      itemId: "bronze_shortsword",
      avatarId: "steve",
      slot: getCompetitiveRigidEquipmentSlot("sword"),
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      avatarHeight: 1.6,
      weaponType: "sword",
    });
    expect(
      validatePublishedRigidEquipmentGlb(
        createValidGlb({ sceneMetadata: metadata, rootMetadata: metadata }),
        { itemId: "bronze_shortsword" },
      ),
    ).toEqual({
      schemaVersion: 1,
      itemId: "bronze_shortsword",
      slot: "weapon",
      compatibleAvatarIds: ["steve"],
    });
  });

  it("requires shields to be fitted to the left hand", () => {
    expect(() =>
      createCompetitiveRigidEquipmentMetadata({
        itemId: "bronze_kiteshield",
        avatarId: "steve",
        slot: getCompetitiveRigidEquipmentSlot("shield"),
        vrmBoneName: "rightHand",
        relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        avatarHeight: 1.6,
        weaponType: "shield",
      }),
    ).toThrow("shield cannot be certified on rightHand");
  });
});
