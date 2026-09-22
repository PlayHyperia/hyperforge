import { describe, expect, it } from "vitest";
import { MeshSSSNodeMaterial, type Node } from "three/webgpu";
import THREE, {
  cameraViewMatrix,
  cameraPosition,
  positionWorld,
  modelWorldMatrix,
  time,
} from "../../../../extras/three/three";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  CURVED_MEADOW_APPEARANCE,
  DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  FINE_MEADOW_APPEARANCE,
  FINE_GRASS_THIN_LEAF_LIGHTING,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  GRASS_CONFIG,
  GrassVisualManager,
  createClumpGeometry,
  NATURAL_TUFT_APPEARANCE,
  type GrassWorkerSetup,
  type GrassVisualProfile,
} from "../GrassVisualManager";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import {
  createGroundedGrassMaterial,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
} from "../GrassGroundingGpu";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import type { CompactTerrainBankVerge } from "../CompactTerrainPalette";

// Independent valid appearance fixture. Canonical court/actor binding is
// covered by CompactIslandPaths; this isolates three unequal height ribbons.
const pondServiceGround: CompactTerrainBankVerge = {
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

function createOwner(
  candidate: boolean | "fine" = true,
  withWorkerSetup = true,
  profile?: GrassVisualProfile,
  gradedBank = false,
  serviceGround?: CompactTerrainBankVerge,
) {
  const terrain = gradedBank
    ? validateWorldTerrainProfile({
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
      })
    : SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
  const config = createTerrainWorkerConfig(terrain, 16);
  const setup: GrassWorkerSetup = {
    ...(serviceGround ? { pondServiceGround: serviceGround } : {}),
    ...(gradedBank
      ? { compactGrassColorGrade: "fine-meadow-green-v1" as const }
      : {}),
    terrainConfig: config,
    seed: terrain.seed,
    biomeCenters: [],
    biomes: {},
    grassConfigs: {},
    tileSize: terrain.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: () => {
      throw new Error("Material arithmetic must not generate placements");
    },
  };
  return new GrassVisualManager(
    config.TERRAIN_PROFILE_IDENTITY,
    new THREE.Group(),
    () => null,
    () => 28,
    terrain.water.threshold,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.4,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
    }),
    withWorkerSetup ? setup : undefined,
    profile ??
      (candidate === "fine"
        ? FINE_MEADOW_GRASS_VISUAL_PROFILE
        : DENSE_MEADOW_GRASS_VISUAL_PROFILE),
    undefined,
    undefined,
    undefined,
    candidate === "fine"
      ? FINE_MEADOW_APPEARANCE.id
      : candidate
        ? NATURAL_TUFT_APPEARANCE.id
        : undefined,
  );
}

function deformationFixture(
  variant:
    | "natural"
    | "fine"
    | "isolated-fine-near4"
    | "bank-inside"
    | "bank-feather"
    | "bank-outside"
    | "bank-wear-apron"
    | "bank-wear-clerk"
    | "bank-wear-shopkeeper"
    | "bank-wear-feather"
    | "pond-service-wear"
    | "pond-service-near4"
    | "pond-service-supplier"
    | "pond-service-outside",
) {
  const isFine = variant !== "natural";
  // Independent authored expectations, not a call back into the CPU/GPU
  // implementation. The last point lies beyond the shopkeeper endpoint:
  // distance²=.75²+.5², x-locality=smooth(7/8), z-locality=smooth(3/4).
  const smoothUnit = (t: number) => t * t * (3 - 2 * t);
  const featherLocality = smoothUnit(7 / 8) * smoothUnit(3 / 4);
  const featherWear =
    0.55 * (1 - smoothUnit((0.8125 - 0.55 ** 2) / (1.2 ** 2 - 0.55 ** 2)));
  const locations = {
    // Keep the original constant-bank arithmetic at explicitly unworn points.
    "bank-inside": [348, 314, 0.65],
    "bank-feather": [341, 314, 0.825],
    "bank-outside": [339, 314, 1],
    // Apron/clerk overlap uses MAX(.8,.62), not additive wear.
    "bank-wear-apron": [350, 319.5, 0.41],
    "bank-wear-clerk": [352, 320.25, 0.464],
    "bank-wear-shopkeeper": [344.25, 320.5, 0.485],
    "bank-wear-feather": [
      341.75,
      322.5,
      1 +
        featherLocality * (0.65 - 1) +
        featherLocality * featherWear * (0.35 - 0.65),
    ],
    "pond-service-wear": [384, 436, 1 + 0.8 * (0.35 - 1)],
    "pond-service-near4": [386, 439, 1 + 0.62 * (0.35 - 1)],
    "pond-service-supplier": [382, 439, 1 + 0.55 * (0.35 - 1)],
    // Inside the locality rectangle but outside every ribbon: no base haircut.
    "pond-service-outside": [388, 444, 1],
  } as const;
  const bankLocation =
    variant in locations
      ? locations[variant as keyof typeof locations]
      : undefined;
  const owner = createOwner(
    isFine ? "fine" : true,
    true,
    undefined,
    !!bankLocation,
    variant.startsWith("pond-service-") ? pondServiceGround : undefined,
  );
  const appearance = isFine ? FINE_MEADOW_APPEARANCE : NATURAL_TUFT_APPEARANCE;
  const geometryLayout = !isFine
    ? undefined
    : variant === "isolated-fine-near4" || variant === "pond-service-near4"
      ? "fine-linear-sweep-near4-v1"
      : FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT;
  // The shader has no segment-dependent branch. These are independent real
  // four-segment templates, not a claim that the current manager selects four.
  const geometries =
    variant === "isolated-fine-near4" || variant === "pond-service-near4"
      ? [0, 1, 2].map((lod) => {
          const layout = getGrassBladeLayout(lod, geometryLayout);
          return createClumpGeometry(
            layout.bladesPerClump,
            layout.bladeSegments,
            appearance,
          );
        })
      : owner["lodGeometries"];
  return {
    owner,
    appearance,
    geometryLayout,
    geometries,
    isFine,
    bankLocation,
    close() {
      if (variant === "isolated-fine-near4" || variant === "pond-service-near4")
        geometries.forEach((geometry) => geometry.dispose());
      owner.destroy();
    },
  };
}

function requireNode(value: unknown): Node {
  if (!(value instanceof THREE.Node))
    throw new Error("Expected an actual Three.js shader node");
  return value;
}

function graph(root: unknown): Set<Node> {
  const found = new Set<Node>();
  const visit = (node: Node) => {
    if (found.has(node)) return;
    if (found.size > 4096) throw new Error("Unexpected shader graph growth");
    found.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(requireNode(root));
  return found;
}

/** Invoke only the real construction-time material Fn; no renderer is mocked. */
function colorGraph(root: Node): Node {
  let node = root;
  while (Reflect.get(node, "isVarNode")) node = Reflect.get(node, "node");
  const shader: unknown = Reflect.get(node, "shaderNode");
  if (shader instanceof THREE.Node) {
    const fn: unknown = Reflect.get(shader, "jsFunc");
    if (typeof fn === "function") {
      const result: unknown = fn();
      if (!(result instanceof THREE.Node)) throw new Error("Invalid color Fn");
      return result;
    }
  }
  return root;
}

interface Inputs {
  attributes: Record<string, number[]>;
  varyings?: Record<string, number[]>;
  model: THREE.Matrix4;
  view: THREE.Matrix4;
  time: number;
  front: boolean;
  cameraPosition?: number[];
  worldPosition?: number[];
}

/** Evaluates the actual constructed TSL arithmetic, never a replacement shader
 * or renderer. Unknown nodes fail closed; this is not native GPU evidence. */
function evaluate(root: unknown, inputs: Inputs): number[] {
  const cache = new Map<Node, number[]>();
  const visit = (node: Node): number[] => {
    const cached = cache.get(node);
    if (cached) return cached;
    const read = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string) => {
      const next = read(key);
      if (!(next instanceof THREE.Node))
        throw new Error(`Missing ${key} on ${node.type}`);
      return visit(next);
    };
    const calculate = (): number[] => {
      if (node === modelWorldMatrix) return inputs.model.toArray();
      if (node === cameraViewMatrix) return inputs.view.toArray();
      if (node === cameraPosition) {
        if (!inputs.cameraPosition) throw new Error("Missing camera position");
        return inputs.cameraPosition;
      }
      if (node === positionWorld) {
        if (!inputs.worldPosition) throw new Error("Missing world position");
        return inputs.worldPosition;
      }
      if (node === time) return [inputs.time];
      if (node.type === "FrontFacingNode") return [Number(inputs.front)];
      if (node.type === "AttributeNode") {
        const values = inputs.attributes[String(read("_attributeName"))];
        if (!values)
          throw new Error(
            `Unexpected attribute ${String(read("_attributeName"))}`,
          );
        return values;
      }
      const value = read("value");
      if (typeof value === "number") return [value];
      if (value instanceof THREE.Vector3) return value.toArray();
      if (node.type === "VaryingNode" && inputs.varyings) {
        const name = String(read("name"));
        const varying = inputs.varyings[name];
        if (!varying) throw new Error(`Missing fragment varying ${name}`);
        return varying;
      }
      // Shared thin-leaf albedo nests the real color Fn inside a Var/Convert.
      // Resolve known external accessors first; expand only the construction-
      // time albedo Fn, never a builder-dependent accessor or GPU shader.
      const expanded = colorGraph(node);
      if (expanded !== node) return visit(expanded);
      if (
        ["VarNode", "VaryingNode", "ConvertNode", "SubBuild"].includes(
          node.type,
        )
      )
        return child("node");
      if (node.type === "JoinNode") {
        const children = read("nodes");
        if (!Array.isArray(children)) throw new Error("Missing joined nodes");
        return children.flatMap((next: unknown) => {
          if (!(next instanceof THREE.Node))
            throw new Error("Invalid joined node");
          return visit(next);
        });
      }
      if (node.type === "SplitNode")
        return [...String(read("components"))].map(
          (c) => child("node")["xyzw".indexOf(c)],
        );
      if (node.type === "ConditionalNode")
        return child("condNode")[0] ? child("ifNode") : child("elseNode");
      const a = child("aNode");
      const method = read("method");
      if (method === "normalize") {
        const length = Math.hypot(...a);
        return a.map((x) => x / length);
      }
      if (method === "sin") return a.map(Math.sin);
      if (method === "cos") return a.map(Math.cos);
      if (method === "negate") return a.map((x) => -x);
      const b = child("bNode");
      if (method === "dot") return [a.reduce((sum, x, i) => sum + x * b[i], 0)];
      if (read("op") === "*" && a.length === 16 && b.length === 4) {
        return new THREE.Vector4(b[0], b[1], b[2], b[3])
          .applyMatrix4(new THREE.Matrix4().fromArray(a))
          .toArray();
      }
      if (method === "transformDirection") {
        return new THREE.Vector3(b[0], b[1], b[2])
          .transformDirection(new THREE.Matrix4().fromArray(a))
          .toArray();
      }
      const operands = [a, b];
      if (read("cNode") instanceof THREE.Node) operands.push(child("cNode"));
      return Array.from(
        { length: Math.max(...operands.map((v) => v.length)) },
        (_, i) => {
          const [x, y, z] = operands.map((v) => v[v.length === 1 ? 0 : i]);
          if (read("op") === "+") return x + y;
          if (read("op") === "-") return x - y;
          if (read("op") === "*") return x * y;
          if (read("op") === "/") return x / y;
          if (read("op") === ">") return Number(x > y);
          if (method === "pow") return Math.pow(x, y);
          if (method === "max") return Math.max(x, y);
          if (method === "min") return Math.min(x, y);
          if (method === "mix") return x + (y - x) * z;
          if (method === "clamp") return Math.min(z, Math.max(y, x));
          if (method === "smoothstep") {
            const t = Math.min(1, Math.max(0, (z - x) / (y - x)));
            return t * t * (3 - 2 * t);
          }
          throw new Error(
            `Unsupported ${node.type} ${String(method)} ${String(read("op"))}`,
          );
        },
      );
    };
    const result = calculate();
    if (result.some((x) => !Number.isFinite(x)))
      throw new Error(`Nonfinite ${node.type}`);
    cache.set(node, result);
    return result;
  };
  return visit(requireNode(root));
}

function vector(values: number[]) {
  return new THREE.Vector3(values[0], values[1], values[2]);
}

function inputFor(geometry: THREE.BufferGeometry, index: number): Inputs {
  return {
    attributes: {
      position: new THREE.Vector3()
        .fromBufferAttribute(geometry.attributes.position, index)
        .toArray(),
      normal: new THREE.Vector3()
        .fromBufferAttribute(geometry.attributes.normal, index)
        .toArray(),
      uv: [
        geometry.attributes.uv.getX(index),
        geometry.attributes.uv.getY(index),
      ],
      instanceOffset: [4, 28, 7],
      instanceRotScaleHash: [0.7, 1.1, 0.3],
      instanceGroundNormal: [0, 1, 0],
    },
    model: new THREE.Matrix4().makeTranslation(350, 0, 350),
    view: new THREE.Matrix4(),
    time: 3.7,
    front: true,
  };
}

function worldBase(inputs: Inputs) {
  const offset = inputs.attributes.instanceOffset;
  return new THREE.Vector3(offset[0], 0, offset[2]).applyMatrix4(inputs.model);
}

function windAmplitude(
  inputs: Inputs,
  maximumHeight: number = NATURAL_TUFT_APPEARANCE.BLADE_HEIGHT_MAX,
) {
  const base = worldBase(inputs);
  const wt = inputs.time * GRASS_CONFIG.WIND_SPEED;
  const strength = GRASS_CONFIG.WIND_STRENGTH * maximumHeight;
  return new THREE.Vector3(
    Math.sin(wt + base.x * 0.35 + base.z * 0.12) * strength,
    0,
    Math.sin(wt * 0.67 + base.x * 0.18 + base.z * 0.28 + 2) * strength * 0.55,
  );
}

function rotation(inputs: Inputs) {
  const up = new THREE.Vector3(0, 1, 0);
  return new THREE.Quaternion()
    .setFromUnitVectors(up, vector(inputs.attributes.instanceGroundNormal))
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        up,
        -inputs.attributes.instanceRotScaleHash[0],
      ),
    );
}

describe("fine meadow thin-leaf lighting (actual CPU nodes and policy algebra)", () => {
  const smooth = (a: number, b: number, value: number) => {
    const t = Math.min(1, Math.max(0, (value - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const materialFor = (owner: GrassVisualManager) => {
    const material = owner["material"];
    if (
      !(material instanceof MeshSSSNodeMaterial) ||
      !material.colorNode ||
      !material.thicknessColorNode
    )
      throw new Error(
        "Actual fine thin-leaf material and source nodes required",
      );
    return material;
  };
  const sourceNodes = (root: Node) => {
    const nodes = graph(root);
    // Expand only actual construction-time Fn bodies, including the shared
    // albedo nested inside the thickness graph. No builder or light is mocked.
    for (const node of nodes) {
      const expanded = colorGraph(node);
      if (expanded !== node)
        for (const child of graph(expanded)) nodes.add(child);
      expect(nodes.size).toBeLessThan(4096);
    }
    return nodes;
  };

  it("connects the actual SSS material to shared albedo and the explicit bounded coefficient policy", () => {
    const owner = createOwner("fine");
    try {
      const material = materialFor(owner);
      expect(FINE_GRASS_THIN_LEAF_LIGHTING).toEqual({
        id: "fine-thin-leaf-v1",
        attenuation: 0.2,
        scale: 1,
        power: 2,
        distortion: 0.1,
        ambient: 0,
        rootStart: 0.05,
        rootEnd: 0.65,
      });
      expect(Object.isFrozen(FINE_GRASS_THIN_LEAF_LIGHTING)).toBe(true);
      expect(material.userData.fineGrassLighting).toBe(
        FINE_GRASS_THIN_LEAF_LIGHTING,
      );
      expect(material.useSSS).toBe(true);
      expect(material.setupLightingModel().useSSS).toBe(true);
      expect(Reflect.get(material.colorNode!, "name")).toBe(
        "fineGrassBladeAlbedo",
      );
      expect(Reflect.get(material.thicknessColorNode!, "name")).toBe(
        "fineGrassThinLeafColor",
      );
      expect(
        graph(material.thicknessColorNode!).has(
          requireNode(material.colorNode),
        ),
      ).toBe(true);
      const inputs = inputFor(owner["lodGeometries"][0], 0);
      for (const [key, expected] of [
        ["thicknessAttenuationNode", 0.2],
        ["thicknessScaleNode", 1],
        ["thicknessPowerNode", 2],
        ["thicknessDistortionNode", 0.1],
        ["thicknessAmbientNode", 0],
      ] as const) {
        const node = material[key];
        expect(node).toBeInstanceOf(THREE.Node);
        expect(evaluate(node, inputs)).toEqual([expected]);
        expect(
          [...graph(node)].some((child) => child.type === "AttributeNode"),
        ).toBe(false);
      }
      const nodes = sourceNodes(material.thicknessColorNode!);
      expect(
        [
          ...new Set(
            [...nodes]
              .filter((node) => node.type === "AttributeNode")
              .map((node) => Reflect.get(node, "_attributeName")),
          ),
        ].sort(),
      ).toEqual(["instanceGrassTint", "instanceGroundColor", "uv"]);
      for (const accessor of [cameraPosition, positionWorld, time])
        expect(nodes.has(accessor)).toBe(false);
      expect(
        [...nodes].some((node) =>
          String(Reflect.get(node, "name")).startsWith("fineGrassGrazing"),
        ),
      ).toBe(false);
      expect(
        [...nodes].some(
          (node) =>
            Reflect.get(node, "isTextureNode") ||
            Reflect.get(node, "isStorageBufferNode"),
        ),
      ).toBe(false);
      // The mask does not feed position, normals, AO or emission.
      for (const root of [
        material.positionNode!,
        material.normalNode!,
        material.aoNode!,
      ])
        expect(graph(root).has(material.thicknessColorNode!)).toBe(false);
      expect(material.emissive.toArray()).toEqual([0, 0, 0]);
      expect(material.emissiveNode).toBeNull();
      expect(material.lights).toBe(true);
    } finally {
      owner.destroy();
    }
  });

  it("preserves the current canopy blade RGB and masks only thin-leaf color at roots, half-mask and tips", () => {
    const owner = createOwner("fine");
    try {
      const material = materialFor(owner);
      for (const height of [-0.1, 0, 0.05, 0.2, 0.35, 0.5, 0.65, 1, 1.1])
        for (const ground of [
          [0.2, 0.4, 0.1],
          [0, 0.3, 0.05],
          [0, 0, 0],
          [0.9, 0.95, 0.99],
        ])
          for (const tint of [
            [0.3, 0.45, 0.2, 0.3],
            [1, 1, 1, 1],
          ])
            for (const delta of [
              [10, 0, 0],
              [0, 10, 0],
              [0, 0, 0],
            ])
              for (const front of [false, true]) {
                const inputs = inputFor(owner["lodGeometries"][0], 0);
                inputs.attributes.instanceGroundColor = ground;
                inputs.attributes.instanceGrassTint = tint;
                inputs.attributes.uv = [0.5, height];
                inputs.front = front;
                inputs.worldPosition = [350, 28, 320];
                inputs.cameraPosition = inputs.worldPosition.map(
                  (value, index) => value + delta[index],
                );
                const transition = smooth(0, 1, height);
                const expectedAlbedo = ground.map((value, channel) => {
                  const root = value * 0.98;
                  const tip = (value + (tint[channel] - value) * tint[3]) * 1.2;
                  return Math.min(1, root + (tip - root) * transition);
                });
                const mask = smooth(0.05, 0.65, height);
                const albedo = evaluate(material.colorNode!, inputs);
                const thickness = evaluate(
                  material.thicknessColorNode!,
                  inputs,
                );
                expect(albedo).toHaveLength(3);
                expect(thickness).toHaveLength(3);
                for (let channel = 0; channel < 3; channel++) {
                  expect(albedo[channel]).toBeCloseTo(
                    expectedAlbedo[channel],
                    13,
                  );
                  expect(thickness[channel]).toBeCloseTo(
                    expectedAlbedo[channel] * mask,
                    13,
                  );
                  expect(Number.isFinite(thickness[channel])).toBe(true);
                  expect(thickness[channel]).toBeGreaterThanOrEqual(0);
                  expect(thickness[channel]).toBeLessThanOrEqual(
                    albedo[channel] + 1e-12,
                  );
                  expect(albedo[channel]).toBeLessThanOrEqual(1);
                  if (expectedAlbedo[channel] === 0)
                    expect(thickness[channel]).toBe(0);
                  if (height <= 0.05) expect(thickness[channel]).toBe(0);
                  if (height === 0.35)
                    expect(thickness[channel]).toBeCloseTo(
                      albedo[channel] * 0.5,
                      13,
                    );
                  if (height >= 0.65)
                    expect(thickness[channel]).toBe(albedo[channel]);
                }
                for (let channel = 0; channel < 3; channel++)
                  for (let other = channel + 1; other < 3; other++)
                    expect(thickness[channel] * albedo[other]).toBeCloseTo(
                      thickness[other] * albedo[channel],
                      13,
                    );
                if (height === 0)
                  expect(albedo).toEqual(ground.map((value) => value * 0.98));
                // Retain the original fine upper clamp without a view gain.
                if (height === 1 && tint[3] === 1)
                  expect(albedo).toEqual([1, 1, 1]);
              }
    } finally {
      owner.destroy();
    }
  });

  it("bounds the direct-light policy with actual coefficients without simulating a lighting model or GPU", () => {
    const owner = createOwner("fine");
    try {
      const material = materialFor(owner);
      const inputs = inputFor(owner["lodGeometries"][0], 0);
      inputs.attributes.instanceGroundColor = [0.2, 0.4, 0.1];
      inputs.attributes.instanceGrassTint = [0.3, 0.45, 0.2, 0.3];
      const attenuation = evaluate(
        material.thicknessAttenuationNode,
        inputs,
      )[0];
      const scale = evaluate(material.thicknessScaleNode, inputs)[0];
      const power = evaluate(material.thicknessPowerNode, inputs)[0];
      const distortion = evaluate(material.thicknessDistortionNode, inputs)[0];
      const ambient = evaluate(material.thicknessAmbientNode, inputs)[0];
      // Independent algebra for the installed Three SSS model's direct term:
      // H=normalize(L+distortion*N), s=(clamp(-V·H,0,1)^power*scale+ambient)
      // and added RGB=s*thicknessColor*attenuation*incomingLightRGB.
      // This verifies parameter policy, not the model's compiled execution.
      const directions = [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(1, 2, -3).normalize(),
      ];
      for (const height of [0, 0.05, 0.35, 0.65, 1]) {
        inputs.attributes.uv = [0.5, height];
        const thickness = evaluate(material.thicknessColorNode!, inputs);
        for (const normal of directions)
          for (const light of directions) {
            const half = light.clone().addScaledVector(normal, distortion);
            // Unit L/N with distortion .1 cannot cancel to an undefined normal.
            expect(half.length()).toBeGreaterThanOrEqual(0.9 - 1e-12);
            expect(half.length()).toBeLessThanOrEqual(1.1 + 1e-12);
            half.normalize();
            for (const view of directions)
              for (const incoming of [
                [0, 0, 0],
                [1, 1, 1],
                [4, 0.5, 0],
              ]) {
                const alignment = Math.min(1, Math.max(0, -view.dot(half)));
                const factor =
                  (alignment ** power * scale + ambient) * attenuation;
                const added = thickness.map(
                  (value, channel) => value * factor * incoming[channel],
                );
                added.forEach((value, channel) => {
                  expect(Number.isFinite(value)).toBe(true);
                  expect(value).toBeGreaterThanOrEqual(0);
                  expect(value).toBeLessThanOrEqual(
                    0.2 * thickness[channel] * incoming[channel] + 1e-12,
                  );
                  if (
                    height <= 0.05 ||
                    incoming[channel] === 0 ||
                    alignment === 0
                  )
                    expect(value).toBe(0);
                });
              }
            // Exact extrema orient V with/opposite the distorted light vector.
            const response = (view: THREE.Vector3) =>
              (Math.min(1, Math.max(0, -view.dot(half))) ** power * scale +
                ambient) *
              attenuation;
            expect(response(half)).toBe(0);
            expect(response(half.clone().negate())).toBeCloseTo(0.2, 13);
          }
      }
    } finally {
      owner.destroy();
    }
  });
});

describe("fine meadow root occlusion (actual CPU node arithmetic)", () => {
  it("uses the existing UV height for a bounded smooth root-only indirect occlusion profile", () => {
    const owner = createOwner("fine");
    try {
      const material = owner["material"];
      // Current canopy recipe reduces only the lower leaf's indirect-light
      // occlusion. This is a live graph assertion, not an archived render hash.
      expect(FINE_MEADOW_APPEARANCE.ROOT_OCCLUSION).toBe(0.78);
      expect(FINE_MEADOW_APPEARANCE.ROOT_OCCLUSION_END).toBe(0.35);
      expect(material.aoNode).toBeInstanceOf(THREE.Node);
      const ao = material.aoNode!;
      expect(ao.type).toBe("VarNode");
      expect(Reflect.get(ao, "name")).toBe("fineGrassRootOcclusion");
      const nodes = [...graph(ao)];
      expect(
        nodes
          .filter((node) => node.type === "AttributeNode")
          .map((node) => Reflect.get(node, "_attributeName")),
      ).toEqual(["uv"]);
      expect(
        nodes.filter(
          (node) =>
            node.type === "VaryingNode" ||
            Reflect.get(node, "isTextureNode") === true ||
            Reflect.get(node, "isStorageBufferNode") === true,
        ),
      ).toEqual([]);
      expect(graph(material.positionNode!).has(ao)).toBe(false);
      expect(graph(material.normalNode!).has(ao)).toBe(false);
      for (const front of [false, true])
        for (const horizontal of [0, 0.5, 1])
          for (const [height, expected] of [
            [-1, 0.78],
            [0, 0.78],
            [0.175, 0.89],
            [0.35, 1],
            [1, 1],
            [2, 1],
          ]) {
            const inputs = inputFor(owner["lodGeometries"][0], 0);
            inputs.front = front;
            inputs.attributes.uv = [horizontal, height];
            expect(evaluate(ao, inputs)[0]).toBeCloseTo(expected, 14);
          }
      let previous = 0.78;
      for (let step = 0; step <= 100; step++) {
        const inputs = inputFor(owner["lodGeometries"][0], 0);
        const height = step / 100;
        inputs.attributes.uv = [0.5, height];
        const actual = evaluate(ao, inputs)[0];
        const t = Math.min(1, Math.max(0, height / 0.35));
        const expected = 0.78 + 0.22 * t * t * (3 - 2 * t);
        expect(actual).toBeCloseTo(expected, 14);
        expect(actual).toBeGreaterThanOrEqual(previous);
        expect(actual).toBeLessThanOrEqual(1);
        previous = actual;
      }
      // This evaluates the real material's AO input only. Installed r186's
      // PhysicalLightingModel applies that input to indirect lighting; native
      // compilation and pixels remain separate acceptance, not a fake renderer.
    } finally {
      owner.destroy();
    }
  });

  it("opts in only fine grass without adding material maps or a transparency pass", () => {
    const fine = createOwner("fine");
    const natural = createOwner(true);
    const curved = createOwner(false);
    try {
      expect(natural["material"].aoNode).toBeNull();
      expect(curved["material"].aoNode).toBeNull();
      expect(fine["material"].aoNode).not.toBeNull();
      for (const owner of [fine, natural, curved]) {
        const material = owner["material"];
        expect(material.side).toBe(THREE.DoubleSide);
        expect(material.transparent).toBe(false);
        expect(material.depthWrite).toBe(true);
        expect(material.roughness).toBe(1);
        expect(material.metalness).toBe(0);
        expect(material.fog).toBe(false);
        expect(material.map).toBeNull();
        expect(material.aoMap).toBeNull();
        expect(material.normalMap).toBeNull();
        expect(material.alphaMap).toBeNull();
        expect(material.emissiveMap).toBeNull();
        expect(material.emissive.toArray()).toEqual([0, 0, 0]);
        expect(material.fragmentNode).toBeNull();
        expect(material.lights).toBe(true);
        for (const [lod, geometry] of owner["lodGeometries"].entries()) {
          expect(Object.keys(geometry.attributes).sort()).toEqual([
            "normal",
            "position",
            "uv",
          ]);
          const tier = getGrassBladeLayout(
            lod,
            owner === fine ? FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT : undefined,
          );
          expect(geometry.attributes.position.count).toBe(
            tier.bladesPerClump * (tier.bladeSegments * 2 + 1),
          );
        }
      }
    } finally {
      fine.destroy();
      natural.destroy();
      curved.destroy();
    }
  });

  it("retains the exact AO node through each actual grounded material clone", () => {
    const owner = createOwner("fine");
    try {
      const base = owner["material"];
      for (const [lod, source] of owner["lodGeometries"].entries()) {
        const geometry = source.clone();
        const count = 2;
        const roots = new Float32Array(
          count * GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump * 2,
        );
        const material = createGroundedGrassMaterial(
          base,
          geometry,
          roots,
          count,
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        try {
          expect(material).not.toBe(base);
          expect(material.aoNode).toBe(base.aoNode);
          expect(material.normalNode).toBe(base.normalNode);
          expect(material.colorNode).toBe(base.colorNode);
          expect(material.positionNode).not.toBe(base.positionNode);
          expect(material.transparent).toBe(false);
          expect(material.side).toBe(THREE.DoubleSide);
          expect(material.aoMap).toBeNull();
          expect(
            geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE).array,
          ).toBe(roots);
          expect(source.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
          const inputs = inputFor(source, 0);
          inputs.attributes.uv = [0.5, 0.175];
          expect(evaluate(material.aoNode!, inputs)[0]).toBeCloseTo(0.89, 14);
        } finally {
          material.dispose();
          geometry.dispose();
        }
      }
    } finally {
      owner.destroy();
    }
  });
});

describe("fine meadow constant normal blend (actual CPU node arithmetic)", () => {
  it("keeps the 0.20 blend finite on both faces across blade height without new vertex inputs", () => {
    const owner = createOwner("fine");
    try {
      const material = owner["material"];
      const normalGraph = graph(material.normalNode!);
      expect(material.roughness).toBe(1);
      expect(
        [...normalGraph]
          .filter((n) => n.type === "VaryingNode")
          .map((n) => Reflect.get(n, "name")),
      ).toEqual(["v_curvedGrassNormal"]);
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 1000);
      camera.position.set(25, 19, -31);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      for (const ground of [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.4, 0.8, -0.3).normalize(),
      ])
        for (const front of [false, true])
          for (const height of [0, 0.15, 1 / 3, 0.45, 0.75, 1])
            for (const interpolated of [
              [0, 0, 0],
              [1e-9, -1e-9, 0],
              [0, 0.999e-6, 0],
              [0, 1.001e-6, 0],
              [0.3, -0.2, 0.4],
              ground.clone().negate().toArray(),
            ]) {
              const inputs = inputFor(owner["lodGeometries"][0], 0);
              inputs.attributes.instanceGroundNormal = ground.toArray();
              inputs.attributes.uv = [0.5, height];
              inputs.varyings = { v_curvedGrassNormal: interpolated };
              inputs.front = front;
              inputs.view.copy(camera.matrixWorldInverse);
              // Independent constant-blend contract at every sampled UV height.
              const weight = 0.2;
              const blade = new THREE.Vector3().fromArray(interpolated);
              if (blade.lengthSq() <= 1e-12) blade.copy(ground);
              else blade.normalize();
              const blended = ground
                .clone()
                .lerp(blade.multiplyScalar(front ? 1 : -1), weight);
              // Every permitted unit-vector pair retains a nonzero denominator.
              expect(blended.length()).toBeGreaterThanOrEqual(0.6 - 1e-12);
              const expected = blended
                .normalize()
                .transformDirection(inputs.view);
              const actual = vector(evaluate(material.normalNode!, inputs));
              expect(actual.length()).toBeCloseTo(1, 12);
              expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
            }
    } finally {
      owner.destroy();
    }
  });
});

describe("natural tuft actual shader deformation (CPU node arithmetic only)", () => {
  it("owns unique pond-service shader names and preserves town/outside deformation exactly", () => {
    const baseline = createOwner("fine", true, undefined, true);
    const candidate = createOwner(
      "fine",
      true,
      undefined,
      true,
      pondServiceGround,
    );
    try {
      const material = candidate["material"];
      if (!(material instanceof MeshSSSNodeMaterial) || !material.colorNode)
        throw new Error(
          "Actual fine thin-leaf material and color node required",
        );
      const colorNode: unknown = material.colorNode;
      const isNode = (value: unknown): value is Node =>
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "isNode") === true;
      if (!isNode(colorNode))
        throw new Error("Actual Three color node required");
      const nodes = new Set<Node>();
      for (const root of [
        material.positionNode!,
        material.normalNode!,
        // Expand only the actual material color factory. Camera/matrix
        // accessors elsewhere in the DAG are builder-dependent, not material
        // construction callbacks that can be invoked without a renderer.
        colorGraph(colorNode),
      ]) {
        for (const node of graph(root)) nodes.add(node);
      }
      expect(nodes.size).toBeLessThan(4096);
      const names = new Map<string, Node>();
      for (const node of nodes) {
        const name: unknown = Reflect.get(node, "name");
        if (
          !Reflect.get(node, "isVarNode") ||
          typeof name !== "string" ||
          !/(?:Verge|(?:Bank|PondService|Authored)HeightScale)/.test(name)
        )
          continue;
        const prior = names.get(name);
        expect(
          prior === undefined || prior === node,
          `Distinct actual shader variables alias ${name}`,
        ).toBe(true);
        names.set(name, node);
      }
      expect(names.has("naturalGrassBankHeightScale")).toBe(true);
      expect(names.has("naturalGrassPondServiceHeightScale")).toBe(true);
      expect(names.has("naturalGrassAuthoredHeightScale")).toBe(true);
      expect(
        [...names.keys()].some((name) => /(?:Pond|Service)/.test(name)),
      ).toBe(true);
      const geometry = candidate["lodGeometries"][0];
      for (const [x, z] of [
        [350, 319.5],
        [341.75, 322.5],
        [388, 444],
        [400, 440],
      ])
        for (const seconds of [0, 3.7])
          for (const distance of [0, 126, 140])
            for (const index of [
              0,
              2,
              geometry.attributes.position.count - 1,
            ]) {
              const inputs = inputFor(geometry, index);
              inputs.model.identity();
              inputs.time = seconds;
              inputs.attributes.instanceOffset = [x, 28, z];
              inputs.attributes.instanceGroundNormal = new THREE.Vector3(
                0.3,
                0.8,
                -0.2,
              )
                .normalize()
                .toArray();
              for (const owner of [baseline, candidate])
                owner["playerPosUniform"]!.value.set(x + distance, 0, z);
              for (const field of ["positionNode", "normalNode"] as const)
                expect(evaluate(candidate["material"][field], inputs)).toEqual(
                  evaluate(baseline["material"][field], inputs),
                );
            }
    } finally {
      candidate.destroy();
      baseline.destroy();
    }
  });

  it("keeps actual fragment normals finite after zero or near-zero raster interpolation", () => {
    const owner = createOwner();
    try {
      const material = owner["material"];
      const fragment = graph(material.normalNode!);
      expect(
        [...fragment].some(
          (node) =>
            Reflect.get(node, "name") === "naturalGrassInterpolatedLengthSq",
        ),
      ).toBe(true);
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 1000);
      camera.position.set(25, 19, -31);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      for (const ground of [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.4, 0.8, -0.3).normalize(),
      ])
        for (const front of [false, true])
          for (const interpolated of [
            [0, 0, 0], // equal interpolation of opposing valid vertex normals
            [1e-9, -1e-9, 0],
            [0, 0.999e-6, 0],
            [0, 1.001e-6, 0],
            [0.3, -0.2, 0.4],
            ground.clone().negate().toArray(),
          ]) {
            const inputs = inputFor(owner["lodGeometries"][1], 0);
            inputs.attributes.instanceGroundNormal = ground.toArray();
            inputs.varyings = { v_curvedGrassNormal: interpolated };
            inputs.view.copy(camera.matrixWorldInverse);
            inputs.front = front;
            // Exercise the real fragment graph with raster-interpolated inputs,
            // not the vertex expression hidden behind the VaryingNode.
            const actual = vector(evaluate(material.normalNode!, inputs));
            const blade = new THREE.Vector3().fromArray(interpolated);
            if (blade.lengthSq() <= 1e-12) blade.copy(ground);
            else blade.normalize();
            const blended = ground
              .clone()
              .lerp(
                blade.multiplyScalar(front ? 1 : -1),
                NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT,
              );
            // A 0.38 unit-blade blend with the unit terrain normal cannot
            // cancel: its pre-normalization length is at least 1 - 2*0.38.
            expect(blended.length()).toBeGreaterThanOrEqual(0.24 - 1e-12);
            const expected = blended
              .normalize()
              .transformDirection(inputs.view);
            expect(actual.length()).toBeCloseTo(1, 12);
            expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
          }
    } finally {
      owner.destroy();
    }
  });

  it("shares the world-space displacement and fade without new attributes, textures, or varyings", () => {
    const owner = createOwner();
    const old = createOwner(false);
    try {
      const material = owner["material"];
      const position = graph(material.positionNode!);
      const normals = graph(material.normalNode!);
      for (const name of [
        "naturalGrassDisplacement",
        "naturalGrassFade",
        "naturalGrassWorldBase",
      ]) {
        const shared = [...position].filter(
          (n) => Reflect.get(n, "name") === name,
        );
        expect(shared).toHaveLength(1);
        expect(normals.has(shared[0])).toBe(true);
      }
      const union = new Set([...position, ...normals]);
      expect(
        [...union].filter((n) => Reflect.get(n, "method") === "sin"),
      ).toHaveLength(3); // two wind waves + yaw
      expect(
        [...union].filter((n) => {
          const exponent: unknown = Reflect.get(n, "bNode");
          return (
            Reflect.get(n, "method") === "pow" &&
            exponent instanceof THREE.Node &&
            evaluate(exponent, inputFor(owner["lodGeometries"][1], 0))[0] ===
              1.8
          );
        }),
      ).toHaveLength(1);
      expect(
        [...union]
          .filter((n) => n.type === "VaryingNode")
          .map((n) => Reflect.get(n, "name")),
      ).toEqual(["v_curvedGrassNormal"]);
      expect(
        [
          ...new Set(
            [...union]
              .filter((n) => n.type === "AttributeNode")
              .map((n) => Reflect.get(n, "_attributeName")),
          ),
        ].sort(),
      ).toEqual([
        "instanceGroundNormal",
        "instanceOffset",
        "instanceRotScaleHash",
        "normal",
        "position",
        "uv",
      ]);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.alphaMap).toBeNull();
      expect(old["material"].name).toBe(CURVED_MEADOW_APPEARANCE.id);
      expect(graph(old["material"].normalNode!).has(time)).toBe(false);
      expect(graph(old["material"].normalNode!).has(modelWorldMatrix)).toBe(
        false,
      );
    } finally {
      owner.destroy();
      old.destroy();
    }
  });

  it("gives identical world positions and normals to the same clump under different chunk origins", () => {
    const owner = createOwner();
    try {
      const geometry = owner["lodGeometries"][1];
      for (const index of [0, 1, 2, 3, 4])
        for (const seconds of [0, 0.1, 2.3, 29]) {
          const a = inputFor(geometry, index);
          a.time = seconds;
          owner["playerPosUniform"]!.value.copy(worldBase(a));
          const b = inputFor(geometry, index);
          b.time = seconds;
          b.model.makeTranslation(300, 0, 400);
          b.attributes.instanceOffset = [54, 28, -43];
          const positionA = vector(
            evaluate(owner["material"].positionNode!, a),
          ).applyMatrix4(a.model);
          const positionB = vector(
            evaluate(owner["material"].positionNode!, b),
          ).applyMatrix4(b.model);
          expect(positionA.distanceTo(positionB)).toBeLessThan(1e-12);
          expect(
            vector(evaluate(owner["material"].normalNode!, a)).distanceTo(
              vector(evaluate(owner["material"].normalNode!, b)),
            ),
          ).toBeLessThan(1e-12);
        }
    } finally {
      owner.destroy();
    }
  });

  it("reduces to the independent fade cofactor at a zero-wave world phase, including completely collapsed roots", () => {
    const owner = createOwner();
    try {
      // Solve both world-space phase equations at time zero; this exercises the
      // actual wind inputs without replacing or switching off the shader path.
      const z = -2 / (0.28 - (0.18 * 0.12) / 0.35);
      const x = (-0.12 * z) / 0.35;
      const geometry = owner["lodGeometries"][1];
      const ground = new THREE.Vector3(0.4, 0.8, -0.3).normalize();
      for (const index of [0, 1, 2, 3, 4])
        for (const distance of [0, 126, 140]) {
          const inputs = inputFor(geometry, index);
          inputs.model.identity();
          inputs.attributes.instanceOffset = [x, 28, z];
          inputs.attributes.instanceGroundNormal = ground.toArray();
          inputs.time = 0;
          owner["playerPosUniform"]!.value.copy(worldBase(inputs)).add(
            new THREE.Vector3(distance, 0, 0),
          );
          expect(windAmplitude(inputs).length()).toBeLessThan(1e-16);
          const f = distance === 0 ? 1 : distance === 126 ? 0.5 : 0;
          const normal = vector(inputs.attributes.normal);
          normal.x *= f;
          normal.z *= f;
          normal.applyQuaternion(rotation(inputs));
          const expectedBlade =
            normal.lengthSq() > 1e-12 ? normal.normalize() : ground.clone();
          const expected = ground
            .clone()
            .lerp(expectedBlade, NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT)
            .normalize();
          const actual = vector(
            evaluate(owner["material"].normalNode!, inputs),
          );
          expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
          expect(actual.length()).toBeCloseTo(1, 12);
        }
    } finally {
      owner.destroy();
    }
  });

  it.each([
    "natural",
    "fine",
    "isolated-fine-near4",
    "bank-inside",
    "bank-feather",
    "bank-outside",
    "bank-wear-apron",
    "bank-wear-clerk",
    "bank-wear-shopkeeper",
    "bank-wear-feather",
    "pond-service-wear",
    "pond-service-near4",
    "pond-service-supplier",
    "pond-service-outside",
  ] as const)(
    "matches %s deformed smooth normals to independent tangent crosses through wind, fade, yaw and slope",
    (variant) => {
      const fixture = deformationFixture(variant);
      const {
        owner,
        appearance,
        geometryLayout,
        geometries,
        isFine,
        bankLocation,
      } = fixture;
      const bankHeight = bankLocation?.[2] ?? 1;
      let cases = 0;
      let finiteDifferenceCases = 0;
      let maximumError = 0;
      try {
        const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 1000);
        camera.position.set(25, 19, -31);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        for (const [lod, geometry] of geometries.entries()) {
          const vertices = getGrassBladeLayout(
            lod,
            geometryLayout,
          ).verticesPerBlade;
          for (const blade of [
            0,
            GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump - 1,
          ]) {
            const root = blade * vertices;
            const left = new THREE.Vector3().fromBufferAttribute(
              geometry.attributes.position,
              root,
            );
            const right = new THREE.Vector3().fromBufferAttribute(
              geometry.attributes.position,
              root + 1,
            );
            const center = left.clone().add(right).multiplyScalar(0.5);
            const width = right.clone().sub(left).normalize();
            const tip = new THREE.Vector3().fromBufferAttribute(
              geometry.attributes.position,
              root + vertices - 1,
            );
            const height = tip.y / appearance.BLADE_TIP_HEIGHT;
            const curve = tip.clone().sub(center);
            // All fine row/side samples, including the new near quarter rows;
            // retain the original independent formula and natural coverage.
            for (const index of isFine
              ? Array.from({ length: vertices }, (_, offset) => root + offset)
              : [root, root + Math.min(2, vertices - 1), root + vertices - 1])
              for (const ground of [
                new THREE.Vector3(0, 1, 0),
                new THREE.Vector3(0.4, 0.8, -0.3).normalize(),
                new THREE.Vector3(-0.6, 0.7, 0.2).normalize(),
              ])
                // Keep all historical combinations; the additive pond cases
                // reuse one clump scale while retaining all slopes/fades/rows.
                for (const scale of variant.startsWith("pond-service-")
                  ? [1.1]
                  : [0.14, 1.1, 4])
                  for (const fadeDistance of [0, 126, 140])
                    for (const seconds of [0, 3.7]) {
                      const inputs = inputFor(geometry, index);
                      if (bankLocation) {
                        inputs.model.identity();
                        inputs.attributes.instanceOffset = [
                          bankLocation[0],
                          28,
                          bankLocation[1],
                        ];
                      }
                      inputs.attributes.instanceGroundNormal = ground.toArray();
                      inputs.attributes.instanceRotScaleHash = [
                        0.4 + lod + seconds,
                        scale,
                        0.3,
                      ];
                      inputs.time = seconds;
                      inputs.view.copy(camera.matrixWorldInverse);
                      inputs.front = cases % 2 === 0;
                      owner["playerPosUniform"]!.value.copy(
                        worldBase(inputs),
                      ).add(new THREE.Vector3(fadeDistance, 0, 0));
                      const fadeT = Math.min(
                        1,
                        Math.max(0, (fadeDistance - 112) / 28),
                      );
                      const fade = 1 - fadeT * fadeT * (3 - 2 * fadeT);
                      const t = inputs.attributes.uv[1];
                      const derivativeY =
                        2 *
                        height *
                        (appearance.BLADE_CONTROL_HEIGHT +
                          t *
                            (appearance.BLADE_TIP_HEIGHT -
                              2 * appearance.BLADE_CONTROL_HEIGHT));
                      const tangentWidth = width
                        .clone()
                        .multiplyScalar(scale)
                        .applyQuaternion(rotation(inputs));
                      // Independent selected middle-control offset; historical
                      // natural grass keeps its exactly upright root tangent.
                      const controlArc = isFine ? 0.35 : 0;
                      const derivativeArc =
                        2 * (controlArc + (1 - 2 * controlArc) * t);
                      const tangentHeight = new THREE.Vector3(
                        curve.x * derivativeArc,
                        derivativeY * fade * bankHeight,
                        curve.z * derivativeArc,
                      )
                        .multiplyScalar(scale)
                        .applyQuaternion(rotation(inputs))
                        .add(
                          windAmplitude(
                            inputs,
                            appearance.BLADE_HEIGHT_MAX,
                          ).multiplyScalar(bankHeight * 1.8 * Math.pow(t, 0.8)),
                        );
                      const cross = tangentWidth.cross(tangentHeight);
                      const tangentCrossLengthSq = cross.lengthSq();
                      const smooth =
                        tangentCrossLengthSq < 1e-20
                          ? ground.clone()
                          : cross.normalize();
                      const expected = ground
                        .clone()
                        .lerp(
                          smooth.multiplyScalar(inputs.front ? 1 : -1),
                          isFine
                            ? 0.2
                            : NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT,
                        )
                        .normalize()
                        .transformDirection(inputs.view);
                      const actual = vector(
                        evaluate(owner["material"].normalNode!, inputs),
                      );
                      maximumError = Math.max(
                        maximumError,
                        actual.distanceTo(expected),
                      );
                      expect(actual.length()).toBeCloseTo(1, 12);
                      expect(actual.distanceTo(expected)).toBeLessThan(2e-6); // source Float32 position/normal rounding
                      if (
                        bankLocation &&
                        t > 0 &&
                        tangentCrossLengthSq > 1e-10
                      ) {
                        // Numerically differentiate the actual position graph,
                        // independent of the cofactor graph and analytic wind
                        // derivative. Hold the clump-locality field constant:
                        // it is a root-owned property, not a per-vertex field.
                        const epsilon = 1e-5;
                        const point = (parameter: number, across: number) => {
                          const arc =
                            2 * controlArc * parameter * (1 - parameter) +
                            parameter * parameter;
                          const source = center
                            .clone()
                            .add(
                              new THREE.Vector3(
                                curve.x * arc,
                                height *
                                  (2 *
                                    appearance.BLADE_CONTROL_HEIGHT *
                                    (1 - parameter) *
                                    parameter +
                                    appearance.BLADE_TIP_HEIGHT *
                                      parameter *
                                      parameter),
                                curve.z * arc,
                              ),
                            )
                            .addScaledVector(width, across);
                          return vector(
                            evaluate(owner["material"].positionNode!, {
                              ...inputs,
                              attributes: {
                                ...inputs.attributes,
                                position: source.toArray(),
                                uv: [0.5, parameter],
                              },
                            }),
                          );
                        };
                        const derivativeAlong = point(t + epsilon, 0)
                          .sub(point(t - epsilon, 0))
                          .multiplyScalar(0.5 / epsilon);
                        const derivativeAcross = point(t, epsilon)
                          .sub(point(t, -epsilon))
                          .multiplyScalar(0.5 / epsilon);
                        const numericalBlade = derivativeAcross
                          .cross(derivativeAlong)
                          .normalize();
                        const numericalNormal = ground
                          .clone()
                          .lerp(
                            numericalBlade.multiplyScalar(
                              inputs.front ? 1 : -1,
                            ),
                            appearance.BLADE_NORMAL_WEIGHT,
                          )
                          .normalize()
                          .transformDirection(inputs.view);
                        expect(actual.distanceTo(numericalNormal)).toBeLessThan(
                          3e-6,
                        );
                        finiteDifferenceCases++;
                      }
                      const position = vector(inputs.attributes.position);
                      position.y *= fade * bankHeight;
                      position
                        .multiplyScalar(scale)
                        .applyQuaternion(rotation(inputs))
                        .add(
                          windAmplitude(
                            inputs,
                            appearance.BLADE_HEIGHT_MAX,
                          ).multiplyScalar(bankHeight * Math.pow(t, 1.8)),
                        )
                        .add(vector(inputs.attributes.instanceOffset));
                      expect(
                        vector(
                          evaluate(owner["material"].positionNode!, inputs),
                        ).distanceTo(position),
                      ).toBeLessThan(1e-12);
                      cases++;
                    }
          }
        }
        expect(cases).toBe(
          variant === "pond-service-near4"
            ? 612
            : variant.startsWith("pond-service-")
              ? 540
              : variant === "isolated-fine-near4"
                ? 1836
                : isFine
                  ? 1620
                  : 972,
        );
        expect(maximumError).toBeLessThan(2e-6);
        if (bankLocation)
          expect(finiteDifferenceCases).toBeGreaterThan(
            variant.startsWith("pond-service-") ? 150 : 500,
          );
      } finally {
        fixture.close();
      }
    },
  );

  it.each([
    "natural",
    "fine",
    "isolated-fine-near4",
    "bank-inside",
    "bank-feather",
    "bank-outside",
    "bank-wear-apron",
    "bank-wear-clerk",
    "bank-wear-shopkeeper",
    "bank-wear-feather",
    "pond-service-wear",
    "pond-service-near4",
    "pond-service-supplier",
    "pond-service-outside",
  ] as const)(
    "keeps both %s roots anchored over time and all vertex wind inside existing swept bounds",
    (variant) => {
      const fixture = deformationFixture(variant);
      const { owner, appearance, geometryLayout, geometries, bankLocation } =
        fixture;
      const bankHeight = bankLocation?.[2] ?? 1;
      try {
        for (const [lod, geometry] of geometries.entries()) {
          const vertices = getGrassBladeLayout(
            lod,
            geometryLayout,
          ).verticesPerBlade;
          for (
            let index = 0;
            index < geometry.attributes.position.count;
            index++
          ) {
            const inputs = inputFor(geometry, index);
            if (bankLocation) {
              inputs.model.identity();
              inputs.attributes.instanceOffset = [
                bankLocation[0],
                28,
                bankLocation[1],
              ];
            }
            inputs.attributes.instanceGroundNormal = new THREE.Vector3(
              0.3,
              0.8,
              -0.4,
            )
              .normalize()
              .toArray();
            owner["playerPosUniform"]!.value.copy(worldBase(inputs));
            const base = vector(inputs.attributes.position);
            base.y *= bankHeight;
            base
              .multiplyScalar(inputs.attributes.instanceRotScaleHash[1])
              .applyQuaternion(rotation(inputs))
              .add(vector(inputs.attributes.instanceOffset));
            const t = inputs.attributes.uv[1];
            for (const seconds of [0, 1.1, 3.7, 20, 100]) {
              inputs.time = seconds;
              const delta = vector(
                evaluate(owner["material"].positionNode!, inputs),
              ).sub(base);
              const cap =
                GRASS_CONFIG.WIND_STRENGTH *
                appearance.BLADE_HEIGHT_MAX *
                bankHeight *
                Math.pow(t, 1.8);
              expect(Math.abs(delta.x)).toBeLessThanOrEqual(cap + 1e-13);
              expect(Math.abs(delta.z)).toBeLessThanOrEqual(cap * 0.55 + 1e-13);
              expect(Math.abs(delta.y)).toBeLessThan(1e-13);
              if (index % vertices < 2)
                expect(delta.length()).toBeLessThan(1e-13);
            }
          }
        }
      } finally {
        fixture.close();
      }
    },
  );
});
