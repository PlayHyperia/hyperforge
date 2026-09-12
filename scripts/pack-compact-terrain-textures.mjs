import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(repo, "packages/server/world/assets");
const output = path.join(assets, "terrain/textures/compact-pbr");
const inputs = {
  grass: [
    "stylized_grass/stylized_grass_d.png",
    "stylized_grass/stylized_grass_r.png",
    "stylized_grass/stylized_grass_n.png",
    null,
  ],
  dirt: [
    "dirt_ground/dirt_ground_d.png",
    "dirt_ground/dirt_ground_r.png",
    "dirt_ground/dirt_ground_n.png",
    "dirt_ground/dirt_ground_ao.png",
  ],
  rock: [
    "rock/rock_d.png",
    "rock/rock__r.png",
    "rock/rock_n.png",
    "rock/rock_ao.png",
  ],
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const grass004Directory = "terrain/textures/ambientcg-grass004";
export const GRASS004_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  assetId: "Grass004",
  provider: "ambientCG",
  sourcePage: "https://ambientcg.com/view?id=Grass004",
  license: "CC0-1.0",
  licensePage: "https://docs.ambientcg.com/license/",
  technique: "surface-fully-procedural",
  dimensionsMeters: [1.4, 1.4],
  metadataUrl:
    "https://ambientcg.com/api/v3/assets?id=Grass004&include=downloads,dimensions,maps,technique,title&limit=1",
  metadataSha256:
    "543be0d8e11775343b15954ccc30677304e2db01b088e744604da29e0d8218d7",
  archive: {
    name: "Grass004_1K-PNG.zip",
    bytes: 19597533,
    officialUrl: "https://ambientcg.com/get?file=Grass004_1K-PNG.zip",
    finalUrl:
      "https://acg-download.struffelproductions.com/file/ambientCG-Web/download/Grass004_8f7ZrdgN/Grass004_1K-PNG.zip",
    sha1: "5738ec75932a2d565f16326ec0a73ec4f6576f38",
    sha256: "9bdb8a28536f437e910824096dd8a3d8276d5186a27ad067dea4e2e762a6981b",
    digestProvenance:
      "SHA1 matched official download-host HEAD x-bz-content-sha1. SHA256 was computed locally; it is not an independent publisher signature. API confirms archive name/size, not hashes or member names.",
  },
  sources: [
    {
      name: "Grass004_1K-PNG_Color.png",
      bytes: 2233725,
      sha256:
        "1c504b956e5550fedd8822e7e2135fe45f513bc1212f72ed67885de1002fabb6",
      pngBitDepth: 8,
    },
    {
      name: "Grass004_1K-PNG_Roughness.png",
      bytes: 826778,
      sha256:
        "c3bac30c64d246019e80dd6448544ac381706d43eb583e5ac875cb4f6eece6d8",
      pngBitDepth: 8,
    },
    {
      name: "Grass004_1K-PNG_NormalGL.png",
      bytes: 5986739,
      sha256:
        "a6fce3c4f2c5d486b5c993bf47b47ce9d4c1dbb04ecef424ad2c0b703715c3c6",
      pngBitDepth: 16,
    },
    {
      name: "Grass004_1K-PNG_AmbientOcclusion.png",
      bytes: 880694,
      sha256:
        "2b90f33cb488385e18d698b6d8e8c649116ebc7478bf7dbd5d08214884adabaf",
      pngBitDepth: 8,
    },
  ],
  precision:
    "Original PNG bytes retained. Existing pngjs decode produces RGBA8, including 16-to-8-bit NormalGL quantization. Packing preserves decoded channels, not original 16-bit normal precision.",
  qualification:
    "Isolated source and channel-packing verification only; native appearance, mips, normal quality and performance are not approved by this provenance record.",
});
const grass004OutputHashes = {
  albedoRoughness:
    "689bba1fa129397f928b51dc79ac283898af82a376b34eeeb09d1e01d1a234ad",
  normalAo: "c87450fc7ecdccf4095ff81aeeb5f81af28710b4976a1cd9bfc3a6c8e884a793",
};
const rockFace03Directory = "terrain/textures/polyhaven-rock-face-03";
export const ROCK_FACE_03_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  assetId: "rock_face_03",
  provider: "Poly Haven",
  sourcePage: "https://polyhaven.com/a/rock_face_03",
  license: "CC0-1.0",
  licensePage: "https://polyhaven.com/license",
  technique: "photographed-surface",
  authors: { "Dario Barresi": "Photography", "Rico Cilliers": "Processing" },
  dimensionsMeters: [2.7, 2.7],
  infoApi: "https://api.polyhaven.com/info/rock_face_03",
  filesApi: "https://api.polyhaven.com/files/rock_face_03",
  sourceObservationSha256:
    "9002936c2d60bb3c9f0993491a9854c753da9f12fdbcaa81c1a6186242be22e2",
  digestProvenance:
    "Byte sizes and MD5 matched the official files API. SHA256 was computed locally; it is not an independent publisher signature.",
  sources: [
    {
      name: "rock_face_03_diff_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/rock_face_03/rock_face_03_diff_1k.png",
      bytes: 5693797,
      publisherMd5: "9c0e0f8a40d9bde94b4e92fa5574648a",
      sha256:
        "6f3be181a09c1489e9a355f86810bcfe5e43e4de9f9e21648cef51fa68220f91",
      pngBitDepth: 16,
      pngColorType: 2,
    },
    {
      name: "rock_face_03_rough_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/rock_face_03/rock_face_03_rough_1k.png",
      bytes: 1861487,
      publisherMd5: "f0882d41a7a4158c95efb93ce353b0b1",
      sha256:
        "2c16f7644044eddb090113f7ac549e8ac8ab44b5b963437ae702075f617ad3dd",
      pngBitDepth: 16,
      pngColorType: 0,
    },
    {
      name: "rock_face_03_nor_gl_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/rock_face_03/rock_face_03_nor_gl_1k.png",
      bytes: 5841646,
      publisherMd5: "17a4feb957478ce571e1146c1e278e31",
      sha256:
        "69cb133b4c6e7d046820bf5d1642dde3bbbaa56e5d4c889992ba251db8cf5218",
      pngBitDepth: 16,
      pngColorType: 2,
    },
    {
      name: "rock_face_03_ao_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/rock_face_03/rock_face_03_ao_1k.png",
      bytes: 1878514,
      publisherMd5: "991616fef343261657cc8bdc16c08222",
      sha256:
        "761351f720b452fd3c89171014fe36696379dde62c29f67990ccc48bd077420b",
      pngBitDepth: 16,
      pngColorType: 0,
    },
  ],
  precision:
    "Original unsigned 16-bit PNG bytes retained. pngjs rounds each sample to RGBA8 before exact channel packing; this quantization is lossy. No ICC/gamma transform, normal normalization, resampling, premultiplication or orientation change. Diffuse RGB remains encoded sRGB; normal RGB, roughness and AO remain linear non-color data despite original profile tags. Derivative PNGs contain no color-profile chunks.",
  qualification:
    "Exact source and decoded-channel packing qualification only; native appearance, repeats, mips, normal response, motion and GPU performance require separate evidence.",
});
const rockFace03OutputHashes = {
  albedoRoughness:
    "97f2d36833a7ce119d021cfa9728c42d292044297b172772c02f07f34403311a",
  normalAo: "056c1754f2e2315a22480025ffe798497d6674fc76b05d8c7f42b3c928268aa4",
};

export function validateRockFace03Source(bytes, index) {
  const source = ROCK_FACE_03_PROVENANCE.sources[index];
  assert(source, "Unknown Rock Face 03 source role");
  assert.equal(bytes.length, source.bytes, source.name);
  assert.equal(sha256(bytes), source.sha256, source.name);
  assert.equal(
    createHash("md5").update(bytes).digest("hex"),
    source.publisherMd5,
    source.name,
  );
  assert.equal(bytes[24], source.pngBitDepth, source.name);
  assert.equal(bytes[25], source.pngColorType, source.name);
}

export function validateRockFace03Provenance(value) {
  assert.deepEqual(
    value,
    ROCK_FACE_03_PROVENANCE,
    "Rock Face 03 provenance mismatch",
  );
}

export function validateGrass004Source(bytes, index) {
  const source = GRASS004_PROVENANCE.sources[index];
  assert(source, "Unknown Grass004 source role");
  assert.equal(bytes.length, source.bytes, source.name);
  assert.equal(sha256(bytes), source.sha256, source.name);
  assert.equal(bytes[24], source.pngBitDepth, source.name);
}

export function validateGrass004Provenance(value) {
  assert.deepEqual(value, GRASS004_PROVENANCE, "Grass004 provenance mismatch");
}

export function parsePackingOptions(args, installedManifest) {
  let check = false;
  let grassSource;
  let rockSource;
  for (const arg of args) {
    if (arg === "--check") {
      assert(!check, "Duplicate --check");
      check = true;
    } else if (arg.startsWith("--grass-source=")) {
      assert(!grassSource, "Duplicate grass source");
      grassSource = arg.slice("--grass-source=".length);
      assert(
        ["legacy", "grass004"].includes(grassSource),
        "Unknown grass source",
      );
    } else if (arg.startsWith("--rock-source=")) {
      assert(!rockSource, "Duplicate rock source");
      rockSource = arg.slice("--rock-source=".length);
      assert(
        ["legacy", "rock-face-03"].includes(rockSource),
        "Unknown rock source",
      );
    } else {
      assert.fail(`Unknown option: ${arg}`);
    }
  }
  if (!grassSource) {
    const id = installedManifest?.layers?.grass?.provenance?.assetId;
    assert(
      id === undefined || id === "Grass004",
      "Unknown installed grass source",
    );
    grassSource = id === "Grass004" ? "grass004" : "legacy";
  }
  if (!rockSource) {
    const id = installedManifest?.layers?.rock?.provenance?.assetId;
    assert(
      id === undefined || id === "rock_face_03",
      "Unknown installed rock source",
    );
    rockSource = id === "rock_face_03" ? "rock-face-03" : "legacy";
  }
  return { check, grassSource, rockSource };
}

// Some original files have exporter data after PNG IEND. Hash the full source,
// but decode its complete PNG stream; pngjs checks its chunk CRCs normally.
export function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    assert.ok(end <= bytes.length, "Truncated PNG chunk");
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IEND") {
      assert.equal(length, 0);
      return PNG.sync.read(bytes.subarray(0, end));
    }
    offset = end;
  }
  throw new Error("PNG has no complete IEND");
}

/** Lossless channel packing only: no recoloring, resampling or inferred normals. */
export function packSurfaceMaps(diffuse, roughness, normal, ao = null) {
  const { width, height } = diffuse;
  assert.equal(width, 1024);
  assert.equal(height, 1024);
  for (const source of [diffuse, roughness, normal, ao].filter(Boolean)) {
    assert.equal(source.width, width);
    assert.equal(source.height, height);
    assert.equal(source.data.length, width * height * 4);
  }
  const albedoRoughness = new PNG({ width, height });
  const normalAo = new PNG({ width, height });
  for (let p = 0; p < diffuse.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      albedoRoughness.data[p + c] = diffuse.data[p + c];
      normalAo.data[p + c] = normal.data[p + c];
    }
    assert.equal(roughness.data[p], roughness.data[p + 1]);
    assert.equal(roughness.data[p], roughness.data[p + 2]);
    albedoRoughness.data[p + 3] = roughness.data[p];
    if (ao) {
      assert.equal(ao.data[p], ao.data[p + 1]);
      assert.equal(ao.data[p], ao.data[p + 2]);
    }
    normalAo.data[p + 3] = ao ? ao.data[p] : 255;
  }
  return { albedoRoughness, normalAo };
}

// Read-only generation: all sources and outputs validate before main writes.
// Legacy bytes remain reproducible with both sources explicitly set to legacy.
// The function's default rock source preserves its historical one-argument API.
export async function buildPackedTerrain(grassSource, rockSource = "legacy") {
  assert(["legacy", "grass004"].includes(grassSource), "Unknown grass source");
  assert(
    ["legacy", "rock-face-03"].includes(rockSource),
    "Unknown rock source",
  );
  const candidate = grassSource === "grass004";
  const rockCandidate = rockSource === "rock-face-03";
  const manifest = {
    schemaVersion: 1,
    operation: "Lossless RGBA channel packing; originals retained unchanged.",
    albedoRoughness:
      "RGB original diffuse (sRGB); alpha original scalar roughness (linear).",
    normalAo:
      "RGB original tangent normal (linear); alpha original AO (linear), or 255 where absent.",
    orientation:
      "Original pixel order retained for all channels. Runtime uses identical UVs and flipY for each pair.",
    metallic: 0,
    provenance:
      "Existing repository terrain materials; this conversion does not assert a new license or scan-quality provenance.",
    layers: {},
  };
  if (candidate) {
    validateGrass004Provenance(
      JSON.parse(
        await readFile(
          path.join(assets, grass004Directory, "provenance.json"),
          "utf8",
        ),
      ),
    );
    manifest.schemaVersion = 2;
    manifest.operation =
      "RGBA8 channel packing; original PNG bytes retained unchanged. Grass004 NormalGL is decoded from 16-bit to 8-bit before packing.";
    manifest.provenance =
      "Grass: ambientCG Grass004 CC0-1.0, procedural, approximately 1.4m square; see portable per-layer provenance. Dirt/rock: unchanged existing repository terrain materials, without a new license or scan-quality assertion.";
  }
  if (rockCandidate) {
    validateRockFace03Provenance(
      JSON.parse(
        await readFile(
          path.join(assets, rockFace03Directory, "provenance.json"),
          "utf8",
        ),
      ),
    );
    manifest.schemaVersion = 3;
    manifest.operation =
      "RGBA8 channel packing; original PNG bytes retained unchanged. Rock Face 03 maps and any Grass004 NormalGL are quantized from 16-bit to 8-bit before exact decoded-channel packing.";
    manifest.provenance = `Rock: Poly Haven Rock Face 03 CC0-1.0, photographed surface, approximately 2.7m square; see portable per-layer provenance. ${candidate ? "Grass: ambientCG Grass004 CC0-1.0, procedural, approximately 1.4m square; see portable per-layer provenance." : "Grass: unchanged existing repository terrain material, without a new license or scan-quality assertion."} Dirt: unchanged existing repository terrain material, without a new license or scan-quality assertion.`;
  }
  const files = new Map();
  for (const [layer, names] of Object.entries(inputs)) {
    const selected =
      candidate && layer === "grass"
        ? GRASS004_PROVENANCE.sources.map(
            (source) => `${grass004Directory}/${source.name}`,
          )
        : rockCandidate && layer === "rock"
          ? ROCK_FACE_03_PROVENANCE.sources.map(
              (source) => `${rockFace03Directory}/${source.name}`,
            )
          : names.map((name) => (name ? `terrain/textures/${name}` : null));
    const sources = await Promise.all(
      selected.map(async (name, index) => {
        if (!name) return null;
        const bytes = await readFile(path.join(assets, name));
        if (candidate && layer === "grass")
          validateGrass004Source(bytes, index);
        if (rockCandidate && layer === "rock")
          validateRockFace03Source(bytes, index);
        return {
          path: name,
          sha256: sha256(bytes),
          image: decodePng(bytes),
        };
      }),
    );
    const packed = packSurfaceMaps(
      ...sources.map((source) => source?.image ?? null),
    );
    const linearMean = [0, 0, 0];
    for (let p = 0; p < packed.albedoRoughness.data.length; p += 4) {
      for (let c = 0; c < 3; c++) {
        const value = packed.albedoRoughness.data[p + c] / 255;
        linearMean[c] +=
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }
    }
    for (let c = 0; c < 3; c++)
      linearMean[c] /=
        packed.albedoRoughness.width * packed.albedoRoughness.height;
    const outputs = {};
    for (const [kind, image] of Object.entries(packed)) {
      const name = `${layer}-${kind === "albedoRoughness" ? "albedo-roughness" : "normal-ao"}.png`;
      const bytes = PNG.sync.write(image, { colorType: 6, inputColorType: 6 });
      assert.deepEqual(
        decodePng(bytes).data,
        image.data,
        `${name} pixel round trip`,
      );
      if (candidate && layer === "grass")
        assert.equal(
          sha256(bytes),
          grass004OutputHashes[kind],
          `Prepared ${name} mismatch`,
        );
      if (rockCandidate && layer === "rock")
        assert.equal(
          sha256(bytes),
          rockFace03OutputHashes[kind],
          `Prepared ${name} mismatch`,
        );
      files.set(name, bytes);
      outputs[kind] = {
        path: `terrain/textures/compact-pbr/${name}`,
        sha256: sha256(bytes),
        bytes: bytes.length,
      };
    }
    manifest.layers[layer] = {
      sources: sources.map((source) =>
        source ? { path: source.path, sha256: source.sha256 } : null,
      ),
      diffuseLinearMean: linearMean,
      outputs,
    };
    if (candidate && layer === "grass") {
      manifest.layers.grass.sources.forEach((source, index) => {
        source.bytes = GRASS004_PROVENANCE.sources[index].bytes;
        source.pngBitDepth = GRASS004_PROVENANCE.sources[index].pngBitDepth;
      });
      manifest.layers.grass.provenance = {
        ...GRASS004_PROVENANCE,
        path: `${grass004Directory}/provenance.json`,
        sourcePathBase: "assets-root",
      };
    }
    if (rockCandidate && layer === "rock") {
      manifest.layers.rock.sources.forEach((source, index) => {
        source.bytes = ROCK_FACE_03_PROVENANCE.sources[index].bytes;
        source.pngBitDepth = ROCK_FACE_03_PROVENANCE.sources[index].pngBitDepth;
      });
      manifest.layers.rock.provenance = {
        ...ROCK_FACE_03_PROVENANCE,
        path: `${rockFace03Directory}/provenance.json`,
        sourcePathBase: "assets-root",
      };
    }
  }
  const receipt = `${JSON.stringify(manifest, null, 2)}\n`;
  files.set("packing-manifest.json", Buffer.from(receipt));
  return { manifest, files };
}

async function readOptional(filename) {
  try {
    return await readFile(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const installed = await readOptional(
    path.join(output, "packing-manifest.json"),
  );
  const installedManifest = installed ? JSON.parse(installed) : null;
  const installedSources = parsePackingOptions([], installedManifest);
  const { check, grassSource, rockSource } = parsePackingOptions(
    process.argv.slice(2),
    installedManifest,
  );
  const { files } = await buildPackedTerrain(grassSource, rockSource);
  const previous = new Map();
  for (const [name, bytes] of files) {
    const existing = await readOptional(path.join(output, name));
    previous.set(name, existing);
    // Unselected layers must remain byte-identical, never silently regenerated.
    const unchangedLayer =
      name.startsWith("dirt-") ||
      (name.startsWith("grass-") &&
        grassSource === installedSources.grassSource) ||
      (name.startsWith("rock-") && rockSource === installedSources.rockSource);
    if (check || (installed && unchangedLayer))
      assert.deepEqual(
        existing,
        bytes,
        `${name} ${check ? "check" : "preservation"}`,
      );
  }
  if (!check) {
    await mkdir(output, { recursive: true });
    for (const [name, bytes] of files) {
      if (!previous.get(name)?.equals(bytes))
        await writeFile(path.join(output, name), bytes);
    }
  }
  console.log(
    `Compact terrain packing ${check ? "verified" : "generated"}: 6 RGBA8 maps, grass=${grassSource}, rock=${rockSource}, original source hashes retained.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
