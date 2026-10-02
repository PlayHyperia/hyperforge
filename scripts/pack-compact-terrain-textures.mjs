import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { read as readKtx } from "three/addons/libs/ktx-parse.module.js";

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
const execute = promisify(execFile);
export const UASTC_CANDIDATE = Object.freeze({
  id: "uastc-v1",
  version: "v4.4.2",
  packageUrl:
    "https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Darwin-arm64.pkg",
  packageSha256:
    "500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c",
  executableSha256:
    "abd30109cbf84859b2f34951f7967e801111abadaac588468d98ed075100ad37",
  librarySha256:
    "bd26f0747b7a800384b7b3c9221dafeb3943ef565a560ab98238cade597c0947",
  decoderDirectory: "terrain/textures/compact-pbr/decoders/three-r186/basis",
  basisLicenseUrl:
    "https://raw.githubusercontent.com/BinomialLLC/basis_universal/master/LICENSE",
  basisLicenseSha256:
    "065fcf48d6af21c0b75e23be5ed5753aee75c892e1c2cf178fa6736305614a5c",
  groundHeightSha256:
    "f83da0f031244f046d72adf229723da5857d36a6cd5fc542d11db019a60bc06c",
});
export const UASTC_MAP_KEYS = Object.freeze(
  ["grass", "dirt", "rock"].flatMap((layer) =>
    ["albedo-roughness", "normal-ao"].map((kind) => `${layer}-${kind}`),
  ),
);
export const UASTC_MIP_BYTES = Object.freeze(
  Array.from(
    { length: 11 },
    (_, level) => Math.max(1, Math.ceil((1024 >> level) / 4)) ** 2 * 16,
  ),
);
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

const polyhavenDirtDirectory = "terrain/textures/polyhaven-dirt";
export const POLYHAVEN_DIRT_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  assetId: "dirt",
  provider: "Poly Haven",
  sourcePage: "https://polyhaven.com/a/dirt",
  license: "CC0-1.0",
  licensePage: "https://polyhaven.com/license",
  technique: "photographed-surface",
  authors: { "Charlotte Baglioni": "All" },
  dimensionsMeters: [2, 2],
  dimensionsProvenance:
    "The official asset page states 2m width. The info API records [2000, 2000] without a unit field; those raw numbers are not interpreted as meters.",
  infoApi: "https://api.polyhaven.com/info/dirt",
  filesApi: "https://api.polyhaven.com/files/dirt",
  sourceObservationSha256:
    "92bdf9aa300c2f37584090f75665c14758ae567f1adbac93a5d98e025a6eb415",
  digestProvenance:
    "Byte sizes and MD5 matched the official files API. SHA256 was computed locally; it is not an independent publisher signature.",
  sources: [
    {
      name: "dirt_diff_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/dirt/dirt_diff_1k.png",
      bytes: 5504678,
      publisherMd5: "033b3aaa80b816a1a53ed211d69a3328",
      sha256:
        "96b3eb441121c41806a4766f37eeeeb4667af73207ccd8bfb56bbd446a221d42",
      pngBitDepth: 16,
      pngColorType: 2,
    },
    {
      name: "dirt_rough_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/dirt/dirt_rough_1k.png",
      bytes: 1586570,
      publisherMd5: "293473a9600f0938205a05461a4396bb",
      sha256:
        "29f68a8972f1e69cf47e67924efe469350f953a5f707f63633a9c36cd7c63f6a",
      pngBitDepth: 16,
      pngColorType: 0,
    },
    {
      name: "dirt_nor_gl_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/dirt/dirt_nor_gl_1k.png",
      bytes: 5904305,
      publisherMd5: "e1d855d9d6b1c9b39681ee4f4097303b",
      sha256:
        "be315cdb7667d58df160a92be2b22423480912ac5668188f3c8360d464203f47",
      pngBitDepth: 16,
      pngColorType: 2,
    },
    {
      name: "dirt_ao_1k.png",
      officialUrl:
        "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/dirt/dirt_ao_1k.png",
      bytes: 1887607,
      publisherMd5: "c9ed532b791721c45820cd88f421fca0",
      sha256:
        "00981482d9b57c3da11417e7a19c751bfdb58c1fec51d695fa391eaab72a1500",
      pngBitDepth: 16,
      pngColorType: 0,
    },
  ],
  precision:
    "Original unsigned 16-bit PNG bytes retained. pngjs rounds each sample to RGBA8 before exact channel packing; this quantization is lossy. No ICC/gamma transform, normal normalization, resampling, premultiplication or orientation change. Diffuse RGB remains encoded sRGB; normal RGB, roughness and AO remain linear non-color data despite original profile tags. Derivative PNGs contain no color-profile chunks.",
  qualification:
    "Exact source and decoded-channel packing qualification only; native appearance, repeats, mips, normal response, motion and GPU performance require separate evidence.",
});
const polyhavenDirtOutputHashes = {
  albedoRoughness:
    "357b327ed327304b25193ce2a3924bf71b139764e93411a54b8c7469a296baef",
  normalAo: "5e860d999d7d9545740fa12dbff729b2b9233b22179f46e46c6fd2f5facca7d3",
};

export function validatePolyhavenDirtSource(bytes, index) {
  const source = POLYHAVEN_DIRT_PROVENANCE.sources[index];
  assert(source, "Unknown Poly Haven Dirt source role");
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

export function validatePolyhavenDirtProvenance(value) {
  assert.deepEqual(
    value,
    POLYHAVEN_DIRT_PROVENANCE,
    "Poly Haven Dirt provenance mismatch",
  );
}

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
  let dirtSource;
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
    } else if (arg.startsWith("--dirt-source=")) {
      assert(!dirtSource, "Duplicate dirt source");
      dirtSource = arg.slice("--dirt-source=".length);
      assert(
        ["legacy", "polyhaven-dirt"].includes(dirtSource),
        "Unknown dirt source",
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
  if (!dirtSource) {
    const id = installedManifest?.layers?.dirt?.provenance?.assetId;
    assert(id === undefined || id === "dirt", "Unknown installed dirt source");
    dirtSource = id === "dirt" ? "polyhaven-dirt" : "legacy";
  }
  return { check, grassSource, rockSource, dirtSource };
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
// Legacy bytes remain reproducible with all sources explicitly set to legacy.
// Default rock/dirt sources preserve the historical one- and two-argument APIs.
export async function buildPackedTerrain(
  grassSource,
  rockSource = "legacy",
  dirtSource = "legacy",
) {
  assert(["legacy", "grass004"].includes(grassSource), "Unknown grass source");
  assert(
    ["legacy", "rock-face-03"].includes(rockSource),
    "Unknown rock source",
  );
  assert(
    ["legacy", "polyhaven-dirt"].includes(dirtSource),
    "Unknown dirt source",
  );
  const candidate = grassSource === "grass004";
  const rockCandidate = rockSource === "rock-face-03";
  const dirtCandidate = dirtSource === "polyhaven-dirt";
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
  if (dirtCandidate) {
    validatePolyhavenDirtProvenance(
      JSON.parse(
        await readFile(
          path.join(assets, polyhavenDirtDirectory, "provenance.json"),
          "utf8",
        ),
      ),
    );
    manifest.schemaVersion = 4;
    manifest.operation =
      "RGBA8 channel packing; original PNG bytes retained unchanged. Poly Haven Dirt maps, any Rock Face 03 maps and any Grass004 NormalGL are quantized from 16-bit to 8-bit before exact decoded-channel packing.";
    manifest.provenance = `Dirt: Poly Haven Dirt CC0-1.0, photographed surface, approximately 2m square; see portable per-layer provenance. ${candidate ? "Grass: ambientCG Grass004 CC0-1.0, procedural, approximately 1.4m square; see portable per-layer provenance." : "Grass: unchanged existing repository terrain material, without a new license or scan-quality assertion."} ${rockCandidate ? "Rock: Poly Haven Rock Face 03 CC0-1.0, photographed surface, approximately 2.7m square; see portable per-layer provenance." : "Rock: unchanged existing repository terrain material, without a new license or scan-quality assertion."}`;
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
          : dirtCandidate && layer === "dirt"
            ? POLYHAVEN_DIRT_PROVENANCE.sources.map(
                (source) => `${polyhavenDirtDirectory}/${source.name}`,
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
        if (dirtCandidate && layer === "dirt")
          validatePolyhavenDirtSource(bytes, index);
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
      if (dirtCandidate && layer === "dirt")
        assert.equal(
          sha256(bytes),
          polyhavenDirtOutputHashes[kind],
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
    if (dirtCandidate && layer === "dirt") {
      manifest.layers.dirt.sources.forEach((source, index) => {
        source.bytes = POLYHAVEN_DIRT_PROVENANCE.sources[index].bytes;
        source.pngBitDepth =
          POLYHAVEN_DIRT_PROVENANCE.sources[index].pngBitDepth;
      });
      manifest.layers.dirt.provenance = {
        ...POLYHAVEN_DIRT_PROVENANCE,
        path: `${polyhavenDirtDirectory}/provenance.json`,
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

/** Match the previous-level WebGPU box-filter semantics, not direct-base resizing.
 * RGB is decoded/re-encoded only for sRGB albedo; packed alpha is always linear.
 * Each level is quantized to RGBA8. Native GPU rounding still requires visual QA.
 */
export function buildUastcReferenceMipChain(source, srgb) {
  assert.equal(source.width, 1024);
  assert.equal(source.height, 1024);
  assert.equal(source.data.length, 1024 * 1024 * 4);
  const base = new PNG({ width: 1024, height: 1024 });
  for (let y = 0; y < 1024; y++)
    base.data.set(
      source.data.subarray(y * 4096, (y + 1) * 4096),
      (1023 - y) * 4096,
    );
  const decode = Array.from({ length: 256 }, (_, byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const encode = (value) =>
    Math.round(
      255 *
        (value <= 0.0031308
          ? 12.92 * value
          : 1.055 * value ** (1 / 2.4) - 0.055),
    );
  const levels = [base];
  while (levels.at(-1).width > 1) {
    const previous = levels.at(-1);
    const next = new PNG({
      width: previous.width / 2,
      height: previous.height / 2,
    });
    for (let y = 0; y < next.height; y++) {
      for (let x = 0; x < next.width; x++) {
        const p = (y * 2 * previous.width + x * 2) * 4;
        for (let c = 0; c < 4; c++) {
          const values = [
            p + c,
            p + c + 4,
            p + c + previous.width * 4,
            p + c + previous.width * 4 + 4,
          ];
          const total = values.reduce(
            (sum, index) =>
              sum +
              (srgb && c < 3
                ? decode[previous.data[index]]
                : previous.data[index]),
            0,
          );
          next.data[(y * next.width + x) * 4 + c] =
            srgb && c < 3 ? encode(total / 4) : Math.round(total / 4);
        }
      }
    }
    levels.push(next);
  }
  return levels;
}

export function inspectUastcCandidate(bytes, srgb) {
  const texture = readKtx(bytes);
  assert.equal(texture.vkFormat, 0);
  assert.equal(texture.pixelWidth, 1024);
  assert.equal(texture.pixelHeight, 1024);
  assert.equal(texture.pixelDepth, 0);
  assert.equal(texture.layerCount, 0);
  assert.equal(texture.faceCount, 1);
  assert.equal(texture.levelCount, 11);
  assert.equal(texture.supercompressionScheme, 2, "Zstandard supercompression");
  assert.equal(texture.keyValue.KTXorientation, "ru");
  assert.equal(texture.keyValue.KTXswizzle, undefined);
  assert.equal(texture.dataFormatDescriptor.length, 1);
  const descriptor = texture.dataFormatDescriptor[0];
  assert.equal(descriptor.colorModel, 166, "UASTC LDR 4x4");
  assert.equal(descriptor.colorPrimaries, srgb ? 1 : 0);
  assert.equal(descriptor.transferFunction, srgb ? 2 : 1);
  assert.equal(descriptor.flags, 0, "Never premultiply packed scalar alpha");
  assert.deepEqual(descriptor.texelBlockDimension, [3, 3, 0, 0]);
  assert(
    descriptor.samples.some((sample) => (sample.channelType & 15) === 3),
    "UASTC RGBA including scalar alpha",
  );
  assert.deepEqual(
    texture.levels.map((level) => level.uncompressedByteLength),
    UASTC_MIP_BYTES,
  );
  return {
    colorModel: descriptor.colorModel,
    colorPrimaries: descriptor.colorPrimaries,
    transferFunction: descriptor.transferFunction,
    flags: descriptor.flags,
    orientation: texture.keyValue.KTXorientation,
    gpuBytes: UASTC_MIP_BYTES.reduce((sum, bytes) => sum + bytes, 0),
  };
}

export function measureUastcRgbaError(reference, decoded, normal) {
  assert.equal(
    decoded.length,
    reference.data.length,
    "Decoded RGBA byte count",
  );
  const pixels = decoded.length / 4;
  const histograms = Array.from({ length: 4 }, () => new Uint32Array(256));
  const totals = [0, 0, 0, 0];
  const maxima = [0, 0, 0, 0];
  const angles = normal ? new Float64Array(pixels) : null;
  let angleSum = 0;
  for (let p = 0; p < decoded.length; p += 4) {
    for (let c = 0; c < 4; c++) {
      const error = Math.abs(reference.data[p + c] - decoded[p + c]);
      histograms[c][error]++;
      totals[c] += error;
      maxima[c] = Math.max(maxima[c], error);
    }
    if (normal) {
      let dot = 0,
        sourceLength = 0,
        decodedLength = 0;
      for (let c = 0; c < 3; c++) {
        const a = reference.data[p + c] / 127.5 - 1;
        const b = decoded[p + c] / 127.5 - 1;
        dot += a * b;
        sourceLength += a * a;
        decodedLength += b * b;
      }
      const cosine = dot / Math.sqrt(sourceLength * decodedLength);
      const angle =
        (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
      assert(Number.isFinite(angle));
      angles[p / 4] = angle;
      angleSum += angle;
    }
  }
  const channels = Object.fromEntries(
    ["r", "g", "b", "a"].map((name, c) => {
      let count = 0,
        p95 = 0;
      while (
        p95 < 255 &&
        (count += histograms[c][p95]) < Math.ceil(pixels * 0.95)
      )
        p95++;
      return [name, { mae: totals[c] / pixels, p95, max: maxima[c] }];
    }),
  );
  const result = {
    channelErrorUnits:
      "RGBA8 code values (0..255); alpha is linear roughness or AO",
    channels,
  };
  if (normal) {
    angles.sort();
    result.normalAngularDegrees = {
      mean: angleSum / pixels,
      p95: angles[Math.ceil(pixels * 0.95) - 1],
      max: angles[pixels - 1],
    };
  }
  return result;
}

export function parseUastcOptions(args) {
  const options = { check: false, ktx: null, packagePath: null };
  const seen = new Set();
  for (const arg of args) {
    const name = arg.split("=", 1)[0];
    assert(!seen.has(name), `Duplicate UASTC option: ${name}`);
    seen.add(name);
    if (arg === "--uastc-candidate") continue;
    if (arg === "--check") options.check = true;
    else if (arg.startsWith("--ktx=")) options.ktx = path.resolve(arg.slice(6));
    else if (arg.startsWith("--ktx-package="))
      options.packagePath = path.resolve(arg.slice(14));
    else assert.fail(`Unknown UASTC option: ${arg}`);
  }
  assert(seen.has("--uastc-candidate"));
  assert(
    options.ktx && options.packagePath,
    "Provide explicit --ktx and --ktx-package paths from verified official KTX 4.4.2 ARM64 package",
  );
  return options;
}

async function verifyUastcTool(options) {
  assert.equal(
    sha256(await readFile(options.packagePath)),
    UASTC_CANDIDATE.packageSha256,
  );
  assert.equal(
    sha256(await readFile(options.ktx)),
    UASTC_CANDIDATE.executableSha256,
  );
  assert.equal(
    sha256(
      await readFile(
        path.resolve(path.dirname(options.ktx), "../lib/libktx.4.4.2.dylib"),
      ),
    ),
    UASTC_CANDIDATE.librarySha256,
  );
  const signature = await execute("/usr/sbin/pkgutil", [
    "--check-signature",
    options.packagePath,
  ]);
  assert.match(signature.stdout, /The Khronos Group, Inc\. \(TD2656HYNK\)/);
  assert.match(signature.stdout, /trusted by the Apple notary service/);
  await execute("/usr/bin/codesign", ["--verify", "--strict", options.ktx]);
  const version = await execute(options.ktx, ["--version"]);
  assert.equal(version.stdout.trim(), "ktx version: v4.4.2");
}

async function collectUastcDecoderFiles(check) {
  const threeRoot = path.join(repo, "node_modules/three");
  assert.equal(
    JSON.parse(await readFile(path.join(threeRoot, "package.json"))).version,
    "0.186.0",
  );
  const files = new Map();
  for (const name of [
    "basis_transcoder.js",
    "basis_transcoder.wasm",
    "README.md",
  ])
    files.set(
      name,
      await readFile(path.join(threeRoot, "examples/jsm/libs/basis", name)),
    );
  files.set(
    "THREE-LICENSE.txt",
    await readFile(path.join(threeRoot, "LICENSE")),
  );
  const licensePath = path.join(
    assets,
    UASTC_CANDIDATE.decoderDirectory,
    "BASIS-LICENSE.txt",
  );
  let license = await readOptional(licensePath);
  if (!license) {
    assert(!check, "Local Basis license missing");
    const response = await fetch(UASTC_CANDIDATE.basisLicenseUrl);
    assert(response.ok, `Basis license HTTP ${response.status}`);
    license = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(sha256(license), UASTC_CANDIDATE.basisLicenseSha256);
  files.set("BASIS-LICENSE.txt", license);
  return files;
}

/** Explicit offline candidate only; neither original maps nor runtime selection are changed. */
export async function buildUastcCandidate(options) {
  await verifyUastcTool(options);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hyperia-uastc-mips-"));
  const original = new Map();
  const files = new Map();
  try {
    const packingBytes = await readFile(
      path.join(output, "packing-manifest.json"),
    );
    original.set("packing-manifest.json", packingBytes);
    const packing = JSON.parse(packingBytes);
    const ground = await readFile(path.join(output, "ground-height.png"));
    original.set("ground-height.png", ground);
    assert.equal(sha256(ground), UASTC_CANDIDATE.groundHeightSha256);
    const decoderFiles = await collectUastcDecoderFiles(options.check);
    const manifest = {
      schemaVersion: 1,
      candidate: UASTC_CANDIDATE.id,
      status:
        "Offline lossy candidate. Not default; native visual and performance acceptance required.",
      sourcePackingManifest: {
        path: "terrain/textures/compact-pbr/packing-manifest.json",
        sha256: sha256(packingBytes),
      },
      encoder: {
        version: UASTC_CANDIDATE.version,
        platform: "darwin-arm64",
        packageUrl: UASTC_CANDIDATE.packageUrl,
        packageSha256: UASTC_CANDIDATE.packageSha256,
        executableSha256: UASTC_CANDIDATE.executableSha256,
        librarySha256: UASTC_CANDIDATE.librarySha256,
        signature:
          "Developer ID Installer: The Khronos Group, Inc. (TD2656HYNK); trusted Apple notarization; executable codesign verification passed",
        quality: 4,
        rdo: false,
        threads: 1,
        zstd: 18,
      },
      mipFilter:
        "11 explicit RGBA8 levels; each is a 2x2 box of the preceding quantized level. Albedo RGB sRGB decode/filter/encode; all alpha and normal RGB linear; no alpha premultiplication or normal renormalization. GPU rounding parity unverified.",
      orientation:
        "Rows physically flipped once before mip generation to match existing createImageBitmap(imageOrientation=flipY), then flipY=false. KTXorientation=ru. Normal green unchanged.",
      validation:
        "Official ktx validate --warnings-as-errors; all 11 levels decoded with official ktx extract --transcode rgba8 --raw; encoded ASTC/BC7 conversion structurally checked. Metrics describe offline RGBA decoding, not native sampling or rendered visual acceptance.",
      unchangedGroundHeight: {
        path: "terrain/textures/compact-pbr/ground-height.png",
        sha256: sha256(ground),
        bytes: ground.length,
      },
      decoder: {
        threeVersion: "0.186.0",
        source:
          "Installed three@0.186.0 examples/jsm/libs/basis, copied unchanged with upstream README and licenses",
        licenseUrl: UASTC_CANDIDATE.basisLicenseUrl,
        files: Object.fromEntries(
          [...decoderFiles].map(([name, bytes]) => [
            name,
            {
              path: `${UASTC_CANDIDATE.decoderDirectory}/${name}`,
              bytes: bytes.length,
              sha256: sha256(bytes),
            },
          ]),
        ),
      },
      maps: {},
    };
    for (const key of UASTC_MAP_KEYS) {
      const srgb = key.endsWith("albedo-roughness");
      const layer = key.split("-")[0];
      const packedReceipt =
        packing.layers[layer].outputs[srgb ? "albedoRoughness" : "normalAo"];
      const source = await readFile(path.join(output, `${key}.png`));
      original.set(`${key}.png`, source);
      assert.equal(sha256(source), packedReceipt.sha256, `${key} source hash`);
      const mips = buildUastcReferenceMipChain(decodePng(source), srgb);
      const inputs = mips.map((_, level) => `${key}.mip-${level}.png`);
      for (let level = 0; level < mips.length; level++)
        await writeFile(
          path.join(scratch, inputs[level]),
          PNG.sync.write(mips[level], { colorType: 6, inputColorType: 6 }),
        );
      const name = `${key}.uastc-v1.ktx2`;
      const argv = [
        "create",
        "--format",
        srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM",
        "--assign-tf",
        srgb ? "srgb" : "linear",
        "--assign-primaries",
        srgb ? "bt709" : "none",
        "--assign-texcoord-origin",
        "bottom-left",
        "--levels",
        "11",
        "--encode",
        "uastc",
        "--uastc-quality",
        "4",
        "--threads",
        "1",
        "--zstd",
        "18",
        "--fail-on-color-conversions",
        "--fail-on-origin-changes",
        ...inputs,
        name,
      ];
      const generatedPath = path.join(scratch, name);
      if (options.check)
        await writeFile(generatedPath, await readFile(path.join(output, name)));
      else
        await execute(options.ktx, argv, {
          cwd: scratch,
          timeout: 600000,
          maxBuffer: 1024 * 1024,
        });
      const compressed = await readFile(generatedPath);
      const info = inspectUastcCandidate(compressed, srgb);
      const validation = await execute(
        options.ktx,
        ["validate", "--warnings-as-errors", name],
        { cwd: scratch },
      );
      const mipReports = [];
      for (let level = 0; level < mips.length; level++) {
        const decodeArgv = [
          "extract",
          "--transcode",
          "rgba8",
          "--raw",
          "--level",
          String(level),
          name,
          "-",
        ];
        const { stdout: decoded } = await execute(options.ktx, decodeArgv, {
          cwd: scratch,
          encoding: "buffer",
          maxBuffer: 8 * 1024 * 1024,
        });
        mipReports.push({
          level,
          width: mips[level].width,
          height: mips[level].height,
          referenceRgbaSha256: sha256(mips[level].data),
          decodedRgbaSha256: sha256(decoded),
          gpuBytes: UASTC_MIP_BYTES[level],
          ...measureUastcRgbaError(mips[level], decoded, !srgb),
        });
      }
      const transcodes = {};
      for (const target of ["astc", "bc7"]) {
        const targetName = `${key}.${target}.ktx2`;
        await execute(
          options.ktx,
          ["transcode", "--target", target, name, targetName],
          { cwd: scratch },
        );
        const transcodedBytes = await readFile(path.join(scratch, targetName));
        const transcoded = readKtx(transcodedBytes);
        assert.equal(
          transcoded.vkFormat,
          target === "astc" ? (srgb ? 158 : 157) : srgb ? 146 : 145,
        );
        assert.deepEqual(
          transcoded.levels.map((level) => level.levelData.length),
          UASTC_MIP_BYTES,
        );
        transcodes[target] = {
          vkFormat: transcoded.vkFormat,
          mipBytes: [...UASTC_MIP_BYTES],
          sha256: sha256(transcodedBytes),
        };
      }
      manifest.maps[key] = {
        path: `terrain/textures/compact-pbr/${name}`,
        bytes: compressed.length,
        sha256: sha256(compressed),
        source: {
          path: packedReceipt.path,
          bytes: source.length,
          sha256: sha256(source),
        },
        ...info,
        encodeArgv: argv,
        officialValidation:
          validation.stdout.trim() || "passed without errors or warnings",
        transcodes,
        mips: mipReports,
      };
      files.set(name, compressed);
      console.log(
        `UASTC ${options.check ? "verified" : "encoded"}: ${key}; ${compressed.length} bytes, all 11 decoded mip levels measured.`,
      );
    }
    files.set(
      "uastc-v1-manifest.json",
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    // Detect source changes during encoding before publishing any derivative.
    for (const [name, before] of original)
      assert.deepEqual(
        await readFile(path.join(output, name)),
        before,
        `${name} preservation`,
      );
    return { manifest, files, decoderFiles };
  } finally {
    assert(path.basename(scratch).startsWith("hyperia-uastc-mips-"));
    await rm(scratch, { recursive: true, force: false });
  }
}

async function main() {
  if (process.argv.slice(2).includes("--uastc-candidate")) {
    const options = parseUastcOptions(process.argv.slice(2));
    const candidate = await buildUastcCandidate(options);
    for (const [directory, files] of [
      [output, candidate.files],
      [
        path.join(assets, UASTC_CANDIDATE.decoderDirectory),
        candidate.decoderFiles,
      ],
    ]) {
      if (!options.check) await mkdir(directory, { recursive: true });
      for (const [name, bytes] of files) {
        const target = path.join(directory, name);
        if (options.check)
          assert.deepEqual(
            await readFile(target),
            bytes,
            `${name} candidate check`,
          );
        else await writeFile(target, bytes);
      }
    }
    console.log(
      "Offline UASTC candidate complete; original PNG maps, packing manifest and runtime selection untouched.",
    );
    return;
  }
  const installed = await readOptional(
    path.join(output, "packing-manifest.json"),
  );
  const installedManifest = installed ? JSON.parse(installed) : null;
  const installedSources = parsePackingOptions([], installedManifest);
  const { check, grassSource, rockSource, dirtSource } = parsePackingOptions(
    process.argv.slice(2),
    installedManifest,
  );
  const { files } = await buildPackedTerrain(
    grassSource,
    rockSource,
    dirtSource,
  );
  const previous = new Map();
  for (const [name, bytes] of files) {
    const existing = await readOptional(path.join(output, name));
    previous.set(name, existing);
    // Unselected layers must remain byte-identical, never silently regenerated.
    const unchangedLayer =
      (name.startsWith("dirt-") &&
        dirtSource === installedSources.dirtSource) ||
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
    `Compact terrain packing ${check ? "verified" : "generated"}: 6 RGBA8 maps, grass=${grassSource}, rock=${rockSource}, dirt=${dirtSource}, original source hashes retained.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
