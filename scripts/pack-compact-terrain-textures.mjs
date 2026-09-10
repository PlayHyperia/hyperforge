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

async function main() {
  const check = process.argv.includes("--check");
  if (!check) await mkdir(output, { recursive: true });
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
  for (const [layer, names] of Object.entries(inputs)) {
    const sources = await Promise.all(
      names.map(async (name) => {
        if (!name) return null;
        const relative = `terrain/textures/${name}`;
        const bytes = await readFile(path.join(assets, relative));
        return {
          path: relative,
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
      if (check)
        assert.deepEqual(await readFile(path.join(output, name)), bytes, name);
      else await writeFile(path.join(output, name), bytes);
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
  }
  const receipt = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check)
    assert.equal(
      await readFile(path.join(output, "packing-manifest.json"), "utf8"),
      receipt,
    );
  else await writeFile(path.join(output, "packing-manifest.json"), receipt);
  console.log(
    `Compact terrain packing ${check ? "verified" : "generated"}: 6 lossless maps, original source hashes retained.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
