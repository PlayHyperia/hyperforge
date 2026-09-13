import { build } from "esbuild";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import * as THREE from "../../../../extras/three/three";
import { createTerrainNoiseSampler } from "../TerrainNoiseSampler";
import {
  generateNoiseTexture,
  getNoiseTexture,
  sampleNoiseCPU,
  sampleNoiseAtPosition,
  createTerrainMaterial,
} from "../TerrainShader";

// Captured from the real pre-fix TerrainShader generator (executed native02
// source SHA256 0ee9335e30b6428678ebeff09720378432ba8dd312000fc71b2be5fa0aab3178),
// before replacing its loop. These pin ALL original 256² RGBA upload bytes.
const textureHashes = {
  12345: "81d914c0cd4b8a735767e2014f6898900c227b06e8089ad7396b45fa0144348b",
  42: "80a1135cd429cc61709aed17888676bbe4fdbac0efa81385960baca86ed48ce3",
};
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

// Independent bilinear reference over the preserved RGBA upload. This uses
// normalized-grid coordinates and nested linear interpolation, rather than
// production's weighted sum. Rounding differences are bounded to a few ulps.
function reference(
  rgba: Uint8Array,
  worldX: number,
  worldZ: number,
  scale: number,
): number {
  const u = worldX * scale;
  const v = worldZ * scale;
  const x = (u - Math.floor(u)) * 256 - 0.5;
  const y = (v - Math.floor(v)) * 256 - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const at = (a: number, b: number) =>
    rgba[((b & 255) * 256 + (a & 255)) * 4] / 255;
  const low = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
  const high = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
  return low * (1 - fy) + high * fy;
}

describe("shared quantized terrain noise", () => {
  it.each([12345, 42] as const)(
    "preserves every historical RGBA byte for seed %i",
    (seed) => {
      const sampler = createTerrainNoiseSampler(seed);
      const data = sampler.copyRGBA();
      expect(Object.isFrozen(sampler)).toBe(true);
      expect(sampler.size).toBe(256);
      expect(sampler.seed).toBe(seed);
      expect(data.byteLength).toBe(262144);
      expect(hash(data)).toBe(textureHashes[seed]);
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] !== data[i + 1] ||
          data[i] !== data[i + 2] ||
          data[i + 3] !== 255
        )
          throw new Error(`Incorrect RGBA encoding at texel ${i / 4}`);
      }
    },
  );

  it("samples exact texel centers, negative UVs and periodic half-texel seams", () => {
    const sampler = createTerrainNoiseSampler();
    const data = sampler.copyRGBA();
    for (let y = 0; y < 256; y += 7) {
      for (let x = 0; x < 256; x += 11) {
        const u = (x + 0.5) / 256;
        const v = (y + 0.5) / 256;
        const expected = data[(y * 256 + x) * 4] / 255;
        expect(sampler.sample(u, v, 1)).toBe(expected);
        expect(sampler.sample(u - 2, v + 3, 1)).toBe(expected);
      }
    }
    const quarterSeam =
      (data[0] +
        data[255 * 4] +
        data[255 * 256 * 4] +
        data[(256 * 256 - 1) * 4]) /
      255 /
      4;
    expect(sampler.sample(0, 0, 1)).toBeCloseTo(quarterSeam, 15);
    expect(sampler.sample(-1, 1, 1)).toBe(sampler.sample(0, 0, 1));
    for (const x of [
      -1 - 1e-9,
      -1,
      -1 + 1e-9,
      -0.5,
      -1e-9,
      0,
      1e-9,
      0.5,
      1 - 1e-9,
      1,
    ])
      for (const z of [-1, -1e-9, 0, 1e-9, 1])
        expect(sampler.sample(x, z, 1)).toBeCloseTo(
          reference(data, x, z, 1),
          13,
        );
  });

  it("matches the original upload's bilinear field at actual terrain scales", () => {
    const sampler = createTerrainNoiseSampler();
    const data = sampler.copyRGBA();
    for (const scale of [0.0008, 0.067, 0.0015, 0.012]) {
      for (let i = 0; i < 257; i++) {
        const x = -400 + i * 3.173;
        const z = 310 - i * 2.417;
        const value = sampler.sample(x, z, scale);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(value).toBeCloseTo(reference(data, x, z, scale), 13);
      }
    }
  });

  it("isolates private cached texels from upload mutations and other seeds", () => {
    const sampler = createTerrainNoiseSampler();
    const first = sampler.sample(267.51, 293.41, 0.067);
    const rgba = sampler.copyRGBA();
    rgba.fill(0);
    expect(sampler.sample(267.51, 293.41, 0.067)).toBe(first);
    expect(hash(sampler.copyRGBA())).toBe(textureHashes[12345]);
    const other = createTerrainNoiseSampler(42);
    expect(other.sample(267.51, 293.41, 0.067)).not.toBe(first);
    expect(sampler.sample(267.51, 293.41, 0.067)).toBe(first);
  });

  it("rejects non-finite public samples and seeds without publishing invalid values", () => {
    const sampler = createTerrainNoiseSampler();
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => createTerrainNoiseSampler(value)).toThrow(RangeError);
      expect(() => sampler.sample(value, 0, 1)).toThrow(RangeError);
      expect(() => sampler.sample(0, value, 1)).toThrow(RangeError);
      expect(() => sampler.sample(1, 1, value)).toThrow(RangeError);
    }
    expect(() => sampler.sample(Number.MAX_VALUE, 1, 2)).toThrow(RangeError);
    expect(Number.isFinite(sampler.sample(0, 0, 0))).toBe(true);
  });

  it("is self-contained when emitted alone and after keepNames/minification", async () => {
    const built = await build({
      entryPoints: [
        fileURLToPath(new URL("../TerrainNoiseSampler.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "TerrainNoiseBundle",
      target: "es2022",
      minify: true,
      keepNames: true,
    });
    const minifiedSource = runInNewContext(
      `${built.outputFiles[0].text}\nTerrainNoiseBundle.createTerrainNoiseSampler.toString();`,
    ) as string;
    const local = createTerrainNoiseSampler();
    for (const source of [
      createTerrainNoiseSampler.toString(),
      minifiedSource,
    ]) {
      // A SECOND empty VM, not the bundler's scope: no captured __name/imports.
      const isolated = runInNewContext(`(${source})();`) as ReturnType<
        typeof createTerrainNoiseSampler
      >;
      expect(hash(isolated.copyRGBA())).toBe(textureHashes[12345]);
      for (let i = 0; i < 257; i++) {
        const x = 250 + i * 0.117;
        const z = 275 + i * 0.219;
        for (const scale of [0.0008, 0.067, 0.0015])
          expect(isolated.sample(x, z, scale)).toBe(local.sample(x, z, scale));
      }
    }
  });

  it("keeps the runtime default field stable even across a first custom utility texture", () => {
    expect(getNoiseTexture()).toBeNull();
    const sampler = createTerrainNoiseSampler();
    const points = [
      [267.51, 293.41],
      [-1, 1],
      [375.21, 354.49],
    ] as const;
    const before = points.map(([x, z]) => sampleNoiseCPU(x, z, 0.067));
    const legacy = sampleNoiseAtPosition(267.51, 293.41);
    const texture = generateNoiseTexture(42);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(hash(texture.image.data as Uint8Array)).toBe(textureHashes[42]);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(generateNoiseTexture()).toBe(texture); // Historical first seed wins.
    // A seeded utility upload cannot silently become a mismatched game terrain.
    expect(() => createTerrainMaterial()).toThrow(
      "Runtime terrain requires the default terrain noise seed",
    );
    for (const [i, [x, z]] of points.entries()) {
      expect(sampleNoiseCPU(x, z, 0.067)).toBe(before[i]);
      expect(before[i]).toBe(sampler.sample(x, z, 0.067));
    }
    expect(sampleNoiseAtPosition(267.51, 293.41, 42)).toBe(legacy);
    expect(legacy).not.toBe(sampler.sample(267.51, 293.41, 0.0008));
    texture.dispose();
  });
});
