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
  POLYHAVEN_DIRT_PROVENANCE,
  ROCK_FACE_03_PROVENANCE,
  parsePackingOptions,
  validateGrass004Provenance,
  validateGrass004Source,
  validatePolyhavenDirtProvenance,
  validatePolyhavenDirtSource,
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
    dirtSource: "legacy",
  });
  const installed = {
    layers: {
      grass: { provenance: { assetId: "Grass004" } },
      rock: { provenance: { assetId: "rock_face_03" } },
      dirt: { provenance: { assetId: "dirt" } },
    },
  };
  assert.deepEqual(parsePackingOptions(["--check"], installed), {
    check: true,
    grassSource: "grass004",
    rockSource: "rock-face-03",
    dirtSource: "polyhaven-dirt",
  });
  assert.deepEqual(parsePackingOptions(["--grass-source=legacy"], installed), {
    check: false,
    grassSource: "legacy",
    rockSource: "rock-face-03",
    dirtSource: "polyhaven-dirt",
  });
  assert.deepEqual(parsePackingOptions(["--rock-source=legacy"], installed), {
    check: false,
    grassSource: "grass004",
    rockSource: "legacy",
    dirtSource: "polyhaven-dirt",
  });
  assert.deepEqual(parsePackingOptions(["--dirt-source=legacy"], installed), {
    check: false,
    grassSource: "grass004",
    rockSource: "rock-face-03",
    dirtSource: "legacy",
  });
  assert.deepEqual(
    parsePackingOptions(["--dirt-source=polyhaven-dirt"], null),
    {
      check: false,
      grassSource: "legacy",
      rockSource: "legacy",
      dirtSource: "polyhaven-dirt",
    },
  );
  assert.deepEqual(
    parsePackingOptions([], {
      layers: { grass: installed.layers.grass, rock: installed.layers.rock },
    }),
    {
      check: false,
      grassSource: "grass004",
      rockSource: "rock-face-03",
      dirtSource: "legacy",
    },
  );
  for (const args of [
    ["--grass-source=unknown"],
    ["--output=/tmp"],
    ["--check", "--check"],
    ["--grass-source=legacy", "--grass-source=grass004"],
    ["--rock-source=unknown"],
    ["--rock-source=legacy", "--rock-source=rock-face-03"],
    ["--dirt-source=unknown"],
    ["--dirt-source="],
    ["--dirt-source=legacy", "--dirt-source=polyhaven-dirt"],
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
  assert.throws(() =>
    parsePackingOptions([], {
      layers: { dirt: { provenance: { assetId: "unknown" } } },
    }),
  );
});

test("Poly Haven Dirt portable provenance pins physical source facts and rejects metadata changes", () => {
  assert.equal(POLYHAVEN_DIRT_PROVENANCE.assetId, "dirt");
  assert.equal(POLYHAVEN_DIRT_PROVENANCE.provider, "Poly Haven");
  assert.equal(
    POLYHAVEN_DIRT_PROVENANCE.sourcePage,
    "https://polyhaven.com/a/dirt",
  );
  assert.equal(POLYHAVEN_DIRT_PROVENANCE.license, "CC0-1.0");
  assert.deepEqual(POLYHAVEN_DIRT_PROVENANCE.dimensionsMeters, [2, 2]);
  assert.deepEqual(
    POLYHAVEN_DIRT_PROVENANCE.sources.map((source) => [
      source.name,
      source.sha256,
    ]),
    [
      [
        "dirt_diff_1k.png",
        "96b3eb441121c41806a4766f37eeeeb4667af73207ccd8bfb56bbd446a221d42",
      ],
      [
        "dirt_rough_1k.png",
        "29f68a8972f1e69cf47e67924efe469350f953a5f707f63633a9c36cd7c63f6a",
      ],
      [
        "dirt_nor_gl_1k.png",
        "be315cdb7667d58df160a92be2b22423480912ac5668188f3c8360d464203f47",
      ],
      [
        "dirt_ao_1k.png",
        "00981482d9b57c3da11417e7a19c751bfdb58c1fec51d695fa391eaab72a1500",
      ],
    ],
  );
  validatePolyhavenDirtProvenance(structuredClone(POLYHAVEN_DIRT_PROVENANCE));
  for (const change of [
    (value) => {
      value.assetId = "rock_face_03";
    },
    (value) => {
      value.license = "unknown";
    },
    (value) => {
      value.sources[0].publisherMd5 = "0".repeat(32);
    },
    (value) => {
      value.sources[0].bytes--;
    },
    (value) => {
      value.sources[2].pngBitDepth = 8;
    },
    (value) => {
      value.sources[1].pngColorType = 2;
    },
    (value) => {
      value.sources[2].officialUrl =
        "https://example.invalid/dirt_nor_dx_1k.png";
    },
    (value) => {
      value.sources.reverse();
    },
    (value) => {
      value.sources.pop();
    },
    (value) => {
      value.dimensionsMeters[0] = 1;
    },
    (value) => {
      value.sourceRoot = "/absolute/external/path";
    },
  ]) {
    const value = structuredClone(POLYHAVEN_DIRT_PROVENANCE);
    change(value);
    assert.throws(() => validatePolyhavenDirtProvenance(value));
  }
  for (const value of [null, {}, []])
    assert.throws(() => validatePolyhavenDirtProvenance(value));
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
  assert.equal(legacy.manifest.schemaVersion, 1);
  for (const [name, hash] of Object.entries(oldOutputs)) {
    assert.equal(sha256(legacy.files.get(name)), hash, name);
    if (!name.startsWith("grass-")) {
      assert.deepEqual(
        candidate.files.get(name),
        legacy.files.get(name),
        `${name} unchanged`,
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
    if (/^(grass|rock)-/.test(name))
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

test("Poly Haven Dirt preserves legacy selection and exact installed decoded-channel packing", async () => {
  await assert.rejects(() =>
    buildPackedTerrain("grass004", "rock-face-03", "unknown"),
  );
  const previous = await buildPackedTerrain(
    "grass004",
    "rock-face-03",
    "legacy",
  );
  const candidate = await buildPackedTerrain(
    "grass004",
    "rock-face-03",
    "polyhaven-dirt",
  );
  assert.equal(previous.manifest.schemaVersion, 3);
  assert.equal(candidate.manifest.schemaVersion, 4);
  assert.deepEqual(
    [...candidate.files.keys()].sort(),
    [...Object.keys(oldOutputs), "packing-manifest.json"].sort(),
  );
  for (const layer of ["grass", "rock"])
    assert.deepEqual(
      candidate.manifest.layers[layer],
      previous.manifest.layers[layer],
    );
  for (const [name, bytes] of candidate.files) {
    assert.deepEqual(await readFile(new URL(name, packedRoot)), bytes, name);
    if (/^(grass|rock)-/.test(name))
      assert.deepEqual(bytes, previous.files.get(name), `${name} unchanged`);
  }
  for (const name of ["dirt-albedo-roughness.png", "dirt-normal-ao.png"])
    assert.equal(
      sha256(previous.files.get(name)),
      oldOutputs[name],
      `${name} legacy still reproducible`,
    );
  assert.equal(
    Object.hasOwn(previous.manifest.layers.dirt, "provenance"),
    false,
  );
  assert.deepEqual(
    candidate.manifest.layers.dirt.diffuseLinearMean,
    [0.1258525186051025, 0.08567628015146961, 0.0490416307568836],
  );
  assert.deepEqual(candidate.manifest.layers.dirt.provenance, {
    ...POLYHAVEN_DIRT_PROVENANCE,
    path: "terrain/textures/polyhaven-dirt/provenance.json",
    sourcePathBase: "assets-root",
  });
  validatePolyhavenDirtProvenance(
    JSON.parse(
      await readFile(
        new URL("terrain/textures/polyhaven-dirt/provenance.json", assetRoot),
        "utf8",
      ),
    ),
  );
  const originals = [];
  for (const [index, source] of POLYHAVEN_DIRT_PROVENANCE.sources.entries()) {
    const bytes = await readFile(
      new URL(`terrain/textures/polyhaven-dirt/${source.name}`, assetRoot),
    );
    validatePolyhavenDirtSource(bytes, index);
    assert.equal(sha256(bytes), source.sha256);
    assert.equal(bytes.length, source.bytes);
    assert.equal(
      createHash("md5").update(bytes).digest("hex"),
      source.publisherMd5,
    );
    assert.equal(bytes[24], 16);
    assert.equal(bytes[25], [2, 0, 2, 0][index]);
    assert.deepEqual(candidate.manifest.layers.dirt.sources[index], {
      path: `terrain/textures/polyhaven-dirt/${source.name}`,
      sha256: source.sha256,
      bytes: source.bytes,
      pngBitDepth: 16,
    });
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1] ^= 1;
    assert.throws(() => validatePolyhavenDirtSource(corrupted, index));
    assert.throws(() =>
      validatePolyhavenDirtSource(bytes.subarray(0, bytes.length - 1), index),
    );
    assert.throws(() => validatePolyhavenDirtSource(bytes, (index + 1) % 4));
    for (const invalidIndex of [-1, 4, 0.5, NaN])
      assert.throws(() => validatePolyhavenDirtSource(bytes, invalidIndex));
    const decoded = decodePng(bytes);
    assert.equal(decoded.width, 1024);
    assert.equal(decoded.height, 1024);
    // The real decoder with rescaling disabled qualifies its 16-to-8 conversion,
    // not a second independent decoder or GPU appearance/roughness behavior.
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
  const albedo = decodePng(candidate.files.get("dirt-albedo-roughness.png"));
  const normal = decodePng(candidate.files.get("dirt-normal-ao.png"));
  let nonWhiteAo = 0;
  for (let p = 0; p < albedo.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      assert.equal(albedo.data[p + c], originals[0].data[p + c]);
      assert.equal(normal.data[p + c], originals[2].data[p + c]);
    }
    assert.equal(albedo.data[p + 3], originals[1].data[p]);
    assert.equal(normal.data[p + 3], originals[3].data[p]);
    if (normal.data[p + 3] !== 255) nonWhiteAo++;
  }
  assert(nonWhiteAo > 0, "Actual Dirt AO retained, not replaced with 255");
  for (const [name, expectedHash] of [
    [
      "dirt-albedo-roughness.png",
      "357b327ed327304b25193ce2a3924bf71b139764e93411a54b8c7469a296baef",
    ],
    [
      "dirt-normal-ao.png",
      "5e860d999d7d9545740fa12dbff729b2b9233b22179f46e46c6fd2f5facca7d3",
    ],
  ]) {
    const bytes = candidate.files.get(name);
    assert.equal(sha256(bytes), expectedHash, name);
    assert.equal(bytes[24], 8);
    assert.equal(bytes[25], 6);
    const chunks = [];
    for (
      let offset = 8;
      offset < bytes.length;
      offset += bytes.readUInt32BE(offset) + 12
    )
      chunks.push(bytes.toString("ascii", offset + 4, offset + 8));
    assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
  }
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
  assert.match(
    stdout,
    /verified.*grass=grass004, rock=rock-face-03, dirt=polyhaven-dirt/,
  );
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
