import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditAvatarLods,
  parseGlbJson,
  readAvatarRegistry,
  summarizeVrmDocument,
} from "./audit-avatar-lods.mjs";

function createDocument(triangles) {
  const bones = Object.fromEntries(
    [
      "hips",
      "spine",
      "head",
      "leftUpperArm",
      "leftLowerArm",
      "leftHand",
      "rightUpperArm",
      "rightLowerArm",
      "rightHand",
      "leftUpperLeg",
      "leftLowerLeg",
      "leftFoot",
      "rightUpperLeg",
      "rightLowerLeg",
      "rightFoot",
    ].map((bone, node) => [bone, { node }]),
  );
  return {
    asset: { version: "2.0" },
    accessors: [
      { count: triangles * 3 },
      { count: triangles * 3 },
      { count: triangles * 3 },
      { count: triangles * 3 },
      {
        bufferView: 0,
        componentType: 5126,
        count: 15,
        type: "MAT4",
      },
    ],
    buffers: [{ byteLength: 15 * 16 * Float32Array.BYTES_PER_ELEMENT }],
    bufferViews: [
      {
        buffer: 0,
        byteLength: 15 * 16 * Float32Array.BYTES_PER_ELEMENT,
      },
    ],
    meshes: [
      {
        primitives: [
          {
            indices: 0,
            attributes: { POSITION: 1, JOINTS_0: 2, WEIGHTS_0: 3 },
          },
        ],
      },
    ],
    nodes: Array.from({ length: 15 }, (_, index) => ({
      name: `bone-${index}`,
    })),
    skins: [
      {
        joints: Array.from({ length: 15 }, (_, index) => index),
        inverseBindMatrices: 4,
      },
    ],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        humanoid: { humanBones: bones },
        meta: {
          authors: ["test"],
          commercialUsage: "corporation",
          modification: "allowModificationRedistribution",
          allowRedistribution: true,
        },
      },
    },
  };
}

function createGlb(document) {
  const binary = Buffer.alloc(15 * 16 * Float32Array.BYTES_PER_ELEMENT);
  for (let matrixIndex = 0; matrixIndex < 15; matrixIndex += 1) {
    for (const diagonalIndex of [0, 5, 10, 15]) {
      binary.writeFloatLE(1, (matrixIndex * 16 + diagonalIndex) * 4);
    }
  }
  const encoded = Buffer.from(JSON.stringify(document), "utf8");
  const padding = (4 - (encoded.length % 4)) % 4;
  const json = Buffer.concat([encoded, Buffer.alloc(padding, 0x20)]);
  const output = Buffer.alloc(20 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  const binaryHeaderOffset = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryHeaderOffset);
  output.writeUInt32LE(0x004e4942, binaryHeaderOffset + 4);
  binary.copy(output, binaryHeaderOffset + 8);
  return output;
}

test("parses registry literals and GLB structure without executing TypeScript", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hyperia-avatar-audit-"));
  try {
    const source = path.join(root, "avatars.ts");
    writeFileSync(
      source,
      `export const AVATAR_OPTIONS = [{ id: "alpha", url: "asset://avatars/a.vrm", lod1Url: "asset://avatars/a_lod1.vrm", lod2Url: "asset://avatars/a_lod2.vrm" }];`,
    );
    assert.deepEqual(readAvatarRegistry(source), [
      {
        id: "alpha",
        url: "asset://avatars/a.vrm",
        lod1Url: "asset://avatars/a_lod1.vrm",
        lod2Url: "asset://avatars/a_lod2.vrm",
      },
    ]);

    const fixture = createGlb(createDocument(123));
    const document = parseGlbJson(fixture, "fixture");
    const summary = summarizeVrmDocument(document, fixture);
    assert.equal(summary.triangles, 123);
    assert.equal(summary.vertices, 369);
    assert.equal(summary.skinnedPrimitiveCount, 1);
    assert.deepEqual(summary.missingRequiredBones, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when exact inverse bind matrices are unavailable", () => {
  const source = createDocument(123);
  delete source.skins[0].inverseBindMatrices;
  const fixture = createGlb(source);
  const document = parseGlbJson(fixture, "fixture");

  assert.throws(
    () => summarizeVrmDocument(document, fixture),
    /one non-sparse Float32 MAT4 inverse bind matrix per joint/,
  );
});

test("passes a complete compatible three-level launch avatar", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hyperia-avatar-audit-"));
  try {
    const source = path.join(root, "avatars.ts");
    const assets = path.join(root, "assets");
    const avatars = path.join(assets, "avatars");
    mkdirSync(avatars, { recursive: true });
    writeFileSync(
      source,
      `export const AVATAR_OPTIONS = [{ id: "alpha", url: "asset://avatars/a.vrm", lod1Url: "asset://avatars/a_lod1.vrm", lod2Url: "asset://avatars/a_lod2.vrm" }];`,
    );
    writeFileSync(
      path.join(avatars, "a.vrm"),
      createGlb(createDocument(20_000)),
    );
    writeFileSync(
      path.join(avatars, "a_lod1.vrm"),
      createGlb(createDocument(8_000)),
    );
    writeFileSync(
      path.join(avatars, "a_lod2.vrm"),
      createGlb(createDocument(2_000)),
    );

    const result = auditAvatarLods({
      avatarSourcePath: source,
      assetsRoot: assets,
    });
    assert.equal(result.passed, true, result.failures.join("\n"));
    assert.equal(result.models.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on missing LODs, excessive geometry, and restrictive rights", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hyperia-avatar-audit-"));
  try {
    const source = path.join(root, "avatars.ts");
    const assets = path.join(root, "assets");
    const avatars = path.join(assets, "avatars");
    mkdirSync(avatars, { recursive: true });
    writeFileSync(
      source,
      `export const AVATAR_OPTIONS = [{ id: "alpha", url: "asset://avatars/a.vrm", lod1Url: "asset://avatars/a_lod1.vrm", lod2Url: "asset://avatars/a_lod2.vrm" }];`,
    );
    const restricted = createDocument(20_001);
    restricted.extensions.VRMC_vrm.meta.commercialUsage = "personalNonProfit";
    restricted.extensions.VRMC_vrm.meta.modification = "prohibited";
    restricted.extensions.VRMC_vrm.meta.allowRedistribution = false;
    writeFileSync(path.join(avatars, "a.vrm"), createGlb(restricted));

    const result = auditAvatarLods({
      avatarSourcePath: source,
      assetsRoot: assets,
    });
    assert.equal(result.passed, false);
    assert.match(result.failures.join("\n"), /20,001 triangles/);
    assert.match(result.failures.join("\n"), /personalNonProfit/);
    assert.match(result.failures.join("\n"), /prohibited/);
    assert.match(result.failures.join("\n"), /allowRedistribution/);
    assert.match(
      result.failures.join("\n"),
      /missing asset: asset:\/\/avatars\/a_lod1/,
    );
    assert.match(
      result.failures.join("\n"),
      /missing asset: asset:\/\/avatars\/a_lod2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
