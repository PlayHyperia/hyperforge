import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import THREE, {
  float,
  mat4,
  cameraViewMatrix,
  normalWorldGeometry,
  positionWorld,
  texture,
  vec2,
  vec3,
  vec4,
} from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import {
  createTerrainMaterial as createRuntimeTerrainMaterial,
  TerrainShadeUniforms,
  sampleNoiseCPU,
  getNoiseTexture,
} from "../TerrainShader";
import {
  COMPACT_TERRAIN_BITMAP_OPTIONS,
  COMPACT_TERRAIN_MATERIAL,
  COMPACT_GRASS_SUBSTRATE,
  COMPACT_TERRAIN_TEXTURE_SHA256,
  COMPACT_TERRAIN_HEIGHT_SHA256,
  COMPACT_TERRAIN_POND_RELIEF,
  COMPACT_TERRAIN_COAST_DETAIL,
  COMPACT_TERRAIN_COAST_CAVITY,
  CompactTerrainTextureSet,
  createCompactTerrainLayers,
  createCompactRockAppearanceRequired,
  createCompactDryGrassRoughness,
  createCompactCotangentNormal,
  createCompactTerrainLayerWeights,
  blendCompactTerrainLayers,
  compactTerrainNormalToView,
  createCompactGroundProjections,
  createCompactGrassSubstrateGradients,
  createCompactDirtProjections,
  createCompactStochasticProjections,
  blendCompactStochasticAlbedo,
  createCompactDirtVertexHash,
  blendCompactDirtAlbedo,
  blendCompactRockAlbedo,
  createCompactPondSurfaceWeights,
  createCompactPondMargin,
  applyCompactPondMarginGrass,
  createCompactPondBankComposition,
  applyCompactPondBankCompositionWeights,
  applyCompactPondBankGrass,
  createCompactPondBankSediment,
  createCompactPondContactSoil,
  createCompactPondRockContact,
  applyCompactPondRockContactWeights,
  applyCompactPondWetness,
  applyCompactPondRockSoil,
  applyCompactPondBankMaterials,
  applyCompactMeadowTint,
  applyCompactFineGrassSubstrateContrast,
  applyCompactGrassColorGrade,
  applyCompactBankVergeGrassTint,
  createCompactBankVergeLocality,
  createCompactBankVergeWear,
  createCompactBankVergeHeightScale,
  createCompactTerrainMacroWeights,
  createCompactCoastWeights,
  createCompactCoastalGroundCover,
  applyCompactCoastRock,
  createCompactPlantingSoil,
  createCompactHavenGroundWeights,
  createCompactHabitatSoilNode,
  createCompactWornTurfWeights,
  createCompactHeightSoilCoverage,
  createCompactPondReliefSoilCoverage,
  applyCompactPondReliefWeights,
  createCompactCoastDetailMask,
  applyCompactCoastDetailWeights,
  applyCompactCoastCavityWeights,
  createCompactCoastCavityPondClearance,
  createCompactCoastDistribution,
  applyCompactCoastDistributionWeights,
  createCompactTerrainDiagnosticOutputs,
  type CompactTerrainLayer,
  type CompactGrassSubstrate,
} from "../CompactTerrainMaterial";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainPlantingLobe,
  type CompactTerrainBankVerge,
  type CompactTerrainGroundRibbon,
  type CompactGrassColorGrade,
  type CompactPondMarginInput,
  type CompactPondBankMath,
} from "../CompactTerrainPalette";
import type { FlatZone } from "../../../../types/world/terrain";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { DataManager } from "../../../../data/DataManager";
import { World } from "../../../../core/World";
import { TerrainSystem } from "../TerrainSystem";
import { createCompactServiceSoil } from "../CompactServiceCourt";
import { getRoadInfluenceTextureState } from "../RoadInfluenceMask";
import { getLamppostLightTextureState } from "../LamppostLightMask";
import habitatData from "../../../../data/compact-haven-habitat-v1.json";
import { validateCompactHabitatComposition } from "../CompactHabitatComposition";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";

// Exercise the real factory and narrow its intentionally broad public return
// type before inspecting node-material graphs. No replacement material is made.
function createTerrainMaterial(
  ...args: Parameters<typeof createRuntimeTerrainMaterial>
) {
  const material = createRuntimeTerrainMaterial(...args);
  if (!(material instanceof THREE.MeshStandardNodeMaterial)) {
    material.dispose();
    throw new Error("Terrain graph checks require the actual node material");
  }
  return material;
}

describe("opt-in Haven habitat material (actual TSL graph, not GPU proof)", () => {
  const habitat = validateCompactHabitatComposition(
    habitatData.composition,
    habitatData.bounds,
  );
  // Independent signed polygon distances from authored vertices, not the
  // production compiled half-planes or its CPU sampler.
  const expectedSoil = (x: number, z: number) =>
    Math.max(
      0,
      ...habitatData.composition.pockets.map((pocket) => {
        const distance = Math.min(
          ...pocket.vertices.map(([ax, az], i) => {
            const [bx, bz] = pocket.vertices[(i + 1) % pocket.vertices.length];
            return (
              ((bx - ax) * (z - az) - (bz - az) * (x - ax)) /
              Math.hypot(bx - ax, bz - az)
            );
          }),
        );
        const t = THREE.MathUtils.clamp(distance / pocket.edgeWidth, 0, 1);
        return pocket.strength * t * t * (3 - 2 * t);
      }),
    );

  it("uses the same authored soil weight across all four PBR channels with cliff and road priority", () => {
    const layers = {
      grass: {
        albedo: vec3(0.1, 0.2, 0.3),
        roughness: float(0.4),
        ao: float(0.2),
        worldNormal: vec3(0, 1, 0),
      },
      dirt: {
        albedo: vec3(0.3, 0.2, 0.1),
        roughness: float(0.7),
        ao: float(0.6),
        worldNormal: vec3(0.6, 0.8, 0),
      },
      rock: {
        albedo: vec3(0.6, 0.5, 0.4),
        roughness: float(0.9),
        ao: float(0.8),
        worldNormal: vec3(0, 0.8, 0.6),
      },
    };
    for (const [x, z] of [
      [299, 330],
      [305, 305],
      [306, 306],
      [318.5, 312.5],
      [316, 332],
      [318.5, 344.5],
      [326.8, 331.6],
    ]) {
      const soil = createCompactHabitatSoilNode(
        float(x),
        float(z),
        habitat,
      ).toVar("testedHabitatSoil");
      const weight = expectedSoil(x, z);
      expect(vectorValue(soil)[0]).toBeCloseTo(weight, 12);
      for (const [dirt, talus, wear, cliff, road] of [
        [0, 0, 0, 0, 0],
        [0.23, 0.31, 0.17, 0.41, 0.29],
        [1, 0, 0, 0, 0],
        [0, 0.5, 0.3, 1, 0],
        [0, 0.5, 0.3, 0.4, 1],
      ]) {
        const surface = blendCompactTerrainLayers(
          layers,
          float(dirt),
          float(cliff),
          float(road),
          { talus: float(talus), wear: float(wear) },
          soil,
        );
        const mix = THREE.MathUtils.lerp;
        const expected = (g: number, d: number, r: number) =>
          mix(
            mix(
              mix(
                mix(mix(mix(g, d, dirt), mix(d, r, 0.85), talus), d, wear),
                d,
                weight,
              ),
              r,
              cliff,
            ),
            d,
            road,
          );
        for (const key of ["albedo", "roughness", "ao"] as const) {
          expect(graph(surface[key]).has(soil)).toBe(true);
          const a = vectorValue(layers.grass[key]),
            b = vectorValue(layers.dirt[key]),
            c = vectorValue(layers.rock[key]);
          vectorValue(surface[key]).forEach((value, i) =>
            expect(value).toBeCloseTo(expected(a[i], b[i], c[i]), 12),
          );
        }
        expect(graph(surface.normal).has(soil)).toBe(true);
        const worldNormals = [...graph(surface.normal)].filter(
          (node) =>
            Reflect.get(node, "method") === "normalize" &&
            !graph(node).has(cameraViewMatrix) &&
            Object.values(layers).every((layer) =>
              graph(node).has(layer.worldNormal),
            ),
        );
        expect(worldNormals).toHaveLength(1);
        const normal = new THREE.Vector3(
          ...[0, 1, 2].map((i) =>
            expected(
              vectorValue(layers.grass.worldNormal)[i],
              vectorValue(layers.dirt.worldNormal)[i],
              vectorValue(layers.rock.worldNormal)[i],
            ),
          ),
        )
          .normalize()
          .toArray();
        vectorValue(worldNormals[0]).forEach((value, i) =>
          expect(value).toBeCloseTo(normal[i], 12),
        );
        if (weight === 0) {
          const original = blendCompactTerrainLayers(
            layers,
            float(dirt),
            float(cliff),
            float(road),
            { talus: float(talus), wear: float(wear) },
          );
          for (const key of ["albedo", "roughness", "ao"] as const)
            expect(vectorValue(surface[key])).toEqual(
              vectorValue(original[key]),
            );
        }
      }
    }
    expect(expectedSoil(318.5, 312.5)).toBe(0.38);
    expect(expectedSoil(318.5, 344.5)).toBe(0.46);
    expect(expectedSoil(299, 330)).toBe(0);
  });

  it("shares one actual field and soil node without adding sampled maps or changing material geometry", () => {
    const options = {
      compactPbr: true,
      compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
    };
    const baseline = createTerrainMaterial(undefined, options);
    const material = createTerrainMaterial(undefined, {
      ...options,
      compactHabitat: habitat,
    });
    try {
      expect(material.compactHabitatMaterial).toBe(habitat);
      expect(Object.isFrozen(material.compactHabitatMaterial)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(material, "compactHabitatMaterial"),
      ).toEqual({
        value: habitat,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      expect(baseline.compactHabitatMaterial).toBeUndefined();
      let shared: Node | undefined;
      for (const owner of [baseline, material]) {
        expect(owner.positionNode).toBeNull();
        expect(owner.displacementMap).toBeNull();
        expect(owner.transparent).toBe(false);
        expect(owner.depthWrite).toBe(true);
        const receipt = owner.compactTerrainSurface!.getReceipt();
        expect(receipt.textures).toHaveLength(6);
        expect(receipt.surfaceSampleCount).toBe(20);
        const textureOwners = new Set(
          receipt.textures.map((entry) => entry.textureUuid),
        );
        const samples = new Set<Node>();
        const seen = new Set<string>();
        for (const root of [
          owner.colorNode!,
          owner.normalNode!,
          owner.roughnessNode!,
          owner.aoNode!,
        ]) {
          const nodes = graph(root);
          const weights = [...nodes].filter(
            (node) => Reflect.get(node, "name") === "compactHabitatSoil",
          );
          expect(weights).toHaveLength(owner === material ? 1 : 0);
          if (owner === material) {
            shared ??= weights[0];
            expect(weights[0]).toBe(shared);
          }
          for (const node of nodes) {
            const value: unknown = Reflect.get(node, "value");
            if (
              value instanceof THREE.Texture &&
              textureOwners.has(value.uuid)
            ) {
              seen.add(value.uuid);
              if (Reflect.get(node, "uvNode")) samples.add(node);
            }
          }
        }
        expect(seen.size).toBe(6);
        expect(samples.size).toBe(20);
      }
      for (const invalid of [
        {
          compactPbr: false,
          compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
        },
        {
          compactPbr: true,
          compactProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        },
      ])
        expect(() =>
          createTerrainMaterial(undefined, {
            ...invalid,
            compactHabitat: habitat,
          }),
        ).toThrow("Habitat composition requires the full Haven PBR material");
    } finally {
      material.dispose();
      baseline.dispose();
    }
  });
});

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

const assetDirectory = new URL(
  "../../../../../../server/world/assets/terrain/textures/compact-pbr/",
  import.meta.url,
);

describe("bounded compact planting soil arithmetic", () => {
  const ops = createCompactTerrainColorOperations();
  const lobes: readonly CompactTerrainPlantingLobe[] = Object.freeze([
    Object.freeze({
      centerX: 329.2,
      centerZ: 336.1,
      radiusX: 1.35,
      radiusZ: 2.1,
    }),
    Object.freeze({
      centerX: 329.35,
      centerZ: 340.9,
      radiusX: 1.5,
      radiusZ: 2.2,
    }),
    Object.freeze({
      centerX: 343.7,
      centerZ: 338.3,
      radiusX: 1.38,
      radiusZ: 1.7,
    }),
    Object.freeze({
      centerX: 343.95,
      centerZ: 340.65,
      radiusX: 1.4,
      radiusZ: 1.95,
    }),
  ]);

  it("admits detached frozen bounded fields and rejects accessor/noncanonical data", () => {
    for (const absent of [undefined, null, []]) {
      const empty = ops.validatePlantingLobes(absent);
      expect(empty).toEqual([]);
      expect(Object.isFrozen(empty)).toBe(true);
    }
    const input = structuredClone(lobes);
    const admitted = ops.validatePlantingLobes(input);
    expect(admitted).toEqual(input);
    expect(admitted).not.toBe(input);
    expect(Object.isFrozen(admitted)).toBe(true);
    for (let i = 0; i < admitted.length; i++) {
      expect(admitted[i]).not.toBe(input[i]);
      expect(Object.isFrozen(admitted[i])).toBe(true);
    }
    let getterReads = 0;
    const accessor = { ...lobes[0] };
    Object.defineProperty(accessor, "centerX", {
      get() {
        getterReads++;
        return 329;
      },
    });
    const listAccessor = [lobes[0]];
    Object.defineProperty(listAccessor, "0", {
      get() {
        getterReads++;
        return lobes[0];
      },
    });
    for (const invalid of [
      {},
      "[]",
      Array(1),
      [...lobes, lobes[0]],
      Object.assign([lobes[0]], { extra: 1 }),
      listAccessor,
      [null],
      [accessor],
      [{ ...lobes[0], extra: 1 }],
      [{ ...lobes[0], [Symbol("extra")]: 1 }],
      [{ centerX: 329, centerZ: 336, radiusX: 1 }],
      [{ ...lobes[0], centerX: Infinity }],
      [{ ...lobes[0], centerZ: NaN }],
      [{ ...lobes[0], centerX: "329" }],
      [{ ...lobes[0], centerZ: -10000.001 }],
      [{ ...lobes[0], centerX: 10000.001 }],
      [{ ...lobes[0], radiusX: 0.749 }],
      [{ ...lobes[0], radiusZ: 3.001 }],
    ])
      expect(() => ops.validatePlantingLobes(invalid)).toThrow(/planting lobe/);
    expect(getterReads).toBe(0);
    expect(
      ops.validatePlantingLobes([
        { centerX: -10000, centerZ: 10000, radiusX: 0.75, radiusZ: 3 },
      ]),
    ).toHaveLength(1);
  });

  it("has exact compact support, bounded feather noise and max-only overlaps", () => {
    const unit = { centerX: 0, centerZ: 0, radiusX: 1, radiusZ: 2 };
    for (const noise of [-10, 0, 0.25, 0.5, 1, 10]) {
      expect(ops.plantingSoil(0, 0, noise, [unit])).toBe(0.9);
      for (const [x, z] of [
        [1, 0],
        [-1, 0],
        [0, 2],
        [0, -2],
        [1, 2],
      ])
        expect(ops.plantingSoil(x, z, noise, [unit])).toBe(0);
      for (let angle = 0; angle < 6.28; angle += 0.05) {
        const x = Math.cos(angle) * 1.000001;
        const z = Math.sin(angle) * 2.000002;
        expect(ops.plantingSoil(x, z, noise, [unit])).toBe(0);
      }
    }
    for (let x = -1.1; x < 1.11; x += 0.1) {
      expect(ops.plantingSoil(x, 0, -10, [unit])).toBe(
        ops.plantingSoil(x, 0, 0, [unit]),
      );
      expect(ops.plantingSoil(x, 0, 10, [unit])).toBe(
        ops.plantingSoil(x, 0, 1, [unit]),
      );
    }
    const prior = JSON.stringify(lobes);
    for (let x = 327; x <= 346; x += 0.5)
      for (let z = 333; z <= 344; z += 0.5) {
        const expected = Math.max(
          ...lobes.map((lobe) => ops.plantingSoil(x, z, 0.4, [lobe])),
        );
        expect(ops.plantingSoil(x, z, 0.4, lobes)).toBe(expected);
        expect(ops.plantingSoil(x, z, 0.4, [...lobes, ...lobes])).toBe(
          expected,
        );
        expect(expected).toBeGreaterThanOrEqual(0);
        expect(expected).toBeLessThanOrEqual(0.9);
      }
    expect(JSON.stringify(lobes)).toBe(prior);
    for (const point of [
      [329.3, 338.45],
      [336.5, 337.5],
      [343, 302],
      [350, 327],
    ])
      expect(ops.plantingSoil(point[0], point[1], 0.5, lobes)).toBe(0);
    for (const absent of [undefined, null, []]) {
      expect(ops.plantingSoil(329.2, 336.1, 0.5, absent)).toBe(0);
      const emptyNode = createCompactPlantingSoil(
        vec3(329.2, 28, 336.1),
        float(0.5),
        absent,
      );
      expect(vectorValue(emptyNode)).toEqual([0]);
      expect([...graph(emptyNode)].map((node) => node.type)).toEqual(
        [...graph(float(0))].map((node) => node.type),
      );
    }
  });

  it("matches actual TSL node algebra without texture, light, height or extra-pass nodes", () => {
    for (const noise of [-1, 0, 0.35, 0.8, 1, 2])
      for (const lobe of lobes)
        for (const [dx, dz] of [
          [0, 0],
          [0.65, 0.2],
          [-0.82, 0.2],
          [0.92, 0],
          [1.01, 0],
          [0.2, 1.05],
        ]) {
          const x = lobe.centerX + dx * lobe.radiusX;
          const z = lobe.centerZ + dz * lobe.radiusZ;
          const node = createCompactPlantingSoil(
            vec3(x, 28, z),
            float(noise),
            lobes,
          );
          expect(vectorValue(node)[0]).toBeCloseTo(
            ops.plantingSoil(x, z, noise, lobes),
            13,
          );
          const nodes = [...graph(node)];
          // r186 wraps constants in VarNode intents; graph-node count is an
          // allocation bound, not a GPU instruction count or timing estimate.
          expect(nodes.length).toBeLessThanOrEqual(64 * lobes.length);
          expect(
            nodes.every((n) =>
              [
                "ConstNode",
                "VarNode",
                "SplitNode",
                "OperatorNode",
                "MathNode",
              ].includes(n.type),
            ),
          ).toBe(true);
        }
  });

  it("unions dirt alone and preserves road priority, absent behavior and physical grass eligibility", () => {
    for (const slope of [0, 0.12, 0.4])
      for (const road of [0, 0.3, 1]) {
        const input = {
          noiseValue: 0.57,
          distortNoise: 0.31,
          slope,
          roadInfluence: road,
          pondSurface: { soil: 0.2, wetness: 0.4 },
          macroSurface: { dry: 0.3, westRock: 0.7 },
        };
        const baseline = ops.weights(input);
        expect(ops.weights({ ...input, plantingSoil: 0 })).toEqual(baseline);
        for (const soil of [0, 0.3, 0.9]) {
          const actual = ops.weights({ ...input, plantingSoil: soil });
          expect(actual.dirt).toBeCloseTo(
            1 - (1 - baseline.dirt) * (1 - soil),
            14,
          );
          expect({ ...actual, dirt: baseline.dirt }).toEqual(baseline);
          const tsl = createCompactTerrainLayerWeights(
            float(input.noiseValue),
            float(slope),
            float(road),
            float(input.distortNoise),
            { soil: float(0.2), wetness: float(0.4) },
            { dry: float(0.3), westRock: float(0.7) },
            float(soil),
          );
          for (const key of ["dirt", "cliff", "road", "variation"] as const)
            expect(vectorValue(tsl[key])[0]).toBeCloseTo(actual[key], 13);
        }
        const sample = {
          noiseValue: input.noiseValue,
          distortNoise: input.distortNoise,
          slope,
          roadInfluence: road,
          surface: { x: 329.2, z: 336.1, height: 28, pond: null },
        };
        const planted = {
          ...sample,
          surface: { ...sample.surface, plantingLobes: lobes },
        };
        expect(ops.grassSupport(planted)).toBe(ops.grassSupport(sample));
        expect(
          ops.sample({
            ...sample,
            surface: { ...sample.surface, plantingLobes: [] },
          }),
        ).toEqual(ops.sample(sample));
        if (road === 1) expect(ops.sample(planted)).toEqual(ops.sample(sample));
        if (road === 0 && slope === 0)
          expect(ops.sample(planted)).not.toEqual(ops.sample(sample));
        const far = {
          ...planted,
          surface: { ...planted.surface, x: 350, z: 327 },
        };
        expect(ops.sample(far)).toEqual(
          ops.sample({
            ...far,
            surface: { ...far.surface, plantingLobes: [] },
          }),
        );
      }
  });

  it("keeps validation and soil sampling self-contained in the minified real worker factory", async () => {
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
      noiseValue: 0.6,
      distortNoise: 0.4,
      slope: 0.01,
      roadInfluence: 0,
      surface: {
        x: 329.2,
        z: 336.1,
        height: 28,
        pond: null,
        plantingLobes: lobes,
      },
    };
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads'); const ops=(${loaded.createCompactTerrainColorOperations.toString()})(); const input=${JSON.stringify(input)}; const admitted=ops.validatePlantingLobes(input.surface.plantingLobes); parentPort.postMessage({soil:ops.plantingSoil(input.surface.x,input.surface.z,input.distortNoise,admitted),color:ops.sample(input),support:ops.grassSupport(input),frozen:Object.isFrozen(admitted)&&admitted.every(Object.isFrozen)});`,
      { eval: true },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual({
        soil: ops.plantingSoil(
          input.surface.x,
          input.surface.z,
          input.distortNoise,
          lobes,
        ),
        color: ops.sample(input),
        support: ops.grassSupport(input),
        frozen: true,
      });
    } finally {
      await worker.terminate();
    }
  });
});
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
function graph(root: unknown): Set<Node> {
  if (!(root instanceof THREE.Node))
    throw new Error("Terrain graph root must be an actual Three node");
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
function vectorValue(
  node: Node,
  inputs?: ReadonlyMap<Node, readonly number[]>,
  cache = new Map<Node, number[]>(),
): number[] {
  const supplied = inputs?.get(node);
  if (supplied) return [...supplied];
  const cached = cache.get(node);
  if (cached) return cached;
  const calculate = (): number[] => {
    const read = (key: string) => Reflect.get(node, key) as unknown;
    const child = (key: string): number[] => {
      const value = read(key);
      if (!(value instanceof THREE.Node))
        throw new Error(`Missing node ${key}`);
      return vectorValue(value, inputs, cache);
    };
    const value = read("value");
    if (typeof value === "number") return [value];
    if (typeof value === "boolean") return [value ? 1 : 0];
    if (
      value instanceof THREE.Vector2 ||
      value instanceof THREE.Vector3 ||
      value instanceof THREE.Vector4
    )
      return value.toArray();
    if (value instanceof THREE.Matrix4) return value.toArray();
    if (node.type === "ConvertNode") {
      const values = child("node");
      if (read("convertTo") === "uint") return values.map((v) => v >>> 0);
      if (read("convertTo") === "int") return values.map((v) => v | 0);
      return values;
    }
    if (node.type === "VarNode") return child("node");
    if (node.type === "ContextNode") {
      // Arithmetic is unchanged by this narrowly scoped codegen setting. The
      // native gate below, not this evaluator, verifies its control flow.
      if (
        !value ||
        typeof value !== "object" ||
        Reflect.ownKeys(value).length !== 1 ||
        Reflect.ownKeys(value)[0] !== "uniformFlow" ||
        typeof Object.getOwnPropertyDescriptor(value, "uniformFlow")?.value !==
          "boolean"
      )
        throw new Error("Unsupported numeric TSL context");
      return child("node");
    }
    if (node.type === "ConditionalNode") {
      const condition = child("condNode");
      if (condition.length !== 1 || ![0, 1].includes(condition[0]))
        throw new Error("Expected concrete scalar TSL condition");
      return child(condition[0] === 1 ? "ifNode" : "elseNode");
    }
    if (node.type === "JoinNode")
      return (read("nodes") as Node[]).flatMap((value) =>
        vectorValue(value, inputs, cache),
      );
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
    // Only concrete uint arithmetic used by the actual PCG TSL graph. Unlike
    // JS double multiplication, Math.imul preserves its modulo-2^32 low bits.
    const isUint = (value: unknown): boolean => {
      if (!(value instanceof THREE.Node)) return false;
      if (value.type === "ConvertNode")
        return Reflect.get(value, "convertTo") === "uint";
      if (value.type === "VarNode") return isUint(Reflect.get(value, "node"));
      if (value.type === "OperatorNode")
        return (
          isUint(Reflect.get(value, "aNode")) &&
          isUint(Reflect.get(value, "bNode"))
        );
      return Reflect.get(value, "nodeType") === "uint";
    };
    const uintArithmetic = isUint(node);
    switch (read("op")) {
      case "!=":
        return pair((a, b) => (a !== b ? 1 : 0));
      case "&&":
        return pair((a, b) => (a !== 0 && b !== 0 ? 1 : 0));
      case "||":
        return pair((a, b) => (a !== 0 || b !== 0 ? 1 : 0));
      case ">":
        return pair((a, b) => (a > b ? 1 : 0));
      case "/":
        return pair((a, b) => a / b);
      case "+":
        return pair((a, b) => (uintArithmetic ? (a + b) >>> 0 : a + b));
      case "-":
        return pair((a, b) => a - b);
      case "*": {
        if (uintArithmetic) return pair((a, b) => Math.imul(a, b) >>> 0);
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
      case "^":
        if (!uintArithmetic) throw new Error("Expected uint XOR");
        return pair((a, b) => (a ^ b) >>> 0);
      case ">>":
        if (!uintArithmetic) throw new Error("Expected uint shift");
        return pair((a, b) => a >>> b);
    }
    switch (read("method")) {
      case "abs":
        return child("aNode").map(Math.abs);
      case "negate":
        return child("aNode").map((value) => -value);
      case "pow":
        return pair(Math.pow);
      case "exp2":
        return child("aNode").map((value) => 2 ** value);
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
      case "sqrt":
        return child("aNode").map(Math.sqrt);
      case "atan":
        return read("bNode") ? pair(Math.atan2) : child("aNode").map(Math.atan);
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
      case "step":
        return pair((edge, value) => (value < edge ? 0 : 1));
      case "dot":
        return [pair((a, b) => a * b).reduce((a, b) => a + b, 0)];
      case "cross":
        return new THREE.Vector3(
          ...(child("aNode") as [number, number, number]),
        )
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
  };
  const result = calculate();
  cache.set(node, result);
  return result;
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

describe("composition-v1 shared actual bank material graph", () => {
  const ops = createCompactTerrainColorOperations();
  const pond = {
    id: "haven_pond_water",
    centerX: 343,
    centerZ: 302,
    radius: 7.5,
    surfaceY: 27.8,
  };
  const zone: FlatZone = {
    id: "haven_pond_floor",
    centerX: 343,
    centerZ: 302,
    width: 22,
    depth: 22,
    height: 26.6,
    blendRadius: 2,
    radialPond: {
      bedRadius: 5,
      bankInnerRadius: 6.5,
      bankOuterRadius: 9,
      bankHeight: 28.08,
      shorelineAmplitude: 0.9,
      bankSectors: [
        {
          bearing: -2.2,
          halfWidth: 0.7,
          innerRadius: 6.4,
          innerHeight: 28.08,
          outerRadius: 8.9,
          outerHeight: 28.3,
        },
        {
          bearing: -1.7,
          halfWidth: 0.6,
          innerRadius: 6.8,
          innerHeight: 27.9,
          outerRadius: 9.1,
          outerHeight: 28.2,
        },
        { bearing: 0.7, halfWidth: 0.55, innerRadius: 6.4, innerHeight: 27.86 },
        {
          bearing: 3.05,
          halfWidth: 0.6,
          innerRadius: 6.3,
          innerHeight: 28.08,
          outerRadius: 8.8,
          outerHeight: 28.4,
        },
      ],
      bankComposition: {
        schemaVersion: 1,
        sectors: [
          { sectorIndex: 0, surface: "sedge-shelf" },
          { sectorIndex: 1, surface: "cutbank" },
          { sectorIndex: 3, surface: "dry-turf" },
        ],
      },
    },
  };
  const field = ops.pondBankField(zone, pond)!;
  const numeric: CompactPondBankMath<number> = {
    constant: (v) => v,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => a / b,
    min: Math.min,
    max: Math.max,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    atan2: Math.atan2,
    smoothstep: (a, b, v) => {
      const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
  };
  const input = (
    angle = -2.2,
    radius = 8,
    height = 28.04,
    slope = 0.04,
    roadInfluence = 0,
  ) => ({
    x: 343 + radius * Math.cos(angle),
    z: 302 + radius * Math.sin(angle),
    height,
    slope,
    roadInfluence,
    distortNoise: 0.5,
    field,
  });
  const nodeInput = (p: ReturnType<typeof input>) => ({
    x: float(p.x),
    z: float(p.z),
    height: float(p.height),
    slope: float(p.slope),
    roadInfluence: float(p.roadInfluence),
    distortNoise: float(p.distortNoise),
    field: p.field,
  });
  const blend = (
    layers: Record<"grass" | "dirt" | "rock", CompactTerrainLayer>,
    composition?: ReturnType<typeof createCompactPondBankComposition>,
  ) =>
    blendCompactTerrainLayers(
      layers,
      float(0.4),
      float(0.2),
      float(0.1),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      composition,
    );
  it("matches the actual CPU kernel through warped knots, overlaps, angle seam and neutral water/road bounds", () => {
    for (const angle of [
      -Math.PI + 1e-8,
      -2.8,
      -2.2,
      -1.9,
      -1.7,
      0.7,
      Math.PI - 1e-8,
    ])
      for (const radius of [0, 5.5, 7, 8.8, 10, 10.5]) {
        const p = input(angle, radius),
          expected = ops.bankComposition(
            { ...p, includeAppearance: true },
            numeric,
          ),
          actual = createCompactPondBankComposition(nodeInput(p));
        for (const key of [
          "soilToGrass",
          "soilToRock",
          "grassToSoil",
          "grassToRock",
          "grassShade",
          "substrateSoilToRock",
          "mineralAppearance",
          "siltAppearance",
        ] as const)
          expect(vectorValue(actual[key]!)[0]).toBeCloseTo(expected[key]!, 12);
      }
    for (const p of [
      input(-2.2, 8, 27.8),
      input(-2.2, 8, 28.04, 0.04, 0.8),
      input(0.7),
    ]) {
      const actual = createCompactPondBankComposition(nodeInput(p));
      expect(vectorValue(actual.soilToRock)).toEqual([0]);
      expect(
        vectorValue(
          vec4(
            actual.soilToGrass,
            actual.grassToSoil,
            actual.grassToRock,
            actual.grassShade,
          ),
        ),
      ).toEqual([0, 0, 0, 1]);
    }
  });
  it("grades existing mineral and silt detail coherently without recoloring neutral soil, grass, relief or raw cavities", () => {
    const source = ops.getPalette();
    const soil: CompactTerrainLayer = {
      albedo: vec3(...source.dirt),
      roughness: float(0.9),
      ao: float(0.85),
      worldNormal: vec3(0.1, 0.994, 0),
      height: float(0.4),
    };
    const rock: CompactTerrainLayer = {
      albedo: vec3(...source.rock),
      roughness: float(0.72),
      ao: float(0.65),
      worldNormal: vec3(0, 0.994, 0.1),
      rawRockAo: float(0.55),
    };
    const unselected = applyCompactPondBankMaterials(soil, rock, undefined);
    expect(unselected.soil).toBe(soil);
    expect(unselected.rock).toBe(rock);
    const recipe = ops.getPondBankRecipe();
    const value = (rgb: readonly number[]) =>
      rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const mix = (a: number, b: number, weight: number) => a + (b - a) * weight;
    for (const angle of [-2.2, -1.7, 0.7, 3.05])
      for (const height of [25.8, 27.5, 27.8, 28.1, 29.8])
        for (const road of [0, 0.4, 0.8, 1]) {
          const p = input(angle, 8, height, 0.04, road);
          const cpu = ops.bankComposition(
            { ...p, includeAppearance: true },
            numeric,
          );
          const composition = createCompactPondBankComposition(nodeInput(p));
          const material = applyCompactPondBankMaterials(
            soil,
            rock,
            composition,
          );
          const graded = ops.bankAppearanceAlbedo(
            [source.dirt[0], source.dirt[1], source.dirt[2]],
            [source.rock[0], source.rock[1], source.rock[2]],
            cpu,
            numeric,
          );
          const mineral = cpu.mineralAppearance!,
            silt = cpu.siltAppearance!;
          for (const [family, original] of [
            ["soil", source.dirt],
            ["rock", source.rock],
          ] as const) {
            const expected = original.map((channel, index) => {
              const mineralTarget = Math.min(
                1,
                Math.max(
                  0,
                  (source.rock[index] * recipe.mineralChroma +
                    value(source.rock) *
                      (1 - recipe.mineralChroma) *
                      recipe.mineralTint[index]) *
                    recipe.mineralValue,
                ),
              );
              const siltTarget = Math.min(
                1,
                Math.max(
                  0,
                  (source.dirt[index] * recipe.siltChroma +
                    value(source.dirt) *
                      (1 - recipe.siltChroma) *
                      recipe.siltTint[index]) *
                    recipe.siltValue,
                ),
              );
              return mix(
                mix(channel, mineralTarget, mineral),
                siltTarget,
                silt,
              );
            });
            vectorValue(material[family].albedo).forEach((channel, i) => {
              expect(channel).toBeCloseTo(expected[i], 13);
              expect(channel).toBeCloseTo(graded[family][i], 13);
              expect(channel).toBeGreaterThanOrEqual(0);
              expect(channel).toBeLessThanOrEqual(1);
            });
          }
          expect(vectorValue(material.soil.roughness)[0]).toBeCloseTo(
            mix(mix(0.9, 0.72, mineral), 0.9, silt),
            13,
          );
          expect(vectorValue(material.rock.roughness)[0]).toBeCloseTo(
            mix(0.72, 0.9, silt),
            13,
          );
          expect(vectorValue(material.soil.ao)[0]).toBeCloseTo(
            mix(mix(0.85, 0.65, mineral), 0.85, silt),
            13,
          );
          expect(vectorValue(material.rock.ao)[0]).toBeCloseTo(
            mix(0.65, 0.85, silt),
            13,
          );
          expect(material.soil.height).toBe(soil.height);
          expect(material.rock.rawRockAo).toBe(rock.rawRockAo);
          const soilNormal = new THREE.Vector3(0.1, 0.994, 0);
          const rockNormal = new THREE.Vector3(0, 0.994, 0.1);
          const expectedSoilNormal = soilNormal.clone();
          if (mineral > 0)
            expectedSoilNormal.lerp(rockNormal, mineral).normalize();
          if (silt > 0) expectedSoilNormal.lerp(soilNormal, silt).normalize();
          const expectedRockNormal = rockNormal.clone();
          if (silt > 0) expectedRockNormal.lerp(soilNormal, silt).normalize();
          for (const [family, normal] of [
            ["soil", expectedSoilNormal],
            ["rock", expectedRockNormal],
          ] as const)
            vectorValue(material[family].worldNormal).forEach(
              (channel, index) =>
                expect(channel).toBeCloseTo(normal.toArray()[index], 13),
            );
          if (mineral === 0 && silt === 0)
            for (const [family, original] of [
              ["soil", soil],
              ["rock", rock],
            ] as const)
              for (const key of [
                "albedo",
                "roughness",
                "ao",
                "worldNormal",
              ] as const)
                expect(vectorValue(material[family][key])).toEqual(
                  vectorValue(original[key]),
                );
          const before = blend({ grass: soil, dirt: soil, rock }, composition);
          const after = blend(
            { grass: soil, dirt: material.soil, rock: material.rock },
            composition,
          );
          expect(vectorValue(after.weights!)).toEqual(
            vectorValue(before.weights!),
          );
        }
  });
  it("matches final selected-field mean color through appearance, nested coast soil, material blending, wetness and variation", () => {
    const profile = validateWorldTerrainProfile({
      ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const palette = ops.getPalette();
    const layer = (rgb: readonly number[]): CompactTerrainLayer => ({
      albedo: vec3(rgb[0], rgb[1], rgb[2]),
      roughness: float(0.9),
      ao: float(0.9),
      worldNormal: vec3(0, 1, 0),
      // Equal source heights neutralize height competition. This qualifies
      // the CPU mean-color contract, not texel relief or native GPU output.
      height: float(0.5),
    });
    const sources = {
      grass: layer(palette.grass),
      dirt: layer(palette.dirt),
      rock: layer(palette.rock),
    };
    const points = [
      [-1.7, 8, 0, 0.04, 0], // Cutbank mineral.
      [-2.2, 8, 0, 0.04, 0], // Sheltered silt.
      [3.05, 8, 0.08, 0.04, 0], // Turf toe.
      [-1.95, 8, 0.04, 0.1, 0], // Soft overlapping families.
      [-1.7, 8, 0.4, 0.2, 0], // Emerged mineral/coastal coexistence.
      [-1.7, 8, 0, 0.04, 1], // Full road priority.
      [-1.7, 8, 0.15, 0.04, 0.4], // Partial road feather.
      [0.7, 8, 0, 0.04, 0], // Unmapped sector.
      [-1.7, 25, 0.4, 0.04, 0], // Outside the bank field.
    ] as const;
    let coastAndAppearance = 0;
    let wetAndAppearance = 0;
    // The second admitted pond is lower but has identical relative bank
    // geometry; it exercises simultaneous coastal and inland material owners.
    for (const lowerBy of [0, pond.surfaceY - profile.water.threshold - 2]) {
      const selectedWater = { ...pond, surfaceY: pond.surfaceY - lowerBy };
      const selectedZone = structuredClone(zone);
      selectedZone.height -= lowerBy;
      selectedZone.radialPond!.bankHeight -= lowerBy;
      for (const sector of selectedZone.radialPond!.bankSectors!) {
        sector.innerHeight -= lowerBy;
        if (sector.outerHeight !== undefined) sector.outerHeight -= lowerBy;
      }
      const bank = ops.pondBankField(selectedZone, selectedWater)!;
      const macroField = ops.macroField(
        profile,
        "distribution-v1",
        "composition-v1",
        bank,
      )!;
      for (const [
        index,
        [angle, radius, relative, slope, road],
      ] of points.entries()) {
        const x = selectedWater.centerX + radius * Math.cos(angle);
        const z = selectedWater.centerZ + radius * Math.sin(angle);
        const height = selectedWater.surfaceY + relative;
        const noise = [0.2, 0.5, 0.8][index % 3];
        const sample = {
          noiseValue: noise,
          meadowNoise: 0.6,
          distortNoise: 0.4,
          slope,
          roadInfluence: road,
          surface: { x, z, height, pond: selectedWater, macroField },
        };
        const world = vec3(x, height, z);
        const macro = createCompactTerrainMacroWeights(
          vec2(x, z),
          float(noise),
          macroField,
        );
        const composition = createCompactPondBankComposition({
          x: float(x),
          z: float(z),
          height: float(height),
          slope: float(slope),
          roadInfluence: float(road),
          distortNoise: float(0.4),
          field: bank,
        });
        const pondSurface = createCompactPondSurfaceWeights(
          world,
          float(0.4),
          vec4(
            selectedWater.centerX,
            selectedWater.centerZ,
            selectedWater.radius,
            selectedWater.surfaceY,
          ),
        );
        const coast = createCompactCoastWeights(
          world,
          float(noise),
          float(0.4),
          macro.westRock,
          float(slope),
          macroField,
        );
        const coastalGround = {
          coverage: createCompactCoastalGroundCover(
            float(height),
            float(noise),
            float(0.4),
            macroField,
          ).mul(float(1).sub(pondSurface.soil)),
          layer: applyCompactCoastRock(sources.dirt, sources.dirt, coast),
        };
        const appearance = applyCompactPondBankMaterials(
          sources.dirt,
          sources.rock,
          composition,
        );
        const rock = applyCompactCoastRock(appearance.rock, appearance.soil, {
          ...coast,
          soil: applyCompactPondRockSoil(coast.soil, composition),
        });
        const grass = applyCompactPondBankGrass(
          applyCompactMeadowTint(
            sources.grass,
            float(0.6),
            macro.dry,
            ops.getComposition().coastalMeadowTintStrength,
          ),
          composition,
        );
        const weights = createCompactTerrainLayerWeights(
          float(noise),
          float(slope),
          float(road),
          float(0.4),
          pondSurface,
          macro,
        );
        const worn = createCompactWornTurfWeights({
          worldPosition: world,
          meadowNoise: float(0.6),
          distortNoise: float(0.4),
          geometricSlope: float(slope),
          rawRoadInfluence: float(road),
          road: weights.road,
          pondSoil: pondSurface.soil,
          coastalCoverage: coastalGround.coverage,
          field: macroField,
        });
        const distribution = createCompactCoastDistribution({
          x: float(x),
          z: float(z),
          height: float(height),
          slope: float(slope),
          noiseValue: float(noise),
          meadowNoise: float(0.6),
          road: worn.road,
          pond: {
            centerX: float(selectedWater.centerX),
            centerZ: float(selectedWater.centerZ),
            radius: float(selectedWater.radius),
          },
          field: macroField,
        });
        const surface = blendCompactTerrainLayers(
          { grass, dirt: appearance.soil, rock },
          weights.dirt,
          weights.cliff,
          worn.road,
          createCompactHavenGroundWeights(
            vec2(x, z),
            macroField.havenGround,
            pondSurface.soil,
            float(slope),
          ),
          undefined,
          coastalGround,
          worn.soil,
          undefined,
          undefined,
          undefined,
          undefined,
          distribution,
          undefined,
          composition,
        );
        const wet = applyCompactPondWetness(surface, pondSurface.wetness);
        const actual = vectorValue(wet.albedo.mul(weights.variation));
        const expected = ops.sample(sample);
        [expected.r, expected.g, expected.b].forEach((channel, i) =>
          expect(actual[i]).toBeCloseTo(channel, 12),
        );
        const local =
          vectorValue(composition.mineralAppearance!)[0] +
          vectorValue(composition.siltAppearance!)[0];
        if (local > 0 && vectorValue(coastalGround.coverage)[0] > 0)
          coastAndAppearance++;
        if (local > 0 && vectorValue(pondSurface.wetness)[0] > 0)
          wetAndAppearance++;
        if (road === 1)
          palette.dirt.forEach((value, channel) =>
            expect(actual[channel]).toBeCloseTo(
              value *
                (1 +
                  (ops.getComposition().pondWetAlbedo - 1) *
                    vectorValue(pondSurface.wetness)[0]) *
                vectorValue(weights.variation)[0],
              13,
            ),
          );
      }
    }
    expect(coastAndAppearance).toBeGreaterThan(0);
    expect(wetAndAppearance).toBeGreaterThan(0);
  });

  it("shares localized nested-soil retention between CPU and actual TSL without changing coastal wetness", () => {
    const source = float(0.6);
    expect(applyCompactPondRockSoil(source, undefined)).toBe(source);
    expect(ops.bankRockSoil(0.6, undefined, numeric)).toBe(0.6);
    const neutral = createCompactPondBankComposition({
      ...nodeInput(input()),
      field: null,
    });
    expect(applyCompactPondRockSoil(source, neutral)).toBe(source);
    for (const angle of [-1.7, -2.2, 0.7])
      for (const height of [26.4, 27.6, 27.8, 28.5, 29.6])
        for (const road of [0, 0.4, 0.8, 1]) {
          const p = input(angle, 8, height, 0.04, road);
          const cpu = ops.bankComposition(p, numeric);
          const nodes = createCompactPondBankComposition(nodeInput(p));
          for (const soil of [0, 0.3, 1]) {
            const expected =
              soil *
              (1 - Math.max(0, Math.min(1, cpu.substrateSoilToRock ?? 0)));
            const actual = applyCompactPondRockSoil(float(soil), nodes);
            expect(ops.bankRockSoil(soil, cpu, numeric)).toBe(expected);
            expect(vectorValue(actual)[0]).toBeCloseTo(expected, 13);
            expect(expected).toBeGreaterThanOrEqual(0);
            expect(expected).toBeLessThanOrEqual(soil);
            if (
              road >= 0.8 ||
              angle === 0.7 ||
              height === 26.4 ||
              height === 29.6
            )
              expect(expected).toBe(soil);
          }
        }
  });
  it("uses retained nested soil coherently for all four rock PBR channels before unchanged wetness", () => {
    const rock: CompactTerrainLayer = {
      albedo: vec3(0.3, 0.2, 0.12),
      roughness: float(0.9),
      ao: float(0.7),
      worldNormal: vec3(0, 1, 0),
    };
    const soil: CompactTerrainLayer = {
      albedo: vec3(0.2, 0.12, 0.05),
      roughness: float(0.7),
      ao: float(0.9),
      worldNormal: vec3(0.6, 0.8, 0),
    };
    const p = input(-1.7, 8, 27.8, 0.04);
    const field = createCompactPondBankComposition(nodeInput(p));
    const mask = ops.bankComposition(p, numeric).substrateSoilToRock!;
    expect(mask).toBeGreaterThan(0);
    const retained = applyCompactPondRockSoil(float(0.6), field);
    const fraction = 0.6 * (1 - mask);
    for (const wet of [0, 0.5, 1]) {
      const wetness = float(wet);
      const layer = applyCompactCoastRock(rock, soil, {
        soil: retained,
        wetness,
      });
      const attenuation = 1 + (ops.getComposition().coastWetAlbedo - 1) * wet;
      const albedo = [
        0.3 + (0.2 - 0.3) * fraction,
        0.2 + (0.12 - 0.2) * fraction,
        0.12 + (0.05 - 0.12) * fraction,
      ].map((v) => v * attenuation);
      vectorValue(layer.albedo).forEach((value, i) =>
        expect(value).toBeCloseTo(albedo[i], 13),
      );
      const dryRoughness = 0.9 + (0.7 - 0.9) * fraction;
      expect(vectorValue(layer.roughness)[0]).toBeCloseTo(
        dryRoughness +
          (Math.min(dryRoughness, ops.getComposition().coastWetRoughness) -
            dryRoughness) *
            wet,
        13,
      );
      expect(vectorValue(layer.ao)[0]).toBeCloseTo(0.7 + 0.2 * fraction, 13);
      const normal = new THREE.Vector3(0.6 * fraction, 1 - 0.2 * fraction, 0)
        .normalize()
        .toArray();
      vectorValue(layer.worldNormal).forEach((value, i) =>
        expect(value).toBeCloseTo(normal[i], 13),
      );
      for (const node of [
        layer.albedo,
        layer.roughness,
        layer.ao,
        layer.worldNormal,
      ]) {
        expect(graph(node).has(retained)).toBe(true);
        expect(
          [...graph(node)].some(
            (n) => Reflect.get(n, "isTextureNode") === true,
          ),
        ).toBe(false);
      }
      expect(graph(retained).has(wetness)).toBe(false);
    }
  });
  it("conserves original material budgets without negative layers or coast transfer including tiny budgets", () => {
    for (const angle of [-2.2, -1.7, 3.05])
      for (const slope of [0, 0.12, 0.3])
        for (const weights of [
          [0.3, 0.4, 0.2, 0.1],
          [1e-20, 2e-20, 3e-20, 4e-20],
          [0, 0, 0.5, 0.5],
        ] as const) {
          const p = input(angle, 8, 28.04, slope),
            composition = createCompactPondBankComposition(nodeInput(p));
          const actual = vectorValue(
            applyCompactPondBankCompositionWeights(
              vec4(...weights),
              composition,
            ),
          );
          const expected = ops.bankCompositionWeights(
            weights,
            ops.bankComposition(p, numeric),
            numeric,
          );
          actual.forEach((v, i) => {
            expect(v).toBeCloseTo(expected[i], 15);
            expect(v).toBeGreaterThanOrEqual(0);
          });
          expect(actual.reduce((a, b) => a + b, 0)).toBeCloseTo(
            weights.reduce<number>((a, b) => a + b, 0),
            15,
          );
          expect(actual[3]).toBe(weights[3]);
        }
  });
  it("uses one final vector for albedo, roughness, AO and normals, shading only the existing grass albedo", () => {
    const composition = createCompactPondBankComposition(nodeInput(input()));
    const layers: Record<"grass" | "dirt" | "rock", CompactTerrainLayer> = {
      grass: {
        albedo: vec3(0.3, 0.5, 0.1),
        roughness: float(0.9),
        ao: float(0.8),
        worldNormal: vec3(0, 1, 0),
        height: float(0.5),
      },
      dirt: {
        albedo: vec3(0.2, 0.12, 0.05),
        roughness: float(0.7),
        ao: float(0.9),
        worldNormal: vec3(0.1, 1, 0),
        height: float(0.5),
      },
      rock: {
        albedo: vec3(0.3, 0.2, 0.12),
        roughness: float(0.8),
        ao: float(0.7),
        worldNormal: vec3(0, 1, 0.1),
      },
    };
    const original = blend(layers);
    const grass = applyCompactPondBankGrass(layers.grass, composition);
    expect(grass.roughness).toBe(layers.grass.roughness);
    expect(grass.ao).toBe(layers.grass.ao);
    expect(grass.worldNormal).toBe(layers.grass.worldNormal);
    const changed = blend({ ...layers, grass }, composition),
      weights = vectorValue(changed.weights!);
    expect(weights).toEqual(
      vectorValue(
        applyCompactPondBankCompositionWeights(original.weights!, composition),
      ),
    );
    for (const root of [
      changed.albedo,
      changed.roughness,
      changed.ao,
      changed.normal,
    ])
      expect(graph(root).has(changed.weights!)).toBe(true);
    expect(vectorValue(changed.roughness)[0]).toBeCloseTo(
      0.9 * weights[0] + 0.7 * weights[1] + 0.8 * weights[2],
      14,
    );
    expect(vectorValue(changed.ao)[0]).toBeCloseTo(
      0.8 * weights[0] + 0.9 * weights[1] + 0.7 * weights[2],
      14,
    );
    expect(() =>
      blend(
        { ...layers, grass: { ...layers.grass, height: undefined } },
        composition,
      ),
    ).toThrow(/height layers/);
    const wetBefore = vectorValue(
      createCompactPondSurfaceWeights(
        vec3(350, 28.04, 302),
        float(0.5),
        vec4(343, 302, 7.5, 27.8),
      ).wetness,
    );
    expect(wetBefore).toEqual([0]);
  });
  it("matches the wet cutbank CPU transfer in the actual graph without changing vegetation, roads or remote material", () => {
    for (const radius of [0, 5, 5.6, 6.8, 8, 9.8, 10.5])
      for (const slope of [0.1, 0.15, 0.21, 0.32, 0.6]) {
        const p = input(-1.7, radius, 27.8, slope);
        const expected = ops.bankComposition(p, numeric);
        const actual = createCompactPondBankComposition(nodeInput(p));
        expect(vectorValue(actual.soilToRock)[0]).toBeCloseTo(
          expected.soilToRock,
          12,
        );
        expect(vectorValue(actual.soilToGrass)).toEqual([0]);
        expect(vectorValue(actual.grassToSoil)).toEqual([0]);
        expect(vectorValue(actual.grassToRock)).toEqual([0]);
        expect(vectorValue(actual.grassShade)).toEqual([1]);
        for (const weights of [
          [0, 1, 0, 0],
          [0.3, 0.4, 0.2, 0.1],
          [1e-20, 2e-20, 3e-20, 4e-20],
          [1, 0, 0, 0],
        ] as const) {
          const values = vectorValue(
            applyCompactPondBankCompositionWeights(vec4(...weights), actual),
          );
          const faceTransfer = weights[1] * expected.soilToRock;
          const transfer =
            faceTransfer +
            (weights[1] - faceTransfer) * (expected.substrateSoilToRock ?? 0);
          expect(values[0]).toBe(weights[0]);
          expect(values[3]).toBe(weights[3]);
          expect(values[1]).toBeCloseTo(weights[1] - transfer, 15);
          expect(values[2]).toBeCloseTo(weights[2] + transfer, 15);
          expect(values.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
          expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(
            weights.reduce<number>((a, b) => a + b, 0),
            15,
          );
        }
        const road = createCompactPondBankComposition(
          nodeInput({ ...p, roadInfluence: 0.8 }),
        );
        const remote = createCompactPondBankComposition({
          ...nodeInput(p),
          field: null,
        });
        expect(vectorValue(road.soilToRock)).toEqual([0]);
        expect(vectorValue(remote.soilToRock)).toEqual([0]);
      }
  });
  it("matches mineral CPU/TSL weights after overlapping emergence without changing grass or coastal shares", () => {
    const authored = structuredClone(zone);
    const sector = authored.radialPond!.bankSectors![0];
    authored.radialPond!.bankSectors = [{ ...sector }, { ...sector }];
    authored.radialPond!.bankComposition = {
      schemaVersion: 1,
      sectors: [
        {
          sectorIndex: 0,
          surface: "sedge-shelf",
          groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
        },
        { sectorIndex: 1, surface: "mineral-shore" },
      ],
    };
    const mineralField = ops.pondBankField(authored, pond)!;
    for (const height of [27.7, 27.8, 27.95, 28, 28.1, 28.4])
      for (const distortNoise of [0, 0.5, 1]) {
        const p = {
          ...input(-2.2, 8, height),
          distortNoise,
          field: mineralField,
        };
        const cpu = ops.bankComposition(p, numeric);
        const actual = createCompactPondBankComposition(nodeInput(p));
        expect(vectorValue(actual.mineralSoilToRock!)[0]).toBeCloseTo(
          cpu.mineralSoilToRock!,
          13,
        );
        for (const weights of [
          [0, 1, 0, 0],
          [0.3, 0.4, 0.2, 0.1],
          [1, 0, 0, 0],
        ] as const) {
          const result = vectorValue(
            applyCompactPondBankCompositionWeights(vec4(...weights), actual),
          );
          const expected = ops.bankCompositionWeights(weights, cpu, numeric);
          const old = ops.bankCompositionWeights(
            weights,
            { ...cpu, mineralSoilToRock: undefined },
            numeric,
          );
          result.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 14));
          expect(result[0]).toBe(old[0]);
          expect(result[3]).toBe(old[3]);
          expect(result.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
          expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(
            weights.reduce<number>((a, b) => a + b, 0),
            14,
          );
        }
        expect(
          vectorValue(
            createCompactPondBankComposition(
              nodeInput({ ...p, roadInfluence: 0.8 }),
            ).mineralSoilToRock!,
          ),
        ).toEqual([0]);
      }
    expect(
      createCompactPondBankComposition(nodeInput(input())),
    ).not.toHaveProperty("mineralSoilToRock");
  });
  it.each(["cutbank", "mineral-shore"] as const)(
    "uses %s wet-soil transfer in every PBR channel while retaining the exact wetness node",
    (surface) => {
      const authored = structuredClone(zone);
      if (surface === "mineral-shore") {
        authored.radialPond!.bankComposition = {
          schemaVersion: 1,
          sectors: [{ sectorIndex: 1, surface }],
        };
      }
      const composition = createCompactPondBankComposition(
        nodeInput({
          ...input(-1.7, 8, 27.8, 0.32),
          field: ops.pondBankField(authored, pond)!,
        }),
      );
      const transferNode =
        surface === "mineral-shore"
          ? composition.mineralSoilToRock!
          : composition.soilToRock;
      expect(vectorValue(transferNode)[0]).toBeGreaterThan(0);
      const layers: Record<"grass" | "dirt" | "rock", CompactTerrainLayer> = {
        grass: {
          albedo: vec3(0.3, 0.5, 0.1),
          roughness: float(0.9),
          ao: float(0.8),
          worldNormal: vec3(0, 1, 0),
          height: float(0.5),
        },
        dirt: {
          albedo: vec3(0.2, 0.12, 0.05),
          roughness: float(0.7),
          ao: float(0.9),
          worldNormal: vec3(0.1, 1, 0),
          height: float(0.5),
        },
        rock: {
          albedo: vec3(0.3, 0.2, 0.12),
          roughness: float(0.8),
          ao: float(0.7),
          worldNormal: vec3(0, 1, 0.1),
        },
      };
      const before = blend(layers, {
        ...composition,
        soilToRock: float(0),
        ...(surface === "mineral-shore" ? { mineralSoilToRock: float(0) } : {}),
      });
      const after = blend(layers, composition);
      const oldWeights = vectorValue(before.weights!),
        weights = vectorValue(after.weights!);
      expect(weights[0]).toBe(oldWeights[0]);
      expect(weights[3]).toBe(oldWeights[3]);
      expect(weights[1]).toBeLessThan(oldWeights[1]);
      expect(weights[2]).toBeGreaterThan(oldWeights[2]);
      for (const root of [
        after.albedo,
        after.roughness,
        after.ao,
        after.normal,
      ]) {
        expect(graph(root).has(after.weights!)).toBe(true);
        expect(graph(root).has(transferNode)).toBe(true);
      }
      expect(vectorValue(after.roughness)[0]).toBeCloseTo(
        0.9 * weights[0] + 0.7 * weights[1] + 0.8 * weights[2],
        14,
      );
      expect(vectorValue(after.ao)[0]).toBeCloseTo(
        0.8 * weights[0] + 0.9 * weights[1] + 0.7 * weights[2],
        14,
      );
      const wetness = createCompactPondSurfaceWeights(
        vec3(343 + 8 * Math.cos(-1.7), 27.8, 302 + 8 * Math.sin(-1.7)),
        float(0.5),
        vec4(343, 302, 7.5, 27.8),
      ).wetness;
      expect(vectorValue(wetness)[0]).toBeGreaterThan(0);
      for (const surface of [before, after]) {
        const wet = applyCompactPondWetness(surface, wetness);
        expect(graph(wet.albedo).has(wetness)).toBe(true);
        expect(graph(wet.roughness).has(wetness)).toBe(true);
        expect(wet.weights).toBe(surface.weights);
        expect(wet.ao).toBe(surface.ao);
        expect(wet.normal).toBe(surface.normal);
      }
    },
  );
  it("shares actual authored emergence graph and conserved targets at submerged, overlap, road and near-pure boundaries", () => {
    const authored = structuredClone(zone);
    const heights = [
      [0.04, 0.12],
      [0.15, 0.3],
      [0.06, 0.16],
    ] as const;
    authored.radialPond!.bankComposition!.sectors.forEach((row, index) =>
      Object.assign(row, {
        groundCover: {
          emergenceHeight: heights[index][0],
          fullHeight: heights[index][1],
        },
      }),
    );
    const field = ops.pondBankField(authored, pond)!;
    for (const angle of [-2.2, -1.9, -1.7, 0.7, 3.05])
      for (const relative of [-0.1, 0, 0.04, 0.08, 0.12, 0.2, 0.4])
        for (const road of [0, 0.8]) {
          const p = { ...input(angle, 8, 27.8 + relative, 0.04, road), field };
          const expected = ops.bankComposition(p, numeric);
          const actual = createCompactPondBankComposition(nodeInput(p));
          expect(vectorValue(actual.groundCoverWeight)[0]).toBeCloseTo(
            expected.groundCoverWeight,
            12,
          );
          expect(vectorValue(actual.groundCoverGrassShare)[0]).toBeCloseTo(
            expected.groundCoverGrassShare,
            12,
          );
          for (const weights of [
            [0.3, 0.4, 0.2, 0.1],
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [1e-20, 2e-20, 3e-20, 4e-20],
          ] as const) {
            const a = vectorValue(
              applyCompactPondBankCompositionWeights(vec4(...weights), actual),
            );
            const b = ops.bankCompositionWeights(weights, expected, numeric);
            a.forEach((value, index) =>
              expect(value).toBeCloseTo(b[index], 12),
            );
            expect(
              a.every((value) => Number.isFinite(value) && value >= 0),
            ).toBe(true);
            expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(
              weights.reduce<number>((x, y) => x + y, 0),
              12,
            );
          }
        }
    const composition = createCompactPondBankComposition(
      nodeInput({ ...input(-2.2, 8, 27.92), field }),
    );
    const layers: Record<"grass" | "dirt" | "rock", CompactTerrainLayer> = {
      grass: {
        albedo: vec3(0.2, 0.4, 0.1),
        roughness: float(0.8),
        ao: float(0.9),
        worldNormal: vec3(0, 1, 0),
        height: float(0.5),
      },
      dirt: {
        albedo: vec3(0.3, 0.2, 0.1),
        roughness: float(0.9),
        ao: float(0.7),
        worldNormal: vec3(0.1, 0.99, 0).normalize(),
        height: float(0.5),
      },
      rock: {
        albedo: vec3(0.4, 0.4, 0.4),
        roughness: float(0.7),
        ao: float(0.8),
        worldNormal: vec3(0, 0.99, 0.1).normalize(),
      },
    };
    const result = blend(layers, composition);
    if (!result.weights)
      throw new Error(
        "Admitted height layers must expose final shared weights",
      );
    for (const root of [
      result.albedo,
      result.roughness,
      result.ao,
      result.normal,
    ]) {
      expect(graph(root).has(result.weights)).toBe(true);
      expect(graph(root).has(composition.groundCoverWeight)).toBe(true);
      expect(graph(root).has(composition.groundCoverGrassShare)).toBe(true);
    }
  });
  it("retains exactly the seven existing map owners and 33 surface texture reads without geometry or derivative additions", () => {
    const owner = new CompactTerrainTextureSet(
      "/assets",
      "stochastic-v1",
      "height-v1",
      "stochastic-v1",
    );
    try {
      const layers = createCompactTerrainLayers(owner, float(64), float(0.5));
      const authored = structuredClone(zone);
      Object.assign(authored.radialPond!.bankComposition!.sectors[0], {
        groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
      });
      const composition = createCompactPondBankComposition(
        nodeInput({ ...input(), field: ops.pondBankField(authored, pond)! }),
      );
      const appearance = applyCompactPondBankMaterials(
        layers.dirt,
        layers.rock,
        composition,
      );
      const baseline = blend(layers),
        candidate = blend(
          {
            ...layers,
            grass: applyCompactPondBankGrass(layers.grass, composition),
            dirt: appearance.soil,
            rock: appearance.rock,
          },
          composition,
        );
      const samples = (value: ReturnType<typeof blend>) =>
        new Set(
          [value.albedo, value.roughness, value.ao, value.normal]
            .flatMap((root) => [...graph(root)])
            .filter(
              (node) =>
                Reflect.get(node, "value") instanceof THREE.Texture &&
                Reflect.get(node, "uvNode"),
            ),
        );
      const a = samples(baseline),
        b = samples(candidate);
      expect(owner.getReceipt().textures).toHaveLength(7);
      expect(a.size).toBe(33);
      expect(b).toEqual(a);
      const compositionNodes = new Set(
        Object.values(composition).flatMap((n) => [...graph(n)]),
      );
      expect(
        [...compositionNodes].some(
          (node) => Reflect.get(node, "value") instanceof THREE.Texture,
        ),
      ).toBe(false);
      expect(
        [...compositionNodes].some((node) =>
          ["dFdx", "dFdy"].includes(String(Reflect.get(node, "method"))),
        ),
      ).toBe(false);
    } finally {
      owner.dispose();
    }
  });
  it("binds the actual runtime PBR factory to exact bank water and rejects missing or incompatible composition owners", () => {
    const profile = validateWorldTerrainProfile({
      ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const options = {
      compactPbr: true,
      compactProfile: profile,
      compactPond: pond,
      compactDirtProjection: "stochastic-v1" as const,
      compactRockProjection: "stochastic-v1" as const,
      compactSurfaceBlend: "height-v1" as const,
      compactPondBlend: "composition-v1" as const,
      compactPondBankField: field,
    };
    const material = createTerrainMaterial(undefined, options),
      baseline = createTerrainMaterial(undefined, {
        ...options,
        compactPondBlend: "relief-contact-v1",
        compactPondBankField: undefined,
      });
    try {
      expect(material.compactPondBlend).toBe("composition-v1");
      expect(material.compactPondBankField).toEqual(field);
      expect(
        Object.getOwnPropertyDescriptor(material, "compactPondBankField")
          ?.writable,
      ).toBe(false);
      const shared = new Set<Node>();
      for (const root of [
        material.colorNode,
        material.normalNode,
        material.roughnessNode,
        material.aoNode,
      ]) {
        const matches = [...graph(root)].filter(
          (node) =>
            Reflect.get(node, "name") === "compactPondBankSurfaceWeights",
        );
        expect(matches).toHaveLength(1);
        shared.add(matches[0]);
        for (const name of [
          "compactPondBankMineralAppearance",
          "compactPondBankSiltAppearance",
        ])
          expect(
            [...graph(root)].filter(
              (node) => Reflect.get(node, "name") === name,
            ),
          ).toHaveLength(1);
      }
      expect(shared.size).toBe(1);
      for (const m of [material, baseline]) {
        expect(m.compactTerrainSurface!.getReceipt().textures).toHaveLength(7);
        expect(m.compactTerrainSurface!.getReceipt().surfaceSampleCount).toBe(
          33,
        );
        expect(m.positionNode).toBeNull();
        expect(m.displacementMap).toBeNull();
      }
      for (const root of [
        baseline.colorNode,
        baseline.normalNode,
        baseline.roughnessNode,
        baseline.aoNode,
      ])
        expect(
          [...graph(root)].some((node) =>
            String(Reflect.get(node, "name")).startsWith("compactPondBank"),
          ),
        ).toBe(false);
      expect(() =>
        createTerrainMaterial(undefined, {
          ...options,
          compactPondBankField: undefined,
        }),
      ).toThrow(/explicit/);
      expect(() =>
        createTerrainMaterial(undefined, {
          ...options,
          compactPond: { ...pond, surfaceY: 27.7 },
        }),
      ).toThrow(/matching bound water/);
      expect(() =>
        createTerrainMaterial(undefined, {
          ...options,
          compactSurfaceBlend: undefined,
        }),
      ).toThrow(/height-v1/);
      expect(() =>
        createTerrainMaterial(undefined, { ...options, compactPbr: false }),
      ).toThrow(/compact PBR/);
      expect(() =>
        createTerrainMaterial(undefined, {
          ...options,
          compactPondBlend: "relief-contact-v1",
        }),
      ).toThrow(/requires composition/);
    } finally {
      material.dispose();
      baseline.dispose();
    }
  });
});

describe("authored Haven ground composition, independent of terrain and grass population", () => {
  const ops = createCompactTerrainColorOperations();
  const profile = HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE;
  const field = ops.macroField(profile)!;
  const ground = field.havenGround!;

  it("detaches the admitted toe and the two connected service-yard ribbons without changing historical fields", () => {
    const before = JSON.stringify(profile);
    expect(ground.talus).toEqual(
      profile.havenShoulder!.toe.slice(1).map((point, i) => ({
        startX: profile.havenShoulder!.toe[i][0],
        startZ: profile.havenShoulder!.toe[i][1],
        endX: point[0],
        endZ: point[1],
        coreRadius: 0.6,
        outerRadius: 3.5,
        strength: 0.65,
      })),
    );
    expect(ground.wear).toEqual([
      {
        startX: 334,
        startZ: 332,
        endX: 337,
        endZ: 344,
        coreRadius: 2.7,
        outerRadius: 4.2,
        strength: 0.88,
      },
      {
        startX: 337,
        startZ: 344,
        endX: 343,
        endZ: 348,
        coreRadius: 1.7,
        outerRadius: 3.2,
        strength: 0.65,
      },
    ]);
    expect(ground.talus).toHaveLength(5);
    for (const value of [
      field,
      ground,
      ground.talus,
      ground.wear,
      ...ground.talus,
      ...ground.wear,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(ground.talus).not.toBe(profile.havenShoulder!.toe);
    expect(
      ops.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE)!.havenGround,
    ).toBeUndefined();
    expect(ops.havenGroundWeights(310, 328)).toEqual({ talus: 0, wear: 0 });
    expect(JSON.stringify(profile)).toBe(before);
  });

  it("matches real Three segment projections and actual TSL arithmetic with bounded MAX overlap and smooth outer joins", () => {
    const expectedRibbon = (
      x: number,
      z: number,
      ribbon: CompactTerrainGroundRibbon,
    ) => {
      const point = new THREE.Vector3(x, 0, z);
      const line = new THREE.Line3(
        new THREE.Vector3(ribbon.startX, 0, ribbon.startZ),
        new THREE.Vector3(ribbon.endX, 0, ribbon.endZ),
      );
      const squaredDistance = point.distanceToSquared(
        line.closestPointToPoint(point, true, new THREE.Vector3()),
      );
      const t = THREE.MathUtils.clamp(
        (squaredDistance - ribbon.coreRadius ** 2) /
          (ribbon.outerRadius ** 2 - ribbon.coreRadius ** 2),
        0,
        1,
      );
      return ribbon.strength * (1 - t * t * (3 - 2 * t));
    };
    let cases = 0;
    for (let x = 297; x <= 350; x += 3.7)
      for (let z = 299; z <= 370; z += 4.1) {
        const cpu = ops.havenGroundWeights(x, z, ground, 1);
        const tsl = createCompactHavenGroundWeights(
          vec2(x, z),
          ground,
          float(0),
          float(1),
        );
        for (const key of ["talus", "wear"] as const) {
          const expected = Math.max(
            ...ground[key].map((ribbon) => expectedRibbon(x, z, ribbon)),
          );
          expect(cpu[key]).toBeCloseTo(expected, 12);
          expect(vectorValue(tsl[key])[0]).toBeCloseTo(expected, 12);
          expect(cpu[key]).toBeGreaterThanOrEqual(0);
          expect(cpu[key]).toBeLessThanOrEqual(key === "wear" ? 0.88 : 0.65);
          expect(
            [...graph(tsl[key])].some((node) =>
              Reflect.get(node, "isTextureNode"),
            ),
          ).toBe(false);
        }
        cases++;
      }
    expect(cases).toBeGreaterThan(250);
    for (const ribbon of [...ground.talus, ...ground.wear]) {
      const one = { talus: [ribbon], wear: [] };
      const midpointX = (ribbon.startX + ribbon.endX) / 2;
      const midpointZ = (ribbon.startZ + ribbon.endZ) / 2;
      const tangent = new THREE.Vector2(
        ribbon.endX - ribbon.startX,
        ribbon.endZ - ribbon.startZ,
      ).normalize();
      const sample = (radius: number) =>
        ops.havenGroundWeights(
          midpointX - tangent.y * radius,
          midpointZ + tangent.x * radius,
          one,
          1,
        ).talus;
      expect(sample(0)).toBe(ribbon.strength);
      expect(sample(ribbon.coreRadius)).toBeCloseTo(ribbon.strength, 13);
      expect(sample(ribbon.outerRadius)).toBeCloseTo(0, 13);
      expect(sample(ribbon.outerRadius + 1e-5)).toBe(0);
      expect(sample(ribbon.outerRadius - 1e-5) / 1e-5).toBeLessThan(0.0001);
    }
    for (const [x, z] of [
      [303.5, 359],
      [315.5, 337],
      [308, 306.5],
      [307, 362.5],
      [330, 360],
      [343, 302],
      [350, 400],
    ])
      expect(ops.havenGroundWeights(x, z, ground, 1)).toEqual({
        talus: 0,
        wear: 0,
      });
    for (const slope of [-1, 0, 0.008, 0.015, 0.029, 0.049, 0.05, 0.2, 1, 2])
      for (const [x, z] of [
        [311, 328],
        [313, 337],
        [335, 336],
      ]) {
        const t = THREE.MathUtils.clamp((slope - 0.008) / (0.05 - 0.008), 0, 1);
        const expected =
          Math.max(
            ...ground.talus.map((ribbon) => expectedRibbon(x, z, ribbon)),
          ) *
          t *
          t *
          (3 - 2 * t);
        const cpu = ops.havenGroundWeights(x, z, ground, slope);
        const tsl = createCompactHavenGroundWeights(
          vec2(x, z),
          ground,
          float(0),
          float(slope),
        );
        expect(cpu.talus).toBeCloseTo(expected, 13);
        expect(vectorValue(tsl.talus)[0]).toBeCloseTo(expected, 13);
        expect(cpu.wear).toBe(ops.havenGroundWeights(x, z, ground, 0).wear);
        expect(vectorValue(tsl.wear)[0]).toBeCloseTo(cpu.wear, 13);
        if (slope <= 0.008) expect(cpu.talus).toBe(0);
      }
    expect(ops.havenGroundWeights(311, 328, ground).talus).toBe(0);
    expect(ops.havenGroundWeights(311, 328, ground, 0.029).talus).toBeCloseTo(
      0.325,
      13,
    );
    expect(ops.havenGroundWeights(311, 328, ground, 0.05).talus).toBe(0.65);
    const absent = createCompactHavenGroundWeights(vec2(310, 328));
    expect(vectorValue(absent.talus)).toEqual([0]);
    expect(vectorValue(absent.wear)).toEqual([0]);
  });

  it("blends the whole existing PBR surface and preserves full cliff, road and pond priority", () => {
    const layers = {
      grass: {
        albedo: vec3(0.1, 0.2, 0.3),
        roughness: float(0.4),
        ao: float(0.2),
        worldNormal: vec3(0, 1, 0),
      },
      dirt: {
        albedo: vec3(0.3, 0.2, 0.1),
        roughness: float(0.7),
        ao: float(0.6),
        worldNormal: vec3(0.6, 0.8, 0),
      },
      rock: {
        albedo: vec3(0.6, 0.5, 0.4),
        roughness: float(0.9),
        ao: float(0.8),
        worldNormal: vec3(0, 0.8, 0.6),
      },
    };
    const before = Object.values(layers).flatMap((layer) =>
      Object.values(layer).map((node) => node.uuid),
    );
    for (const [x, z] of [
      [311, 328],
      [315, 328],
      [335, 336],
      [343, 348],
      [350, 360],
    ])
      for (const dirt of [0, 0.37, 1])
        for (const cliff of [0, 0.41, 1])
          for (const road of [0, 0.52, 1]) {
            const authored = ops.havenGroundWeights(x, z, ground, 1);
            const authoredNodes = createCompactHavenGroundWeights(
              vec2(x, z),
              ground,
              float(0),
              float(1),
            );
            const surface = blendCompactTerrainLayers(
              layers,
              float(dirt),
              float(cliff),
              float(road),
              authoredNodes,
            );
            const mix = THREE.MathUtils.lerp;
            const expected = (grass: number, soil: number, rock: number) =>
              mix(
                mix(
                  mix(
                    mix(
                      mix(grass, soil, dirt),
                      mix(soil, rock, 0.85),
                      authored.talus,
                    ),
                    soil,
                    authored.wear,
                  ),
                  rock,
                  cliff,
                ),
                soil,
                road,
              );
            for (const key of ["albedo", "roughness", "ao"] as const) {
              const actual = vectorValue(surface[key]);
              const a = vectorValue(layers.grass[key]),
                b = vectorValue(layers.dirt[key]),
                c = vectorValue(layers.rock[key]);
              actual.forEach((value, channel) =>
                expect(value).toBeCloseTo(
                  expected(a[channel], b[channel], c[channel]),
                  13,
                ),
              );
            }
            for (const layer of Object.values(layers))
              expect(graph(surface.normal).has(layer.worldNormal)).toBe(true);
            const expectedNormal = new THREE.Vector3(
              ...[0, 1, 2].map((channel) =>
                expected(
                  vectorValue(layers.grass.worldNormal)[channel],
                  vectorValue(layers.dirt.worldNormal)[channel],
                  vectorValue(layers.rock.worldNormal)[channel],
                ),
              ),
            ).normalize();
            // Evaluate the actual pre-camera world-normal subgraph. The real
            // camera node is renderer-bound, not an invented test uniform;
            // separate projection tests qualify the world-to-view operation.
            const worldNormals = [...graph(surface.normal)].filter(
              (node) =>
                Reflect.get(node, "method") === "normalize" &&
                !graph(node).has(cameraViewMatrix) &&
                Object.values(layers).every((layer) =>
                  graph(node).has(layer.worldNormal),
                ),
            );
            expect(worldNormals).toHaveLength(1);
            vectorValue(worldNormals[0]).forEach((value, channel) =>
              expect(value).toBeCloseTo(expectedNormal.toArray()[channel], 13),
            );
            for (const node of [authoredNodes.talus, authoredNodes.wear]) {
              expect(node.type).toBe("VarNode");
              for (const channel of [
                surface.albedo,
                surface.roughness,
                surface.ao,
                surface.normal,
              ])
                expect(graph(channel).has(node)).toBe(true);
            }
          }
    const bed = blendCompactTerrainLayers(
      layers,
      float(1),
      float(0),
      float(0),
      createCompactHavenGroundWeights(
        vec2(311, 328),
        ground,
        float(1),
        float(1),
      ),
    );
    expect(vectorValue(bed.albedo)).toEqual(vectorValue(layers.dirt.albedo));
    expect(vectorValue(bed.roughness)).toEqual([0.7]);
    expect(vectorValue(bed.ao)).toEqual([0.6]);
    expect(
      Object.values(layers).flatMap((layer) =>
        Object.values(layer).map((node) => node.uuid),
      ),
    ).toEqual(before);
  });

  it("keeps CPU grass-base colors equal to TSL composition while all physical eligibility stays identical", () => {
    const palette = ops.getPalette();
    const { havenGround: _ground, ...withoutGround } = field;
    const layers = {
      grass: {
        albedo: vec3(...palette.grass),
        roughness: float(0.8),
        ao: float(1),
        worldNormal: vec3(0, 1, 0),
      },
      dirt: {
        albedo: vec3(...palette.dirt),
        roughness: float(0.9),
        ao: float(1),
        worldNormal: vec3(0, 1, 0),
      },
      rock: {
        albedo: vec3(...palette.rock),
        roughness: float(0.7),
        ao: float(1),
        worldNormal: vec3(0, 1, 0),
      },
    };
    let changedColors = 0;
    for (const grassColorGrade of [undefined, "fine-meadow-green-v1"] as const)
      for (const [x, z] of [
        [307, 310],
        [311, 328],
        [315, 328],
        [335, 336],
        [343, 348],
        [350, 360],
        [400, 400],
      ])
        for (const noiseValue of [0.2, 0.51, 0.8])
          for (const slope of [0, 0.008, 0.015, 0.029, 0.05, 0.1, 0.3])
            for (const roadInfluence of [0, 0.5, 1]) {
              const input = {
                noiseValue,
                meadowNoise: 0,
                grassColorGrade,
                distortNoise: 0.4,
                slope,
                roadInfluence,
                surface: {
                  x,
                  z,
                  height: field.baseElevation,
                  pond: null,
                  macroField: field,
                },
              };
              const historical = {
                ...input,
                surface: { ...input.surface, macroField: withoutGround },
              };
              expect(ops.grassSupport(input)).toBe(
                ops.grassSupport(historical),
              );
              const cpu = ops.sample(input);
              expect(cpu).toEqual(ops.sample({ ...input, meadowNoise: 1 }));
              const macro = ops.macroWeights(x, z, noiseValue, field);
              const weights = ops.weights({ ...input, macroSurface: macro });
              const surface = blendCompactTerrainLayers(
                {
                  ...layers,
                  grass: applyCompactGrassColorGrade(
                    layers.grass,
                    grassColorGrade,
                  ),
                },
                float(weights.dirt),
                float(weights.cliff),
                float(weights.road),
                createCompactHavenGroundWeights(
                  vec2(x, z),
                  ground,
                  float(0),
                  float(slope),
                ),
              );
              const actual = vectorValue(surface.albedo.mul(weights.variation));
              [cpu.r, cpu.g, cpu.b].forEach((value, channel) =>
                expect(actual[channel]).toBeCloseTo(value, 13),
              );
              if (roadInfluence === 1)
                expect(cpu).toEqual(ops.sample(historical));
              else if (
                JSON.stringify(cpu) !== JSON.stringify(ops.sample(historical))
              )
                changedColors++;
            }
    expect(changedColors).toBeGreaterThan(75);
    expect(_ground).toBe(ground);
  });

  it("attributes the actual material graph to immutable used controls with six maps and the explicit 20-sample candidate budget", () => {
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: profile,
    });
    const baseline = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
    });
    try {
      const receipt = material.compactHavenGroundMaterial!;
      expect(receipt).toEqual({
        schemaVersion: 1,
        mode: "authored-haven-ground-v2",
        descriptor: ground,
        sourceGrass: true,
        wholePbrBlend: true,
        talusSegments: 5,
        wearSegments: 2,
        talusRockFraction: 0.85,
        talusSlopeStart: 0.008,
        talusSlopeEnd: 0.05,
        grassEligibilityChanged: false,
      });
      for (const object of [
        receipt,
        receipt.descriptor,
        receipt.descriptor.talus,
        receipt.descriptor.wear,
        ...receipt.descriptor.talus,
        ...receipt.descriptor.wear,
      ])
        expect(Object.isFrozen(object)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(material, "compactHavenGroundMaterial")
          ?.writable,
      ).toBe(false);
      expect(
        material.compactTerrainSurface!.getReceipt().textures,
      ).toHaveLength(6);
      expect(
        material.compactTerrainSurface!.getReceipt().surfaceSampleCount,
      ).toBe(20);
      expect(baseline.compactHavenGroundMaterial).toBeUndefined();
      const pbr = material;
      for (const node of [
        pbr.colorNode,
        pbr.normalNode,
        pbr.roughnessNode,
        pbr.aoNode,
      ])
        expect(node).toBeInstanceOf(THREE.Node);
    } finally {
      material.dispose();
      baseline.dispose();
    }
  });

  it("runs the freshly bundled palette and admitted descriptor in a real isolated worker with exact CPU parity", async () => {
    const bundle = await build({
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
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
    const inputs = [
      [307, 310],
      [311, 328],
      [317, 337],
      [335, 336],
      [343, 348],
      [350, 360],
    ].flatMap(([x, z]) =>
      [0, 0.5, 1].flatMap((roadInfluence) =>
        [0, 0.008, 0.029, 0.05, 0.1].map((slope) => ({
          noiseValue: 0.57,
          meadowNoise: 0.9,
          distortNoise: 0.31,
          slope,
          roadInfluence,
          surface: {
            x,
            z,
            height: field.baseElevation,
            pond: null,
            macroField: field,
          },
        })),
      ),
    );
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads');
      const ops=(${loaded.createCompactTerrainColorOperations.toString()})();
      const field=ops.macroField(${JSON.stringify(profile)});
      const inputs=${JSON.stringify(inputs)};
      parentPort.postMessage({field,frozen:Object.isFrozen(field.havenGround)&&field.havenGround.talus.every(Object.isFrozen),
        results:inputs.map(input=>({color:ops.sample(input),support:ops.grassSupport(input),weights:ops.havenGroundWeights(input.surface.x,input.surface.z,field.havenGround,input.slope)}))});`,
      { eval: true, env: {} },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual({
        field,
        frozen: true,
        results: inputs.map((input) => ({
          color: ops.sample(input),
          support: ops.grassSupport(input),
          weights: ops.havenGroundWeights(
            input.surface.x,
            input.surface.z,
            ground,
            input.slope,
          ),
        })),
      });
    } finally {
      await worker.terminate();
    }
  });
});

describe("frequency-aware grass substrate (actual TSL, not hardware filtering or art approval)", () => {
  const ownedSamples = (roots: Node[], owner: CompactTerrainTextureSet) => {
    const owned = new Set(
      owner.getReceipt().textures.map((row) => row.textureUuid),
    );
    return [...new Set(roots.flatMap((root) => [...graph(root)]))].filter(
      (node) => {
        const value: unknown = Reflect.get(node, "value");
        return (
          value instanceof THREE.Texture &&
          owned.has(value.uuid) &&
          Reflect.get(node, "uvNode")
        );
      },
    );
  };
  const layerRoots = (layers: ReturnType<typeof createCompactTerrainLayers>) =>
    Object.values(layers).flatMap((layer) => Object.values(layer));
  const fingerprint = (root: Node, owner: CompactTerrainTextureSet): string => {
    const keys = new Map(
      owner.getReceipt().textures.map((row) => [row.textureUuid, row.key]),
    );
    const cache = new Map<Node, string>();
    const visit = (node: Node): string => {
      const cached = cache.get(node);
      if (cached) return cached;
      const value: unknown = Reflect.get(node, "value");
      const result = createHash("sha256")
        .update(
          JSON.stringify({
            type: node.type,
            ...Object.fromEntries(
              ["op", "method", "components", "scope", "nodeType", "name"].map(
                (key) => [key, Reflect.get(node, key)],
              ),
            ),
            value:
              value instanceof THREE.Texture
                ? {
                    key: keys.get(value.uuid),
                    colorSpace: value.colorSpace,
                    anisotropy: value.anisotropy,
                  }
                : value instanceof THREE.Matrix4
                  ? value.toArray()
                  : value instanceof THREE.Vector2 ||
                      value instanceof THREE.Vector3 ||
                      value instanceof THREE.Vector4
                    ? value.toArray()
                    : typeof value === "number" ||
                        typeof value === "boolean" ||
                        typeof value === "string"
                      ? value
                      : undefined,
            children: [...node.getChildren()].map(visit),
          }),
        )
        .digest("hex");
      cache.set(node, result);
      return result;
    };
    return visit(root);
  };

  it("admits only the frozen height-material recipe and reports the exact added reads without allocating maps", () => {
    expect(COMPACT_GRASS_SUBSTRATE).toEqual({
      id: "frequency-v1",
      footprintMeters: 0.07,
      detailRetention: 0.35,
      additionalSurfaceSampleCount: 2,
    });
    expect(Object.isFrozen(COMPACT_GRASS_SUBSTRATE)).toBe(true);
    for (const invalid of [
      null,
      false,
      {},
      "",
      "FREQUENCY-V1",
      "frequency-v1 ",
      "frequency-v2",
    ])
      expect(
        () =>
          new CompactTerrainTextureSet(
            "/assets",
            undefined,
            "height-v1",
            undefined,
            invalid as CompactGrassSubstrate,
          ),
      ).toThrow();
    expect(
      () =>
        new CompactTerrainTextureSet(
          "/assets",
          undefined,
          undefined,
          undefined,
          "frequency-v1",
        ),
    ).toThrow();
    for (const dirt of [undefined, "stochastic-v1"] as const)
      for (const rock of [undefined, "stochastic-v1"] as const) {
        const baseline = new CompactTerrainTextureSet(
          "/assets",
          dirt,
          "height-v1",
          rock,
        );
        const candidate = new CompactTerrainTextureSet(
          "/assets",
          dirt,
          "height-v1",
          rock,
          "frequency-v1",
        );
        try {
          const previous = baseline.getReceipt(),
            current = candidate.getReceipt();
          const expected = (dirt ? 27 : 24) + (rock ? 6 : 0);
          expect(previous.surfaceSampleCount).toBe(expected);
          expect(current.surfaceSampleCount).toBe(expected + 2);
          expect(
            Object.prototype.hasOwnProperty.call(previous, "grassSubstrate"),
          ).toBe(false);
          expect(current.grassSubstrate).toBe(COMPACT_GRASS_SUBSTRATE);
          expect(current.textures).toHaveLength(7);
          expect(
            current.textures.map(({ textureUuid: _uuid, ...row }) => row),
          ).toEqual(
            previous.textures.map(({ textureUuid: _uuid, ...row }) => row),
          );
          const grass = candidate.getNode("grass", "albedo-roughness").value;
          expect(grass.colorSpace).toBe(THREE.SRGBColorSpace);
          expect(grass.minFilter).toBe(THREE.LinearMipmapLinearFilter);
          expect(grass.anisotropy).toBe(16);
          expect(grass.generateMipmaps).toBe(true);
          expect(grass.premultiplyAlpha).toBe(false);
          const a = createCompactTerrainLayers(
            baseline,
            float(64),
            float(0.137),
          );
          const b = createCompactTerrainLayers(
            candidate,
            float(64),
            float(0.137),
          );
          expect(ownedSamples(layerRoots(a), baseline)).toHaveLength(expected);
          expect(ownedSamples(layerRoots(b), candidate)).toHaveLength(
            expected + 2,
          );
          for (const layer of ["grass", "dirt", "rock"] as const)
            for (const channel of [
              "albedo",
              "roughness",
              "ao",
              "worldNormal",
              "height",
              "rawRockAo",
            ] as const) {
              const before = a[layer][channel],
                after = b[layer][channel];
              if (!before || !after) {
                expect(after).toBe(before);
                continue;
              }
              // Only separately owned texture UUIDs are normalized to source
              // keys; every arithmetic input, projection and channel remains.
              expect(
                fingerprint(after, candidate) === fingerprint(before, baseline),
              ).toBe(!(layer === "grass" && channel === "albedo"));
            }
        } finally {
          baseline.dispose();
          candidate.dispose();
        }
      }
  });

  it("broadens the derivative covariance by an isotropic physical footprint for zero, grazing and rotated inputs", () => {
    const cases: ReadonlyArray<
      readonly [readonly [number, number], readonly [number, number]]
    > = [
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0.003, 0],
        [0, 0.004],
      ],
      [
        [0.3, 0],
        [0, 0.000001],
      ],
      [
        [0.2, 0.1],
        [0.4, 0.2],
      ],
      [
        [0.03, -0.01],
        [-0.04, 0.002],
      ],
      [
        [12, 3],
        [-7, 15],
      ],
    ];
    for (const [sourceX, sourceY] of cases)
      for (const angle of [0, 0.71, Math.PI / 2, -1.7])
        for (const scale of [0.82 / 1.4, 1.18 / 1.4, -1 / 1.4]) {
          const rotate = (v: readonly [number, number]) =>
            [
              v[0] * Math.cos(angle) - v[1] * Math.sin(angle),
              v[0] * Math.sin(angle) + v[1] * Math.cos(angle),
            ] as const;
          const dx = rotate(sourceX),
            dy = rotate(sourceY);
          const gradients = createCompactGrassSubstrateGradients(
            vec2(...dx),
            vec2(...dy),
            float(scale),
          );
          const x = vectorValue(gradients.dx),
            y = vectorValue(gradients.dy);
          expect([...x, ...y].every(Number.isFinite)).toBe(true);
          const r2 = (0.07 * Math.abs(scale)) ** 2;
          const original = [
            dx[0] ** 2 + dy[0] ** 2,
            dx[0] * dx[1] + dy[0] * dy[1],
            dx[1] ** 2 + dy[1] ** 2,
          ];
          const actual = [
            x[0] ** 2 + y[0] ** 2,
            x[0] * x[1] + y[0] * y[1],
            x[1] ** 2 + y[1] ** 2,
          ];
          const expected = [original[0] + r2, original[1], original[2] + r2];
          actual.forEach((value, i) =>
            expect(Math.abs(value - expected[i])).toBeLessThan(
              1e-12 * Math.max(1, Math.abs(expected[i])),
            ),
          );
          // Test the PSD increment in independent directions, not only the
          // diagonal. This catches broadening just the major derivative.
          for (const direction of [0, 0.43, 1.27, 2.9]) {
            const u = Math.cos(direction),
              v = Math.sin(direction);
            const added =
              u * u * (actual[0] - original[0]) +
              2 * u * v * (actual[1] - original[1]) +
              v * v * (actual[2] - original[2]);
            expect(Math.abs(added - r2)).toBeLessThan(1e-10);
            expect(added).toBeGreaterThan(0);
          }
        }
    // CPU arithmetic establishes the ellipse, not exact native anisotropic
    // taps, mip choice, a Gaussian kernel or pixel/motion acceptance.
    for (const scale of [0, 1e-12, -1e-12]) {
      const gradients = createCompactGrassSubstrateGradients(
        vec2(0),
        vec2(0),
        float(scale),
      );
      const x = vectorValue(gradients.dx),
        y = vectorValue(gradients.dy);
      expect([...x, ...y].every(Number.isFinite)).toBe(true);
      expect(x).toEqual([1e-6, 0]);
      expect(y).toEqual([0, 1e-6]);
    }
  });

  it("shares actual projection scale and stays continuous across every sampled antirepeat band", () => {
    const at = (noise: number) =>
      createCompactGroundProjections(
        vec2(350, 320),
        float(noise),
        1 / 1.4,
        vec2(0.003, 0.001),
        vec2(0.08, 0.006),
      );
    for (const id of [-3, 0, 1, 7, 13, 24, 32]) {
      const left = at(id / 32 - 1e-8),
        right = at(id / 32 + 1e-8);
      expect(vectorValue(left.weight)).toEqual([1]);
      expect(vectorValue(right.weight)).toEqual([0]);
      for (const key of ["uv", "dx", "dy", "scale"] as const)
        expect(vectorValue(left.b[key])).toEqual(vectorValue(right.a[key]));
      const lowLeft = createCompactGrassSubstrateGradients(
        left.b.dx,
        left.b.dy,
        left.b.scale,
        "B",
      );
      const lowRight = createCompactGrassSubstrateGradients(
        right.a.dx,
        right.a.dy,
        right.a.scale,
        "A",
      );
      for (const key of ["dx", "dy"] as const)
        expect(vectorValue(lowLeft[key])).toEqual(vectorValue(lowRight[key]));
      for (const p of [left.a, left.b, right.a, right.b]) {
        const scale = vectorValue(p.scale)[0];
        expect(
          Math.hypot(...vectorValue(p.dx)) / Math.hypot(0.003, 0.001),
        ).toBeCloseTo(scale, 12);
        expect(
          Math.hypot(...vectorValue(p.dy)) / Math.hypot(0.08, 0.006),
        ).toBeCloseTo(scale, 12);
        expect(scale).toBeGreaterThanOrEqual(0.82 / 1.4);
        expect(scale).toBeLessThanOrEqual(1.18 / 1.4);
      }
    }
  });

  it("retains original high-frequency reads for roughness and other channels while composing only linear RGB", () => {
    const owner = new CompactTerrainTextureSet(
      "/assets",
      "stochastic-v1",
      "height-v1",
      "stochastic-v1",
      "frequency-v1",
    );
    try {
      const layers = createCompactTerrainLayers(owner, float(0), float(0.137));
      const grass = layers.grass;
      const source = owner.getNode("grass", "albedo-roughness").value;
      const samples = ownedSamples([grass.albedo], owner).filter(
        (node) => Reflect.get(node, "value") === source,
      );
      const original = ownedSamples([grass.roughness], owner).filter(
        (node) => Reflect.get(node, "value") === source,
      );
      const low = samples.filter((node) => !original.includes(node));
      expect(samples).toHaveLength(4);
      expect(original).toHaveLength(2);
      expect(low).toHaveLength(2);
      for (const sample of low) {
        const high = original.filter(
          (node) =>
            Reflect.get(node, "uvNode") === Reflect.get(sample, "uvNode"),
        );
        expect(high).toHaveLength(1);
        expect(Reflect.get(sample, "gradNode")).toHaveLength(2);
        expect(Reflect.get(sample, "gradNode")).not.toEqual(
          Reflect.get(high[0], "gradNode"),
        );
        const broad = Reflect.get(sample, "gradNode") as Node[];
        const detailed = Reflect.get(high[0], "gradNode") as Node[];
        for (const component of broad)
          for (const originalDerivative of detailed)
            expect(graph(component).has(originalDerivative)).toBe(true);
        expect(Reflect.get(sample, "levelNode")).toBeNull();
        expect(Reflect.get(sample, "biasNode")).toBeNull();
        for (const root of [
          grass.roughness,
          grass.ao,
          grass.worldNormal,
          grass.height!,
        ])
          expect(graph(root).has(sample)).toBe(false);
      }
      const contrasted = applyCompactFineGrassSubstrateContrast(
        grass,
        "fine-meadow-green-v1",
        "height-v1",
      );
      const mean = createCompactTerrainColorOperations().getPalette().grass;
      for (const [highRgb, lowRgb] of [
        [mean, mean],
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        [
          [1, 1, 1],
          [1, 1, 1],
        ],
        [
          [0.03, 0.8, 0.12],
          [0.18, 0.24, 0.09],
        ],
        [
          [0.7, 0.13, 0.32],
          [0.18, 0.24, 0.09],
        ],
      ])
        for (const lowAlpha of [0, 0.23, 1]) {
          // Actual sample-node inputs are already linear RGB. This checks
          // real graph composition, never pretends to implement GPU filtering.
          const inputs = new Map<Node, readonly number[]>();
          original.forEach((node) => inputs.set(node, [...highRgb, 0.41]));
          low.forEach((node) => inputs.set(node, [...lowRgb, lowAlpha]));
          const expected = lowRgb.map(
            (value, i) => value + 0.35 * (highRgb[i] - value),
          );
          vectorValue(grass.albedo, inputs).forEach((value, i) => {
            expect(value).toBeCloseTo(expected[i], 14);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          });
          vectorValue(contrasted.albedo, inputs).forEach((value, i) =>
            expect(value).toBeCloseTo(
              mean[i] + 0.7 * (expected[i] - mean[i]),
              14,
            ),
          );
          expect(vectorValue(grass.roughness, inputs)[0]).toBeCloseTo(
            0.85 + 0.13 * 0.41,
            14,
          );
          for (const channel of [
            "roughness",
            "ao",
            "worldNormal",
            "height",
          ] as const)
            expect(contrasted[channel]).toBe(grass[channel]);
        }
    } finally {
      owner.dispose();
    }
  });

  it("wires the extra reads only for admitted grade plus height and keeps the existing contrast order", () => {
    for (const grade of [
      undefined,
      "fine-meadow-green-v1",
      "fine-meadow-regional-v1",
    ] as const)
      for (const height of [undefined, "height-v1"] as const) {
        const material = createTerrainMaterial(undefined, {
          compactPbr: true,
          compactDirtProjection: "stochastic-v1",
          compactRockProjection: "stochastic-v1",
          compactGrassColorGrade: grade,
          compactSurfaceBlend: height,
        });
        try {
          const owner = material.compactTerrainSurface!;
          const active = grade !== undefined && height !== undefined;
          const receipt = owner.getReceipt();
          const expected = height ? (active ? 35 : 33) : 28;
          expect(receipt.surfaceSampleCount).toBe(expected);
          expect(
            Object.prototype.hasOwnProperty.call(receipt, "grassSubstrate"),
          ).toBe(active);
          if (active)
            expect(receipt.grassSubstrate).toBe(COMPACT_GRASS_SUBSTRATE);
          const roots = [
            material.colorNode!,
            material.normalNode!,
            material.roughnessNode!,
            material.aoNode!,
          ].map((root) => {
            if (!(root instanceof THREE.Node))
              throw new Error("Expected actual terrain material node");
            return root;
          });
          expect(ownedSamples(roots, owner)).toHaveLength(expected);
          if (grade) {
            const named = (name: string) => {
              const matches = [...graph(material.colorNode!)].filter(
                (node) => Reflect.get(node, "name") === name,
              );
              expect(matches).toHaveLength(1);
              return matches[0];
            };
            const contrast = named("fineGrassSubstrateContrast");
            const substrate = named("fineGrassSubstrateAlbedo");
            const graded = named("compactGrassGradedAlbedo");
            expect(vectorValue(contrast)).toEqual([height ? 0.7 : 0.35]);
            expect(graph(graded).has(substrate)).toBe(true);
            expect(graph(substrate).has(graded)).toBe(false);
            const source = owner.getNode("grass", "albedo-roughness").value;
            expect(
              ownedSamples([substrate], owner).filter(
                (node) => Reflect.get(node, "value") === source,
              ),
            ).toHaveLength(active ? 4 : 2);
          }
        } finally {
          material.dispose();
        }
      }
  });
});

describe("exact-zero rock appearance (CPU arithmetic plus explicit native WGSL gate)", () => {
  it("evaluates only the explicit uniform-flow context arithmetic identity", () => {
    for (const uniformFlow of [true, false])
      expect(vectorValue(vec3(0.2, 0.8, 0.1).context({ uniformFlow }))).toEqual(
        [0.2, 0.8, 0.1],
      );
    let getterReads = 0;
    const inherited = Object.assign(Object.create({ uniformFlow: true }), {
      unrelated: true,
    });
    const accessor = Object.defineProperty({}, "uniformFlow", {
      get: () => {
        getterReads++;
        return true;
      },
    });
    for (const context of [
      {},
      { uniformFlow: 1 },
      { uniformFlow: true, other: false },
      { uniformFlow: true, [Symbol("other")]: false },
      inherited,
      accessor,
    ])
      expect(() => vectorValue(vec3(1).context(context))).toThrow(
        "Unsupported numeric TSL context",
      );
    expect(getterReads).toBe(0);
  });
  it("skips only exact zero rock and absent dry-soil mineral contribution", () => {
    const values = [-1, -1e-30, -0, 0, 1e-30, 0.25, 1];
    for (const rock of values)
      for (const soil of values)
        for (const mineral of [-2, -1e-30, -0, 0, 1e-30, 0.5, 1, 2]) {
          const gate = createCompactRockAppearanceRequired(
            vec4(0.3, soil, rock, 0.7),
            float(mineral),
          );
          const expected =
            rock !== 0 ||
            (soil !== 0 && Math.max(0, Math.min(1, mineral)) !== 0);
          expect(vectorValue(gate)).toEqual([expected ? 1 : 0]);
          // This graph has no sampler, derivative or appearance dependency.
          expect(
            [...graph(gate)].some(
              (node) =>
                Reflect.get(node, "isTextureNode") === true ||
                ["dFdx", "dFdy"].includes(String(Reflect.get(node, "method"))),
            ),
          ).toBe(false);
        }
    // Neither wet-soil nor grass weight can require mineral appearance alone.
    for (const unrelated of [-10, 0, 10])
      expect(
        vectorValue(
          createCompactRockAppearanceRequired(
            vec4(unrelated, 0, 0, unrelated),
            float(1),
          ),
        ),
      ).toEqual([0]);
  });

  it("resolves appearance once after final bank weights without feeding appearance back into weights", () => {
    const layers = {
      grass: {
        albedo: vec3(0.1, 0.2, 0.3),
        roughness: float(0.92),
        ao: float(0.7),
        worldNormal: vec3(0, 1, 0),
        height: float(0.2),
      },
      dirt: {
        albedo: vec3(0.4, 0.3, 0.2),
        roughness: float(0.86),
        ao: float(0.6),
        worldNormal: vec3(0.2, 0.9, 0.1),
        height: float(0.8),
      },
      rock: {
        albedo: vec3(0.6, 0.7, 0.8),
        roughness: float(0.9),
        ao: float(0.8),
        worldNormal: vec3(0.1, 0.9, 0.2),
        rawRockAo: float(0.3),
      },
    };
    const parameters: Parameters<typeof blendCompactTerrainLayers> = [
      layers,
      float(0.24),
      float(0.13),
      float(0.19),
      { talus: float(0.2), wear: float(0.1) },
      float(0.17),
      undefined,
      float(0.12),
      float(0.21),
      float(0.11),
      float(0.08),
      { coverage: float(0.2), pondRegion: float(0.4) },
      undefined,
      undefined,
      {
        soilToGrass: float(0.1),
        soilToRock: float(0.2),
        grassToSoil: float(0.13),
        grassToRock: float(0.12),
        grassShade: float(0.8),
        groundCoverWeight: float(0.09),
        groundCoverGrassShare: float(0.7),
      },
    ];
    const baseline = blendCompactTerrainLayers(...parameters);
    const observed: Node[] = [];
    parameters[15] = (weights, original) => {
      observed.push(weights);
      expect(original).toBe(layers);
      return original;
    };
    const resolved = blendCompactTerrainLayers(...parameters);
    expect(observed).toEqual([resolved.weights]);
    const frame = new Map<Node, readonly number[]>([
      [cameraViewMatrix, new THREE.Matrix4().toArray()],
    ]);
    for (const key of [
      "albedo",
      "roughness",
      "ao",
      "normal",
      "weights",
    ] as const)
      expect(vectorValue(resolved[key]!, frame)).toEqual(
        vectorValue(baseline[key]!, frame),
      );
    const replacement = vec3(0.9, 0.1, 0.7);
    parameters[15] = (_weights, original) => ({
      ...original,
      grass: { ...original.grass, height: float(999), albedo: replacement },
    });
    const replaced = blendCompactTerrainLayers(...parameters);
    expect(vectorValue(replaced.weights!)).toEqual(
      vectorValue(baseline.weights!),
    );
    expect(graph(replaced.weights!).has(replacement)).toBe(false);
    const grassWeight = vectorValue(baseline.weights!)[0];
    const oldColor = vectorValue(baseline.albedo);
    const delta = vectorValue(replacement).map(
      (value, i) => value - vectorValue(layers.grass.albedo)[i],
    );
    vectorValue(replaced.albedo).forEach((value, i) =>
      expect(value).toBeCloseTo(oldColor[i] + grassWeight * delta[i], 13),
    );
    parameters[13] = { coverage: float(0.4), pondClearance: float(1) };
    expect(() => blendCompactTerrainLayers(...parameters)).toThrow(
      /coast cavity/i,
    );
    parameters[13] = undefined;
    parameters[0] = {
      ...layers,
      grass: { ...layers.grass, height: undefined },
    };
    expect(() => blendCompactTerrainLayers(...parameters)).toThrow(
      /height layers/i,
    );
  });

  type Flow = {
    code: string;
    result: string;
    textureNames: Map<string, string>;
  };
  type NativeFlowReceipt = {
    baseline: Omit<Flow, "textureNames"> & { textureNames: [string, string][] };
    candidate: Omit<Flow, "textureNames"> & {
      textureNames: [string, string][];
    };
    before: {
      uuid: string;
      sourceUuid: string;
      version: number;
      sourceVersion: number;
      colorSpace: string;
      anisotropy: number;
      wrapS: number;
      wrapT: number;
      minFilter: number;
      magFilter: number;
      generateMipmaps: boolean;
      flipY: boolean;
      premultiplyAlpha: boolean;
    }[];
    after: NativeFlowReceipt["before"];
    sharedPackedChannels: number;
    adapter: {
      vendor: string;
      architecture: string;
      description: string;
      fallback: boolean;
    };
    features: string[];
    errors: string[];
    nativeBackend: boolean;
  };

  // This entry imports only real production code and installed Three. Unlike
  // storage-only codegen, r186 texture codegen queries actual device features.
  // No supplied capability table, fake GPU object or feature override is valid.
  const nativeProbe = String.raw`
globalThis.terrainWgslProbe = async () => {
  if (!navigator.gpu || !isSecureContext) throw new Error("Native WebGPU is required");
  const adapter = await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
  if (!adapter || adapter.isFallbackAdapter || adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(
    [adapter.info.vendor,adapter.info.architecture,adapter.info.description].join(" ")))
    throw new Error("A hardware WebGPU adapter is required");
  const device = await adapter.requestDevice({requiredFeatures:[...adapter.features]});
  let active = true, renderer, owner, geometry, material;
  const errors = [];
  const onError = event => errors.push(String(event.error.message));
  device.addEventListener("uncapturederror", onError);
  device.lost.then(info => { if(active) errors.push("Device lost: " + info.message); });
  try {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("Missing real browser canvas");
    renderer = new THREE.WebGPURenderer({canvas,device});
    await renderer.init();
    if (renderer.backend.isWebGPUBackend !== true || renderer.backend.device !== device)
      throw new Error("Renderer did not retain the actual WebGPU device");
    owner = new CompactTerrainTextureSet("/assets","stochastic-v1","height-v1","stochastic-v1","frequency-v1");
    const textures = [
      ...["grass","dirt","rock"].flatMap(layer =>
        ["albedo-roughness","normal-ao"].map(channel => owner.getNode(layer,channel).value)),
      owner.getHeightNode().value,
    ];
    const snapshot = () => textures.map(t => ({
      uuid:t.uuid,sourceUuid:t.source.uuid,version:t.version,sourceVersion:t.source.version,
      colorSpace:t.colorSpace,anisotropy:t.anisotropy,wrapS:t.wrapS,wrapT:t.wrapT,
      minFilter:t.minFilter,magFilter:t.magFilter,generateMipmaps:t.generateMipmaps,
      flipY:t.flipY,premultiplyAlpha:t.premultiplyAlpha,
    }));
    const before = snapshot();
    geometry = new THREE.PlaneGeometry(2,2);
    material = new THREE.MeshStandardNodeMaterial();
    const mesh = new THREE.Mesh(geometry,material);
    let sharedPackedChannels = 0;
    const graph = root => {
      const nodes = new Set();
      const visit = node => {if(nodes.has(node))return;nodes.add(node);for(const child of node.getChildren())visit(child);};
      visit(root);return nodes;
    };
    const sharedDistance = uniform(16), sharedPattern = uniform(.43);
    const makeOutput = gated => {
      const factory = gated ? createCompactTerrainLayerFactory(owner,sharedDistance,sharedPattern) : null;
      const placeholder = {albedo:vec3(0),roughness:float(1),ao:float(1),worldNormal:normalWorldGeometry};
      const layers = factory ? {...factory.createGround(),rock:placeholder} : createCompactTerrainLayers(owner,sharedDistance,sharedPattern);
      const mineral = positionWorld.x.sin().mul(.5).add(.5).toVar("testedPondMineral");
      const silt = positionWorld.z.cos().mul(.5).add(.5).toVar("testedPondSilt");
      const appearance = original => {
        const bank = applyCompactPondBankMaterials(original.dirt,original.rock,
          {mineralAppearance:mineral,siltAppearance:silt});
        return {...original,dirt:bank.soil,rock:bank.rock};
      };
      const surface = blendCompactTerrainLayers(layers,uniform(.31),uniform(.23),uniform(.17),
        undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,
        (weights,original) => {
          if (!gated) return appearance(original);
          const rock = factory.createRock(createCompactRockAppearanceRequired(weights,mineral).toVar("testedRockAppearanceRequired"));
          const shared = Object.values(rock).map(root => [...graph(root)].filter(node => node.name === "compactRockAppearanceResult"));
          if(shared.length!==5 || shared.some(rows => rows.length!==1 || rows[0]!==shared[0][0]))
            throw new Error("Rock appearance is not one shared actual packed node");
          sharedPackedChannels=shared.length;
          return appearance({...original,rock});
        });
      // Exercise staged channel evaluation so the shared texture owners are
      // established before normals. This focused graph does not reproduce the
      // complete terrain material's lighting or exact emitted channel order.
      return Fn(() => {
        const albedo = surface.albedo.toVar("testedSurfaceAlbedo");
        const roughness = surface.roughness.toVar("testedSurfaceRoughness");
        const ao = surface.ao.toVar("testedSurfaceAo");
        const normal = surface.normal.toVar("testedSurfaceNormal");
        return vec4(albedo.add(normal),roughness.add(ao));
      })();
    };
    const generate = output => {
      const builder = new WGSLNodeBuilder(mesh,renderer);
      builder.camera = new THREE.PerspectiveCamera(58,1,.2,1000);
      builder.shaderStage = "fragment";
      const flow = builder.flowStagesNode(output,"vec4");
      if(typeof flow.code!=="string" || typeof flow.result!=="string")throw new Error("Missing native generated flow");
      const byUuid = new Map(owner.getReceipt().textures.map(row => [row.textureUuid,row.key]));
      const textureNames = builder.uniforms.fragment.filter(row => row.value instanceof THREE.Texture && byUuid.has(row.value.uuid))
        .map(row => [row.name,byUuid.get(row.value.uuid)]);
      if(textureNames.length!==7)throw new Error("Incomplete actual texture bindings");
      return {code:flow.code,result:flow.result,textureNames};
    };
    const baseline = generate(makeOutput(false)), candidate = generate(makeOutput(true));
    if(errors.length)throw new Error(errors.join("; "));
    return {baseline,candidate,before,after:snapshot(),sharedPackedChannels,
      adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description,
        fallback:adapter.isFallbackAdapter===true || adapter.info.isFallbackAdapter===true},
      features:[...device.features].sort(),errors,nativeBackend:renderer.backend.isWebGPUBackend};
  } finally {
    active=false;device.removeEventListener("uncapturederror",onError);
    try { owner?.dispose();geometry?.dispose();material?.dispose();renderer?.dispose(); }
    finally { device.destroy(); }
  }
};`;

  async function generateNative(): Promise<NativeFlowReceipt> {
    let browser: Browser | undefined;
    let server: Server | undefined;
    const errors: string[] = [];
    const modulePath = fileURLToPath(
      new URL("../CompactTerrainMaterial.ts", import.meta.url),
    );
    const threePath = fileURLToPath(
      new URL("../../../../extras/three/three.ts", import.meta.url),
    );
    try {
      const entry = await build({
        stdin: {
          contents: `import THREE,{float,vec3,vec4,uniform,normalWorldGeometry,positionWorld,Fn} from ${JSON.stringify(threePath)};
import {WGSLNodeBuilder} from "three/webgpu";
import {CompactTerrainTextureSet,createCompactTerrainLayers,createCompactTerrainLayerFactory,createCompactRockAppearanceRequired,blendCompactTerrainLayers,applyCompactPondBankMaterials} from ${JSON.stringify(modulePath)};
${nativeProbe}`,
          resolveDir: fileURLToPath(new URL(".", import.meta.url)),
          loader: "js",
        },
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        minify: false,
        keepNames: true,
      });
      expect(entry.outputFiles).toHaveLength(1);
      expect(
        Object.keys(entry.metafile.inputs).some((path) =>
          path.endsWith("CompactTerrainMaterial.ts"),
        ),
      ).toBe(true);
      expect(
        Object.keys(entry.metafile.inputs).filter((path) =>
          /__tests__|vitest|playwright|node:/.test(path),
        ),
      ).toEqual([]);
      server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (request.url === "/") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            '<!doctype html><title>Hyperia native terrain WGSL qualification</title><canvas></canvas><script type="module" src="/entry.js"></script>',
          );
        } else if (request.url === "/entry.js") {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(entry.outputFiles[0].contents);
        } else if (request.url === "/favicon.ico") {
          response.writeHead(204).end();
        } else {
          errors.push(`Unexpected request ${request.url}`);
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing private loopback port");
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        timeout: 20_000,
        args: ["--use-angle=metal", "--enable-features=WebGPU,UnsafeWebGPU"],
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = `http://127.0.0.1:${address.port}`;
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin)
          return route.continue();
        errors.push("Unexpected nonlocal request");
        return route.abort();
      });
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForFunction(
        () => typeof Reflect.get(globalThis, "terrainWgslProbe") === "function",
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const receipt = await Promise.race([
        page.evaluate(async () => {
          const actual = window as unknown as Window & {
            terrainWgslProbe(): Promise<NativeFlowReceipt>;
          };
          return actual.terrainWgslProbe();
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Native terrain WGSL qualification exceeded 45 seconds",
                ),
              ),
            45_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      expect(errors).toEqual([]);
      expect(receipt.errors).toEqual([]);
      expect(receipt.nativeBackend).toBe(true);
      expect(receipt.adapter.fallback).toBe(false);
      expect(receipt.sharedPackedChannels).toBe(5);
      process.stdout.write(
        `Native terrain WGSL adapter (not rendering/performance proof): ${JSON.stringify({ adapter: receipt.adapter, features: receipt.features })}\n`,
      );
      return receipt;
    } finally {
      try {
        await browser?.close();
      } finally {
        if (server?.listening)
          await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
            server!.closeAllConnections();
          });
      }
    }
  }

  // Balance generated braces rather than treating indentation or temporary IDs
  // as a shader contract. No normalization or rewriting of generated WGSL.
  const matchingEnd = (
    source: string,
    start: number,
    open: string,
    close: string,
  ) => {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === open) depth++;
      if (source[i] === close && --depth === 0) return i;
    }
    throw new Error("Unbalanced actual WGSL control flow");
  };
  const branches = (source: string) =>
    [...source.matchAll(/\bif\s*\(/g)].map((match) => {
      const start = match.index + match[0].lastIndexOf("(");
      const conditionEnd = matchingEnd(source, start, "(", ")");
      const bodyStart = source.indexOf("{", conditionEnd + 1);
      if (bodyStart < 0 || source.slice(conditionEnd + 1, bodyStart).trim())
        throw new Error("Missing actual conditional body");
      return {
        condition: source.slice(start + 1, conditionEnd),
        start: bodyStart,
        end: matchingEnd(source, bodyStart, "{", "}"),
      };
    });

  // Mandatory native qualification is separate from ordinary unit runs. A
  // skipped test is explicitly NOT generated-shader proof or promotion approval.
  it.skipIf(process.env.HYPERIA_NATIVE_TERRAIN_WGSL !== "1")(
    "native WebGPU generates one shared deferred rock branch with 18 reads, hoisted derivatives and unchanged 5 height reads",
    async () => {
      const receipt = await generateNative();
      const baseline: Flow = {
        ...receipt.baseline,
        textureNames: new Map(receipt.baseline.textureNames),
      };
      const candidate: Flow = {
        ...receipt.candidate,
        textureNames: new Map(receipt.candidate.textureNames),
      };
      const calls = (flow: Flow) =>
        [...flow.code.matchAll(/\btextureSampleGrad\s*\(\s*(\w+)/g)].map(
          (match) => {
            const key = flow.textureNames.get(match[1]);
            if (!key) throw new Error(`Unowned generated texture ${match[1]}`);
            return { key, offset: match.index };
          },
        );
      const oldCalls = calls(baseline),
        newCalls = calls(candidate);
      expect(oldCalls).toHaveLength(35);
      expect(newCalls).toHaveLength(35);
      const counts = (rows: ReturnType<typeof calls>) =>
        Object.fromEntries(
          [...new Set(rows.map((row) => row.key))]
            .sort()
            .map((key) => [key, rows.filter((row) => row.key === key).length]),
        );
      expect(counts(newCalls)).toEqual(counts(oldCalls));
      expect(counts(newCalls)).toEqual({
        "grass-albedo-roughness": 4,
        "grass-normal-ao": 2,
        "dirt-albedo-roughness": 3,
        "dirt-normal-ao": 3,
        "rock-albedo-roughness": 9,
        "rock-normal-ao": 9,
        "ground-height": 5,
      });
      const conditional = branches(candidate.code).filter((branch) =>
        branch.condition.includes("testedRockAppearanceRequired"),
      );
      expect(conditional).toHaveLength(1);
      const branch = conditional[0];
      const inside = (offset: number) =>
        offset > branch.start && offset < branch.end;
      expect(newCalls.filter((row) => inside(row.offset))).toHaveLength(18);
      for (const call of newCalls)
        expect(inside(call.offset)).toBe(call.key.startsWith("rock-"));
      const derivatives = [...candidate.code.matchAll(/\bdpd[xy]\s*\(/g)];
      expect(derivatives.length).toBeGreaterThan(0);
      for (const derivative of derivatives)
        expect(inside(derivative.index)).toBe(false);
      const worldDerivativeOperands: string[] = [];
      // r186 WGSLNodeBuilder maps dFdy to '- dpdy' for WebGPU coordinates.
      // Both hoisted derivatives must use the same actual world-position
      // varying, with no X negation or additional expression accepted.
      for (const [name, operation] of [
        ["compactRockWorldDx", "dpdx"],
        ["compactRockWorldDy", "-\\s*dpdy"],
      ]) {
        const assignments = [
          ...candidate.code.matchAll(
            new RegExp(
              `\\b${name}\\s*=\\s*${operation}\\s*\\(\\s*(\\w+)\\s*\\)\\s*;`,
              "g",
            ),
          ),
        ];
        const excerpt = candidate.code
          .split("\n")
          .filter((line) => /compactRockWorldD[xy]|\bdpd[xy]\s*\(/.test(line))
          .slice(0, 24)
          .map((line) => line.slice(0, 1200))
          .join("\n");
        expect(
          assignments,
          `Actual derivative assignments (bounded excerpt):\n${excerpt}`,
        ).toHaveLength(1);
        expect(assignments[0].index).toBeLessThan(branch.start);
        worldDerivativeOperands.push(assignments[0][1]);
      }
      expect(worldDerivativeOperands).toEqual([
        "v_positionWorld",
        "v_positionWorld",
      ]);
      expect([
        ...candidate.code.matchAll(/\bcompactRockAppearanceResult\s*=/g),
      ]).toHaveLength(1);
      const oldBranches = branches(baseline.code);
      for (const call of oldCalls.filter((row) => row.key.startsWith("rock-")))
        expect(
          oldBranches.some(
            (region) => call.offset > region.start && call.offset < region.end,
          ),
        ).toBe(false);
      for (const flow of [baseline, candidate]) {
        const regions = branches(flow.code);
        const source = flow.code + flow.result;
        // Both mineral and silt really vary by fragment. Derivative legality
        // must cover their downstream normals, not just the rock initializer.
        expect(source).toContain("testedPondMineral");
        expect(source).toContain("testedPondSilt");
        expect(source).toMatch(/\bselect\s*\(/);
        for (const name of [
          "compactPondBankSoilSourceNormal",
          "compactPondBankRockSourceNormal",
        ]) {
          const assignments = [
            ...flow.code.matchAll(new RegExp(`\\b${name}\\s*=`, "g")),
          ];
          expect(assignments).toHaveLength(1);
          expect(
            regions.some(
              (region) =>
                assignments[0].index > region.start &&
                assignments[0].index < region.end,
            ),
          ).toBe(false);
        }
        for (const derivative of flow.code.matchAll(/\bdpd[xy]\s*\(/g))
          expect(
            regions.some(
              (region) =>
                derivative.index > region.start &&
                derivative.index < region.end,
            ),
            "Material derivatives must precede every nonuniform bank/rock branch",
          ).toBe(false);
        expect(flow.code).not.toMatch(/\btextureSample(?:Bias|Level)?\s*\(/);
        expect(flow.code + flow.result).not.toMatch(/undefined|NaN|Infinity/);
      }
      expect(receipt.after).toEqual(receipt.before);
      expect(receipt.after).toHaveLength(7);
      for (const texture of receipt.after) {
        expect(texture.anisotropy).toBe(16);
        expect(texture.wrapS).toBe(THREE.RepeatWrapping);
        expect(texture.wrapT).toBe(THREE.RepeatWrapping);
        expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
        expect(texture.magFilter).toBe(THREE.LinearFilter);
        expect(texture.generateMipmaps).toBe(true);
        expect(texture.flipY).toBe(false);
        expect(texture.premultiplyAlpha).toBe(false);
      }
      const fingerprint = (flow: Flow) => ({
        codeSha256: createHash("sha256").update(flow.code).digest("hex"),
        resultSha256: createHash("sha256").update(flow.result).digest("hex"),
        codeLength: flow.code.length,
        resultLength: flow.result.length,
      });
      process.stdout.write(
        `Native terrain WGSL qualification: ${JSON.stringify({
          scope:
            "Actual initialized r186 generated fragment flow; not shader-module compilation, draw or performance proof",
          adapter: receipt.adapter,
          baseline: fingerprint(baseline),
          candidate: fingerprint(candidate),
          ownedSampleCounts: counts(newCalls),
          totalSamples: newCalls.length,
          rockSamplesInsideSingleBranch: newCalls.filter((row) =>
            inside(row.offset),
          ).length,
          heightSamplesOutsideBranch: newCalls.filter(
            (row) => row.key === "ground-height" && !inside(row.offset),
          ).length,
          derivativeOperatorsOutsideBranch: derivatives.length,
          worldDerivativeOperands,
          sharedPackedChannels: receipt.sharedPackedChannels,
          samplerStateUnchanged: true,
        })}\n`,
      );
    },
    90_000,
  );
});

describe("compact terrain actual texture ownership and CPU material graph", () => {
  it("compresses only admitted fine grass linear albedo around the unchanged source mean", () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    const grass: CompactTerrainLayer = {
      albedo: vec3(0.3, 0.08, 0.6),
      roughness: float(0.91),
      ao: float(0.83),
      worldNormal: vec3(0.2, 0.9, 0.1),
    };
    expect(applyCompactFineGrassSubstrateContrast(grass, undefined)).toBe(
      grass,
    );
    for (const invalid of [null, false, "", {}, "fine-meadow-green-v2"])
      expect(() =>
        applyCompactFineGrassSubstrateContrast(
          grass,
          invalid as CompactGrassColorGrade,
        ),
      ).toThrow(/grass color grade/);
    const candidate = applyCompactFineGrassSubstrateContrast(
      grass,
      "fine-meadow-green-v1",
    );
    for (const key of ["roughness", "ao", "worldNormal"] as const)
      expect(candidate[key]).toBe(grass[key]);
    const contrastNodes = [...graph(candidate.albedo)].filter(
      (node) => Reflect.get(node, "name") === "fineGrassSubstrateContrast",
    );
    expect(contrastNodes).toHaveLength(1);
    // Actual r186 intent wrappers are traversed by the existing evaluator.
    expect(vectorValue(contrastNodes[0])).toEqual([0.35]);
    expect(Reflect.get(candidate.albedo, "name")).toBe(
      "fineGrassSubstrateAlbedo",
    );
    expect(graph(candidate.albedo).has(grass.albedo)).toBe(true);
    for (const rgb of [palette.grass, [0, 0, 0], [1, 1, 1], [0.3, 0.08, 0.6]]) {
      const actual = vectorValue(
        candidate.albedo,
        new Map([[grass.albedo, rgb]]),
      );
      for (let channel = 0; channel < 3; channel++)
        expect(actual[channel]).toBeCloseTo(
          palette.grass[channel] +
            0.35 * (rgb[channel] - palette.grass[channel]),
          14,
        );
      if (rgb === palette.grass) expect(actual).toEqual(palette.grass);
    }
    expect(vectorValue(grass.albedo)).toEqual([0.3, 0.08, 0.6]);
    expect(ops.getPalette()).toEqual(palette);
  });

  it("keeps all real grass texels bounded and preserves the raw linear mean with actual TSL contrast", async () => {
    const ops = createCompactTerrainColorOperations();
    const mean = ops.getPalette().grass;
    const bytes = await readFile(
      new URL("grass-albedo-roughness.png", assetDirectory),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedDigest("grass-albedo-roughness"),
    );
    const image = PNG.sync.read(bytes);
    const grass: CompactTerrainLayer = {
      albedo: vec3(0),
      roughness: float(1),
      ao: float(1),
      worldNormal: vec3(0, 1, 0),
    };
    const candidate = applyCompactFineGrassSubstrateContrast(
      grass,
      "fine-meadow-green-v1",
    );
    const graded = applyCompactGrassColorGrade(
      candidate,
      "fine-meadow-green-v1",
    );
    // Every decoded 8-bit channel value goes through the actual arithmetic
    // graph once. The lookup covers every real RGB texel without fabricating a
    // GPU sampler or allocating a graph for each of the million source pixels.
    const linear: number[] = [];
    const lookup: number[][] = [];
    const gradedLookup: number[][] = [];
    for (let value = 0; value < 256; value++) {
      const srgb = value / 255;
      const source =
        srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      linear.push(source);
      const input = new Map<Node, readonly number[]>([
        [grass.albedo, [source, source, source]],
      ]);
      lookup.push(vectorValue(candidate.albedo, input));
      gradedLookup.push(vectorValue(graded.albedo, input));
    }
    const sums = [0, 0, 0],
      sourceSums = [0, 0, 0];
    let minimum = Infinity,
      maximum = -Infinity,
      maxError = 0;
    for (let pixel = 0; pixel < image.data.length; pixel += 4)
      for (let channel = 0; channel < 3; channel++) {
        const encoded = image.data[pixel + channel];
        const value = lookup[encoded][channel];
        sums[channel] += value;
        sourceSums[channel] += linear[encoded];
        minimum = Math.min(minimum, value, gradedLookup[encoded][channel]);
        maximum = Math.max(maximum, value, gradedLookup[encoded][channel]);
        maxError = Math.max(
          maxError,
          Math.abs(
            value - (mean[channel] + 0.35 * (linear[encoded] - mean[channel])),
          ),
        );
      }
    expect(maxError).toBeLessThan(1e-14);
    expect(minimum).toBeGreaterThanOrEqual(0);
    expect(maximum).toBeLessThan(1);
    for (let channel = 0; channel < 3; channel++) {
      expect(sourceSums[channel] / (image.width * image.height)).toBeCloseTo(
        mean[channel],
        12,
      );
      expect(sums[channel] / (image.width * image.height)).toBeCloseTo(
        mean[channel],
        11,
      );
    }
    expect(ops.getPalette().grass).toEqual(mean);
  });

  it("applies substrate contrast before grade and every soil, habitat, cliff and road override", () => {
    const mean = createCompactTerrainColorOperations().getPalette().grass;
    const grass: CompactTerrainLayer = {
      albedo: vec3(0.3, 0.08, 0.6),
      roughness: float(0.91),
      ao: float(0.83),
      worldNormal: vec3(0, 1, 0),
    };
    const dirt: CompactTerrainLayer = {
      albedo: vec3(0.17, 0.11, 0.06),
      roughness: float(0.8),
      ao: float(0.7),
      worldNormal: vec3(0.2, 0.9, 0.1),
    };
    const rock: CompactTerrainLayer = {
      albedo: vec3(0.23, 0.18, 0.14),
      roughness: float(0.7),
      ao: float(0.6),
      worldNormal: vec3(-0.1, 0.9, 0.2),
    };
    const candidate = applyCompactGrassColorGrade(
      applyCompactFineGrassSubstrateContrast(grass, "fine-meadow-green-v1"),
      "fine-meadow-green-v1",
    );
    const grade = [0.95, 1.3, 1.1];
    const compressed = [0.3, 0.08, 0.6].map(
      (value, i) => (mean[i] + 0.35 * (value - mean[i])) * grade[i],
    );
    for (const [soil, talus, wear, habitat, cliff, road] of [
      [0, 0, 0, 0, 0, 0],
      [0.2, 0.3, 0.4, 0.46, 0.25, 0.35],
      [1, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 0, 0, 1, 0, 0],
      [0, 0.3, 0.4, 0.46, 1, 0],
      [0, 0.3, 0.4, 0.46, 0.25, 1],
    ]) {
      const blend = (g: CompactTerrainLayer) =>
        blendCompactTerrainLayers(
          { grass: g, dirt, rock },
          float(soil),
          float(cliff),
          float(road),
          { talus: float(talus), wear: float(wear) },
          float(habitat),
        );
      const actual = blend(candidate),
        baseline = blend(grass);
      const mix = THREE.MathUtils.lerp;
      const expected = compressed.map((g, i) => {
        const d = vectorValue(dirt.albedo)[i],
          r = vectorValue(rock.albedo)[i];
        return mix(
          mix(
            mix(
              mix(mix(mix(g, d, soil), mix(d, r, 0.85), talus), d, wear),
              d,
              habitat,
            ),
            r,
            cliff,
          ),
          d,
          road,
        );
      });
      vectorValue(actual.albedo).forEach((value, i) =>
        expect(value).toBeCloseTo(expected[i], 13),
      );
      for (const key of ["roughness", "ao"] as const)
        expect(vectorValue(actual[key])).toEqual(vectorValue(baseline[key]));
      for (const root of [actual.normal, actual.roughness, actual.ao])
        expect(graph(root).has(candidate.albedo)).toBe(false);
      if (
        soil === 1 ||
        wear === 1 ||
        habitat === 1 ||
        cliff === 1 ||
        road === 1
      )
        // Numeric TSL mix uses a + (b-a)*t; t=1 can retain tiny
        // cancellation differences for distinct incoming grass albedos.
        vectorValue(actual.albedo).forEach((value, channel) =>
          expect(value).toBeCloseTo(vectorValue(baseline.albedo)[channel], 14),
        );
    }
  });

  it("keeps accepted grass color grading separate from physical channels in actual owned layer graphs", () => {
    const owner = new CompactTerrainTextureSet("https://assets.invalid");
    const before = owner.getReceipt();
    const layers = createCompactTerrainLayers(owner, float(0), float(0.137));
    const candidate = createCompactTerrainLayers(owner, float(0), float(0.137));
    candidate.grass = applyCompactFineGrassSubstrateContrast(
      candidate.grass,
      "fine-meadow-green-v1",
    );
    candidate.grass = applyCompactGrassColorGrade(
      candidate.grass,
      "fine-meadow-green-v1",
    );
    // Compare semantic graphs, not incidental UUIDs of separately constructed
    // arithmetic nodes. Actual texture identities and all numeric inputs stay
    // in the fingerprint, so changing a map or its projection is not ignored.
    const fingerprint = (root: Node): string => {
      const cache = new Map<Node, string>();
      const visit = (node: Node): string => {
        const found = cache.get(node);
        if (found) return found;
        const value: unknown = Reflect.get(node, "value");
        const attributes = Object.fromEntries(
          ["op", "method", "components", "scope", "nodeType", "name"].map(
            (key) => [key, Reflect.get(node, key)],
          ),
        );
        const result = createHash("sha256")
          .update(
            JSON.stringify({
              type: node.type,
              ...attributes,
              value:
                value instanceof THREE.Texture
                  ? value.uuid
                  : value instanceof THREE.Matrix4
                    ? value.toArray()
                    : value instanceof THREE.Vector2 ||
                        value instanceof THREE.Vector3 ||
                        value instanceof THREE.Vector4
                      ? value.toArray()
                      : typeof value === "number"
                        ? value
                        : undefined,
              children: [...node.getChildren()].map(visit),
            }),
          )
          .digest("hex");
        cache.set(node, result);
        return result;
      };
      return visit(root);
    };
    try {
      for (const layer of ["grass", "dirt", "rock"] as const)
        for (const channel of [
          "albedo",
          "roughness",
          "ao",
          "worldNormal",
        ] as const) {
          const changed = layer === "grass" && channel === "albedo";
          expect(
            fingerprint(candidate[layer][channel]) ===
              fingerprint(layers[layer][channel]),
          ).toBe(!changed);
        }
      const strength = [...graph(candidate.grass.worldNormal)].filter(
        (node) =>
          Reflect.get(node, "name") === "fineGrassSubstrateNormalStrength",
      );
      expect(strength).toHaveLength(0);
      const grassNormalTexture = owner.getNode("grass", "normal-ao").value;
      const projectedNormals = [...graph(candidate.grass.worldNormal)].filter(
        (node) =>
          Reflect.get(node, "method") === "normalize" &&
          [...graph(node)].filter(
            (input) =>
              Reflect.get(input, "value") === grassNormalTexture &&
              Reflect.get(input, "uvNode"),
          ).length === 1,
      );
      expect(projectedNormals).toHaveLength(2);
      expect(owner.getReceipt()).toEqual(before);
      for (const invalid of [null, false, {}, "fine-meadow-green-v2"])
        expect(() =>
          applyCompactGrassColorGrade(
            candidate.grass,
            invalid as CompactGrassColorGrade,
          ),
        ).toThrow(/grass color grade/);
    } finally {
      owner.dispose();
    }
  });

  it("evaluates actual sampled normal graphs against independent rotated frames and unchanged distance fade", () => {
    const owner = new CompactTerrainTextureSet("https://assets.invalid");
    const noise = 0.137;
    const smooth = (a: number, b: number, value: number) => {
      const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    // Explicit fragment inputs for actual arithmetic nodes, not a renderer or
    // texture-filter emulation. Projection derivatives are evaluated from the
    // real linear UV graph under this known world differential basis.
    const evaluate = (root: Node, encoded: readonly number[]) => {
      const inputs = new Map<Node, readonly number[]>([
        [positionWorld, [350, 28, 320]],
        [normalWorldGeometry, [0, 1, 0]],
        [cameraViewMatrix, new THREE.Matrix4().toArray()],
      ]);
      for (const node of graph(root)) {
        const method: unknown = Reflect.get(node, "method");
        if (method === "dFdx" || method === "dFdy") {
          const operand: unknown = Reflect.get(node, "aNode");
          if (!(operand instanceof THREE.Node))
            throw new Error("Missing derivative operand");
          const shifted = new Map(inputs);
          shifted.set(
            positionWorld,
            method === "dFdx" ? [351, 28, 320] : [350, 28, 319],
          );
          const a = vectorValue(operand, inputs),
            b = vectorValue(operand, shifted);
          inputs.set(
            node,
            b.map((value, index) => value - a[index]),
          );
        }
        if (
          Reflect.get(node, "value") instanceof THREE.Texture &&
          Reflect.get(node, "uvNode")
        )
          inputs.set(node, [...encoded, 1]);
      }
      return new THREE.Vector3(
        ...(vectorValue(root, inputs) as [number, number, number]),
      );
    };
    const expectedGround = (encoded: readonly number[], strength: number) => {
      const index = Math.floor(noise * 32);
      const sample = (id: number) => {
        const angle = id * 2.399963229728653;
        const x = (encoded[0] * 2 - 1) * strength;
        const z = (encoded[1] * 2 - 1) * strength;
        return new THREE.Vector3(
          Math.cos(angle) * x + Math.sin(angle) * z,
          Math.max(0.001, encoded[2] * 2 - 1),
          -Math.sin(angle) * x + Math.cos(angle) * z,
        ).normalize();
      };
      return sample(index)
        .lerp(sample(index + 1), smooth(0.18, 0.82, noise * 32 - index))
        .normalize();
    };
    try {
      for (const distance of [0, 45, 80, 120, 145])
        for (const encoded of [
          [0.5, 0.5, 1],
          [0.75, 0.625, 1],
          [0.2, 0.8, 0.9],
        ]) {
          const fade = 1 - smooth(45 ** 2, 120 ** 2, distance ** 2);
          const baseline = createCompactTerrainLayers(
            owner,
            float(distance ** 2),
            float(noise),
          );
          const candidate = createCompactTerrainLayers(
            owner,
            float(distance ** 2),
            float(noise),
          );
          candidate.grass = applyCompactGrassColorGrade(
            candidate.grass,
            "fine-meadow-green-v1",
          );
          const grass = evaluate(candidate.grass.worldNormal, encoded);
          expect(grass.distanceTo(expectedGround(encoded, fade))).toBeLessThan(
            1e-10,
          );
          expect(
            evaluate(baseline.grass.worldNormal, encoded).distanceTo(
              expectedGround(encoded, fade),
            ),
          ).toBeLessThan(1e-10);
          for (const layers of [baseline, candidate]) {
            expect(
              evaluate(layers.dirt.worldNormal, encoded).distanceTo(
                expectedGround(encoded, 0.25 * fade),
              ),
            ).toBeLessThan(1e-10);
            const rock = expectedGround(encoded, 0.4 * fade);
            expect(
              evaluate(layers.rock.worldNormal, encoded).distanceTo(rock),
            ).toBeLessThan(1e-10);
          }
          expect(grass.length()).toBeCloseTo(1, 12);
          expect(grass.toArray().every(Number.isFinite)).toBe(true);
          for (const [dirt, cliff, road] of [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]) {
            const before = blendCompactTerrainLayers(
              baseline,
              float(dirt),
              float(cliff),
              float(road),
            );
            const after = blendCompactTerrainLayers(
              candidate,
              float(dirt),
              float(cliff),
              float(road),
            );
            expect(
              evaluate(before.normal, encoded).distanceTo(
                evaluate(after.normal, encoded),
              ),
            ).toBeLessThan(1e-12);
          }
        }
    } finally {
      owner.dispose();
    }
  });

  it("retains the original normal strengths without the rejected override and admits explicit dual-rock sampling", () => {
    const common = {
      compactPbr: true,
      compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
    };
    const ordinary = createTerrainMaterial(undefined, common);
    const candidate = createTerrainMaterial(undefined, {
      ...common,
      compactGrassColorGrade: "fine-meadow-green-v1",
    });
    try {
      const strength = [...graph(candidate.normalNode!)].filter(
        (node) =>
          Reflect.get(node, "name") === "fineGrassSubstrateNormalStrength",
      );
      expect(strength).toHaveLength(0);
      expect(
        [...graph(ordinary.normalNode!)].some(
          (node) =>
            Reflect.get(node, "name") === "fineGrassSubstrateNormalStrength",
        ),
      ).toBe(false);
      for (const material of [ordinary, candidate]) {
        expect(material.positionNode).toBeNull();
        expect(material.displacementMap).toBeNull();
        expect(material.transparent).toBe(false);
        expect(material.depthWrite).toBe(true);
        const receipt = material.compactTerrainSurface!.getReceipt();
        expect(receipt.surfaceSampleCount).toBe(20);
        expect(receipt.textures).toHaveLength(6);
        const owned = new Set(
          receipt.textures.map((entry) => entry.textureUuid),
        );
        const samples = new Set<Node>();
        for (const root of [
          material.colorNode!,
          material.normalNode!,
          material.roughnessNode!,
          material.aoNode!,
        ])
          for (const node of graph(root)) {
            const value: unknown = Reflect.get(node, "value");
            if (
              value instanceof THREE.Texture &&
              owned.has(value.uuid) &&
              Reflect.get(node, "uvNode")
            )
              samples.add(node);
          }
        expect(samples.size).toBe(20);
        expect(
          [...samples].filter((node) => Reflect.get(node, "gradNode")),
        ).toHaveLength(20);
      }
    } finally {
      ordinary.dispose();
      candidate.dispose();
    }
  });

  it("routes actual raw grass samples through contrast before optional meadow tint and grade", () => {
    const ops = createCompactTerrainColorOperations();
    const mean = ops.getPalette().grass;
    const ordinary = createTerrainMaterial(undefined, { compactPbr: true });
    const candidate = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactGrassColorGrade: "fine-meadow-green-v1",
    });
    try {
      const colorNodes = graph(candidate.colorNode!);
      const named = (name: string): Node => {
        const nodes = [...colorNodes].filter(
          (node) => Reflect.get(node, "name") === name,
        );
        expect(nodes).toHaveLength(1);
        return nodes[0];
      };
      const contrast = named("fineGrassSubstrateContrast");
      const substrate = named("fineGrassSubstrateAlbedo");
      const graded = named("compactGrassGradedAlbedo");
      expect(vectorValue(contrast)).toEqual([0.35]);
      expect(graph(graded).has(substrate)).toBe(true);
      expect(graph(substrate).has(graded)).toBe(false);
      for (const root of [
        ordinary.colorNode!,
        candidate.normalNode!,
        candidate.roughnessNode!,
        candidate.aoNode!,
      ])
        for (const node of graph(root))
          expect([
            "fineGrassSubstrateContrast",
            "fineGrassSubstrateAlbedo",
          ]).not.toContain(Reflect.get(node, "name"));
      const textureSet = candidate.compactTerrainSurface!;
      const source = textureSet.getNode("grass", "albedo-roughness").value;
      const samples = [...graph(substrate)].filter(
        (node) =>
          Reflect.get(node, "value") === source && Reflect.get(node, "uvNode"),
      );
      expect(samples).toHaveLength(2);
      for (const node of samples)
        expect(Reflect.get(node, "gradNode")).toBeTruthy();
      for (const noise of [0.1, 0.51, 0.9]) {
        // Supply explicit sampled values to actual TSL nodes. This checks
        // composition order, not GPU filtering or a synthetic renderer.
        const inputs = new Map<Node, readonly number[]>();
        for (const node of graph(graded)) {
          if (!Reflect.get(node, "uvNode")) continue;
          if (Reflect.get(node, "value") === source)
            inputs.set(node, [...mean, 0.9]);
          if (Reflect.get(node, "value") === getNoiseTexture())
            inputs.set(node, [noise, 0, 0, 1]);
        }
        vectorValue(substrate, inputs).forEach((value, channel) =>
          expect(value).toBeCloseTo(mean[channel], 14),
        );
        const tint = ops.meadowTint(noise, 0);
        const expected = mean.map(
          (value, channel) => value * tint[channel] * [0.95, 1.3, 1.1][channel],
        );
        vectorValue(graded, inputs).forEach((value, channel) =>
          expect(value).toBeCloseTo(expected[channel], 14),
        );
      }
    } finally {
      ordinary.dispose();
      candidate.dispose();
    }
  });

  it("admits only the immutable opt-in grass grade without changing raw scan means", () => {
    const ops = createCompactTerrainColorOperations();
    const raw = ops.getPalette();
    const descriptor = ops.getGrassColorGrade();
    expect(descriptor).toEqual({
      id: "fine-meadow-green-v1",
      linearMultipliers: [0.95, 1.3, 1.1],
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.linearMultipliers)).toBe(true);
    expect(ops.grassColorGrade(undefined)).toBeUndefined();
    expect(ops.grassColorGrade(descriptor.id)).toBe(descriptor.id);
    for (const invalid of [
      null,
      false,
      "",
      "fine-meadow-green-v2",
      {},
      [descriptor.id],
    ]) {
      expect(() => ops.grassColorGrade(invalid)).toThrow(/grass color grade/);
      expect(() =>
        ops.sample({
          noiseValue: 0,
          distortNoise: 0,
          slope: 0,
          roadInfluence: 0,
          grassColorGrade: invalid as CompactGrassColorGrade,
        }),
      ).toThrow(/grass color grade/);
    }
    expect(ops.getPalette()).toEqual(raw);
    expect(raw.grass).toEqual([
      0.12687350988906373, 0.16117143469264922, 0.03425721790414253,
    ]);
    expect(() =>
      createTerrainMaterial(undefined, {
        compactGrassColorGrade: descriptor.id,
      }),
    ).toThrow(/compact PBR/);
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactGrassColorGrade: descriptor.id,
      compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
    });
    const ungraded = createTerrainMaterial(undefined, { compactPbr: true });
    try {
      expect(material.compactGrassColorGrade).toEqual(descriptor);
      expect(
        Object.getOwnPropertyDescriptor(material, "compactGrassColorGrade"),
      ).toMatchObject({
        writable: false,
        configurable: false,
        enumerable: true,
      });
      const gradedNodes = [...graph(material.colorNode!)].filter(
        (node) => Reflect.get(node, "name") === "compactGrassGradedAlbedo",
      );
      expect(gradedNodes).toHaveLength(1);
      for (const root of [
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ])
        expect(graph(root).has(gradedNodes[0])).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          ungraded,
          "compactGrassColorGrade",
        ),
      ).toBe(false);
    } finally {
      material.dispose();
      ungraded.dispose();
    }
  });

  it("grades grass before physical-layer mixing and preserves all nonalbedo owners", () => {
    const ops = createCompactTerrainColorOperations();
    const palette = ops.getPalette();
    const layer = (rgb: number[]): CompactTerrainLayer => ({
      albedo: vec3(...(rgb as [number, number, number])),
      roughness: float(0.85),
      ao: float(0.8),
      worldNormal: vec3(0, 1, 0),
    });
    const grass = layer(palette.grass),
      dirt = layer(palette.dirt),
      rock = layer(palette.rock);
    expect(applyCompactGrassColorGrade(grass, undefined)).toBe(grass);
    const factors = [0.95, 1.3, 1.1];
    for (const noiseValue of [0.1, 0.51, 0.9])
      for (const meadowNoise of [0, 0.51, 1])
        for (const slope of [0, 0.1, 1])
          for (const roadInfluence of [0, 0.5, 1]) {
            const input = {
              noiseValue,
              meadowNoise,
              slope,
              roadInfluence,
              distortNoise: 0.35,
              surface: { x: 350, z: 320, height: 28.4, pond: null },
            };
            const meanGrass = applyCompactFineGrassSubstrateContrast(
              grass,
              "fine-meadow-green-v1",
            );
            expect(vectorValue(meanGrass.albedo)).toEqual(palette.grass);
            const rawGrass = applyCompactMeadowTint(
              meanGrass,
              float(meadowNoise),
            );
            const graded = applyCompactGrassColorGrade(
              rawGrass,
              "fine-meadow-green-v1",
            );
            for (const key of ["roughness", "ao", "worldNormal"] as const)
              expect(graded[key]).toBe(rawGrass[key]);
            const weights = createCompactTerrainLayerWeights(
              float(noiseValue),
              float(slope),
              float(roadInfluence),
              float(0.35),
            );
            const surface = blendCompactTerrainLayers(
              { grass: graded, dirt, rock },
              weights.dirt,
              weights.cliff,
              weights.road,
            );
            const rgb = vectorValue(surface.albedo.mul(weights.variation));
            const cpu = ops.sample({
              ...input,
              grassColorGrade: "fine-meadow-green-v1",
            });
            for (const [i, key] of (["r", "g", "b"] as const).entries()) {
              expect(vectorValue(graded.albedo)[i]).toBeCloseTo(
                vectorValue(rawGrass.albedo)[i] * factors[i],
                14,
              );
              expect(rgb[i]).toBeCloseTo(cpu[key], 13);
            }
            const gradedInput = {
              ...input,
              grassColorGrade: "fine-meadow-green-v1" as const,
            };
            expect(ops.grassSupport(gradedInput)).toBe(ops.grassSupport(input));
            if (slope === 1 || roadInfluence === 1)
              expect(cpu).toEqual(ops.sample(input));
          }
    expect(vectorValue(grass.albedo)).toEqual(palette.grass);
  });

  it("keeps every actual grass scan texel bounded with the grade and every meadow-tint endpoint", async () => {
    const ops = createCompactTerrainColorOperations();
    const image = PNG.sync.read(
      await readFile(new URL("grass-albedo-roughness.png", assetDirectory)),
    );
    const tints = [
      [1, 1, 1],
      ...[0, 1].flatMap((noise) =>
        [0, 1].map((macro) => ops.meadowTint(noise, macro)),
      ),
    ];
    const maximum = [0, 0, 0];
    for (let p = 0; p < image.data.length; p += 4)
      for (let c = 0; c < 3; c++)
        maximum[c] = Math.max(maximum[c], image.data[p + c]);
    for (const tint of tints)
      for (let c = 0; c < 3; c++) {
        const srgb = maximum[c] / 255;
        const linear =
          srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        expect(
          linear * tint[c] * ops.getGrassColorGrade().linearMultipliers[c],
        ).toBeLessThan(1);
      }
  });

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

  it("retains strictly monotone dry turf roughness from every encoded alpha instead of flattening low values", async () => {
    const values: number[] = [];
    for (let alpha = 0; alpha <= 255; alpha++) {
      const value = vectorValue(
        createCompactDryGrassRoughness(float(alpha / 255)),
      )[0];
      expect(value).toBeCloseTo(0.85 + ((0.98 - 0.85) * alpha) / 255, 14);
      expect(value).toBeGreaterThanOrEqual(0.85);
      expect(value).toBeLessThanOrEqual(0.98);
      if (alpha > 0) expect(value).toBeGreaterThan(values[alpha - 1]);
      values.push(value);
    }
    // Real original map, no guessed roughness, fabricated texture or renderer.
    const bytes = await readFile(
      new URL("grass-albedo-roughness.png", assetDirectory),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedDigest("grass-albedo-roughness"),
    );
    const image = PNG.sync.read(bytes);
    let oldClipped = 0;
    const rawValues = new Set<number>();
    const dryValues = new Set<number>();
    for (let p = 3; p < image.data.length; p += 4) {
      const alpha = image.data[p];
      oldClipped += Number(alpha / 255 < 0.65);
      rawValues.add(alpha);
      dryValues.add(values[alpha]);
    }
    expect(oldClipped).toBe(1_048_367);
    expect(rawValues.size).toBeGreaterThan(100);
    expect(dryValues.size).toBe(rawValues.size);
  });

  it("connects dry turf to both actual grass projections only and preserves localized wet endpoints", () => {
    const owner = new CompactTerrainTextureSet(
      "https://assets.example.invalid",
    );
    try {
      const layers = createCompactTerrainLayers(owner, float(0));
      const dryNodes = [...graph(layers.grass.roughness)].filter((node) =>
        /^compactDryGrassRoughness[AB]$/.test(
          String(Reflect.get(node, "name")),
        ),
      );
      expect(dryNodes).toHaveLength(2);
      expect(dryNodes.map((node) => Reflect.get(node, "name")).sort()).toEqual([
        "compactDryGrassRoughnessA",
        "compactDryGrassRoughnessB",
      ]);
      const alphaTexture = owner.getNode("grass", "albedo-roughness").value;
      for (const dry of dryNodes) {
        const sampled = [...graph(dry)].filter(
          (node) => Reflect.get(node, "value") instanceof THREE.Texture,
        );
        expect(sampled.length).toBeGreaterThan(0);
        expect(
          sampled.every((node) => Reflect.get(node, "value") === alphaTexture),
        ).toBe(true);
      }
      for (const layer of ["dirt", "rock"] as const) {
        expect(
          [...graph(layers[layer].roughness)].some((node) =>
            /^compactDryGrassRoughness[AB]$/.test(
              String(Reflect.get(node, "name")),
            ),
          ),
        ).toBe(false);
        expect(
          [...graph(layers[layer].roughness)].some(
            (node) => Reflect.get(node, "method") === "max",
          ),
        ).toBe(true);
      }
      for (const key of ["albedo", "ao", "worldNormal"] as const)
        for (const layer of Object.values(layers))
          expect(
            [...graph(layer[key])].some((node) =>
              /^compactDryGrassRoughness[AB]$/.test(
                String(Reflect.get(node, "name")),
              ),
            ),
          ).toBe(false);

      // Actual numeric TSL composition, not GPU or shoreline-footprint proof.
      const layer = (roughness: Node<"float">): CompactTerrainLayer => ({
        albedo: vec3(0.2, 0.3, 0.1),
        roughness,
        ao: float(0.9),
        worldNormal: vec3(0, 1, 0),
      });
      for (const alpha of [0, 0.25, 0.5, 1]) {
        const dry = layer(createCompactDryGrassRoughness(float(alpha)));
        const expectedDry = 0.85 + (0.98 - 0.85) * alpha;
        const surface = blendCompactTerrainLayers(
          { grass: dry, dirt: layer(float(0.944)), rock: layer(float(0.82)) },
          float(0),
          float(0),
          float(0),
        );
        for (const wetness of [0, 0.25, 0.5, 1]) {
          const pond = applyCompactPondWetness(surface, float(wetness));
          expect(vectorValue(pond.roughness)[0]).toBeCloseTo(
            expectedDry + (0.62 - expectedDry) * wetness,
            14,
          );
          expect(pond.normal).toBe(surface.normal);
          expect(pond.ao).toBe(surface.ao);
          const coast = applyCompactCoastRock(layer(float(0.82)), dry, {
            soil: float(1),
            wetness: float(wetness),
          });
          expect(vectorValue(coast.roughness)[0]).toBeCloseTo(
            expectedDry + (0.58 - expectedDry) * wetness,
            14,
          );
        }
      }
    } finally {
      owner.dispose();
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

  // Real Three textures retain their construction-time default. Compact maps
  // must have identical quality before or after graphics initialization.
  it.each([1, 16])(
    "keeps all seven placeholder/admitted maps at16× when Three starts with %i× filtering",
    async (anisotropy) => {
      const previous = THREE.Texture.DEFAULT_ANISOTROPY;
      THREE.Texture.DEFAULT_ANISOTROPY = anisotropy;
      try {
        for (const dirtProjection of [undefined, "stochastic-v1"] as const) {
          const owner = new CompactTerrainTextureSet(
            "https://assets.example.invalid/game-assets",
            dirtProjection,
            "height-v1",
          );
          const entries = lifecycle(owner).entries;
          const checkFiltering = () => {
            const receipt = owner.getReceipt();
            expect(receipt.textures).toHaveLength(7);
            expect(receipt.surfaceSampleCount).toBe(dirtProjection ? 27 : 24);
            for (const row of receipt.textures) {
              const image = entries.get(row.key)!.node.value;
              expect(row.anisotropy).toBe(16);
              expect(image.anisotropy).toBe(16);
              expect(image.magFilter).toBe(THREE.LinearFilter);
              expect(image.minFilter).toBe(THREE.LinearMipmapLinearFilter);
              expect(image.generateMipmaps).toBe(true);
            }
          };
          try {
            expect(owner.getReceipt().status).toBe("idle");
            checkFiltering();
            for (const entry of entries.values()) {
              const projected = entry.node
                .grad(vec2(0.01, 0), vec2(0, 0.01))
                .sample(vec2(0.3, 0.4));
              // Actual packed PNG decode and production admission. Browser
              // bitmap upload/native sampler cost remain separate live gates.
              const decoded = await decodedTexture(entry.key);
              expect(decoded.anisotropy).toBe(anisotropy);
              entry.status = "loading";
              expect(
                lifecycle(owner).installTexture(
                  entry,
                  decoded,
                  entry.key === "ground-height"
                    ? COMPACT_TERRAIN_HEIGHT_SHA256["ground-height"]
                    : expectedDigest(entry.key),
                ),
              ).toBe(true);
              expect(projected.value).toBe(decoded);
              expect(projected.value.anisotropy).toBe(16);
            }
            expect(owner.getReceipt().status).toBe("ready");
            checkFiltering();
            const copied = owner.getReceipt();
            copied.textures[0].anisotropy = 2;
            expect(owner.getReceipt().textures[0].anisotropy).toBe(16);
            expect(THREE.Texture.DEFAULT_ANISOTROPY).toBe(anisotropy);
          } finally {
            owner.dispose();
          }
        }
      } finally {
        THREE.Texture.DEFAULT_ANISOTROPY = previous;
      }
      expect(THREE.Texture.DEFAULT_ANISOTROPY).toBe(previous);
    },
  );

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
    const plantingLobes = createCompactServiceSoil(
      DataManager.getWorldConfig()!.compactServicePlanting,
    );
    const material = createTerrainMaterial(shade, {
      compactPbr: true,
      compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
      compactPlantingLobes: plantingLobes,
      compactProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
    });
    const legacy = createTerrainMaterial();
    try {
      expect(material.terrainUniforms.shade).toBe(shade);
      expect(material.compactPlantingMaterial).toEqual(plantingLobes);
      expect(material.compactPlantingMaterial).not.toBe(plantingLobes);
      // Inspect real connected PBR graphs, not just the published descriptor.
      for (const root of [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ]) {
        const constants = new Set(
          [...graph(root)].map((node) => Reflect.get(node, "value")),
        );
        for (const lobe of plantingLobes) {
          expect(constants.has(lobe.centerX)).toBe(true);
          expect(constants.has(lobe.centerZ)).toBe(true);
        }
      }
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
      expect(samples.size).toBe(20);
      expect(
        [...samples].filter((node) => Reflect.get(node, "gradNode")).length,
      ).toBe(20);
      expect(methods.has("dFdx")).toBe(true);
      expect(methods.has("dFdy")).toBe(true);
      expect(COMPACT_TERRAIN_MATERIAL.surfaceSampleCount).toBe(20);
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

describe("lazy compact terrain diagnostics (actual graph, not native or GPU-cost approval)", () => {
  it("exposes the actual final composition sources without changing the ordinary material graph", () => {
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactSurfaceBlend: "height-v1",
      compactDirtProjection: "stochastic-v1",
      compactRockProjection: "stochastic-v1",
      compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
      compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
    });
    try {
      const roots = [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ];
      const originalGraphs = roots.map(graph);
      const originalOutput = material.outputNode;
      const originalToneMapped = material.toneMapped;
      const originalReceipt = material.compactTerrainSurface!.getReceipt();
      const originalVersion = material.version;
      const allNodes = new Set(originalGraphs.flatMap((nodes) => [...nodes]));
      expect(
        [...allNodes].some((node) =>
          String(Reflect.get(node, "name")).startsWith("compactDiagnostic"),
        ),
      ).toBe(false);

      const diagnostic = material.getCompactTerrainDiagnosticOutputs()!;
      expect(diagnostic.schemaVersion).toBe(1);
      expect(material.getCompactTerrainDiagnosticOutputs()).toBe(diagnostic);
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(Object.isFrozen(diagnostic.sources)).toBe(true);
      expect(Reflect.get(diagnostic.layerWeights, "name")).toBe(
        "compactDiagnosticMaterialCoverage",
      );
      expect(Reflect.get(diagnostic.causes, "name")).toBe(
        "compactDiagnosticPondCauses",
      );
      const { sources } = diagnostic;
      for (const source of Object.values(sources))
        expect(allNodes.has(source)).toBe(true);
      // Identity, not equivalent recreated expressions: the same final weight
      // vector drives every physical surface channel before debug is requested.
      for (const nodes of originalGraphs) {
        expect(nodes.has(sources.weights)).toBe(true);
        expect(nodes.has(sources.effectiveCliff)).toBe(true);
        expect(nodes.has(sources.coastSoil)).toBe(true);
      }
      expect(graph(sources.effectiveCliff).has(sources.geometricCliff)).toBe(
        true,
      );
      expect(graph(sources.effectiveCliff).has(sources.pondSoil)).toBe(true);
      expect(graph(diagnostic.layerWeights).has(sources.weights)).toBe(true);
      expect(graph(diagnostic.layerWeights).has(sources.coastSoil)).toBe(true);
      for (const source of [
        sources.pondSoil,
        sources.pondWetness,
        sources.geometricCliff,
      ])
        expect(graph(diagnostic.causes).has(source)).toBe(true);

      // Requesting outputs does not install them, invalidate the material, or
      // add texture work to any ordinary PBR root. Only the native harness may
      // temporarily lease outputNode; these graph checks are not a GPU render.
      expect(material.outputNode).toBe(originalOutput);
      expect(material.toneMapped).toBe(originalToneMapped);
      expect(material.version).toBe(originalVersion);
      expect([
        material.colorNode,
        material.normalNode,
        material.roughnessNode,
        material.aoNode,
      ]).toEqual(roots);
      roots.forEach((root, i) =>
        expect(graph(root)).toEqual(originalGraphs[i]),
      );
      expect(material.compactTerrainSurface!.getReceipt()).toEqual(
        originalReceipt,
      );
      for (const output of [diagnostic.layerWeights, diagnostic.causes])
        for (const node of graph(output))
          if (Reflect.get(node, "value") instanceof THREE.Texture)
            expect(allNodes.has(node)).toBe(true);

      // Evaluate the actual published diagnostic output at supplied values for
      // its actual source nodes. This checks channel encoding, not GPU pixels.
      for (const weights of [
        [1, 0, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [0.17, 0.23, 0.41, 0.19],
      ]) {
        for (const coastSoil of [0, 0.37, 1]) {
          const values = new Map<Node, readonly number[]>([
            [sources.weights, weights],
            [sources.coastSoil, [coastSoil]],
            [sources.pondSoil, [0.31]],
            [sources.pondWetness, [0.67]],
            [sources.geometricCliff, [0.83]],
          ]);
          const coverage = vectorValue(diagnostic.layerWeights, values);
          expect(coverage[0]).toBeCloseTo(weights[2] * (1 - coastSoil), 12);
          expect(coverage[1]).toBeCloseTo(weights[0], 12);
          expect(coverage[2]).toBeCloseTo(
            weights[1] + weights[3] + weights[2] * coastSoil,
            12,
          );
          expect(coverage.slice(0, 3).reduce((a, b) => a + b, 0)).toBeCloseTo(
            1,
            12,
          );
          expect(coverage[3]).toBe(1);
          expect(vectorValue(diagnostic.causes, values)).toEqual([
            0.31, 0.67, 0.83, 1,
          ]);
        }
      }
    } finally {
      material.dispose();
    }
    expect(material.getCompactTerrainDiagnosticOutputs()).toBeNull();
  });

  it("reports actual soil inside the rock material as soil, matching the physical color composition", () => {
    const layer = (
      color: [number, number, number],
      height?: number,
    ): CompactTerrainLayer => ({
      albedo: vec3(...color),
      roughness: float(0.8),
      ao: float(1),
      worldNormal: vec3(0, 1, 0),
      ...(height === undefined ? {} : { height: float(height) }),
    });
    for (const [soil, cliff, road, coastCoverage, coastSoil] of [
      [0.2, 0.4, 0.1, 0.3, 0.37],
      [0.8, 0.7, 0, 0.2, 0.6],
      [0.5, 1, 0, 0.5, 1],
      [0.5, 1, 1, 0.5, 0.37],
      [0, 0, 0, 0, 0],
    ]) {
      const coast = { soil: float(coastSoil), wetness: float(0) };
      const grass = layer([0, 1, 0], 0.23);
      const dirt = layer([0, 0, 1], 0.72);
      const rock = applyCompactCoastRock(layer([1, 0, 0]), dirt, coast);
      const surface = blendCompactTerrainLayers(
        { grass, dirt, rock },
        float(soil),
        float(cliff),
        float(road),
        undefined,
        undefined,
        {
          coverage: float(coastCoverage),
          layer: applyCompactCoastRock(dirt, dirt, coast),
        },
      );
      const outputs = createCompactTerrainDiagnosticOutputs({
        weights: surface.weights!,
        coastSoil: coast.soil,
        pondSoil: float(0),
        pondWetness: float(0),
        geometricCliff: float(cliff),
        effectiveCliff: float(cliff),
      });
      const physicalColor = vectorValue(surface.albedo);
      const coverage = vectorValue(outputs.layerWeights);
      physicalColor.forEach((value, i) =>
        expect(coverage[i]).toBeCloseTo(value, 12),
      );
      expect(coverage[3]).toBe(1);
    }
  });

  it("keeps diagnostics material-local, returns null for unavailable graphs, and cannot recreate after disposal", () => {
    const legacy = createTerrainMaterial();
    const linear = createTerrainMaterial(undefined, { compactPbr: true });
    const createHeight = () =>
      createTerrainMaterial(undefined, {
        compactPbr: true,
        compactSurfaceBlend: "height-v1",
      });
    const first = createHeight();
    const second = createHeight();
    const neverRequested = createHeight();
    try {
      for (const material of [legacy, linear]) {
        const output = material.outputNode;
        const version = material.version;
        expect(material.getCompactTerrainDiagnosticOutputs()).toBeNull();
        expect(material.getCompactTerrainDiagnosticOutputs()).toBeNull();
        expect(material.outputNode).toBe(output);
        expect(material.version).toBe(version);
      }
      const a = first.getCompactTerrainDiagnosticOutputs()!;
      const b = second.getCompactTerrainDiagnosticOutputs()!;
      expect(a).not.toBe(b);
      expect(a.layerWeights).not.toBe(b.layerWeights);
      expect(a.causes).not.toBe(b.causes);
      expect(a.sources.weights).not.toBe(b.sources.weights);
      expect(vectorValue(a.sources.coastSoil)).toEqual([0]);
      expect(
        vectorValue(a.causes, new Map([[a.sources.geometricCliff, [0.6]]])),
      ).toEqual([0, 0, 0.6, 1]);
      first.dispose();
      expect(first.getCompactTerrainDiagnosticOutputs()).toBeNull();
      expect(second.getCompactTerrainDiagnosticOutputs()).toBe(b);
      neverRequested.dispose();
      expect(neverRequested.getCompactTerrainDiagnosticOutputs()).toBeNull();
    } finally {
      legacy.dispose();
      linear.dispose();
      first.dispose();
      second.dispose();
      neverRequested.dispose();
    }
  });
});

describe("height-only dry pond-bank sediment (actual graph, not native approval)", () => {
  const smooth = (start: number, end: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  };

  it("reuses the pond domain with bounded dry height and slope fades without changing soil or wetness", () => {
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    const parameters = vec4(
      pond.centerX,
      pond.centerZ,
      pond.radius,
      pond.surfaceY,
    );
    const ops = createCompactTerrainColorOperations();
    for (const distance of [0, 9.5, 10, 10.5, 11])
      for (const height of [0, 0.16, 0.33089490244919, 0.6, 0.84])
        for (const noise of [0, 0.5, 1]) {
          const input = {
            x: pond.centerX + distance,
            z: pond.centerZ,
            height: pond.surfaceY + height,
            pond,
            noiseValue: noise,
          };
          const surface = createCompactPondSurfaceWeights(
            vec3(input.x, input.height, input.z),
            float(noise),
            parameters,
          );
          const before = [
            vectorValue(surface.soil)[0],
            vectorValue(surface.wetness)[0],
          ];
          const cpu = ops.pondWeights(input);
          expect(before[0]).toBeCloseTo(cpu.soil, 12);
          expect(before[1]).toBeCloseTo(cpu.wetness, 12);
          const region =
            1 - smooth(pond.radius + 2.25, pond.radius + 3, distance);
          const localHeight = height - (noise - 0.5) * 0.12;
          for (const slope of [0, 0.2, 0.3, 0.4, 0.8]) {
            const sediment = createCompactPondBankSediment(
              surface.domain,
              float(slope),
            );
            const value = vectorValue(sediment)[0];
            const expected =
              region *
              smooth(0.1, 0.22, localHeight) *
              (1 - smooth(0.42, 0.78, localHeight)) *
              (1 - smooth(0.2, 0.4, slope));
            expect(value).toBeCloseTo(expected, 12);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            if (distance >= pond.radius + 3 || slope >= 0.4 || height <= 0)
              expect(value).toBe(0);
            if (height === 0.33089490244919 && distance <= 9.5 && slope <= 0.2)
              expect(value).toBe(1);
            for (const source of Object.values(surface.domain))
              expect(graph(sediment).has(source)).toBe(true);
            // Material coverage never feeds back into the ecological mask or
            // wetness. Both retain exactly their original node graph/values.
            expect(graph(surface.soil).has(sediment)).toBe(false);
            expect(graph(surface.wetness).has(sediment)).toBe(false);
            expect([
              vectorValue(surface.soil)[0],
              vectorValue(surface.wetness)[0],
            ]).toEqual(before);
          }
          expect(graph(surface.soil).has(surface.domain.region)).toBe(true);
          expect(graph(surface.wetness).has(surface.domain.region)).toBe(true);
          expect(graph(surface.soil).has(surface.domain.noiseHeight)).toBe(
            true,
          );
        }
  });

  it("transfers only final rock to dry soil after height competition with one shared weight vector for every PBR channel", () => {
    const layer = (
      color: [number, number, number],
      roughness: number,
      ao: number,
      normal: [number, number, number],
      height?: number,
    ): CompactTerrainLayer => ({
      albedo: vec3(...color),
      roughness: float(roughness),
      ao: float(ao),
      worldNormal: vec3(...normal),
      ...(height === undefined ? {} : { height: float(height) }),
    });
    const layers = {
      grass: layer([0.11, 0.27, 0.08], 0.92, 0.8, [0, 1, 0], 0.19),
      dirt: layer([0.32, 0.19, 0.09], 0.84, 0.91, [0.6, 0.8, 0], 0.81),
      rock: layer([0.48, 0.43, 0.37], 0.73, 0.72, [0, 0.8, 0.6]),
    };
    const coast = layer([0.2, 0.12, 0.06], 0.67, 0.86, [-0.6, 0.8, 0]);
    const view = new Map<Node, readonly number[]>([
      [cameraViewMatrix, new THREE.Matrix4().toArray()],
    ]);
    for (const [dirt, cliff, road, wetSoil] of [
      [0, 0, 0, 0],
      [0.23, 0.49, 0.12, 0.19],
      [0.81, 0.2, 0, 0.31],
      [0.17, 1, 0, 0],
      [0.5, 1, 1, 0.5],
    ]) {
      const resolve = (sediment?: Node<"float">) =>
        blendCompactTerrainLayers(
          layers,
          float(dirt),
          float(cliff),
          float(road),
          { talus: float(0.13), wear: float(0.09) },
          float(0.11),
          { coverage: float(wetSoil), layer: coast },
          float(0.07),
          sediment,
        );
      const baseline = resolve();
      const before = vectorValue(baseline.weights!);
      for (const amount of [-0.2, 0, 0.37, 1, 1.2]) {
        const sediment = float(amount).toVar("testedPondSediment");
        const surface = resolve(sediment);
        const weights = vectorValue(surface.weights!);
        const transfer = before[2] * Math.max(0, Math.min(1, amount));
        expect(weights[0]).toBe(before[0]);
        expect(weights[3]).toBe(before[3]);
        expect(weights[1]).toBeCloseTo(before[1] + transfer, 12);
        expect(weights[2]).toBeCloseTo(before[2] - transfer, 12);
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        weights.forEach((weight) => expect(weight).toBeGreaterThanOrEqual(0));
        if (amount <= 0) expect(weights).toEqual(before);
        if (road === 1) expect(weights).toEqual([0, 1, 0, 0]);
        for (const channel of [
          surface.albedo,
          surface.roughness,
          surface.ao,
          surface.normal,
        ]) {
          expect(graph(channel).has(surface.weights!)).toBe(true);
          expect(graph(channel).has(sediment)).toBe(true);
          expect(
            [...graph(channel)].filter(
              (node) =>
                Reflect.get(node, "name") === "compactHeightSurfaceWeights",
            ),
          ).toHaveLength(1);
        }
        const layerOrder = [layers.grass, layers.dirt, layers.rock, coast];
        for (const property of ["albedo", "roughness", "ao"] as const) {
          const expected = vectorValue(layerOrder[0][property]).map(
            (_, channel) =>
              layerOrder.reduce(
                (sum, layer, i) =>
                  sum + vectorValue(layer[property])[channel] * weights[i],
                0,
              ),
          );
          vectorValue(surface[property]).forEach((value, i) =>
            expect(value).toBeCloseTo(expected[i], 12),
          );
        }
        const normal = new THREE.Vector3();
        layerOrder.forEach((layer, i) =>
          normal.addScaledVector(
            new THREE.Vector3(
              ...(vectorValue(layer.worldNormal) as [number, number, number]),
            ),
            weights[i],
          ),
        );
        normal.normalize();
        vectorValue(surface.normal, view).forEach((value, i) =>
          expect(value).toBeCloseTo(normal.toArray()[i], 12),
        );
      }
    }
  });

  it("admits only an actual pond on height-v1 and adds no maps, geometry or wetness override", () => {
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    for (const height of [false, true])
      for (const hasPond of [false, true]) {
        const material = createTerrainMaterial(undefined, {
          compactPbr: true,
          compactSurfaceBlend: height ? "height-v1" : undefined,
          compactDirtProjection: "stochastic-v1",
          compactRockProjection: "stochastic-v1",
          compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
          compactPond: hasPond ? pond : undefined,
        });
        try {
          const roots = [
            material.colorNode!,
            material.normalNode!,
            material.roughnessNode!,
            material.aoNode!,
          ];
          const nodes = new Set(roots.flatMap((root) => [...graph(root)]));
          const sediment = [...nodes].filter(
            (node) => Reflect.get(node, "name") === "compactPondDrySediment",
          );
          const finalWeights = [...nodes].filter(
            (node) =>
              Reflect.get(node, "name") === "compactPondSedimentSurfaceWeights",
          );
          expect(sediment).toHaveLength(height && hasPond ? 1 : 0);
          expect(finalWeights).toHaveLength(height && hasPond ? 1 : 0);
          if (height && hasPond) {
            const diagnostic = material.getCompactTerrainDiagnosticOutputs()!;
            expect(diagnostic.sources.weights).toBe(finalWeights[0]);
            for (const root of roots)
              expect(graph(root).has(finalWeights[0])).toBe(true);
            expect(graph(diagnostic.sources.pondSoil).has(sediment[0])).toBe(
              false,
            );
            expect(graph(diagnostic.sources.pondWetness).has(sediment[0])).toBe(
              false,
            );
          }
          const receipt = material.compactTerrainSurface!.getReceipt();
          expect(receipt.textures).toHaveLength(height ? 7 : 6);
          expect(receipt.surfaceSampleCount).toBe(height ? 33 : 28);
          const owned = new Set(
            receipt.textures.map((entry) => entry.textureUuid),
          );
          expect(
            [...nodes].filter((node) => {
              const value: unknown = Reflect.get(node, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(node, "uvNode")
              );
            }),
          ).toHaveLength(height ? 33 : 28);
          expect(material.positionNode).toBeNull();
          expect(material.displacementMap).toBeNull();
        } finally {
          material.dispose();
        }
      }
    // Even a caller supplying the new optional node cannot affect the linear
    // branch: without admitted source heights it remains entirely disconnected.
    const layer = (): CompactTerrainLayer => ({
      albedo: vec3(0.2, 0.3, 0.4),
      roughness: float(0.8),
      ao: float(0.9),
      worldNormal: vec3(0, 1, 0),
    });
    const ignored = float(1).toVar("ignoredLinearSediment");
    const linear = blendCompactTerrainLayers(
      { grass: layer(), dirt: layer(), rock: layer() },
      float(0.2),
      float(0.3),
      float(0.4),
      undefined,
      undefined,
      undefined,
      undefined,
      ignored,
    );
    expect(linear.weights).toBeUndefined();
    for (const channel of [
      linear.albedo,
      linear.roughness,
      linear.ao,
      linear.normal,
    ])
      expect(graph(channel).has(ignored)).toBe(false);
  });
});

describe("opt-in pond relief candidate (actual TSL graph, not native approval)", () => {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const grassMean = 0.34206187678318395;
  const soilMean = 0.41093718958835973;
  const coverage = (share: number, grass: number, soil: number) => {
    const c = clamp(share);
    const ratio =
      2 ** (12 * (clamp(soil) - soilMean - (clamp(grass) - grassMean)));
    return (c * ratio) / (1 - c + c * ratio);
  };
  const sample = (share: number, grass: number, soil: number) =>
    vectorValue(
      createCompactPondReliefSoilCoverage(
        float(share),
        float(grass),
        float(soil),
      ),
    )[0];

  it("pins relief centering to the actual unchanged packed height bytes", async () => {
    const bytes = await readFile(
      new URL(
        "../../../../../../server/world/assets/terrain/textures/compact-pbr/ground-height.png",
        import.meta.url,
      ),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(digest).toBe(COMPACT_TERRAIN_HEIGHT_SHA256["ground-height"]);
    expect(COMPACT_TERRAIN_POND_RELIEF.heightSha256).toBe(digest);
    expect(COMPACT_TERRAIN_POND_RELIEF.heightLog2Gain).toBe(12);
    const png = PNG.sync.read(bytes);
    expect([png.width, png.height]).toEqual([1024, 1024]);
    const sums = [0, 0];
    for (let offset = 0; offset < png.data.length; offset += 4) {
      sums[0] += png.data[offset];
      sums[1] += png.data[offset + 1];
    }
    const means = sums.map((sum) => sum / (png.width * png.height * 255));
    expect(means[0]).toBeCloseTo(grassMean, 14);
    expect(means[1]).toBeCloseTo(soilMean, 14);
    expect(COMPACT_TERRAIN_POND_RELIEF.grassHeightMean).toBe(grassMean);
    expect(COMPACT_TERRAIN_POND_RELIEF.soilHeightMean).toBe(soilMean);
    expect(Object.isFrozen(COMPACT_TERRAIN_POND_RELIEF)).toBe(true);
  });

  it("evaluates the actual relief graph with bounded finite coverage and exact pure endpoints", () => {
    for (const grass of [-100, 0, grassMean, 0.5, 1, 100])
      for (const soil of [-100, 0, soilMean, 0.5, 1, 100])
        for (const c of [-10, 0, 1e-8, 0.1, 0.5, 0.9, 1 - 1e-8, 1, 10]) {
          const actual = sample(c, grass, soil);
          expect(Number.isFinite(actual)).toBe(true);
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThanOrEqual(1);
          expect(actual).toBeCloseTo(coverage(c, grass, soil), 13);
          if (c <= 0 || c >= 1) expect(actual).toBe(clamp(c));
          else {
            expect(actual).toBeGreaterThan(0);
            expect(actual).toBeLessThan(1);
          }
        }
    const nodes = graph(
      createCompactPondReliefSoilCoverage(float(0.37), float(0.25), float(0.7)),
    );
    expect(
      [...nodes].some((node) => Reflect.get(node, "method") === "exp2"),
    ).toBe(true);
    expect([...nodes].some((node) => node.type.includes("Texture"))).toBe(
      false,
    );
  });

  it("is monotone and preserves current coverage at centered coarse relief without replacing generic height-v1", () => {
    for (const [grass, soil] of [
      [0, 1],
      [1, 0],
      [grassMean, soilMean],
      [0.2, 0.7],
      [0.8, 0.3],
    ]) {
      let previous = -1;
      for (let step = 0; step <= 100; step++) {
        const c = step / 100;
        const actual = sample(c, grass, soil);
        expect(actual).toBeGreaterThanOrEqual(previous);
        if (grass === grassMean && soil === soilMean)
          expect(actual).toBeCloseTo(c, 14);
        previous = actual;
      }
    }
    for (const c of [0, 0.001, 0.17, 0.5, 0.83, 0.999, 1]) {
      for (const offset of [-0.3, -0.1, 0, 0.2, 0.5])
        expect(sample(c, grassMean + offset, soilMean + offset)).toBeCloseTo(
          c,
          14,
        );
      let lastSoil = -1;
      let lastGrass = 2;
      for (let step = 0; step <= 20; step++) {
        const soil = sample(c, grassMean, step / 20);
        const grass = sample(c, step / 20, soilMean);
        expect(soil).toBeGreaterThanOrEqual(lastSoil);
        expect(grass).toBeLessThanOrEqual(lastGrass);
        lastSoil = soil;
        lastGrass = grass;
      }
      expect(
        vectorValue(
          createCompactHeightSoilCoverage(float(c), float(0.4), float(0.6)),
        )[0],
      ).toBeCloseTo((3.4 * c) / (2.6 * (1 - c) + 3.4 * c), 14);
    }
    // Equal raw heights are not equal centered relief for these two scans.
    expect(sample(0.5, 0.5, 0.5)).toBeLessThan(0.5);
    expect(sample(0.5, grassMean - 0.1, soilMean + 0.1)).toBeGreaterThan(0.8);
    expect(sample(0.5, grassMean + 0.1, soilMean - 0.1)).toBeLessThan(0.2);
  });

  it("conserves current grass/dry-soil weight and exactly protects rock, coastal soil, roads and absent/full pond masks", () => {
    for (const before of [
      [0.23, 0.31, 0.19, 0.27],
      [0.6, 0.4, 0, 0],
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [0, 0, 0, 0],
      [1e-15, 2e-15, 0.4, 0.6 - 3e-15],
    ])
      for (const [grass, soil] of [
        [0, 1],
        [1, 0],
        [grassMean, soilMean],
      ])
        for (const [pond, road, coast] of [
          [0.5, 0, 0],
          [0.17, 0.23, 0.31],
          [0, 0, 0],
          [1, 0, 0],
          [-100, 0, 0],
          [100, 0, 0],
          [0.5, 1, 0],
          [0.5, 0, 1],
          [0.5, 100, 0],
          [0.5, 0, 100],
        ]) {
          const weights = vec4(...(before as [number, number, number, number]));
          const result = applyCompactPondReliefWeights(
            weights,
            float(grass),
            float(soil),
            float(pond),
            float(road),
            float(coast),
          );
          const after = vectorValue(result);
          expect(graph(result).has(weights)).toBe(true);
          after.forEach((value) => {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(-1e-15);
            expect(value).toBeLessThanOrEqual(1);
          });
          expect(after[2]).toBe(before[2]);
          expect(after[3]).toBe(before[3]);
          expect(after[0] + after[1]).toBeCloseTo(before[0] + before[1], 14);
          const p = clamp(pond);
          const locality =
            4 * p * (1 - p) * (1 - clamp(road)) * (1 - clamp(coast));
          if (locality === 0 || (grass === grassMean && soil === soilMean))
            expect(after).toEqual(before);
          const total = before[0] + before[1];
          if (total > 0) {
            const current = before[1] / total;
            const shift =
              total * locality * (coverage(current, grass, soil) - current);
            expect(after[0]).toBeCloseTo(before[0] - shift, 13);
            expect(after[1]).toBeCloseTo(before[1] + shift, 13);
          }
        }
  });

  it("feeds one relief vector through every PBR channel after height-v1 and before the unchanged sediment transfer", () => {
    const layer = (
      color: [number, number, number],
      roughness: number,
      ao: number,
      normal: [number, number, number],
      height?: number,
    ): CompactTerrainLayer => ({
      albedo: vec3(...color),
      roughness: float(roughness),
      ao: float(ao),
      worldNormal: vec3(...normal),
      ...(height === undefined ? {} : { height: float(height) }),
    });
    const layers = {
      grass: layer([0.11, 0.27, 0.08], 0.92, 0.8, [0, 1, 0], 0.19),
      dirt: layer([0.32, 0.19, 0.09], 0.84, 0.91, [0.6, 0.8, 0], 0.61),
      rock: layer([0.48, 0.43, 0.37], 0.73, 0.72, [0, 0.8, 0.6]),
    };
    const coastal = layer([0.2, 0.12, 0.06], 0.67, 0.86, [-0.6, 0.8, 0]);
    const view = new Map<Node, readonly number[]>([
      [cameraViewMatrix, new THREE.Matrix4().toArray()],
    ]);
    for (const [dirt, cliff, road, coast] of [
      [0.2, 0.3, 0.17, 0.23],
      [0.5, 0, 0, 0],
      [0.5, 1, 0, 0],
      [0.5, 0.3, 1, 0.2],
      [0.5, 0, 0, 1],
    ]) {
      const resolve = (relief?: Node<"float">, sediment?: Node<"float">) =>
        blendCompactTerrainLayers(
          layers,
          float(dirt),
          float(cliff),
          float(road),
          { talus: float(0.13), wear: float(0.09) },
          float(0.11),
          { coverage: float(coast), layer: coastal },
          float(0.07),
          sediment,
          relief,
        );
      const baseline = resolve();
      const base = vectorValue(baseline.weights!);
      const pond = float(0.5).toVar("testedReliefPondSoil");
      const sediment = float(0.37).toVar("testedReliefSediment");
      const result = resolve(pond, sediment);
      const nodes = graph(result.weights!);
      const intermediate = [...nodes].filter(
        (node) =>
          Reflect.get(node, "name") === "compactPondReliefSurfaceWeights",
      );
      const authored = [...nodes].filter(
        (node) => Reflect.get(node, "name") === "compactHeightSurfaceWeights",
      );
      expect(intermediate).toHaveLength(1);
      expect(authored).toHaveLength(1);
      expect(graph(intermediate[0]).has(authored[0])).toBe(true);
      expect(graph(intermediate[0]).has(sediment)).toBe(false);
      expect(graph(result.weights!).has(sediment)).toBe(true);
      const relief = vectorValue(intermediate[0]);
      const total = base[0] + base[1];
      const fraction = total > 0 ? base[1] / total : 0;
      const shift =
        total *
        (1 - road) *
        (1 - coast) *
        (coverage(fraction, 0.19, 0.61) - fraction);
      expect(relief[0]).toBeCloseTo(base[0] - shift, 13);
      expect(relief[1]).toBeCloseTo(base[1] + shift, 13);
      expect(relief.slice(2)).toEqual(base.slice(2));
      const expected = [
        relief[0],
        relief[1] + relief[2] * 0.37,
        relief[2] * 0.63,
        relief[3],
      ];
      vectorValue(result.weights!).forEach((value, index) =>
        expect(value).toBeCloseTo(expected[index], 13),
      );
      for (const root of [
        result.albedo,
        result.roughness,
        result.ao,
        result.normal,
      ]) {
        expect(graph(root).has(result.weights!)).toBe(true);
        expect(graph(root).has(intermediate[0])).toBe(true);
        expect(graph(root).has(pond)).toBe(true);
      }
      const ordered = [layers.grass, layers.dirt, layers.rock, coastal];
      for (const key of ["albedo", "roughness", "ao"] as const)
        vectorValue(result[key]).forEach((value, channel) =>
          expect(value).toBeCloseTo(
            ordered.reduce(
              (sum, item, index) =>
                sum + vectorValue(item[key])[channel] * expected[index],
              0,
            ),
            12,
          ),
        );
      const normal = new THREE.Vector3();
      ordered.forEach((item, index) =>
        normal.addScaledVector(
          new THREE.Vector3(
            ...(vectorValue(item.worldNormal) as [number, number, number]),
          ),
          expected[index],
        ),
      );
      normal.normalize();
      vectorValue(result.normal, view).forEach((value, index) =>
        expect(value).toBeCloseTo(normal.toArray()[index], 12),
      );
      const absent = resolve(undefined);
      for (const key of [
        "weights",
        "albedo",
        "roughness",
        "ao",
        "normal",
      ] as const)
        expect(vectorValue(absent[key]!, view)).toEqual(
          vectorValue(baseline[key]!, view),
        );
    }
  });

  it("requires explicit relief-v1, compact PBR, height-v1 and a validated actual pond", () => {
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    for (const invalid of [null, false, 0, {}, "", "height-v1", "relief-v2"])
      expect(() =>
        createTerrainMaterial(undefined, {
          compactPbr: true,
          compactSurfaceBlend: "height-v1",
          compactPond: pond,
          compactPondBlend: invalid as never,
        }),
      ).toThrow("Invalid compact pond blend");
    expect(() =>
      createTerrainMaterial(undefined, {
        compactPondBlend: "relief-v1",
      }),
    ).toThrow("Pond blending requires the compact PBR material");
    expect(() =>
      createTerrainMaterial(undefined, {
        compactPbr: true,
        compactPond: pond,
        compactPondBlend: "relief-v1",
      }),
    ).toThrow("Pond blending requires height-v1 surface blending");
    for (const absent of [undefined, null])
      expect(() =>
        createTerrainMaterial(undefined, {
          compactPbr: true,
          compactSurfaceBlend: "height-v1",
          compactPond: absent,
          compactPondBlend: "relief-v1",
        }),
      ).toThrow("Pond blending requires an admitted compact pond");
    expect(() =>
      createTerrainMaterial(undefined, {
        compactPbr: true,
        compactSurfaceBlend: "height-v1",
        compactPond: { ...pond, radius: -1 },
        compactPondBlend: "relief-v1",
      }),
    ).toThrow();
  });

  it("reuses the exact pond source and all paired material reads while preserving normal graph and wetness ownership", () => {
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    const options = {
      compactPbr: true,
      compactSurfaceBlend: "height-v1" as const,
      compactDirtProjection: "stochastic-v1" as const,
      compactRockProjection: "stochastic-v1" as const,
      compactProfile: HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
      compactPond: pond,
    };
    const ordinary = createTerrainMaterial(undefined, options);
    const explicitAbsent = createTerrainMaterial(undefined, {
      ...options,
      compactPondBlend: undefined,
    });
    const noPond = createTerrainMaterial(undefined, {
      ...options,
      compactPond: undefined,
    });
    const material = createTerrainMaterial(undefined, {
      ...options,
      compactPondBlend: "relief-v1",
    });
    try {
      expect(
        Object.getOwnPropertyDescriptor(material, "compactPondBlend"),
      ).toEqual({
        value: "relief-v1",
        enumerable: true,
        writable: false,
        configurable: false,
      });
      for (const baseline of [ordinary, explicitAbsent, noPond]) {
        expect(
          Object.prototype.hasOwnProperty.call(baseline, "compactPondBlend"),
        ).toBe(false);
        for (const root of [
          baseline.colorNode!,
          baseline.normalNode!,
          baseline.roughnessNode!,
          baseline.aoNode!,
        ])
          expect(
            [...graph(root)].some((node) =>
              String(Reflect.get(node, "name")).startsWith("compactPondRelief"),
            ),
          ).toBe(false);
      }
      const originalOutput = material.outputNode;
      const version = material.version;
      const diagnostic = material.getCompactTerrainDiagnosticOutputs()!;
      const roots = [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ];
      const nodes = new Set(roots.flatMap((root) => [...graph(root)]));
      const relief = [...nodes].filter(
        (node) =>
          Reflect.get(node, "name") === "compactPondReliefSurfaceWeights",
      );
      expect(relief).toHaveLength(1);
      expect(graph(relief[0]).has(diagnostic.sources.pondSoil)).toBe(true);
      expect(graph(diagnostic.sources.weights).has(relief[0])).toBe(true);
      for (const source of [
        diagnostic.sources.pondSoil,
        diagnostic.sources.pondWetness,
      ])
        expect(graph(source).has(relief[0])).toBe(false);
      for (const root of roots) {
        expect(graph(root).has(relief[0])).toBe(true);
        expect(graph(root).has(diagnostic.sources.weights)).toBe(true);
      }
      expect(material.outputNode).toBe(originalOutput);
      expect(material.version).toBe(version);
      expect(material.positionNode).toBeNull();
      expect(material.vertexNode).toBeNull();
      expect(material.geometryNode).toBeNull();
      expect(material.displacementMap).toBeNull();
      for (const owner of [ordinary, explicitAbsent, material]) {
        const textureSet = owner.compactTerrainSurface!;
        const receipt = textureSet.getReceipt();
        expect(receipt.textures).toHaveLength(7);
        expect(receipt.surfaceSampleCount).toBe(33);
        const owned = new Set(
          receipt.textures.map((entry) => entry.textureUuid),
        );
        const all = new Set(
          [
            owner.colorNode!,
            owner.normalNode!,
            owner.roughnessNode!,
            owner.aoNode!,
          ].flatMap((root) => [...graph(root)]),
        );
        const reads = [...all].filter((node) => {
          const value: unknown = Reflect.get(node, "value");
          return (
            value instanceof THREE.Texture &&
            owned.has(value.uuid) &&
            Reflect.get(node, "uvNode")
          );
        });
        expect(reads).toHaveLength(33);
        const heights = reads.filter(
          (node) =>
            Reflect.get(node, "value") === textureSet.getHeightNode()!.value,
        );
        expect(heights).toHaveLength(5);
        for (const read of heights) {
          const paired = reads.filter(
            (node) =>
              node !== read &&
              Reflect.get(node, "uvNode") === Reflect.get(read, "uvNode"),
          );
          expect(paired).toHaveLength(2);
          for (const pair of paired)
            expect(Reflect.get(pair, "gradNode")).toEqual(
              Reflect.get(read, "gradNode"),
            );
        }
      }
      const normalizeReceipt = (owner: typeof material) =>
        owner
          .compactTerrainSurface!.getReceipt()
          .textures.map(({ textureUuid: _uuid, ...entry }) => entry);
      expect(normalizeReceipt(material)).toEqual(normalizeReceipt(ordinary));
      expect(normalizeReceipt(explicitAbsent)).toEqual(
        normalizeReceipt(ordinary),
      );
    } finally {
      ordinary.dispose();
      explicitAbsent.dispose();
      noPond.dispose();
      material.dispose();
    }
  });
});

describe("height-aware ground candidate (actual TSL graph, not native approval)", () => {
  it("preserves pure coverage, stays finite/monotone and responds to genuine relative relief", () => {
    for (const grassHeight of [0, 0.2, 0.5, 0.8, 1]) {
      for (const soilHeight of [0, 0.2, 0.5, 0.8, 1]) {
        let previous = -1;
        for (let i = 0; i <= 100; i++) {
          const value = vectorValue(
            createCompactHeightSoilCoverage(
              float(i / 100),
              float(grassHeight),
              float(soilHeight),
            ),
          )[0];
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
          if (i === 0 || i === 100) expect(value).toBe(i / 100);
          else {
            expect(value).toBeGreaterThan(0);
            expect(value).toBeLessThan(1);
          }
          if (grassHeight === soilHeight)
            expect(value).toBeCloseTo(i / 100, 14);
          previous = value;
        }
      }
    }
    const sample = (grass: number, soil: number) =>
      vectorValue(
        createCompactHeightSoilCoverage(float(0.5), float(grass), float(soil)),
      )[0];
    expect(sample(0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(sample(0.2, 0.8)).toBeGreaterThan(0.5);
    expect(sample(0.8, 0.2)).toBeLessThan(0.5);
  });

  it("keeps a continuous authored shoulder instead of sharpening it when relief agrees", () => {
    const sample = (coverage: number, grass: number, soil: number) =>
      vectorValue(
        createCompactHeightSoilCoverage(
          float(coverage),
          float(grass),
          float(soil),
        ),
      )[0];
    for (const coverage of [
      0.001, 0.05, 0.2, 0.36, 0.5, 0.64, 0.8, 0.95, 0.999,
    ]) {
      // Equal filtered relief is the neutral case at every mip, not just 50%.
      for (const height of [0, 0.17, 0.4, 0.9, 1])
        expect(sample(coverage, height, height)).toBeCloseTo(coverage, 14);
      const low = sample(coverage, 1, 0);
      const high = sample(coverage, 0, 1);
      expect(low).toBeCloseTo(coverage / (5 - 4 * coverage), 14);
      expect(high).toBeCloseTo((5 * coverage) / (1 + 4 * coverage), 14);
      expect(low).toBeGreaterThan(0);
      expect(high).toBeLessThan(1);
      expect(sample(coverage, 0.25, 0.75)).toBeCloseTo(
        1 - sample(1 - coverage, 0.75, 0.25),
        14,
      );
    }
  });

  it("uses shared height coverage for physical channels while preserving full road/cliff overrides", () => {
    const layer = (value: number, height?: number): CompactTerrainLayer => ({
      albedo: vec3(value),
      roughness: float(value),
      ao: float(value),
      worldNormal: vec3(0, 1, 0),
      ...(height !== undefined ? { height: float(height) } : {}),
    });
    const layers = {
      grass: layer(0, 0.2),
      dirt: layer(1, 0.8),
      rock: layer(0.3),
    };
    for (const [dirt, cliff, road] of [
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
      [0.5, 1, 0],
      [0.5, 1, 1],
    ]) {
      const result = blendCompactTerrainLayers(
        layers,
        float(dirt),
        float(cliff),
        float(road),
      );
      const expected =
        road === 1
          ? 1
          : cliff === 1
            ? 0.3
            : vectorValue(
                createCompactHeightSoilCoverage(
                  float(dirt),
                  float(0.2),
                  float(0.8),
                ),
              )[0];
      for (const node of [result.albedo, result.roughness, result.ao]) {
        for (const value of vectorValue(node))
          expect(value).toBeCloseTo(expected, 12);
      }
    }
    // Coastal soil keeps its own wet material rather than becoming dry dirt.
    const coastal = blendCompactTerrainLayers(
      layers,
      float(0),
      float(0),
      float(0),
      undefined,
      undefined,
      { coverage: float(1), layer: layer(0.6) },
    );
    expect(vectorValue(coastal.albedo)).toEqual([0.6, 0.6, 0.6]);
    expect(vectorValue(coastal.roughness)).toEqual([0.6]);
  });

  it("owns one optional linear height map, follows every ground projection, and leaves default intact", () => {
    expect(() =>
      createTerrainMaterial(undefined, { compactSurfaceBlend: "height-v1" }),
    ).toThrow("requires the compact PBR");
    const ordinary = createTerrainMaterial(undefined, { compactPbr: true });
    try {
      expect(ordinary.compactTerrainSurface!.getHeightNode()).toBeUndefined();
      expect(
        ordinary.compactTerrainSurface!.getReceipt().textures,
      ).toHaveLength(6);
      expect(ordinary.compactTerrainSurface!.getReceipt().surfaceBlend).toBe(
        "linear-v1",
      );
      for (const dirtProjection of [undefined, "stochastic-v1"] as const) {
        const material = createTerrainMaterial(undefined, {
          compactPbr: true,
          compactSurfaceBlend: "height-v1",
          compactDirtProjection: dirtProjection,
        });
        try {
          const owner = material.compactTerrainSurface!;
          const expected = dirtProjection ? 27 : 24;
          const receipt = owner.getReceipt();
          expect(receipt.surfaceBlend).toBe("height-v1");
          expect(receipt.surfaceSampleCount).toBe(expected);
          expect(receipt.textures).toHaveLength(7);
          const heightMap = owner.getHeightNode()!;
          expect(heightMap.value.colorSpace).toBe(THREE.NoColorSpace);
          expect(heightMap.value.flipY).toBe(false);
          expect(heightMap.value.premultiplyAlpha).toBe(false);
          expect(heightMap.value.generateMipmaps).toBe(true);
          expect(material.positionNode).toBeNull();
          expect(material.displacementMap).toBeNull();
          const owned = new Set(receipt.textures.map((t) => t.textureUuid));
          const nodes = new Set(
            [
              material.colorNode!,
              material.normalNode!,
              material.roughnessNode!,
              material.aoNode!,
            ].flatMap((node) => [...graph(node)]),
          );
          const samples = [...nodes].filter((node) => {
            const value: unknown = Reflect.get(node, "value");
            return (
              value instanceof THREE.Texture &&
              owned.has(value.uuid) &&
              Reflect.get(node, "uvNode")
            );
          });
          expect(samples).toHaveLength(expected);
          const heights = samples.filter(
            (n) => Reflect.get(n, "value") === heightMap.value,
          );
          expect(heights).toHaveLength(dirtProjection ? 5 : 4);
          for (const sample of heights) {
            const surface = samples.filter(
              (n) =>
                n !== sample &&
                Reflect.get(n, "uvNode") === Reflect.get(sample, "uvNode"),
            );
            expect(surface).toHaveLength(2);
            for (const paired of surface) {
              expect(Reflect.get(paired, "gradNode")).toEqual(
                Reflect.get(sample, "gradNode"),
              );
            }
          }
        } finally {
          material.dispose();
        }
      }
    } finally {
      ordinary.dispose();
    }
  });

  it("retains rock contribution and the wet:dry soil ratio through overlapping authored fields", () => {
    const layer = (
      color: [number, number, number],
      ao: number,
      height?: number,
    ): CompactTerrainLayer => ({
      albedo: vec3(...color),
      ao: float(ao),
      roughness: float(0.8),
      worldNormal: vec3(0, 1, 0),
      ...(height !== undefined ? { height: float(height) } : {}),
    });
    const layers = {
      grass: layer([1, 0, 0], 0, 0.23),
      dirt: layer([0, 1, 0], 0, 0.72),
      rock: layer([0, 0, 1], 0),
    };
    for (const [dirt, worn, talus, wear, habitat, coast, cliff, road] of [
      [0.17, 0.11, 0.23, 0.08, 0.12, 0.19, 0.31, 0.13],
      [0.01, 0.04, 0.1, 0.02, 0.03, 0.05, 0.2, 0.03],
      [0.01, 0, 1, 0, 0.1, 0.25, 0.5, 0.2],
    ]) {
      let weights = [1, 0, 0, 0];
      const overlay = (target: number[], coverage: number) => {
        weights = weights.map(
          (v, i) => v * (1 - coverage) + target[i] * coverage,
        );
      };
      overlay([0, 1, 0, 0], dirt);
      overlay([0, 1, 0, 0], worn);
      overlay([0, 0.15, 0.85, 0], talus);
      overlay([0, 1, 0, 0], wear);
      overlay([0, 1, 0, 0], habitat);
      overlay([0, 0, 0, 1], coast);
      overlay([0, 0, 1, 0], cliff);
      overlay([0, 1, 0, 0], road);
      const result = blendCompactTerrainLayers(
        layers,
        float(dirt),
        float(cliff),
        float(road),
        { talus: float(talus), wear: float(wear) },
        float(habitat),
        { coverage: float(coast), layer: layer([0, 0, 0], 1) },
        float(worn),
      );
      const [grass, dry, rock] = vectorValue(result.albedo);
      const wet = vectorValue(result.ao)[0];
      expect(rock).toBeCloseTo(weights[2], 12);
      expect(grass + dry + rock + wet).toBeCloseTo(1, 12);
      // Height competition can eliminate both soil contributions. Cross
      // multiplication checks their proportions without inventing a 0/0 ratio.
      expect(wet * weights[1]).toBeCloseTo(dry * weights[3], 12);
      expect(vectorValue(result.roughness)[0]).toBeCloseTo(0.8, 12);
    }
  });

  it("pins the actual height pack without replacing or reinterpreting existing packed channels", async () => {
    const file = new URL(
      "../../../../../../server/world/assets/terrain/textures/compact-pbr/ground-height.png",
      import.meta.url,
    );
    const bytes = await readFile(file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      COMPACT_TERRAIN_HEIGHT_SHA256["ground-height"],
    );
    const png = PNG.sync.read(bytes);
    expect([png.width, png.height]).toEqual([1024, 1024]);
    const range = [
      [255, 0],
      [255, 0],
      [255, 0],
    ];
    let invalidAlpha = 0;
    for (let p = 0; p < png.data.length; p += 4) {
      if (png.data[p + 3] !== 255) invalidAlpha++;
      for (let c = 0; c < 3; c++) {
        range[c][0] = Math.min(range[c][0], png.data[p + c]);
        range[c][1] = Math.max(range[c][1], png.data[p + c]);
      }
    }
    expect(invalidAlpha).toBe(0);
    for (const [low, high] of range) expect(high - low).toBeGreaterThan(64);
  });
});

describe("opt-in stochastic dirt (actual TSL/scan arithmetic, not native approval)", () => {
  const point = vec2(0);
  const p = createCompactDirtProjections(point, vec2(1, 0), vec2(0, 1));
  const at = (x: number, z: number) => {
    const inputs = new Map<Node, readonly number[]>([[point, [x, z]]]);
    const cache = new Map<Node, number[]>();
    const evaluate = (node: Node) => vectorValue(node, inputs, cache);
    return {
      weights: evaluate(p.weights),
      patches: [p.a, p.b, p.c].map((patch) => ({
        id: evaluate(patch.id),
        uv: evaluate(patch.uv),
        dx: evaluate(patch.dx),
        dy: evaluate(patch.dy),
      })),
    };
  };
  const world = (u: number, v: number) => [
    (u + v * 0.5) * COMPACT_TERRAIN_MATERIAL.dirtPatchEdgeMeters,
    (v * Math.sqrt(3) * COMPACT_TERRAIN_MATERIAL.dirtPatchEdgeMeters) / 2,
  ];

  it("is explicit-only, owns exactly six paired dirt reads, and keeps default graphs at twenty", () => {
    expect(() =>
      createTerrainMaterial(undefined, {
        compactDirtProjection: "stochastic-v1",
      }),
    ).toThrow("requires the compact PBR");
    const ordinary = createTerrainMaterial(undefined, { compactPbr: true });
    const candidate = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactDirtProjection: "stochastic-v1",
    });
    try {
      for (const [material, count, dirtCount] of [
        [ordinary, 20, 4],
        [candidate, 22, 6],
      ] as const) {
        const owner = material.compactTerrainSurface!;
        expect(owner.getReceipt().surfaceSampleCount).toBe(count);
        expect(owner.getReceipt().textures).toHaveLength(6);
        expect(material.positionNode).toBeNull();
        expect(material.displacementMap).toBeNull();
        const owned = new Set(
          owner.getReceipt().textures.map((t) => t.textureUuid),
        );
        const nodes = new Set([
          ...graph(material.colorNode!),
          ...graph(material.normalNode!),
          ...graph(material.roughnessNode!),
          ...graph(material.aoNode!),
        ]);
        const samples = [...nodes].filter((node) => {
          const value: unknown = Reflect.get(node, "value");
          return (
            value instanceof THREE.Texture &&
            owned.has(value.uuid) &&
            Reflect.get(node, "uvNode")
          );
        });
        expect(samples).toHaveLength(count);
        const ar = owner.getNode("dirt", "albedo-roughness").value;
        const na = owner.getNode("dirt", "normal-ao").value;
        const dirt = samples.filter((n) =>
          [ar, na].includes(Reflect.get(n, "value")),
        );
        expect(dirt).toHaveLength(dirtCount);
        for (const sample of dirt.filter(
          (n) => Reflect.get(n, "value") === ar,
        )) {
          const paired = dirt.filter(
            (n) =>
              Reflect.get(n, "value") === na &&
              Reflect.get(n, "uvNode") === Reflect.get(sample, "uvNode"),
          );
          expect(paired).toHaveLength(1);
          const gradients: unknown = Reflect.get(sample, "gradNode");
          expect(Array.isArray(gradients)).toBe(true);
          if (!Array.isArray(gradients))
            throw new Error("Missing explicit gradients");
          expect(Reflect.get(paired[0], "gradNode")).toEqual(gradients);
          for (const gradient of gradients) {
            for (const derivative of [...graph(gradient)].filter((n) =>
              ["dFdx", "dFdy"].includes(String(Reflect.get(n, "method"))),
            )) {
              const methods = [...graph(Reflect.get(derivative, "aNode"))].map(
                (n) => Reflect.get(n, "method"),
              );
              expect(methods).not.toContain("floor");
              expect(methods).not.toContain("sin");
            }
          }
        }
        expect(
          [...nodes].filter(
            (n) => Reflect.get(n, "name") === "compactStochasticDirtAlbedo",
          ),
        ).toHaveLength(count === 22 ? 1 : 0);
      }
    } finally {
      ordinary.dispose();
      candidate.dispose();
    }
  });

  it("shares edge transforms at signed coordinates and keeps unit weight/physical gradients", () => {
    for (const i of [-512, -3, -1, 0, 2, 350])
      for (const j of [-350, -2, 0, 3, 510])
        for (const [u, v, du, dv] of [
          [i + 0.37, j + 0.63, 1, 0],
          [i, j + 0.39, 1, 0],
          [i + 0.29, j, 0, 1],
        ]) {
          const [x0, z0] = world(u - du * 1e-8, v - dv * 1e-8);
          const [x1, z1] = world(u + du * 1e-8, v + dv * 1e-8);
          const left = at(x0, z0),
            right = at(x1, z1);
          for (const side of [left, right]) {
            expect(side.weights.reduce((a, b) => a + b)).toBeCloseTo(1, 12);
            expect(Math.min(...side.weights)).toBeGreaterThanOrEqual(-1e-12);
            expect(Math.max(...side.weights)).toBeLessThanOrEqual(1 + 1e-12);
            for (const patch of side.patches) {
              expect(Math.hypot(...patch.dx)).toBeCloseTo(0.5, 12);
              expect(Math.hypot(...patch.dy)).toBeCloseTo(0.5, 12);
              expect(
                patch.dx[0] * patch.dy[0] + patch.dx[1] * patch.dy[1],
              ).toBeCloseTo(0, 12);
            }
          }
          for (const [index, a] of left.patches.entries()) {
            if (left.weights[index] < 1e-6) continue;
            const other = right.patches.findIndex(
              (b) => b.id[0] === a.id[0] && b.id[1] === a.id[1],
            );
            expect(other).toBeGreaterThanOrEqual(0);
            const b = right.patches[other];
            expect(a.dx).toEqual(b.dx);
            expect(a.dy).toEqual(b.dy);
            expect(
              Math.hypot(...a.uv.map((value, k) => value - b.uv[k])),
            ).toBeLessThan(2e-8);
            expect(
              Math.abs(left.weights[index] - right.weights[other]),
            ).toBeLessThan(4e-8);
          }
        }
  });

  it("hashes signed vertex IDs with exact uint arithmetic and a representable float32 output", () => {
    const reference = (x: number, y: number, salt: number) => {
      const seed =
        ((Math.imul(x, 1597334677) + Math.imul(y, 3812015801)) ^ salt) >>> 0;
      const state = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
      const word =
        Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
      return (((word >>> 22) ^ word) >>> 8) / 16777216;
    };
    const values = new Set<number>();
    for (const x of [-1024, -513, -1, 0, 1, 513, 1024])
      for (const y of [-1024, -321, -1, 0, 1, 321, 1024])
        for (const salt of [0, 0x68bc21eb, 0x02e5be93]) {
          const actual = vectorValue(
            createCompactDirtVertexHash(vec2(x, y), salt),
          )[0];
          expect(actual).toBe(reference(x, y, salt));
          expect(Math.fround(actual)).toBe(actual);
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThan(1);
          values.add(actual);
        }
    expect(values.size).toBe(147);
  });

  it("bounds linear-albedo variance correction, preserves endpoints and leaves the mean fixed", () => {
    const mean = createCompactTerrainColorOperations().getPalette().dirt;
    for (const w of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1 / 3, 1 / 3, 1 / 3],
      [0.2, 0.3, 0.5],
    ]) {
      const gain = 1 / Math.hypot(...w);
      expect(gain).toBeGreaterThanOrEqual(1);
      expect(gain).toBeLessThanOrEqual(Math.sqrt(3) + 1e-12);
      for (const values of [
        [mean, mean, mean],
        [
          [0, 0, 0],
          [1, 1, 1],
          [0.1, 0.5, 0.2],
        ],
      ]) {
        const result = vectorValue(
          blendCompactDirtAlbedo(
            vec3(...values[0]),
            vec3(...values[1]),
            vec3(...values[2]),
            vec3(...w),
          ),
        );
        result.forEach((value, channel) => {
          const blended = values.reduce(
            (sum, c, i) => sum + c[channel] * w[i],
            0,
          );
          expect(value).toBeCloseTo(
            THREE.MathUtils.clamp(
              mean[channel] + (blended - mean[channel]) * gain,
              0,
              1,
            ),
            12,
          );
        });
      }
    }
  });

  it("keeps paired normal, roughness and AO arithmetic continuous at float32-representable edges", () => {
    const owner = new CompactTerrainTextureSet("/assets", "stochastic-v1");
    try {
      for (const distance of [0, 80 ** 2, 121 ** 2]) {
        const layer = createCompactTerrainLayers(owner, float(distance)).dirt;
        const roots = [layer.worldNormal, layer.roughness, layer.ao];
        const nodes = new Set(roots.flatMap((root) => [...graph(root)]));
        const ar = owner.getNode("dirt", "albedo-roughness").value;
        const na = owner.getNode("dirt", "normal-ao").value;
        const evaluate = (x: number, z: number, encoded: number[]) => {
          const inputs = new Map<Node, readonly number[]>([
            [positionWorld, [Math.fround(x), 0, Math.fround(z)]],
            [normalWorldGeometry, [0, 1, 0]],
          ]);
          for (const node of nodes) {
            if (Reflect.get(node, "uvNode")) {
              if (Reflect.get(node, "value") === ar)
                inputs.set(node, [0.1, 0.1, 0.1, 0.93]);
              if (Reflect.get(node, "value") === na)
                inputs.set(node, [...encoded, 0.6]);
            }
            const method = Reflect.get(node, "method");
            if (method === "dFdx" || method === "dFdy") {
              const input: unknown = Reflect.get(node, "aNode");
              const spatial = input === positionWorld;
              inputs.set(
                node,
                spatial
                  ? method === "dFdx"
                    ? [1, 0, 0]
                    : [0, 0, -1]
                  : method === "dFdx"
                    ? [1, 0]
                    : [0, -1],
              );
            }
          }
          const normal = vectorValue(layer.worldNormal, inputs);
          expect(normal.every(Number.isFinite)).toBe(true);
          expect(Math.hypot(...normal)).toBeCloseTo(1, 12);
          expect(vectorValue(layer.roughness, inputs)[0]).toBeCloseTo(0.93, 12);
          expect(vectorValue(layer.ao, inputs)[0]).toBeCloseTo(0.86, 12);
          if (distance > 120 ** 2 || encoded[0] === 0.5)
            normal.forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i], 12));
          return normal;
        };
        for (const [u, v, du, dv] of [
          [-513 + 0.37, -321 + 0.63, 1, 0],
          [512, 350.39, 1, 0],
          [350.29, -512, 0, 1],
        ]) {
          const [lx, lz] = world(u - du * 0.001, v - dv * 0.001);
          const [rx, rz] = world(u + du * 0.001, v + dv * 0.001);
          expect(
            Math.fround(lx) !== Math.fround(rx) ||
              Math.fround(lz) !== Math.fround(rz),
          ).toBe(true);
          for (const encoded of [
            [0.5, 0.5, 1],
            [0.75, 0.4, 0.94],
          ]) {
            const a = evaluate(lx, lz, encoded),
              b = evaluate(rx, rz, encoded);
            expect(Math.hypot(...a.map((n, i) => n - b[i]))).toBeLessThan(
              0.002,
            );
          }
        }
      }
    } finally {
      owner.dispose();
    }
  });

  it("breaks the CURRENT 2m rotated dirt lattice without flattening actual packed linear soil", async () => {
    const bytes = await readFile(
      new URL("dirt-albedo-roughness.png", assetDirectory),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedDigest("dirt-albedo-roughness"),
    );
    const png = PNG.sync.read(bytes);
    const linear = (n: number) =>
      n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    const mean = createCompactTerrainColorOperations().getPalette().dirt;
    const sample = (uv: number[]) => {
      const px = (uv[0] - Math.floor(uv[0])) * png.width - 0.5;
      const py = (uv[1] - Math.floor(uv[1])) * png.height - 0.5;
      const ix = Math.floor(px),
        iy = Math.floor(py),
        fx = px - ix,
        fy = py - iy;
      const texel = (x: number, y: number, c: number) =>
        linear(
          png.data[
            (((y + png.height) % png.height) * png.width +
              ((x + png.width) % png.width)) *
              4 +
              c
          ] / 255,
        );
      return [0, 1, 2].map(
        (c) =>
          (texel(ix, iy, c) * (1 - fx) + texel(ix + 1, iy, c) * fx) * (1 - fy) +
          (texel(ix, iy + 1, c) * (1 - fx) + texel(ix + 1, iy + 1, c) * fx) *
            fy,
      );
    };
    const candidate = (x: number, z: number) => {
      const state = at(x, z),
        gain = 1 / Math.hypot(...state.weights);
      const colors = state.patches.map((patch) => sample(patch.uv));
      const rgb = mean.map((m, c) =>
        THREE.MathUtils.clamp(
          m +
            (colors.reduce(
              (s, color, i) => s + color[c] * state.weights[i],
              0,
            ) -
              m) *
              gain,
          0,
          1,
        ),
      );
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const correlation = (a: number[], b: number[]) => {
      const ma = a.reduce((s, v) => s + v) / a.length,
        mb = b.reduce((s, v) => s + v) / b.length;
      const va = a.reduce((s, v) => s + (v - ma) ** 2, 0),
        vb = b.reduce((s, v) => s + (v - mb) ** 2, 0);
      return (
        a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) /
        Math.sqrt(va * vb)
      );
    };
    const baseline: number[] = [],
      revised: number[] = [];
    const shifts: number[][] = [];
    // Current rotated/scaled projection IDs, not the obsolete 3.33m grid.
    for (const id of [0, 7, 16, 24]) {
      const angle = id * 2.399963229728653;
      const scale = (1 + Math.sin(id * 1.61803398875) * 0.18) * 0.5;
      for (const multiple of [1, 2]) {
        shifts.push([
          (Math.cos(angle) / scale) * multiple,
          (-Math.sin(angle) / scale) * multiple,
        ]);
        shifts.push([
          (Math.sin(angle) / scale) * multiple,
          (Math.cos(angle) / scale) * multiple,
        ]);
      }
    }
    // Also reject the NEW equilateral lattice periods, not only old repeats.
    for (const multiple of [1, 2, 4])
      shifts.push([multiple, 0], [multiple / 2, (multiple * Math.sqrt(3)) / 2]);
    const shifted = shifts.map(() => [] as number[]);
    let baselineDifference = 0;
    for (let i = 0; i < 256; i++) {
      const x = 295 + ((i * 0.61803398875) % 1) * 20;
      const z = -23 + ((i * 0.41421356237) % 1) * 20;
      const raw = sample([x * 0.5, z * 0.5]);
      const repeat = sample([(x + 2) * 0.5, z * 0.5]);
      baselineDifference += Math.abs(raw[0] - repeat[0]);
      baseline.push(raw[0] * 0.2126 + raw[1] * 0.7152 + raw[2] * 0.0722);
      revised.push(candidate(x, z));
      shifts.forEach(([dx, dz], j) =>
        shifted[j].push(candidate(x + dx, z + dz)),
      );
    }
    expect(baselineDifference).toBeLessThan(1e-9);
    for (const values of shifted)
      expect(Math.abs(correlation(revised, values))).toBeLessThan(0.3);
    const variance = (values: number[]) => {
      const mean = values.reduce((s, v) => s + v) / values.length;
      return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    };
    const ratio = variance(revised) / variance(baseline);
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.4);
    console.info(
      "Dirt actual packed linear CPU samples (not native mips)",
      JSON.stringify({
        samples: revised.length,
        shifts,
        correlations: shifted.map((v) => correlation(revised, v)),
        varianceRatio: ratio,
      }),
    );
  });
});

describe("opt-in stochastic rock (actual graph/scan evidence, not native approval)", () => {
  it("breaks current rotated rock periods and 1.35m patch translations while retaining actual packed linear contrast", async () => {
    const bytes = await readFile(
      new URL("rock-albedo-roughness.png", assetDirectory),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedDigest("rock-albedo-roughness"),
    );
    const png = PNG.sync.read(bytes);
    expect([png.width, png.height]).toEqual([1024, 1024]);
    const c = COMPACT_TERRAIN_MATERIAL;
    expect(c.repeatsPerMeter).toBe(1 / 2.7);
    expect(c.rockPatchEdgeMeters).toBe(1.35);
    const linear = Array.from({ length: 256 }, (_, byte) => {
      const value = byte / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    // Bilinear linear-reflectance sampling of the real packed PNG. This is
    // level-zero CPU evidence, not native mip/aniso/normal/temporal qualification.
    const sample = (uv: readonly number[]) => {
      const px = (uv[0] - Math.floor(uv[0])) * png.width - 0.5;
      const py = (uv[1] - Math.floor(uv[1])) * png.height - 0.5;
      const ix = Math.floor(px),
        iy = Math.floor(py),
        fx = px - ix,
        fy = py - iy;
      const texel = (x: number, y: number, channel: number) =>
        linear[
          png.data[
            (((y + png.height) % png.height) * png.width +
              ((x + png.width) % png.width)) *
              4 +
              channel
          ]
        ];
      return [0, 1, 2].map(
        (channel) =>
          (texel(ix, iy, channel) * (1 - fx) +
            texel(ix + 1, iy, channel) * fx) *
            (1 - fy) +
          (texel(ix, iy + 1, channel) * (1 - fx) +
            texel(ix + 1, iy + 1, channel) * fx) *
            fy,
      );
    };
    const luminance = (rgb: readonly number[]) =>
      rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const variance = (values: readonly number[]) => {
      const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length;
      return (
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length
      );
    };
    const correlation = (a: readonly number[], b: readonly number[]) => {
      const ma = a.reduce((sum, value) => sum + value, 0) / a.length;
      const mb = b.reduce((sum, value) => sum + value, 0) / b.length;
      return (
        a.reduce((sum, value, i) => sum + (value - ma) * (b[i] - mb), 0) /
        (a.length * Math.sqrt(variance(a) * variance(b)))
      );
    };
    const point = vec2(0);
    const shifts: Array<{ kind: string; delta: [number, number] }> = [];
    let legacyRepeatError = 0;
    // These are the CURRENT legacy affine projection periods, including its
    // ±18% scale/rotation, not an obsolete axis-aligned 3.33m texture period.
    // A fixed selector isolates each legacy projection; the entire noise-varying
    // legacy material is not claimed to have an exact global period.
    for (const id of [0, 7, 16, 24]) {
      const projection = createCompactGroundProjections(
        point,
        float((id + 0.05) / c.groundPatternBands),
        c.repeatsPerMeter,
        vec2(1, 0),
        vec2(0, 1),
      );
      expect(vectorValue(projection.weight)[0]).toBe(0);
      const angle = id * 2.399963229728653;
      const scale =
        (1 + Math.sin(id * 1.61803398875) * 0.18) * c.repeatsPerMeter;
      for (const multiple of [1, 2])
        for (const [axis, delta] of [
          ["u", [Math.cos(angle) / scale, -Math.sin(angle) / scale]],
          ["v", [Math.sin(angle) / scale, Math.cos(angle) / scale]],
        ] as const) {
          const offset: [number, number] = [
            delta[0] * multiple,
            delta[1] * multiple,
          ];
          shifts.push({
            kind: `legacy-${id}-${axis}-${multiple}`,
            delta: offset,
          });
          for (let i = 0; i < 8; i++) {
            const origin = [295 + i * 0.61803398875, -23 + i * 0.41421356237];
            const uv = vectorValue(projection.a.uv, new Map([[point, origin]]));
            const moved = vectorValue(
              projection.a.uv,
              new Map([
                [point, [origin[0] + offset[0], origin[1] + offset[1]]],
              ]),
            );
            const expected = axis === "u" ? [multiple, 0] : [0, multiple];
            for (let component = 0; component < 2; component++)
              expect(moved[component] - uv[component]).toBeCloseTo(
                expected[component],
                10,
              );
            legacyRepeatError = Math.max(
              legacyRepeatError,
              Math.abs(luminance(sample(uv)) - luminance(sample(moved))),
            );
          }
        }
    }
    expect(legacyRepeatError).toBeLessThan(1e-8);
    for (const multiple of [1, 2, 4]) {
      const edge = c.rockPatchEdgeMeters * multiple;
      shifts.push(
        { kind: `patch-u-${multiple}`, delta: [edge, 0] },
        {
          kind: `patch-v-${multiple}`,
          delta: [edge / 2, (edge * Math.sqrt(3)) / 2],
        },
      );
    }
    const reports: Array<{
      seed: number;
      varianceRatio: number;
      correlations: number[];
    }> = [];
    for (const seed of [0x173ab129, 0x375cd103, 0x529a4d27]) {
      const projection = createCompactStochasticProjections(
        point,
        c.repeatsPerMeter,
        c.rockPatchEdgeMeters,
        vec2(1, 0),
        vec2(0, 1),
        seed,
      );
      const colorInputs = [vec3(0.1), vec3(0.2), vec3(0.3)];
      const blended = blendCompactStochasticAlbedo(
        colorInputs[0],
        colorInputs[1],
        colorInputs[2],
        projection.weights,
        createCompactTerrainColorOperations().getPalette().rock,
      );
      const candidate = (x: number, y: number) => {
        const inputs = new Map<Node, readonly number[]>([[point, [x, y]]]);
        const cache = new Map<Node, number[]>();
        [projection.a, projection.b, projection.c].forEach((patch, index) =>
          inputs.set(
            colorInputs[index],
            sample(vectorValue(patch.uv, inputs, cache)),
          ),
        );
        // Both the actual projection graph and actual contrast operator execute.
        return luminance(vectorValue(blended, inputs, cache));
      };
      const baseline: number[] = [],
        revised: number[] = [];
      const shifted = shifts.map(() => [] as number[]);
      for (let i = 0; i < 256; i++) {
        const x = 295 + ((i * 0.61803398875) % 1) * 20;
        const y = -23 + ((i * 0.41421356237) % 1) * 20;
        baseline.push(
          luminance(sample([x * c.repeatsPerMeter, y * c.repeatsPerMeter])),
        );
        revised.push(candidate(x, y));
        shifts.forEach(({ delta: [dx, dy] }, index) =>
          shifted[index].push(candidate(x + dx, y + dy)),
        );
      }
      const correlations = shifted.map((values) =>
        correlation(revised, values),
      );
      for (const value of correlations)
        expect(Math.abs(value)).toBeLessThan(0.3);
      expect(variance(baseline)).toBeGreaterThan(1e-8);
      const ratio = variance(revised) / variance(baseline);
      expect(ratio).toBeGreaterThan(0.65);
      expect(ratio).toBeLessThan(1.4);
      reports.push({ seed, varianceRatio: ratio, correlations });
    }
    console.info(
      "Rock actual packed linear level-zero CPU samples (not native mips/temporal/performance proof)",
      JSON.stringify({
        samplesPerPlane: 256,
        legacyRepeatError,
        shifts,
        reports,
      }),
    );
  });

  it("adds only six paired surface reads without changing default, heights or texture owners", () => {
    expect(() =>
      createTerrainMaterial(undefined, {
        compactRockProjection: "stochastic-v1",
      }),
    ).toThrow("requires the compact PBR");
    for (const dirt of [undefined, "stochastic-v1"] as const)
      for (const height of [undefined, "height-v1"] as const)
        for (const rock of [undefined, "stochastic-v1"] as const) {
          const material = createTerrainMaterial(undefined, {
            compactPbr: true,
            compactDirtProjection: dirt,
            compactSurfaceBlend: height,
            compactRockProjection: rock,
          });
          try {
            const owner = material.compactTerrainSurface!;
            const receipt = owner.getReceipt();
            const count =
              20 +
              (dirt ? 2 : 0) +
              (rock ? 6 : 0) +
              (height ? (dirt ? 5 : 4) : 0);
            expect(receipt.surfaceSampleCount).toBe(count);
            expect(receipt.rockProjection).toBe(rock ?? "dual-v1");
            expect(receipt.textures).toHaveLength(height ? 7 : 6);
            expect(material.positionNode).toBeNull();
            expect(material.displacementMap).toBeNull();
            const owned = new Set(receipt.textures.map((t) => t.textureUuid));
            const nodes = new Set(
              [
                material.colorNode!,
                material.normalNode!,
                material.roughnessNode!,
                material.aoNode!,
              ].flatMap((n) => [...graph(n)]),
            );
            const samples = [...nodes].filter((n) => {
              const value: unknown = Reflect.get(n, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(n, "uvNode")
              );
            });
            expect(samples).toHaveLength(count);
            const ar = owner.getNode("rock", "albedo-roughness").value;
            const na = owner.getNode("rock", "normal-ao").value;
            const colors = samples.filter(
              (n) => Reflect.get(n, "value") === ar,
            );
            expect(colors).toHaveLength(rock ? 9 : 6);
            for (const a of colors) {
              const paired = samples.filter(
                (n) =>
                  Reflect.get(n, "value") === na &&
                  Reflect.get(n, "uvNode") === Reflect.get(a, "uvNode"),
              );
              expect(paired).toHaveLength(1);
              expect(Reflect.get(paired[0], "gradNode")).toEqual(
                Reflect.get(a, "gradNode"),
              );
            }
          } finally {
            material.dispose();
          }
        }
  });

  it("keeps scan scale, signed-cell continuity and stable gradients independently on all rock planes", () => {
    const c = COMPACT_TERRAIN_MATERIAL;
    const point = vec2(0);
    for (const seed of [0x173ab129, 0x375cd103, 0x529a4d27]) {
      const p = createCompactStochasticProjections(
        point,
        c.repeatsPerMeter,
        c.rockPatchEdgeMeters,
        vec2(1, 0),
        vec2(0, 1),
        seed,
      );
      const evaluate = (u: number, v: number) => {
        const input = new Map<Node, readonly number[]>([
          [
            point,
            [
              (u + v * 0.5) * c.rockPatchEdgeMeters,
              v * Math.sqrt(3) * 0.5 * c.rockPatchEdgeMeters,
            ],
          ],
        ]);
        const cache = new Map<Node, number[]>();
        const value = (n: Node) => vectorValue(n, input, cache);
        const weights = value(p.weights);
        expect(weights.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 12);
        for (const w of weights) expect(w).toBeGreaterThanOrEqual(-1e-12);
        return [p.a, p.b, p.c].map((patch, i) => {
          const dx = value(patch.dx),
            dy = value(patch.dy);
          expect(Math.hypot(...dx)).toBeCloseTo(c.repeatsPerMeter, 12);
          expect(Math.hypot(...dy)).toBeCloseTo(c.repeatsPerMeter, 12);
          expect(dx[0] * dy[0] + dx[1] * dy[1]).toBeCloseTo(0, 12);
          return {
            id: value(patch.id).join(","),
            uv: value(patch.uv),
            dx,
            dy,
            w: weights[i],
          };
        });
      };
      for (const [u, v, du, dv] of [
        [3.37, 6.63, 1, 0],
        [-4, -2.39, 1, 0],
        [2.31, -3, 0, 1],
      ]) {
        const a = evaluate(u - du * 1e-7, v - dv * 1e-7);
        const b = evaluate(u + du * 1e-7, v + dv * 1e-7);
        const shared = a.filter((x) => x.w > 1e-5);
        expect(shared).toHaveLength(2);
        for (const x of shared) {
          const y = b.find((y) => x.id === y.id)!;
          expect(y).toBeDefined();
          expect(y.dx).toEqual(x.dx);
          expect(y.dy).toEqual(x.dy);
          expect(y.w).toBeCloseTo(x.w, 6);
          for (let i = 0; i < 2; i++) expect(y.uv[i]).toBeCloseTo(x.uv[i], 6);
        }
      }
    }
  });

  it("shares only candidate geometric normal inputs and preserves non-neutral skewed cotangent frames", () => {
    const owner = new CompactTerrainTextureSet(
      "/assets",
      undefined,
      undefined,
      "stochastic-v1",
    );
    const ordinary = new CompactTerrainTextureSet("/assets");
    const distance = float(0);
    const derivativeX = vec3(1, 0, 0);
    const derivativeY = vec3(0, 0, 1);
    const controls = COMPACT_TERRAIN_MATERIAL;
    const planes = [
      { components: [2, 1], seed: 0x173ab129 },
      { components: [0, 2], seed: 0x375cd103 },
      { components: [0, 1], seed: 0x529a4d27 },
    ] as const;
    const projectPlane = (node: Node<"vec3">, components: readonly number[]) =>
      vec2(
        components[0] === 2 ? node.z : node.x,
        components[1] === 1 ? node.y : node.z,
      );
    const projections = planes.map(({ components, seed }) =>
      createCompactStochasticProjections(
        projectPlane(positionWorld, components),
        controls.repeatsPerMeter,
        controls.rockPatchEdgeMeters,
        projectPlane(derivativeX, components),
        projectPlane(derivativeY, components),
        seed,
      ),
    );
    // Controlled non-neutral texels vary by the actual sampled UV. The normal
    // reconstruction below is independent numeric arithmetic, not a GPU mock,
    // native texture-filtering assertion, or a second call to the normal helper.
    const encodedAt = ([u, v]: readonly number[]) => [
      0.5 + 0.24 * Math.sin(u * 0.7 + v * 0.3),
      0.5 + 0.21 * Math.cos(v * 0.9 - u * 0.2),
      0.81 + 0.11 * Math.sin(u * 0.11 - v * 0.13),
    ];
    try {
      const layer = createCompactTerrainLayers(owner, distance).rock;
      const nodes = [...graph(layer.worldNormal)];
      const worldDerivatives = nodes.filter(
        (node) =>
          ["dFdx", "dFdy"].includes(Reflect.get(node, "method")) &&
          Reflect.get(node, "aNode") === positionWorld,
      );
      expect(worldDerivatives).toHaveLength(2);
      expect(
        nodes.filter((node) => Reflect.get(node, "method") === "cross"),
      ).toHaveLength(2);
      expect(
        [
          ...graph(
            createCompactTerrainLayers(ordinary, distance).rock.worldNormal,
          ),
        ].filter((node) => Reflect.get(node, "method") === "cross"),
      ).toHaveLength(12);
      const normalTexture = owner.getNode("rock", "normal-ao").value;
      const samples = nodes.filter(
        (node) =>
          Reflect.get(node, "value") === normalTexture &&
          Reflect.get(node, "uvNode"),
      );
      expect(samples).toHaveLength(9);
      for (const direction of [
        [0, 1, 0],
        [1, 0, 0],
        [-1, 0, 0],
        [1, 1, 1],
        [-0.8, 0.13, 0.6],
        [1, 0.000001, -0.000002],
      ]) {
        const normal = new THREE.Vector3(...direction).normalize();
        const u = new THREE.Vector3(
          Math.abs(normal.y) < 0.9 ? 0 : 1,
          Math.abs(normal.y) < 0.9 ? 1 : 0,
          0,
        )
          .cross(normal)
          .normalize();
        const v = normal.clone().cross(u);
        for (const [a, b, c, d] of [
          [1.8, 0.31, 0.73, 0.6],
          [0.37, 1.61, 0.51, -0.12],
        ]) {
          const q0 = u.clone().multiplyScalar(a).addScaledVector(v, b);
          const q1 = u.clone().multiplyScalar(c).addScaledVector(v, d);
          for (const position of [
            [-23.7, 19.8, 478.3],
            [428.1, 27.4, -17.9],
          ])
            for (const meters of [0, 80, 121]) {
              const inputs = new Map<Node, readonly number[]>([
                [positionWorld, position],
                [normalWorldGeometry, normal.toArray()],
                [derivativeX, q0.toArray()],
                [derivativeY, q1.toArray()],
                [distance, [meters ** 2]],
              ]);
              for (const node of nodes) {
                const method = Reflect.get(node, "method");
                if (method !== "dFdx" && method !== "dFdy") continue;
                const operand: unknown = Reflect.get(node, "aNode");
                if (!(operand instanceof THREE.Node))
                  throw new Error("Missing actual projection derivative");
                // Every derivative operand here is the continuous world vector
                // or its linear plane projection, before discrete patch choice.
                inputs.set(
                  node,
                  vectorValue(
                    operand,
                    new Map([
                      [positionWorld, (method === "dFdx" ? q0 : q1).toArray()],
                    ]),
                  ),
                );
              }
              for (const sample of samples) {
                const uv: unknown = Reflect.get(sample, "uvNode");
                if (!(uv instanceof THREE.Node))
                  throw new Error("Missing actual normal sample UV");
                inputs.set(sample, [
                  ...encodedAt(vectorValue(uv, inputs)),
                  0.67,
                ]);
              }
              const t = THREE.MathUtils.clamp(
                (meters ** 2 - controls.normalFadeNear ** 2) /
                  (controls.normalFadeFar ** 2 - controls.normalFadeNear ** 2),
                0,
                1,
              );
              const strength =
                (1 - t * t * (3 - 2 * t)) * controls.rockNormalStrength;
              const planeNormals = projections.map((projection) => {
                const weights = vectorValue(projection.weights, inputs);
                return [projection.a, projection.b, projection.c]
                  .reduce((sum, patch, index) => {
                    const st0 = vectorValue(patch.dx, inputs);
                    const st1 = vectorValue(patch.dy, inputs);
                    const q1perp = q1.clone().cross(normal);
                    const q0perp = normal.clone().cross(q0);
                    const tangent = q1perp
                      .clone()
                      .multiplyScalar(st0[0])
                      .addScaledVector(q0perp, st1[0]);
                    const bitangent = q1perp
                      .clone()
                      .multiplyScalar(st0[1])
                      .addScaledVector(q0perp, st1[1]);
                    const scale =
                      1 /
                      Math.sqrt(
                        Math.max(
                          tangent.lengthSq(),
                          bitangent.lengthSq(),
                          1e-12,
                        ),
                      );
                    const encoded = encodedAt(vectorValue(patch.uv, inputs));
                    const patchNormal = tangent
                      .multiplyScalar(scale)
                      .multiplyScalar(encoded[0] * 2 - 1)
                      .multiplyScalar(strength)
                      .add(
                        bitangent
                          .multiplyScalar(scale)
                          .multiplyScalar(encoded[1] * 2 - 1)
                          .multiplyScalar(strength),
                      )
                      .add(
                        normal
                          .clone()
                          .multiplyScalar(Math.max(encoded[2] * 2 - 1, 0.001)),
                      )
                      .normalize();
                    return sum.addScaledVector(patchNormal, weights[index]);
                  }, new THREE.Vector3())
                  .normalize();
              });
              const axisWeights = normal
                .toArray()
                .map((value) => Math.abs(value) ** 4);
              const totalWeight = Math.max(
                axisWeights.reduce((sum, value) => sum + value, 0),
                1e-12,
              );
              const expected = planeNormals
                .reduce(
                  (sum, value, index) =>
                    sum.addScaledVector(
                      value,
                      axisWeights[index] / totalWeight,
                    ),
                  new THREE.Vector3(),
                )
                .normalize();
              const actual = new THREE.Vector3(
                ...vectorValue(layer.worldNormal, inputs),
              );
              expect(actual.distanceTo(expected)).toBeLessThan(1e-11);
              expect(actual.length()).toBeCloseTo(1, 12);
            }
        }
      }
    } finally {
      owner.dispose();
      ordinary.dispose();
    }
  });

  it("preserves neutral normals on signed and equal-axis slopes without biplanar singularities", () => {
    const owner = new CompactTerrainTextureSet(
      "/assets",
      undefined,
      undefined,
      "stochastic-v1",
    );
    try {
      const layer = createCompactTerrainLayers(owner, float(0)).rock;
      const nodes = new Set(
        [layer.albedo, layer.roughness, layer.ao, layer.worldNormal].flatMap(
          (n) => [...graph(n)],
        ),
      );
      const ar = owner.getNode("rock", "albedo-roughness").value;
      const na = owner.getNode("rock", "normal-ao").value;
      const mean = createCompactTerrainColorOperations().getPalette().rock;
      for (const normal of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 1, 1],
        [-1, 1, -1],
        [1, 0.001, 1],
      ]) {
        const n = new THREE.Vector3(...normal).normalize();
        const tangent = new THREE.Vector3(
          Math.abs(n.y) < 0.9 ? 0 : 1,
          Math.abs(n.y) < 0.9 ? 1 : 0,
          0,
        )
          .cross(n)
          .normalize();
        const bitangent = n.clone().cross(tangent);
        const input = new Map<Node, readonly number[]>([
          [positionWorld, [-23.7, 19.8, 478.3]],
          [normalWorldGeometry, n.toArray()],
        ]);
        for (const node of nodes) {
          if (Reflect.get(node, "uvNode")) {
            if (Reflect.get(node, "value") === ar)
              input.set(node, [...mean, 0.91]);
            if (Reflect.get(node, "value") === na)
              input.set(node, [0.5, 0.5, 1, 0.6]);
          }
          const method = Reflect.get(node, "method");
          if (method === "dFdx" || method === "dFdy") {
            const operand = Reflect.get(node, "aNode");
            const direction = method === "dFdx" ? tangent : bitangent;
            if (operand === positionWorld) input.set(node, direction.toArray());
            else {
              // Evaluate this plane's linear projection on a spatial direction.
              input.set(
                node,
                vectorValue(
                  operand,
                  new Map([[positionWorld, direction.toArray()]]),
                ),
              );
            }
          }
        }
        vectorValue(layer.worldNormal, input).forEach((v, i) =>
          expect(v).toBeCloseTo(n.toArray()[i], 12),
        );
        vectorValue(layer.albedo, input).forEach((v, i) =>
          expect(v).toBeCloseTo(mean[i], 12),
        );
        expect(vectorValue(layer.roughness, input)[0]).toBeCloseTo(0.91, 12);
        expect(vectorValue(layer.ao, input)[0]).toBeCloseTo(0.86, 12);
      }
    } finally {
      owner.dispose();
    }
  });
});

describe("dual-projection rock candidate (CPU graph evidence, not native approval)", () => {
  const mean = createCompactTerrainColorOperations().getPalette().rock;
  const srgbToLinear = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const smooth = (value: number) => {
    const t = THREE.MathUtils.clamp((value - 0.18) / (0.82 - 0.18), 0, 1);
    return t * t * (3 - 2 * t);
  };

  it("uses bounded mean-centered compensation with exact endpoints and no histogram-preservation claim", () => {
    for (const a of [mean, [0, 0, 0], [1, 1, 1], [0.1, 0.3, 0.7]])
      for (const b of [mean, [0, 0, 0], [1, 1, 1], [0.7, 0.2, 0.1]])
        for (const w of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const actual = vectorValue(
            blendCompactRockAlbedo(
              vec3(a[0], a[1], a[2]),
              vec3(b[0], b[1], b[2]),
              float(w),
            ),
          );
          const gain = 1 / Math.hypot(1 - w, w);
          expect(gain).toBeGreaterThanOrEqual(1);
          expect(gain).toBeLessThanOrEqual(Math.SQRT2);
          actual.forEach((value, c) => {
            const expected = THREE.MathUtils.clamp(
              mean[c] + ((1 - w) * a[c] + w * b[c] - mean[c]) * gain,
              0,
              1,
            );
            expect(value).toBeCloseTo(expected, 13);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            if (w === 0 || w === 1)
              expect(value).toBeCloseTo((w === 0 ? a : b)[c], 14);
          });
        }
    // Correlated inputs deliberately do NOT have exact variance preservation.
    // A constant input at the palette mean remains a fixed point at every blend.
    for (const w of [0, 0.25, 0.5, 0.75, 1])
      vectorValue(
        blendCompactRockAlbedo(vec3(...mean), vec3(...mean), float(w)),
      ).forEach((value, c) => expect(value).toBe(mean[c]));
  });

  it("keeps actual packed linear-rock contrast under deterministic independent pairing, including coarse CPU mip averages", async () => {
    const bytes = await readFile(
      new URL("rock-albedo-roughness.png", assetDirectory),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      expectedDigest("rock-albedo-roughness"),
    );
    const png = PNG.sync.read(bytes);
    const reports: Array<{
      block: number;
      w: number;
      clipped: number;
      samples: number;
      moments: Array<{
        mean: number;
        linearRatio: number;
        correctedRatio: number;
      }>;
    }> = [];
    // These are reference linear box-filter levels, not the native GPU mip chain.
    // The stride is coprime to all power-of-two pixel counts, so B visits exactly
    // the same texels as A, in a different order; correlation is measured below.
    for (const block of [1, 4, 16]) {
      const size = png.width / block,
        count = size * size;
      const data = new Float64Array(count * 3);
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++)
          for (let c = 0; c < 3; c++)
            data[
              (Math.floor(y / block) * size + Math.floor(x / block)) * 3 + c
            ] +=
              srgbToLinear(png.data[(y * png.width + x) * 4 + c] / 255) /
              (block * block);
      for (const w of [0.25, 0.5, 0.75]) {
        const sums = Array.from({ length: 3 }, () => [0, 0, 0, 0, 0, 0]);
        let clipped = 0;
        const aNode = vec3(0),
          bNode = vec3(1);
        const node = blendCompactRockAlbedo(aNode, bNode, float(w));
        for (let i = 0; i < count; i++) {
          const j = (i * 65521 + 13579) % count;
          const output: number[] = [];
          for (let c = 0; c < 3; c++) {
            const a = data[i * 3 + c],
              b = data[j * 3 + c];
            const linear = (1 - w) * a + w * b;
            const raw = mean[c] + (linear - mean[c]) / Math.hypot(1 - w, w);
            clipped += Number(raw < 0 || raw > 1);
            const corrected = THREE.MathUtils.clamp(raw, 0, 1);
            output.push(corrected);
            const s = sums[c];
            s[0] += a;
            s[1] += a * a;
            s[2] += linear;
            s[3] += linear * linear;
            s[4] += corrected;
            s[5] += corrected * corrected;
          }
          // Execute the actual TSL arithmetic across real image samples too.
          if (i % Math.max(1, Math.floor(count / 32)) === 0) {
            const inputs = new Map<Node, readonly number[]>([
              [aNode, [...data.slice(i * 3, i * 3 + 3)]],
              [bNode, [...data.slice(j * 3, j * 3 + 3)]],
            ]);
            vectorValue(node, inputs).forEach((value, c) =>
              expect(value).toBeCloseTo(output[c], 13),
            );
          }
        }
        const moments = sums.map((s, c) => {
          const variance = s[1] / count - (s[0] / count) ** 2;
          expect(s[0] / count).toBeCloseTo(mean[c], 10);
          expect(Math.abs(s[4] / count - mean[c])).toBeLessThan(5e-5);
          const linearRatio = (s[3] / count - (s[2] / count) ** 2) / variance;
          const correctedRatio =
            (s[5] / count - (s[4] / count) ** 2) / variance;
          expect(linearRatio).toBeLessThan(0.7);
          expect(correctedRatio).toBeGreaterThan(0.95);
          expect(correctedRatio).toBeLessThan(1.05);
          return { mean: s[4] / count, linearRatio, correctedRatio };
        });
        expect(clipped / (count * 3)).toBeLessThan(0.001);
        reports.push({ block, w, clipped, samples: count, moments });
      }
    }
    console.info(
      "Dual rock linear sample/mip-reference moments",
      JSON.stringify(reports),
    );
  });

  it("uses six paired rock projections with stable explicit gradients and no extra allocated texture", () => {
    const material = createTerrainMaterial(undefined, { compactPbr: true });
    try {
      const owner = material.compactTerrainSurface!;
      const colors = owner.getNode("rock", "albedo-roughness").value;
      const normals = owner.getNode("rock", "normal-ao").value;
      const nodes = new Set([
        ...graph(material.colorNode!),
        ...graph(material.normalNode!),
        ...graph(material.roughnessNode!),
        ...graph(material.aoNode!),
      ]);
      const samples = [...nodes].filter(
        (n) =>
          [colors, normals].includes(Reflect.get(n, "value")) &&
          Reflect.get(n, "uvNode"),
      );
      expect(samples).toHaveLength(12);
      const colorSamples = samples.filter(
        (n) => Reflect.get(n, "value") === colors,
      );
      for (const a of colorSamples) {
        const paired = samples.filter(
          (n) =>
            Reflect.get(n, "value") === normals &&
            Reflect.get(n, "uvNode") === Reflect.get(a, "uvNode"),
        );
        expect(paired).toHaveLength(1);
        const gradients: unknown = Reflect.get(a, "gradNode");
        expect(Array.isArray(gradients)).toBe(true);
        if (!Array.isArray(gradients) || gradients.length !== 2)
          throw new Error("Expected two actual texture gradients");
        expect(Reflect.get(paired[0], "gradNode")).toEqual(gradients);
        for (const gradient of gradients) {
          if (!(gradient instanceof THREE.Node))
            throw new Error("Expected gradient node");
          const derivatives = [...graph(gradient)].filter((n) =>
            ["dFdx", "dFdy"].includes(String(Reflect.get(n, "method"))),
          );
          expect(derivatives.length).toBeGreaterThan(0);
          for (const derivative of derivatives) {
            // Derivatives of the raw world plane, never floor/offset/rotation.
            const methods = [...graph(Reflect.get(derivative, "aNode"))].map(
              (n) => Reflect.get(n, "method"),
            );
            expect(methods).not.toContain("floor");
            expect(methods).not.toContain("sin");
            expect(methods).not.toContain("cos");
          }
        }
      }
      for (const axis of ["X", "Y", "Z"])
        expect(
          [...nodes].filter(
            (n) => Reflect.get(n, "name") === `compactRockAlbedo${axis}`,
          ),
        ).toHaveLength(1);
      expect(owner.getReceipt().textures).toHaveLength(6);
      expect(owner.getReceipt().surfaceSampleCount).toBe(20);
      expect(material.positionNode).toBeNull();
      expect(material.metalness).toBe(0);
    } finally {
      material.dispose();
    }
  });

  it("matches independent rotated normal frames on all signed axes and across projection bands", () => {
    const owner = new CompactTerrainTextureSet("https://assets.invalid");
    const encoded = [0.73, 0.36, 0.92];
    const axes = [
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
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, -1],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ];
    try {
      for (const [nv, tv, bv] of axes) {
        const n = new THREE.Vector3(...nv),
          t = new THREE.Vector3(...tv),
          b = new THREE.Vector3(...bv);
        const q = n.clone().cross(t);
        for (const noise of [
          -1e-8,
          0,
          0.137,
          7 / 32 - 1e-8,
          7 / 32 + 1e-8,
          1,
        ]) {
          const layers = createCompactTerrainLayers(
            owner,
            float(0),
            float(noise),
          );
          const inputs = new Map<Node, readonly number[]>([
            [positionWorld, [350, 28, 320]],
            [normalWorldGeometry, nv],
          ]);
          for (const node of graph(layers.rock.worldNormal)) {
            const method = Reflect.get(node, "method");
            if (method === "dFdx" || method === "dFdy") {
              const operand: unknown = Reflect.get(node, "aNode");
              if (!(operand instanceof THREE.Node))
                throw new Error("Missing derivative operand");
              const shifted = new Map(inputs),
                delta = method === "dFdx" ? t : q;
              shifted.set(
                positionWorld,
                new THREE.Vector3(350, 28, 320).add(delta).toArray(),
              );
              const a = vectorValue(operand, inputs),
                z = vectorValue(operand, shifted);
              inputs.set(
                node,
                z.map((v, c) => v - a[c]),
              );
            }
            if (
              Reflect.get(node, "value") ===
                owner.getNode("rock", "normal-ao").value &&
              Reflect.get(node, "uvNode")
            )
              inputs.set(node, [...encoded, 1]);
          }
          const id = Math.floor(noise * 32);
          const expectedProjection = (index: number) => {
            const angle = index * 2.399963229728653;
            const u = (encoded[0] * 2 - 1) * 0.4,
              v = (encoded[1] * 2 - 1) * 0.4;
            return n
              .clone()
              .multiplyScalar(encoded[2] * 2 - 1)
              .addScaledVector(t, Math.cos(angle) * u + Math.sin(angle) * v)
              .addScaledVector(b, -Math.sin(angle) * u + Math.cos(angle) * v)
              .normalize();
          };
          const expected = expectedProjection(id)
            .lerp(expectedProjection(id + 1), smooth(noise * 32 - id))
            .normalize();
          const actual = new THREE.Vector3(
            ...vectorValue(layers.rock.worldNormal, inputs),
          );
          expect(actual.distanceTo(expected)).toBeLessThan(1e-10);
          expect(actual.length()).toBeCloseTo(1, 12);
          expect(actual.dot(n)).toBeGreaterThan(0);
        }
      }
    } finally {
      owner.dispose();
    }
  });

  it("breaks the old 2.7m packed-rock stamp with real linear bilinear samples and continuous incoming projections", async () => {
    const png = PNG.sync.read(
      await readFile(new URL("rock-albedo-roughness.png", assetDirectory)),
    );
    const sample = (uv: number[]) => {
      const x = uv[0] * png.width - 0.5,
        y = uv[1] * png.height - 0.5;
      const ix = Math.floor(x),
        iy = Math.floor(y),
        fx = x - ix,
        fy = y - iy;
      const at = (a: number, b: number, c: number) =>
        srgbToLinear(
          png.data[
            ((((b % png.height) + png.height) % png.height) * png.width +
              (((a % png.width) + png.width) % png.width)) *
              4 +
              c
          ] / 255,
        );
      return [0, 1, 2].map(
        (c) =>
          (at(ix, iy, c) * (1 - fx) + at(ix + 1, iy, c) * fx) * (1 - fy) +
          (at(ix, iy + 1, c) * (1 - fx) + at(ix + 1, iy + 1, c) * fx) * fy,
      );
    };
    const blended = (x: number, y: number, noise: number) => {
      const p = createCompactGroundProjections(
        vec2(x, y),
        float(noise),
        1 / 2.7,
        vec2(1, 0),
        vec2(0, 1),
      );
      const a = sample(vectorValue(p.a.uv)),
        b = sample(vectorValue(p.b.uv));
      return vectorValue(
        blendCompactRockAlbedo(vec3(...a), vec3(...b), p.weight),
      );
    };
    let oldError = 0,
      newError = 0;
    for (let i = 0; i < 128; i++) {
      const x = 240 + i * 0.73,
        y = -12 + (i % 23) * 0.61;
      const a = sample([x / 2.7, y / 2.7]),
        b = sample([(x + 2.7) / 2.7, y / 2.7]);
      const c = blended(x, y, sampleNoiseCPU(x, 310, 0.0008));
      const d = blended(x + 2.7, y, sampleNoiseCPU(x + 2.7, 310, 0.0008));
      for (let k = 0; k < 3; k++) {
        oldError += (a[k] - b[k]) ** 2;
        newError += (c[k] - d[k]) ** 2;
      }
    }
    expect(Math.sqrt(oldError / 384)).toBeLessThan(1e-10);
    expect(Math.sqrt(newError / 384)).toBeGreaterThan(1 / 255);
    for (const id of [-3, 0, 7, 19, 32]) {
      const a = blended(350, 12, id / 32 - 1e-8),
        b = blended(350, 12, id / 32 + 1e-8);
      a.forEach((value, c) => expect(value).toBeCloseTo(b[c], 12));
    }
    console.info(
      "Dual rock packed-linear repeat RMS",
      JSON.stringify({
        old: Math.sqrt(oldError / 384),
        candidate: Math.sqrt(newError / 384),
      }),
    );
  });
});

describe("candidate coastal mineral-to-meadow ground", () => {
  const candidateProfile = () =>
    validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });

  describe("explicit shore-contact-v1 center-preserving pond soil", () => {
    const ops = createCompactTerrainColorOperations();
    const descriptor = ops.validatePondDistribution({
      id: "shore-contact-v1",
      soilFullHeight: 0.055,
      soilEndHeight: 0.165,
    });
    const smooth = (a: number, b: number, value: number) => {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const math = {
      constant: (value: number) => value,
      add: (a: number, b: number) => a + b,
      sub: (a: number, b: number) => a - b,
      mul: (a: number, b: number) => a * b,
      div: (a: number, b: number) => a / b,
      min: Math.min,
      max: Math.max,
      clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
      smoothstep: smooth,
    };

    it("shares a frozen, centered coverage kernel with exact pure endpoints and no texture nodes", () => {
      expect(descriptor).toEqual({
        id: "shore-contact-v1",
        soilFullHeight: 0.055,
        soilEndHeight: 0.165,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect((descriptor.soilFullHeight + descriptor.soilEndHeight) / 2).toBe(
        0.11,
      );
      for (const noise of [0, 0.2, 0.5, 0.8, 1]) {
        const noiseHeight = (noise - 0.5) * 0.12;
        let previous = 1;
        for (const height of [-1, 0, 0.055, 0.08, 0.11, 0.14, 0.165, 0.22, 1]) {
          const relativeHeight = height + noiseHeight;
          const cpu = ops.pondSoilCoverage(
            relativeHeight,
            noise,
            descriptor,
            math,
          );
          const nodes = createCompactPondSurfaceWeights(
            vec3(0, relativeHeight, 0),
            float(noise),
            vec4(0, 0, 7.5, 0),
            descriptor,
          );
          const value = vectorValue(nodes.soil)[0];
          const expected = 1 - smooth(0.055, 0.165, height);
          expect(value).toBeCloseTo(expected, 14);
          expect(value).toBeCloseTo(cpu, 14);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(previous);
          previous = value;
          if (height < 0.055) expect(value).toBe(1);
          if (height > 0.165) expect(value).toBe(0);
          if (height === 0.11) expect(value).toBeCloseTo(0.5, 14);
          expect(
            [...graph(nodes.soil)].some((node) =>
              node.type.includes("Texture"),
            ),
          ).toBe(false);
        }
      }
      for (const [height, expected] of [
        [0.055, 1],
        [0.165, 0],
      ] as const)
        expect(
          vectorValue(
            createCompactPondSurfaceWeights(
              vec3(0, height, 0),
              float(0.5),
              vec4(0, 0, 7.5, 0),
              descriptor,
            ).soil,
          )[0],
        ).toBe(expected);
    });

    it("keeps legacy cliff soil, radial exclusion, wetness and sediment domain exact across current pond samples", () => {
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
      const parameters = vec4(
        pond.centerX,
        pond.centerZ,
        pond.radius,
        pond.surfaceY,
      );
      for (const distance of [
        0,
        pond.radius,
        pond.radius + 2.25,
        pond.radius + 2.625,
        pond.radius + 3,
        pond.radius + 20,
      ])
        for (const height of [-0.2, 0, 0.055, 0.11, 0.165, 0.22, 0.6])
          for (const noise of [0, 0.5, 1]) {
            const input = {
              x: pond.centerX + distance,
              z: pond.centerZ,
              height: pond.surfaceY + height,
              pond,
              noiseValue: noise,
            };
            const world = vec3(input.x, input.height, input.z);
            const original = createCompactPondSurfaceWeights(
              world,
              float(noise),
              parameters,
            );
            const candidate = createCompactPondSurfaceWeights(
              world,
              float(noise),
              parameters,
              descriptor,
            );
            const cpu = ops.pondWeights(input, descriptor);
            const historical = ops.pondWeights(input);
            expect(original).not.toHaveProperty("cliffSoil");
            expect(candidate.cliffSoil).toBeDefined();
            expect(vectorValue(candidate.cliffSoil!)).toEqual(
              vectorValue(original.soil),
            );
            expect(cpu.cliffSoil).toBe(historical.soil);
            expect(vectorValue(candidate.soil)[0]).toBeCloseTo(cpu.soil, 12);
            expect(vectorValue(candidate.wetness)).toEqual(
              vectorValue(original.wetness),
            );
            expect(cpu.wetness).toBe(historical.wetness);
            for (const key of ["region", "height", "noiseHeight"] as const)
              expect(vectorValue(candidate.domain[key])).toEqual(
                vectorValue(original.domain[key]),
              );
            expect(
              vectorValue(
                createCompactPondBankSediment(candidate.domain, float(0.17)),
              ),
            ).toEqual(
              vectorValue(
                createCompactPondBankSediment(original.domain, float(0.17)),
              ),
            );
            expect(graph(candidate.cliffSoil!).has(candidate.soil)).toBe(false);
            expect(graph(candidate.wetness).has(candidate.soil)).toBe(false);
            if (distance >= pond.radius + 3) {
              expect(vectorValue(candidate.soil)[0]).toBe(0);
              expect(vectorValue(candidate.cliffSoil!)[0]).toBe(0);
              expect(cpu).toEqual({ soil: 0, wetness: 0, cliffSoil: 0 });
            }
          }
    });

    it("changes soil competition without changing cliff classification or full-road priority, with one conserved PBR vector", () => {
      const layer = (
        color: [number, number, number],
        roughness: number,
        ao: number,
        normal: [number, number, number],
        height?: number,
      ): CompactTerrainLayer => ({
        albedo: vec3(...color),
        roughness: float(roughness),
        ao: float(ao),
        worldNormal: vec3(...normal),
        ...(height === undefined ? {} : { height: float(height) }),
      });
      const layers = {
        grass: layer([0.12, 0.28, 0.08], 0.91, 0.83, [0, 1, 0], 0.25),
        dirt: layer([0.31, 0.18, 0.09], 0.82, 0.72, [0.6, 0.8, 0], 0.62),
        rock: layer([0.47, 0.41, 0.36], 0.75, 0.68, [0, 0.8, 0.6]),
      };
      const view = new Map<Node, readonly number[]>([
        [cameraViewMatrix, new THREE.Matrix4().toArray()],
      ]);
      let changed = 0;
      for (const height of [-0.1, 0.04, 0.08, 0.11, 0.14, 0.18, 0.3])
        for (const slope of [0, 0.12, 0.24, 0.9])
          for (const road of [0, 0.35, 1]) {
            const surface = (selected: boolean) => {
              const pond = createCompactPondSurfaceWeights(
                vec3(0, height, 0),
                float(0.5),
                vec4(0, 0, 7.5, 0),
                selected ? descriptor : undefined,
              );
              const weights = createCompactTerrainLayerWeights(
                float(0.63),
                float(slope),
                float(road),
                float(0.5),
                pond,
              );
              return {
                pond,
                weights,
                result: blendCompactTerrainLayers(
                  layers,
                  weights.dirt,
                  weights.cliff,
                  weights.road,
                ),
              };
            };
            const old = surface(false),
              candidate = surface(true);
            expect(vectorValue(candidate.weights.cliff)).toEqual(
              vectorValue(old.weights.cliff),
            );
            expect(vectorValue(candidate.weights.geometricCliff)).toEqual(
              vectorValue(old.weights.geometricCliff),
            );
            expect(vectorValue(candidate.weights.road)).toEqual(
              vectorValue(old.weights.road),
            );
            expect(
              graph(candidate.weights.cliff).has(candidate.pond.soil),
            ).toBe(false);
            expect(
              graph(candidate.weights.cliff).has(candidate.pond.cliffSoil!),
            ).toBe(true);
            const result = candidate.result;
            const weights = vectorValue(result.weights!);
            expect(
              weights.every(
                (value) => Number.isFinite(value) && value >= 0 && value <= 1,
              ),
            ).toBe(true);
            expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 13);
            expect(weights[3]).toBe(0);
            for (const key of ["albedo", "roughness", "ao"] as const) {
              expect(graph(result[key]).has(result.weights!)).toBe(true);
              vectorValue(result[key]).forEach((value, channel) =>
                expect(value).toBeCloseTo(
                  Object.values(layers).reduce(
                    (sum, item, index) =>
                      sum + vectorValue(item[key])[channel] * weights[index],
                    0,
                  ),
                  12,
                ),
              );
              if (road === 1)
                expect(vectorValue(result[key])).toEqual(
                  vectorValue(old.result[key]),
                );
            }
            expect(graph(result.normal).has(result.weights!)).toBe(true);
            const normal = new THREE.Vector3();
            Object.values(layers).forEach((item, index) =>
              normal.addScaledVector(
                new THREE.Vector3(
                  ...(vectorValue(item.worldNormal) as [
                    number,
                    number,
                    number,
                  ]),
                ),
                weights[index],
              ),
            );
            normal.normalize();
            vectorValue(result.normal, view).forEach((value, index) =>
              expect(value).toBeCloseTo(normal.toArray()[index], 12),
            );
            if (road === 1) {
              expect(weights).toEqual([0, 1, 0, 0]);
              expect(vectorValue(result.normal, view)).toEqual(
                vectorValue(old.result.normal, view),
              );
            }
            if (
              vectorValue(candidate.weights.dirt)[0] !==
              vectorValue(old.weights.dirt)[0]
            )
              changed++;
          }
      expect(changed).toBeGreaterThan(0);
    });

    it("retains legacy cliff, contact and wetness references in the actual selected material graph without more reads", () => {
      const base = {
        compactPbr: true,
        compactSurfaceBlend: "height-v1" as const,
        compactDirtProjection: "stochastic-v1" as const,
        compactRockProjection: "stochastic-v1" as const,
        compactProfile: candidateProfile(),
        compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
      };
      const materials = [
        undefined,
        "relief-v1",
        "relief-contact-v1",
        "shore-contact-v1",
      ].map((mode) =>
        createTerrainMaterial(undefined, {
          ...base,
          compactPondBlend: mode as
            "relief-v1" | "relief-contact-v1" | "shore-contact-v1" | undefined,
        }),
      );
      try {
        for (const material of materials) {
          const selected = material.compactPondBlend === "shore-contact-v1";
          const roots = [
            material.colorNode!,
            material.normalNode!,
            material.roughnessNode!,
            material.aoNode!,
          ];
          const all = new Set(roots.flatMap((root) => [...graph(root)]));
          const named = (name: string) =>
            [...all].filter((node) => Reflect.get(node, "name") === name);
          const soil = named("compactPondShoreSoil"),
            legacy = named("compactPondLegacySoil"),
            marginSoil = named("compactPondMarginSoil");
          expect(soil).toHaveLength(selected ? 1 : 0);
          expect(legacy).toHaveLength(selected ? 1 : 0);
          expect(marginSoil).toHaveLength(selected ? 1 : 0);
          const diagnostic = material.getCompactTerrainDiagnosticOutputs()!;
          if (selected) {
            // Review62 evolves this unpromoted mode; the centered coverage is
            // retained inside the shared final margin, not used as the output.
            expect(diagnostic.sources.pondSoil).toBe(marginSoil[0]);
            expect(graph(marginSoil[0]).has(soil[0])).toBe(true);
            expect(
              graph(diagnostic.sources.effectiveCliff).has(legacy[0]),
            ).toBe(true);
            expect(graph(diagnostic.sources.effectiveCliff).has(soil[0])).toBe(
              false,
            );
            expect(graph(diagnostic.sources.pondWetness).has(soil[0])).toBe(
              false,
            );
            const contact = named("compactPondRockContactExposure");
            expect(contact).toHaveLength(1);
            expect(graph(contact[0]).has(legacy[0])).toBe(true);
            expect(graph(contact[0]).has(soil[0])).toBe(false);
            for (const name of [
              "compactPondMarginCover",
              "compactPondMarginExposure",
            ]) {
              const nodes = named(name);
              expect(nodes).toHaveLength(1);
              expect(graph(marginSoil[0]).has(nodes[0])).toBe(true);
              expect(graph(contact[0]).has(nodes[0])).toBe(false);
              expect(graph(diagnostic.sources.pondWetness).has(nodes[0])).toBe(
                false,
              );
              expect(
                graph(diagnostic.sources.effectiveCliff).has(nodes[0]),
              ).toBe(false);
            }
            const shade = named("compactPondMarginShade");
            expect(shade).toHaveLength(1);
            expect(graph(material.colorNode!).has(shade[0])).toBe(true);
            for (const root of roots.slice(1))
              expect(graph(root).has(shade[0])).toBe(false);
            for (const root of roots) {
              expect(graph(root).has(diagnostic.sources.weights)).toBe(true);
              expect(graph(root).has(soil[0])).toBe(true);
              expect(graph(root).has(marginSoil[0])).toBe(true);
            }
            expect(
              Object.getOwnPropertyDescriptor(material, "compactPondBlend"),
            ).toEqual({
              value: "shore-contact-v1",
              writable: false,
              enumerable: true,
              configurable: false,
            });
          }
          if (!selected)
            expect(
              [...all].some((node) =>
                String(Reflect.get(node, "name")).startsWith(
                  "compactPondMargin",
                ),
              ),
            ).toBe(false);
          const receipt = material.compactTerrainSurface!.getReceipt();
          expect(receipt.textures).toHaveLength(7);
          expect(receipt.surfaceSampleCount).toBe(33);
          const owned = new Set(
            receipt.textures.map((entry) => entry.textureUuid),
          );
          expect(
            [...all].filter((node) => {
              const value: unknown = Reflect.get(node, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(node, "uvNode")
              );
            }),
          ).toHaveLength(33);
          for (const key of [
            "positionNode",
            "vertexNode",
            "geometryNode",
            "displacementMap",
          ] as const)
            expect(material[key]).toBeNull();
        }
      } finally {
        materials.forEach((material) => material.dispose());
      }
    });

    const marginInput = (): CompactPondMarginInput<number> => {
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
      return {
        x: pond.centerX + pond.radius,
        z: pond.centerZ,
        height: pond.surfaceY + 0.15,
        slope: 0.04,
        meadowNoise: 0.5,
        distortNoise: 0.5,
        roadInfluence: 0,
        pond,
        field: ops.macroField(
          candidateProfile(),
          undefined,
          "shore-contact-v1",
        ),
      };
    };
    const marginNodes = (input: CompactPondMarginInput<number>) =>
      createCompactPondMargin({
        ...input,
        x: float(input.x),
        z: float(input.z),
        height: float(input.height),
        slope: float(input.slope),
        meadowNoise: float(input.meadowNoise),
        distortNoise: float(input.distortNoise),
        roadInfluence: float(input.roadInfluence),
        pond: input.pond
          ? {
              centerX: float(input.pond.centerX),
              centerZ: float(input.pond.centerZ),
              radius: float(input.pond.radius),
              surfaceY: float(input.pond.surfaceY),
            }
          : null,
      });

    it("evaluates the actual shared pond margin against independent world-space recipe arithmetic", () => {
      const base = marginInput(),
        pond = base.pond!;
      const recipe = ops.getPondMarginRecipe();
      expect(Object.isFrozen(recipe)).toBe(true);
      let coverWitnesses = 0,
        exposureWitnesses = 0;
      for (let i = 0; i < 180; i++) {
        const input = {
          ...base,
          x: pond.centerX + [6.8, 7.5, 8.5, 9.1, 10.4, 10.5][i % 6],
          z: pond.centerZ + [0, 0.5, -0.5][Math.floor(i / 6) % 3],
          height:
            pond.surfaceY +
            [0.04, 0.11, 0.15, 0.4, 0.7][Math.floor(i / 18) % 5],
          slope: [0.02, 0.1, 0.18, 0.22][Math.floor(i / 5) % 4],
          meadowNoise: [-1, 0.25, 0.5, 0.8, 2][Math.floor(i / 3) % 5],
          distortNoise: [0.2, 0.5, 0.8][i % 3],
          roadInfluence: [0, 0.2, 0.8][Math.floor(i / 15) % 3],
        };
        const squaredDistance =
          (input.x - pond.centerX) ** 2 + (input.z - pond.centerZ) ** 2;
        const h = input.height - pond.surfaceY;
        const locality =
          (1 -
            smooth(
              (pond.radius + 1) ** 2,
              (pond.radius + 3) ** 2,
              squaredDistance,
            )) *
          smooth(0.035, 0.105, h) *
          (1 - smooth(0.35, 0.85, h)) *
          (1 - smooth(0.08, 0.22, math.clamp(input.slope, 0, 1))) *
          (1 - smooth(0, 0.8, input.roadInfluence));
        const patch = smooth(
          0.4,
          0.55,
          math.clamp(input.meadowNoise, 0, 1) * 0.65 +
            math.clamp(input.distortNoise, 0, 1) * 0.35,
        );
        const expected = {
          cover: 0.75 * locality * patch,
          exposure: 0.45 * locality * (1 - patch),
          shade: 1 - 0.22 * locality * (0.3 + 0.7 * (1 - patch)),
          clumpScale: 1 - 0.45 * locality * (0.35 + 0.65 * patch),
        };
        const cpu = ops.pondMargin(input, math),
          actual = marginNodes(input);
        const wrapper = ops.pondMarginAt({
          noiseValue: input.distortNoise,
          meadowNoise: input.meadowNoise,
          distortNoise: input.distortNoise,
          slope: input.slope,
          roadInfluence: input.roadInfluence,
          surface: {
            x: input.x,
            z: input.z,
            height: input.height,
            pond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
            macroField: input.field,
          },
        });
        for (const key of [
          "cover",
          "exposure",
          "shade",
          "clumpScale",
        ] as const) {
          const value = vectorValue(actual[key])[0];
          expect(value).toBeCloseTo(expected[key], 13);
          expect(value).toBeCloseTo(cpu[key], 13);
          expect(value).toBeCloseTo(wrapper[key], 13);
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(
            [...graph(actual[key])].every(
              (node) =>
                !/Texture|Camera/.test(node.type) && node !== cameraViewMatrix,
            ),
          ).toBe(true);
        }
        if (cpu.cover > 0) coverWitnesses++;
        if (cpu.exposure > 0) exposureWitnesses++;
      }
      expect(coverWitnesses).toBeGreaterThan(0);
      expect(exposureWitnesses).toBeGreaterThan(0);
      const shifted = {
        ...base,
        x: base.x + 64,
        z: base.z - 32,
        height: base.height + 8,
        pond: {
          ...pond,
          centerX: pond.centerX + 64,
          centerZ: pond.centerZ - 32,
          surfaceY: pond.surfaceY + 8,
        },
      };
      const translated = marginNodes(shifted),
        original = marginNodes(base);
      for (const key of ["cover", "exposure", "shade", "clumpScale"] as const)
        expect(vectorValue(translated[key])).toEqual(
          vectorValue(original[key]),
        );
    });

    it("keeps the pond margin exactly neutral outside admission, water, slope, road and radial bounds", () => {
      const base = marginInput(),
        pond = base.pond!;
      const neutral = { cover: 0, exposure: 0, shade: 1, clumpScale: 1 };
      const cases: CompactPondMarginInput<number>[] = [
        { ...base, pond: null },
        { ...base, field: null },
        { ...base, field: ops.macroField(candidateProfile()) },
        {
          ...base,
          field: ops.macroField(candidateProfile(), undefined, "relief-v1"),
        },
        {
          ...base,
          field: ops.macroField(
            candidateProfile(),
            undefined,
            "relief-contact-v1",
          ),
        },
        { ...base, x: pond.centerX + pond.radius + 3 },
        { ...base, x: pond.centerX - pond.radius - 3 },
        { ...base, z: pond.centerZ + pond.radius + 30 },
        { ...base, height: pond.surfaceY - 1 },
        { ...base, height: pond.surfaceY + 0.035 - 1e-12 },
        { ...base, height: pond.surfaceY + 0.85 + 1e-12 },
        { ...base, slope: 0.22 },
        { ...base, slope: 2 },
        { ...base, roadInfluence: 0.8 },
        { ...base, roadInfluence: 1 },
      ];
      for (const input of cases) {
        const actual = marginNodes(input);
        expect(ops.pondMargin(input, math)).toEqual(neutral);
        for (const key of ["cover", "exposure", "shade", "clumpScale"] as const)
          expect(vectorValue(actual[key])[0]).toBe(neutral[key]);
      }
      expect(() =>
        createCompactPondSurfaceWeights(
          vec3(base.x, base.height, base.z),
          float(0.5),
          vec4(pond.centerX, pond.centerZ, pond.radius, pond.surfaceY),
          undefined,
          marginNodes(base),
        ),
      ).toThrow("Pond margin requires the admitted pond distribution");
    });

    it("transfers selected pond soil in both directions without changing historical wetness, cliff or sediment inputs", () => {
      const base = marginInput(),
        pond = base.pond!;
      const parameters = vec4(
        pond.centerX,
        pond.centerZ,
        pond.radius,
        pond.surfaceY,
      );
      let covered = 0,
        exposed = 0;
      for (const height of [0.07, 0.11, 0.15, 0.3, 0.5])
        for (const meadowNoise of [0, 0.5, 1]) {
          const input = {
            ...base,
            height: pond.surfaceY + height,
            meadowNoise,
          };
          const world = vec3(input.x, input.height, input.z);
          const margin = marginNodes(input),
            cpu = ops.pondMargin(input, math);
          const before = createCompactPondSurfaceWeights(
            world,
            float(0.5),
            parameters,
            descriptor,
          );
          const after = createCompactPondSurfaceWeights(
            world,
            float(0.5),
            parameters,
            descriptor,
            margin,
          );
          const oldSoil = vectorValue(before.soil)[0],
            newSoil = vectorValue(after.soil)[0];
          const expected = oldSoil * (1 - cpu.cover);
          expect(newSoil).toBeCloseTo(
            expected + (1 - expected) * cpu.exposure,
            14,
          );
          expect(newSoil).toBeGreaterThanOrEqual(0);
          expect(newSoil).toBeLessThanOrEqual(1);
          if (newSoil < oldSoil) covered++;
          if (newSoil > oldSoil) exposed++;
          expect(vectorValue(after.wetness)).toEqual(
            vectorValue(before.wetness),
          );
          expect(vectorValue(after.cliffSoil!)).toEqual(
            vectorValue(before.cliffSoil!),
          );
          for (const key of ["region", "height", "noiseHeight"] as const)
            expect(vectorValue(after.domain[key])).toEqual(
              vectorValue(before.domain[key]),
            );
          expect(
            vectorValue(
              createCompactPondBankSediment(after.domain, float(0.14)),
            ),
          ).toEqual(
            vectorValue(
              createCompactPondBankSediment(before.domain, float(0.14)),
            ),
          );
          for (const road of [0, 0.4, 1]) {
            const prior = createCompactTerrainLayerWeights(
              float(0.5),
              float(0.14),
              float(road),
              float(0.5),
              before,
            );
            const result = createCompactTerrainLayerWeights(
              float(0.5),
              float(0.14),
              float(road),
              float(0.5),
              after,
            );
            for (const key of ["cliff", "geometricCliff", "road"] as const)
              expect(vectorValue(result[key])).toEqual(vectorValue(prior[key]));
          }
        }
      expect(covered).toBeGreaterThan(0);
      expect(exposed).toBeGreaterThan(0);
    });

    it("grades grass reflectance only and conserves every actual final PBR layer contribution", () => {
      const base = marginInput();
      const layer = (
        color: [number, number, number],
        roughness: number,
        ao: number,
        normal: [number, number, number],
        height: number,
      ): CompactTerrainLayer => ({
        albedo: vec3(...color),
        roughness: float(roughness),
        ao: float(ao),
        worldNormal: vec3(...normal),
        height: float(height),
      });
      const layers = {
        grass: layer([0.1, 0.3, 0.08], 0.95, 0.82, [0, 1, 0], 0.4),
        dirt: layer([0.3, 0.19, 0.12], 0.85, 0.77, [0.6, 0.8, 0], 0.5),
        rock: layer([0.42, 0.37, 0.3], 0.74, 0.69, [0, 0.8, 0.6], 0.6),
      };
      const view = new Map<Node, readonly number[]>([
        [cameraViewMatrix, new THREE.Matrix4().toArray()],
      ]);
      for (const meadowNoise of [0, 0.5, 1]) {
        const input = { ...base, meadowNoise },
          margin = marginNodes(input);
        const grass = applyCompactPondMarginGrass(layers.grass, margin);
        for (const key of ["roughness", "ao", "worldNormal", "height"] as const)
          expect(grass[key]).toBe(layers.grass[key]);
        expect(layers.grass.albedo).not.toBe(grass.albedo);
        const shade = vectorValue(margin.shade)[0];
        vectorValue(grass.albedo).forEach((v, i) =>
          expect(v).toBeCloseTo(
            vectorValue(layers.grass.albedo)[i] * shade,
            14,
          ),
        );
        const pond = input.pond!;
        const surface = createCompactPondSurfaceWeights(
          vec3(input.x, input.height, input.z),
          float(0.5),
          vec4(pond.centerX, pond.centerZ, pond.radius, pond.surfaceY),
          descriptor,
          margin,
        );
        for (const road of [0, 0.4, 1]) {
          const coverage = createCompactTerrainLayerWeights(
            float(0.5),
            float(0.14),
            float(road),
            float(0.5),
            surface,
          );
          const selectedLayers = { ...layers, grass };
          const result = blendCompactTerrainLayers(
            selectedLayers,
            coverage.dirt,
            coverage.cliff,
            coverage.road,
          );
          const weights = vectorValue(result.weights!);
          expect(
            weights.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
          ).toBe(true);
          expect(weights.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 14);
          for (const key of ["albedo", "roughness", "ao"] as const) {
            expect(graph(result[key]).has(result.weights!)).toBe(true);
            vectorValue(result[key]).forEach((v, channel) =>
              expect(v).toBeCloseTo(
                Object.values(selectedLayers).reduce(
                  (sum, l, i) =>
                    sum + vectorValue(l[key])[channel] * weights[i],
                  0,
                ),
                13,
              ),
            );
          }
          const normal = new THREE.Vector3();
          Object.values(selectedLayers).forEach((l, i) =>
            normal.addScaledVector(
              new THREE.Vector3(
                ...(vectorValue(l.worldNormal) as [number, number, number]),
              ),
              weights[i],
            ),
          );
          normal.normalize();
          expect(graph(result.normal).has(result.weights!)).toBe(true);
          vectorValue(result.normal, view).forEach((v, i) =>
            expect(v).toBeCloseTo(normal.toArray()[i], 13),
          );
          if (road === 1) {
            expect(weights).toEqual([0, 1, 0, 0]);
            expect(vectorValue(result.albedo)).toEqual(
              vectorValue(layers.dirt.albedo),
            );
          }
        }
      }
    });

    it("rejects missing pond/PBR/height admission and altered or accessor-based descriptors", () => {
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
      const base = {
        compactPbr: true,
        compactSurfaceBlend: "height-v1" as const,
        compactProfile: candidateProfile(),
        compactPond: pond,
        compactPondBlend: "shore-contact-v1" as const,
      };
      for (const compactPond of [null, undefined])
        expect(() =>
          createTerrainMaterial(undefined, { ...base, compactPond }),
        ).toThrow("admitted compact pond");
      expect(() =>
        createTerrainMaterial(undefined, {
          ...base,
          compactSurfaceBlend: undefined,
        }),
      ).toThrow("height-v1");
      expect(() =>
        createTerrainMaterial(undefined, {
          ...base,
          compactPbr: false,
          compactSurfaceBlend: undefined,
        }),
      ).toThrow("compact PBR");
      let getterCalls = 0;
      for (const invalid of [
        { ...descriptor, soilFullHeight: 0.12 },
        { ...descriptor, soilEndHeight: 0.22 },
        { ...descriptor, extra: true },
        {
          ...descriptor,
          get soilFullHeight() {
            getterCalls++;
            return 0.055;
          },
        },
      ])
        expect(() =>
          createCompactPondSurfaceWeights(
            vec3(0, 0.1, 0),
            float(0.5),
            vec4(0, 0, 7.5, 0),
            invalid as typeof descriptor,
          ),
        ).toThrow("Invalid compact pond distribution");
      expect(getterCalls).toBe(0);
    });
  });

  describe("explicit shared distribution-v1 coastal succession", () => {
    const numericMath = {
      constant: (v: number) => v,
      add: (a: number, b: number) => a + b,
      sub: (a: number, b: number) => a - b,
      mul: (a: number, b: number) => a * b,
      div: (a: number, b: number) => a / b,
      min: Math.min,
      max: Math.max,
      clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
      smoothstep: (a: number, b: number, v: number) => {
        const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
        return t * t * (3 - 2 * t);
      },
    };

    it("captures a frozen measured descriptor without changing historical macro fields", () => {
      const ops = createCompactTerrainColorOperations(),
        profile = candidateProfile(),
        old = ops.macroField(profile)!,
        detail = ops.macroField(profile, "detail-v1")!,
        candidate = ops.macroField(profile, "distribution-v1")!;
      expect(detail).toEqual(old);
      expect(old).not.toHaveProperty("coastalDistribution");
      const { coastalDistribution, ...rest } = candidate;
      expect(rest).toEqual(old);
      expect(coastalDistribution).toEqual({
        id: "distribution-v1",
        coastCoverageFull: 0.25,
        turfSlopeStart: 0.04,
        turfSlopeEnd: 0.09,
        bedrockSlopeStart: 0.11,
        bedrockSlopeEnd: 0.23,
        slopeNoise: 0.005,
      });
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(coastalDistribution)).toBe(true);
      for (const value of [null, "", "future", 1, {}])
        expect(() => ops.coastBlend(value)).toThrow(
          "Invalid compact coast blend",
        );
      const { southernMeadow: _candidate, ...historical } = profile;
      expect(_candidate).toBeDefined();
      expect(() => ops.macroField(historical, "distribution-v1")).toThrow(
        "admitted coastal meadow",
      );
    });

    it("evaluates one actual CPU/TSL kernel with full path/pond protection and calibrated low-shore neutrality", () => {
      const ops = createCompactTerrainColorOperations(),
        field = ops.macroField(candidateProfile(), "distribution-v1")!,
        pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        c = ops.getComposition();
      for (let i = 0; i < 180; i++) {
        const x = i % 6 === 0 ? pond.centerX : 420,
          z =
            i % 6 === 0
              ? pond.centerZ + pond.radius + c.pondBankReach - 0.01
              : 470,
          height = [16, 20, 24, 25, 26.5, 30][i % 6],
          slope = [0, 0.012, 0.025, 0.04, 0.065, 0.09, 0.1, 0.17, 0.23, 0.6][
            i % 10
          ],
          noiseValue = [0, 0.5, 1][Math.floor(i / 10) % 3],
          meadowNoise = [0.2, 0.5, 0.8][Math.floor(i / 30) % 3],
          road = i % 7 === 0 ? 1 : i % 7 === 1 ? 0.4 : 0,
          input = {
            x,
            z,
            height,
            slope,
            noiseValue,
            meadowNoise,
            road,
            pond,
            field,
          },
          expected = ops.coastalDistribution(input, numericMath),
          actual = createCompactCoastDistribution({
            x: float(x),
            z: float(z),
            height: float(height),
            slope: float(slope),
            noiseValue: float(noiseValue),
            meadowNoise: float(meadowNoise),
            road: float(road),
            pond: {
              centerX: float(pond.centerX),
              centerZ: float(pond.centerZ),
              radius: float(pond.radius),
            },
            field,
          });
        expect(vectorValue(actual.turfRetention)[0]).toBeCloseTo(
          expected.turfRetention,
          13,
        );
        expect(vectorValue(actual.bedrockShare)[0]).toBeCloseTo(
          expected.bedrockShare,
          13,
        );
        expect(
          Object.values(expected).every(
            (v) => Number.isFinite(v) && v >= 0 && v <= 1,
          ),
        ).toBe(true);
        expect(
          ops.coastalDistributionAt(
            {
              noiseValue,
              meadowNoise,
              distortNoise: 0.5,
              slope,
              surface: { x, z, height, pond, macroField: field },
            },
            road,
          ),
        ).toEqual(expected);
        if (road === 1 || i % 6 === 0 || slope <= 0.025 || height === 30)
          expect(expected.turfRetention).toBe(1);
      }
      for (const meadowNoise of [0, 0.5, 1]) {
        const base = {
          x: 420,
          z: 470,
          height: 24,
          noiseValue: 0.5,
          meadowNoise,
          road: 0,
          pond: null,
          field,
        };
        expect(
          ops.coastalDistribution({ ...base, slope: 0.095 }, numericMath)
            .turfRetention,
        ).toBe(0);
        expect(
          ops.coastalDistribution({ ...base, slope: 0.1 }, numericMath)
            .bedrockShare,
        ).toBe(0);
        expect(
          ops.coastalDistribution({ ...base, slope: 0.235 }, numericMath)
            .bedrockShare,
        ).toBe(1);
        expect(
          ops.coastalDistribution({ ...base, slope: 0.17 }, numericMath)
            .bedrockShare,
        ).toBeCloseTo(0.5, 14);
        expect(
          ops.coastalDistribution({ ...base, slope: 0.2, road: 1 }, numericMath)
            .turfRetention,
        ).toBe(1);
      }
    });

    it("shares a conserved nonnegative transfer without inventing grass or reducing existing bedrock", () => {
      const ops = createCompactTerrainColorOperations();
      for (const weights of [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [0, 0, 0, 0],
        [0.2, 0.3, 0.4, 0.1],
        [1e-30, 0, 2e-30, 0],
      ] as const)
        for (const turfRetention of [-1, 0, 0.2, 1, 2])
          for (const bedrockShare of [-1, 0, 0.6, 1, 2]) {
            const controls = { turfRetention, bedrockShare },
              cpu = ops.coastalDistributionWeights(
                weights,
                controls,
                numericMath,
              ),
              actual = vectorValue(
                applyCompactCoastDistributionWeights(vec4(...weights), {
                  turfRetention: float(turfRetention),
                  bedrockShare: float(bedrockShare),
                }),
              ),
              q = weights[0] * (1 - Math.max(0, Math.min(1, turfRetention))),
              r = q * Math.max(0, Math.min(1, bedrockShare)),
              expected = [
                weights[0] - q,
                weights[1] + q - r,
                weights[2] + r,
                weights[3],
              ],
              total = weights.reduce<number>((a, b) => a + b, 0);
            expect(actual).toEqual(cpu);
            actual.forEach((v, k) =>
              expect(v / Math.max(total, 1e-30)).toBeCloseTo(
                expected[k] / Math.max(total, 1e-30),
                13,
              ),
            );
            expect(actual.every((v) => Number.isFinite(v) && v >= 0)).toBe(
              true,
            );
            expect(actual[0]).toBeLessThanOrEqual(weights[0]);
            expect(actual[1]).toBeGreaterThanOrEqual(weights[1]);
            expect(actual[2]).toBeGreaterThanOrEqual(weights[2]);
            expect(actual[3]).toBe(weights[3]);
            if (turfRetention >= 1 || weights[0] === 0)
              expect(actual).toEqual(weights);
          }
    });

    it("updates actual root mean colors and post-coastal support using the same material reassignment", () => {
      const ops = createCompactTerrainColorOperations(),
        profile = candidateProfile(),
        old = ops.macroField(profile)!,
        field = ops.macroField(profile, "distribution-v1")!,
        palette = ops.getPalette(),
        c = ops.getComposition(),
        input = {
          noiseValue: 0.5,
          distortNoise: 0.5,
          meadowNoise: 0.5,
          slope: 0.1,
          roadInfluence: 0,
          surface: {
            x: 420,
            z: 470,
            height: 24,
            pond: null,
            macroField: field,
          },
        },
        baseline = { ...input, surface: { ...input.surface, macroField: old } },
        distribution = ops.coastalDistributionAt(input);
      expect(distribution).toEqual({ turfRetention: 0, bedrockShare: 0 });
      expect(ops.grassSupportBeforeCoast(input)).toBe(
        ops.grassSupportBeforeCoast(baseline),
      );
      expect(ops.grassSupport(baseline)).toBeGreaterThan(0);
      expect(ops.grassSupport(input)).toBe(0);
      const macro = ops.macroWeights(
          input.surface.x,
          input.surface.z,
          input.noiseValue,
          old,
        ),
        base = ops.weights({
          ...input,
          macroSurface: macro,
          pondSurface: { soil: 0, wetness: 0 },
        }),
        coast = ops.coastWeights({
          ...input.surface,
          noiseValue: 0.5,
          distortNoise: 0.5,
          slope: 0.1,
          westRock: macro.westRock,
          field: old,
        }),
        tint = ops.meadowTint(0.5, macro.dry, c.coastalMeadowTintStrength),
        authored = ops.havenGroundWeights(420, 470, old.havenGround, 0.1),
        coastal = ops.coastalGroundCover({
          height: 24,
          noiseValue: 0.5,
          distortNoise: 0.5,
          field: old,
        }),
        worn = ops.wornTurfWeights({
          x: 420,
          z: 470,
          meadowNoise: 0.5,
          distortNoise: 0.5,
          slope: 0.1,
          roadInfluence: 0,
          road: base.road,
          pondSoil: 0,
          coastalCoverage: coastal,
          field: old,
        }),
        g =
          (1 - base.dirt) *
          (1 - worn.soil) *
          (old.havenGround ? (1 - authored.talus) * (1 - authored.wear) : 1) *
          (1 - coastal) *
          (1 - base.cliff) *
          (1 - worn.road),
        before = ops.sample(baseline),
        after = ops.sample(input);
      expect(g).toBeGreaterThan(0);
      for (const [i, key] of (["r", "g", "b"] as const).entries())
        expect(after[key]).toBeCloseTo(
          before[key] +
            g * (palette.dirt[i] - palette.grass[i] * tint[i]) * base.variation,
          12,
        );
      expect(coast.wetness).toBe(0);
      expect(after).not.toEqual(before);
      for (const protectedInput of [
        { ...input, slope: 0.02 },
        { ...input, roadInfluence: 1 },
        { ...input, surface: { ...input.surface, height: 31 } },
        {
          ...input,
          surface: {
            ...input.surface,
            x: 343,
            z: 302,
            pond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
          },
        },
      ]) {
        const before = {
          ...protectedInput,
          surface: { ...protectedInput.surface, macroField: old },
        };
        expect(ops.sample(protectedInput)).toEqual(ops.sample(before));
        expect(ops.grassSupport(protectedInput)).toBe(ops.grassSupport(before));
      }
      // Agreement here is algebraic for mean colors and identical inputs.
      // Indexed/interpolated shader normals and worker finite-difference
      // normals differ: native blade-root/material contact remains a gate.
    });

    it("keeps selected distribution and actual root decomposition self-contained in a freshly minified isolated worker", async () => {
      const bundle = await build({
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
      const loaded: typeof import("../CompactTerrainPalette") = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
      );
      const ops = createCompactTerrainColorOperations(),
        profile = candidateProfile(),
        field = ops.macroField(profile, "distribution-v1")!,
        inputs = [0.02, 0.06, 0.095, 0.17, 0.25].flatMap((slope) =>
          [0, 0.5, 1].map((roadInfluence) => ({
            noiseValue: 0.5,
            distortNoise: 0.4,
            meadowNoise: 0.6,
            slope,
            roadInfluence,
            surface: {
              x: 420,
              z: 470,
              height: 24,
              pond: null,
              macroField: field,
            },
          })),
        );
      const worker = new Worker(
        `const {parentPort}=require('node:worker_threads');const ops=(${loaded.createCompactTerrainColorOperations.toString()})();const field=ops.macroField(${JSON.stringify(profile)},'distribution-v1');const inputs=${JSON.stringify(inputs)};parentPort.postMessage({field,frozen:Object.isFrozen(field.coastalDistribution),rows:inputs.map(input=>{input.surface.macroField=field;return {color:ops.sample(input),support:ops.grassSupport(input),priorSupport:ops.grassSupportBeforeCoast(input),distribution:ops.coastalDistributionAt(input)};})});`,
        { eval: true, env: {} },
      );
      try {
        const actual: unknown = await new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
        expect(actual).toEqual({
          field,
          frozen: true,
          rows: inputs.map((input) => ({
            color: ops.sample(input),
            support: ops.grassSupport(input),
            priorSupport: ops.grassSupportBeforeCoast(input),
            distribution: ops.coastalDistributionAt(input),
          })),
        });
      } finally {
        await worker.terminate();
      }
    });

    it("selects one final shared PBR vector without changing legacy graphs, seven maps or 33 samples", () => {
      const base = {
          compactPbr: true,
          compactSurfaceBlend: "height-v1" as const,
          compactDirtProjection: "stochastic-v1" as const,
          compactRockProjection: "stochastic-v1" as const,
          compactProfile: candidateProfile(),
          compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        },
        absent = createTerrainMaterial(undefined, base),
        detail = createTerrainMaterial(undefined, {
          ...base,
          compactCoastBlend: "detail-v1",
        }),
        candidate = createTerrainMaterial(undefined, {
          ...base,
          compactCoastBlend: "distribution-v1",
        });
      try {
        for (const material of [absent, detail, candidate]) {
          const roots = [
              material.colorNode!,
              material.roughnessNode!,
              material.aoNode!,
              material.normalNode!,
            ],
            all = new Set(roots.flatMap((root) => [...graph(root)])),
            final = [...all].filter(
              (node) =>
                Reflect.get(node, "name") ===
                "compactCoastDistributionSurfaceWeights",
            ),
            receipt = material.compactTerrainSurface!.getReceipt(),
            owned = new Set(receipt.textures.map((t) => t.textureUuid));
          expect(final).toHaveLength(material === candidate ? 1 : 0);
          expect(receipt.textures).toHaveLength(7);
          expect(receipt.surfaceSampleCount).toBe(33);
          expect(
            [...all].filter((node) => {
              const value: unknown = Reflect.get(node, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(node, "uvNode")
              );
            }),
          ).toHaveLength(33);
          if (material === candidate) {
            const diag = material.getCompactTerrainDiagnosticOutputs()!;
            expect(diag.sources.weights).toBe(final[0]);
            for (const root of roots)
              expect(graph(root).has(final[0])).toBe(true);
            for (const source of [
              diag.sources.pondSoil,
              diag.sources.pondWetness,
            ])
              expect(graph(source).has(final[0])).toBe(false);
            expect(
              [...all].filter(
                (node) =>
                  Reflect.get(node, "name") ===
                  "compactCoastDetailSurfaceWeights",
              ),
            ).toHaveLength(0);
          }
          expect(material.positionNode).toBeNull();
          expect(material.displacementMap).toBeNull();
        }
        expect(
          Object.getOwnPropertyDescriptor(candidate, "compactCoastBlend"),
        ).toEqual({
          value: "distribution-v1",
          enumerable: true,
          configurable: false,
          writable: false,
        });
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactSurfaceBlend: undefined,
            compactCoastBlend: "distribution-v1",
          }),
        ).toThrow("height-v1");
      } finally {
        absent.dispose();
        detail.dispose();
        candidate.dispose();
      }
    });
  });

  describe("explicit cavity-v1 source-aligned coastal boundary", () => {
    it("pins the raw packed AO mean independently of lighting strength or height", async () => {
      const c = COMPACT_TERRAIN_COAST_CAVITY;
      const bytes = await readFile(
        new URL("rock-normal-ao.png", assetDirectory),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        c.sourceSha256,
      );
      expect(c.sourceSha256).toBe(
        COMPACT_TERRAIN_TEXTURE_SHA256["rock-normal-ao"],
      );
      const image = PNG.sync.read(bytes);
      expect([image.width, image.height]).toEqual([1024, 1024]);
      let sum = 0;
      for (let i = 3; i < image.data.length; i += 4) sum += image.data[i];
      expect(sum / (255 * image.width * image.height)).toBe(c.rawAoMean);
      expect(Object.isFrozen(c)).toBe(true);
      expect(c).toMatchObject({
        rawAoMean: 0.9150973263908835,
        cavityGain: 2.4,
        maximumBias: 0.2,
        transitionStart: 0.22,
        transitionEnd: 0.78,
        coastCoverageFull: 0.25,
      });
      expect(c.maximumBias).toBeLessThan(c.transitionStart);
      expect(c.maximumBias).toBeLessThan(1 - c.transitionEnd);
    });

    it("conserves tiny and empty pair budgets, exact endpoints and protected weights with bounded monotone bias", () => {
      const c = COMPACT_TERRAIN_COAST_CAVITY;
      const clamp = (v: number, low = 0, high = 1) =>
        Math.max(low, Math.min(high, v));
      const smooth = (a: number, b: number, v: number) => {
        const t = clamp((v - a) / (b - a));
        return t * t * (3 - 2 * t);
      };
      for (const total of [0, 1e-30, 1e-14, 0.6, 1])
        for (const share of [0, 1e-10, 0.1, 0.3, 0.5, 0.7, 0.9, 1 - 1e-10, 1])
          for (const [coverage, road, pond] of [
            [0, 0, 1],
            [1, 1, 1],
            [1, 0, 0],
            [0.1, 0.3, 0.7],
            [1, 0, 1],
            [-1, -1, 2],
            [2, 2, -1],
          ]) {
            let previousGrass = Infinity;
            for (const rawAo of [-1, 0, 0.7, c.rawAoMean, 0.97, 1, 2]) {
              const g = total * share,
                r = total * (1 - share);
              const before = [
                g,
                0.25 * (1 - total),
                r,
                0.75 * (1 - total),
              ] as const;
              const actual = vectorValue(
                applyCompactCoastCavityWeights(
                  vec4(...before),
                  float(rawAo),
                  float(coverage),
                  float(road),
                  float(pond),
                ),
              );
              const bias = clamp(
                (c.rawAoMean - clamp(rawAo)) * c.cavityGain,
                -c.maximumBias,
                c.maximumBias,
              );
              const adjusted = smooth(
                c.transitionStart,
                c.transitionEnd,
                share + bias,
              );
              const locality =
                clamp(coverage / c.coastCoverageFull) *
                (1 - clamp(road)) *
                clamp(pond);
              const transfer = Math.min(
                r,
                Math.max(-g, (adjusted - share) * total * locality),
              );
              expect(
                actual.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
              ).toBe(true);
              expect(actual[1]).toBe(before[1]);
              expect(actual[3]).toBe(before[3]);
              if (total > 0) {
                expect(actual[0] / total).toBeCloseTo(
                  (g + transfer) / total,
                  13,
                );
                expect(actual[2] / total).toBeCloseTo(
                  (r - transfer) / total,
                  13,
                );
                expect((actual[0] + actual[2]) / total).toBeCloseTo(1, 13);
              }
              expect(actual[0]).toBeLessThanOrEqual(previousGrass);
              previousGrass = actual[0];
              if (total === 0 || share === 0 || share === 1 || locality === 0)
                expect(actual).toEqual(before);
            }
          }
      // Neutral cavity removes its bias, but deliberately narrows the existing
      // mixed shoulder; it is not the previous mean-neutral Overlay operation.
      const neutral = (g: number) =>
        vectorValue(
          applyCompactCoastCavityWeights(
            vec4(g, 0, 1 - g, 0),
            float(c.rawAoMean),
            float(1),
            float(0),
            float(1),
          ),
        )[0];
      expect(neutral(0.3)).toBeLessThan(0.3);
      expect(neutral(0.7)).toBeGreaterThan(0.7);
      expect(neutral(0.5)).toBeCloseTo(0.5, 14);
    });

    it("excludes the entire pond footprint and radial fade, then fades in only outside it", () => {
      const c = createCompactTerrainColorOperations().getComposition();
      const pond = vec4(343, 302, 7.5, 27.8),
        inner = 7.5 + c.pondBankReach;
      const outer = inner + c.pondRadialFade;
      const before = [0.4, 0.1, 0.3, 0.2] as const;
      for (let degrees = 0; degrees < 360; degrees += 10)
        for (const radius of [
          0,
          7.5,
          inner - c.pondRadialFade / 2,
          inner - 1e-6,
        ]) {
          const angle = (degrees * Math.PI) / 180;
          const world = vec3(
            343 + radius * Math.cos(angle),
            28,
            302 + radius * Math.sin(angle),
          );
          const clearance = createCompactCoastCavityPondClearance(world, pond);
          expect(vectorValue(clearance)).toEqual([0]);
          expect(
            vectorValue(
              applyCompactCoastCavityWeights(
                vec4(...before),
                float(0),
                float(1),
                float(0),
                clearance,
              ),
            ),
          ).toEqual(before);
        }
      for (const [dx, dz] of [
        [inner, 0],
        [-inner, 0],
        [0, inner],
        [0, -inner],
      ])
        expect(
          vectorValue(
            createCompactCoastCavityPondClearance(
              vec3(343 + dx, 0, 302 + dz),
              pond,
            ),
          ),
        ).toEqual([0]);
      let previous = -1;
      for (let radius = inner; radius <= outer + 0.25; radius += 0.125) {
        const actual = vectorValue(
          createCompactCoastCavityPondClearance(
            vec3(343 + radius, 999, 302),
            pond,
          ),
        )[0];
        expect(actual).toBeGreaterThanOrEqual(previous);
        expect(actual).toBeLessThanOrEqual(1);
        if (radius >= outer) expect(actual).toBe(1);
        previous = actual;
      }
      expect(
        vectorValue(
          createCompactCoastCavityPondClearance(vec3(343, 28, 302), null),
        ),
      ).toEqual([1]);
    });

    it("propagates the same nine sampled alpha values through patch and axis weights without AO or soil contamination", async () => {
      const image = PNG.sync.read(
        await readFile(new URL("rock-normal-ao.png", assetDirectory)),
      );
      const sampleAo = (uv: readonly number[]) => {
        const x = uv[0] * image.width - 0.5,
          y = uv[1] * image.height - 0.5;
        const ix = Math.floor(x),
          iy = Math.floor(y),
          fx = x - ix,
          fy = y - iy;
        const at = (a: number, b: number) =>
          image.data[
            ((((b % image.height) + image.height) % image.height) *
              image.width +
              (((a % image.width) + image.width) % image.width)) *
              4 +
              3
          ] / 255;
        return (
          (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
          (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy
        );
      };
      const owner = new CompactTerrainTextureSet(
        "/assets",
        "stochastic-v1",
        "height-v1",
        "stochastic-v1",
      );
      const distance = float(0).toVar("cavityTestNormalDistance");
      try {
        const layers = createCompactTerrainLayers(owner, distance),
          rock = layers.rock;
        expect(rock.rawRockAo).toBeTruthy();
        const raw = rock.rawRockAo!,
          nodes = graph(raw);
        const normalTexture = owner.getNode("rock", "normal-ao").value;
        const colorTexture = owner.getNode("rock", "albedo-roughness").value;
        const samples = [...nodes].filter(
          (n) =>
            Reflect.get(n, "value") === normalTexture &&
            Reflect.get(n, "uvNode"),
        );
        const colorSamples = [...graph(rock.albedo)].filter(
          (n) =>
            Reflect.get(n, "value") === colorTexture &&
            Reflect.get(n, "uvNode"),
        );
        expect(samples).toHaveLength(9);
        expect(colorSamples).toHaveLength(9);
        expect(nodes.has(distance)).toBe(false);
        expect(nodes.has(layers.dirt.ao)).toBe(false);
        for (const sample of samples) {
          expect(graph(rock.ao).has(sample)).toBe(true);
          const pair = colorSamples.filter(
            (n) => Reflect.get(n, "uvNode") === Reflect.get(sample, "uvNode"),
          );
          expect(pair).toHaveLength(1);
          expect(Reflect.get(pair[0], "gradNode")).toEqual(
            Reflect.get(sample, "gradNode"),
          );
        }
        const planes = [
          vec2(positionWorld.z, positionWorld.y),
          vec2(positionWorld.x, positionWorld.z),
          vec2(positionWorld.x, positionWorld.y),
        ];
        const seeds = [0x173ab129, 0x375cd103, 0x529a4d27];
        const projections = planes.map((plane, i) =>
          createCompactStochasticProjections(
            plane,
            COMPACT_TERRAIN_MATERIAL.repeatsPerMeter,
            COMPACT_TERRAIN_MATERIAL.rockPatchEdgeMeters,
            vec2(1, 0),
            vec2(0, 1),
            seeds[i],
          ),
        );
        for (const position of [
          [401.5, 24, 470.3],
          [-23.7, 19.8, -37.2],
        ])
          for (const n of [
            [0, 1, 0],
            [1, 0, 0],
            [-0.3, 0.8, -0.5],
            [1, -1, 1],
          ]) {
            const normal = new THREE.Vector3(...n).normalize();
            const inputs = new Map<Node, readonly number[]>([
              [positionWorld, position],
              [normalWorldGeometry, normal.toArray()],
            ]);
            for (const sample of samples) {
              const uv: unknown = Reflect.get(sample, "uvNode");
              if (!(uv instanceof THREE.Node))
                throw new Error("Missing actual raw AO projection");
              inputs.set(sample, [
                0.5,
                0.5,
                1,
                sampleAo(vectorValue(uv, inputs)),
              ]);
            }
            const axis = normal.toArray().map((v) => Math.abs(v) ** 4),
              sum = axis.reduce((a, b) => a + b, 0);
            const expected = projections.reduce((total, p, i) => {
              const w = vectorValue(p.weights, inputs);
              return (
                total +
                ([p.a, p.b, p.c].reduce(
                  (value, patch, j) =>
                    value + sampleAo(vectorValue(patch.uv, inputs)) * w[j],
                  0,
                ) *
                  axis[i]) /
                  sum
              );
            }, 0);
            expect(vectorValue(raw, inputs)[0]).toBeCloseTo(expected, 13);
            expect(vectorValue(rock.ao, inputs)[0]).toBeCloseTo(
              1 + (expected - 1) * COMPACT_TERRAIN_MATERIAL.aoStrength,
              13,
            );
          }
        const coast = applyCompactCoastRock(rock, layers.dirt, {
          soil: float(1),
          wetness: float(1),
        });
        expect(coast.rawRockAo).toBe(raw);
        expect(graph(coast.rawRockAo!).has(layers.dirt.ao)).toBe(false);
        // Actual sampled scalar/UV arithmetic, not a GPU filtering or mip claim.
      } finally {
        owner.dispose();
      }
    });

    it("shares one conserved final vector across all PBR channels and retains nested-soil semantics", () => {
      const layer = (
        color: [number, number, number],
        roughness: number,
        ao: number,
        normal: [number, number, number],
        height?: number,
      ): CompactTerrainLayer => ({
        albedo: vec3(...color),
        roughness: float(roughness),
        ao: float(ao),
        worldNormal: vec3(...normal),
        ...(height === undefined ? {} : { height: float(height) }),
      });
      const rock = {
        ...layer([0.5, 0.4, 0.3], 0.73, 0.7, [0, 0.8, 0.6]),
        rawRockAo: float(0.7),
      };
      const dirt = layer([0.3, 0.2, 0.09], 0.82, 0.9, [0.6, 0.8, 0], 0.4);
      const layers = {
        grass: layer([0.1, 0.3, 0.07], 0.95, 0.8, [0, 1, 0], 0.6),
        dirt,
        rock: applyCompactCoastRock(rock, dirt, {
          soil: float(0.6),
          wetness: float(0.2),
        }),
      };
      const coast = layer([0.15, 0.1, 0.04], 0.58, 0.85, [-0.6, 0.8, 0]);
      const resolve = (coverage?: Node<"float">) =>
        blendCompactTerrainLayers(
          layers,
          float(0.3),
          float(0.5),
          float(0),
          undefined,
          undefined,
          { coverage: float(0.1), layer: coast },
          undefined,
          float(0.2),
          float(0.1),
          float(0.3),
          undefined,
          undefined,
          coverage ? { coverage, pondClearance: float(1) } : undefined,
        );
      const before = resolve(),
        after = resolve(float(1));
      const expected = vectorValue(
        applyCompactCoastCavityWeights(
          before.weights!,
          rock.rawRockAo,
          float(1),
          float(0),
          float(1),
        ),
      );
      expect(vectorValue(after.weights!)).toEqual(expected);
      expect(graph(after.weights!).has(rock.rawRockAo)).toBe(true);
      const view = new Map<Node, readonly number[]>([
        [cameraViewMatrix, new THREE.Matrix4().toArray()],
      ]);
      const ordered = [layers.grass, layers.dirt, layers.rock, coast];
      for (const property of ["albedo", "roughness", "ao", "normal"] as const) {
        expect(graph(after[property]).has(after.weights!)).toBe(true);
        expect(vectorValue(resolve(float(0))[property], view)).toEqual(
          vectorValue(before[property], view),
        );
      }
      for (const property of ["albedo", "roughness", "ao"] as const)
        vectorValue(after[property]).forEach((value, component) =>
          expect(value).toBeCloseTo(
            ordered.reduce(
              (sum, item, i) =>
                sum + vectorValue(item[property])[component] * expected[i],
              0,
            ),
            12,
          ),
        );
      const expectedNormal = ordered
        .reduce(
          (sum, item, i) =>
            sum.addScaledVector(
              new THREE.Vector3(...vectorValue(item.worldNormal)),
              expected[i],
            ),
          new THREE.Vector3(),
        )
        .normalize();
      vectorValue(after.normal, view).forEach((value, i) =>
        expect(value).toBeCloseTo(expectedNormal.toArray()[i], 12),
      );
      expect(expected[1]).toBe(vectorValue(before.weights!)[1]);
      expect(expected[3]).toBe(vectorValue(before.weights!)[3]);
      expect(expected[2]).not.toBe(vectorValue(before.weights!)[2]);
      // Its existing 60% nested coastal-soil share follows rock-branch weight;
      // unchanged explicit soil channels do not mean total soil stays fixed.
      expect(expected[1] + expected[3] + 0.6 * expected[2]).not.toBe(
        vectorValue(before.weights!)[1] +
          vectorValue(before.weights!)[3] +
          0.6 * vectorValue(before.weights!)[2],
      );
    });

    it("admits only the explicit coastal height mode and keeps all 33 existing samples with one final owner", () => {
      const base = {
        compactPbr: true,
        compactSurfaceBlend: "height-v1" as const,
        compactDirtProjection: "stochastic-v1" as const,
        compactRockProjection: "stochastic-v1" as const,
        compactProfile: candidateProfile(),
        compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
      };
      const options = { ...base, compactCoastBlend: "cavity-v1" as const };
      const absent = createTerrainMaterial(undefined, base),
        candidate = createTerrainMaterial(undefined, options);
      try {
        for (const material of [absent, candidate]) {
          const originalOutput = material.outputNode;
          const roots = [
            material.colorNode!,
            material.roughnessNode!,
            material.aoNode!,
            material.normalNode!,
          ];
          const all = new Set(roots.flatMap((root) => [...graph(root)]));
          const final = [...all].filter(
            (n) =>
              Reflect.get(n, "name") === "compactCoastCavitySurfaceWeights",
          );
          expect(final).toHaveLength(material === candidate ? 1 : 0);
          const receipt = material.compactTerrainSurface!.getReceipt();
          expect(receipt.surfaceSampleCount).toBe(33);
          expect(receipt.textures).toHaveLength(7);
          const owned = new Set(receipt.textures.map((t) => t.textureUuid));
          expect(
            [...all].filter((n) => {
              const value: unknown = Reflect.get(n, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(n, "uvNode")
              );
            }),
          ).toHaveLength(33);
          if (material === candidate) {
            const diag = material.getCompactTerrainDiagnosticOutputs()!;
            expect(diag.sources.weights).toBe(final[0]);
            for (const root of roots)
              expect(graph(root).has(final[0])).toBe(true);
            for (const source of [
              diag.sources.pondSoil,
              diag.sources.pondWetness,
            ])
              expect(graph(source).has(final[0])).toBe(false);
            for (const name of [
              "compactCoastDetailSurfaceWeights",
              "compactCoastDistributionSurfaceWeights",
            ])
              expect(
                [...all].some((n) => Reflect.get(n, "name") === name),
              ).toBe(false);
          }
          expect(material.outputNode).toBe(originalOutput);
          expect(material.positionNode).toBeNull();
          expect(material.displacementMap).toBeNull();
        }
        expect(
          Object.getOwnPropertyDescriptor(candidate, "compactCoastBlend"),
        ).toEqual({
          value: "cavity-v1",
          enumerable: true,
          configurable: false,
          writable: false,
        });
        expect(
          Object.prototype.hasOwnProperty.call(absent, "compactCoastBlend"),
        ).toBe(false);
        Reflect.set(options, "compactCoastBlend", "invalid-after-capture");
        expect(candidate.compactCoastBlend).toBe("cavity-v1");
        expect(() => createTerrainMaterial(undefined, options)).toThrow(
          "Invalid compact coast blend",
        );
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactCoastBlend: "cavity-v1",
            compactPbr: false,
          }),
        ).toThrow("compact PBR");
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactCoastBlend: "cavity-v1",
            compactSurfaceBlend: undefined,
          }),
        ).toThrow("height-v1");
        const { southernMeadow: _meadow, ...withoutCoast } =
          base.compactProfile;
        expect(_meadow).toBeDefined();
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactCoastBlend: "cavity-v1",
            compactProfile: withoutCoast,
          }),
        ).toThrow("coastal macro domain");
        const ops = createCompactTerrainColorOperations();
        expect(ops.macroField(base.compactProfile, "cavity-v1")).toEqual(
          ops.macroField(base.compactProfile),
        );
        // Unchanged CPU ownership is not rendered root-color/ecology parity.
      } finally {
        absent.dispose();
        candidate.dispose();
      }
    });
  });

  describe("explicit detail-v1 coastal grass/rock coverage", () => {
    it("centers the admitted grass detail and equals endpoint-preserving Overlay, including tiny budgets", () => {
      const controls = COMPACT_TERRAIN_COAST_DETAIL;
      expect(Object.isFrozen(controls)).toBe(true);
      expect(controls.heightSha256).toBe(
        COMPACT_TERRAIN_HEIGHT_SHA256["ground-height"],
      );
      expect(controls.grassHeightMean).toBe(0.34206187678318395);
      expect(controls.detailGain).toBe(2);
      for (const height of [-1, 0, controls.grassHeightMean, 0.6, 1, 2]) {
        const detail = Math.max(
          0,
          Math.min(
            1,
            0.5 +
              2 * (Math.max(0, Math.min(1, height)) - controls.grassHeightMean),
          ),
        );
        expect(
          vectorValue(createCompactCoastDetailMask(float(height)))[0],
        ).toBe(detail);
        for (const total of [1, 0.6, 1e-15, 1e-30])
          for (const share of [0, 1e-10, 0.1, 0.49, 0.5, 0.8, 1 - 1e-10, 1])
            for (const locality of [0, 0.3, 1]) {
              const grass = total * share,
                rock = total * (1 - share);
              const result = vectorValue(
                applyCompactCoastDetailWeights(
                  vec4(grass, 0, rock, 0),
                  float(height),
                  float(locality),
                  float(0),
                  float(0),
                ),
              );
              const overlay =
                share < 0.5
                  ? 2 * share * detail
                  : 1 - 2 * (1 - share) * (1 - detail);
              const expectedShare = share + locality * (overlay - share);
              // Normalize the comparison: an absolute epsilon would conceal
              // the entire result at tiny positive grass/rock budgets.
              expect(result[0] / total).toBeCloseTo(expectedShare, 13);
              expect(result[2] / total).toBeCloseTo(1 - expectedShare, 13);
              expect((result[0] + result[2]) / total).toBeCloseTo(1, 13);
              expect(result.every((v) => Number.isFinite(v) && v >= 0)).toBe(
                true,
              );
              if (
                locality === 0 ||
                share === 0 ||
                share === 1 ||
                height === controls.grassHeightMean
              )
                expect(result).toEqual([grass, 0, rock, 0]);
            }
      }
    });

    it("protects pond and road locality and explicit soil while honestly changing nested rock-branch soil", () => {
      for (const values of [
        [1, 0, 0, 0],
        [0, 0, 1, 0],
        [0, 0.4, 0, 0.6],
        [0, 0, 0, 0],
        [0.2, 0.3, 0.4, 0.1],
      ] as const)
        for (const height of [0, 0.2, 0.6, 1])
          for (const [coverage, road, pond] of [
            [0, 0, 0],
            [1, 1, 0],
            [1, 0, 1],
            [0.7, 0.2, 0.4],
            [2, -1, -1],
            [-1, 0, 0],
          ]) {
            const result = vectorValue(
              applyCompactCoastDetailWeights(
                vec4(...values),
                float(height),
                float(coverage),
                float(road),
                float(pond),
              ),
            );
            expect(result[1]).toBe(values[1]);
            expect(result[3]).toBe(values[3]);
            expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(
              values.reduce<number>((a, b) => a + b, 0),
              13,
            );
            expect(
              result.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
            ).toBe(true);
            if (
              coverage <= 0 ||
              road === 1 ||
              pond === 1 ||
              values[0] === 0 ||
              values[2] === 0
            )
              expect(result).toEqual(values);
          }
      const before = [0.2, 0.3, 0.4, 0.1],
        after = vectorValue(
          applyCompactCoastDetailWeights(
            vec4(0.2, 0.3, 0.4, 0.1),
            float(1),
            float(1),
            float(0),
            float(0),
          ),
        ),
        nestedSoil = 0.6,
        coverage = (weights: readonly number[]) => [
          weights[0],
          weights[2] * (1 - nestedSoil),
          weights[1] + weights[3] + weights[2] * nestedSoil,
        ];
      expect(after).toEqual([0.4, 0.3, 0.2, 0.1]);
      expect(coverage(after)[2]).toBeLessThan(coverage(before)[2]);
      expect(coverage(after).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
    });

    it("reuses actual sea-relative coverage rather than soil and leaves wetness and CPU support owners untouched", () => {
      const ops = createCompactTerrainColorOperations(),
        field = ops.macroField(candidateProfile())!,
        world = vec3(420, field.seaLevel + 1, 480),
        coast = createCompactCoastWeights(
          world,
          float(0.5),
          float(0.5),
          float(0),
          float(1),
          field,
        ),
        weights = applyCompactCoastDetailWeights(
          vec4(0.5, 0, 0.5, 0),
          float(1),
          coast.coverage,
          float(0),
          float(0),
        ),
        input = {
          noiseValue: 0.5,
          distortNoise: 0.5,
          slope: 0.12,
          roadInfluence: 0,
          surface: {
            x: 420,
            z: 480,
            height: field.seaLevel + 1,
            pond: null,
            macroField: field,
          },
        },
        support = ops.grassSupport(input),
        color = ops.sample(input);
      expect(vectorValue(coast.coverage)[0]).toBe(1);
      expect(vectorValue(coast.soil)[0]).toBe(0);
      expect(vectorValue(weights)).toEqual([1, 0, 0, 0]);
      expect(graph(coast.soil).has(coast.coverage)).toBe(true);
      expect(graph(weights).has(coast.coverage)).toBe(true);
      for (const source of [coast.soil, coast.wetness])
        expect(graph(source).has(weights)).toBe(false);
      expect(ops.grassSupport(input)).toBe(support);
      expect(ops.sample(input)).toEqual(color);
      // These CPU owners do not receive the opt-in. Their unchanged density
      // and root-color values are NOT visual agreement with changed material
      // coverage; real grass roots and LOD fades remain native acceptance gates.
      expect(
        vectorValue(
          createCompactCoastWeights(
            world,
            float(0.5),
            float(0.5),
            float(0),
            float(1),
            null,
          ).coverage,
        ),
      ).toEqual([0]);
    });

    it("shares one final detailed vector and aligned height across all four PBR channels", () => {
      const layer = (
        color: [number, number, number],
        roughness: number,
        ao: number,
        normal: [number, number, number],
        height?: number,
      ): CompactTerrainLayer => ({
        albedo: vec3(...color),
        roughness: float(roughness),
        ao: float(ao),
        worldNormal: vec3(...normal),
        ...(height === undefined ? {} : { height: float(height) }),
      });
      const layers = {
          grass: layer([0.1, 0.3, 0.07], 0.95, 0.8, [0, 1, 0], 0.6),
          dirt: layer([0.3, 0.2, 0.09], 0.82, 0.9, [0.6, 0.8, 0], 0.4),
          rock: layer([0.5, 0.4, 0.3], 0.73, 0.7, [0, 0.8, 0.6]),
        },
        coast = layer([0.15, 0.1, 0.04], 0.58, 0.85, [-0.6, 0.8, 0]),
        resolve = (coverage?: Node<"float">) =>
          blendCompactTerrainLayers(
            layers,
            float(0.3),
            float(0.5),
            float(0),
            undefined,
            undefined,
            { coverage: float(0.1), layer: coast },
            undefined,
            float(0.2),
            float(0.1),
            float(0.3),
            coverage ? { coverage, pondRegion: float(0) } : undefined,
          ),
        baseline = resolve(),
        candidate = resolve(float(0.7)),
        expected = vectorValue(
          applyCompactCoastDetailWeights(
            baseline.weights!,
            layers.grass.height!,
            float(0.7),
            float(0),
            float(0),
          ),
        ),
        view = new Map<Node, readonly number[]>([
          [cameraViewMatrix, new THREE.Matrix4().toArray()],
        ]),
        ordered = [layers.grass, layers.dirt, layers.rock, coast];
      expect(vectorValue(candidate.weights!)).toEqual(expected);
      expect(graph(candidate.weights!).has(layers.grass.height!)).toBe(true);
      for (const property of ["albedo", "roughness", "ao", "normal"] as const) {
        expect(graph(candidate[property]).has(candidate.weights!)).toBe(true);
        expect(vectorValue(resolve(float(0))[property], view)).toEqual(
          vectorValue(baseline[property], view),
        );
      }
      for (const property of ["albedo", "roughness", "ao"] as const)
        vectorValue(candidate[property]).forEach((v, i) =>
          expect(v).toBeCloseTo(
            ordered.reduce(
              (sum, item, channel) =>
                sum + vectorValue(item[property])[i] * expected[channel],
              0,
            ),
            12,
          ),
        );
      const normal = new THREE.Vector3();
      ordered.forEach((item, i) =>
        normal.addScaledVector(
          new THREE.Vector3(
            ...(vectorValue(item.worldNormal) as [number, number, number]),
          ),
          expected[i],
        ),
      );
      normal.normalize();
      vectorValue(candidate.normal, view).forEach((v, i) =>
        expect(v).toBeCloseTo(normal.toArray()[i], 12),
      );
      for (const name of [
        "compactPondReliefSurfaceWeights",
        "compactPondSedimentSurfaceWeights",
        "compactPondRockContactSurfaceWeights",
        "compactCoastDetailSurfaceWeights",
        "compactCoastDetailTransfer",
      ])
        expect(
          [...graph(candidate.weights!)].filter(
            (node) => Reflect.get(node, "name") === name,
          ),
        ).toHaveLength(1);
    });

    it("admits only explicit coastal height blending, captures selection immutably and adds no samples or pond dependency", () => {
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        base = {
          compactPbr: true,
          compactSurfaceBlend: "height-v1" as const,
          compactDirtProjection: "stochastic-v1" as const,
          compactRockProjection: "stochastic-v1" as const,
          compactProfile: candidateProfile(),
          compactPond: pond,
        },
        options = { ...base, compactCoastBlend: "detail-v1" as const },
        absent = createTerrainMaterial(undefined, base),
        candidate = createTerrainMaterial(undefined, options),
        independentCoast = createTerrainMaterial(undefined, {
          ...options,
          compactPond: null,
        });
      try {
        for (const material of [absent, candidate, independentCoast]) {
          const originalOutput = material.outputNode;
          const roots = [
              material.colorNode!,
              material.roughnessNode!,
              material.aoNode!,
              material.normalNode!,
            ],
            all = new Set(roots.flatMap((root) => [...graph(root)])),
            details = [...all].filter(
              (node) =>
                Reflect.get(node, "name") ===
                "compactCoastDetailSurfaceWeights",
            ),
            receipt = material.compactTerrainSurface!.getReceipt(),
            owned = new Set(receipt.textures.map((entry) => entry.textureUuid));
          expect(details).toHaveLength(material === absent ? 0 : 1);
          expect(receipt.surfaceSampleCount).toBe(33);
          expect(receipt.textures).toHaveLength(7);
          expect(
            [...all].filter((node) => {
              const value: unknown = Reflect.get(node, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(node, "uvNode")
              );
            }),
          ).toHaveLength(33);
          if (material !== absent) {
            const diagnostics = material.getCompactTerrainDiagnosticOutputs()!;
            expect(diagnostics.sources.weights).toBe(details[0]);
            for (const root of roots)
              expect(graph(root).has(details[0])).toBe(true);
            for (const mask of [
              diagnostics.sources.pondSoil,
              diagnostics.sources.pondWetness,
            ])
              expect(graph(mask).has(details[0])).toBe(false);
          }
          // The real factory already owns a fog/PBR output node. Neither the
          // candidate nor lazy diagnostic access replaces that output owner.
          expect(originalOutput).toBeTruthy();
          expect(material.outputNode).toBe(originalOutput);
          expect(material.positionNode).toBeNull();
          expect(material.displacementMap).toBeNull();
        }
        expect(
          Object.getOwnPropertyDescriptor(candidate, "compactCoastBlend"),
        ).toEqual({
          value: "detail-v1",
          enumerable: true,
          configurable: false,
          writable: false,
        });
        expect(
          Object.prototype.hasOwnProperty.call(absent, "compactCoastBlend"),
        ).toBe(false);
        Reflect.set(options, "compactCoastBlend", "invalid-after-capture");
        expect(candidate.compactCoastBlend).toBe("detail-v1");
        expect(() => createTerrainMaterial(undefined, options)).toThrow(
          "Invalid compact coast blend",
        );
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactCoastBlend: "detail-v1",
            compactSurfaceBlend: undefined,
          }),
        ).toThrow("height-v1");
        expect(() =>
          createTerrainMaterial(undefined, {
            compactPbr: false,
            compactCoastBlend: "detail-v1",
          }),
        ).toThrow("compact PBR");
        const { southernMeadow: _candidate, ...withoutCoast } =
          base.compactProfile;
        expect(_candidate).toBeDefined();
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactProfile: withoutCoast,
            compactCoastBlend: "detail-v1",
          }),
        ).toThrow("coastal macro domain");
      } finally {
        absent.dispose();
        candidate.dispose();
        independentCoast.dispose();
      }
    });
  });

  describe("explicit relief-contact-v1 rock exposure", () => {
    it("uses the unchanged two footprints at recorded review52 rock anchors and bounds every influence", () => {
      const ops = createCompactTerrainColorOperations(),
        field = ops.macroField(candidateProfile())!,
        identity = DataManager.getWorldContentIdentity();
      // Recorded actual review52 authoring, including all six relocated poses.
      // These are spatial-domain witnesses, not rendered/model-contact proof.
      const anchors = [
        ["west01", 337, 295.7, 0.75],
        ["west02", 335.9, 296.8, 0.07161112969794178],
        ["west03", 337.6, 296, 0.75],
        ["west04", 338, 295, 0.569295749742786],
        ["west05", 336.3, 295.5, 0.6807861328125082],
        ["north01", 339.25, 294.9, 0],
        ["north02", 340.45, 294.3, 0],
        ["north03", 336.8, 294.9, 0.6633143169889613],
        ["north04", 337.8, 293.8, 0],
        ["east01", 350.1, 298.2, 0.55],
        ["east02", 350.9, 299.2, 0.060617872235791244],
        ["east03", 351.1, 297.6, 0.0007244636625315383],
        ["east04", 349.35, 298.75, 0.55],
        ["workshop01", 326, 328, 0],
        ["workshop02", 324.2, 328.7, 0],
        ["workshop03", 328, 329.7, 0],
        ["workshop04", 326.8, 331.6, 0],
      ] as const;
      for (const [_id, x, z, expected] of anchors) {
        const exposure = createCompactPondRockContact({
          world: vec3(x, 27.8, z),
          distortNoise: float(1),
          field,
          pondSoil: float(1),
          geometricCliff: float(1),
          road: float(0),
        });
        expect(vectorValue(exposure)[0]).toBeCloseTo(expected, 12);
      }
      for (const x of [334, 335.4, 338, 340.7, 343, 347.1, 350, 351.38, 353])
        for (const z of [293, 294, 296, 299.4, 300.53, 302, 308])
          for (const noise of [-1, 0.5, 2]) {
            const value = vectorValue(
              createCompactPondRockContact({
                world: vec3(x, 27.8, z),
                distortNoise: float(noise),
                field,
                pondSoil: float(1),
                geometricCliff: float(1),
                road: float(0),
              }),
            )[0];
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(0.75);
            const insideNorthWest =
                x >= 335.4 && x <= 340.7 && z >= 294 && z <= 299.40000000000003,
              insideEast =
                x >= 347.1 && x <= 351.38 && z >= 297.12 && z <= 300.53;
            if (!insideNorthWest && !insideEast) expect(value).toBe(0);
            if (z >= 302) expect(value).toBe(0);
          }
      expect(DataManager.getWorldContentIdentity()).toBe(identity);
    });

    it("requires real soil, cliff and field exposure without changing original masks or CPU grass", () => {
      const ops = createCompactTerrainColorOperations(),
        field = ops.macroField(candidateProfile())!,
        pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        world = vec3(338.9, pond.surfaceY + 0.11, 297.6),
        surface = createCompactPondSurfaceWeights(
          world,
          float(0.5),
          vec4(pond.centerX, pond.centerZ, pond.radius, pond.surfaceY),
        ),
        before = [vectorValue(surface.soil), vectorValue(surface.wetness)],
        cpuInput = {
          noiseValue: 0.5,
          distortNoise: 0.5,
          slope: 0.15,
          roadInfluence: 0,
          surface: {
            x: 338.9,
            z: 297.6,
            height: pond.surfaceY + 0.11,
            pond,
            macroField: field,
          },
        },
        support = ops.grassSupport(cpuInput),
        color = ops.sample(cpuInput);
      const base = {
        world,
        distortNoise: float(0.5),
        field,
        pondSoil: surface.soil,
        geometricCliff: float(0.5),
        road: float(0),
      };
      const exposure = createCompactPondRockContact(base);
      expect(vectorValue(exposure)[0]).toBeGreaterThan(0);
      expect(support).toBeGreaterThan(0);
      // Positive support and contact can overlap: exact unchanged CPU data is
      // not evidence of visual root-color agreement. Native anchors must be
      // inspected; do not silently recolor/reseed grass to hide that gate.
      for (const input of [
        { ...base, world: undefined },
        { ...base, field: null },
        { ...base, field: { ...field, pondContactGround: undefined } },
        { ...base, field: { ...field, coastalMeadow: undefined } },
        { ...base, pondSoil: float(0) },
        { ...base, geometricCliff: float(0) },
        { ...base, road: float(1) },
        { ...base, world: vec3(343, pond.surfaceY, 302) },
      ])
        expect(vectorValue(createCompactPondRockContact(input))[0]).toBe(0);
      expect(graph(exposure).has(surface.soil)).toBe(true);
      expect(graph(surface.soil).has(exposure)).toBe(false);
      expect(graph(surface.wetness).has(exposure)).toBe(false);
      expect([vectorValue(surface.soil), vectorValue(surface.wetness)]).toEqual(
        before,
      );
      expect(ops.grassSupport(cpuInput)).toBe(support);
      expect(ops.sample(cpuInput)).toEqual(color);
    });

    it("conserves exact grass/coast weights and transfers only available final dry soil", () => {
      for (const values of [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [0.2, 0.5, 0.2, 0.1],
        [0.4, 1e-8, 0.59999999, 0],
      ] as const)
        for (const amount of [-1, 0, 0.55, 0.75, 1, 2]) {
          const source = vec4(...values),
            result = vectorValue(
              applyCompactPondRockContactWeights(source, float(amount)),
            ),
            transfer = values[1] * Math.max(0, Math.min(1, amount));
          expect(result[0]).toBe(values[0]);
          expect(result[3]).toBe(values[3]);
          expect(result[1]).toBe(values[1] - transfer);
          expect(result[2]).toBe(values[2] + transfer);
          expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(
            values.reduce<number>((a, b) => a + b, 0),
            13,
          );
          expect(
            result.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
          ).toBe(true);
          if (amount <= 0 || values[1] === 0) expect(result).toEqual(values);
        }
    });

    it("applies contact after relief and sediment and shares one final vector across every PBR channel", () => {
      const layer = (
        color: [number, number, number],
        roughness: number,
        ao: number,
        normal: [number, number, number],
        height?: number,
      ): CompactTerrainLayer => ({
        albedo: vec3(...color),
        roughness: float(roughness),
        ao: float(ao),
        worldNormal: vec3(...normal),
        ...(height === undefined ? {} : { height: float(height) }),
      });
      const layers = {
          grass: layer([0.1, 0.3, 0.07], 0.95, 0.8, [0, 1, 0], 0.2),
          dirt: layer([0.3, 0.2, 0.09], 0.82, 0.9, [0.6, 0.8, 0], 0.7),
          rock: layer([0.5, 0.4, 0.3], 0.73, 0.7, [0, 0.8, 0.6]),
        },
        coast = layer([0.15, 0.1, 0.04], 0.58, 0.85, [-0.6, 0.8, 0]),
        resolve = (contact?: Node<"float">) =>
          blendCompactTerrainLayers(
            layers,
            float(0.4),
            float(0.5),
            float(0),
            undefined,
            undefined,
            { coverage: float(0.1), layer: coast },
            undefined,
            float(0.6),
            float(0.7),
            contact,
          ),
        baseline = resolve(),
        before = vectorValue(baseline.weights!),
        exposure = float(0.75).toVar("testedRockContactExposure"),
        candidate = resolve(exposure),
        weights = vectorValue(candidate.weights!),
        expected = [
          before[0],
          before[1] * 0.25,
          before[2] + before[1] * 0.75,
          before[3],
        ],
        view = new Map<Node, readonly number[]>([
          [cameraViewMatrix, new THREE.Matrix4().toArray()],
        ]),
        ordered = [layers.grass, layers.dirt, layers.rock, coast];
      weights.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 13));
      for (const property of ["albedo", "roughness", "ao", "normal"] as const) {
        expect(graph(candidate[property]).has(candidate.weights!)).toBe(true);
        expect(graph(candidate[property]).has(exposure)).toBe(true);
        expect(vectorValue(resolve(float(0))[property], view)).toEqual(
          vectorValue(baseline[property], view),
        );
      }
      for (const property of ["albedo", "roughness", "ao"] as const) {
        const values = vectorValue(candidate[property]);
        values.forEach((v, i) =>
          expect(v).toBeCloseTo(
            ordered.reduce(
              (sum, item, channel) =>
                sum + vectorValue(item[property])[i] * expected[channel],
              0,
            ),
            12,
          ),
        );
      }
      const normal = new THREE.Vector3();
      ordered.forEach((item, i) =>
        normal.addScaledVector(
          new THREE.Vector3(
            ...(vectorValue(item.worldNormal) as [number, number, number]),
          ),
          expected[i],
        ),
      );
      normal.normalize();
      vectorValue(candidate.normal, view).forEach((v, i) =>
        expect(v).toBeCloseTo(normal.toArray()[i], 12),
      );
      for (const name of [
        "compactPondReliefSurfaceWeights",
        "compactPondSedimentSurfaceWeights",
        "compactPondRockContactSurfaceWeights",
      ])
        expect(
          [...graph(candidate.weights!)].filter(
            (node) => Reflect.get(node, "name") === name,
          ),
        ).toHaveLength(1);
    });

    it("keeps defaults and relief-v1 exact while admitting contact with unchanged wetness and sampling", () => {
      const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        base = {
          compactPbr: true,
          compactSurfaceBlend: "height-v1" as const,
          compactDirtProjection: "stochastic-v1" as const,
          compactRockProjection: "stochastic-v1" as const,
          compactPond: pond,
          compactProfile: candidateProfile(),
        };
      const absent = createTerrainMaterial(undefined, base),
        relief = createTerrainMaterial(undefined, {
          ...base,
          compactPondBlend: "relief-v1",
        }),
        candidate = createTerrainMaterial(undefined, {
          ...base,
          compactPondBlend: "relief-contact-v1",
        });
      try {
        for (const material of [absent, relief, candidate]) {
          const roots = [
              material.colorNode!,
              material.roughnessNode!,
              material.aoNode!,
              material.normalNode!,
            ],
            all = new Set(roots.flatMap((root) => [...graph(root)])),
            contacts = [...all].filter(
              (node) =>
                Reflect.get(node, "name") ===
                "compactPondRockContactSurfaceWeights",
            ),
            diagnostics = material.getCompactTerrainDiagnosticOutputs()!,
            receipt = material.compactTerrainSurface!.getReceipt(),
            owned = new Set(receipt.textures.map((entry) => entry.textureUuid));
          expect(contacts).toHaveLength(material === candidate ? 1 : 0);
          expect(receipt.surfaceSampleCount).toBe(33);
          expect(receipt.textures).toHaveLength(7);
          expect(
            [...all].filter((node) => {
              const value: unknown = Reflect.get(node, "value");
              return (
                value instanceof THREE.Texture &&
                owned.has(value.uuid) &&
                Reflect.get(node, "uvNode")
              );
            }),
          ).toHaveLength(33);
          if (material === candidate) {
            expect(
              [...all].filter(
                (node) =>
                  Reflect.get(node, "name") === "compactPondContactSoil",
              ),
            ).toHaveLength(1);
            expect(diagnostics.sources.weights).toBe(contacts[0]);
            for (const root of roots)
              expect(graph(root).has(contacts[0])).toBe(true);
            for (const source of [
              diagnostics.sources.pondSoil,
              diagnostics.sources.pondWetness,
            ])
              expect(graph(source).has(contacts[0])).toBe(false);
            expect(graph(contacts[0]).has(diagnostics.sources.pondSoil)).toBe(
              true,
            );
            expect(
              graph(contacts[0]).has(diagnostics.sources.geometricCliff),
            ).toBe(true);
          }
          expect(material.positionNode).toBeNull();
          expect(material.vertexNode).toBeNull();
          expect(material.geometryNode).toBeNull();
          expect(material.displacementMap).toBeNull();
        }
        expect(
          Object.getOwnPropertyDescriptor(candidate, "compactPondBlend"),
        ).toEqual({
          value: "relief-contact-v1",
          enumerable: true,
          configurable: false,
          writable: false,
        });
        for (const compactPond of [null, undefined])
          expect(() =>
            createTerrainMaterial(undefined, {
              ...base,
              compactPond,
              compactPondBlend: "relief-contact-v1",
            }),
          ).toThrow("admitted compact pond");
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactSurfaceBlend: undefined,
            compactPondBlend: "relief-contact-v1",
          }),
        ).toThrow("height-v1");
        expect(() =>
          createTerrainMaterial(undefined, {
            ...base,
            compactPbr: false,
            compactDirtProjection: undefined,
            compactRockProjection: undefined,
            compactSurfaceBlend: undefined,
            compactPondBlend: "relief-contact-v1",
          }),
        ).toThrow("compact PBR");
      } finally {
        absent.dispose();
        relief.dispose();
        candidate.dispose();
      }
    });
  });

  it("bounds candidate pond contact substrate to two frozen unequal northern contacts", () => {
    const ops = createCompactTerrainColorOperations();
    const profile = candidateProfile();
    const field = ops.macroField(profile)!;
    const { southernMeadow: _candidate, ...historical } = profile;
    expect(_candidate).toBeDefined();
    expect(ops.macroField(historical)).not.toHaveProperty("pondContactGround");
    expect(
      ops.macroField({ ...profile, id: "unrelated-meadow-layout" }),
    ).not.toHaveProperty("pondContactGround");
    expect(field.pondContactGround).toEqual([
      {
        startX: 338.9,
        startZ: 297.6,
        endX: 337.2,
        endZ: 295.8,
        coreRadius: 0.6,
        outerRadius: 1.8,
        strength: 0.75,
      },
      {
        startX: 348.35,
        startZ: 299.28,
        endX: 350.13,
        endZ: 298.37,
        coreRadius: 0.45,
        outerRadius: 1.25,
        strength: 0.55,
      },
    ]);
    expect(Object.isFrozen(field.pondContactGround)).toBe(true);
    expect(field.pondContactGround!.every(Object.isFrozen)).toBe(true);
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    expect([pond.centerX, pond.centerZ]).toEqual([343, 302]);
    for (const ribbon of field.pondContactGround!)
      expect(
        Math.max(ribbon.startZ, ribbon.endZ) + ribbon.outerRadius,
      ).toBeLessThan(pond.centerZ);
    for (const [x, z] of [
      [343, 302],
      [343, 308],
      [348, 318],
      [450, 450],
    ])
      expect(ops.pondContactSoil(x, z, 1, field)).toBe(0);
    expect(ops.pondContactSoil(undefined, 297.6, 1, field)).toBe(0);
    expect(ops.pondContactSoil(338.9, undefined, 1, field)).toBe(0);
    expect(ops.pondContactSoil(338.9, 297.6, 1, null)).toBe(0);
    expect(
      ops.pondContactSoil(338.9, 297.6, 1, {
        ...field,
        coastalMeadow: undefined,
      }),
    ).toBe(0);
  });

  it("matches independent pond contact kernels in CPU and real TSL without changing wetness or physical support", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const { pondContactGround: _contacts, ...beforeContact } = field;
    expect(_contacts).toHaveLength(2);
    const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const smooth = (a: number, b: number, v: number) => {
      const t = clamp((v - a) / (b - a));
      return t * t * (3 - 2 * t);
    };
    const contact = (x: number, z: number, noise: number) => {
      const kernels = [
        [338.9, 297.6, 337.2, 295.8, 0.6, 1.8, 0.75],
        [348.35, 299.28, 350.13, 298.37, 0.45, 1.25, 0.55],
      ].map(([ax, az, bx, bz, inner, outer, strength]) => {
        const segment = new THREE.Line3(
          new THREE.Vector3(ax, 0, az),
          new THREE.Vector3(bx, 0, bz),
        );
        const point = new THREE.Vector3(x, 0, z);
        const closest = segment.closestPointToPoint(
          point,
          true,
          new THREE.Vector3(),
        );
        return (
          strength *
          (1 - smooth(inner ** 2, outer ** 2, point.distanceToSquared(closest)))
        );
      });
      return Math.max(...kernels) * (0.8 + 0.2 * clamp(noise));
    };
    let changed = 0;
    for (const [x, z] of [
      [338.9, 297.6],
      [338.05, 296.7],
      [337.2, 295.8],
      [338.2, 294.8],
      [348.35, 299.28],
      [349.24, 298.825],
      [350.13, 298.37],
      [351.1, 299.1],
      [343, 302],
      [343, 308],
      [348, 318],
    ])
      for (const distortNoise of [-1, 0, 0.5, 1, 2])
        for (const pondSoil of [0, 0.5, 1]) {
          const expected = contact(x, z, distortNoise);
          const cpu = ops.pondContactSoil(x, z, distortNoise, field);
          const node = createCompactPondContactSoil(
            vec3(x, 28.08, z),
            float(distortNoise),
            field,
          );
          expect(cpu).toBeCloseTo(expected, 13);
          expect(vectorValue(node)[0]).toBeCloseTo(expected, 13);
          expect(cpu).toBeGreaterThanOrEqual(0);
          expect(cpu).toBeLessThanOrEqual(0.75);
          const input = {
            x,
            z,
            meadowNoise: 0.5,
            distortNoise,
            slope: 0.11,
            roadInfluence: 0.5,
            road: 0.5,
            pondSoil,
            coastalCoverage: 0.2,
            field,
          };
          const before = ops.wornTurfWeights({
            ...input,
            field: beforeContact,
          });
          const actual = ops.wornTurfWeights(input);
          const gpu = createCompactWornTurfWeights({
            worldPosition: vec3(x, 28.08, z),
            meadowNoise: float(0.5),
            distortNoise: float(distortNoise),
            geometricSlope: float(0.11),
            rawRoadInfluence: float(0.5),
            road: float(0.5),
            pondSoil: float(pondSoil),
            coastalCoverage: float(0.2),
            field,
          });
          expect(actual.soil).toBeCloseTo(
            Math.max(before.soil, expected * (1 - pondSoil) * 0.8),
            13,
          );
          expect(vectorValue(gpu.soil)[0]).toBeCloseTo(actual.soil, 13);
          expect(actual.road).toBe(before.road);
          expect(vectorValue(gpu.road)[0]).toBeCloseTo(before.road, 13);
          if (pondSoil === 1) expect(actual.soil).toBe(0);
          if (expected === 0) expect(actual).toEqual(before);
          if (actual.soil > before.soil) changed++;
          const supportInput = {
            noiseValue: 0.54,
            distortNoise,
            slope: 0.11,
            surface: { x, z, height: 28.08, pond, macroField: field },
          };
          const beforeSupport = {
            ...supportInput,
            surface: { ...supportInput.surface, macroField: beforeContact },
          };
          expect(ops.grassSupport(supportInput)).toBe(
            ops.grassSupport(beforeSupport),
          );
          expect(ops.grassSupportBeforeCoast(supportInput)).toBe(
            ops.grassSupportBeforeCoast(beforeSupport),
          );
          expect(
            ops.pondWeights({
              ...supportInput.surface,
              noiseValue: distortNoise,
            }),
          ).toEqual(
            ops.pondWeights({
              ...beforeSupport.surface,
              noiseValue: distortNoise,
            }),
          );
        }
    expect(changed).toBeGreaterThan(20);
  });

  it("bounds the frozen bank verge to its actual bank anchors and preserves omission and outer coordinates", () => {
    const ops = createCompactTerrainColorOperations();
    const selected = candidateProfile();
    const field = ops.macroField(selected)!;
    const { southernMeadow: _candidate, ...historical } = selected;
    const oldField = ops.macroField(historical);
    expect(oldField).not.toHaveProperty("bankVerge");
    expect(
      ops.macroField({ ...selected, id: "unrelated-meadow-layout" }),
    ).not.toHaveProperty("bankVerge");
    expect(field.bankVerge).toEqual({
      minX: 340,
      maxX: 357,
      minZ: 310,
      maxZ: 324,
      feather: 2,
      wearStart: 0.1,
      wearEnd: 0.8,
      minimumScale: 0.55,
      heightScale: 0.65,
      wornHeightScale: 0.35,
      wear: [
        {
          startX: 346,
          startZ: 319,
          endX: 350,
          endZ: 319.5,
          coreRadius: 0.7,
          outerRadius: 1.55,
          strength: 0.8,
        },
        {
          startX: 350,
          startZ: 319.5,
          endX: 354,
          endZ: 321,
          coreRadius: 0.6,
          outerRadius: 1.35,
          strength: 0.62,
        },
        {
          startX: 346,
          startZ: 319,
          endX: 342.5,
          endZ: 322,
          coreRadius: 0.55,
          outerRadius: 1.2,
          strength: 0.55,
        },
      ],
      grassTint: [0.96, 0.88, 1],
      tipBrightness: 1.08,
    });
    expect(Object.isFrozen(field.bankVerge)).toBe(true);
    expect(Object.isFrozen(field.bankVerge!.grassTint)).toBe(true);
    expect(Object.isFrozen(field.bankVerge!.wear)).toBe(true);
    expect(field.bankVerge!.wear.every(Object.isFrozen)).toBe(true);
    const bank = ALL_WORLD_AREAS.central_haven.stations!.find(
      (s) => s.type === "bank",
    )!;
    expect(bank.position).toMatchObject({ x: 348, z: 318 });
    const clerk = ALL_WORLD_AREAS.central_haven.npcs!.find(
      (npc) => npc.id === "bank_clerk",
    )!;
    expect(clerk.position).toMatchObject({ x: 356, z: 324 });
    expect(clerk.position.x).toBeLessThanOrEqual(field.bankVerge!.maxX);
    expect(clerk.position.z).toBeLessThanOrEqual(field.bankVerge!.maxZ);
    expect(
      ops.bankVergeLocality(clerk.position.x - 2, clerk.position.z - 3, field),
    ).toBe(1);
    for (const [x, z] of [
      [348, 318],
      [348, 321],
      [346, 319],
      [350, 319.5],
      [354, 321],
    ])
      expect(ops.bankVergeLocality(x, z, field)).toBe(1);
    for (const [x, z] of [
      [340, 318],
      [357, 318],
      [348, 310],
      [348, 324],
      [339, 318],
      [358, 318],
      [348, 309],
      [348, 325],
    ]) {
      expect(ops.bankVergeLocality(x, z, field)).toBe(0);
      expect(ops.bankVergeClumpScale(x, z, 0.8, field)).toBe(1);
    }
    expect(ops.bankVergeLocality(341, 311, field)).toBe(0.25);
    expect(ops.bankVergeLocality(undefined, 318, field)).toBe(0);
    expect(ops.bankVergeLocality(348, undefined, field)).toBe(0);
    for (const absent of [
      null,
      oldField,
      { ...field, coastalMeadow: undefined },
    ]) {
      expect(ops.bankVergeLocality(348, 318, absent)).toBe(0);
      expect(ops.bankVergeClumpScale(348, 318, 0.8, absent)).toBe(1);
    }
    let previous = 1;
    for (let index = 0; index <= 100; index++) {
      const road = index / 100;
      const t = Math.max(0, Math.min(1, (road - 0.1) / 0.7));
      const expected = 1 - 0.45 * t * t * (3 - 2 * t);
      const scale = ops.bankVergeClumpScale(348, 318, road, field);
      expect(scale).toBeCloseTo(expected, 14);
      expect(scale).toBeGreaterThanOrEqual(0.55);
      expect(scale).toBeLessThanOrEqual(previous);
      previous = scale;
    }
  });

  it("shares the local grass reflectance and vertical factor without changing soil or outer meadow", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const palette = ops.getPalette();
    const grass: CompactTerrainLayer = {
      albedo: vec3(...(palette.grass as [number, number, number])),
      roughness: float(0.9),
      ao: float(0.8),
      worldNormal: vec3(0, 1, 0),
      height: float(0.4),
    };
    for (const [x, z, locality] of [
      [348, 318, 1],
      [341, 318, 0.5],
      [341, 311, 0.25],
      [339, 318, 0],
      [357, 318, 0],
      [348, 324, 0],
    ]) {
      const wear = ops.bankVergeWear(x, z, field);
      expect(ops.bankVergeHeightScale(x, z, field)).toBeCloseTo(
        1 - 0.35 * locality - 0.3 * wear,
        14,
      );
      const tint = ops.bankVergeGrassTint(x, z, field);
      expect(tint).toEqual([1 - 0.04 * locality, 1 - 0.12 * locality, 1]);
      const position = vec3(x, 28, z);
      expect(
        vectorValue(createCompactBankVergeLocality(position, field))[0],
      ).toBeCloseTo(locality, 14);
      const tinted = applyCompactBankVergeGrassTint(
        grass,
        "fine-meadow-green-v1",
        position,
        field,
      );
      vectorValue(tinted.albedo).forEach((value, channel) =>
        expect(value).toBeCloseTo(palette.grass[channel] * tint[channel], 14),
      );
      for (const key of ["roughness", "ao", "worldNormal", "height"] as const)
        expect(tinted[key]).toBe(grass[key]);
      expect(
        applyCompactBankVergeGrassTint(grass, undefined, position, field),
      ).toBe(grass);
      const input = {
        noiseValue: 0.5,
        meadowNoise: 0.5,
        distortNoise: 0.5,
        slope: 0,
        roadInfluence: 0,
        surface: { x, z, height: 28.4, pond: null, macroField: field },
      };
      // A neutral descriptor reconstructs the prior grass reflectance only;
      // road and locality shaping remain exactly the same in both samples.
      const neutralField = {
        ...field,
        bankVerge: {
          ...field.bankVerge!,
          grassTint: [1, 1, 1] as const,
        },
      };
      const oldInput = {
        ...input,
        surface: { ...input.surface, macroField: neutralField },
      };
      expect(ops.sample(input)).toEqual(ops.sample(oldInput));
      for (const roadInfluence of [0, 1]) {
        const actual = ops.sample({
          ...input,
          roadInfluence,
          grassColorGrade: "fine-meadow-green-v1",
        });
        const previous = ops.sample({
          ...oldInput,
          roadInfluence,
          grassColorGrade: "fine-meadow-green-v1",
        });
        if (roadInfluence === 1 || locality === 0)
          expect(actual).toEqual(previous);
        else {
          expect(actual.r).toBeLessThan(previous.r);
          expect(actual.g).toBeLessThan(previous.g);
          expect(actual.b).toBe(previous.b);
        }
      }
      expect(ops.grassSupport(input)).toBe(ops.grassSupport(oldInput));
    }
    for (const absent of [null, { ...field, coastalMeadow: undefined }]) {
      expect(ops.bankVergeHeightScale(348, 318, absent)).toBe(1);
      expect(ops.bankVergeGrassTint(348, 318, absent)).toEqual([1, 1, 1]);
      expect(
        applyCompactBankVergeGrassTint(
          grass,
          "fine-meadow-green-v1",
          vec3(348, 28, 318),
          absent,
        ),
      ).toBe(grass);
    }
  });

  it("shares authored bank wear and vertical groups with independent capsule distances", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const verge = field.bankVerge!;
    let mixed = 0;
    for (const x of [
      339, 340, 340.5, 341, 342.5, 345, 346, 348, 350, 351, 354, 356, 357,
    ])
      for (const z of [
        309, 310, 311, 317.7, 318, 319, 319.5, 320.3, 321, 322, 323, 324, 325,
      ]) {
        const position = new THREE.Vector3(x, 0, z);
        const locality =
          THREE.MathUtils.smoothstep(
            x,
            verge.minX,
            verge.minX + verge.feather,
          ) *
          (1 -
            THREE.MathUtils.smoothstep(
              x,
              verge.maxX - verge.feather,
              verge.maxX,
            )) *
          THREE.MathUtils.smoothstep(
            z,
            verge.minZ,
            verge.minZ + verge.feather,
          ) *
          (1 -
            THREE.MathUtils.smoothstep(
              z,
              verge.maxZ - verge.feather,
              verge.maxZ,
            ));
        const expected =
          locality *
          Math.max(
            0,
            ...verge.wear.map((ribbon) => {
              const nearest = new THREE.Line3(
                new THREE.Vector3(ribbon.startX, 0, ribbon.startZ),
                new THREE.Vector3(ribbon.endX, 0, ribbon.endZ),
              ).closestPointToPoint(position, true, new THREE.Vector3());
              return (
                ribbon.strength *
                (1 -
                  THREE.MathUtils.smoothstep(
                    nearest.distanceToSquared(position),
                    ribbon.coreRadius ** 2,
                    ribbon.outerRadius ** 2,
                  ))
              );
            }),
          );
        const expectedHeight = 1 - 0.35 * locality - 0.3 * expected;
        expect(ops.bankVergeWear(x, z, field)).toBeCloseTo(expected, 13);
        expect(
          vectorValue(createCompactBankVergeWear(vec3(x, 28, z), field))[0],
        ).toBeCloseTo(expected, 13);
        expect(ops.bankVergeHeightScale(x, z, field)).toBeCloseTo(
          expectedHeight,
          13,
        );
        expect(
          vectorValue(
            createCompactBankVergeHeightScale(vec3(x, 28, z), field),
          )[0],
        ).toBeCloseTo(expectedHeight, 13);
        expect(expectedHeight).toBeGreaterThanOrEqual(0.41 - 1e-14);
        expect(expectedHeight).toBeLessThanOrEqual(1);
        if (expected > 0 && expected < 0.8) mixed++;
      }
    expect(mixed).toBeGreaterThan(10);
    for (const fieldWithoutWear of [
      null,
      { ...field, coastalMeadow: undefined },
    ]) {
      expect(ops.bankVergeWear(348, 319, fieldWithoutWear)).toBe(0);
      expect(
        vectorValue(
          createCompactBankVergeWear(vec3(348, 28, 319), fieldWithoutWear),
        )[0],
      ).toBe(0);
      expect(
        vectorValue(
          createCompactBankVergeHeightScale(
            vec3(348, 28, 319),
            fieldWithoutWear,
          ),
        )[0],
      ).toBe(1);
    }
  });

  it("layers bank wear into the existing physical soil channels without changing support or full cores", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const noWear = { ...field, bankVerge: { ...field.bankVerge!, wear: [] } };
    const palette = ops.getPalette();
    const base = {
      noiseValue: 0.5,
      meadowNoise: 0.5,
      distortNoise: 0.5,
      slope: 0,
      roadInfluence: 0,
      surface: {
        x: 348,
        z: 319.25,
        height: 28.4,
        pond: null,
        macroField: field,
      },
    };
    const without = {
      ...base,
      surface: { ...base.surface, macroField: noWear },
    };
    expect(ops.sample(base)).toEqual(ops.sample(without));
    const wear = ops.bankVergeWear(base.surface.x, base.surface.z, field);
    expect(wear).toBe(0.8);
    const previous = ops.sample({
      ...without,
      grassColorGrade: "fine-meadow-green-v1",
    });
    const current = ops.sample({
      ...base,
      grassColorGrade: "fine-meadow-green-v1",
    });
    for (const [i, channel] of (["r", "g", "b"] as const).entries())
      expect(current[channel]).toBeCloseTo(
        THREE.MathUtils.lerp(previous[channel], palette.dirt[i], wear),
        13,
      );
    expect(ops.grassSupport(base)).toBe(ops.grassSupport(without));
    expect(ops.bankVergeClumpScale(348, 319.25, 0.6, field)).toBe(
      ops.bankVergeClumpScale(348, 319.25, 0.6, noWear),
    );
    expect(
      ops.sample({
        ...base,
        roadInfluence: 1,
        grassColorGrade: "fine-meadow-green-v1",
      }),
    ).toEqual(
      ops.sample({
        ...without,
        roadInfluence: 1,
        grassColorGrade: "fine-meadow-green-v1",
      }),
    );
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: candidateProfile(),
      compactGrassColorGrade: "fine-meadow-green-v1",
      compactSurfaceBlend: "height-v1",
    });
    try {
      for (const surface of [
        material.colorNode,
        material.roughnessNode,
        material.aoNode,
        material.normalNode,
      ]) {
        const names = [...graph(surface)].map((node) =>
          Reflect.get(node, "name"),
        );
        expect(
          names.filter((name) => name === "compactBankVergeWear"),
        ).toHaveLength(1);
        expect(
          names.filter((name) => name === "compactTurfAndBankSoil"),
        ).toHaveLength(1);
      }
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
    } finally {
      material.dispose();
    }
  });

  describe("pond-service terrain wear (actual TSL arithmetic, not rendered pixels)", () => {
    // Independent valid appearance fixture, matching the grass graph tests.
    // Actual court/chest/clerk/dock binding is covered in CompactIslandPaths.
    const service: CompactTerrainBankVerge = {
      minX: 378,
      maxX: 390,
      minZ: 432,
      maxZ: 446,
      feather: 1,
      wearStart: 0.1,
      wearEnd: 0.9,
      minimumScale: 1,
      heightScale: 1,
      wornHeightScale: 0.35,
      tipBrightness: 1,
      grassTint: [1, 1, 1],
      wear: [
        {
          startX: 382,
          startZ: 436,
          endX: 386,
          endZ: 436,
          coreRadius: 0.5,
          outerRadius: 1,
          strength: 0.8,
        },
        {
          startX: 386,
          startZ: 436,
          endX: 386,
          endZ: 440,
          coreRadius: 0.4,
          outerRadius: 0.9,
          strength: 0.62,
        },
        {
          startX: 382,
          startZ: 436,
          endX: 382,
          endZ: 440,
          coreRadius: 0.3,
          outerRadius: 0.8,
          strength: 0.55,
        },
      ],
    };
    const points = [
      [384, 436],
      [386, 439],
      [382, 439], // Three unequal ribbon cores.
      [386, 436], // Overlap must use max, not addition.
      [384, 436.75],
      [386.65, 439],
      [382.55, 439], // Capsule shoulders.
      [388, 444],
      [378, 432],
      [390, 446],
      [410, 455], // Unworn/outer controls.
      [348, 319.25],
      [341, 314],
      [339, 314], // Existing town and feather.
    ] as const;
    const expectedServiceWear = (x: number, z: number) => {
      const smooth = THREE.MathUtils.smoothstep;
      const locality =
        smooth(x, service.minX, service.minX + service.feather) *
        (1 - smooth(x, service.maxX - service.feather, service.maxX)) *
        smooth(z, service.minZ, service.minZ + service.feather) *
        (1 - smooth(z, service.maxZ - service.feather, service.maxZ));
      const point = new THREE.Vector3(x, 0, z);
      return (
        locality *
        Math.max(
          0,
          ...service.wear.map((ribbon) => {
            const closest = new THREE.Line3(
              new THREE.Vector3(ribbon.startX, 0, ribbon.startZ),
              new THREE.Vector3(ribbon.endX, 0, ribbon.endZ),
            ).closestPointToPoint(point, true, new THREE.Vector3());
            return (
              ribbon.strength *
              (1 -
                smooth(
                  closest.distanceToSquared(point),
                  ribbon.coreRadius ** 2,
                  ribbon.outerRadius ** 2,
                ))
            );
          }),
        )
      );
    };

    it("matches independent pond capsules and CPU wear with exact town/outside palette and support parity", () => {
      const ops = createCompactTerrainColorOperations();
      const profile = candidateProfile();
      const previous = ops.macroField(profile)!;
      const combined = ops.macroField(
        profile,
        undefined,
        undefined,
        undefined,
        service,
      )!;
      expect(combined.bankVerge).toEqual(previous.bankVerge);
      expect(combined.pondServiceGround).toEqual(service);
      const wearNode = createCompactBankVergeWear(positionWorld, combined);
      expect([
        expectedServiceWear(384, 436),
        expectedServiceWear(386, 439),
        expectedServiceWear(382, 439),
      ]).toEqual([0.8, 0.62, 0.55]);
      let changed = 0;
      for (const [x, z] of points) {
        const serviceWear = expectedServiceWear(x, z);
        const expected = Math.max(
          ops.bankVergeWear(x, z, previous),
          serviceWear,
        );
        expect(ops.bankVergeWear(x, z, combined)).toBeCloseTo(expected, 13);
        expect(
          vectorValue(wearNode, new Map([[positionWorld, [x, 28.4, z]]]))[0],
        ).toBeCloseTo(expected, 13);
        const base = {
          noiseValue: 0.5,
          meadowNoise: 0.5,
          distortNoise: 0.5,
          slope: 0,
          roadInfluence: 0,
          surface: { x, z, height: 28.4, pond: null, macroField: previous },
        };
        const candidate = {
          ...base,
          surface: { ...base.surface, macroField: combined },
        };
        expect(ops.sample(candidate)).toEqual(ops.sample(base));
        expect(ops.grassSupport(candidate)).toBe(ops.grassSupport(base));
        expect(ops.bankVergeClumpScale(x, z, 0.6, combined)).toBe(
          ops.bankVergeClumpScale(x, z, 0.6, previous),
        );
        expect(ops.bankVergeGrassTint(x, z, combined)).toEqual(
          ops.bankVergeGrassTint(x, z, previous),
        );
        const before = ops.sample({
          ...base,
          grassColorGrade: "fine-meadow-green-v1",
        });
        const after = ops.sample({
          ...candidate,
          grassColorGrade: "fine-meadow-green-v1",
        });
        if (serviceWear === 0) expect(after).toEqual(before);
        else {
          changed++;
          expect(after).not.toEqual(before);
          for (const [i, channel] of (["r", "g", "b"] as const).entries())
            expect(after[channel]).toBeCloseTo(
              THREE.MathUtils.lerp(
                before[channel],
                ops.getPalette().dirt[i],
                serviceWear,
              ),
              13,
            );
        }
        expect(
          ops.sample({
            ...candidate,
            roadInfluence: 1,
            grassColorGrade: "fine-meadow-green-v1",
          }),
        ).toEqual(
          ops.sample({
            ...base,
            roadInfluence: 1,
            grassColorGrade: "fine-meadow-green-v1",
          }),
        );
      }
      expect(changed).toBe(7);
    });

    it("shares one combined soil node across all four real terrain channels without duplicate role names", () => {
      const options = {
        compactPbr: true,
        compactProfile: candidateProfile(),
        compactGrassColorGrade: "fine-meadow-green-v1" as const,
        compactSurfaceBlend: "height-v1" as const,
      };
      const previous = createTerrainMaterial(undefined, options);
      const candidate = createTerrainMaterial(undefined, {
        ...options,
        pondServiceGround: service,
      });
      const findSoil = (material: typeof candidate) => {
        const nodes = new Set<Node>();
        let soil: Node | undefined;
        for (const root of [
          material.colorNode,
          material.roughnessNode,
          material.aoNode,
          material.normalNode,
        ]) {
          const channel = graph(root);
          const matching = [...channel].filter(
            (node) => Reflect.get(node, "name") === "compactTurfAndBankSoil",
          );
          expect(matching).toHaveLength(1);
          if (soil) expect(matching[0]).toBe(soil);
          soil = matching[0];
          channel.forEach((node) => nodes.add(node));
        }
        if (!soil) throw new Error("Missing actual terrain soil node");
        // r186's nodeProxyIntent wraps MathNode in its own unnamed VarNode;
        // the explicit soil variable owns that wrapper, not MathNode directly.
        const intent = Reflect.get(soil, "node") as Node;
        expect(intent.type).toBe("VarNode");
        expect(Reflect.get(intent, "name")).toBeNull();
        expect(Reflect.get(intent, "intent")).toBe(true);
        const mixNode = Reflect.get(intent, "node") as Node;
        expect(mixNode).toBeInstanceOf(THREE.Node);
        expect(Reflect.get(mixNode, "method")).toBe("mix");
        const baseSoil = Reflect.get(mixNode, "aNode") as Node;
        const wear = Reflect.get(mixNode, "cNode") as Node;
        expect(baseSoil).toBeInstanceOf(THREE.Node);
        expect(wear).toBeInstanceOf(THREE.Node);
        return { nodes, soil, baseSoil, wear };
      };
      try {
        const before = findSoil(previous),
          after = findSoil(candidate);
        const names = [...after.nodes]
          .filter((node) => node.type === "VarNode")
          .map((node) => Reflect.get(node, "name") as unknown)
          .filter(
            (name): name is string =>
              typeof name === "string" &&
              /^compact(?:BankVerge|PondServiceVerge|TurfAndBankSoil)/.test(
                name,
              ),
          );
        expect(names.slice().sort()).toEqual(
          [
            "compactBankVergeLocality",
            "compactBankVergeWear",
            "compactPondServiceVergeLocality",
            "compactPondServiceVergeWear",
            "compactTurfAndBankSoil",
          ].sort(),
        );
        expect(new Set(names).size).toBe(names.length);
        const ops = createCompactTerrainColorOperations();
        const field = ops.macroField(
          options.compactProfile,
          undefined,
          undefined,
          undefined,
          service,
        )!;
        for (const [x, z] of points) {
          const position: readonly number[] = [x, 28.4, z];
          const wear = ops.bankVergeWear(x, z, field);
          expect(
            vectorValue(after.wear, new Map([[positionWorld, position]]))[0],
          ).toBeCloseTo(wear, 13);
          // Parameterize only the incoming worn-turf soil scalar. Evaluate the
          // actual factory's connected mix; do not fake texture/GPU sampling.
          for (const base of [0, 0.23, 1]) {
            const value = vectorValue(
              after.soil,
              new Map([
                [positionWorld, position],
                [after.baseSoil, [base]],
              ]),
            )[0];
            expect(value).toBeCloseTo(THREE.MathUtils.lerp(base, 1, wear), 13);
            if (expectedServiceWear(x, z) === 0)
              expect(value).toBe(
                vectorValue(
                  before.soil,
                  new Map([
                    [positionWorld, position],
                    [before.baseSoil, [base]],
                  ]),
                )[0],
              );
          }
        }
        expect(candidate.positionNode).toBeNull();
        expect(candidate.displacementMap).toBeNull();
        expect(candidate.transparent).toBe(previous.transparent);
        expect(candidate.depthWrite).toBe(previous.depthWrite);
      } finally {
        candidate.dispose();
        previous.dispose();
      }
    });
  });

  it("removes only the bank's second road-edge remap with exact CPU/TSL locality and unchanged soil support", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const { bankVerge: _verge, ...previousField } = field;
    const smooth = (a: number, b: number, value: number) => {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    let changed = 0;
    for (const x of [339, 340, 341, 342, 348, 355, 356, 357, 358])
      for (const z of [309, 310, 311, 312, 318, 322, 323, 324, 325])
        for (const raw of [0, 0.1, 0.25, 0.5, 0.7, 0.79, 0.8, 1]) {
          const road = ops.weights({
            noiseValue: 0.6,
            distortNoise: 0.5,
            slope: 0,
            roadInfluence: raw,
          }).road;
          const input = {
            x,
            z,
            meadowNoise: 0.6,
            distortNoise: 0.5,
            slope: 0,
            roadInfluence: raw,
            road,
            pondSoil: 0,
            coastalCoverage: 0,
            field,
          };
          const before = ops.wornTurfWeights({
            ...input,
            field: previousField,
          });
          const after = ops.wornTurfWeights(input);
          const locality =
            smooth(340, 342, x) *
            (1 - smooth(355, 357, x)) *
            smooth(310, 312, z) *
            (1 - smooth(322, 324, z));
          const expected = before.road + (road - before.road) * locality;
          const nodes = createCompactWornTurfWeights({
            worldPosition: vec3(x, 28, z),
            meadowNoise: float(0.6),
            distortNoise: float(0.5),
            geometricSlope: float(0),
            rawRoadInfluence: float(raw),
            road: float(road),
            pondSoil: float(0),
            coastalCoverage: float(0),
            field,
          });
          expect(after.road).toBeCloseTo(expected, 14);
          expect(vectorValue(nodes.road)[0]).toBeCloseTo(expected, 14);
          expect(after.soil).toBe(before.soil);
          expect(vectorValue(nodes.soil)[0]).toBe(after.soil);
          if (locality === 0) expect(after).toEqual(before);
          if (locality === 1) expect(after.road).toBe(road);
          if (Math.abs(after.road - before.road) > 0.001) changed++;
          const surface = { x, z, height: 28, pond: null, macroField: field };
          const colors = { noiseValue: 0.6, ...input, surface };
          expect(ops.grassSupport(colors)).toBe(
            ops.grassSupport({
              ...colors,
              surface: { ...surface, macroField: previousField },
            }),
          );
          if (locality === 0)
            expect(ops.sample(colors)).toEqual(
              ops.sample({
                ...colors,
                surface: { ...surface, macroField: previousField },
              }),
            );
        }
    expect(changed).toBeGreaterThan(0);
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: candidateProfile(),
    });
    try {
      const names = [...graph(material.colorNode)].map((node) =>
        Reflect.get(node, "name"),
      );
      expect(
        names.filter((name) => name === "compactBankVergeLocality"),
      ).toHaveLength(1);
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
    } finally {
      material.dispose();
    }
  });

  it("admits worn turf only for the selected field with independently calculated bounded CPU/TSL weights", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const { coastalMeadow: _selected, ...historicalField } = field;
    expect(_selected).toBe(true);
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const smooth = (a: number, b: number, value: number) => {
      const t = clamp((value - a) / (b - a));
      return t * t * (3 - 2 * t);
    };
    const mix = THREE.MathUtils.lerp;
    let changed = 0;
    for (const meadowNoise of [-1, 0, 0.35, 0.65, 1, 2])
      for (const distortNoise of [-1, 0, 0.35, 0.65, 1, 2])
        for (const slope of [0, 0.04, 0.11, 0.18, 1])
          for (const roadInfluence of [
            0, 0.1, 0.5, 0.699, 0.7, 0.75, 0.8, 0.9, 1,
          ]) {
            const road = ops.weights({
              noiseValue: 0.54,
              distortNoise,
              slope,
              roadInfluence,
            }).road;
            const input = {
              meadowNoise,
              distortNoise,
              slope,
              roadInfluence,
              road,
              pondSoil: 0.2,
              coastalCoverage: 0.3,
              field,
            };
            const actual = ops.wornTurfWeights(input);
            const nodes = createCompactWornTurfWeights({
              meadowNoise: float(meadowNoise),
              distortNoise: float(distortNoise),
              geometricSlope: float(slope),
              rawRoadInfluence: float(roadInfluence),
              road: float(road),
              pondSoil: float(0.2),
              coastalCoverage: float(0.3),
              field,
            });
            const patch = smooth(
              0.35,
              0.65,
              clamp(meadowNoise) * 0.55 + clamp(distortNoise) * 0.45,
            );
            const land = 0.8 * 0.7;
            const expected = {
              soil: patch * (1 - smooth(0.04, 0.18, clamp(slope))) * 0.3 * land,
              road: mix(
                road,
                smooth(mix(0.12, 0.36, patch), mix(0.64, 0.88, patch), road),
                (1 - smooth(0.7, 0.8, roadInfluence)) * land,
              ),
            };
            for (const key of ["soil", "road"] as const) {
              expect(actual[key]).toBeCloseTo(expected[key], 14);
              expect(vectorValue(nodes[key])[0]).toBeCloseTo(expected[key], 14);
              expect(actual[key]).toBeGreaterThanOrEqual(0);
              expect(actual[key]).toBeLessThanOrEqual(key === "soil" ? 0.3 : 1);
            }
            if (roadInfluence === 0) expect(actual.road).toBe(0);
            if (roadInfluence >= 0.8) expect(actual.road).toBe(road);
            if (slope >= 0.18) expect(actual.soil).toBe(0);
            if (Math.abs(actual.road - road) > 0.01) changed++;
            for (const oldField of [null, historicalField]) {
              expect(
                ops.wornTurfWeights({ ...input, field: oldField }),
              ).toEqual({ soil: 0, road });
            }
          }
    expect(changed).toBeGreaterThan(100);
    const road = float(0.43);
    const absent = createCompactWornTurfWeights({
      meadowNoise: float(1),
      distortNoise: float(1),
      geometricSlope: float(0),
      rawRoadInfluence: float(0.4),
      road,
      pondSoil: float(0),
      coastalCoverage: float(0),
      field: historicalField,
    });
    expect(absent.road).toBe(road);
    expect(vectorValue(absent.soil)).toEqual([0]);
  });

  it("suppresses worn turf using the actual authored pond annulus and coastal coverage without expanding road support", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const pond = ops.validatePond(ALL_WORLD_AREAS.haven_pond.waterBodies![0])!;
    let partial = 0;
    for (const distance of [
      0,
      pond.radius,
      pond.radius + 2.25,
      pond.radius + 2.6,
      pond.radius + 3,
      pond.radius + 3.01,
    ])
      for (const relativeHeight of [-0.2, 0, 0.07, 0.11, 0.22, 0.4])
        for (const coastalCoverage of [-1, 0, 0.4, 1, 2]) {
          const position = {
            x: pond.centerX + distance,
            z: pond.centerZ,
            height: pond.surfaceY + relativeHeight,
            noiseValue: 0.5,
            pond,
          };
          const pondSoil = ops.pondWeights(position).soil;
          const pondNodes = createCompactPondSurfaceWeights(
            vec3(position.x, position.height, position.z),
            float(0.5),
            vec4(pond.centerX, pond.centerZ, pond.radius, pond.surfaceY),
          );
          expect(vectorValue(pondNodes.soil)[0]).toBeCloseTo(pondSoil, 13);
          const input = {
            meadowNoise: 1,
            distortNoise: 1,
            slope: 0,
            roadInfluence: 0,
            road: 0,
            pondSoil,
            coastalCoverage,
            field,
          };
          const weights = ops.wornTurfWeights(input);
          const nodes = createCompactWornTurfWeights({
            meadowNoise: float(1),
            distortNoise: float(1),
            geometricSlope: float(0),
            rawRoadInfluence: float(0),
            road: float(0),
            pondSoil: pondNodes.soil,
            coastalCoverage: float(coastalCoverage),
            field,
          });
          expect(weights.road).toBe(0);
          expect(vectorValue(nodes.road)).toEqual([0]);
          expect(vectorValue(nodes.soil)[0]).toBeCloseTo(weights.soil, 14);
          if (pondSoil === 1 || coastalCoverage >= 1)
            expect(weights.soil).toBe(0);
          if (pondSoil > 0 && pondSoil < 1 && coastalCoverage === 0) partial++;
          if (distance > pond.radius + 3 && coastalCoverage === 0)
            expect(weights.soil).toBe(0.3);
        }
    expect(partial).toBeGreaterThan(0);
  });

  it("blends worn turf coherently across all PBR channels before existing authored and full-core overrides", () => {
    const layer = (
      albedo: [number, number, number],
      roughness: number,
      ao: number,
      normal: [number, number, number],
    ) => ({
      albedo: vec3(...albedo),
      roughness: float(roughness),
      ao: float(ao),
      worldNormal: vec3(...normal),
    });
    const layers = {
      grass: layer([0.1, 0.3, 0.2], 0.9, 0.7, [0, 1, 0]),
      dirt: layer([0.3, 0.2, 0.1], 0.8, 0.8, [0.6, 0.8, 0]),
      rock: layer([0.5, 0.4, 0.3], 0.7, 0.9, [0, 0.8, 0.6]),
    };
    const coast = layer([0.08, 0.06, 0.04], 0.6, 0.6, [0, 1, 0]);
    const before = Object.values(layers).flatMap((entry) =>
      Object.values(entry).map((node) => node.uuid),
    );
    const view = new Map<Node, readonly number[]>([
      [cameraViewMatrix, new THREE.Matrix4().toArray()],
    ]);
    for (const soil of [0, 0.15, 0.3])
      for (const [dirt, talus, wear, habitat, coastal, cliff, road] of [
        [0.1, 0, 0, 0, 0, 0, 0],
        [0.2, 0.3, 0.4, 0.2, 0.25, 0.15, 0.5],
        [0.1, 1, 0, 0, 0, 0, 0],
        [0.1, 0, 1, 0, 0, 0, 0],
        [0.1, 0, 0, 1, 0, 0, 0],
        [0.1, 0, 0, 0, 1, 0, 0],
        [0.1, 0, 0, 0, 0, 1, 0],
        [0.1, 0.2, 0.3, 0.4, 0.2, 0.5, 1],
        [1, 0, 0, 0, 0, 0, 0],
      ]) {
        const args = [
          layers,
          float(dirt),
          float(cliff),
          float(road),
          { talus: float(talus), wear: float(wear) },
          float(habitat),
          { coverage: float(coastal), layer: coast },
        ] as const;
        const soilNode = float(soil).toVar("testWornTurfSoil");
        const actual = blendCompactTerrainLayers(...args, soilNode);
        const baseline = blendCompactTerrainLayers(...args);
        const mix = THREE.MathUtils.lerp;
        const expected = (a: number, b: number, c: number, d: number) => {
          let value = mix(a, b, dirt);
          value = mix(value, b, soil);
          value = mix(value, mix(b, c, 0.85), talus);
          value = mix(value, b, wear);
          value = mix(value, b, habitat);
          value = mix(value, d, coastal);
          return mix(mix(value, c, cliff), b, road);
        };
        for (const key of ["albedo", "roughness", "ao"] as const) {
          const channels = vectorValue(layers.grass[key]).map((v, i) =>
            expected(
              v,
              vectorValue(layers.dirt[key])[i],
              vectorValue(layers.rock[key])[i],
              vectorValue(coast[key])[i],
            ),
          );
          vectorValue(actual[key]).forEach((v, i) =>
            expect(v).toBeCloseTo(channels[i], 13),
          );
          expect(graph(actual[key]).has(soilNode)).toBe(true);
        }
        const normal = new THREE.Vector3()
          .fromArray(
            vectorValue(layers.grass.worldNormal).map((v, i) =>
              expected(
                v,
                vectorValue(layers.dirt.worldNormal)[i],
                vectorValue(layers.rock.worldNormal)[i],
                vectorValue(coast.worldNormal)[i],
              ),
            ),
          )
          .normalize();
        vectorValue(actual.normal, view).forEach((v, i) =>
          expect(v).toBeCloseTo(normal.toArray()[i], 13),
        );
        expect(graph(actual.normal).has(soilNode)).toBe(true);
        if (soil === 0)
          for (const key of ["albedo", "roughness", "ao", "normal"] as const)
            expect(vectorValue(actual[key], view)).toEqual(
              vectorValue(baseline[key], view),
            );
        if (
          [talus, wear, habitat, coastal, cliff, road, dirt].some(
            (value) => value === 1,
          )
        )
          for (const key of ["albedo", "roughness", "ao", "normal"] as const) {
            const original = vectorValue(baseline[key], view);
            // Repeated floating-point lerp/normalization can differ by one
            // Number ULP; the independent scalar weights/core remain exact.
            vectorValue(actual[key], view).forEach((value, i) =>
              expect(value).toBeCloseTo(original[i], 13),
            );
          }
        if (dirt === 1) {
          const wet = applyCompactPondWetness(actual, float(1));
          expect(vectorValue(wet.albedo)).toEqual(
            [0.3, 0.2, 0.1].map((v) => v * 0.72),
          );
          expect(vectorValue(wet.roughness)[0]).toBeCloseTo(0.62, 13);
        }
      }
    expect(
      Object.values(layers).flatMap((entry) =>
        Object.values(entry).map((node) => node.uuid),
      ),
    ).toEqual(before);
  });

  it("connects single worn-turf weights to every actual PBR root with only the existing twenty surface and three noise samples", () => {
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: candidateProfile(),
      compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
    });
    const baseline = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: DataManager.getWorldConfig()!.terrainProfile,
    });
    try {
      const owned = new Set(
        material
          .compactTerrainSurface!.getReceipt()
          .textures.map((entry) => entry.textureUuid),
      );
      const surfaceSamples = new Set<Node>(),
        noiseSamples = new Set<Node>(),
        roadSamples = new Set<Node>(),
        lampSamples = new Set<Node>();
      const roadTexture = getRoadInfluenceTextureState().textureNode.value;
      const lampTexture = getLamppostLightTextureState().textureNode.value;
      const shared = new Map<string, Set<Node>>(
        [
          "compactWornTurfPatch",
          "compactWornTurfSoil",
          "compactWornTurfRoad",
          "compactPondContactSoil",
        ].map((name) => [name, new Set<Node>()]),
      );
      for (const root of [
        material.colorNode,
        material.normalNode,
        material.roughnessNode,
        material.aoNode,
      ]) {
        const nodes = graph(root);
        for (const [name, owners] of shared) {
          const selected = [...nodes].filter(
            (node) => Reflect.get(node, "name") === name,
          );
          expect(selected).toHaveLength(1);
          owners.add(selected[0]);
        }
        for (const node of nodes) {
          if (
            !Reflect.get(node, "uvNode") ||
            Reflect.get(node, "isTextureNode") !== true
          )
            continue;
          const value: unknown = Reflect.get(node, "value");
          if (value instanceof THREE.Texture && owned.has(value.uuid))
            surfaceSamples.add(node);
          else if (value === getNoiseTexture()) noiseSamples.add(node);
          else if (value === roadTexture) roadSamples.add(node);
          else if (value === lampTexture) lampSamples.add(node);
          else throw new Error("Unaccounted sampled texture in worn turf");
        }
      }
      for (const owners of shared.values()) expect(owners.size).toBe(1);
      expect(owned.size).toBe(6);
      expect(surfaceSamples.size).toBe(20);
      expect(noiseSamples.size).toBe(3);
      expect(roadSamples.size).toBe(1);
      expect(lampSamples.size).toBe(1);
      const oldRoadSamples = [...graph(baseline.colorNode)].filter(
        (node) =>
          Reflect.get(node, "value") === roadTexture &&
          Reflect.get(node, "uvNode"),
      );
      expect(oldRoadSamples).toHaveLength(1);
      const oldLampSamples = [...graph(baseline.colorNode)].filter(
        (node) =>
          Reflect.get(node, "value") === lampTexture &&
          Reflect.get(node, "uvNode"),
      );
      expect(oldLampSamples).toHaveLength(1);
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
      expect(material.metalness).toBe(0);
      for (const root of [
        baseline.colorNode,
        baseline.normalNode,
        baseline.roughnessNode,
        baseline.aoNode,
      ])
        expect(
          [...graph(root)].some((node) =>
            shared.has(String(Reflect.get(node, "name"))),
          ),
        ).toBe(false);
    } finally {
      material.dispose();
      baseline.dispose();
    }
  });

  it("retains the independent native16 default palette and physical-support fingerprint", () => {
    // Derived read-only from native16/executed/.../CompactTerrainPalette.ts:
    // 31,462 bytes, SHA256 ee3eedaa0f7cda6712f376025e080327b6055b5666c3e90897b47ebb92233afe.
    // The test needs no external archive; it retains that pre-change output,
    // not a new CPU-vs-new-TSL agreement or a refreshed candidate golden.
    const ops = createCompactTerrainColorOperations();
    const rows: unknown[] = [];
    for (const grassColorGrade of [undefined, "fine-meadow-green-v1"] as const)
      for (const noiseValue of [0, 0.35, 0.54, 0.65, 1])
        for (const distortNoise of [0, 0.37, 1])
          for (const slope of [0, 0.04, 0.11, 0.18, 0.8])
            for (const roadInfluence of [0, 0.5, 0.7, 0.8, 1]) {
              const input = {
                grassColorGrade,
                noiseValue,
                meadowNoise: 0.71,
                distortNoise,
                slope,
                roadInfluence,
                surface: { x: 350, z: 320, height: 28.4, pond: null },
              };
              rows.push({
                color: ops.sample(input),
                support: ops.grassSupport(input),
                original: ops.grassSupportBeforeCoast(input),
                weights: ops.weights(input),
              });
            }
    expect(rows).toHaveLength(750);
    expect(
      createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    ).toBe("7868a34373b07cdd0e87fc5b8b6ba0392c087e7c670e062b5096d7ff21affee7");
  });

  it("retains worn-turf scalar and physical-support parity in the freshly minified real isolated worker", async () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const { coastalMeadow: _selected, ...historicalField } = field;
    expect(_selected).toBe(true);
    const inputs = [field, historicalField].flatMap((selectedField) =>
      [-1, 0.5, 2].flatMap((meadowNoise) =>
        [-1, 0.5, 2].flatMap((distortNoise) =>
          [0, 0.11, 0.18].flatMap((slope) =>
            [0, 0.5, 0.75, 0.8, 1].map((roadInfluence) => ({
              meadowNoise,
              distortNoise,
              slope,
              roadInfluence,
              road: ops.weights({
                noiseValue: 0.54,
                distortNoise,
                slope,
                roadInfluence,
              }).road,
              pondSoil: 0.3,
              coastalCoverage: 0.2,
              field: selectedField,
            })),
          ),
        ),
      ),
    );
    // Exercise both actual contact interiors after serialization, not only the
    // historical coordinate-free calls that intentionally skip local edits.
    const workerInputs = [
      ...inputs,
      ...inputs.flatMap((input) => [
        { ...input, x: 338.9, z: 297.6 },
        { ...input, x: 348.35, z: 299.28 },
      ]),
    ];
    const bundle = await build({
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
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads'); const ops=(${loaded.createCompactTerrainColorOperations.toString()})();parentPort.postMessage(${JSON.stringify(workerInputs)}.map(input=>ops.wornTurfWeights(input)));`,
      { eval: true, env: {} },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(
        workerInputs.map((input) => ops.wornTurfWeights(input)),
      );
      for (const input of inputs) {
        const base = {
          ...input,
          noiseValue: 0.54,
          surface: {
            x: 480,
            z: 495,
            height: field.seaLevel + 12,
            pond: null,
            macroField: input.field,
          },
        };
        const changedAppearance = {
          ...base,
          meadowNoise: 1 - input.meadowNoise,
        };
        expect(ops.weights(base)).toEqual(ops.weights(changedAppearance));
        expect(ops.grassSupport(base)).toBe(
          ops.grassSupport(changedAppearance),
        );
        expect(ops.grassSupportBeforeCoast(base)).toBe(
          ops.grassSupportBeforeCoast(changedAppearance),
        );
      }
    } finally {
      await worker.terminate();
    }
  });

  it("is owned by the admitted candidate profile, leaving absent-option worlds unchanged", () => {
    const ops = createCompactTerrainColorOperations();
    for (const profile of [
      SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
      validateWorldTerrainProfile(DataManager.getWorldConfig()!.terrainProfile),
    ]) {
      const field = ops.macroField(profile);
      expect(field?.coastalMeadow).toBeUndefined();
      for (const height of [-20, 16, 18, 21, 30]) {
        const input = { height, noiseValue: 0.7, distortNoise: 0.2, field };
        expect(ops.coastalGroundCover(input)).toBe(0);
        expect(
          vectorValue(
            createCompactCoastalGroundCover(
              float(height),
              float(0.7),
              float(0.2),
              field,
            ),
          ),
        ).toEqual([0]);
      }
    }
    const field = ops.macroField(candidateProfile())!;
    expect(field.coastalMeadow).toBe(true);
    expect(Object.isFrozen(field)).toBe(true);
    expect(DataManager.getWorldConfig()!.terrainProfile).not.toHaveProperty(
      "southernMeadow",
    );
  });

  it("matches CPU/TSL continuous metre-based coverage with irregular but bounded margins", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const coversAtThreeMetres = new Set<number>();
    for (const noiseValue of [-1, 0, 0.3, 0.5, 0.7, 1, 2])
      for (const distortNoise of [-1, 0, 0.5, 1, 2]) {
        const patch = smooth(
          0.35,
          0.65,
          Math.max(0, Math.min(1, noiseValue)) +
            (Math.max(0, Math.min(1, distortNoise)) - 0.5) * 0.12,
        );
        const full = 0.6 + 1.2 * patch,
          end = 3.8 + 2.4 * patch;
        const cover = (height: number) =>
          ops.coastalGroundCover({
            height: field.seaLevel + height,
            noiseValue,
            distortNoise,
            field,
          });
        coversAtThreeMetres.add(cover(3));
        for (const relative of [
          -2, 0, 0.1, 0.4, 0.6, 1, 1.8, 2, 3.8, 5, 6.2, 10,
        ]) {
          const expected = 1 - smooth(full, end, relative);
          expect(cover(relative)).toBeCloseTo(expected, 13);
          expect(cover(relative)).toBeGreaterThanOrEqual(0);
          expect(cover(relative)).toBeLessThanOrEqual(1);
          expect(
            vectorValue(
              createCompactCoastalGroundCover(
                float(field.seaLevel + relative),
                float(noiseValue),
                float(distortNoise),
                field,
              ),
            )[0],
          ).toBeCloseTo(expected, 13);
        }
        for (const boundary of [full, end]) {
          const epsilon = 1e-6;
          expect(
            Math.abs((cover(boundary) - cover(boundary - epsilon)) / epsilon),
          ).toBeLessThan(1e-5);
          expect(
            Math.abs((cover(boundary + epsilon) - cover(boundary)) / epsilon),
          ).toBeLessThan(1e-5);
        }
      }
    expect(coversAtThreeMetres.size).toBeGreaterThan(3);
    expect(
      Math.max(...coversAtThreeMetres) - Math.min(...coversAtThreeMetres),
    ).toBeGreaterThan(0.3);
  });

  it("blends all PBR channels and grass support, keeping dry roads, ponds and steep rock final", () => {
    const ops = createCompactTerrainColorOperations();
    const field = ops.macroField(candidateProfile())!;
    const { coastalMeadow: _candidate, ...oldField } = field;
    const palette = ops.getPalette();
    const viewInputs = new Map<Node, readonly number[]>([
      [cameraViewMatrix, new THREE.Matrix4().toArray()],
    ]);
    const layer = (
      rgb: number[],
      roughness: number,
      ao: number,
      normal: [number, number, number],
    ) => ({
      albedo: vec3(...(rgb as [number, number, number])),
      roughness: float(roughness),
      ao: float(ao),
      worldNormal: vec3(...normal),
    });
    const layers = {
      grass: layer(palette.grass, 0.91, 0.8, [0, 1, 0]),
      dirt: layer(palette.dirt, 0.88, 0.9, [0.6, 0.8, 0]),
      rock: layer(palette.rock, 0.76, 0.7, [0, 0.8, 0.6]),
    };
    for (const relative of [0, 0.2, 0.6, 1.8, 3, 5, 6.2, 12])
      for (const slope of [0, 0.07, 0.15, 0.23, 0.8])
        for (const roadInfluence of [0, 0.5, 1]) {
          const input = {
            noiseValue: 0.54,
            meadowNoise: 0.6,
            distortNoise: 0.37,
            slope,
            roadInfluence,
            surface: {
              x: 480,
              z: 495,
              height: field.seaLevel + relative,
              pond: null,
              macroField: field,
            },
          };
          const oldInput = {
            ...input,
            surface: { ...input.surface, macroField: oldField },
          };
          const macro = ops.macroWeights(480, 495, input.noiseValue, field);
          const weights = ops.weights({ ...input, macroSurface: macro });
          const coast = createCompactCoastWeights(
            vec3(480, input.surface.height, 495),
            float(input.noiseValue),
            float(input.distortNoise),
            float(macro.westRock),
            float(slope),
            field,
          );
          const coverage = createCompactCoastalGroundCover(
            float(input.surface.height),
            float(input.noiseValue),
            float(input.distortNoise),
            field,
          );
          const wetSoil = applyCompactCoastRock(
            layers.dirt,
            layers.dirt,
            coast,
          );
          const coastalRock = applyCompactCoastRock(
            layers.rock,
            layers.dirt,
            coast,
          );
          const baseline = blendCompactTerrainLayers(
            { ...layers, rock: coastalRock },
            float(weights.dirt),
            float(weights.cliff),
            float(weights.road),
          );
          const tintedGrass = applyCompactMeadowTint(
            layers.grass,
            float(input.meadowNoise),
            float(macro.dry),
            0.4,
          );
          // Retain the original tint/coastal-only graph explicitly; the new
          // candidate adds a separate whole-material soil/road composition.
          const beforeWornTurf = blendCompactTerrainLayers(
            { ...layers, grass: tintedGrass, rock: coastalRock },
            float(weights.dirt),
            float(weights.cliff),
            float(weights.road),
            undefined,
            undefined,
            { coverage, layer: wetSoil },
          );
          const wornTurf = createCompactWornTurfWeights({
            meadowNoise: float(input.meadowNoise),
            distortNoise: float(input.distortNoise),
            geometricSlope: float(slope),
            rawRoadInfluence: float(roadInfluence),
            road: float(weights.road),
            pondSoil: float(0),
            coastalCoverage: coverage,
            field,
          });
          const actual = blendCompactTerrainLayers(
            { ...layers, grass: tintedGrass, rock: coastalRock },
            float(weights.dirt),
            float(weights.cliff),
            wornTurf.road,
            undefined,
            undefined,
            { coverage, layer: wetSoil },
            wornTurf.soil,
          );
          const cpu = ops.sample(input);
          vectorValue(actual.albedo.mul(weights.variation)).forEach(
            (v, index) =>
              expect(v).toBeCloseTo(
                cpu[["r", "g", "b"][index] as "r" | "g" | "b"],
                12,
              ),
          );
          const cover = vectorValue(coverage)[0];
          expect(ops.grassSupport(input)).toBeCloseTo(
            ops.grassSupport(oldInput) * (1 - cover),
            14,
          );
          expect(ops.grassSupportBeforeCoast(input)).toBe(
            ops.grassSupport(oldInput),
          );
          for (const key of ["albedo", "roughness", "ao"] as const) {
            const expected = vectorValue(tintedGrass[key]).map((v, i) => {
              const dirt = vectorValue(layers.dirt[key])[i];
              const rock = vectorValue(coastalRock[key])[i];
              const wet = vectorValue(wetSoil[key])[i];
              let result = v + (dirt - v) * weights.dirt;
              result += (dirt - result) * vectorValue(wornTurf.soil)[0];
              result += (wet - result) * cover;
              result += (rock - result) * weights.cliff;
              return result + (dirt - result) * vectorValue(wornTurf.road)[0];
            });
            vectorValue(actual[key]).forEach((v, i) =>
              expect(v).toBeCloseTo(expected[i], 13),
            );
          }
          const expectedNormal = new THREE.Vector3().fromArray(
            vectorValue(layers.grass.worldNormal),
          );
          expectedNormal.lerp(
            new THREE.Vector3().fromArray(vectorValue(layers.dirt.worldNormal)),
            weights.dirt,
          );
          expectedNormal.lerp(
            new THREE.Vector3().fromArray(vectorValue(layers.dirt.worldNormal)),
            vectorValue(wornTurf.soil)[0],
          );
          expectedNormal.lerp(
            new THREE.Vector3().fromArray(vectorValue(wetSoil.worldNormal)),
            cover,
          );
          expectedNormal.lerp(
            new THREE.Vector3().fromArray(vectorValue(coastalRock.worldNormal)),
            weights.cliff,
          );
          expectedNormal
            .lerp(
              new THREE.Vector3().fromArray(
                vectorValue(layers.dirt.worldNormal),
              ),
              vectorValue(wornTurf.road)[0],
            )
            .normalize();
          vectorValue(actual.normal, viewInputs).forEach((v, i) =>
            expect(v).toBeCloseTo(expectedNormal.toArray()[i], 13),
          );
          if (
            roadInfluence === 1 ||
            (weights.cliff === 1 &&
              vectorValue(wornTurf.road)[0] === weights.road)
          ) {
            for (const key of ["albedo", "roughness", "ao", "normal"] as const)
              expect(vectorValue(actual[key], viewInputs)).toEqual(
                vectorValue(baseline[key], viewInputs),
              );
            expect(cpu).toEqual(ops.sample(oldInput));
          }
          // Preserve the previous tint-only nonalbedo contract on its exact
          // graph. Worn turf now intentionally mixes all channels above, but
          // the physical grass eligibility remains the same.
          if (relative >= 6.2) {
            for (const key of ["roughness", "ao", "normal"] as const)
              expect(vectorValue(beforeWornTurf[key], viewInputs)).toEqual(
                vectorValue(baseline[key], viewInputs),
              );
            expect(ops.grassSupport(input)).toBe(ops.grassSupport(oldInput));
            if (weights.cliff < 1 && weights.road < 1 && weights.dirt < 1)
              expect(cpu).not.toEqual(ops.sample(oldInput));
          }
          if (relative <= 0.6) expect(ops.grassSupport(input)).toBe(0);
          if (relative >= 0.6)
            expect(vectorValue(wetSoil.roughness)).toEqual([0.88]);
          // Pond soil suppresses coastal cover even in an artificial overlap.
          const pond = applyCompactPondWetness(
            blendCompactTerrainLayers(
              { ...layers, rock: coastalRock },
              float(1),
              float(0),
              float(0),
              undefined,
              undefined,
              { coverage: coverage.mul(0), layer: wetSoil },
            ),
            float(1),
          );
          expect(vectorValue(pond.albedo)).toEqual(
            palette.dirt.map((v) => v * 0.72),
          );
          expect(vectorValue(pond.roughness)[0]).toBeCloseTo(0.62, 13);
        }
  });

  it("separates regional fresh/dry reflectance with exact CPU/TSL parity and no new physical layers or texture samples", () => {
    const ops = createCompactTerrainColorOperations();
    const grade = "fine-meadow-regional-v1" as const;
    const descriptor = ops.getGrassColorGrade(grade);
    expect(descriptor.id).toBe(grade);
    expect(descriptor.linearMultipliers).toEqual([0.95, 1.3, 1.1]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.linearMultipliers)).toBe(true);
    expect(ops.getGrassColorGrade().id).toBe("fine-meadow-green-v1");
    const grass: CompactTerrainLayer = {
      albedo: vec3(0.2, 0.3, 0.15),
      roughness: float(0.91),
      ao: float(0.8),
      worldNormal: vec3(0.1, 0.99, 0.05),
    };
    for (const [noise, endpoint] of [
      [-1, [0.8, 1.25, 0.65]],
      [0.43, [0.8, 1.25, 0.65]],
      [0.515, [1.025, 1.1, 0.95]],
      [0.6, [1.25, 0.95, 1.25]],
      [2, [1.25, 0.95, 1.25]],
    ] as const)
      for (const macroDry of [0, 0.35, 1]) {
        const expected = endpoint.map(
          (value, channel) =>
            value + ([1.25, 0.95, 1.25][channel] - value) * macroDry,
        );
        const actual = applyCompactMeadowTint(
          grass,
          float(noise),
          float(macroDry),
          0.4,
          grade,
        );
        const cpu = ops.meadowTint(noise, macroDry, 0.4, grade);
        vectorValue(actual.albedo).forEach((value, channel) => {
          expect(cpu[channel]).toBeCloseTo(expected[channel], 14);
          expect(value).toBeCloseTo(
            [0.2, 0.3, 0.15][channel] * expected[channel],
            14,
          );
        });
        expect(actual.roughness).toBe(grass.roughness);
        expect(actual.ao).toBe(grass.ao);
        expect(actual.worldNormal).toBe(grass.worldNormal);
        expect(
          [...graph(actual.albedo)].some((node) =>
            Reflect.get(node, "isTextureNode"),
          ),
        ).toBe(false);
      }
    // Actual production color/normal/roughness/AO graphs use the same texture
    // budget. This is a structural check, not a native GPU-time measurement.
    const materials = (["fine-meadow-green-v1", grade] as const).map(
      (compactGrassColorGrade) =>
        createTerrainMaterial(undefined, {
          compactPbr: true,
          compactProfile: candidateProfile(),
          compactGrassColorGrade,
        }),
    );
    try {
      expect(materials[1].compactGrassColorGrade?.id).toBe(grade);
      for (const key of [
        "colorNode",
        "normalNode",
        "roughnessNode",
        "aoNode",
      ] as const) {
        const counts = materials.map(
          (material) =>
            [...graph(material[key]!)].filter((node) =>
              Reflect.get(node, "isTextureNode"),
            ).length,
        );
        if (key === "colorNode") expect(counts[0]).toBeGreaterThan(0);
        expect(counts[1]).toBe(counts[0]);
      }
      const field = ops.macroField(candidateProfile());
      for (const noise of [0, 0.43, 0.515, 0.6, 1])
        for (const slope of [0, 0.08, 0.2, 0.5])
          for (const roadInfluence of [0, 0.2, 1]) {
            const input = {
              noiseValue: noise,
              meadowNoise: noise,
              distortNoise: 0.5,
              slope,
              roadInfluence,
              surface: {
                x: 383,
                z: 438,
                height: 27,
                pond: null,
                macroField: field,
              },
            };
            const regionalInput = { ...input, grassColorGrade: grade };
            expect(ops.grassSupport(regionalInput)).toBe(
              ops.grassSupport(input),
            );
            expect(ops.grassSupportBeforeCoast(regionalInput)).toBe(
              ops.grassSupportBeforeCoast(input),
            );
            if (roadInfluence === 1)
              expect(ops.sample(regionalInput)).toEqual(
                ops.sample({
                  ...input,
                  grassColorGrade: "fine-meadow-green-v1",
                }),
              );
          }
    } finally {
      for (const material of materials) material.dispose();
    }
  });

  it("uses literal restrained tint endpoints in CPU and actual TSL without changing physical layer owners", () => {
    const ops = createCompactTerrainColorOperations();
    expect(ops.getComposition().coastalMeadowTintStrength).toBe(0.4);
    const grass: CompactTerrainLayer = {
      albedo: vec3(0.2, 0.3, 0.15),
      roughness: float(0.91),
      ao: float(0.8),
      worldNormal: vec3(0.1, 0.99, 0.05),
    };
    for (const [noise, endpoint] of [
      [-1, [0.92, 1.1, 0.86]],
      [0.43, [0.92, 1.1, 0.86]],
      [0.515, [1.13, 1.1, 0.97]],
      [0.6, [1.34, 1.1, 1.08]],
      [2, [1.34, 1.1, 1.08]],
    ] as const)
      for (const macroDry of [0, 0.35, 1]) {
        // Independently authored literal endpoints, not expectations derived
        // from production constants or the production CPU implementation.
        const expected = endpoint.map(
          (value, channel) =>
            value + ([1.1, 0.98, 1.1][channel] - value) * macroDry,
        );
        const actual = applyCompactMeadowTint(
          grass,
          float(noise),
          float(macroDry),
          0.4,
        );
        const cpu = ops.meadowTint(noise, macroDry, 0.4);
        vectorValue(actual.albedo).forEach((value, channel) => {
          expect(cpu[channel]).toBeCloseTo(expected[channel], 14);
          expect(value).toBeCloseTo(
            [0.2, 0.3, 0.15][channel] * expected[channel],
            14,
          );
        });
        expect(actual.roughness).toBe(grass.roughness);
        expect(actual.ao).toBe(grass.ao);
        expect(actual.worldNormal).toBe(grass.worldNormal);
        expect(vectorValue(grass.albedo)).toEqual([0.2, 0.3, 0.15]);
        expect(
          [...graph(actual.albedo)].some(
            (node) => Reflect.get(node, "isTextureNode") === true,
          ),
        ).toBe(false);
        // The optional argument must not change the old full-strength path.
        expect(ops.meadowTint(noise, macroDry)).toEqual(
          ops.meadowTint(noise, macroDry, 1),
        );
        expect(
          vectorValue(
            applyCompactMeadowTint(grass, float(noise), float(macroDry)).albedo,
          ),
        ).toEqual(
          vectorValue(
            applyCompactMeadowTint(grass, float(noise), float(macroDry), 1)
              .albedo,
          ),
        );
      }
  });

  it("routes candidate meadow noise through the real graded grass graph while Haven stays neutral and grass support stays fixed", () => {
    const ops = createCompactTerrainColorOperations();
    const profile = candidateProfile();
    const field = ops.macroField(profile)!;
    const { southernMeadow: _candidate, ...historicalProfile } = profile;
    const historicalField = ops.macroField(historicalProfile)!;
    const candidate = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: profile,
      compactGrassColorGrade: "fine-meadow-green-v1",
    });
    const historical = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: historicalProfile,
      compactGrassColorGrade: "fine-meadow-green-v1",
    });
    try {
      expect(_candidate).toBeDefined();
      expect(historicalField.havenGround).toBeDefined();
      const mean = ops.getPalette().grass;
      const colors = new Set<number>();
      for (const material of [candidate, historical]) {
        const isCandidate = material === candidate;
        const materialField = isCandidate ? field : historicalField;
        const nodes = graph(material.colorNode);
        const named = (name: string) => {
          const found = [...nodes].filter(
            (node) => Reflect.get(node, "name") === name,
          );
          expect(found).toHaveLength(1);
          return found[0];
        };
        const graded = named("compactGrassGradedAlbedo");
        const substrate = named("fineGrassSubstrateAlbedo");
        const tint = [...graph(graded)].filter(
          (node) => Reflect.get(node, "name") === "coastalMeadowTint",
        );
        expect(tint).toHaveLength(isCandidate ? 1 : 0);
        expect(graph(graded).has(substrate)).toBe(true);
        expect(graph(substrate).has(graded)).toBe(false);
        const noiseSamples = [...nodes].filter(
          (node) =>
            Reflect.get(node, "value") === getNoiseTexture() &&
            Reflect.get(node, "uvNode"),
        );
        expect(noiseSamples).toHaveLength(isCandidate ? 3 : 2);
        const meadowSamples = noiseSamples.filter((node) =>
          [...graph(Reflect.get(node, "uvNode"))].some(
            (uv) => Reflect.get(uv, "value") === 0.006,
          ),
        );
        expect(meadowSamples).toHaveLength(isCandidate ? 1 : 0);
        for (const root of [
          material.normalNode,
          material.roughnessNode,
          material.aoNode,
        ]) {
          const physical = graph(root);
          for (const node of tint) expect(physical.has(node)).toBe(false);
          for (const node of meadowSamples)
            expect(physical.has(node)).toBe(isCandidate);
        }
        const source = material.compactTerrainSurface!.getNode(
          "grass",
          "albedo-roughness",
        ).value;
        for (const [meadowNoise, endpoint] of [
          [0, [0.92, 1.1, 0.86]],
          [1, [1.34, 1.1, 1.08]],
        ] as const) {
          const x = 480,
            z = 495,
            height = field.seaLevel + 12;
          const input = {
            noiseValue: 0.54,
            meadowNoise,
            distortNoise: 0.37,
            slope: 0,
            roadInfluence: 0,
            surface: { x, z, height, pond: null, macroField: materialField },
          };
          const macro = ops.macroWeights(x, z, input.noiseValue, materialField);
          const supplied = new Map<Node, readonly number[]>([
            [positionWorld, [x, height, z]],
          ]);
          for (const node of graph(graded)) {
            if (!Reflect.get(node, "uvNode")) continue;
            if (Reflect.get(node, "value") === source)
              supplied.set(node, [...mean, 0.9]);
            if (Reflect.get(node, "value") === getNoiseTexture())
              supplied.set(node, [
                meadowSamples.includes(node) ? meadowNoise : input.noiseValue,
                0,
                0,
                1,
              ]);
          }
          for (const node of meadowSamples) {
            const uv: unknown = Reflect.get(node, "uvNode");
            if (!(uv instanceof THREE.Node))
              throw new Error("Missing actual meadow noise UV");
            expect(vectorValue(uv, supplied)).toEqual([x * 0.006, z * 0.006]);
          }
          vectorValue(graded, supplied).forEach((value, channel) => {
            const expectedTint = isCandidate
              ? endpoint[channel] +
                ([1.1, 0.98, 1.1][channel] - endpoint[channel]) * macro.dry
              : 1;
            expect(value).toBeCloseTo(
              mean[channel] * expectedTint * [0.95, 1.3, 1.1][channel],
              13,
            );
          });
          const alternative = { ...input, meadowNoise: 1 - meadowNoise };
          expect(ops.grassSupport(input)).toBe(ops.grassSupport(alternative));
          expect(ops.grassSupportBeforeCoast(input)).toBe(
            ops.grassSupportBeforeCoast(alternative),
          );
          expect(ops.weights(input)).toEqual(ops.weights(alternative));
          if (isCandidate) colors.add(ops.sample(input).r);
          else expect(ops.sample(input)).toEqual(ops.sample(alternative));
        }
        expect(material.positionNode).toBeNull();
        expect(material.displacementMap).toBeNull();
        expect(material.metalness).toBe(0);
      }
      expect(colors.size).toBe(2);
    } finally {
      candidate.dispose();
      historical.dispose();
    }
  });

  it("preserves restrained candidate tint and physical support in the freshly emitted isolated worker", async () => {
    const ops = createCompactTerrainColorOperations();
    const profile = candidateProfile();
    const field = ops.macroField(profile)!;
    const { southernMeadow: _candidate, ...historicalProfile } = profile;
    const historicalField = ops.macroField(historicalProfile)!;
    expect(_candidate).toBeDefined();
    const inputs = [field, historicalField].flatMap((macroField) =>
      [undefined, "fine-meadow-green-v1" as const].flatMap((grassColorGrade) =>
        [0, 0.43, 0.515, 0.6, 1].flatMap((meadowNoise) =>
          [0.2, 3, 12].flatMap((relative) =>
            [0, 0.15, 0.3].flatMap((slope) =>
              [0, 0.5, 1].map((roadInfluence) => ({
                noiseValue: 0.54,
                meadowNoise,
                grassColorGrade,
                distortNoise: 0.37,
                slope,
                roadInfluence,
                surface: {
                  x: 480,
                  z: 495,
                  height: field.seaLevel + relative,
                  pond: null,
                  macroField,
                },
              })),
            ),
          ),
        ),
      ),
    );
    const bundle = await build({
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
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads');
      const ops=(${loaded.createCompactTerrainColorOperations.toString()})();
      const inputs=${JSON.stringify(inputs)};
      parentPort.postMessage({field:ops.macroField(${JSON.stringify(profile)}),
        strength:ops.getComposition().coastalMeadowTintStrength,
        endpoints:[ops.meadowTint(0,0,0.4),ops.meadowTint(1,0,0.4),ops.meadowTint(1,1,0.4)],
        results:inputs.map(input=>({color:ops.sample(input),support:ops.grassSupport(input),originalSupport:ops.grassSupportBeforeCoast(input),weights:ops.weights(input)}))});`,
      { eval: true, env: {} },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual({
        field,
        strength: 0.4,
        endpoints: [
          [
            expect.closeTo(0.92, 14),
            expect.closeTo(1.1, 14),
            expect.closeTo(0.86, 14),
          ],
          [
            expect.closeTo(1.34, 14),
            expect.closeTo(1.1, 14),
            expect.closeTo(1.08, 14),
          ],
          [
            expect.closeTo(1.1, 14),
            expect.closeTo(0.98, 14),
            expect.closeTo(1.1, 14),
          ],
        ],
        results: inputs.map((input) => ({
          color: ops.sample(input),
          support: ops.grassSupport(input),
          originalSupport: ops.grassSupportBeforeCoast(input),
          weights: ops.weights(input),
        })),
      });
    } finally {
      await worker.terminate();
    }
  });

  it("connects one shared cover to actual material channels with the same six maps and twenty surface samples", () => {
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactProfile: candidateProfile(),
      compactPond: ALL_WORLD_AREAS.haven_pond.waterBodies![0],
    });
    try {
      const owned = new Set(
        material
          .compactTerrainSurface!.getReceipt()
          .textures.map((row) => row.textureUuid),
      );
      const maps = new Set<string>(),
        samples = new Set<Node>(),
        covers = new Set<Node>();
      for (const root of [
        material.colorNode!,
        material.normalNode!,
        material.roughnessNode!,
        material.aoNode!,
      ]) {
        const nodes = graph(root);
        const cover = [...nodes].filter(
          (node) => Reflect.get(node, "name") === "compactCoastalGroundCover",
        );
        expect(cover).toHaveLength(1);
        covers.add(cover[0]);
        for (const node of nodes) {
          const value: unknown = Reflect.get(node, "value");
          if (value instanceof THREE.Texture && owned.has(value.uuid)) {
            maps.add(value.uuid);
            if (Reflect.get(node, "uvNode")) samples.add(node);
          }
        }
      }
      expect(covers.size).toBe(1);
      expect(maps.size).toBe(6);
      expect(samples.size).toBe(20);
      expect([...samples].every((node) => Reflect.get(node, "gradNode"))).toBe(
        true,
      );
      expect(material.positionNode).toBeNull();
      expect(material.displacementMap).toBeNull();
      expect(material.metalness).toBe(0);
    } finally {
      material.dispose();
    }
  });
});

describe("compact grass base palette without changing default ecology", () => {
  it("keeps actual steep coastal faces on triplanar rock and retains low-slope headland contrast", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const ops = createCompactTerrainColorOperations();
    try {
      await terrain.init();
      const profile = terrain.getWorldTerrainProfile();
      const field = ops.macroField(profile)!;
      const target =
        field.seaLevel + (field.baseElevation - field.seaLevel) * 0.25;
      const transects = Array.from({ length: 12 }, (_, sector) => {
        const angle = (sector * Math.PI) / 6;
        return {
          name: `radial-${sector}`,
          start: 0,
          end: 240,
          step: 5,
          xz: (radius: number) =>
            [
              profile.island.centerX + Math.cos(angle) * radius,
              profile.island.centerZ + Math.sin(angle) * radius,
            ] as const,
        };
      });
      const lowland = profile.coastalApron?.lowland;
      expect(lowland).toBeDefined();
      if (!lowland) throw new Error("Expected the admitted coastal lowland");
      // First radial shore crossings hit the near bank before the curved
      // lowland. Keep all twelve rays and separately follow its authored axis.
      transects.push({
        name: "coastal-lowland-centerline",
        start: lowland.minZ,
        end: lowland.maxZ,
        step: 0.5,
        xz: (z: number) => {
          const t = Math.max(
            0,
            Math.min(1, (z - lowland.westReleaseZ) / lowland.westReleaseLength),
          );
          return [
            lowland.startX +
              (lowland.endX - lowland.startX) * t * t * (3 - 2 * t),
            z,
          ] as const;
        },
      });
      const samples: Array<{
        transect: string;
        x: number;
        z: number;
        y: number;
        slope: number;
        soil: number;
        lowSlopeSoil: number;
        cliff: number;
      }> = [];
      for (const transect of transects) {
        const height = (coordinate: number) =>
          terrain["getHeightAtComputed"](...transect.xz(coordinate));
        let low = transect.start,
          high = Math.min(low + transect.step, transect.end);
        while (height(high) > target && high < transect.end) {
          low = high;
          high = Math.min(high + transect.step, transect.end);
        }
        expect(height(low)).toBeGreaterThan(target);
        expect(height(high)).toBeLessThanOrEqual(target);
        for (let i = 0; i < 30; i++) {
          const middle = (low + high) / 2;
          if (height(middle) > target) low = middle;
          else high = middle;
        }
        const [x, z] = transect.xz((low + high) / 2);
        const y = terrain["getHeightAtComputed"](x, z);
        const color = terrain.getTerrainColorAt(x, z, true, "compact-pbr-v1");
        const noiseValue = sampleNoiseCPU(x, z, 0.0008);
        const distortNoise = sampleNoiseCPU(x, z, 0.067);
        const macro = ops.macroWeights(x, z, noiseValue, field);
        const slope = 1 - Math.abs(color.ny);
        const coast = ops.coastWeights({
          x,
          z,
          height: y,
          noiseValue,
          distortNoise,
          westRock: macro.westRock,
          slope,
          field,
        });
        const gpu = createCompactCoastWeights(
          vec3(x, y, z),
          float(noiseValue),
          float(distortNoise),
          float(macro.westRock),
          float(slope),
          field,
        );
        expect(vectorValue(gpu.soil)[0]).toBeCloseTo(coast.soil, 13);
        const lowSlopeCoast = ops.coastWeights({
          x,
          z,
          height: y,
          noiseValue,
          distortNoise,
          westRock: macro.westRock,
          slope: 0,
          field,
        });
        // Independent authored ramp, not the production weight function.
        const t = Math.max(0, Math.min(1, (slope - 0.07) / 0.16));
        expect(coast.soil).toBeCloseTo(
          lowSlopeCoast.soil * (1 - t * t * (3 - 2 * t)),
          13,
        );
        expect(lowSlopeCoast.soil).toBeGreaterThan(0.03);
        expect(coast.wetness).toBe(0);
        const cliff = ops.weights({
          noiseValue,
          distortNoise,
          slope: 1 - color.ny,
          roadInfluence: 0,
          macroSurface: macro,
        }).cliff;
        if (slope >= 0.23) {
          expect(coast.soil).toBe(0);
          expect(cliff).toBe(1);
          expect(color.grassWeight).toBe(0);
        }
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
        samples.push({
          transect: transect.name,
          x,
          z,
          y,
          slope,
          soil: coast.soil,
          lowSlopeSoil: lowSlopeCoast.soil,
          cliff,
        });
      }
      expect(samples).toHaveLength(13);
      // Authored west bearing is pi. Compare actual shore, not a renamed noise patch.
      expect(samples[6].lowSlopeSoil).toBeLessThan(
        samples[0].lowSlopeSoil * 0.6,
      );
      // The admitted east-bank cove intentionally breaks the old all-steep
      // coastline assumption. Cover both actual gentle sediment and bare rock.
      expect(samples.some((sample) => sample.slope >= 0.23)).toBe(true);
      expect(
        samples.some((sample) => sample.slope < 0.23 && sample.soil > 0.03),
      ).toBe(true);
      expect(samples[12].slope).toBeLessThan(0.23);
      expect(samples[12].soil).toBeGreaterThan(0.03);
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
      slope: 0,
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

  it("rejects overhead sediment smoothly on geometric cliffs without drying wet rock", () => {
    const ops = createCompactTerrainColorOperations();
    const profile = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
    const field = ops.macroField(profile)!;
    const base = {
      x: field.centerX + profile.island.radius,
      z: field.centerZ,
      height: field.seaLevel,
      noiseValue: 0.5,
      distortNoise: 0.5,
      westRock: 0,
      field,
    };
    const flat = ops.coastWeights({ ...base, slope: 0 });
    expect(flat.soil).toBe(0.625);
    expect(flat.wetness).toBeCloseTo(0.896, 14);
    let previousSoil = flat.soil;
    for (let step = 0; step <= 100; step++) {
      const slope = step / 100;
      const t = Math.max(0, Math.min(1, (slope - 0.07) / 0.16));
      const expected = 0.625 * (1 - t * t * (3 - 2 * t));
      const cpu = ops.coastWeights({ ...base, slope });
      const graph = createCompactCoastWeights(
        vec3(base.x, base.height, base.z),
        float(base.noiseValue),
        float(base.distortNoise),
        float(base.westRock),
        float(slope),
        field,
      );
      expect(cpu.soil).toBeCloseTo(expected, 14);
      expect(vectorValue(graph.soil)[0]).toBeCloseTo(expected, 14);
      expect(cpu.soil).toBeLessThanOrEqual(previousSoil);
      expect(cpu.wetness).toBe(flat.wetness);
      expect(vectorValue(graph.wetness)[0]).toBeCloseTo(flat.wetness, 14);
      if (slope <= 0.07) expect(cpu.soil).toBe(flat.soil);
      if (slope >= 0.23) expect(cpu.soil).toBe(0);
      previousSoil = cpu.soil;
    }
    for (const boundary of [0.07, 0.23]) {
      const epsilon = 1e-6;
      const left = ops.coastWeights({ ...base, slope: boundary - epsilon });
      const center = ops.coastWeights({ ...base, slope: boundary });
      const right = ops.coastWeights({ ...base, slope: boundary + epsilon });
      expect(Math.abs((center.soil - left.soil) / epsilon)).toBeLessThan(
        0.0001,
      );
      expect(Math.abs((right.soil - center.soil) / epsilon)).toBeLessThan(
        0.0001,
      );
    }
    const dryRock = {
      albedo: vec3(0.2, 0.3, 0.4),
      roughness: float(0.8),
      ao: float(0.7),
      worldNormal: vec3(0.6, 0.8, 0),
    };
    const dryCliff = applyCompactCoastRock(
      dryRock,
      {
        albedo: vec3(0.8, 0.7, 0.6),
        roughness: float(0.95),
        ao: float(0.9),
        worldNormal: vec3(0, 1, 0),
      },
      createCompactCoastWeights(
        vec3(base.x, field.seaLevel + 2, base.z),
        float(0.5),
        float(0.5),
        float(0),
        float(1),
        field,
      ),
    );
    for (const key of ["albedo", "roughness", "ao", "worldNormal"] as const)
      expect(vectorValue(dryCliff[key])).toEqual(vectorValue(dryRock[key]));
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
        for (const noise of [0.1, 0.5, 0.9])
          for (const slope of [0, 0.07, 0.1, 0.15, 0.23, 0.5, 1]) {
            const height =
              field.seaLevel +
              relative * (field.baseElevation - field.seaLevel);
            const edge = 1 - noise;
            const macro = ops.macroWeights(x, z, noise, field);
            const coast = ops.coastWeights({
              x,
              z,
              height,
              noiseValue: noise,
              distortNoise: edge,
              westRock: macro.westRock,
              slope,
              field,
            });
            const actual = createCompactCoastWeights(
              vec3(x, height, z),
              float(noise),
              float(edge),
              float(macro.westRock),
              float(slope),
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
                slope,
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
      expect(
        [...graph(actual.albedo)].some(
          (node) => Reflect.get(node, "isTextureNode") === true,
        ),
      ).toBe(false);
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
    const support = ops.grassSupport(base);
    const colors: number[] = [];
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
    expect(COMPACT_TERRAIN_MATERIAL.dirtRepeatsPerMeter).toBe(1 / 2);
    expect(COMPACT_TERRAIN_MATERIAL.textureCount).toBe(6);
    expect(COMPACT_TERRAIN_MATERIAL.surfaceSampleCount).toBe(20);
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
    const inputs: Parameters<
      ReturnType<typeof createCompactTerrainColorOperations>["sample"]
    >[0][] = [input];
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
    inputs.push(
      ...inputs.map((value) => ({
        ...value,
        grassColorGrade: "fine-meadow-green-v1" as const,
      })),
    );
    inputs.push(
      ...inputs.map((value) => ({
        ...value,
        surface: {
          ...value.surface!,
          pond: null,
          macroField: {
            ...value.surface!.macroField!,
            coastalMeadow: true as const,
          },
        },
      })),
    );
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads'); const operations=(${loaded.createCompactTerrainColorOperations.toString()})(); parentPort.postMessage(${JSON.stringify(inputs)}.map(input=>({color:operations.sample(input),support:operations.grassSupport(input),coverage:operations.coastalGroundCover({...input,height:input.surface.height,field:input.surface.macroField})})));`,
      { eval: true },
    );
    try {
      const actual = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(actual).toEqual(
        inputs.map((value) => {
          const operations = createCompactTerrainColorOperations();
          return {
            color: operations.sample(value),
            support: operations.grassSupport({
              ...value,
              surface: value.surface!,
            }),
            coverage: operations.coastalGroundCover({
              ...value,
              height: value.surface!.height,
              field: value.surface!.macroField!,
            }),
          };
        }),
      );
    } finally {
      await worker.terminate();
    }
  });
});
