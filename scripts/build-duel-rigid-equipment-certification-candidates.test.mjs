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

import { buildDuelRigidEquipmentCertificationCandidates } from "./build-duel-rigid-equipment-certification-candidates.mjs";
import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GRIP_CONTACT = {
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
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createGlb() {
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
            avatarId: "/api/assets/steve/model",
            duelFit: {
              schemaVersion: 1,
              itemId: "bronze_shortsword",
              slot: "weapon",
              compatibleAvatarIds: ["steve"],
            },
          },
        },
      },
      { name: "EquipmentContent" },
    ],
    buffers: [{ byteLength: 8 }],
  };
  const encoded = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(json);
  const binary = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
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
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-semantic-grip-candidates-"),
  );
  const sourceRelative =
    "packages/server/world/assets/models/swords/shortsword.glb";
  const sourcePath = path.join(workspaceRoot, sourceRelative);
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  const source = createGlb();
  writeFileSync(sourcePath, source);
  const sourceReport = certifyRigidDuelEquipmentGlb(source, {
    itemId: "bronze_shortsword",
    avatarId: "steve",
    legacyAvatarId: "/api/assets/steve/model",
    slot: "weapon",
    gripContact: GRIP_CONTACT,
  }).report;
  const manifest = {
    schemaVersion: 2,
    avatarId: "steve",
    legacyAvatarId: "/api/assets/steve/model",
    certifications: [
      {
        itemId: "bronze_shortsword",
        slot: "weapon",
        grip: "one-hand",
        presentationAuthority: {
          schemaVersion: 1,
          actionSemantic: "blade-tip",
          actionAxisSymmetry: "directed",
          gripContact: GRIP_CONTACT,
        },
        path: sourceRelative,
        sha256: sha256(source),
        structuralDocumentSha256: sourceReport.structuralDocumentSha256,
        nonJsonChunksSha256: sourceReport.nonJsonChunksSha256,
      },
    ],
  };
  return { workspaceRoot, manifest, sourcePath };
}

test("builds deterministic metadata-only semantic-grip candidates", () => {
  const fixture = createFixture();
  try {
    const written = buildDuelRigidEquipmentCertificationCandidates({
      ...fixture,
      write: true,
    });
    assert.equal(written.ok, true);
    assert.equal(written.candidateCount, 1);
    assert.equal(written.outputs[0].metadataChanged, true);
    assert.equal(
      written.outputs[0].structuralDocumentSha256,
      fixture.manifest.certifications[0].structuralDocumentSha256,
    );
    assert.deepEqual(
      written.outputs[0].nonJsonChunksSha256,
      fixture.manifest.certifications[0].nonJsonChunksSha256,
    );
    const checked = buildDuelRigidEquipmentCertificationCandidates({
      ...fixture,
      write: false,
    });
    assert.deepEqual(checked, written);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("fails closed on stale output, source drift, and unsafe roots", () => {
  const fixture = createFixture();
  try {
    const report = buildDuelRigidEquipmentCertificationCandidates({
      ...fixture,
      write: true,
    });
    const candidatePath = path.join(
      fixture.workspaceRoot,
      report.outputs[0].candidatePath,
    );
    writeFileSync(candidatePath, Buffer.from("stale"));
    assert.throws(
      () =>
        buildDuelRigidEquipmentCertificationCandidates({
          ...fixture,
          write: false,
        }),
      /candidate is missing or stale/u,
    );

    writeFileSync(fixture.sourcePath, Buffer.from("drifted"));
    assert.throws(
      () =>
        buildDuelRigidEquipmentCertificationCandidates({
          ...fixture,
          write: true,
        }),
      /source SHA-256 drifted/u,
    );

    assert.throws(
      () =>
        buildDuelRigidEquipmentCertificationCandidates({
          ...fixture,
          outputRoot: "packages/server/world/assets/models/active",
          write: true,
        }),
      /candidates tree/u,
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("generated candidate contains the exact requested authority", () => {
  const fixture = createFixture();
  try {
    const report = buildDuelRigidEquipmentCertificationCandidates({
      ...fixture,
      write: true,
    });
    const candidate = readFileSync(
      path.join(fixture.workspaceRoot, report.outputs[0].candidatePath),
    );
    const certification = certifyRigidDuelEquipmentGlb(candidate, {
      itemId: "bronze_shortsword",
      avatarId: "steve",
      legacyAvatarId: "/api/assets/steve/model",
      slot: "weapon",
      gripContact: GRIP_CONTACT,
    });
    assert.equal(certification.report.changed, false);
    assert.deepEqual(certification.report.gripContact, GRIP_CONTACT);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});
