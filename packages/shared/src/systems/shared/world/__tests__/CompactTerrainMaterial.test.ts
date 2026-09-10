import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import THREE, {
  float,
  mat4,
  cameraViewMatrix,
  texture,
  vec2,
  vec3,
} from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import {
  createTerrainMaterial,
  TerrainShadeUniforms,
  sampleNoiseCPU,
} from "../TerrainShader";
import {
  COMPACT_TERRAIN_BITMAP_OPTIONS,
  COMPACT_TERRAIN_MATERIAL,
  COMPACT_TERRAIN_TEXTURE_SHA256,
  CompactTerrainTextureSet,
  createCompactTerrainLayers,
  createCompactCotangentNormal,
  createCompactTerrainLayerWeights,
  blendCompactTerrainLayers,
  compactTerrainNormalToView,
  createCompactGroundProjections,
  type CompactTerrainLayer,
} from "../CompactTerrainMaterial";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";

const assetDirectory = new URL(
  "../../../../../../server/world/assets/terrain/textures/compact-pbr/",
  import.meta.url,
);
type TextureEntry = {
  node: ReturnType<typeof texture>;
  key: string;
  status: string;
};
type TextureLifecycle = {
  entries: Map<string, TextureEntry>;
  installTexture(
    entry: TextureEntry,
    image: THREE.Texture,
    sha256: string,
  ): boolean;
};
function lifecycle(owner: CompactTerrainTextureSet) {
  return owner as unknown as TextureLifecycle;
}
function expectedDigest(key: string): string {
  return COMPACT_TERRAIN_TEXTURE_SHA256[
    key as keyof typeof COMPACT_TERRAIN_TEXTURE_SHA256
  ];
}
function graph(root: Node): Set<Node> {
  const nodes = new Set<Node>();
  const visit = (node: Node) => {
    if (nodes.has(node)) return;
    nodes.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return nodes;
}

// Evaluate only the concrete numeric TSL operations used by the normal frame.
// Unknown nodes fail: this is arithmetic evidence, never a mock GPU renderer.
function vectorValue(node: Node): number[] {
  const read = (key: string) => Reflect.get(node, key) as unknown;
  const child = (key: string): number[] => {
    const value = read(key);
    if (!(value instanceof THREE.Node)) throw new Error(`Missing node ${key}`);
    return vectorValue(value);
  };
  const value = read("value");
  if (typeof value === "number") return [value];
  if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3)
    return value.toArray();
  if (value instanceof THREE.Matrix4) return value.toArray();
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  if (node.type === "JoinNode")
    return (read("nodes") as Node[]).flatMap(vectorValue);
  if (node.type === "SplitNode")
    return [...String(read("components"))].map(
      (component) => child("node")["xyzw".indexOf(component)],
    );
  const pair = (apply: (a: number, b: number) => number) => {
    const a = child("aNode");
    const b = child("bNode");
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      apply(a[a.length === 1 ? 0 : i], b[b.length === 1 ? 0 : i]),
    );
  };
  const triple = (apply: (a: number, b: number, c: number) => number) => {
    const a = child("aNode"),
      b = child("bNode"),
      c = child("cNode");
    return Array.from(
      { length: Math.max(a.length, b.length, c.length) },
      (_, i) =>
        apply(
          a[a.length === 1 ? 0 : i],
          b[b.length === 1 ? 0 : i],
          c[c.length === 1 ? 0 : i],
        ),
    );
  };
  switch (read("op")) {
    case "+":
      return pair((a, b) => a + b);
    case "-":
      return pair((a, b) => a - b);
    case "*": {
      const a = child("aNode"),
        b = child("bNode");
      if (a.length === 16 || b.length === 16) {
        const matrixFirst = a.length === 16;
        const matrix = new THREE.Matrix4().fromArray(matrixFirst ? a : b);
        if (!matrixFirst) matrix.transpose();
        const direction = matrixFirst ? b : a;
        return new THREE.Vector4(
          ...(direction as [number, number, number, number]),
        )
          .applyMatrix4(matrix)
          .toArray();
      }
      return pair((a, b) => a * b);
    }
  }
  switch (read("method")) {
    case "floor":
      return child("aNode").map(Math.floor);
    case "fract":
      return child("aNode").map((value) => value - Math.floor(value));
    case "sin":
      return child("aNode").map(Math.sin);
    case "cos":
      return child("aNode").map(Math.cos);
    case "max":
      return pair(Math.max);
    case "clamp":
      return triple((value, minimum, maximum) =>
        Math.max(minimum, Math.min(maximum, value)),
      );
    case "mix":
      return triple((a, b, weight) => a + (b - a) * weight);
    case "smoothstep":
      return triple((a, b, value) => {
        const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
        return t * t * (3 - 2 * t);
      });
    case "dot":
      return [pair((a, b) => a * b).reduce((a, b) => a + b, 0)];
    case "cross":
      return new THREE.Vector3(...(child("aNode") as [number, number, number]))
        .cross(
          new THREE.Vector3(...(child("bNode") as [number, number, number])),
        )
        .toArray();
    case "inversesqrt":
      return child("aNode").map((value) => 1 / Math.sqrt(value));
    case "normalize": {
      const a = child("aNode");
      const length = Math.hypot(...a);
      return a.map((value) => value / length);
    }
    case "transformDirection": {
      const a = child("aNode"),
        b = child("bNode");
      const matrixFirst = a.length === 16;
      const matrix = new THREE.Matrix4().fromArray(matrixFirst ? a : b);
      if (!matrixFirst) matrix.transpose();
      const direction = matrixFirst ? b : a;
      return new THREE.Vector3(...(direction as [number, number, number]))
        .transformDirection(matrix)
        .toArray();
    }
  }
  throw new Error(
    `Unsupported numeric node ${node.type}/${String(read("method"))}`,
  );
}
async function decodedTexture(name: string) {
  const decoded = PNG.sync.read(
    await readFile(new URL(`${name}.png`, assetDirectory)),
  );
  return new THREE.DataTexture(
    new Uint8Array(decoded.data),
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
  );
}

describe("compact terrain actual texture ownership and CPU material graph", () => {
  it("packs real RGB unchanged with scalar roughness/AO and reproducible linear palette", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("packing-manifest.json", assetDirectory), "utf8"),
    );
    const palette = createCompactTerrainColorOperations().getPalette();
    for (const layer of ["grass", "dirt", "rock"] as const) {
      for (const kind of ["albedoRoughness", "normalAo"] as const) {
        const output = manifest.layers[layer].outputs[kind];
        const name = output.path.split("/").at(-1)!;
        const bytes = await readFile(new URL(name, assetDirectory));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          output.sha256,
        );
        expect(expectedDigest(name.replace(/\.png$/, ""))).toBe(output.sha256);
        const packed = PNG.sync.read(bytes);
        expect(packed.width).toBe(1024);
        expect(packed.height).toBe(1024);
        if (kind === "normalAo" && layer === "grass") {
          let mismatches = 0;
          for (let p = 3; p < packed.data.length; p += 4)
            if (packed.data[p] !== 255) mismatches++;
          expect(mismatches).toBe(0);
        }
        if (kind === "albedoRoughness") {
          const mean = [0, 0, 0];
          for (let p = 0; p < packed.data.length; p += 4) {
            for (let c = 0; c < 3; c++) {
              const value = packed.data[p + c] / 255;
              mean[c] +=
                value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4;
            }
          }
          for (let c = 0; c < 3; c++) {
            expect(mean[c] / 1024 ** 2).toBeCloseTo(palette[layer][c], 12);
            expect(manifest.layers[layer].diffuseLinearMean[c]).toBeCloseTo(
              palette[layer][c],
              12,
            );
          }
        }
      }
    }
  });

  it("distinguishes idle placeholders from six admitted real images and keeps sampled references live", async () => {
    const owner = new CompactTerrainTextureSet(
      "https://assets.example.invalid/game-assets",
    );
    const entries = lifecycle(owner).entries;
    expect(owner.getReceipt().status).toBe("idle");
    expect(owner.getReceipt().textures).toHaveLength(6);
    try {
      for (const entry of entries.values()) {
        const old = entry.node.value;
        const sampled = entry.node.sample(vec2(0.3, 0.4));
        const gradientSample = entry.node
          .grad(vec2(0.01, 0), vec2(0, 0.01))
          .sample(vec2(0.3, 0.4));
        let disposed = 0;
        old.addEventListener("dispose", () => disposed++);
        // Real decoder -> real DataTexture -> exact production admission method.
        // Browser fetch/bitmap transfer remains a separate WebGPU gate.
        const decoded = await decodedTexture(entry.key);
        entry.status = "loading";
        expect(
          lifecycle(owner).installTexture(
            entry,
            decoded,
            expectedDigest(entry.key),
          ),
        ).toBe(true);
        expect(sampled.value).toBe(decoded);
        expect(gradientSample.value).toBe(decoded);
        expect(disposed).toBe(1);
        expect(decoded.colorSpace).toBe(
          entry.key.endsWith("normal-ao")
            ? THREE.NoColorSpace
            : THREE.SRGBColorSpace,
        );
        expect(decoded.premultiplyAlpha).toBe(false);
        expect(decoded.flipY).toBe(false);
      }
      expect(owner.getReceipt().status).toBe("ready");
      expect(
        owner
          .getReceipt()
          .textures.every(
            (entry) => entry.width === 1024 && entry.height === 1024,
          ),
      ).toBe(true);
      const copied = owner.getReceipt();
      copied.textures[0].status = "error";
      expect(owner.getReceipt().status).toBe("ready");
    } finally {
      owner.dispose();
    }
    expect(owner.getReceipt().status).toBe("disposed");
  });

  it("rejects invalid dimensions and late results without tainting the installed owner", async () => {
    const owner = new CompactTerrainTextureSet(
      "https://assets.example.invalid",
    );
    const entry = [...lifecycle(owner).entries.values()][0];
    const placeholder = entry.node.value;
    entry.status = "loading";
    const invalid = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    let invalidDisposals = 0;
    invalid.addEventListener("dispose", () => invalidDisposals++);
    expect(() =>
      lifecycle(owner).installTexture(
        entry,
        invalid,
        expectedDigest(entry.key),
      ),
    ).toThrow("dimensions");
    expect(invalidDisposals).toBe(1);
    expect(entry.node.value).toBe(placeholder);
    owner.dispose();
    owner.dispose();
    const late = await decodedTexture(entry.key);
    let lateDisposals = 0;
    late.addEventListener("dispose", () => lateDisposals++);
    expect(
      lifecycle(owner).installTexture(entry, late, expectedDigest(entry.key)),
    ).toBe(false);
    expect(entry.node.value).toBe(placeholder);
    expect(lateDisposals).toBe(1);
    await expect(owner.load()).rejects.toThrow("disposed");
  });

  it("actual fetch/decode failure cannot admit placeholders", async () => {
    // Node has fetch, but deliberately no bitmap decoder/browser mock. This
    // actual invalid data URL exercises the real rejection and cancellation.
    const owner = new CompactTerrainTextureSet(
      "data:application/octet-stream,",
    );
    try {
      const promise = owner.load();
      expect(owner.load()).toBe(promise);
      await expect(promise).rejects.toThrow("admission failed");
      expect(owner.getReceipt().status).toBe("error");
      expect(
        owner
          .getReceipt()
          .textures.every((entry) => entry.status === "error" && entry.error),
      ).toBe(true);
    } finally {
      owner.dispose();
    }
  });

  it("disposal cancels in-flight admission and never publishes a late completion", async () => {
    const owner = new CompactTerrainTextureSet(
      "data:application/octet-stream,",
    );
    const promise = owner.load();
    owner.dispose();
    await expect(promise).rejects.toThrow("disposed");
    expect(
      owner
        .getReceipt()
        .textures.every(
          (entry) => entry.status === "disposed" && entry.width === 1,
        ),
    ).toBe(true);
  });

  it("uses only six surface textures, real derivative normal frames and unchanged geometry/shade ownership", () => {
    const shade = new TerrainShadeUniforms();
    const material = createTerrainMaterial(shade, {
      compactPbr: true,
    }) as THREE.MeshStandardNodeMaterial &
      ReturnType<typeof createTerrainMaterial>;
    const legacy = createTerrainMaterial() as THREE.MeshStandardNodeMaterial;
    try {
      expect(material.terrainUniforms.shade).toBe(shade);
      expect(material.normalNode).toBeTruthy();
      expect(material.roughnessNode).toBeTruthy();
      expect(material.aoNode).toBeTruthy();
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
      expect(material.metalness).toBe(0);
      expect(material.fog).toBe(false);
      expect(material.outputNode).toBeTruthy();
      expect(legacy.normalNode).toBeNull();
      expect(legacy.aoNode).toBeNull();
      expect(Reflect.get(legacy, "compactTerrainSurface")).toBeUndefined();
      const owner = material.compactTerrainSurface!;
      const owned = new Set(
        owner.getReceipt().textures.map((entry) => entry.textureUuid),
      );
      const seenOwned = new Set<string>();
      const samples = new Set<Node>();
      const methods = new Set<string>();
      for (const root of [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ]) {
        for (const node of graph(root)) {
          const value: unknown = Reflect.get(node, "value");
          if (value instanceof THREE.Texture && owned.has(value.uuid))
            seenOwned.add(value.uuid);
          if (
            value instanceof THREE.Texture &&
            owned.has(value.uuid) &&
            Reflect.get(node, "uvNode")
          )
            samples.add(node);
          const method: unknown = Reflect.get(node, "method");
          if (typeof method === "string") methods.add(method);
        }
      }
      expect(seenOwned.size).toBe(6);
      expect(samples.size).toBe(14);
      expect(
        [...samples].filter((node) => Reflect.get(node, "gradNode")).length,
      ).toBe(8);
      expect(methods.has("dFdx")).toBe(true);
      expect(methods.has("dFdy")).toBe(true);
      expect(COMPACT_TERRAIN_MATERIAL.surfaceSampleCount).toBe(14);
      expect(COMPACT_TERRAIN_BITMAP_OPTIONS).toEqual({
        imageOrientation: "flipY",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      const layers = createCompactTerrainLayers(owner, float(0));
      expect(layers.dirt.albedo).not.toBe(layers.grass.albedo);
    } finally {
      material.dispose();
      legacy.dispose();
    }
    expect(material.compactTerrainSurface!.getReceipt().status).toBe(
      "disposed",
    );
  });

  it("preserves neutral normals and exact U/V handedness on all six world projections", () => {
    for (const [normal, tangent, bitangent] of [
      [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [-1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, -1],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]) {
      const n = new THREE.Vector3(...(normal as [number, number, number]));
      const t = new THREE.Vector3(...(tangent as [number, number, number]));
      const b = new THREE.Vector3(...(bitangent as [number, number, number]));
      const dy = n.clone().cross(t);
      for (const [r, g, strength] of [
        [0.5, 0.5, 1],
        [0.75, 0.5, 1],
        [0.5, 0.75, 1],
        [0.75, 0.75, 0],
      ]) {
        const node = createCompactCotangentNormal(
          vec3(r, g, 1),
          vec3(n),
          vec3(t),
          vec3(dy),
          vec2(1, 0),
          vec2(0, dy.dot(b)),
          float(strength),
        );
        const actual = new THREE.Vector3(
          ...(vectorValue(node) as [number, number, number]),
        );
        const expected = n
          .clone()
          .addScaledVector(t, (r * 2 - 1) * strength)
          .addScaledVector(b, (g * 2 - 1) * strength)
          .normalize();
        expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
      }
    }
    const degenerate = createCompactCotangentNormal(
      vec3(0.8, 0.2, 1),
      vec3(0, 1, 0),
      vec3(0),
      vec3(0),
      vec2(0),
      vec2(0),
      float(1),
    );
    expect(vectorValue(degenerate)).toEqual([0, 1, 0]);
  });

  it("transforms actual compact normals world-to-view for overhead and grazing cameras without changing Lambert lighting", () => {
    const material = createTerrainMaterial(undefined, { compactPbr: true });
    try {
      // Verify the production graph uses this matrix-first contract, not only
      // a standalone helper. This is CPU arithmetic, not GPU image approval.
      const conversion = [...graph(material.normalNode!)].find(
        (node) =>
          Reflect.get(node, "op") === "*" &&
          Reflect.get(node, "aNode") === cameraViewMatrix,
      );
      expect(conversion).toBeDefined();
    } finally {
      material.dispose();
    }
    const sunWorld = new THREE.Vector3(0.3, 0.8, -0.2).normalize();
    for (const position of [
      [0, 600, 40],
      [0, 40, 100],
      [80, 50, -120],
      [-60, 30, 80],
    ]) {
      const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.2, 10_000);
      camera.position.set(...(position as [number, number, number]));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      const sunView = sunWorld
        .clone()
        .transformDirection(camera.matrixWorldInverse);
      for (const normal of [
        [0, 1, 0],
        [0.2, 1, 0.1],
        [-0.1, 0.8, 0.3],
      ]) {
        const worldNormal = new THREE.Vector3(
          ...(normal as [number, number, number]),
        ).normalize();
        const node = compactTerrainNormalToView(
          vec3(worldNormal),
          mat4(camera.matrixWorldInverse),
        );
        const actual = new THREE.Vector3(
          ...(vectorValue(node) as [number, number, number]),
        );
        const expected = worldNormal
          .clone()
          .transformDirection(camera.matrixWorldInverse);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
        expect(actual.dot(sunView)).toBeCloseTo(worldNormal.dot(sunWorld), 12);
      }
    }
  });

  it("keeps antirepeat projection transitions continuous and normals aligned with each actual rotated UV", () => {
    const at = (noise: number, x = 350, z = 320) =>
      createCompactGroundProjections(
        vec2(x, z),
        float(noise),
        COMPACT_TERRAIN_MATERIAL.grassRepeatsPerMeter,
        vec2(1, 0),
        vec2(0, -1),
      );
    const eps = 1e-8;
    for (const id of [-3, 0, 1, 7, 13, 24, 32]) {
      const left = at(id / 32 - eps),
        right = at(id / 32 + eps);
      expect(vectorValue(left.weight)[0]).toBe(1);
      expect(vectorValue(right.weight)[0]).toBe(0);
      for (const key of ["uv", "dx", "dy"] as const)
        expect(vectorValue(left.b[key])).toEqual(vectorValue(right.a[key]));
      for (const p of [left.a, left.b, right.a, right.b]) {
        const dx = vectorValue(p.dx),
          dy = vectorValue(p.dy);
        const magnitude = Math.hypot(...dx);
        expect(magnitude).toBeGreaterThan(0.85 * 0.81);
        expect(magnitude).toBeLessThan(0.85 * 1.19);
        expect(dx[0] * dy[0] + dx[1] * dy[1]).toBeCloseTo(0, 12);
        const normal = createCompactCotangentNormal(
          vec3(0.75, 0.5, 1),
          vec3(0, 1, 0),
          vec3(1, 0, 0),
          vec3(0, 0, -1),
          p.dx,
          p.dy,
          float(1),
        );
        const expected = new THREE.Vector3(
          (dx[0] / magnitude) * 0.5,
          1,
          (-dy[0] / magnitude) * 0.5,
        ).normalize();
        const actual = new THREE.Vector3(
          ...(vectorValue(normal) as [number, number, number]),
        );
        expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
      }
    }
    // World anchoring does not depend on node-local UVs or quadtree density.
    const origin = at(0.431, 350, 320),
      near = at(0.431, 350 + eps, 320);
    expect(
      Math.hypot(
        ...vectorValue(origin.a.uv).map(
          (v, i) => v - vectorValue(near.a.uv)[i],
        ),
      ),
    ).toBeLessThan(2e-8);
  });

  it("removes the old exact 3.33m stamp in actual packed diffuse samples without modifying their bytes", async () => {
    // CPU bilinear sampling of the real admitted input images demonstrates
    // texture-coordinate repeat reduction only, not rendering/performance.
    for (const layer of ["grass", "dirt"] as const) {
      const png = PNG.sync.read(
        await readFile(
          new URL(`${layer}-albedo-roughness.png`, assetDirectory),
        ),
      );
      const texel = (uv: number[]): number[] => {
        const px = (((uv[0] % 1) + 1) % 1) * png.width - 0.5;
        const py = (((uv[1] % 1) + 1) % 1) * png.height - 0.5;
        const x0 = Math.floor(px),
          y0 = Math.floor(py),
          fx = px - x0,
          fy = py - y0;
        const at = (x: number, y: number, c: number) =>
          png.data[
            ((((y % png.height) + png.height) % png.height) * png.width +
              (((x % png.width) + png.width) % png.width)) *
              4 +
              c
          ] / 255;
        return [0, 1, 2].map(
          (c) =>
            (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) +
            (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy,
        );
      };
      const sample = (x: number, z: number) => {
        const p = createCompactGroundProjections(
          vec2(x, z),
          float(sampleNoiseCPU(x, z, 0.0008)),
          layer === "grass"
            ? COMPACT_TERRAIN_MATERIAL.grassRepeatsPerMeter
            : COMPACT_TERRAIN_MATERIAL.dirtRepeatsPerMeter,
          vec2(1, 0),
          vec2(0, 1),
        );
        const a = texel(vectorValue(p.a.uv)),
          b = texel(vectorValue(p.b.uv));
        const w = vectorValue(p.weight)[0];
        return a.map((value, i) => value * (1 - w) + b[i] * w);
      };
      let baselineDifference = 0,
        revisedDifference = 0;
      const oldPeriod = 1 / COMPACT_TERRAIN_MATERIAL.repeatsPerMeter;
      for (let ix = 0; ix < 8; ix++)
        for (let iz = 0; iz < 8; iz++) {
          const x = 260 + ix * 11.7,
            z = 240 + iz * 13.1;
          const oldA = texel([x * 0.3, z * 0.3]),
            oldB = texel([(x + oldPeriod) * 0.3, z * 0.3]);
          const a = sample(x, z),
            b = sample(x + oldPeriod, z);
          for (let c = 0; c < 3; c++) {
            baselineDifference += (oldA[c] - oldB[c]) ** 2;
            revisedDifference += (a[c] - b[c]) ** 2;
          }
        }
      expect(Math.sqrt(baselineDifference / 192)).toBeLessThan(1e-10);
      expect(Math.sqrt(revisedDifference / 192)).toBeGreaterThan(1 / 255);
    }
  });
});

describe("compact grass base palette without changing ecology", () => {
  it("uses identical layer and full-path selection with restrained macro variation", () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    const sample = (slope: number, roadInfluence: number, noiseValue = 0.5) =>
      ops.sample({ noiseValue, distortNoise: 0.5, slope, roadInfluence });
    expect(sample(1, 0)).toEqual({
      r: palette.rock[0],
      g: palette.rock[1],
      b: palette.rock[2],
    });
    expect(sample(1, 1)).toEqual({
      r: palette.dirt[0],
      g: palette.dirt[1],
      b: palette.dirt[2],
    });
    const grass = sample(0, 0, 0.1);
    expect(grass.r).toBeCloseTo(palette.grass[0] * 0.984, 14);
    for (const slope of [0, 0.2, 0.45, 0.8, 1])
      for (const roadInfluence of [0, 0.25, 0.75, 1])
        for (const noiseValue of [0, 0.5, 1]) {
          const result = sample(slope, roadInfluence, noiseValue);
          expect(
            Object.values(result).every(
              (value) => Number.isFinite(value) && value >= 0 && value <= 1,
            ),
          ).toBe(true);
          expect(Object.keys(result).sort()).toEqual(["b", "g", "r"]);
        }
  });

  it("matches actual compact TSL weights and RGB while retaining full dirt paths over the restrained meadow", () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    const layer = (color: number[]): CompactTerrainLayer => ({
      albedo: vec3(...(color as [number, number, number])),
      roughness: float(1),
      ao: float(1),
      worldNormal: vec3(0, 1, 0),
    });
    const layers = {
      grass: layer(palette.grass),
      dirt: layer(palette.dirt),
      rock: layer(palette.rock),
    };
    for (const noiseValue of [0, 0.3, 0.5, 0.6, 0.72, 1])
      for (const slope of [-0.2, 0, 0.05, 0.15, 0.3, 0.4, 0.55, 1, 1.2])
        for (const roadInfluence of [-0.2, 0, 0.25, 0.75, 1, 1.2]) {
          const input = { noiseValue, slope, roadInfluence, distortNoise: 0.1 };
          const cpu = ops.weights(input);
          const actual = createCompactTerrainLayerWeights(
            float(noiseValue),
            float(slope),
            float(roadInfluence),
            float(input.distortNoise),
          );
          for (const key of ["dirt", "cliff", "road", "variation"] as const)
            expect(vectorValue(actual[key])[0]).toBeCloseTo(cpu[key], 13);
          if (slope === 0) {
            expect(cpu.dirt).toBeLessThanOrEqual(0.12);
            expect(cpu.cliff).toBe(0);
          }
          if (roadInfluence >= 1) expect(cpu.road).toBe(1);
          const surface = blendCompactTerrainLayers(
            layers,
            actual.dirt,
            actual.cliff,
            actual.road,
          );
          const rgb = vectorValue(surface.albedo.mul(actual.variation));
          const expected = ops.sample(input);
          expect(rgb[0]).toBeCloseTo(expected.r, 13);
          expect(rgb[1]).toBeCloseTo(expected.g, 13);
          expect(rgb[2]).toBeCloseTo(expected.b, 13);
          if (roadInfluence <= 0 || roadInfluence >= 1)
            expect(ops.sample({ ...input, distortNoise: 0.9 })).toEqual(
              expected,
            );
        }
    expect(COMPACT_TERRAIN_MATERIAL.dirtNormalStrength).toBe(0.25);
    expect(COMPACT_TERRAIN_MATERIAL.rockNormalStrength).toBe(0.4);
    expect(COMPACT_TERRAIN_MATERIAL.repeatsPerMeter).toBe(0.3);
    expect(COMPACT_TERRAIN_MATERIAL.textureCount).toBe(6);
    expect(COMPACT_TERRAIN_MATERIAL.surfaceSampleCount).toBe(14);
  });

  it("wears only the soft path margin with matching CPU and actual TSL weights", () => {
    const ops = createCompactTerrainColorOperations();
    for (const edge of [0, 0.1, 0.3, 0.5, 0.7, 1]) {
      let previous = -1;
      for (let i = 0; i <= 100; i++) {
        const road = i / 100;
        const input = {
          noiseValue: 0.4,
          distortNoise: edge,
          slope: 0,
          roadInfluence: road,
        };
        const actual = createCompactTerrainLayerWeights(
          float(input.noiseValue),
          float(0),
          float(road),
          float(edge),
        );
        const cpu = ops.weights(input);
        expect(vectorValue(actual.road)[0]).toBeCloseTo(cpu.road, 13);
        expect(cpu.road).toBeGreaterThanOrEqual(previous);
        if (i === 0 || i === 100) expect(cpu.road).toBe(road);
        previous = cpu.road;
      }
    }
    expect(
      ops.weights({
        noiseValue: 0.4,
        slope: 0,
        roadInfluence: 0.5,
        distortNoise: 0.1,
      }).road,
    ).toBeGreaterThan(
      ops.weights({
        noiseValue: 0.4,
        slope: 0,
        roadInfluence: 0.5,
        distortNoise: 0.9,
      }).road,
    );
  });

  it("runs the actual minified keepNames factory in a fresh worker without bundle helpers", async () => {
    const result = await build({
      entryPoints: [
        new URL("../CompactTerrainPalette.ts", import.meta.url).pathname,
      ],
      bundle: true,
      minify: true,
      keepNames: true,
      platform: "node",
      format: "esm",
      write: false,
    });
    const loaded = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    );
    const input = {
      noiseValue: 0.57,
      distortNoise: 0.31,
      slope: 0.42,
      roadInfluence: 0.63,
    };
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads'); const operations=(${loaded.createCompactTerrainColorOperations.toString()})(); parentPort.postMessage(operations.sample(${JSON.stringify(input)}));`,
      { eval: true },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(
        createCompactTerrainColorOperations().sample(input),
      );
    } finally {
      await worker.terminate();
    }
  });
});
