import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import THREE, {
  float,
  mat4,
  cameraViewMatrix,
  texture,
  vec2,
  vec3,
  vec4,
} from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import {
  createTerrainMaterial,
  TerrainShadeUniforms,
  sampleNoiseCPU,
  getNoiseTexture,
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
  createCompactPondSurfaceWeights,
  applyCompactPondWetness,
  applyCompactMeadowTint,
  createCompactTerrainMacroWeights,
  createCompactCoastWeights,
  applyCompactCoastRock,
  type CompactTerrainLayer,
} from "../CompactTerrainMaterial";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { DataManager } from "../../../../data/DataManager";
import { World } from "../../../../core/World";
import { TerrainSystem } from "../TerrainSystem";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

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
  if (
    value instanceof THREE.Vector2 ||
    value instanceof THREE.Vector3 ||
    value instanceof THREE.Vector4
  )
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
    case "/":
      return pair((a, b) => a / b);
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
    case "length":
      return [Math.hypot(...child("aNode"))];
    case "min":
      return pair(Math.min);
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
          const source = manifest.layers.grass.sources[3];
          expect(source.path).toBe(
            "terrain/textures/ambientcg-grass004/Grass004_1K-PNG_AmbientOcclusion.png",
          );
          const bytes = await readFile(
            new URL(source.path, new URL("../../../", assetDirectory)),
          );
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            source.sha256,
          );
          const ao = PNG.sync.read(bytes);
          expect([ao.width, ao.height]).toEqual([1024, 1024]);
          let mismatches = 0;
          let nonWhite = 0;
          for (let p = 0; p < packed.data.length; p += 4) {
            if (packed.data[p + 3] !== ao.data[p]) mismatches++;
            if (packed.data[p + 3] !== 255) nonWhite++;
          }
          expect(mismatches).toBe(0);
          expect(nonWhite).toBeGreaterThan(0);
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
      compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
      compactProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
    }) as THREE.MeshStandardNodeMaterial &
      ReturnType<typeof createTerrainMaterial>;
    const legacy = createTerrainMaterial() as THREE.MeshStandardNodeMaterial &
      ReturnType<typeof createTerrainMaterial>;
    try {
      expect(material.terrainUniforms.shade).toBe(shade);
      const compactAlbedo = graph(material.colorNode!);
      const legacyAlbedo = graph(legacy.colorNode!);
      const noiseSamples = [...compactAlbedo].filter(
        (node) =>
          Reflect.get(node, "value") === getNoiseTexture() &&
          Reflect.get(node, "uvNode"),
      );
      // Original classification/distortion plus one meadow sample. All reuse
      // the same allocated texture; only the meadow UV uses the new scale.
      expect(noiseSamples).toHaveLength(3);
      const meadowSamples = noiseSamples.filter((node) =>
        [...graph(Reflect.get(node, "uvNode") as Node)].some(
          (uv) => Reflect.get(uv, "value") === 0.006,
        ),
      );
      expect(meadowSamples).toHaveLength(1);
      expect(
        [...legacyAlbedo].some((node) => Reflect.get(node, "value") === 0.006),
      ).toBe(false);
      for (const node of [
        shade.tint,
        shade.strength,
        material.terrainUniforms.sunDirection,
      ])
        expect(compactAlbedo.has(node)).toBe(false);
      for (const node of [
        legacy.terrainUniforms.shade.tint,
        legacy.terrainUniforms.shade.strength,
        legacy.terrainUniforms.sunDirection,
      ])
        expect(legacyAlbedo.has(node)).toBe(true);
      expect(material.normalNode).toBeTruthy();
      expect(material.roughnessNode).toBeTruthy();
      expect(material.aoNode).toBeTruthy();
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
      expect(material.metalness).toBe(0);
      expect(material.fog).toBe(false);
      expect(material.outputNode).toBeTruthy();
      expect(Object.isFrozen(material.compactPondMaterial!.profile)).toBe(true);
      for (const root of [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
      ])
        expect(graph(root).has(material.compactPondMaterial!.parameters)).toBe(
          true,
        );
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
        expect(magnitude).toBeGreaterThan((1 / 1.4) * 0.81);
        expect(magnitude).toBeLessThan((1 / 1.4) * 1.19);
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
      // Historical grass/dirt baseline used 0.3 repeats/m. The current rock
      // projection scale must not redefine that retained comparison fixture.
      const oldPeriod = 1 / 0.3;
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
  it("redistributes real v4 coastal rock while retaining west-headland contrast", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const ops = createCompactTerrainColorOperations();
    try {
      await terrain.init();
      const profile = terrain.getWorldTerrainProfile();
      const field = ops.macroField(profile)!;
      const target =
        field.seaLevel + (field.baseElevation - field.seaLevel) * 0.25;
      const samples = [];
      for (let sector = 0; sector < 12; sector++) {
        const angle = (sector * Math.PI) / 6;
        const xz = (radius: number) =>
          [
            profile.island.centerX + Math.cos(angle) * radius,
            profile.island.centerZ + Math.sin(angle) * radius,
          ] as const;
        const height = (radius: number) =>
          terrain["getHeightAtComputed"](...xz(radius));
        let low = 0,
          high = 5;
        while (height(high) > target && high < 240) {
          low = high;
          high += 5;
        }
        expect(height(low)).toBeGreaterThan(target);
        expect(height(high)).toBeLessThanOrEqual(target);
        for (let i = 0; i < 30; i++) {
          const middle = (low + high) / 2;
          if (height(middle) > target) low = middle;
          else high = middle;
        }
        const [x, z] = xz((low + high) / 2);
        const y = terrain["getHeightAtComputed"](x, z);
        const color = terrain.getTerrainColorAt(x, z, true, "compact-pbr-v1");
        const noiseValue = sampleNoiseCPU(x, z, 0.0008);
        const distortNoise = sampleNoiseCPU(x, z, 0.067);
        const macro = ops.macroWeights(x, z, noiseValue, field);
        const coast = ops.coastWeights({
          x,
          z,
          height: y,
          noiseValue,
          distortNoise,
          westRock: macro.westRock,
          field,
        });
        const gpu = createCompactCoastWeights(
          vec3(x, y, z),
          float(noiseValue),
          float(distortNoise),
          float(macro.westRock),
          field,
        );
        expect(vectorValue(gpu.soil)[0]).toBeCloseTo(coast.soil, 13);
        expect(coast.soil).toBeGreaterThan(0.03);
        expect(coast.wetness).toBe(0);
        const cliff = ops.weights({
          noiseValue,
          distortNoise,
          slope: 1 - color.ny,
          roadInfluence: 0,
          macroSurface: macro,
        }).cliff;
        expect(cliff).toBeGreaterThan(0.95);
        expect(color.grassWeight).toBeLessThan(0.05);
        const expected = ops.sample({
          noiseValue,
          meadowNoise: sampleNoiseCPU(x, z, 0.006),
          distortNoise,
          slope: 1 - color.ny,
          roadInfluence: 0,
          surface: { x, z, height: y, pond: null, macroField: field },
        });
        expect(color.r).toBeCloseTo(expected.r, 12);
        expect(color.g).toBeCloseTo(expected.g, 12);
        expect(color.b).toBeCloseTo(expected.b, 12);
        samples.push({ sector, x, z, y, soil: coast.soil, cliff });
      }
      // Authored west bearing is pi. Compare actual shore, not a renamed noise patch.
      expect(samples[6].soil).toBeLessThan(samples[0].soil * 0.6);
      process.stdout.write(
        `Compact coast CPU anchors (not GPU/contact proof): ${JSON.stringify(samples)}\n`,
      );
    } finally {
      world.destroy();
    }
  });

  it("uses admitted sea/base/headland fields with narrow wetness and independent coast expectations", () => {
    const ops = createCompactTerrainColorOperations();
    const profile = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
    const field = ops.macroField(profile)!;
    const rise = profile.height.baseOffset - profile.water.threshold;
    const input = {
      x: profile.island.centerX + profile.island.radius,
      z: profile.island.centerZ,
      height: profile.water.threshold + rise * 0.2,
      noiseValue: 0.5,
      distortNoise: 0.5,
      westRock: 0,
      field,
    };
    // Independent fixed arithmetic: smoothstep(.35,.65,.5)=.5, giving
    // soil=.35+(.9-.35)*.5=.625 east; authored west headland retains72% rock.
    expect(ops.coastWeights(input)).toEqual({ soil: 0.625, wetness: 0 });
    expect(
      ops.coastWeights({
        ...input,
        x: profile.island.centerX - profile.island.radius,
      }).soil,
    ).toBeCloseTo(0.175, 14);
    expect(ops.coastWeights({ ...input, westRock: 1 }).soil).toBeCloseTo(
      0.40625,
      14,
    );
    expect(
      ops.coastWeights({ ...input, height: profile.water.threshold }).wetness,
    ).toBeCloseTo(0.896, 14);
    expect(
      ops.coastWeights({
        ...input,
        height: profile.water.threshold + rise * 0.04,
      }).wetness,
    ).toBe(0);
    expect(
      ops.coastWeights({
        ...input,
        height: profile.water.threshold - rise * 0.01,
      }).wetness,
    ).toBe(1);
    expect(ops.coastWeights({ ...input, height: field.baseElevation })).toEqual(
      { soil: 0, wetness: 0 },
    );
    expect(ops.coastWeights({ ...input, field: null })).toEqual({
      soil: 0,
      wetness: 0,
    });
    expect(ops.macroField(SCULPTED_COMPACT_V1_PROFILE_FIXTURE)).toBeNull();
    expect(() =>
      ops.macroField({
        ...profile,
        height: { ...profile.height, baseOffset: profile.water.threshold },
      }),
    ).toThrow("Invalid admitted macro surface field");
    const shifted = validateWorldTerrainProfile({
      ...profile,
      id: "coast-elevation-regression",
      water: { ...profile.water, threshold: profile.water.threshold - 4 },
      height: { ...profile.height, baseOffset: profile.height.baseOffset - 4 },
    });
    const shiftedField = ops.macroField(shifted)!;
    for (const h of [-0.1, 0, 0.02, 0.55, 0.74, 0.97, 1.1]) {
      const height = profile.water.threshold + h * rise;
      const a = ops.coastWeights({ ...input, height });
      const b = ops.coastWeights({
        ...input,
        height: height - 4,
        field: shiftedField,
      });
      expect(b.soil).toBeCloseTo(a.soil, 14);
      expect(b.wetness).toBeCloseTo(a.wetness, 14);
    }
  });

  it("matches coastal TSL arithmetic, continuous edges and full soil priorities without changing grass support", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE)!;
    const palette = ops.getPalette();
    const layer = (
      rgb: number[],
      roughness: number,
      ao: number,
    ): CompactTerrainLayer => ({
      albedo: vec3(...(rgb as [number, number, number])),
      roughness: float(roughness),
      ao: float(ao),
      worldNormal: vec3(0, 1, 0),
    });
    const layers = {
      grass: layer(palette.grass, 0.91, 0.8),
      dirt: layer(palette.dirt, 0.88, 0.9),
      rock: layer(palette.rock, 0.76, 0.7),
    };
    for (const [x, z] of [
      [190, 400],
      [350, 235],
      [510, 400],
      [430, 478],
      [350, 565],
      [350, 400],
    ])
      for (const relative of [-0.02, 0, 0.02, 0.5, 0.72, 0.97, 1.1])
        for (const noise of [0.1, 0.5, 0.9]) {
          const height =
            field.seaLevel + relative * (field.baseElevation - field.seaLevel);
          const edge = 1 - noise;
          const macro = ops.macroWeights(x, z, noise, field);
          const coast = ops.coastWeights({
            x,
            z,
            height,
            noiseValue: noise,
            distortNoise: edge,
            westRock: macro.westRock,
            field,
          });
          const actual = createCompactCoastWeights(
            vec3(x, height, z),
            float(noise),
            float(edge),
            float(macro.westRock),
            field,
          );
          for (const key of ["soil", "wetness"] as const) {
            expect(vectorValue(actual[key])[0]).toBeCloseTo(coast[key], 13);
            expect(coast[key]).toBeGreaterThanOrEqual(0);
            expect(coast[key]).toBeLessThanOrEqual(1);
            const beside = ops.coastWeights({
              x: x + 1e-6,
              z,
              height: height + 1e-6,
              noiseValue: noise,
              distortNoise: edge,
              westRock: macro.westRock,
              field,
            });
            expect(Math.abs(coast[key] - beside[key])).toBeLessThan(1e-4);
          }
          const coastalRock = applyCompactCoastRock(
            layers.rock,
            layers.dirt,
            actual,
          );
          const expectedRoughness = 0.76 + (0.88 - 0.76) * coast.soil;
          expect(vectorValue(coastalRock.roughness)[0]).toBeCloseTo(
            expectedRoughness + (0.58 - expectedRoughness) * coast.wetness,
            13,
          );
          expect(vectorValue(coastalRock.ao)[0]).toBeCloseTo(
            0.7 + 0.2 * coast.soil,
            13,
          );
          expect(vectorValue(coastalRock.worldNormal)).toEqual([0, 1, 0]);
          for (const slope of [0, 0.1, 0.5])
            for (const road of [0, 1]) {
              const input = {
                noiseValue: noise,
                distortNoise: edge,
                slope,
                roadInfluence: road,
                surface: { x, z, height, pond: null, macroField: field },
              };
              const weights = ops.weights({ ...input, macroSurface: macro });
              const surface = blendCompactTerrainLayers(
                {
                  ...layers,
                  grass: applyCompactMeadowTint(
                    layers.grass,
                    float(noise),
                    float(macro.dry),
                  ),
                  rock: coastalRock,
                },
                float(weights.dirt),
                float(weights.cliff),
                float(weights.road),
              );
              const rgb = vectorValue(surface.albedo.mul(weights.variation));
              const cpu = ops.sample(input);
              for (const [i, key] of ["r", "g", "b"].entries())
                expect(rgb[i]).toBeCloseTo(cpu[key as "r" | "g" | "b"], 13);
              const support = ops.grassSupport(input);
              expect(support).toBe((1 - weights.dirt) * (1 - weights.cliff));
              if (road === 1) {
                expect(vectorValue(surface.roughness)[0]).toBeCloseTo(0.88, 13);
                rgb.forEach((value, i) =>
                  expect(value).toBeCloseTo(
                    palette.dirt[i] * weights.variation,
                    13,
                  ),
                );
              }
              if (slope === 0) {
                const withoutCoast = ops.sample({
                  ...input,
                  surface: { ...input.surface, height: field.baseElevation },
                });
                expect(cpu).toEqual(withoutCoast);
              }
            }
          // Full pond soil wins even in an artificial below-ocean overlap.
          const pondSurface = applyCompactPondWetness(
            blendCompactTerrainLayers(
              { ...layers, rock: coastalRock },
              float(1),
              float(0),
              float(0),
            ),
            float(1),
          );
          expect(vectorValue(pondSurface.albedo)).toEqual(
            palette.dirt.map((v) => v * 0.72),
          );
          expect(vectorValue(pondSurface.roughness)[0]).toBeCloseTo(0.62, 13);
        }
  });

  it("matches admitted ridge-field TSL, physical-layer weights and CPU RGB with protected soil overrides", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE)!;
    const palette = ops.getPalette();
    const layer = (rgb: number[]): CompactTerrainLayer => ({
      albedo: vec3(...(rgb as [number, number, number])),
      roughness: float(0.8),
      ao: float(1),
      worldNormal: vec3(0, 1, 0),
    });
    const layers = {
      grass: layer(palette.grass),
      dirt: layer(palette.dirt),
      rock: layer(palette.rock),
    };
    for (const [x, z] of [
      [225, 410],
      [238, 410],
      [260, 410],
      [280, 410],
      [246, 365],
      [256, 457],
      [350, 320],
      [343, 302],
    ]) {
      for (const noise of [0, 0.5, 1]) {
        const cpuMacro = ops.macroWeights(x, z, noise, field);
        const gpuMacro = createCompactTerrainMacroWeights(
          vec2(x, z),
          float(noise),
          field,
        );
        for (const key of ["dry", "westRock"] as const)
          expect(vectorValue(gpuMacro[key])[0]).toBeCloseTo(cpuMacro[key], 13);
        for (const slope of [0, 0.03, 0.07, 0.15, 0.5]) {
          for (const road of [0, 0.4, 1]) {
            const cpuWeights = ops.weights({
              noiseValue: noise,
              slope,
              roadInfluence: road,
              macroSurface: cpuMacro,
            });
            const weights = createCompactTerrainLayerWeights(
              float(noise),
              float(slope),
              float(road),
              float(0.5),
              undefined,
              gpuMacro,
            );
            for (const key of ["dirt", "cliff", "road", "variation"] as const)
              expect(vectorValue(weights[key])[0]).toBeCloseTo(
                cpuWeights[key],
                13,
              );
            const surface = blendCompactTerrainLayers(
              {
                ...layers,
                grass: applyCompactMeadowTint(
                  layers.grass,
                  float(noise),
                  gpuMacro.dry,
                ),
              },
              weights.dirt,
              weights.cliff,
              weights.road,
            );
            const rgb = vectorValue(surface.albedo.mul(weights.variation));
            const expected = ops.sample({
              noiseValue: noise,
              distortNoise: 0.5,
              slope,
              roadInfluence: road,
              surface: { x, z, height: 30, pond: null, macroField: field },
            });
            expect(rgb[0]).toBeCloseTo(expected.r, 13);
            expect(rgb[1]).toBeCloseTo(expected.g, 13);
            expect(rgb[2]).toBeCloseTo(expected.b, 13);
            if (road === 1) {
              for (let channel = 0; channel < 3; channel++)
                expect(rgb[channel]).toBeCloseTo(
                  palette.dirt[channel] * cpuWeights.variation,
                  13,
                );
            }
          }
          // Explicit overlap stress case: soil must win even if a future admitted
          // pond occupies the ridge. This does not move any runtime water body.
          const pondWeights = createCompactTerrainLayerWeights(
            float(noise),
            float(slope),
            float(0),
            float(0.5),
            { soil: float(1), wetness: float(1) },
            gpuMacro,
          );
          expect(vectorValue(pondWeights.dirt)[0]).toBe(1);
          expect(vectorValue(pondWeights.cliff)[0]).toBe(0);
        }
      }
    }
  });

  it("composes fresh and dry grass linear albedo with bounded, matching CPU and real TSL arithmetic", async () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    const grass: CompactTerrainLayer = {
      albedo: vec3(...(palette.grass as [number, number, number])),
      roughness: float(0.85),
      ao: float(0.8),
      worldNormal: vec3(0, 1, 0),
    };
    for (const [noise, dryness] of [
      [-1, 0],
      [0.43, 0],
      [0.515, 0.5],
      [0.6, 1],
      [2, 1],
    ]) {
      // Independent intended formula, in linear units, not sRGB multiplication.
      const expected = [
        0.8 + (1.85 - 0.8) * dryness,
        1.25,
        0.65 + (1.2 - 0.65) * dryness,
      ];
      const actual = applyCompactMeadowTint(grass, float(noise));
      const rgb = vectorValue(actual.albedo);
      const cpu = ops.meadowTint(noise);
      for (let channel = 0; channel < 3; channel++) {
        expect(cpu[channel]).toBeCloseTo(expected[channel], 14);
        expect(rgb[channel]).toBeCloseTo(
          palette.grass[channel] * expected[channel],
          14,
        );
      }
      expect(actual.roughness).toBe(grass.roughness);
      expect(actual.ao).toBe(grass.ao);
      expect(actual.worldNormal).toBe(grass.worldNormal);
      expect(actual).not.toBe(grass);
      expect(vectorValue(grass.albedo)).toEqual(palette.grass);
      expect([...graph(actual.albedo)].some((node) => node.isTextureNode)).toBe(
        false,
      );
    }
    // The six maps are hash-locked elsewhere in this suite. Check that the
    // strongest linear tint never clips their actual grass diffuse texels.
    const image = PNG.sync.read(
      await readFile(new URL("grass-albedo-roughness.png", assetDirectory)),
    );
    const maximum = [0, 0, 0];
    for (let offset = 0; offset < image.data.length; offset += 4)
      for (let channel = 0; channel < 3; channel++)
        maximum[channel] = Math.max(
          maximum[channel],
          image.data[offset + channel],
        );
    // Each channel has its own maximum: green peaks in the greener meadow,
    // not on the dry shoulder. Check every endpoint of both linear blends.
    const tintCorners = [0, 1].flatMap((noise) =>
      [0, 1].map((macro) => ops.meadowTint(noise, macro)),
    );
    const strongest = [0, 1, 2].map((channel) =>
      Math.max(...tintCorners.map((tint) => tint[channel])),
    );
    for (let channel = 0; channel < 3; channel++) {
      const srgb = maximum[channel] / 255;
      const linear =
        srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      expect(linear * strongest[channel]).toBeLessThan(1);
    }
  });

  it("keeps dry meadow grass support and protected soil independent of its color field", () => {
    const ops = createCompactTerrainColorOperations();
    const layer: CompactTerrainLayer = {
      albedo: vec3(...(ops.getPalette().grass as [number, number, number])),
      roughness: float(0.85),
      ao: float(0.8),
      worldNormal: vec3(0, 1, 0),
    };
    const base = {
      noiseValue: 0.52,
      distortNoise: 0.47,
      slope: 0,
      roadInfluence: 0,
      surface: { x: 350, z: 320, height: 28.4, pond: null },
    };
    const support = ops.grassSupport(base),
      colors = [];
    for (const meadowNoise of [0, 0.43, 0.515, 0.6, 1]) {
      const input = { ...base, meadowNoise };
      expect(ops.grassSupport(input)).toBe(support);
      expect(ops.weights(input)).toEqual(ops.weights(base));
      const actual = applyCompactMeadowTint(layer, float(meadowNoise));
      const weights = ops.weights(base),
        palette = ops.getPalette();
      const expected = vectorValue(actual.albedo).map(
        (v, i) =>
          (v + (palette.dirt[i] - v) * weights.dirt) * weights.variation,
      );
      const color = ops.sample(input);
      colors.push(color.r);
      for (const [i, key] of ["r", "g", "b"].entries())
        expect(color[key as "r" | "g" | "b"]).toBeCloseTo(expected[i], 13);
      expect(ops.sample({ ...input, roadInfluence: 1 })).toEqual(
        ops.sample({ ...base, roadInfluence: 1 }),
      );
    }
    expect(Math.max(...colors) - Math.min(...colors)).toBeGreaterThan(0.12);
  });

  it("exposes real geometric ridge slopes while preserving flat turf, soil paths and pond beds", () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    for (const degrees of [0, 10, 20, 22, 25, 30, 35, 40, 60, 90]) {
      const slope = 1 - Math.cos((degrees * Math.PI) / 180);
      const t = Math.max(0, Math.min(1, (slope - 0.07) / (0.23 - 0.07)));
      const expected = t * t * (3 - 2 * t);
      const cpu = ops.weights({ noiseValue: 0.5, slope, roadInfluence: 0 });
      const nodes = createCompactTerrainLayerWeights(
        float(0.5),
        float(slope),
        float(0),
      );
      expect(cpu.cliff).toBeCloseTo(expected, 14);
      expect(vectorValue(nodes.cliff)[0]).toBeCloseTo(expected, 14);
      if (degrees <= 20) expect(cpu.cliff).toBe(0);
      if (degrees >= 40) expect(cpu.cliff).toBe(1);
      const protectedPond = ops.weights({
        noiseValue: 0.5,
        slope,
        roadInfluence: 0,
        pondSurface: { soil: 1, wetness: 1 },
      });
      expect(protectedPond.cliff).toBe(0);
      expect(protectedPond.dirt).toBe(1);
      expect(
        ops.sample({
          noiseValue: 0.5,
          distortNoise: 0.5,
          slope,
          roadInfluence: 1,
        }),
      ).toEqual({
        r: palette.dirt[0],
        g: palette.dirt[1],
        b: palette.dirt[2],
      });
    }
    // Test the authored range against the real cached world-noise field.
    const dryness: number[] = [];
    for (let x = 150; x <= 550; x += 20)
      for (let z = 200; z <= 600; z += 20) {
        const noise = sampleNoiseCPU(x, z, 0.006);
        const t = Math.max(0, Math.min(1, (noise - 0.43) / (0.6 - 0.43)));
        const expected = t * t * (3 - 2 * t);
        const actual = (ops.meadowTint(noise)[0] - 0.8) / (1.85 - 0.8);
        expect(actual).toBeCloseTo(expected, 12);
        dryness.push(actual);
      }
    expect(Math.max(...dryness) - Math.min(...dryness)).toBeGreaterThan(0.25);
  });

  it("matches real TSL wet-soil/bed layers and CPU colour without affecting remote terrain", () => {
    const ops = createCompactTerrainColorOperations();
    const pond = ops.validatePond(ALL_WORLD_AREAS.haven_pond.waterBodies![0])!;
    const uniform = vec4(
      pond.centerX,
      pond.centerZ,
      pond.radius,
      pond.surfaceY,
    );
    const palette = ops.getPalette();
    const layer = (rgb: number[]): CompactTerrainLayer => ({
      albedo: vec3(...(rgb as [number, number, number])),
      roughness: float(0.85),
      ao: float(1),
      worldNormal: vec3(0, 1, 0),
    });
    const layers = {
      grass: layer(palette.grass),
      dirt: layer(palette.dirt),
      rock: layer(palette.rock),
    };
    for (const distance of [0, 5, 7.5, 9, 10.4, 11, 80])
      for (const relativeHeight of [-2, -0.1, 0.1, 0.28, 0.6, 1, 1.5])
        for (const noise of [0, 0.25, 0.5, 0.75, 1]) {
          const input = {
            x: pond.centerX + distance,
            z: pond.centerZ,
            height: pond.surfaceY + relativeHeight,
            pond,
            noiseValue: noise,
          };
          const cpu = ops.pondWeights(input);
          const gpu = createCompactPondSurfaceWeights(
            vec3(input.x, input.height, input.z),
            float(noise),
            uniform,
          );
          expect(vectorValue(gpu.soil)[0]).toBeCloseTo(cpu.soil, 12);
          expect(vectorValue(gpu.wetness)[0]).toBeCloseTo(cpu.wetness, 12);
          if (distance > pond.radius + 3)
            expect(cpu).toEqual({ soil: 0, wetness: 0 });
          if (distance <= pond.radius && relativeHeight < -0.1)
            expect(cpu).toEqual({ soil: 1, wetness: 1 });
          // The actual dry bank is only 0.28m above this water surface. It
          // must retain turf rather than becoming a wide bare-soil annulus.
          if (relativeHeight >= 0.28) {
            expect(cpu.soil).toBeCloseTo(0, 12);
            expect(cpu.wetness).toBe(0);
          }
          const weights = createCompactTerrainLayerWeights(
            float(0.5),
            float(0.4),
            float(0),
            float(noise),
            gpu,
          );
          const material = applyCompactPondWetness(
            blendCompactTerrainLayers(
              {
                ...layers,
                grass: applyCompactMeadowTint(layers.grass, float(0.5)),
              },
              weights.dirt,
              weights.cliff,
              weights.road,
            ),
            gpu.wetness,
          );
          const rgb = vectorValue(material.albedo);
          const colour = ops.sample({
            noiseValue: 0.5,
            distortNoise: noise,
            slope: 0.4,
            roadInfluence: 0,
            surface: input,
          });
          expect(rgb[0]).toBeCloseTo(colour.r, 12);
          expect(rgb[1]).toBeCloseTo(colour.g, 12);
          expect(rgb[2]).toBeCloseTo(colour.b, 12);
          expect(vectorValue(material.roughness)[0]).toBeCloseTo(
            0.85 + (0.62 - 0.85) * cpu.wetness,
            12,
          );
        }
    expect(ops.validatePond(null)).toBeNull();
    for (const radius of [0, -1, Infinity, NaN, 129])
      expect(() => ops.validatePond({ ...pond, radius })).toThrow();
    const moved = ops.validatePond({
      ...pond,
      centerX: pond.centerX + 100,
      centerZ: pond.centerZ - 40,
      surfaceY: pond.surfaceY + 3,
    })!;
    expect(
      ops.pondWeights({
        x: moved.centerX,
        z: moved.centerZ,
        height: moved.surfaceY - 1,
        noiseValue: 0.5,
        pond: moved,
      }),
    ).toEqual({ soil: 1, wetness: 1 });
  });
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
    expect(grass.r).toBeCloseTo(palette.grass[0] * 0.8 * 0.984, 14);
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

  it("matches actual compact TSL weights and RGB while retaining full dirt paths over the meadow", () => {
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
            {
              ...layers,
              grass: applyCompactMeadowTint(layers.grass, float(noiseValue)),
            },
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
    expect(COMPACT_TERRAIN_MATERIAL.repeatsPerMeter).toBe(1 / 2.7);
    expect(COMPACT_TERRAIN_MATERIAL.grassRepeatsPerMeter).toBe(1 / 1.4);
    expect(COMPACT_TERRAIN_MATERIAL.dirtRepeatsPerMeter).toBe(0.95);
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
      surface: {
        x: 343,
        z: 310,
        height: 28.08,
        pond: createCompactTerrainColorOperations().validatePond(
          ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        ),
        macroField: createCompactTerrainColorOperations().macroField(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        ),
      },
    };
    const inputs = [input];
    for (const x of [190, 350, 510])
      for (const height of [15.8, 16, 16.2, 20, 25, 28.15])
        inputs.push({
          ...input,
          surface: { ...input.surface, x, z: 400, height },
        });
    for (const slope of [0, 0.07, 0.15, 0.23, 0.8])
      for (const noiseValue of [0, 0.28, 0.5, 0.72, 1])
        for (const roadInfluence of [0, 0.5, 1])
          inputs.push({ ...input, slope, noiseValue, roadInfluence });
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads'); const operations=(${loaded.createCompactTerrainColorOperations.toString()})(); parentPort.postMessage(${JSON.stringify(inputs)}.map(input=>operations.sample(input)));`,
      { eval: true },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(
        inputs.map((value) =>
          createCompactTerrainColorOperations().sample(value),
        ),
      );
    } finally {
      await worker.terminate();
    }
  });
});
