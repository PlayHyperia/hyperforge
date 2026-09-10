import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";
import {
  verifyActiveDuelEquipmentBindings,
  verifyDuelRigidEquipmentCertifications,
  resolveDuelEquipmentCertificationBinding,
} from "./verify-duel-rigid-equipment-certifications.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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
    path.join(tmpdir(), "hyperia-equipment-certifications-"),
  );
  const relativePath = "packages/server/world/assets/models/swords/fixture.glb";
  const assetPath = path.join(workspaceRoot, relativePath);
  mkdirSync(path.dirname(assetPath), { recursive: true });
  const presentationAuthority = {
    schemaVersion: 1,
    actionSemantic: "blade-tip",
    actionAxisSymmetry: "directed",
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
  const { output, report } = certifyRigidDuelEquipmentGlb(createGlb(), {
    itemId: "bronze_shortsword",
    avatarId: "steve",
    legacyAvatarId: "/api/assets/steve/model",
    slot: "weapon",
    gripContact: presentationAuthority.gripContact,
  });
  writeFileSync(assetPath, output);
  const certification = {
    itemId: "bronze_shortsword",
    slot: "weapon",
    grip: "one-hand",
    presentationAuthority,
    path: relativePath,
    sha256: report.outputSha256,
    structuralDocumentSha256: report.structuralDocumentSha256,
    nonJsonChunksSha256: report.nonJsonChunksSha256,
  };
  return {
    workspaceRoot,
    manifest: {
      schemaVersion: 2,
      avatarId: "steve",
      legacyAvatarId: "/api/assets/steve/model",
      certifications: [certification],
    },
  };
}

test("verifies immutable item, avatar, structure, and binary authority", () => {
  const fixture = createFixture();
  try {
    const report = verifyDuelRigidEquipmentCertifications(fixture);
    assert.equal(report.ok, true);
    assert.equal(report.certificationCount, 1);
    assert.deepEqual(report.reports[0], {
      itemId: "bronze_shortsword",
      path: "packages/server/world/assets/models/swords/fixture.glb",
      slot: "weapon",
      grip: "one-hand",
      vrmBoneName: "rightHand",
      sha256: fixture.manifest.certifications[0].sha256,
      structuralDocumentSha256:
        fixture.manifest.certifications[0].structuralDocumentSha256,
      nonJsonChunkCount: 1,
      actionSemantic: "blade-tip",
      actionAxisSymmetry: "directed",
      gripContact:
        fixture.manifest.certifications[0].presentationAuthority.gripContact,
    });
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("fails closed on digest drift and duplicate competitive identity", () => {
  const fixture = createFixture();
  try {
    const driftedManifest = structuredClone(fixture.manifest);
    driftedManifest.certifications[0].sha256 = "0".repeat(64);
    assert.throws(
      () =>
        verifyDuelRigidEquipmentCertifications({
          workspaceRoot: fixture.workspaceRoot,
          manifest: driftedManifest,
        }),
      /asset SHA-256 drifted/u,
    );

    const duplicateManifest = structuredClone(fixture.manifest);
    duplicateManifest.certifications.push(
      structuredClone(duplicateManifest.certifications[0]),
    );
    assert.throws(
      () =>
        verifyDuelRigidEquipmentCertifications({
          workspaceRoot: fixture.workspaceRoot,
          manifest: duplicateManifest,
        }),
      /Duplicate certified itemId/u,
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects traversal and invalid grip declarations before reading files", () => {
  const fixture = createFixture();
  try {
    const traversalManifest = structuredClone(fixture.manifest);
    traversalManifest.certifications[0].path =
      "packages/server/world/assets/models/../outside.glb";
    assert.throws(
      () =>
        verifyDuelRigidEquipmentCertifications({
          workspaceRoot: fixture.workspaceRoot,
          manifest: traversalManifest,
        }),
      /must remain under/u,
    );

    const invalidGripManifest = structuredClone(fixture.manifest);
    invalidGripManifest.certifications[0].grip = "either";
    assert.throws(
      () =>
        verifyDuelRigidEquipmentCertifications({
          workspaceRoot: fixture.workspaceRoot,
          manifest: invalidGripManifest,
        }),
      /grip must be/u,
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects a combat certification without exact semantic grip authority", () => {
  const fixture = createFixture();
  try {
    const missingAuthority = structuredClone(fixture.manifest);
    delete missingAuthority.certifications[0].presentationAuthority;
    assert.throws(
      () =>
        verifyDuelRigidEquipmentCertifications({
          workspaceRoot: fixture.workspaceRoot,
          manifest: missingAuthority,
        }),
      /semantic grip authority/u,
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("binds every certified asset to the active runtime item manifest", () => {
  const fixture = createFixture();
  try {
    const certification = fixture.manifest.certifications[0];
    const itemManifest = [
      {
        id: certification.itemId,
        equippedModelPath: "asset://models/swords/fixture.glb",
      },
    ];
    const report = verifyActiveDuelEquipmentBindings({
      workspaceRoot: fixture.workspaceRoot,
      certificationManifest: fixture.manifest,
      itemManifest,
    });
    assert.equal(report.activeBindingCount, 1);
    assert.deepEqual(report.bindings, [
      {
        itemId: certification.itemId,
        manifestIndex: 0,
        assetUrl: "asset://models/swords/fixture.glb",
        sha256: certification.sha256,
        avatarOverride: null,
      },
    ]);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects active path drift, avatar bypasses, and candidate activation", () => {
  const fixture = createFixture();
  try {
    const certification = fixture.manifest.certifications[0];
    const baseItem = {
      id: certification.itemId,
      equippedModelPath: "asset://models/swords/fixture.glb",
    };
    const verify = (itemManifest) =>
      verifyActiveDuelEquipmentBindings({
        workspaceRoot: fixture.workspaceRoot,
        certificationManifest: fixture.manifest,
        itemManifest,
      });

    assert.throws(
      () =>
        verify([
          {
            ...baseItem,
            equippedModelPath: "asset://models/swords/other.glb",
          },
        ]),
      /active equippedModelPath does not match/u,
    );
    assert.throws(
      () =>
        verify([
          {
            ...baseItem,
            equippedModelPathsByAvatar: {
              steve: "asset://models/swords/other.glb",
            },
          },
        ]),
      /override bypasses/u,
    );
    assert.throws(
      () =>
        verify([
          baseItem,
          {
            id: "uncertified_weapon",
            equippedModelPath:
              "asset://models/swords/candidates/experimental.glb",
          },
        ]),
      /activates a candidate-only asset/u,
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

function overrideFixture() {
  const fixture = createFixture();
  const workspace = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const avatarAsset = "avatars/duel-candidates/duel-steve.vrm";
  for (const file of [
    "packages/shared/src/data/avatars.ts",
    `packages/server/world/assets/${avatarAsset}`,
  ]) {
    const destination = path.join(fixture.workspaceRoot, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(workspace, file)));
  }
  fixture.manifest.binding = {
    mode: "avatar-override",
    avatar: {
      url: `asset://${avatarAsset}`,
      sha256: createHash("sha256")
        .update(
          readFileSync(
            path.join(workspace, "packages/server/world/assets", avatarAsset),
          ),
        )
        .digest("hex"),
    },
  };
  const certification = fixture.manifest.certifications[0];
  fixture.itemManifest = [
    {
      id: certification.itemId,
      equippedModelPath: "asset://models/swords/unchanged-default.glb",
      equippedModelSha256: "a".repeat(64),
      equippedModelPathsByAvatar: {
        steve: "asset://models/swords/fixture.glb",
      },
      equippedModelSha256ByAvatar: { steve: certification.sha256 },
    },
  ];
  fixture.verify = () =>
    verifyActiveDuelEquipmentBindings({
      workspaceRoot: fixture.workspaceRoot,
      certificationManifest: fixture.manifest,
      itemManifest: fixture.itemManifest,
    });
  return fixture;
}

test("explicit avatar override validates registered VRM identity without binding the default", () => {
  const fixture = overrideFixture();
  try {
    const before = structuredClone(fixture.itemManifest);
    const report = fixture.verify();
    assert.equal(report.binding.mode, "avatar-override");
    assert.equal(report.binding.avatarId, "steve");
    assert.equal(report.binding.sha256, fixture.manifest.binding.avatar.sha256);
    assert.equal(
      report.bindings[0].avatarOverride,
      "asset://models/swords/fixture.glb",
    );
    assert.deepEqual(fixture.itemManifest, before);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("avatar binding rejects unknown, wrong, duplicate, and changed registered identities", () => {
  const fixture = overrideFixture();
  try {
    const valid = structuredClone(fixture.manifest);
    const resolve = () =>
      resolveDuelEquipmentCertificationBinding({
        workspaceRoot: fixture.workspaceRoot,
        certificationManifest: fixture.manifest,
      });
    for (const [update, pattern] of [
      [
        (value) => {
          value.avatarId = "not-registered";
        },
        /does not match the registered avatar/u,
      ],
      [
        (value) => {
          value.avatarId = "kaykit-knight";
        },
        /does not match the registered avatar/u,
      ],
      [
        (value) => {
          value.binding.avatar.sha256 = "0".repeat(64);
        },
        /avatar SHA-256 drifted/u,
      ],
      [
        (value) => {
          value.binding.mode = "default";
        },
        /exact avatar-override/u,
      ],
    ]) {
      fixture.manifest = structuredClone(valid);
      update(fixture.manifest);
      assert.throws(resolve, pattern);
    }
    fixture.manifest = valid;
    const registryPath = path.join(
      fixture.workspaceRoot,
      "packages/shared/src/data/avatars.ts",
    );
    const registry = readFileSync(registryPath, "utf8");
    writeFileSync(
      registryPath,
      registry.replace('id: "kaykit-knight"', 'id: "steve"'),
    );
    assert.throws(resolve, /duplicate identity mappings/u);
    writeFileSync(
      registryPath,
      registry.replace('id: "steve",', 'id: "steve", ...dynamicOverride,'),
    );
    assert.throws(resolve, /dynamic or duplicate registry properties/u);
    writeFileSync(
      registryPath,
      registry.replace(
        'id: "steve",',
        'id: "steve", ["url"]: "asset://avatars/other.vrm",',
      ),
    );
    assert.throws(resolve, /dynamic or duplicate registry properties/u);
    writeFileSync(
      registryPath,
      registry.replace('id: "steve",', 'id: "steve", id: "other",'),
    );
    assert.throws(resolve, /dynamic or duplicate registry properties/u);
    writeFileSync(
      registryPath,
      registry.replace('id: "steve",', "id: dynamicAvatarId,"),
    );
    assert.throws(resolve, /literal identity and URL properties/u);
    writeFileSync(
      registryPath,
      registry.replace(
        'url: "asset://avatars/duel-candidates/duel-kaykit-knight.vrm"',
        'url: "asset://avatars/duel-candidates/duel-steve.vrm"',
      ),
    );
    assert.throws(resolve, /duplicate identity mappings/u);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("avatar-only equipment requires exact own URL and digest with no duplicate/default leakage", () => {
  const fixture = overrideFixture();
  try {
    const valid = structuredClone(fixture.itemManifest);
    for (const [update, pattern] of [
      [
        (items) => {
          delete items[0].equippedModelPathsByAvatar;
        },
        /override binding drifted/u,
      ],
      [
        (items) => {
          items[0].equippedModelPathsByAvatar.steve =
            "asset://models/swords/wrong.glb";
        },
        /override binding drifted/u,
      ],
      [
        (items) => {
          items[0].equippedModelSha256ByAvatar.steve = "0".repeat(64);
        },
        /override binding drifted/u,
      ],
      [
        (items) => {
          delete items[0].equippedModelSha256ByAvatar;
        },
        /override binding drifted/u,
      ],
      [
        (items) => {
          items[0].equippedModelPathsByAvatar = Object.create(
            items[0].equippedModelPathsByAvatar,
          );
        },
        /override binding drifted/u,
      ],
      [
        (items) => {
          items[0].equippedModelPath =
            items[0].equippedModelPathsByAvatar.steve;
        },
        /leaks into a default/u,
      ],
      [
        (items) => {
          items[0].equippedModelPathsByAvatar["kaykit-knight"] =
            items[0].equippedModelPathsByAvatar.steve;
        },
        /duplicate override mappings/u,
      ],
      [
        (items) => {
          items.push({ ...items[0], id: "other_item" });
        },
        /duplicate override mappings/u,
      ],
      [
        (items) => {
          items.push(structuredClone(items[0]));
        },
        /Duplicate weapon itemId/u,
      ],
      [
        (items) => {
          items[0].id = "wrong_item";
        },
        /missing from the weapon item manifest/u,
      ],
    ]) {
      fixture.itemManifest = structuredClone(valid);
      update(fixture.itemManifest);
      assert.throws(fixture.verify, pattern);
    }
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("resolves the actual registered Knight LOD0 bytes without asserting weapon fit", () => {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const asset = "avatars/duel-candidates/duel-kaykit-knight.vrm";
  const hash = createHash("sha256")
    .update(
      readFileSync(
        path.join(workspaceRoot, "packages/server/world/assets", asset),
      ),
    )
    .digest("hex");
  const binding = resolveDuelEquipmentCertificationBinding({
    workspaceRoot,
    certificationManifest: {
      avatarId: "kaykit-knight",
      binding: {
        mode: "avatar-override",
        avatar: { url: `asset://${asset}`, sha256: hash },
      },
    },
  });
  assert.equal(binding.avatarId, "kaykit-knight");
  assert.equal(binding.sha256, hash);
});
