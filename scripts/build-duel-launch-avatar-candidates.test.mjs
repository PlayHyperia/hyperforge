import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseGlbJson } from "./audit-avatar-lods.mjs";
import {
  bundleGltfArchiveEntryToGlb,
  convertKayKitBodyToVrm,
  KAYKIT_LOD_PROFILES,
  repairLockedGltfImageUris,
  selectGlbAnimation,
} from "./build-duel-launch-avatar-candidates.mjs";

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EXTRA_CHUNK = 0x12345678;

function align4(value) {
  return (value + 3) & ~3;
}

function createGlb(document, binary, extra) {
  const chunks = [
    { type: JSON_CHUNK, data: Buffer.from(JSON.stringify(document), "utf8") },
    { type: BIN_CHUNK, data: binary },
    { type: EXTRA_CHUNK, data: extra },
  ];
  const totalLength =
    12 +
    chunks.reduce((total, chunk) => total + 8 + align4(chunk.data.length), 0);
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  let offset = 12;
  for (const chunk of chunks) {
    const length = align4(chunk.data.length);
    output.writeUInt32LE(length, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    if (chunk.type === JSON_CHUNK) {
      output.fill(0x20, offset + 8 + chunk.data.length, offset + 8 + length);
    }
    offset += 8 + length;
  }
  return output;
}

function chunksByType(buffer) {
  const chunks = new Map();
  let offset = 12;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    chunks.set(
      type,
      Buffer.from(buffer.subarray(offset + 8, offset + 8 + length)),
    );
    offset += 8 + length;
  }
  return chunks;
}

function createKayKitFixture() {
  const nodeNames = [
    "hips",
    "spine",
    "chest",
    "head",
    "upperarm.l",
    "lowerarm.l",
    "wrist.l",
    "upperarm.r",
    "lowerarm.r",
    "wrist.r",
    "upperleg.l",
    "lowerleg.l",
    "foot.l",
    "toes.l",
    "upperleg.r",
    "lowerleg.r",
    "foot.r",
    "toes.r",
  ];
  const binary = Buffer.alloc(nodeNames.length * 64);
  for (let matrix = 0; matrix < nodeNames.length; matrix += 1) {
    for (const component of [0, 5, 10, 15]) {
      binary.writeFloatLE(1, (matrix * 16 + component) * 4);
    }
  }
  return createGlb(
    {
      asset: { version: "2.0" },
      nodes: nodeNames.map((name) => ({ name })),
      skins: [
        {
          joints: nodeNames.map((_, index) => index),
          inverseBindMatrices: 0,
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: nodeNames.length,
          type: "MAT4",
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: binary.length }],
      buffers: [{ byteLength: binary.length }],
    },
    binary,
    Buffer.from("preserve-me"),
  );
}

test("locks conservative KayKit close and distant LOD ceilings", () => {
  assert.deepEqual(KAYKIT_LOD_PROFILES, [
    {
      id: "lod1",
      file: "kaykit-knight_lod1.vrm",
      maxTriangles: 3_000,
      maxTextureSize: 512,
      maxError: 0.02,
    },
    {
      id: "lod2",
      file: "kaykit-knight_lod2.vrm",
      maxTriangles: 2_000,
      maxTextureSize: 256,
      maxError: 0.035,
    },
  ]);
});

test("adds deterministic CC0 VRM 1.0 authority without changing binary chunks", () => {
  const source = createKayKitFixture();
  const output = convertKayKitBodyToVrm(source);
  assert.deepEqual(output, convertKayKitBodyToVrm(source));

  const document = parseGlbJson(output, "candidate");
  assert.equal(document.extensions.VRMC_vrm.specVersion, "1.0");
  assert.equal(
    document.extensions.VRMC_vrm.meta.commercialUsage,
    "corporation",
  );
  assert.equal(document.extensions.VRMC_vrm.meta.allowRedistribution, true);
  assert.equal(
    document.extensions.VRMC_vrm.meta.licenseUrl,
    "https://vrm.dev/licenses/1.0/",
  );
  assert.equal(
    document.extensions.VRMC_vrm.meta.otherLicenseUrl,
    "https://creativecommons.org/publicdomain/zero/1.0/",
  );
  assert.equal(
    document.extensions.VRMC_vrm.meta.modification,
    "allowModificationRedistribution",
  );
  assert.equal(
    document.extensions.VRMC_vrm.humanoid.humanBones.leftHand.node,
    6,
  );
  assert.equal(
    document.extensions.VRMC_vrm.humanoid.humanBones.rightHand.node,
    9,
  );
  assert.ok(document.extensionsUsed.includes("VRMC_vrm"));

  const sourceChunks = chunksByType(source);
  const outputChunks = chunksByType(output);
  assert.deepEqual(outputChunks.get(BIN_CHUNK), sourceChunks.get(BIN_CHUNK));
  assert.deepEqual(
    outputChunks.get(EXTRA_CHUNK),
    sourceChunks.get(EXTRA_CHUNK),
  );
});

test("fails closed when a required source bone is missing or ambiguous", () => {
  const source = createKayKitFixture();
  const missing = parseGlbJson(source, "fixture");
  missing.nodes.find((node) => node.name === "wrist.l").name = "missing";
  assert.throws(
    () =>
      convertKayKitBodyToVrm(
        createGlb(
          missing,
          chunksByType(source).get(BIN_CHUNK),
          Buffer.from("preserve-me"),
        ),
      ),
    /missing leftHand node wrist\.l/u,
  );

  const duplicate = parseGlbJson(source, "fixture");
  duplicate.nodes.push({ name: "hips" });
  assert.throws(
    () =>
      convertKayKitBodyToVrm(
        createGlb(
          duplicate,
          chunksByType(source).get(BIN_CHUNK),
          Buffer.from("preserve-me"),
        ),
      ),
    /duplicate node name hips/u,
  );
});

test("selects exactly one named animation without rewriting payload chunks", () => {
  const source = createKayKitFixture();
  const document = parseGlbJson(source, "fixture");
  document.animations = [
    { name: "Idle_A", channels: [], samplers: [] },
    { name: "Death_A", channels: [], samplers: [] },
  ];
  const animationSource = createGlb(
    document,
    chunksByType(source).get(BIN_CHUNK),
    Buffer.from("preserve-me"),
  );
  const selected = selectGlbAnimation(animationSource, "Death_A", "fixture");
  assert.deepEqual(parseGlbJson(selected, "selected").animations, [
    { name: "Death_A", channels: [], samplers: [] },
  ]);
  assert.deepEqual(
    chunksByType(selected).get(BIN_CHUNK),
    chunksByType(animationSource).get(BIN_CHUNK),
  );
  assert.throws(
    () => selectGlbAnimation(animationSource, "Missing", "fixture"),
    /found 0/u,
  );
});

test("bundles locked external buffers and textures into one deterministic GLB", () => {
  const resources = new Map([
    ["pack/data.bin", Buffer.from([1, 2, 3, 4])],
    ["pack/texture.png", Buffer.from([5, 6, 7])],
  ]);
  const modelBytes = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "data.bin", byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      images: [{ uri: "texture.png" }],
    }),
  );
  const options = {
    modelBytes,
    sourceEntry: "pack/model.gltf",
    readResource: (entry) => resources.get(entry) ?? null,
  };
  const output = bundleGltfArchiveEntryToGlb(options);
  assert.deepEqual(output, bundleGltfArchiveEntryToGlb(options));
  const document = parseGlbJson(output, "bundled");
  assert.deepEqual(document.buffers, [{ byteLength: 7 }]);
  assert.equal(document.images[0].uri, undefined);
  assert.equal(document.images[0].mimeType, "image/png");
  assert.equal(document.images[0].bufferView, 1);
  assert.deepEqual(
    chunksByType(output).get(BIN_CHUNK).subarray(0, 7),
    Buffer.from([1, 2, 3, 4, 5, 6, 7]),
  );

  const escaping = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "../../escape.bin", byteLength: 4 }],
    }),
  );
  assert.throws(
    () =>
      bundleGltfArchiveEntryToGlb({
        ...options,
        modelBytes: escaping,
      }),
    /escapes its archive root/u,
  );
});

test("repairs only exact locked external image references", () => {
  const replacement = Buffer.from([1, 2, 3]);
  const repair = {
    imageName: "Normal.png",
    missingUri: "Normal_png.png",
    replacementUri: "Normal.png",
    replacementEntry: "pack/Normal.png",
    replacementBytes: replacement.length,
    replacementSha256: createHash("sha256").update(replacement).digest("hex"),
  };
  const options = {
    modelBytes: Buffer.from(
      JSON.stringify({
        images: [{ name: "Normal.png", uri: "Normal_png.png" }],
      }),
    ),
    repairs: [repair],
    readResource: (entry) =>
      entry === repair.replacementEntry ? replacement : null,
  };
  const repaired = repairLockedGltfImageUris(options);
  assert.equal(
    JSON.parse(repaired.modelBytes.toString("utf8")).images[0].uri,
    "Normal.png",
  );
  assert.deepEqual(repaired, repairLockedGltfImageUris(options));
  assert.throws(
    () =>
      repairLockedGltfImageUris({
        ...options,
        readResource: () => Buffer.from([9]),
      }),
    /Locked replacement does not match/u,
  );
});
