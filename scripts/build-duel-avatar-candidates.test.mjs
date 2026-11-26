import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDuelAvatarCandidates,
  DUEL_AVATAR_CANDIDATES,
} from "./build-duel-avatar-candidates.mjs";
import { parseGlbJson } from "./audit-avatar-lods.mjs";
import { optimizeVrmLod } from "./optimize-vrm-lod.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");

test("keeps the recommended Steve baseline in the reproducible candidate set", () => {
  const candidate = DUEL_AVATAR_CANDIDATES.find(({ id }) => id === "steve");
  assert.deepEqual(candidate, {
    id: "steve",
    name: "Steve",
    archetype: "canonical duel-rig baseline",
    source: "avatars/steve.vrm",
    lods: {
      lod0: { maxTriangles: 3_000, maxTextureSize: 1_024 },
      lod1: { maxTriangles: 2_400, maxTextureSize: 512 },
      lod2: { maxTriangles: 1_800, maxTextureSize: 256 },
    },
  });
});

test("builds deterministic, validator-clean LODs without overwriting the source", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "hyperia-duel-vrm-"));
  const outputRoot = path.join(temporaryRoot, "avatars");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  const sourcePath = path.join(assetsRoot, "avatars/steve.vrm");
  const sourceBefore = readFileSync(sourcePath);
  const candidates = [
    {
      id: "fixture",
      name: "Fixture",
      archetype: "test fighter",
      source: "avatars/steve.vrm",
      lods: {
        lod0: { maxTriangles: 3_000, maxTextureSize: 512 },
        lod1: { maxTriangles: 2_400, maxTextureSize: 256 },
        lod2: { maxTriangles: 1_800, maxTextureSize: 128 },
      },
    },
  ];

  try {
    const manifest = await buildDuelAvatarCandidates({
      assetsRoot,
      outputRoot,
      manifestPath,
      candidates,
    });
    assert.equal(manifest.totals.generatedModels, 3);
    assert.ok(manifest.totals.generatedBytes < manifest.totals.sourceBytes);
    for (const lod of manifest.candidates[0].lods) {
      assert.equal(lod.validator.errors, 0);
      assert.equal(lod.materialPolicy, undefined);
    }
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);

    await buildDuelAvatarCandidates({
      assetsRoot,
      outputRoot,
      manifestPath,
      candidates,
      check: true,
    });

    const stalePath = path.join(outputRoot, "duel-fixture_lod2.vrm");
    writeFileSync(stalePath, Buffer.from("stale"));
    await assert.rejects(
      buildDuelAvatarCandidates({
        assetsRoot,
        outputRoot,
        manifestPath,
        candidates,
        check: true,
      }),
      /Generated avatar is stale/,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function afterJsonChunk(buffer) {
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a);
  return buffer.subarray(20 + buffer.readUInt32LE(12));
}

function rewriteDocument(buffer, change) {
  const document = parseGlbJson(buffer);
  change(document);
  const json = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const tail = afterJsonChunk(buffer);
  const output = Buffer.alloc(20 + paddedLength + tail.length);
  buffer.copy(output, 0, 0, 20);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12);
  json.copy(output, 20);
  output.fill(0x20, 20 + json.length, 20 + paddedLength);
  tail.copy(output, 20 + paddedLength);
  return output;
}

test("Bandit body policy changes only alpha metadata in all three real LODs", async () => {
  const candidate = DUEL_AVATAR_CANDIDATES.find(({ id }) => id === "bandit");
  assert.equal(candidate.materialPolicy, "bandit-opaque-body-v1");
  const sourcePath = path.join(assetsRoot, candidate.source);
  const sourceBefore = readFileSync(sourcePath);
  const servedPaths = ["", "_lod1", "_lod2"].map((suffix) =>
    path.join(assetsRoot, `avatars/duel-candidates/duel-bandit${suffix}.vrm`),
  );
  const servedBefore = servedPaths.map((file) => readFileSync(file));
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-bandit-policy-"),
  );
  const outputRoot = path.join(temporaryRoot, "candidates");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  const options = {
    assetsRoot,
    outputRoot,
    manifestPath,
    candidates: [candidate],
  };
  try {
    const manifest = await buildDuelAvatarCandidates(options);
    assert.equal(manifest.totals.generatedModels, 3);
    assert.equal(manifest.candidates[0].sourceSha256, sha256(sourceBefore));
    for (const lod of manifest.candidates[0].lods) {
      const baseline = await optimizeVrmLod(sourceBefore, {
        ...candidate.lods[lod.lod],
        maxError: 0.02,
        source: candidate.source,
      });
      const suffix = { lod0: "", lod1: "_lod1", lod2: "_lod2" }[lod.lod];
      const corrected = readFileSync(
        path.join(outputRoot, `duel-bandit${suffix}.vrm`),
      );
      const before = parseGlbJson(baseline.output);
      const after = parseGlbJson(corrected);
      assert.equal(before.materials[0].alphaMode, "BLEND");
      assert.equal(after.materials[0].alphaMode, "OPAQUE");
      after.materials[0].alphaMode = "BLEND";
      assert.deepEqual(
        after,
        before,
        `${lod.lod}: all other JSON remains identical`,
      );
      assert.deepEqual(
        afterJsonChunk(corrected),
        afterJsonChunk(baseline.output),
      );
      assert.equal(lod.sha256, sha256(corrected));
      assert.notEqual(lod.sha256, baseline.report.outputSha256);
      assert.equal(lod.bytes, corrected.length);
      assert.equal(lod.rigFingerprint, baseline.report.outputRigFingerprint);
      assert.equal(lod.validator.errors, 0);
      assert.deepEqual(lod.materialPolicy, {
        id: "bandit-opaque-body-v1",
        inputSha256: baseline.report.outputSha256,
        materialIndex: 0,
        from: "BLEND",
        to: "OPAQUE",
      });
    }
    await buildDuelAvatarCandidates({ ...options, check: true });
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    servedPaths.forEach((file, index) =>
      assert.deepEqual(readFileSync(file), servedBefore[index]),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Bandit policy rejects unaudited identity, material, primitive and source bytes before output", async () => {
  const bandit = DUEL_AVATAR_CANDIDATES.find(({ id }) => id === "bandit");
  const source = readFileSync(path.join(assetsRoot, bandit.source));
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-bandit-rejection-"),
  );
  const localAssets = path.join(temporaryRoot, "assets");
  const localSource = path.join(localAssets, bandit.source);
  mkdirSync(path.dirname(localSource), { recursive: true });
  const cases = [
    {
      label: "foreign identity",
      candidate: { ...bandit, id: "unrelated" },
      error: /unsupported candidate material policy/,
    },
    {
      label: "unknown policy",
      candidate: { ...bandit, materialPolicy: "opaque-all" },
      error: /unsupported candidate material policy/,
    },
    {
      label: "missing BLEND",
      change: (doc) => {
        doc.materials[0].alphaMode = "OPAQUE";
      },
      error: /material signature/,
    },
    {
      label: "cutout",
      change: (doc) => {
        doc.materials[0].alphaMode = "MASK";
        doc.materials[0].alphaCutoff = 0.5;
      },
      error: /material signature/,
    },
    {
      label: "partial base alpha",
      change: (doc) => {
        doc.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 0.5];
      },
      error: /material signature/,
    },
    {
      label: "transmission",
      change: (doc) => {
        doc.materials[0].extensions.KHR_materials_transmission = {
          transmissionFactor: 1,
        };
      },
      error: /material signature/,
    },
    {
      label: "MToon",
      change: (doc) => {
        doc.materials[0].extensions.VRMC_materials_mtoon = {
          specVersion: "1.0",
        };
      },
      error: /material signature/,
    },
    {
      label: "extra hair material",
      change: (doc) => {
        doc.materials.push({ ...doc.materials[0], name: "Hair" });
      },
      error: /material signature/,
    },
    {
      label: "extra primitive",
      change: (doc) => {
        doc.meshes[0].primitives.push(
          structuredClone(doc.meshes[0].primitives[0]),
        );
      },
      error: /primitive signature/,
    },
    {
      label: "vertex alpha",
      change: (doc) => {
        doc.meshes[0].primitives[0].attributes.COLOR_0 = 0;
      },
      error: /primitive signature/,
    },
    {
      label: "different material binding",
      change: (doc) => {
        doc.meshes[0].primitives[0].material = 1;
      },
      error: /primitive signature/,
    },
    {
      label: "unaudited source",
      change: (doc) => {
        doc.asset.generator += " revised";
      },
      error: /exact audited source SHA256/,
    },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const input = entry.change
        ? rewriteDocument(source, entry.change)
        : source;
      writeFileSync(localSource, input);
      const outputRoot = path.join(temporaryRoot, `output-${index}`);
      const manifestPath = path.join(temporaryRoot, `manifest-${index}.json`);
      await assert.rejects(
        buildDuelAvatarCandidates({
          assetsRoot: localAssets,
          outputRoot,
          manifestPath,
          candidates: [entry.candidate ?? bandit],
        }),
        entry.error,
        entry.label,
      );
      assert.equal(existsSync(outputRoot), false, entry.label);
      assert.equal(existsSync(manifestPath), false, entry.label);
      assert.deepEqual(readFileSync(localSource), input, entry.label);
    }
    assert.deepEqual(
      readFileSync(path.join(assetsRoot, bandit.source)),
      source,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
