import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { PNG } from "pngjs";
import {
  buildPackedTerrain,
  decodePng,
  GRASS004_PROVENANCE,
  ROCK_FACE_03_PROVENANCE,
  parsePackingOptions,
  validateGrass004Provenance,
  validateGrass004Source,
  validateRockFace03Provenance,
  validateRockFace03Source,
} from "./pack-compact-terrain-textures.mjs";

const assetRoot = new URL("../packages/server/world/assets/", import.meta.url);
const packedRoot = new URL("terrain/textures/compact-pbr/", assetRoot);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
const oldOutputs = {
  "grass-albedo-roughness.png":
    "d36ddd357a3d9244dd8bbed085721f8cc41492bfa6d3342f7b945cefac609510",
  "grass-normal-ao.png":
    "86f0932e5aa88dd243020064d5bb189fc5bd68ef72d07e236d1a6b8960f3bb44",
  "dirt-albedo-roughness.png":
    "fa96eddfdf4a089f34a48eb85feaea6082a360500348e28efd8c3ed4f2ec9dc6",
  "dirt-normal-ao.png":
    "70ea434b6df2b7bc072f6099511400134d68f934a9e31d66c9c09b0528a69caa",
  "rock-albedo-roughness.png":
    "6d60baa29999649c294f9f9bbbbf194e57841bd25a6e984b6a1284c0fb202ff1",
  "rock-normal-ao.png":
    "db544a21396d150c73afb6a51660ec441033aee96da2c05e33bd448ec33ffb78",
};

test("explicit source admission and installed-source default reject unknown options", () => {
  assert.deepEqual(parsePackingOptions([], null), {
    check: false,
    grassSource: "legacy",
    rockSource: "legacy",
  });
  const installed = {
    layers: {
      grass: { provenance: { assetId: "Grass004" } },
      rock: { provenance: { assetId: "rock_face_03" } },
    },
  };
  assert.deepEqual(parsePackingOptions(["--check"], installed), {
    check: true,
    grassSource: "grass004",
    rockSource: "rock-face-03",
  });
  assert.deepEqual(parsePackingOptions(["--grass-source=legacy"], installed), {
    check: false,
    grassSource: "legacy",
    rockSource: "rock-face-03",
  });
  assert.deepEqual(parsePackingOptions(["--rock-source=legacy"], installed), {
    check: false,
    grassSource: "grass004",
    rockSource: "legacy",
  });
  for (const args of [
    ["--grass-source=unknown"],
    ["--output=/tmp"],
    ["--check", "--check"],
    ["--grass-source=legacy", "--grass-source=grass004"],
    ["--rock-source=unknown"],
    ["--rock-source=legacy", "--rock-source=rock-face-03"],
  ]) {
    assert.throws(() => parsePackingOptions(args, installed));
  }
  assert.throws(() =>
    parsePackingOptions([], {
      layers: { grass: { provenance: { assetId: "unknown" } } },
    }),
  );
  assert.throws(() =>
    parsePackingOptions([], {
      layers: { rock: { provenance: { assetId: "unknown" } } },
    }),
  );
});

test("Rock Face 03 portable provenance rejects changed source facts and paths", () => {
  validateRockFace03Provenance(structuredClone(ROCK_FACE_03_PROVENANCE));
  for (const change of [
    (value) => {
      value.sources[0].publisherMd5 = "0".repeat(32);
    },
    (value) => {
      value.sources[2].pngBitDepth = 8;
    },
    (value) => {
      value.dimensionsMeters[0] = 3;
    },
    (value) => {
      value.sourceRoot = "/absolute/external/path";
    },
  ]) {
    const value = structuredClone(ROCK_FACE_03_PROVENANCE);
    change(value);
    assert.throws(
      () => validateRockFace03Provenance(value),
      /Rock Face 03 provenance mismatch/,
    );
  }
});

test("portable provenance rejects changed source facts or undeclared external paths", () => {
  validateGrass004Provenance(structuredClone(GRASS004_PROVENANCE));
  for (const change of [
    (value) => {
      value.archive.sha1 = "0".repeat(40);
    },
    (value) => {
      value.sources[2].pngBitDepth = 8;
    },
    (value) => {
      value.dimensionsMeters[0] = 2;
    },
    (value) => {
      value.sourceRoot = "/absolute/external/path";
    },
  ]) {
    const value = structuredClone(GRASS004_PROVENANCE);
    change(value);
    assert.throws(
      () => validateGrass004Provenance(value),
      /Grass004 provenance mismatch/,
    );
  }
});

test("retained original PNGs match exact source pins and reject same-size corruption", async () => {
  for (const [index, source] of GRASS004_PROVENANCE.sources.entries()) {
    const bytes = await readFile(
      new URL(`terrain/textures/ambientcg-grass004/${source.name}`, assetRoot),
    );
    validateGrass004Source(bytes, index);
    const copy = Buffer.from(bytes);
    copy[copy.length - 1] ^= 1;
    assert.throws(() => validateGrass004Source(copy, index));
    assert.equal(sha256(bytes), source.sha256);
    assert.throws(() =>
      validateGrass004Source(bytes.subarray(0, bytes.length - 1), index),
    );
  }
});

test("real source packing reproduces all legacy maps and exact prepared Grass004 bytes", async () => {
  const legacy = await buildPackedTerrain("legacy");
  const candidate = await buildPackedTerrain("grass004");
  for (const [name, hash] of Object.entries(oldOutputs)) {
    assert.equal(sha256(legacy.files.get(name)), hash, name);
    if (!name.startsWith("grass-")) {
      assert.deepEqual(
        candidate.files.get(name),
        legacy.files.get(name),
        `${name} unchanged`,
      );
      if (name.startsWith("dirt-"))
        assert.deepEqual(
          await readFile(new URL(name, packedRoot)),
          legacy.files.get(name),
        );
    }
  }
  assert.deepEqual(candidate.manifest.layers.dirt, legacy.manifest.layers.dirt);
  assert.deepEqual(candidate.manifest.layers.rock, legacy.manifest.layers.rock);
  assert.equal(
    sha256(candidate.files.get("grass-albedo-roughness.png")),
    "689bba1fa129397f928b51dc79ac283898af82a376b34eeeb09d1e01d1a234ad",
  );
  assert.equal(
    sha256(candidate.files.get("grass-normal-ao.png")),
    "c87450fc7ecdccf4095ff81aeeb5f81af28710b4976a1cd9bfc3a6c8e884a793",
  );
  assert.deepEqual(
    candidate.manifest.layers.grass.diffuseLinearMean,
    [0.12687350988906373, 0.16117143469264922, 0.03425721790414253],
  );
  assert.equal(candidate.manifest.schemaVersion, 2);
  assert.equal(candidate.manifest.layers.grass.sources[2].pngBitDepth, 16);
  for (const [name, bytes] of candidate.files)
    if (name.startsWith("grass-"))
      assert.deepEqual(await readFile(new URL(name, packedRoot)), bytes, name);
  const albedo = decodePng(candidate.files.get("grass-albedo-roughness.png"));
  const normals = decodePng(candidate.files.get("grass-normal-ao.png"));
  const originals = await Promise.all(
    GRASS004_PROVENANCE.sources.map(async (source) =>
      decodePng(
        await readFile(
          new URL(
            `terrain/textures/ambientcg-grass004/${source.name}`,
            assetRoot,
          ),
        ),
      ),
    ),
  );
  let nonWhiteAo = 0;
  for (let p = 0; p < albedo.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      assert.equal(albedo.data[p + c], originals[0].data[p + c]);
      assert.equal(normals.data[p + c], originals[2].data[p + c]);
    }
    assert.equal(albedo.data[p + 3], originals[1].data[p]);
    assert.equal(normals.data[p + 3], originals[3].data[p]);
    if (normals.data[p + 3] !== 255) nonWhiteAo++;
  }
  assert(
    nonWhiteAo > 0,
    "Actual source AO is retained, not substituted with 255",
  );
});

test("Rock Face 03 retains exact originals, non-color rescaling and every packed channel", async () => {
  const previous = await buildPackedTerrain("grass004");
  const candidate = await buildPackedTerrain("grass004", "rock-face-03");
  assert.equal(candidate.manifest.schemaVersion, 3);
  for (const layer of ["grass", "dirt"])
    assert.deepEqual(
      candidate.manifest.layers[layer],
      previous.manifest.layers[layer],
    );
  for (const [name, bytes] of candidate.files) {
    assert.deepEqual(await readFile(new URL(name, packedRoot)), bytes, name);
    if (/^(grass|dirt)-/.test(name))
      assert.deepEqual(bytes, previous.files.get(name));
  }
  assert.deepEqual(
    candidate.manifest.layers.rock.diffuseLinearMean,
    [0.2327181410040423, 0.14549203474325217, 0.08365218395286236],
  );
  const originals = [];
  for (const [index, source] of ROCK_FACE_03_PROVENANCE.sources.entries()) {
    const bytes = await readFile(
      new URL(
        `terrain/textures/polyhaven-rock-face-03/${source.name}`,
        assetRoot,
      ),
    );
    validateRockFace03Source(bytes, index);
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1] ^= 1;
    assert.throws(() => validateRockFace03Source(corrupted, index));
    assert.throws(() =>
      validateRockFace03Source(bytes.subarray(0, bytes.length - 1), index),
    );
    assert.throws(() => validateRockFace03Source(bytes, 4));
    const decoded = decodePng(bytes);
    // Same decoder with its rescale disabled: qualifies quantization, not an
    // independent decoder. ICC/gamma must not alter color or vector/scalar data.
    const raw16 = PNG.sync.read(bytes, { skipRescale: true });
    assert(raw16.data instanceof Uint16Array);
    assert.equal(decoded.data.length, raw16.data.length);
    for (let p = 0; p < decoded.data.length; p++)
      assert.equal(
        decoded.data[p],
        Math.floor((raw16.data[p] * 255) / 65535 + 0.5),
      );
    originals.push(decoded);
  }
  const albedo = decodePng(candidate.files.get("rock-albedo-roughness.png"));
  const normal = decodePng(candidate.files.get("rock-normal-ao.png"));
  for (let p = 0; p < albedo.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      assert.equal(albedo.data[p + c], originals[0].data[p + c]);
      assert.equal(normal.data[p + c], originals[2].data[p + c]);
    }
    assert.equal(albedo.data[p + 3], originals[1].data[p]);
    assert.equal(normal.data[p + 3], originals[3].data[p]);
  }
  for (const name of ["rock-albedo-roughness.png", "rock-normal-ao.png"]) {
    const bytes = candidate.files.get(name);
    const chunks = [];
    for (
      let offset = 8;
      offset < bytes.length;
      offset += bytes.readUInt32BE(offset) + 12
    )
      chunks.push(bytes.toString("ascii", offset + 4, offset + 8));
    assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
  }
  assert.equal(
    sha256(candidate.files.get("rock-albedo-roughness.png")),
    "97f2d36833a7ce119d021cfa9728c42d292044297b172772c02f07f34403311a",
  );
  assert.equal(
    sha256(candidate.files.get("rock-normal-ao.png")),
    "056c1754f2e2315a22480025ffe798497d6674fc76b05d8c7f42b3c928268aa4",
  );
});

test("ordinary CLI --check follows installed sources and does not rewrite any output", async () => {
  const names = [...Object.keys(oldOutputs), "packing-manifest.json"];
  const before = await Promise.all(
    names.map(async (name) => ({
      name,
      hash: sha256(await readFile(new URL(name, packedRoot))),
      mtime: (await stat(new URL(name, packedRoot))).mtimeMs,
    })),
  );
  const { stdout } = await execute(
    process.execPath,
    [
      new URL("./pack-compact-terrain-textures.mjs", import.meta.url).pathname,
      "--check",
    ],
    { timeout: 15000 },
  );
  assert.match(stdout, /verified.*grass=grass004, rock=rock-face-03/);
  for (const receipt of before) {
    assert.equal(
      sha256(await readFile(new URL(receipt.name, packedRoot))),
      receipt.hash,
    );
    assert.equal(
      (await stat(new URL(receipt.name, packedRoot))).mtimeMs,
      receipt.mtime,
    );
  }
});
