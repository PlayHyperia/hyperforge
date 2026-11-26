import assert from "node:assert/strict";
import { test } from "node:test";

import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function createGlb(document) {
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const binary = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const total = 12 + 8 + padded.length + 8 + binary.length;
  const output = Buffer.alloc(total);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  padded.copy(output, 20);
  const binaryOffset = 20 + padded.length;
  output.writeUInt32LE(binary.length, binaryOffset);
  output.writeUInt32LE(BIN_CHUNK_TYPE, binaryOffset + 4);
  binary.copy(output, binaryOffset + 8);
  return output;
}

function document(overrides = {}) {
  return {
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
            avatarId: "/api/assets/steve/model",
            ...overrides,
          },
        },
      },
      { name: "EquipmentContent" },
    ],
    buffers: [{ byteLength: 8 }],
  };
}

const request = {
  itemId: "bronze_2h_sword",
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
};

test("certifies identical scene/root authority without changing binary data", () => {
  const input = createGlb(document());
  const first = certifyRigidDuelEquipmentGlb(input, request);
  assert.equal(first.report.changed, true);
  assert.deepEqual(first.report.duelFit, {
    schemaVersion: 1,
    itemId: "bronze_2h_sword",
    slot: "weapon",
    compatibleAvatarIds: ["steve"],
  });
  assert.deepEqual(first.report.gripContact, request.gripContact);
  assert.equal(first.report.nonJsonChunksSha256.length, 1);

  const second = certifyRigidDuelEquipmentGlb(first.output, request);
  assert.equal(second.report.changed, false);
  assert.deepEqual(second.output, first.output);
  assert.equal(
    second.report.structuralDocumentSha256,
    first.report.structuralDocumentSha256,
  );
  assert.deepEqual(
    second.report.nonJsonChunksSha256,
    first.report.nonJsonChunksSha256,
  );
});

test("rejects incompatible legacy identity and contradictory fit authority", () => {
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(
        createGlb(document({ avatarId: "/api/assets/other/model" })),
        request,
      ),
    /avatar identity does not match/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(
        createGlb(
          document({
            duelFit: {
              schemaVersion: 1,
              itemId: "other_sword",
              slot: "weapon",
              compatibleAvatarIds: ["steve"],
            },
          }),
        ),
        request,
      ),
    /contradicts/u,
  );
});

test("enforces finite v2 matrices and left-hand shield attachment", () => {
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(
        createGlb(document({ relativeMatrix: [Number.NaN] })),
        request,
      ),
    /complete finite v2 fit/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        slot: "shield",
      }),
    /only be certified on leftHand/u,
  );
});

test("requires exact semantic grip and action-end authority", () => {
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        gripContact: undefined,
      }),
    /Semantic grip authority/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        gripContact: {
          ...request.gripContact,
          contentNodeName: "MissingContent",
        },
      }),
    /existing content node/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        gripContact: {
          ...request.gripContact,
          sourceAxis: [0, 0, 0],
        },
      }),
    /finite source axis/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        gripContact: {
          ...request.gripContact,
          actionEnd: "either",
        },
      }),
    /invalid action end/u,
  );
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(createGlb(document()), {
        ...request,
        gripContact: {
          ...request.gripContact,
          zones: [
            {
              ...request.gripContact.zones[0],
              boneName: "leftHand",
            },
          ],
        },
      }),
    /primary zone must use the fitted attachment hand/u,
  );
});

test("rejects contradictory embedded semantic grip authority", () => {
  assert.throws(
    () =>
      certifyRigidDuelEquipmentGlb(
        createGlb(
          document({
            gripContact: {
              ...request.gripContact,
              actionEnd: "maximum",
            },
          }),
        ),
        request,
      ),
    /contradicts/u,
  );
});
