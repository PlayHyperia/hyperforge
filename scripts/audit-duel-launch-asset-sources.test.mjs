import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";

import { auditDuelLaunchAssetSources } from "./audit-duel-launch-asset-sources.mjs";
import { readZipArchive } from "./lib/read-zip-archive.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [entryName, entryValue] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(entryValue);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createFixture() {
  const license = Buffer.from(
    "CC0 1.0 Universal\nPublic Domain Dedication\n",
    "utf8",
  );
  const positions = Buffer.alloc(36);
  [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0].forEach((value, index) =>
    positions.writeFloatLE(value, index * 4),
  );
  const model = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [
        {
          byteLength: positions.length,
          uri: `data:application/octet-stream;base64,${positions.toString("base64")}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: positions.length, target: 34962 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [-0.5, 0, 0],
          max: [0.5, 1, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
    "utf8",
  );
  const archive = createStoredZip([
    ["fixture/License.txt", license],
    ["fixture/model.gltf", model],
  ]);
  const lock = {
    schemaVersion: 1,
    packs: [
      {
        id: "fixture-pack",
        provider: "Fixture",
        kind: "avatar-base-kit",
        disposition: "test-only",
        sourcePage: "https://example.com/source",
        purchasePage: "https://example.com/purchase",
        license: {
          spdx: "CC0-1.0",
          url: "https://creativecommons.org/publicdomain/zero/1.0/",
          commercialUse: true,
          modification: true,
          redistribution: true,
          attributionRequired: false,
          embeddedEntry: "fixture/License.txt",
          embeddedSha256: sha256(license),
          requiredText: ["CC0 1.0 Universal", "Public Domain Dedication"],
        },
        nonAiEvidence: {
          url: "https://example.com/source",
          statement: "No generative AI was used",
          verifiedAt: "2026-08-12",
        },
        archive: {
          file: "fixture.zip",
          version: "1",
          bytes: archive.length,
          entries: 2,
          sha256: sha256(archive),
        },
        requiredEntries: ["fixture/model.gltf"],
        inspections: [
          {
            entry: "fixture/model.gltf",
            format: "gltf",
            sha256: sha256(model),
            expected: {
              triangles: 1,
              vertices: 3,
              primitiveCount: 1,
              skinCount: 0,
              jointCount: 0,
              animationCount: 0,
              textureCount: 0,
              missingResources: [],
              validatorErrors: 0,
              validatorWarnings: 0,
            },
          },
        ],
      },
    ],
  };
  return { archive, lock };
}

test("reads exact stored ZIP entries and rejects traversal paths", () => {
  const valid = createStoredZip([["safe/file.txt", "safe"]]);
  const parsed = readZipArchive(valid, "fixture");
  assert.equal(parsed.entryCount, 1);
  assert.equal(parsed.entries.get("safe/file.txt").data.toString(), "safe");

  const traversal = createStoredZip([["../escape.txt", "unsafe"]]);
  assert.throws(
    () => readZipArchive(traversal, "fixture"),
    /unsafe ZIP entry path/u,
  );
});

test("rejects archive data that does not match its central CRC-32", () => {
  const archive = createStoredZip([["file.txt", "payload"]]);
  const corrupted = Buffer.from(archive);
  corrupted[30 + Buffer.byteLength("file.txt")] ^= 0xff;
  assert.throws(() => readZipArchive(corrupted, "fixture"), /CRC-32 mismatch/u);
});

test("audits immutable archive, license, entry, and model locks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hyperia-launch-assets-"));
  try {
    const { archive, lock } = createFixture();
    writeFileSync(path.join(root, "fixture.zip"), archive);
    const result = await auditDuelLaunchAssetSources({
      lock,
      downloadsDir: root,
    });
    assert.equal(result.passed, true, result.failures.join("\n"));
    assert.equal(result.totals.passedPacks, 1);
    assert.equal(result.packs[0].inspections[0].triangles, 1);

    const corrupted = Buffer.from(archive);
    corrupted[30 + Buffer.byteLength("fixture/License.txt")] ^= 0xff;
    writeFileSync(path.join(root, "fixture.zip"), corrupted);
    const failed = await auditDuelLaunchAssetSources({
      lock,
      downloadsDir: root,
    });
    assert.equal(failed.passed, false);
    assert.match(failed.failures.join("\n"), /CRC-32 mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
