import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE, {
  cameraViewMatrix,
  cameraPosition,
  positionWorld,
  modelWorldMatrix,
  output,
  time,
} from "../../../../extras/three/three";
import {
  MeshSSSNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
} from "three/webgpu";
import habitatData from "../../../../data/compact-haven-habitat-v1.json";
import { validateCompactHabitatComposition } from "../CompactHabitatComposition";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  COMPACT_MEADOW_APPEARANCE,
  CURVED_MEADOW_APPEARANCE,
  NATURAL_TUFT_APPEARANCE,
  FINE_MEADOW_APPEARANCE,
  FINE_GRASS_THIN_LEAF_LIGHTING,
  FINE_GRASS_CANOPY_NORMAL_LIGHTING,
  FINE_GRASS_LEAF_VOLUME_LIGHTING,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  GRASS_CONFIG,
  GrassVisualManager,
  createClumpGeometry,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassVisualProfile,
  type GrassWorkerSetup,
} from "../GrassVisualManager";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import { sampleSkyCycle } from "../SkySystem";
import { createGroundedGrassMaterial } from "../GrassGroundingGpu";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";

/** Real geometry/material construction; no renderer or GPU is simulated. */
function manager(
  profile: GrassVisualProfile = {},
  terrain = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  withWorkerSetup = true,
  appearanceCandidate?: ConstructorParameters<typeof GrassVisualManager>[13],
  habitat?: ConstructorParameters<typeof GrassVisualManager>[14],
  lighting?: ConstructorParameters<typeof GrassVisualManager>[15],
  grassColorGrade?: GrassWorkerSetup["compactGrassColorGrade"],
) {
  const config = createTerrainWorkerConfig(terrain, 16);
  const setup: GrassWorkerSetup = {
    terrainConfig: config,
    seed: terrain.seed,
    biomeCenters: [],
    biomes: {},
    grassConfigs: {},
    ...(grassColorGrade ? { compactGrassColorGrade: grassColorGrade } : {}),
    tileSize: terrain.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: () => {
      throw new Error("Appearance construction must not generate placements");
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
    profile,
    undefined,
    undefined,
    undefined,
    appearanceCandidate,
    habitat,
    lighting,
  );
}

// Expand the actual material's construction-time Fn, not a replacement shader.
function requireNode(value: unknown): Node {
  if (!(value instanceof THREE.Node))
    throw new Error("Expected actual Three node");
  return value;
}

function numericValue(value: unknown): number[] | null {
  if (value instanceof THREE.Vector2) return [value.x, value.y];
  if (value instanceof THREE.Vector3) return [value.x, value.y, value.z];
  if (value instanceof THREE.Vector4)
    return [value.x, value.y, value.z, value.w];
  if (value instanceof THREE.Matrix3 || value instanceof THREE.Matrix4)
    return Array.from(value.elements);
  return null;
}

function expand(input: unknown): Node {
  let node = requireNode(input);
  while (Reflect.get(node, "isVarNode")) node = Reflect.get(node, "node");
  const shaderNode: unknown = Reflect.get(node, "shaderNode");
  if (shaderNode instanceof THREE.Node) {
    const jsFunc: unknown = Reflect.get(shaderNode, "jsFunc");
    if (typeof jsFunc === "function") {
      const result: unknown = jsFunc();
      if (!(result instanceof THREE.Node)) throw new Error("Expected Fn node");
      return result;
    }
  }
  return node;
}

function graph(root: unknown): Set<Node> {
  const nodes = new Set<Node>();
  const visit = (node: Node) => {
    if (nodes.has(node)) return;
    expect(nodes.size).toBeLessThan(4096);
    nodes.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(expand(root));
  return nodes;
}

// Concrete node arithmetic only. Unknown operations fail; no GPU is simulated.
function colorValue(
  input: unknown,
  attributes: Record<string, number[]>,
): number[] {
  // TSL is a DAG. Evaluate a shared node once per immutable input sample;
  // recursively expanding it as a tree makes folded-normal tests exponential.
  // No cache survives a call, so the next wind/UV/attribute sample is independent.
  const values = new Map<Node, number[]>();
  const evaluate = (value: unknown): number[] => {
    const node = requireNode(value);
    const cached = values.get(node);
    if (cached) return cached;
    const result = computeColorValue(node, attributes, evaluate);
    values.set(node, result);
    return result;
  };
  return evaluate(input);
}

function computeColorValue(
  input: unknown,
  attributes: Record<string, number[]>,
  evaluate: (input: unknown) => number[],
): number[] {
  const node = requireNode(input);
  const read = (key: string): unknown => Reflect.get(node, key);
  const child = (key: string): number[] => {
    const value = read(key);
    if (!(value instanceof THREE.Node))
      throw new Error(
        `Missing ${key} on ${node.type}: ${Object.keys(node).join(",")}`,
      );
    return evaluate(value);
  };
  if (node === cameraViewMatrix) return attributes._cameraViewMatrix;
  if (node === cameraPosition) return attributes._cameraPosition;
  if (node === positionWorld) return attributes._positionWorld;
  if (node === modelWorldMatrix) return attributes._modelWorldMatrix;
  if (node === time && attributes._time) return attributes._time;
  if (node.type === "FrontFacingNode") return attributes._frontFacing;
  if (node.type === "AttributeNode") {
    const value = attributes[String(read("_attributeName"))];
    if (!value) throw new Error("Unexpected albedo attribute");
    return value;
  }
  // Resolve external accessor identities first: Three camera accessors require
  // a real builder. Only the remaining construction-time albedo Fn is expanded
  // when it is nested below the shared thickness tint.
  const expanded = expand(node);
  if (expanded !== node) return evaluate(expanded);
  const value = read("value");
  if (typeof value === "number") return [value];
  const numeric = numericValue(value);
  if (numeric) return numeric;
  if (
    node.type === "ConvertNode" ||
    node.type === "VarNode" ||
    node.type === "VaryingNode" ||
    node.type === "SubBuild"
  )
    return child("node");
  if (node.type === "JoinNode") {
    const nodes = read("nodes");
    if (!Array.isArray(nodes) || nodes.some((n) => !(n instanceof THREE.Node)))
      throw new Error("Invalid join inputs");
    return nodes.flatMap((n) => evaluate(n));
  }
  if (node.type === "SplitNode")
    return [...String(read("components"))].map(
      (component) => child("node")["xyzw".indexOf(component)],
    );
  if (node.type === "ConditionalNode")
    return child("condNode")[0] ? child("ifNode") : child("elseNode");
  const aValues = child("aNode");
  if (read("method") === "normalize") {
    const length = Math.hypot(...aValues);
    return aValues.map((x) => x / length);
  }
  if (read("method") === "sin") return aValues.map(Math.sin);
  if (read("method") === "cos") return aValues.map(Math.cos);
  if (read("method") === "negate") return aValues.map((x) => -x);
  const operands = [aValues, child("bNode")];
  if (read("method") === "dot")
    return [aValues.reduce((sum, value, i) => sum + value * operands[1][i], 0)];
  if (read("op") === "*" && aValues.length === 16 && operands[1].length === 4) {
    const matrix = new THREE.Matrix4().fromArray(aValues);
    return new THREE.Vector4(
      ...(operands[1] as [number, number, number, number]),
    )
      .applyMatrix4(matrix)
      .toArray();
  }
  if (read("method") === "transformDirection") {
    expect(aValues.length).toBe(16);
    expect(operands[1].length).toBe(3);
    return new THREE.Vector3(...(operands[1] as [number, number, number]))
      .transformDirection(new THREE.Matrix4().fromArray(aValues))
      .toArray();
  }
  if (read("cNode") instanceof THREE.Node) operands.push(child("cNode"));
  return Array.from(
    { length: Math.max(...operands.map((v) => v.length)) },
    (_, i) => {
      const [a, b, c] = operands.map((v) => v[v.length === 1 ? 0 : i]);
      if (read("op") === "*") return a * b;
      if (read("op") === "+") return a + b;
      if (read("op") === "-") return a - b;
      if (read("op") === "/") return a / b;
      if (read("op") === ">") return Number(a > b);
      if (read("method") === "min") return Math.min(a, b);
      if (read("method") === "max") return Math.max(a, b);
      if (read("method") === "pow") return Math.pow(a, b);
      if (read("method") === "clamp") return Math.min(c, Math.max(b, a));
      if (read("method") === "mix") return a + (b - a) * c;
      if (read("method") === "smoothstep") {
        const t = Math.max(0, Math.min(1, (c - a) / (b - a)));
        return t * t * (3 - 2 * t);
      }
      throw new Error(`Unexpected color operation ${node.type}`);
    },
  );
}

function geometryBytes(geometry: THREE.BufferGeometry) {
  return (
    Object.values(geometry.attributes).reduce(
      (sum, attribute) => sum + attribute.array.byteLength,
      0,
    ) + geometry.index!.array.byteLength
  );
}

describe("opt-in fine canopy normals (actual graph and geometry, CPU only)", () => {
  const fine = (
    lighting?: ConstructorParameters<typeof GrassVisualManager>[15],
  ) =>
    manager(
      FINE_MEADOW_GRASS_VISUAL_PROFILE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      true,
      "fine-meadow-v1",
      undefined,
      lighting,
    );

  it("admits only the explicit sculpt/fine owner without changing profile metadata", () => {
    const baseline = fine(),
      candidate = fine("canopy-normal-v1");
    try {
      expect(candidate.getProfileReceipt()).toEqual(
        baseline.getProfileReceipt(),
      );
      expect(FINE_GRASS_CANOPY_NORMAL_LIGHTING).toEqual({
        id: "canopy-normal-v1",
        rootWeight: 0.2,
        upperWeight: 0.45,
        rootEnd: 0.1,
        upperStart: 0.65,
      });
      expect(Object.isFrozen(FINE_GRASS_CANOPY_NORMAL_LIGHTING)).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(
          baseline["material"].userData,
          "fineGrassCanopyLighting",
        ),
      ).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(
          candidate["material"].userData,
          "fineGrassCanopyLighting",
        ),
      ).toEqual({
        value: FINE_GRASS_CANOPY_NORMAL_LIGHTING,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      for (const value of [
        null,
        "",
        "other",
        " canopy-normal-v1",
        {},
        ["canopy-normal-v1"],
      ])
        expect(() =>
          fine(value as ConstructorParameters<typeof GrassVisualManager>[15]),
        ).toThrow("Grass lighting");
      for (const profile of [
        {},
        STREAMING_GRASS_VISUAL_PROFILE,
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
      ])
        expect(() =>
          manager(
            profile,
            SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
            true,
            undefined,
            undefined,
            "canopy-normal-v1",
          ),
        ).toThrow("Grass lighting");
      expect(() =>
        manager(
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          false,
          "fine-meadow-v1",
          undefined,
          "canopy-normal-v1",
        ),
      ).toThrow("Grass lighting");
      expect(() =>
        manager(
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          COMPACT_WORLD_TERRAIN_PROFILE,
          true,
          "fine-meadow-v1",
          undefined,
          "canopy-normal-v1",
        ),
      ).toThrow("Grass lighting");
    } finally {
      baseline.destroy();
      candidate.destroy();
    }
  });

  it("changes only the final normal mixture, preserving geometry, position, albedo, AO and all SSS inputs exactly", () => {
    const baseline = fine(),
      candidate = fine("canopy-normal-v1");
    try {
      const a = baseline["material"],
        b = candidate["material"];
      if (
        !(a instanceof MeshSSSNodeMaterial) ||
        !(b instanceof MeshSSSNodeMaterial)
      )
        throw new Error("Expected actual fine physical materials");
      for (const key of [
        "side",
        "transparent",
        "depthWrite",
        "roughness",
        "metalness",
        "fog",
        "transmission",
        "clearcoat",
        "sheen",
        "iridescence",
        "anisotropy",
        "dispersion",
        "retroreflectivity",
      ] as const)
        expect(b[key]).toBe(a[key]);
      expect(b.userData.fineGrassLighting).toBe(a.userData.fineGrassLighting);
      const unchanged = [
        "positionNode",
        "colorNode",
        "aoNode",
        "thicknessColorNode",
        "thicknessAttenuationNode",
        "thicknessScaleNode",
        "thicknessPowerNode",
        "thicknessDistortionNode",
        "thicknessAmbientNode",
      ] as const;
      for (const key of [...unchanged, "normalNode"] as const) {
        const oldGraph = graph(a[key]!),
          newGraph = graph(b[key]!);
        expect([...newGraph].some((n) => Reflect.get(n, "isTextureNode"))).toBe(
          false,
        );
        const attrs = (nodes: Set<Node>) =>
          [...nodes]
            .filter((n) => n.type === "AttributeNode")
            .map((n) => Reflect.get(n, "_attributeName"))
            .sort();
        expect(attrs(newGraph)).toEqual(attrs(oldGraph));
      }
      const oldNodes = graph(a.normalNode!),
        newNodes = graph(b.normalNode!);
      expect(
        [...oldNodes].some(
          (n) => Reflect.get(n, "name") === "fineGrassCanopyNormalWeight",
        ),
      ).toBe(false);
      const weight = [...newNodes].filter(
        (n) => Reflect.get(n, "name") === "fineGrassCanopyNormalWeight",
      );
      expect(weight).toHaveLength(1);
      const blade = [...newNodes].find(
        (n) => Reflect.get(n, "name") === "v_curvedGrassNormal",
      )!;
      expect(blade).toBeDefined();
      let changed = 0;
      for (let lod = 0; lod < 3; lod++) {
        const oldGeometry = baseline["lodGeometries"][lod],
          geometry = candidate["lodGeometries"][lod];
        expect(Object.keys(geometry.attributes)).toEqual(
          Object.keys(oldGeometry.attributes),
        );
        for (const key of Object.keys(geometry.attributes))
          expect(geometry.attributes[key].array).toEqual(
            oldGeometry.attributes[key].array,
          );
        expect(geometry.index!.array).toEqual(oldGeometry.index!.array);
        expect(geometryBytes(geometry)).toBe(geometryBytes(oldGeometry));
        const position = geometry.getAttribute("position"),
          normal = geometry.getAttribute("normal"),
          uvs = geometry.getAttribute("uv");
        const stride = getGrassBladeLayout(
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        ).verticesPerBlade;
        for (const index of [0, 2, stride - 1])
          for (const distance of [0, 125, 140])
            for (const windTime of [0, 2.3])
              for (const ground of [
                new THREE.Vector3(0, 1, 0),
                new THREE.Vector3(0.3, 0.9, -0.2).normalize(),
              ])
                for (const front of [false, true]) {
                  const inputs = {
                    position: new THREE.Vector3()
                      .fromBufferAttribute(position, index)
                      .toArray(),
                    normal: new THREE.Vector3()
                      .fromBufferAttribute(normal, index)
                      .toArray(),
                    uv: [uvs.getX(index), uvs.getY(index)],
                    instanceGroundNormal: ground.toArray(),
                    instanceOffset: [distance, 28, 0],
                    instanceRotScaleHash: [0.7, 0.83, 0.4],
                    instanceGroundColor: [0.2, 0.4, 0.1],
                    instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
                    _time: [windTime],
                    _frontFacing: [front ? 1 : 0],
                    _cameraViewMatrix: new THREE.Matrix4()
                      .makeRotationY(0.4)
                      .toArray(),
                    _modelWorldMatrix: new THREE.Matrix4().toArray(),
                  };
                  for (const key of unchanged)
                    expect(colorValue(b[key]!, inputs)).toEqual(
                      colorValue(a[key]!, inputs),
                    );
                  const t = Math.max(
                    0,
                    Math.min(1, (inputs.uv[1] - 0.1) / 0.55),
                  );
                  const expectedWeight = 0.2 + 0.25 * t * t * (3 - 2 * t);
                  expect(colorValue(weight[0], inputs)[0]).toBeCloseTo(
                    expectedWeight,
                    14,
                  );
                  const leaf = new THREE.Vector3(
                    ...(colorValue(blade, inputs) as [number, number, number]),
                  );
                  const expected = ground
                    .clone()
                    .lerp(
                      leaf.normalize().multiplyScalar(front ? 1 : -1),
                      expectedWeight,
                    )
                    .normalize()
                    .transformDirection(
                      new THREE.Matrix4().fromArray(inputs._cameraViewMatrix),
                    );
                  const actual = new THREE.Vector3(
                    ...(colorValue(b.normalNode!, inputs) as [
                      number,
                      number,
                      number,
                    ]),
                  );
                  expect(actual.toArray().every(Number.isFinite)).toBe(true);
                  expect(actual.length()).toBeCloseTo(1, 12);
                  expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
                  const previous = colorValue(a.normalNode!, inputs);
                  if (inputs.uv[1] <= 0.1)
                    expect(actual.toArray()).toEqual(previous);
                  else if (
                    actual.distanceTo(
                      new THREE.Vector3(
                        ...(previous as [number, number, number]),
                      ),
                    ) > 1e-3
                  )
                    changed++;
                }
      }
      expect(changed).toBeGreaterThan(0);
      // Even opposite unit normals retain length >=1-2*.45 before normalize.
      for (const front of [false, true]) {
        const lowerBound = new THREE.Vector3(0, 1, 0)
          .lerp(new THREE.Vector3(0, front ? -1 : 1, 0), 0.45)
          .length();
        expect(lowerBound).toBeGreaterThanOrEqual(0.09999999999999998);
      }
    } finally {
      baseline.destroy();
      candidate.destroy();
    }
  });

  it("retains candidate normal identity through real grounding clones and immutable representative publication", async () => {
    const owner = fine("canopy-normal-v1");
    try {
      for (let lod = 0; lod < 3; lod++) {
        const geometry = owner["lodGeometries"][lod].clone();
        const layout = getGrassBladeLayout(
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        const clone = createGroundedGrassMaterial(
          owner["material"],
          geometry,
          new Float32Array(layout.bladesPerClump * layout.rootComponents),
          1,
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        try {
          expect(clone.normalNode).toBe(owner["material"].normalNode);
          expect(clone.colorNode).toBe(owner["material"].colorNode);
          expect(clone.aoNode).toBe(owner["material"].aoNode);
          expect(clone.userData.fineGrassCanopyLighting).toEqual(
            FINE_GRASS_CANOPY_NORMAL_LIGHTING,
          );
        } finally {
          clone.dispose();
          geometry.dispose();
        }
      }
      let inspected = false;
      await owner.precompileRepresentativeChunk(async (object) => {
        // Inspect actual constructed owner only; no compilation/GPU is simulated.
        if (
          !(object instanceof THREE.InstancedMesh) ||
          !(object.material instanceof MeshSSSNodeMaterial)
        )
          throw new Error("Expected real fine representative");
        expect(object.material.normalNode).toBe(owner["material"].normalNode);
        expect(
          Object.getOwnPropertyDescriptor(
            object.material.userData,
            "fineGrassCanopyLighting",
          ),
        ).toEqual({
          value: FINE_GRASS_CANOPY_NORMAL_LIGHTING,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        inspected = true;
      });
      expect(inspected).toBe(true);
    } finally {
      owner.destroy();
    }
  });
});

describe("opt-in fine leaf volume (actual graph/geometry, not native rendering)", () => {
  const fine = (
    lighting?: ConstructorParameters<typeof GrassVisualManager>[15],
    grassColorGrade?: GrassWorkerSetup["compactGrassColorGrade"],
  ) =>
    manager(
      FINE_MEADOW_GRASS_VISUAL_PROFILE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      true,
      "fine-meadow-v1",
      undefined,
      lighting,
      grassColorGrade,
    );
  const smooth = (low: number, high: number, value: number) => {
    const x = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return x * x * (3 - 2 * x);
  };
  const named = (root: unknown, name: string) => {
    const nodes = [...graph(root)].filter(
      (n) => Reflect.get(n, "name") === name,
    );
    expect(nodes).toHaveLength(1);
    return nodes[0];
  };
  const vector = (value: number[]) => {
    expect(value).toHaveLength(3);
    return new THREE.Vector3(value[0], value[1], value[2]);
  };
  const inputsAt = (
    geometry: THREE.BufferGeometry,
    index: number,
  ): Record<string, number[]> => ({
    position: new THREE.Vector3()
      .fromBufferAttribute(geometry.getAttribute("position"), index)
      .toArray(),
    normal: new THREE.Vector3()
      .fromBufferAttribute(geometry.getAttribute("normal"), index)
      .toArray(),
    uv: [
      geometry.getAttribute("uv").getX(index),
      geometry.getAttribute("uv").getY(index),
    ],
    instanceGroundNormal: [0, 1, 0],
    instanceOffset: [0, 28, 0],
    instanceRotScaleHash: [0.7, 0.83, 0.4],
    instanceGroundColor: [0.2, 0.4, 0.1],
    instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
    _time: [0],
    _frontFacing: [1],
    _cameraViewMatrix: new THREE.Matrix4().makeRotationY(0.4).toArray(),
    _modelWorldMatrix: new THREE.Matrix4().toArray(),
  });

  it("admits a distinct immutable recipe only for the fine sculpt owner", () => {
    const baseline = fine(),
      canopy = fine("canopy-normal-v1"),
      candidate = fine("leaf-volume-v1");
    try {
      expect(FINE_GRASS_LEAF_VOLUME_LIGHTING).toEqual({
        id: "leaf-volume-v1",
        rootWeight: 0.2,
        upperWeight: 0.45,
        rootEnd: 0.1,
        upperStart: 0.65,
        foldTangent: Math.tan((24 * Math.PI) / 180),
        foldTipStart: 0.75,
        rootBrightness: 0.55,
        tipBrightness: 1.12,
      });
      expect(Object.isFrozen(FINE_GRASS_LEAF_VOLUME_LIGHTING)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(
          candidate["material"].userData,
          "fineGrassCanopyLighting",
        ),
      ).toEqual({
        value: FINE_GRASS_LEAF_VOLUME_LIGHTING,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      expect(canopy["material"].userData.fineGrassCanopyLighting).toBe(
        FINE_GRASS_CANOPY_NORMAL_LIGHTING,
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          baseline["material"].userData,
          "fineGrassCanopyLighting",
        ),
      ).toBe(false);
      expect(candidate.getProfileReceipt()).toEqual(
        baseline.getProfileReceipt(),
      );
      for (const value of [
        "LEAF-VOLUME-V1",
        " leaf-volume-v1",
        "leaf-volume-v1 ",
        ["leaf-volume-v1"],
        {},
        null,
      ])
        expect(() =>
          fine(value as ConstructorParameters<typeof GrassVisualManager>[15]),
        ).toThrow("Grass lighting");
      for (const profile of [
        {},
        STREAMING_GRASS_VISUAL_PROFILE,
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
      ])
        expect(() =>
          manager(
            profile,
            SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
            true,
            undefined,
            undefined,
            "leaf-volume-v1",
          ),
        ).toThrow("Grass lighting");
      expect(() =>
        manager(
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          false,
          "fine-meadow-v1",
          undefined,
          "leaf-volume-v1",
        ),
      ).toThrow("Grass lighting");
      expect(() =>
        manager(
          FINE_MEADOW_GRASS_VISUAL_PROFILE,
          COMPACT_WORLD_TERRAIN_PROFILE,
          true,
          "fine-meadow-v1",
          undefined,
          "leaf-volume-v1",
        ),
      ).toThrow("Grass lighting");
    } finally {
      baseline.destroy();
      canopy.destroy();
      candidate.destroy();
    }
  });

  it("preserves every geometry byte and pass property while adding only the explicit width varying", () => {
    const baseline = fine(),
      canopy = fine("canopy-normal-v1"),
      candidate = fine("leaf-volume-v1");
    try {
      const a = baseline["material"],
        b = candidate["material"];
      if (
        !(a instanceof MeshSSSNodeMaterial) ||
        !(b instanceof MeshSSSNodeMaterial)
      )
        throw new Error("Expected real fine SSS materials");
      for (const key of [
        "side",
        "transparent",
        "depthWrite",
        "roughness",
        "metalness",
        "fog",
        "transmission",
        "clearcoat",
        "sheen",
        "iridescence",
        "anisotropy",
        "dispersion",
        "retroreflectivity",
      ] as const)
        expect(b[key]).toBe(a[key]);
      expect(b.emissive.toArray()).toEqual([0, 0, 0]);
      expect(b.userData.fineGrassLighting).toBe(a.userData.fineGrassLighting);
      for (const key of [
        "normalNode",
        "colorNode",
        "aoNode",
        "positionNode",
        "thicknessColorNode",
      ] as const) {
        const oldGraph = graph(a[key]),
          newGraph = graph(b[key]);
        expect([...newGraph].some((n) => Reflect.get(n, "isTextureNode"))).toBe(
          false,
        );
        const attributes = (nodes: Set<Node>) =>
          [
            ...new Set(
              [...nodes]
                .filter((n) => n.type === "AttributeNode")
                .map((n) => Reflect.get(n, "_attributeName")),
            ),
          ].sort();
        expect(attributes(newGraph)).toEqual(attributes(oldGraph));
      }
      const width = named(b.normalNode, "v_fineGrassWidthAxis");
      expect(width.type).toBe("VaryingNode");
      for (const owner of [baseline, canopy])
        expect(
          [...graph(owner["material"].normalNode)].some(
            (n) => Reflect.get(n, "name") === "v_fineGrassWidthAxis",
          ),
        ).toBe(false);
      for (let lod = 0; lod < 3; lod++) {
        const geometry = candidate["lodGeometries"][lod];
        for (const owner of [baseline, canopy]) {
          const original = owner["lodGeometries"][lod];
          expect(Object.keys(geometry.attributes)).toEqual(
            Object.keys(original.attributes),
          );
          for (const key of Object.keys(original.attributes))
            expect(geometry.attributes[key].array).toEqual(
              original.attributes[key].array,
            );
          expect(geometry.index!.array).toEqual(original.index!.array);
          expect(geometryBytes(geometry)).toBe(geometryBytes(original));
        }
        const inputs = inputsAt(geometry, 2);
        for (const distance of [0, 125, 140])
          for (const windTime of [0, 2.3]) {
            inputs.instanceOffset[0] = distance;
            inputs._time[0] = windTime;
            for (const key of [
              "positionNode",
              "aoNode",
              "thicknessAttenuationNode",
              "thicknessScaleNode",
              "thicknessPowerNode",
              "thicknessDistortionNode",
              "thicknessAmbientNode",
            ] as const)
              expect(colorValue(b[key], inputs)).toEqual(
                colorValue(a[key], inputs),
              );
          }
      }
    } finally {
      baseline.destroy();
      canopy.destroy();
      candidate.destroy();
    }
  });

  it("evaluates the real folded graph with correct authored width, both faces, slope, wind and fade", () => {
    const owner = fine("leaf-volume-v1");
    try {
      const material = owner["material"],
        normalNode = material.normalNode;
      const widthNode = named(normalNode, "v_fineGrassWidthAxis");
      const bladeNode = named(normalNode, "v_curvedGrassNormal");
      const foldNode = named(normalNode, "fineGrassTransverseFold");
      const weightNode = named(normalNode, "fineGrassCanopyNormalWeight");
      let oppositeSides = 0;
      for (let lod = 0; lod < 3; lod++) {
        const geometry = owner["lodGeometries"][lod];
        const stride = getGrassBladeLayout(
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        ).verticesPerBlade;
        for (const index of [0, 2, stride - 1])
          for (const distance of [0, 125, 140])
            for (const windTime of [0, 2.3])
              for (const ground of [
                new THREE.Vector3(0, 1, 0),
                new THREE.Vector3(0.3, 0.9, -0.2).normalize(),
              ]) {
                const inputs = inputsAt(geometry, index);
                inputs.instanceOffset[0] = distance;
                inputs._time[0] = windTime;
                inputs.instanceGroundNormal = ground.toArray();
                const source = vector(inputs.normal);
                const expectedWidth = new THREE.Vector3(source.z, 0, -source.x)
                  // Instance yaw uses x'=cx-sz,z'=sx+cz: opposite Three's +Y angle.
                  .normalize()
                  .applyAxisAngle(
                    new THREE.Vector3(0, 1, 0),
                    -inputs.instanceRotScaleHash[0],
                  )
                  .applyQuaternion(
                    new THREE.Quaternion().setFromUnitVectors(
                      new THREE.Vector3(0, 1, 0),
                      ground,
                    ),
                  );
                const actualWidth = vector(colorValue(widthNode, inputs));
                expect(actualWidth.length()).toBeCloseTo(1, 12);
                expect(actualWidth.distanceTo(expectedWidth)).toBeLessThan(
                  1e-12,
                );
                const leaf = vector(colorValue(bladeNode, inputs)).normalize();
                const tangent = expectedWidth
                  .clone()
                  .addScaledVector(leaf, -expectedWidth.dot(leaf));
                tangent.divideScalar(
                  Math.sqrt(Math.max(tangent.lengthSq(), 1e-12)),
                );
                const t = inputs.uv[1],
                  weight = 0.2 + 0.25 * smooth(0.1, 0.65, t);
                expect(colorValue(weightNode, inputs)[0]).toBeCloseTo(
                  weight,
                  14,
                );
                const sideNormals: THREE.Vector3[] = [];
                for (const u of [0, 0.5, 1])
                  for (const front of [false, true]) {
                    inputs.uv[0] = u;
                    inputs._frontFacing[0] = front ? 1 : 0;
                    const fold =
                      (2 * u - 1) *
                      Math.tan((24 * Math.PI) / 180) *
                      (1 - smooth(0.75, 1, t));
                    expect(colorValue(foldNode, inputs)[0]).toBeCloseTo(
                      fold,
                      14,
                    );
                    const folded = leaf
                      .clone()
                      .addScaledVector(tangent, fold)
                      .normalize();
                    const mixed = ground
                      .clone()
                      .lerp(folded.multiplyScalar(front ? 1 : -1), weight);
                    const expected = (
                      mixed.lengthSq() > 1e-12
                        ? mixed.normalize()
                        : ground.clone()
                    ).transformDirection(
                      new THREE.Matrix4().fromArray(inputs._cameraViewMatrix),
                    );
                    const actual = vector(colorValue(normalNode, inputs));
                    expect(actual.toArray().every(Number.isFinite)).toBe(true);
                    expect(actual.length()).toBeCloseTo(1, 12);
                    expect(actual.distanceTo(expected)).toBeLessThan(1e-11);
                    expect(
                      actual
                        .clone()
                        .transformDirection(
                          new THREE.Matrix4()
                            .fromArray(inputs._cameraViewMatrix)
                            .invert(),
                        )
                        .dot(ground),
                    ).toBeGreaterThan(0);
                    if (front && u !== 0.5) sideNormals.push(actual);
                  }
                if (t === 1)
                  expect(
                    sideNormals[0].distanceTo(sideNormals[1]),
                  ).toBeLessThan(1e-12);
                else if (
                  distance === 0 &&
                  sideNormals[0].distanceTo(sideNormals[1]) > 0.05
                )
                  oppositeSides++;
              }
      }
      expect(oppositeSides).toBeGreaterThan(0);
    } finally {
      owner.destroy();
    }
  });

  it("reports actual leaf-normal illumination contrast without requiring today's appearance", () => {
    const owner = fine("leaf-volume-v1");
    try {
      const material = owner["material"];
      if (!(material instanceof MeshSSSNodeMaterial))
        throw new Error("Expected the actual fine SSS material");
      const geometry = owner["lodGeometries"][0];
      const layout = getGrassBladeLayout(
        0,
        FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
      );
      const range = (values: number[]) => [
        Math.min(...values),
        Math.max(...values),
      ];
      const spread = (values: number[]) =>
        Math.max(...values) - Math.min(...values);
      const saturate = (value: number) => Math.min(1, Math.max(0, value));
      const measurements: Array<{
        phase: number;
        lightWorld: number[];
        rowHeight: number;
        front: boolean;
        ndotlRange: number[];
        crossWidthNdotlSpreadRange: number[];
        crossWidthNormalYSpreadRange: number[];
        edgeNormalDistanceRange: number[];
        topDownSssRgbMaximum: number[];
        grazingBacklitSssRgbMaximum: number[];
      }> = [];

      // sampleSkyCycle is production math. Environment.updateSunLightPosition
      // places the settled daytime light at anchor + sun*400 + (0,100,0).
      // Actual live lightDirection is lerped: these are NOT captured light
      // vectors, and no water-uniform vector is substituted for the light.
      for (const phase of [0.5, 0.56, 0.3]) {
        const sun = new THREE.Vector3();
        sampleSkyCycle(phase, sun);
        const light = sun
          .multiplyScalar(400)
          .add(new THREE.Vector3(0, 100, 0))
          .normalize();
        const topDownView = new THREE.Vector3(0, 1, 0);
        // A representative viewer above ground, opposite the light azimuth.
        // It is intentionally not the native capture camera or a light change.
        const grazingView = new THREE.Vector3(-light.x, 0, -light.z);
        if (grazingView.lengthSq() < 1e-12) grazingView.set(0, 0, 1);
        grazingView.normalize().setY(0.15).normalize();
        for (let row = 0; row <= layout.bladeSegments; row++)
          for (const front of [false, true]) {
            const index = Math.min(row * 2, layout.verticesPerBlade - 1);
            const allNdotl: number[] = [];
            const ndotlSpreads: number[] = [];
            const normalYSpreads: number[] = [];
            const edgeNormalDistances: number[] = [];
            const sssMax = [new THREE.Vector3(), new THREE.Vector3()];
            // Real first-blade row attributes, flat retained support, near LOD,
            // unfaded, wind time zero, four instance yaws. UV centers/edges
            // query the actual composed graph; this is not raster interpolation.
            for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
              const inputs = inputsAt(geometry, index);
              inputs.instanceRotScaleHash[0] = yaw;
              inputs._frontFacing[0] = front ? 1 : 0;
              const viewMatrix = new THREE.Matrix4().fromArray(
                inputs._cameraViewMatrix,
              );
              const inverseView = viewMatrix.clone().invert();
              const normals: THREE.Vector3[] = [];
              const ndotl: number[] = [];
              for (const u of [0, 0.5, 1]) {
                inputs.uv[0] = u;
                const viewNormal = vector(
                  colorValue(material.normalNode, inputs),
                );
                const normal = viewNormal
                  .clone()
                  .transformDirection(inverseView);
                expect(normal.length()).toBeCloseTo(1, 12);
                const incidence = saturate(normal.dot(light));
                expect(incidence).toBeCloseTo(
                  saturate(
                    viewNormal.dot(
                      light.clone().transformDirection(viewMatrix),
                    ),
                  ),
                  12,
                );
                normals.push(normal);
                ndotl.push(incidence);
                allNdotl.push(incidence);

                const thickness = vector(
                  colorValue(material.thicknessColorNode, inputs),
                );
                const attenuation = colorValue(
                  material.thicknessAttenuationNode,
                  inputs,
                )[0];
                const scale = colorValue(
                  material.thicknessScaleNode,
                  inputs,
                )[0];
                const power = colorValue(
                  material.thicknessPowerNode,
                  inputs,
                )[0];
                const distortion = colorValue(
                  material.thicknessDistortionNode,
                  inputs,
                )[0];
                const ambient = colorValue(
                  material.thicknessAmbientNode,
                  inputs,
                )[0];
                // Installed Three MeshSSSNodeMaterial.direct algebra, unit white
                // incident light: H=normalize(L+distortion*N), then
                // RGB=(saturate(-V.H)^power*scale+ambient)*thickness*attenuation.
                // This is source-backed CPU algebra, not native model execution;
                // no IBL, shadows, Fresnel, tone mapping or exposure is simulated.
                const half = light
                  .clone()
                  .addScaledVector(normal, distortion)
                  .normalize();
                for (const [viewIndex, view] of [
                  topDownView,
                  grazingView,
                ].entries()) {
                  const factor =
                    (saturate(-view.dot(half)) ** power * scale + ambient) *
                    attenuation;
                  const added = thickness.clone().multiplyScalar(factor);
                  added.toArray().forEach((value, channel) => {
                    expect(Number.isFinite(value)).toBe(true);
                    expect(value).toBeGreaterThanOrEqual(0);
                    expect(value).toBeLessThanOrEqual(
                      thickness.getComponent(channel) *
                        (scale + ambient) *
                        attenuation +
                        1e-12,
                    );
                  });
                  sssMax[viewIndex].max(added);
                }
              }
              ndotlSpreads.push(spread(ndotl));
              normalYSpreads.push(spread(normals.map((n) => n.y)));
              edgeNormalDistances.push(normals[0].distanceTo(normals[2]));
              // A different normal is not necessarily a different illumination.
              // The clamp is 1-Lipschitz. Separate inclination and azimuth terms:
              // at exact zenith, only delta-normal.y can change direct incidence.
              for (let a = 0; a < normals.length; a++)
                for (let b = a + 1; b < normals.length; b++) {
                  const delta = normals[a].clone().sub(normals[b]);
                  const bound =
                    Math.abs(delta.y * light.y) +
                    Math.hypot(delta.x, delta.z) * Math.hypot(light.x, light.z);
                  expect(Math.abs(ndotl[a] - ndotl[b])).toBeLessThanOrEqual(
                    bound + 1e-12,
                  );
                  expect(
                    normals[a].dot(new THREE.Vector3(0, 1, 0)) -
                      normals[b].dot(new THREE.Vector3(0, 1, 0)),
                  ).toBeCloseTo(delta.y, 14);
                }
            }
            measurements.push({
              phase,
              lightWorld: light.toArray(),
              rowHeight: geometry.getAttribute("uv").getY(index),
              front,
              ndotlRange: range(allNdotl),
              crossWidthNdotlSpreadRange: range(ndotlSpreads),
              crossWidthNormalYSpreadRange: range(normalYSpreads),
              edgeNormalDistanceRange: range(edgeNormalDistances),
              topDownSssRgbMaximum: sssMax[0].toArray(),
              grazingBacklitSssRgbMaximum: sssMax[1].toArray(),
            });
          }
      }
      expect(measurements).toHaveLength(3 * (layout.bladeSegments + 1) * 2);
      // Diagnostic values intentionally are not snapshotted or constrained to
      // remain weak: subsequent shape/material work may improve this contrast.
      console.info(
        "fineLeafDirectIlluminationDiagnostic",
        JSON.stringify({
          scope:
            "CPU actual composed normals; hypothetical settled daylight; unit incident RGB; not a native capture or visual-quality approval",
          measurements,
        }),
      );
    } finally {
      owner.destroy();
    }
  });

  it("keeps zero-width and collapsed-normal results finite and the authored weight below hemisphere reversal", () => {
    const owner = fine("leaf-volume-v1");
    try {
      const material = owner["material"],
        inputs = inputsAt(owner["lodGeometries"][0], 2);
      inputs.normal = [0, 1, 0]; // Valid unit input parallel to terrain: zero width frame.
      inputs.instanceOffset = [140, 28, 0];
      inputs._frontFacing = [0];
      inputs.uv[0] = 0.5;
      const weightNode = named(
        material.normalNode,
        "fineGrassCanopyNormalWeight",
      );
      for (const t of [0, 0.1, 0.375, 0.65 - 1e-5, 0.65, 0.65 + 1e-5, 1]) {
        inputs.uv[1] = t;
        for (const u of [0, 0.5, 1]) {
          inputs.uv[0] = u;
          const result = vector(colorValue(material.normalNode, inputs));
          expect(result.toArray().every(Number.isFinite)).toBe(true);
          expect(result.length()).toBeCloseTo(1, 12);
          expect(colorValue(weightNode, inputs)[0]).toBeGreaterThanOrEqual(0.2);
          expect(colorValue(weightNode, inputs)[0]).toBeLessThanOrEqual(0.45);
          expect(result.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(
            1e-12,
          );
        }
      }
      // Exercise the earlier zero-normal fallback independently of valid source geometry.
      inputs.normal = [0, 0, 0];
      inputs.uv = [0.5, 0.65];
      expect(vector(colorValue(material.normalNode, inputs)).toArray()).toEqual(
        [0, 1, 0],
      );
      // The upper-tip mask is the real graph, not a replaced shading function.
      inputs.normal = [1, 0, 0];
      inputs.uv[0] = 1;
      const foldNode = named(material.normalNode, "fineGrassTransverseFold");
      for (const t of [0.75, 0.875, 1]) {
        inputs.uv[1] = t;
        expect(colorValue(foldNode, inputs)[0]).toBeCloseTo(
          Math.tan((24 * Math.PI) / 180) * (1 - smooth(0.75, 1, t)),
          14,
        );
      }
    } finally {
      owner.destroy();
    }
  });

  it("darkens actual albedo roots, preserves relative bank tint and shares it with SSS without changing AO or scattering coefficients", () => {
    for (const grade of [undefined, "fine-meadow-green-v1"] as const) {
      const baseline = fine(undefined, grade),
        candidate = fine("leaf-volume-v1", grade);
      try {
        const a = baseline["material"],
          b = candidate["material"];
        if (
          !(a instanceof MeshSSSNodeMaterial) ||
          !(b instanceof MeshSSSNodeMaterial)
        )
          throw new Error("Expected actual fine SSS materials");
        const inputs = inputsAt(candidate["lodGeometries"][0], 2);
        for (const position of [
          [0, 28, 0],
          [390, 25, 470],
          [450, 28, 465],
        ]) {
          inputs.instanceOffset = position;
          const bankNode = [...graph(b.colorNode)].find(
            (n) => Reflect.get(n, "name") === "v_naturalGrassBankLocality",
          );
          const locality = bankNode ? colorValue(bankNode, inputs)[0] : 0;
          for (const t of [0, 0.2, 0.5, 1]) {
            inputs.uv[1] = t;
            const before = colorValue(a.colorNode, inputs),
              after = colorValue(b.colorNode, inputs);
            const tint = inputs.instanceGroundColor.map(
              (c, i) =>
                c +
                (inputs.instanceGrassTint[i] - c) * inputs.instanceGrassTint[3],
            );
            const tip = 1.12 + (1.08 * (1.12 / 1.2) - 1.12) * locality;
            const expected = inputs.instanceGroundColor.map((c, i) =>
              Math.min(
                1,
                c * 0.55 + (tint[i] * tip - c * 0.55) * smooth(0, 1, t),
              ),
            );
            for (let i = 0; i < 3; i++)
              expect(after[i]).toBeCloseTo(expected[i], 13);
            if (t === 0)
              for (let i = 0; i < 3; i++)
                expect(after[i] / before[i]).toBeCloseTo(0.55 / 0.98, 13);
            if (t === 1)
              for (let i = 0; i < 3; i++)
                expect(after[i] / before[i]).toBeCloseTo(1.12 / 1.2, 13);
            expect(colorValue(b.thicknessColorNode, inputs)).toEqual(
              after.map((c) => c * smooth(0.05, 0.65, t)),
            );
            for (const key of [
              "aoNode",
              "thicknessAttenuationNode",
              "thicknessScaleNode",
              "thicknessPowerNode",
              "thicknessDistortionNode",
              "thicknessAmbientNode",
            ] as const)
              expect(colorValue(b[key], inputs)).toEqual(
                colorValue(a[key], inputs),
              );
          }
        }
      } finally {
        baseline.destroy();
        candidate.destroy();
      }
    }
  });

  it.each([0, 1, 2])(
    "limits the historical .78 root change to its exact RGB contribution at LOD%i, including soil and bank tips",
    (lod) => {
      // The historical default sculpt fixture has no coastal meadow. Admit
      // the current authored descriptor through the real terrain profile path;
      // the manager must derive its bank macro field, not receive an injected one.
      const terrain = validateWorldTerrainProfile({
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
      const field = validateCompactHabitatComposition(
        habitatData.composition,
        habitatData.bounds,
      );
      // Historical installed dirt mean, independently verified by the terrain
      // material tests. Keep every channel distinct so a scalar tint shortcut fails.
      const dirt = [
        0.1258525186051025, 0.08567628015146961, 0.0490416307568836,
      ];
      for (const grade of [undefined, "fine-meadow-green-v1"] as const) {
        for (const habitat of [undefined, field]) {
          const owner = manager(
            FINE_MEADOW_GRASS_VISUAL_PROFILE,
            terrain,
            true,
            "fine-meadow-v1",
            habitat,
            "leaf-volume-v1",
            grade,
          );
          try {
            expect(owner["compactMacroField"]?.coastalMeadow).toBe(true);
            expect(owner["compactMacroField"]?.bankVerge).toMatchObject({
              minX: 340,
              maxX: 357,
              minZ: 310,
              maxZ: 324,
              feather: 2,
              tipBrightness: 1.08,
            });
            const material = owner["material"];
            if (!(material instanceof MeshSSSNodeMaterial))
              throw new Error("Expected actual fine SSS material");
            const inputs = inputsAt(owner["lodGeometries"][lod], 2);
            // SSS wraps the albedo Fn beneath its clamp/VarNode. Expand the
            // real nested construction-time Fn too; getChildren alone cannot
            // expose the habitat/bank nodes captured by its JavaScript closure.
            const nodes = new Set<Node>();
            const visit = (node: Node): void => {
              if (nodes.has(node)) return;
              expect(nodes.size).toBeLessThan(4096);
              nodes.add(node);
              const expanded = expand(node);
              if (expanded !== node) visit(expanded);
              for (const child of node.getChildren()) visit(child);
            };
            visit(requireNode(material.colorNode));
            const soilNode = [...nodes].find(
              (node) =>
                Reflect.get(node, "name") === "v_naturalGrassHabitatSoil",
            );
            const bankNode = [...nodes].find(
              (node) =>
                Reflect.get(node, "name") === "v_naturalGrassBankLocality",
            );
            expect(Boolean(soilNode)).toBe(Boolean(habitat));
            expect(Boolean(bankNode)).toBe(Boolean(grade));
            for (const [x, z, bankWeight] of [
              [0, 0, 0],
              [318.5, 312.5, 0], // Inside the real Haven soil pocket.
              [340, 317, 0], // Exact current bank-verge boundary.
              [341, 317, 0.5], // Halfway through its two-metre feather.
              [346, 317, 1], // Current bank-verge interior.
            ]) {
              inputs.instanceOffset = [x, 28, z];
              const locality = bankNode ? colorValue(bankNode, inputs)[0] : 0;
              expect(locality).toBeCloseTo(grade ? bankWeight : 0, 13);
              const soil = soilNode ? colorValue(soilNode, inputs)[0] : 0;
              if (habitat && x === 318.5) expect(soil).toBeGreaterThan(0.1);
              const rootGround = inputs.instanceGroundColor.map(
                (value, i) => value + (dirt[i] - value) * soil,
              );
              const tinted = inputs.instanceGroundColor.map(
                (value, i) =>
                  value +
                  (inputs.instanceGrassTint[i] - value) *
                    inputs.instanceGrassTint[3],
              );
              const tip = 1.12 + (1.08 * (1.12 / 1.2) - 1.12) * locality;
              for (const t of [0, 0.2, 0.5, 0.75, 1]) {
                inputs.uv[1] = t;
                const blend = smooth(0, 1, t);
                const actual = colorValue(material.colorNode, inputs);
                const historical = rootGround.map(
                  (root, i) =>
                    root * 0.78 + (tinted[i] * tip - root * 0.78) * blend,
                );
                for (let channel = 0; channel < 3; channel++) {
                  // These real-color samples stay below the albedo clamp;
                  // the exact difference therefore isolates this one coefficient.
                  expect(historical[channel]).toBeGreaterThan(0);
                  expect(historical[channel]).toBeLessThan(1);
                  expect(actual[channel]).toBeGreaterThan(0);
                  expect(actual[channel]).toBeLessThan(1);
                  expect(actual[channel] - historical[channel]).toBeCloseTo(
                    rootGround[channel] * (0.55 - 0.78) * (1 - blend),
                    13,
                  );
                  if (t === 1)
                    expect(actual[channel]).toBeCloseTo(
                      tinted[channel] * tip,
                      13,
                    );
                }
                expect(colorValue(material.thicknessColorNode, inputs)).toEqual(
                  actual.map((value) => value * smooth(0.05, 0.65, t)),
                );
              }
            }
          } finally {
            owner.destroy();
          }
        }
      }
    },
  );

  it("retains the new nodes and immutable receipt through real grounded owners", async () => {
    const owner = fine("leaf-volume-v1");
    try {
      for (let lod = 0; lod < 3; lod++) {
        const geometry = owner["lodGeometries"][lod].clone();
        const layout = getGrassBladeLayout(
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        const clone = createGroundedGrassMaterial(
          owner["material"],
          geometry,
          new Float32Array(layout.bladesPerClump * layout.rootComponents),
          1,
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        try {
          for (const key of ["normalNode", "colorNode", "aoNode"] as const)
            expect(clone[key]).toBe(owner["material"][key]);
          expect(clone.userData.fineGrassCanopyLighting).toEqual(
            FINE_GRASS_LEAF_VOLUME_LIGHTING,
          );
        } finally {
          clone.dispose();
          geometry.dispose();
        }
      }
      let inspected = false;
      await owner.precompileRepresentativeChunk(async (object) => {
        if (
          !(object instanceof THREE.InstancedMesh) ||
          !(object.material instanceof MeshSSSNodeMaterial)
        )
          throw new Error("Expected real grounded fine owner");
        expect(object.material.normalNode).toBe(owner["material"].normalNode);
        expect(
          Object.getOwnPropertyDescriptor(
            object.material.userData,
            "fineGrassCanopyLighting",
          ),
        ).toEqual({
          value: FINE_GRASS_LEAF_VOLUME_LIGHTING,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        expect(
          Object.isFrozen(object.material.userData.fineGrassCanopyLighting),
        ).toBe(true);
        inspected = true;
      });
      expect(inspected).toBe(true);
    } finally {
      owner.destroy();
    }
  });
});

describe("Haven habitat grass root integration (actual graph and geometry, CPU only)", () => {
  const field = validateCompactHabitatComposition(
    habitatData.composition,
    habitatData.bounds,
  );
  const natural = (
    habitat?: ConstructorParameters<typeof GrassVisualManager>[14],
  ) =>
    manager(
      DENSE_MEADOW_GRASS_VISUAL_PROFILE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      true,
      "natural-tuft-v1",
      habitat,
    );
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
        const t = Math.max(0, Math.min(1, distance / pocket.edgeWidth));
        return pocket.strength * t * t * (3 - 2 * t);
      }),
    );

  it("blends roots toward the hash-locked dirt mean at actual world-space roots while leaving tips unchanged", () => {
    const owner = natural(field),
      baseline = natural();
    try {
      const material = owner["material"],
        original = baseline["material"];
      // Independent decoded mean of the installed Poly Haven Dirt diffuse.
      // CompactTerrainMaterial.test verifies all pixels against its source hash.
      const dirt = [
        0.1258525186051025, 0.08567628015146961, 0.0490416307568836,
      ];
      const ground = [0.2, 0.4, 0.1],
        tip = [0.23, 0.415, 0.13];
      for (const [x, z] of [
        [299, 330],
        [306, 306],
        [318.5, 312.5],
        [316, 332],
        [318.5, 344.5],
        [326.8, 331.6],
      ]) {
        const weight = expectedSoil(x, z);
        // Identical world root through a translated/rotated parent and local
        // offset proves the graph does not classify only the chunk origin.
        for (const matrix of [
          new THREE.Matrix4(),
          new THREE.Matrix4().makeRotationY(0.71).setPosition(280, 17, 295),
        ]) {
          const local = new THREE.Vector3(x, 17, z).applyMatrix4(
            matrix.clone().invert(),
          );
          for (const height of [0, 0.25, 0.5, 1]) {
            const attrs = {
              instanceOffset: local.toArray(),
              instanceGroundColor: ground,
              instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
              uv: [0.5, height],
              _modelWorldMatrix: matrix.toArray(),
            };
            const actual = colorValue(expand(material.colorNode!), attrs);
            const old = colorValue(expand(original.colorNode!), attrs);
            const t = height * height * (3 - 2 * height);
            const expected = ground.map((value, i) => {
              const root = (value + (dirt[i] - value) * weight) * 0.64;
              return root + (tip[i] - root) * t;
            });
            actual.forEach((value, i) =>
              expect(value).toBeCloseTo(expected[i], 12),
            );
            if (height === 1 || weight === 0)
              actual.forEach((value, i) =>
                expect(value).toBeCloseTo(old[i], 12),
              );
            if (height === 0 && weight > 0.1) expect(actual).not.toEqual(old);
          }
        }
      }
      const nodes = graph(material.colorNode!);
      const varyings = [...nodes].filter((n) => n.type === "VaryingNode");
      expect(varyings.map((n) => Reflect.get(n, "name"))).toEqual([
        "v_naturalGrassHabitatSoil",
      ]);
      // Three's actual CPU type resolver; no renderer/device is fabricated.
      // The installed JavaScript class is constructible for this CPU type
      // query although its declarations mark the base builder abstract. Keep
      // the exact historical constructor/arguments and verify the real owner;
      // no renderer or backend is fabricated or compiled.
      const builder: unknown = Reflect.construct(THREE.NodeBuilder, [
        null,
        null,
      ]);
      if (!(builder instanceof THREE.NodeBuilder))
        throw new Error("Expected installed Three CPU node builder");
      expect(varyings[0].getNodeType(builder)).toBe("float");
      expect(
        [...graph(original.colorNode!)].filter((n) => n.type === "VaryingNode"),
      ).toHaveLength(0);
      expect(
        [...nodes]
          .filter((n) => n.type === "AttributeNode")
          .map((n) => Reflect.get(n, "_attributeName"))
          .sort(),
      ).toEqual([
        "instanceGrassTint",
        "instanceGroundColor",
        "instanceOffset",
        "uv",
      ]);
      expect(
        [...nodes].some((n) => Reflect.get(n, "isTextureNode") === true),
      ).toBe(false);
      expect(material.name).toBe(original.name);
    } finally {
      owner.destroy();
      baseline.destroy();
    }
  });

  it("keeps every geometry byte and the complete position/normal graph unchanged, and requires the natural appearance", () => {
    // Canonical traversal preserves shared-node edges while omitting per-owner
    // UUIDs/IDs. Constants, operations and uniform initial values remain exact.
    const signature = (root: unknown) => {
      const nodes = [...graph(root)],
        ids = new Map(nodes.map((node, i) => [node, i]));
      return nodes.map((node) => {
        const fields: Record<string, unknown> = { type: node.type };
        for (const key of [
          "nodeType",
          "op",
          "method",
          "_attributeName",
          "name",
          "components",
          "scope",
        ])
          fields[key] = Reflect.get(node, key);
        const value: unknown = Reflect.get(node, "value");
        if (
          typeof value === "number" ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          value === null
        )
          fields.value = value;
        else if (numericValue(value)) fields.value = numericValue(value);
        fields.children = [...node.getChildren()].map((child) =>
          ids.get(child),
        );
        return fields;
      });
    };
    const baseline = natural(),
      candidate = natural(field);
    try {
      for (let lod = 0; lod < 3; lod++) {
        const a = baseline["lodGeometries"][lod],
          b = candidate["lodGeometries"][lod];
        expect(Object.keys(b.attributes)).toEqual(Object.keys(a.attributes));
        expect(geometryBytes(b)).toBe(geometryBytes(a));
        for (const [aa, ba] of [
          [a.index!, b.index!],
          ...Object.keys(a.attributes).map((key) => [
            a.attributes[key],
            b.attributes[key],
          ]),
        ]) {
          expect(ba.itemSize).toBe(aa.itemSize);
          expect(ba.normalized).toBe(aa.normalized);
          expect(ba.array.constructor).toBe(aa.array.constructor);
          expect(
            new Uint8Array(
              ba.array.buffer,
              ba.array.byteOffset,
              ba.array.byteLength,
            ),
          ).toEqual(
            new Uint8Array(
              aa.array.buffer,
              aa.array.byteOffset,
              aa.array.byteLength,
            ),
          );
        }
      }
      for (const key of ["positionNode", "normalNode"] as const) {
        expect(signature(candidate["material"][key]!)).toEqual(
          signature(baseline["material"][key]!),
        );
        expect(
          [...graph(candidate["material"][key]!)].some(
            (n) => Reflect.get(n, "name") === "v_naturalGrassHabitatSoil",
          ),
        ).toBe(false);
      }
      expect(candidate.getProfileReceipt()).toEqual(
        baseline.getProfileReceipt(),
      );
      for (const profile of [
        {},
        STREAMING_GRASS_VISUAL_PROFILE,
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
      ])
        expect(() =>
          manager(
            profile,
            SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
            true,
            undefined,
            field,
          ),
        ).toThrow(
          "Habitat grass requires the explicit natural tuft appearance",
        );
    } finally {
      candidate.destroy();
      baseline.destroy();
    }
  });
});

// Generated from the actual constructor at pushed checkpoint 2bc7c5a898984090.
// Position/normal/UV/index bytes in that order; no GPU or rendering assertion.
const legacyGeometryHashes = [
  "30d43cae657ad1a55190ed6e23dda8cc7973ee4bb684a248e9d39ee851f5a109",
  "06e6a222140aa84141061eb5775b6dc46a84a8a739b69d8ee00450de8b695b2d",
  "b6d82f6b4b98e0d3a5a40813c6a5f8bac7ff94559df4e77f058a1aba4ae4a26c",
];

describe("compact meadow appearance candidate (CPU only)", () => {
  it("leaves ordinary and fixed-arena geometry/material behavior identical", () => {
    const ordinary = manager();
    const fixed = manager(STREAMING_GRASS_VISUAL_PROFILE);
    try {
      for (let lod = 0; lod < GRASS_CONFIG.LOD_TIERS.length; lod++) {
        const a = ordinary["lodGeometries"][lod];
        const b = fixed["lodGeometries"][lod];
        const hash = createHash("sha256");
        for (const attribute of [
          a.attributes.position,
          a.attributes.normal,
          a.attributes.uv,
          a.index!,
        ]) {
          const values = attribute.array;
          hash.update(
            new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
          );
        }
        expect(hash.digest("hex")).toBe(legacyGeometryHashes[lod]);
        expect(b.index!.array).toEqual(a.index!.array);
        for (const key of Object.keys(a.attributes))
          expect(b.attributes[key].array).toEqual(a.attributes[key].array);
      }
      expect(ordinary["material"].name).toBe("legacy-blades-v1");
      expect(fixed["material"].name).toBe("legacy-blades-v1");
    } finally {
      ordinary.destroy();
      fixed.destroy();
    }
  });

  it("preserves topology, buffer bytes, deterministic blade roots and UVs at every LOD", () => {
    const baseline = manager();
    const candidate = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    const repeat = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    try {
      for (const [lod, tier] of GRASS_CONFIG.LOD_TIERS.entries()) {
        const before = baseline["lodGeometries"][lod];
        const after = candidate["lodGeometries"][lod];
        expect(after.index!.array).toEqual(before.index!.array);
        expect(after.attributes.uv.array).toEqual(before.attributes.uv.array);
        expect(after.attributes.normal.array).toEqual(
          before.attributes.normal.array,
        );
        expect(Object.keys(after.attributes)).toEqual(
          Object.keys(before.attributes),
        );
        expect(geometryBytes(after)).toBe(geometryBytes(before));
        expect(after.attributes.position.array).toEqual(
          repeat["lodGeometries"][lod].attributes.position.array,
        );
        const oldPosition = before.attributes.position;
        const newPosition = after.attributes.position;
        const vertsPerBlade = tier.bladeSegments * 2 + 1;
        for (let blade = 0; blade < tier.bladesPerClump; blade++) {
          const root = blade * vertsPerBlade;
          for (const get of ["getX", "getZ"] as const) {
            const oldCenter =
              (oldPosition[get](root) + oldPosition[get](root + 1)) / 2;
            const newCenter =
              (newPosition[get](root) + newPosition[get](root + 1)) / 2;
            expect(Math.abs(oldCenter - newCenter)).toBeLessThan(6e-8);
          }
          expect(newPosition.getY(root)).toBe(0);
          expect(newPosition.getY(root + 1)).toBe(0);
          const tip = root + vertsPerBlade - 1;
          const height = newPosition.getY(tip);
          expect(height).toBeGreaterThan(0.2);
          expect(height).toBeLessThan(0.73);
          expect(height).toBeLessThan(oldPosition.getY(tip));
          const width = Math.hypot(
            newPosition.getX(root + 1) - newPosition.getX(root),
            newPosition.getZ(root + 1) - newPosition.getZ(root),
          );
          expect(width / height).toBeCloseTo(
            COMPACT_MEADOW_APPEARANCE.BLADE_WIDTH_RATIO,
            6,
          );
        }
        for (const value of newPosition.array)
          expect(Number.isFinite(value)).toBe(true);
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        for (let index = 0; index < after.index!.count; index += 3) {
          a.fromBufferAttribute(newPosition, after.index!.getX(index));
          b.fromBufferAttribute(newPosition, after.index!.getX(index + 1));
          c.fromBufferAttribute(newPosition, after.index!.getX(index + 2));
          expect(b.sub(a).cross(c.sub(a)).length()).toBeGreaterThan(1e-5);
        }
      }
      expect(candidate["lodGeometries"][1].attributes.position.count).toBe(60);
      expect(candidate["lodGeometries"][1].index!.count / 3).toBe(36);
    } finally {
      baseline.destroy();
      candidate.destroy();
      repeat.destroy();
    }
  });

  it.each([
    COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
    DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  ])(
    "uses one opaque PBR material without adding texture inputs for $id",
    (profile) => {
      const owner = manager(profile);
      try {
        const material = owner["material"];
        expect(material.name).toBe(
          profile.id === "compact-meadow-v2"
            ? CURVED_MEADOW_APPEARANCE.id
            : COMPACT_MEADOW_APPEARANCE.id,
        );
        expect(material.transparent).toBe(false);
        expect(material.depthWrite).toBe(true);
        expect(material.side).toBe(THREE.DoubleSide);
        expect(material.roughness).toBe(1);
        expect(material.metalness).toBe(0);
        expect(material.fog).toBe(false);
        expect(material.map).toBeNull();
        expect(material.normalMap).toBeNull();
        expect(material.alphaMap).toBeNull();
        expect(material.emissive.getHex()).toBe(0);
        expect(material.positionNode).toBeTruthy();
        expect(material.colorNode).toBeTruthy();
        expect(owner["maxRenderDistance"]).toBe(140);
        expect(owner["minimumLodLevel"]).toBe(1);
        expect(owner["clumpSpacing"]).toBe(
          profile.id === "compact-meadow-v2" ? 1.75 : 2.8,
        );
        expect(owner["maxChunksPerFrame"]).toBe(1);
        expect(owner.getProfileReceipt()).toMatchObject({
          profileId: profile.id,
          grounding: { mode: "blade-roots-v1", failedChunks: 0 },
        });
      } finally {
        owner.destroy();
      }
    },
  );

  it("builds the dense blade curve and its smooth unit normals without extra geometry or buffers", () => {
    const baseline = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    const curved = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    const repeat = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    try {
      const style = CURVED_MEADOW_APPEARANCE;
      for (const [lod, tier] of GRASS_CONFIG.LOD_TIERS.entries()) {
        const geometry = curved["lodGeometries"][lod];
        const previous = baseline["lodGeometries"][lod];
        const position = geometry.attributes.position,
          normal = geometry.attributes.normal;
        expect(geometryBytes(geometry)).toBe(geometryBytes(previous));
        expect(geometry.index!.array).toEqual(previous.index!.array);
        expect(geometry.attributes.uv.array).toEqual(
          previous.attributes.uv.array,
        );
        expect(Object.keys(geometry.attributes)).toEqual(
          Object.keys(previous.attributes),
        );
        expect(position.array).toEqual(
          repeat["lodGeometries"][lod].attributes.position.array,
        );
        expect(normal.array).toEqual(
          repeat["lodGeometries"][lod].attributes.normal.array,
        );
        const vertices = tier.bladeSegments * 2 + 1;
        for (let blade = 0; blade < tier.bladesPerClump; blade++) {
          const root = blade * vertices,
            tip = root + vertices - 1;
          const left = new THREE.Vector3().fromBufferAttribute(position, root);
          const right = new THREE.Vector3().fromBufferAttribute(
            position,
            root + 1,
          );
          const center = left.clone().add(right).multiplyScalar(0.5);
          const widthAxis = right.clone().sub(left).normalize();
          const end = new THREE.Vector3().fromBufferAttribute(position, tip);
          const h = end.y / style.BLADE_TIP_HEIGHT;
          const control = new THREE.Vector3(
            center.x,
            h * style.BLADE_CONTROL_HEIGHT,
            center.z,
          );
          expect(left.y).toBe(0);
          expect(right.y).toBe(0);
          expect(end.y).toBeGreaterThan(0.15);
          expect(end.y).toBeLessThan(0.45);
          expect(end.y).toBeLessThan(previous.attributes.position.getY(tip));
          expect(left.distanceTo(right) / h).toBeCloseTo(
            style.BLADE_WIDTH_RATIO,
            5,
          );
          for (const axis of ["x", "z"] as const) {
            const read = axis === "x" ? "getX" : "getZ";
            expect(center[axis]).toBeCloseTo(
              (previous.attributes.position[read](root) +
                previous.attributes.position[read](root + 1)) /
                2,
              6,
            );
          }
          for (let v = 0; v < vertices; v++) {
            const index = root + v,
              t = geometry.attributes.uv.getY(index);
            const expectedCenter = center
              .clone()
              .multiplyScalar((1 - t) ** 2)
              .addScaledVector(control, 2 * (1 - t) * t)
              .addScaledVector(end, t * t);
            expect(position.getY(index)).toBeCloseTo(expectedCenter.y, 6);
            const tangent = control
              .clone()
              .sub(center)
              .multiplyScalar(2 * (1 - t))
              .addScaledVector(end.clone().sub(control), 2 * t);
            const expectedNormal = widthAxis.clone().cross(tangent).normalize();
            const n = new THREE.Vector3().fromBufferAttribute(normal, index);
            expect(n.length()).toBeCloseTo(1, 6);
            expect(n.dot(tangent.clone().normalize())).toBeCloseTo(0, 5);
            expect(n.distanceTo(expectedNormal)).toBeLessThan(4e-5);
          }
          if (tier.bladeSegments > 1)
            expect(position.getY(root + 2)).toBeGreaterThan(
              end.y / tier.bladeSegments,
            );
          expect(Math.abs(normal.getY(tip))).toBeGreaterThan(0.01);
        }
      }
      const nodes = graph(curved["material"].normalNode!);
      for (const name of [
        "normal",
        "instanceGroundNormal",
        "instanceRotScaleHash",
      ])
        expect(
          [...nodes].some((n) => Reflect.get(n, "_attributeName") === name),
        ).toBe(true);
      expect([...nodes].some((n) => n.type === "FrontFacingNode")).toBe(true);
      expect(
        [...nodes].some(
          (n) =>
            n.type === "VaryingNode" &&
            Reflect.get(n, "name") === "v_curvedGrassNormal",
        ),
      ).toBe(true);
    } finally {
      baseline.destroy();
      curved.destroy();
      repeat.destroy();
    }
  });

  it.each([
    ["ordinary", {}],
    ["fixed-arena", STREAMING_GRASS_VISUAL_PROFILE],
    ["compact-meadow", COMPACT_ISLAND_GRASS_VISUAL_PROFILE],
    ["curved-meadow", DENSE_MEADOW_GRASS_VISUAL_PROFILE],
  ] as const)(
    "keeps %s compact albedo independent of sun/view shading",
    (_, profile) => {
      const owner = manager(profile);
      try {
        const material = owner["material"];
        const albedo = graph(material.colorNode!);
        expect(albedo.has(owner.shadeUniforms.tint)).toBe(false);
        expect(albedo.has(owner.shadeUniforms.strength)).toBe(false);
        expect(albedo.has(owner["sunDirUniform"]!)).toBe(false);
        expect(
          [...albedo]
            .filter((n) => n.type === "AttributeNode")
            .map((n) => Reflect.get(n, "_attributeName"))
            .sort(),
        ).toEqual(["instanceGrassTint", "instanceGroundColor", "uv"]);
        const normals = graph(material.normalNode!);
        expect(normals.has(cameraViewMatrix)).toBe(true);
        expect(
          [...normals].some(
            (n) => Reflect.get(n, "_attributeName") === "instanceGroundNormal",
          ),
        ).toBe(true);
        expect(graph(material.outputNode!).has(output)).toBe(true);
        expect(material.vertexColors).toBe(false);
        expect(material.envMap).toBeNull();
        expect(material.envNode).toBeNull();
        expect(material.lights).toBe(true);
      } finally {
        owner.destroy();
      }
    },
  );

  it.each([
    ["ordinary", {}],
    ["fixed-arena", STREAMING_GRASS_VISUAL_PROFILE],
  ] as const)(
    "retains %s legacy shade graph and no-owner fallback",
    (_, profile) => {
      for (const withWorkerSetup of [true, false]) {
        const owner = manager(
          profile,
          withWorkerSetup
            ? COMPACT_WORLD_TERRAIN_PROFILE
            : SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          withWorkerSetup,
        );
        try {
          const albedo = graph(owner["material"].colorNode!);
          expect(albedo.has(owner.shadeUniforms.tint)).toBe(true);
          expect(albedo.has(owner.shadeUniforms.strength)).toBe(true);
          expect(albedo.has(owner["sunDirUniform"]!)).toBe(true);
          expect(
            [...albedo].some(
              (n) =>
                Reflect.get(n, "_attributeName") === "instanceGroundNormal",
            ),
          ).toBe(true);
        } finally {
          owner.destroy();
        }
      }
    },
  );

  it("matches actual curved-normal node arithmetic to independent quaternion yaw/tilt and camera transforms", () => {
    const owner = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    try {
      const normalNode = owner["material"].normalNode!;
      const normals = owner["lodGeometries"][1].attributes.normal;
      const up = new THREE.Vector3(0, 1, 0);
      for (const ground of [
        up,
        new THREE.Vector3(0.3, 0.8, -0.2).normalize(),
        new THREE.Vector3(-0.6, 0.7, 0.4).normalize(),
      ])
        for (const rotation of [0, 0.7, 2.8, 5.4])
          for (const view of [
            [0, 60, 5],
            [30, 2, -60],
            [-50, 14, 20],
          ] as const)
            for (const front of [false, true])
              for (const index of [0, 2, 4]) {
                const camera = new THREE.PerspectiveCamera(
                  52,
                  16 / 9,
                  0.2,
                  1000,
                );
                camera.position.set(view[0], view[1], view[2]);
                camera.lookAt(0, 0, 0);
                camera.updateMatrixWorld(true);
                const normal = new THREE.Vector3().fromBufferAttribute(
                  normals,
                  index,
                );
                const turned = normal
                  .clone()
                  .applyQuaternion(
                    new THREE.Quaternion().setFromAxisAngle(up, -rotation),
                  )
                  .applyQuaternion(
                    new THREE.Quaternion().setFromUnitVectors(up, ground),
                  );
                const expected = ground
                  .clone()
                  .lerp(
                    turned.normalize().multiplyScalar(front ? 1 : -1),
                    CURVED_MEADOW_APPEARANCE.BLADE_NORMAL_WEIGHT,
                  )
                  .normalize()
                  .transformDirection(camera.matrixWorldInverse);
                const actual = new THREE.Vector3(
                  ...(colorValue(normalNode, {
                    normal: normal.toArray(),
                    instanceRotScaleHash: [rotation, 1, 0.3],
                    instanceGroundNormal: ground.toArray(),
                    _cameraViewMatrix: camera.matrixWorldInverse.toArray(),
                    _frontFacing: [front ? 1 : 0],
                  }) as [number, number, number]),
                );
                expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
              }
    } finally {
      owner.destroy();
    }
  });

  it("preserves actual compact root/middle/tip albedo arithmetic", () => {
    const owner = manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
    try {
      const albedo = expand(owner["material"].colorNode!);
      for (const [height, expected] of [
        [0, [0.144, 0.288, 0.072]],
        [0.5, [0.1893, 0.35565, 0.1023]],
        [1, [0.2346, 0.4233, 0.1326]],
      ] as const) {
        const actual = colorValue(albedo, {
          instanceGroundColor: [0.2, 0.4, 0.1],
          instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
          uv: [0.5, height],
        });
        actual.forEach((value, i) =>
          expect(value).toBeCloseTo(expected[i], 12),
        );
      }
    } finally {
      owner.destroy();
    }
  });
});

// Actual native03 source templates; no external artifact or Git dependency at test time.
// Report SHA256: 0bf76034f5c3a12bd044b9b8b4a8564774f617e1ff72f206e39edab4953a971c.
// Archived generator SHA256: 3424ee573ac30799fe79cd4b4a3ded2876745a2bfbe4f07be8135c42aab0ecfe.
const historicalFineTemplates = [
  {
    lod: 0,
    positionBase64:
      "xUT/PgAAAACZ6XM8g/YFPwAAAAAJzdY8ao4EP18tiT75jjc8gRcJP18tiT5jUZ48d4cRPzUp6z5Pdki7hUUUPzUp6z57zPI6DQcnP8H5Ej9ol928Md5gvgAAAABHhY8+JxF6vgAAAADerYc+IJl5vn80kj7RQYw+KNSFvn80kj4so4Y+FFOeviKj+j41sIQ+ycijviKj+j5VSoE+jfTVvvWlHD/Jc3A+0h3LPAAAAAApfRq/tplqPQAAAABv7Bu/yMHSPIFCpj7spyC/s7lIPYFCpj4iryG/rUmePCWCDj8jwDK/p8sIPSWCDj9KXzO/plQDPK4iMj9c4VC/Oh43PgAAAACtTjg+hq45PgAAAAAK91M+Sl1CPtnSiD7x80s+ozNEPtnSiD40xl8+iGBjPgeO6j6jDX8+7XxkPgeO6j7mhIU+liyNPsSYEj9l16k+XF4LvwAAAAD0OQq+2LMRvwAAAABJZSC+N8IQv5bVpT7bGhi+R0wVv5bVpT4t/ie+WyIfv8okDj+LdTu+AOEhv8okDj/bEEW+Zvg2v/ytMT+s83W+dXTAPgAAAABg0Fq+ZKXPPgAAAAA002q+UYnGPrcrqT6vj3S+Y2zRPrcrqT6XBIC+CHrUPuYAET8jop6+PA/bPuYAET83GqK+RGrrPiBBNT/GENu+84E9vgAAAACWsiA/hDJcvgAAAABQTSQ/mOU9vr8Gpz7unyY/IuRTvr8Gpz43NSk/f142vlsqDz+EYjc/AqtDvlsqDz9e8jg/6DkpvvH0Mj+OP1M/DuukvQAAAAAcC1G+XzmBvQAAAACnrES+z4KhvevsVT7idGG+I+6HvevsVT6Wl1i+FWehvVxdtz6uGYu+a++RvVxdtz6da4i+jOqhvbI05T6HLLe+QWUBPwAAAABgJy0+Gpf+PgAAAABFL0o+FBAGPzTflD7gdDU+uY4EPzTflD4QQ0o+5agUP341/z6qI0Y+5L8TP341/z4muFI+YQctP2+BHz8iYWE+x6q9vgAAAAB3iyM+7VbIvgAAAAA2cw0+U6HJvmRUlz7b4yQ+XUfRvmRUlz41DhU+3H7qvg22AT+hLy8+yh7vvg22AT+VnCU+JYgQv5AjIj+QxkA+1y9gPgAAAAAedRe/FKN5PgAAAAAj/BG/nxpwPh5cpT4jmxu/8SuBPh5cpT4arxe/f1KMPqy8DT8jmim/ItaRPqy8DT8LOye/y9utPtcrMT8LCUG/naTgPQAAAACoFpI+Jk7vPQAAAABocJ4+dd3kPRTYfT7o7Zw+fV/vPRTYfT7Ux6U+emDtPaSU2T7W87k+ArvzPaSU2T7tTb8+Mkf7Peb8Bz+RFeo+wfUIvwAAAABG3n2+7I4BvwAAAABAY3S+c2sJv6oimT5UsIq+fR0Ev6oimT6lSoe+Z+UMv0hCAz+7S6++T7AJv0hCAz/gPa2+gNUSv9sSJD9UZuy+qXr4PgAAAAAomKG9Wuz2PgAAAAACqEq9zh0CPws5lT6aNYu9E48BPws5lT6FCUC9p/cTP4HP/z6BQjK9WqETP4HP/z7hDvy88LsxP7HhHz/Yv1q7HEnWvgAAAADh0RA/HgvNvgAAAABvDgg/Ui3mvmI1wz4ODBA/sI3fvmI1wz5AxAk/KDwMv1RSJz83NhA/hjsKv1RSJz8Oagw/UTw2v+kmUT8cqBA/xs2FugAAAADsNiy+EMqaPAAAAABQUiK+sr+Eu4hPXz49Gzu+FHonPIhPXz40BDS+E+OZvL5ovz7DlWq+JWAmvL5ovz5MTGa+5Rwzve5C7z5F9Jy+6FrWPgAAAAC+oZ0+iGPJPgAAAAAZEaY+rcrbPq1kmD7Krag+y3/SPq1kmD5Tua4+esbvPm+fAj8bbsc+FSjqPm+fAj/UFcs+raoIP0tHIz+mhPo+z3rFvgAAAAAvf1y8IgfSvgAAAAABd6a8IPjPvotggD6AP928SvbYvotggD6sxAK96uHrvjcT3D5qlIa97FHxvjcT3D58q4y9jRQNvwKMCT+tNQW+Ohj2PgAAAACXdN2+O+H3PgAAAACLisy+BzMBP++Ppz56g+C+ydYBP++Ppz5GZNS+BmcTP/GfDz/7eu6+C8oTP/GfDz+hJue+P7kxP+2HMz8tCwO/3cVPvQAAAAB3Z5c+c9xwvQAAAAAu4KI+LpB1vTxGcD7X56A+YqOGvTxGcD58IKk+kMeuvQ/zzT7lKLo+2/K1vQ/zzT54Ib8+gI8Cvum3AD/hBuQ+QsbCvgAAAAAkROW+oSqyvgAAAAACzuK+jBXHvvJnpT7Ghey+jS67vvJnpT4uwuq+DbjYvtDGDT+cfgG/roXRvtDGDT8V9gC/5G72voQ4MT+bPRS/X1TnPgAAAACypc88pifnPgAAAADTgFQ9QaTtPhXZhT6JEzI9NITtPhXZhT6e9n89SlAAPyV05T5ZBbk9mUYAPyV05T5xkdA9/SIQP5doDz+/9ys+hiUFvwAAAADpZsQ+zNcNvwAAAACe5Ms+O6wLv3GRuj7MSNI+uucRv3GRuj4np9c+kskcv2HqHz8cz/k+So4gv2HqHz8dDv0+hCQ5v/nkRz/WxB0/ZHSJPQAAAAAS0HW+lza8PQAAAADwtGm+0PBsPcWCij4/7IG+6tiaPcWCij5yK3u+Bou8PHdy7T7rr5i+J0MKPXdy7T5xEJa+/HsRvYpnFD/Xvr6+",
    hashes: {
      position:
        "55443fb17c48988d4a0304508144b23e6b1c59728603f044eb1352a3b67b325f",
      normal:
        "b5716344a1c6bd41ac0f7950765de27a25744d5011d4644ce4c365c18253d8d5",
      uv: "d5d2ad2bb12d03180c5bd3557b9efb12d240b66a706c3349d523f6f64a980fe8",
      index: "1565b487db6e8caa6fe2c23707dfac0e7feb2b0b46ac9822d69a0c356c6c7f43",
    },
  },
  {
    lod: 1,
    positionBase64:
      "xUT/PgAAAACZ6XM8g/YFPwAAAAAJzdY8UAkKP3sRvz7gxbA74qwNP3sRvz5oKEM8DQcnP8H5Ej9ol928Md5gvgAAAABHhY8+JxF6vgAAAADerYc+sOqKvoykyz7IAok+VymSvoykyz6FgIQ+jfTVvvWlHD/Jc3A+0h3LPAAAAAApfRq/tplqPQAAAABv7Bu/PQnAPHyT5z5ZNii/boQsPXyT5z6ICSm/plQDPK4iMj9c4VC/Oh43PgAAAACtTjg+hq45PgAAAAAK91M+YyZQPmWTvj49kmE+wp9RPmWTvj5yeXE+liyNPsSYEj9l16k+XF4LvwAAAAD0OQq+2LMRvwAAAABJZSC+wNIWv8j75j76GCe+Gncav8j75j5L2DO+Zvg2v/ytMT+s83W+dXTAPgAAAABg0Fq+ZKXPPgAAAAA002q+MYbMPnah6z6phYm+VELVPnah6z4SII6+RGrrPiBBNT/GENu+84E9vgAAAACWsiA/hDJcvgAAAABQTSQ/Yx87vtOk6D6Rpi0/6sRMvtOk6D4juS8/6DkpvvH0Mj+OP1M/DuukvQAAAAAcC1G+XzmBvQAAAACnrES+YQuhvdr7lD6ISXe+NoWMvdr7lD7SLHC+jOqhvbI05T6HLLe+QWUBPwAAAABgJy0+Gpf+PgAAAABFL0o+vR4MP3Zbzz4bwDw+j+kKP3Zbzz5ycU0+YQctP2+BHz8iYWE+x6q9vgAAAAB3iyM+7VbIvgAAAAA2cw0+OHPXvtXH0j5S6yg+NJbdvtXH0j75Nhw+JYgQv5AjIj+QxkA+1y9gPgAAAAAedRe/FKN5PgAAAAAj/BG/7qWAPpdS5j6DXyG/EPeHPpdS5j7zOR6/y9utPtcrMT8LCUG/naTgPQAAAACoFpI+Jk7vPQAAAABocJ4+spXoPcXIsD4JK6k++gPxPcXIsD4LRbA+Mkf7Peb8Bz+RFeo+",
    hashes: {
      position:
        "8787345a60666cad17e99748db6077d3790dfdf082927fd77f73b0b490572f0a",
      normal:
        "72dc1b6f260d22a141bb2b478f1a461f41d07618f700679dd36642cd7b5707d3",
      uv: "3151b5917b93984ac88c1b99647ac2a751caaba476e95228a95a3717bd841b33",
      index: "d7054c3ebc02228dec288e98823c302ac0c0491d75fa01a5a99805531c2e6851",
    },
  },
] as const;

describe("fine continuous meadow geometry candidate", () => {
  const historicalHashes = [
    "b173a82e99e75117f67e75712006fcdfb2a8a780307d4af24e53f9c3f824100f",
    "36513b1d7085d52e23abab4ed2e2d73d823003cda9f095596ca8f5e3de097721",
    "4d341787ea4e46a0bb4dbdfc30714dd8c352c4e23c86a892a6979c10cdc48f8d",
  ];
  const digest = (values: ArrayBufferView) =>
    createHash("sha256")
      .update(
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      )
      .digest("hex");
  const geometryDigest = (
    geometry: THREE.BufferGeometry,
    position?: Float32Array,
  ) => {
    const hash = createHash("sha256");
    for (const values of [
      position ?? geometry.attributes.position.array,
      geometry.attributes.normal.array,
      geometry.attributes.uv.array,
      geometry.index!.array,
    ])
      hash.update(
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      );
    return hash.digest("hex");
  };
  const fine = () =>
    manager(
      FINE_MEADOW_GRASS_VISUAL_PROFILE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      true,
      FINE_MEADOW_APPEARANCE.id,
    );
  // Explicit pre-canopy geometry recipe. Never inherit new fine settings into
  // archived byte/area assertions or regenerate their historical hashes.
  const historicalSweptFineShape = Object.freeze({
    BLADE_HEIGHT_MIN: 0.38,
    BLADE_HEIGHT_MAX: 0.86,
    BLADE_WIDTH_RATIO: 0.045,
    BLADE_TAPER: 0.85,
    BLADE_TAPER_POWER: 1,
    BLADE_ARC_RATIO: 0.48,
    BLADE_CONTROL_HEIGHT: 0.76,
    BLADE_TIP_HEIGHT: 0.95,
    PROGRESSIVE_ROOTS: true,
  });
  // Exact Review73 control: do not inherit the candidate taper into this shape.
  const broadCanopyControlShape = Object.freeze({
    ...historicalSweptFineShape,
    BLADE_TAPER_POWER: 2,
    BLADE_UPPER_WIDTH_GAIN: 0.35,
  });
  // Rejected Review74 control remains executable; do not regenerate its
  // measured area loss from the new candidate's width or curvature values.
  const pointedControlShape = Object.freeze({
    ...historicalSweptFineShape,
    BLADE_TAPER: 1,
    BLADE_TAPER_POWER: 1,
    BLADE_WIDTH_FALLOFF_POWER: 0.85,
    BLADE_UPPER_WIDTH_GAIN: 0,
  });
  const pointedControlCase = (nearSegments: 3 | 4) => {
    const geometries = [0, 1, 2].map((lod) => {
      const layout = getGrassBladeLayout(
        lod,
        nearSegments === 3
          ? "fine-linear-sweep-3seg-v1"
          : "fine-linear-sweep-near4-v1",
      );
      return createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        pointedControlShape,
      );
    });
    return {
      geometries,
      dispose: () => geometries.forEach((geometry) => geometry.dispose()),
    };
  };
  const broadCanopyControlCase = (nearSegments: 3 | 4) => {
    const geometries = [0, 1, 2].map((lod) => {
      const layout = getGrassBladeLayout(
        lod,
        nearSegments === 3
          ? "fine-linear-sweep-3seg-v1"
          : "fine-linear-sweep-near4-v1",
      );
      return createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        broadCanopyControlShape,
      );
    });
    return {
      geometries,
      dispose: () => geometries.forEach((geometry) => geometry.dispose()),
    };
  };
  const historicalFineGeometryCase = (nearSegments: 3 | 4) => {
    const geometries = [0, 1, 2].map((lod) => {
      const layout = getGrassBladeLayout(
        lod,
        nearSegments === 3
          ? "fine-linear-sweep-3seg-v1"
          : "fine-linear-sweep-near4-v1",
      );
      return createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        historicalSweptFineShape,
      );
    });
    return {
      geometries,
      dispose: () => geometries.forEach((geometry) => geometry.dispose()),
    };
  };
  const fineGeometryCase = (nearSegments: 3 | 4) => {
    if (nearSegments === 3) {
      const owner = fine();
      return {
        geometries: owner["lodGeometries"],
        dispose: () => owner.destroy(),
      };
    }
    // Retain the rejected candidate's analytic coverage without installing it
    // in a manager or introducing a runtime appearance override.
    const geometries = [0, 1, 2].map((lod) => {
      const layout = getGrassBladeLayout(lod, "fine-linear-sweep-near4-v1");
      return createClumpGeometry(
        layout.bladesPerClump,
        layout.bladeSegments,
        FINE_MEADOW_APPEARANCE,
      );
    });
    return {
      geometries,
      dispose: () => geometries.forEach((geometry) => geometry.dispose()),
    };
  };

  it.each([3, 4] as const)(
    "retains historical linear-taper roots, tips and mid bytes with %i near segments",
    (nearSegments) => {
      // Actual live substrate-contrast-art01 source templates, before near4.
      // Report SHA256: 54238d7cdf4e2e41da24faa155d0b955489dd61fb60b1a9a78d593bfda023657.
      // Generator SHA256: 043fd4cd167f3ed411b3c7f05542a08c969f47d993ed89bf9adb2870a124e85d.
      // Near position SHA256: 3664097a4df304b022923d9c300bc864e2dceb377aee062ee40d284a97156b03.
      // Only each old blade's vertices 0, 1 and 6 are retained here, in order.
      const rootsAndTips = new Float32Array(
        Uint8Array.from(
          Buffer.from(
            "xUT/PgAAAACZ6XM8g/YFPwAAAAAJzdY8z8M8P8H5Ej9myWO9Md5gvgAAAABHhY8+JxF6vgAAAADerYc+SosHv/WlHD8sNFk+0h3LPAAAAAApfRq/tplqPQAAAABv7Bu/6UJBvK4iMj+xFXG/Oh43PgAAAACtTjg+hq45PgAAAAAK91M+Bo+qPsSYEj8sTtQ+XF4LvwAAAAD0OQq+2LMRvwAAAABJZSC+LjtPv/ytMT/a95e+dXTAPgAAAABg0Fq+ZKXPPgAAAAA002q+I1EAPyBBNT/AOg2/84E9vgAAAACWsiA/hDJcvgAAAABQTSQ/ttkTvvH0Mj9Rf3A/DuukvQAAAAAcC1G+XzmBvQAAAACnrES+vtKqvbI05T57OOi+QWUBPwAAAABgJy0+Gpf+PgAAAABFL0o+xNZHP2+BHz9sAXg+x6q9vgAAAAB3iyM+7VbIvgAAAAA2cw0++r8sv5AjIj9M8Vg+1y9gPgAAAAAedRe/FKN5PgAAAAAj/BG/ohnPPtcrMT+xn1u/naTgPQAAAACoFpI+Jk7vPQAAAABocJ4+JW4DPub8Bz+Ylg0/wfUIvwAAAABG3n2+7I4BvwAAAABAY3S+mfoav9sSJD8mwBe/qXr4PgAAAAAomKG9Wuz2PgAAAAACqEq9chBSP7HhHz/p4Ac9HEnWvgAAAADh0RA/HgvNvgAAAABvDgg/ea1kv+kmUT8UMBM/xs2FugAAAADsNiy+EMqaPAAAAABQUiK+tUWave5C7z5A8si+6FrWPgAAAAC+oZ0+iGPJPgAAAAAZEaY+Hk4cP0tHIz8Y3Bc/z3rFvgAAAAAvf1y8IgfSvgAAAAABd6a8MJokvwKMCT88wkq+Ohj2PgAAAACXdN2+O+H3PgAAAACLisy++kJSP+2HMz82xRG/3cVPvQAAAAB3Z5c+c9xwvQAAAAAu4KI+1D8vvum3AD+ORwc/QsbCvgAAAAAkROW+oSqyvgAAAAACzuK+lDQNv4Q4MT8/xii/X1TnPgAAAACypc88pifnPgAAAADTgFQ9+z4hP5doDz+FbHs+hiUFvwAAAADpZsQ+zNcNvwAAAACe5Ms+OrtVv/nkRz/PYkA/ZHSJPQAAAAAS0HW+lza8PQAAAADwtGm+exbWvYpnFD/LQ+m+",
            "base64",
          ),
        ).buffer,
      );
      expect(digest(rootsAndTips)).toBe(
        "6aefd820b073570a2fd82b5beeed70e86b05592a824da050d2ec21bdb3a697ba",
      );
      const owner = historicalFineGeometryCase(nearSegments);
      try {
        const near = owner.geometries[0];
        const stride = nearSegments * 2 + 1;
        const actual = new Float32Array(
          Array.from({ length: 24 }, (_, blade) =>
            [0, 1, stride - 1].flatMap((vertex) =>
              Array.from(near.attributes.position.array).slice(
                (blade * stride + vertex) * 3,
                (blade * stride + vertex + 1) * 3,
              ),
            ),
          ).flat(),
        );
        expect(actual).toEqual(rootsAndTips);
        if (nearSegments === 3) {
          expect(digest(near.attributes.position.array)).toBe(
            "3664097a4df304b022923d9c300bc864e2dceb377aee062ee40d284a97156b03",
          );
          expect(digest(near.attributes.normal.array)).toBe(
            "5b24d50084f11bdd81c47e6fa579373dc3235b45ba4a3a538261e17ea420e2a2",
          );
          expect(digest(near.attributes.uv.array)).toBe(
            historicalFineTemplates[0].hashes.uv,
          );
          expect(digest(near.index!.array)).toBe(
            historicalFineTemplates[0].hashes.index,
          );
        }
        const mid = owner.geometries[1];
        expect(digest(mid.attributes.position.array)).toBe(
          "cf3ea7b781509d5f090f4cad5686500ae684f9e86d522f06b898bae731fa4d20",
        );
        expect(digest(mid.attributes.normal.array)).toBe(
          "dcea6f798b52defa2c29ba47f222be4f695f568b847dc4001e3f514889de63f7",
        );
        expect(digest(mid.attributes.uv.array)).toBe(
          historicalFineTemplates[1].hashes.uv,
        );
        expect(digest(mid.index!.array)).toBe(
          historicalFineTemplates[1].hashes.index,
        );
        // The standalone near4 template adds 48 vertices and 48 triangles. These
        // byte checks do not claim density, instance/root or runtime cost changes.
        expect(geometryBytes(near)).toBe(
          nearSegments === 3
            ? 168 * 8 * 4 + 120 * 3 * 2
            : 216 * 8 * 4 + 168 * 3 * 2,
        );
        expect(geometryBytes(mid)).toBe(60 * 8 * 4 + 36 * 3 * 2);
      } finally {
        owner.dispose();
      }
    },
  );

  it("keeps the upper-canopy leaf and non-emissive root albedo contract explicit", () => {
    expect(FINE_MEADOW_APPEARANCE).toEqual({
      id: "fine-meadow-v1",
      GEOMETRY_LAYOUT: "fine-linear-sweep-3seg-v1",
      BLADE_HEIGHT_MIN: 0.38,
      BLADE_HEIGHT_MAX: 0.86,
      BLADE_WIDTH_RATIO: 0.045,
      BLADE_TAPER: 0.85,
      BLADE_TAPER_POWER: 2,
      BLADE_WIDTH_FALLOFF_POWER: 1,
      BLADE_UPPER_WIDTH_GAIN: 0.35,
      BLADE_ARC_RATIO: 0.48,
      BLADE_CONTROL_HEIGHT: 0.76,
      BLADE_CONTROL_ARC_RATIO: 0.35,
      BLADE_TIP_HEIGHT: 0.95,
      BLADE_NORMAL_WEIGHT: 0.2,
      ROOT_BRIGHTNESS: 0.98,
      TIP_BRIGHTNESS: 1.2,
      ROOT_OCCLUSION: 0.78,
      ROOT_OCCLUSION_END: 0.35,
      PROGRESSIVE_ROOTS: true,
    });
    const owner = fine();
    try {
      const albedo = expand(owner["material"].colorNode!);
      for (const [height, expected] of [
        [0, [0.196, 0.392, 0.098]],
        [0.5, [0.236, 0.445, 0.127]],
        [1, [0.276, 0.498, 0.156]],
      ] as const) {
        const actual = colorValue(albedo, {
          instanceGroundColor: [0.2, 0.4, 0.1],
          instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
          instanceGroundNormal: [0, 1, 0],
          // No camera values: the actual albedo is now view independent.
          uv: [0.5, height],
        });
        actual.forEach((value, i) =>
          expect(value).toBeCloseTo(expected[i], 12),
        );
      }
      expect(owner["material"].emissive.getHex()).toBe(0);
    } finally {
      owner.destroy();
    }
  });

  it.each([3, 4] as const)(
    "retains the rejected pointed control's monotone widths with %i near segments and original curve normals",
    (nearSegments) => {
      const current = pointedControlCase(nearSegments);
      const historical = broadCanopyControlCase(nearSegments);
      // Independent artistic recipe, not a call to the generator's helpers.
      const widthFactor = (t: number) => Math.pow(1 - t, 0.85);
      const controlWidthFactor = (t: number) => {
        const u = Math.min(1, Math.max(0, 2 * t));
        return (1 - 0.85 * t * t) * (1 + 0.35 * u * u * (3 - 2 * u));
      };
      try {
        for (let lod = 0; lod < 3; lod++) {
          const geometry = current.geometries[lod];
          const old = historical.geometries[lod];
          const positions = geometry.getAttribute("position");
          const original = old.getAttribute("position");
          const normals = geometry.getAttribute("normal");
          const segments =
            lod === 0
              ? nearSegments
              : GRASS_CONFIG.LOD_TIERS[lod].bladeSegments;
          const stride = segments * 2 + 1;
          expect(positions.count).toBe(original.count);
          expect(geometryBytes(geometry)).toBe(geometryBytes(old));
          expect(Object.keys(geometry.attributes).sort()).toEqual([
            "normal",
            "position",
            "uv",
          ]);
          for (const name of ["normal", "uv"])
            expect(geometry.attributes[name].array).toEqual(
              old.attributes[name].array,
            );
          expect(geometry.index!.array).toEqual(old.index!.array);
          // The far tier has only a root edge and tip, so remains byte-exact.
          if (lod === 2) expect(positions.array).toEqual(original.array);
          else expect(positions.array).not.toEqual(original.array);
          for (
            let blade = 0;
            blade < GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump;
            blade++
          ) {
            const base = blade * stride;
            const leftRoot = new THREE.Vector3().fromBufferAttribute(
              original,
              base,
            );
            const rightRoot = new THREE.Vector3().fromBufferAttribute(
              original,
              base + 1,
            );
            const tip = new THREE.Vector3().fromBufferAttribute(
              original,
              base + stride - 1,
            );
            const rootCenter = leftRoot
              .clone()
              .add(rightRoot)
              .multiplyScalar(0.5);
            const rootWidth = leftRoot.distanceTo(rightRoot);
            const sideAxis = rightRoot.clone().sub(leftRoot).normalize();
            const arc = tip.clone().sub(rootCenter).setY(0);
            const height = tip.y / 0.95;
            let previousWidth = Infinity;
            for (const offset of [0, 1, stride - 1])
              for (let axis = 0; axis < 3; axis++)
                expect(positions.array[(base + offset) * 3 + axis]).toBe(
                  original.array[(base + offset) * 3 + axis],
                );
            // P(t,u) uses unchanged control centerline/root edges but the
            // independently specified upper width. Test off-center normals so
            // the nonzero width derivative must cancel in the cross product.
            const pointAt = (t: number, u: number) =>
              rootCenter
                .clone()
                .addScaledVector(arc, t * t)
                .setY(height * (1.52 * t - 0.57 * t * t))
                .addScaledVector(sideAxis, u * rootWidth * widthFactor(t));
            for (let row = 0; row < segments; row++) {
              const t = row / segments;
              const vertex = base + row * 2;
              const left = new THREE.Vector3().fromBufferAttribute(
                positions,
                vertex,
              );
              const right = new THREE.Vector3().fromBufferAttribute(
                positions,
                vertex + 1,
              );
              expect(left.y).toBe(original.getY(vertex));
              expect(right.y).toBe(original.getY(vertex + 1));
              expect(left.distanceTo(pointAt(t, -0.5))).toBeLessThan(2e-7);
              expect(right.distanceTo(pointAt(t, 0.5))).toBeLessThan(2e-7);
              const width = left.distanceTo(right);
              expect(width).toBeCloseTo(rootWidth * widthFactor(t), 6);
              expect(width).toBeLessThan(previousWidth);
              previousWidth = width;
              if (row === 0) continue;
              const oldWidth = new THREE.Vector3()
                .fromBufferAttribute(original, vertex)
                .distanceTo(
                  new THREE.Vector3().fromBufferAttribute(original, vertex + 1),
                );
              expect(width).toBeLessThan(oldWidth);
              expect(width / oldWidth).toBeCloseTo(
                widthFactor(t) / controlWidthFactor(t),
                4,
              );
              const epsilon = 1e-5;
              for (const u of [-0.37, 0.37]) {
                const across = pointAt(t, u + epsilon).sub(
                  pointAt(t, u - epsilon),
                );
                const along = pointAt(t + epsilon, u).sub(
                  pointAt(t - epsilon, u),
                );
                const finiteNormal = across.cross(along).normalize();
                for (const offset of [0, 1]) {
                  const actual = new THREE.Vector3().fromBufferAttribute(
                    normals,
                    vertex + offset,
                  );
                  expect(actual.distanceTo(finiteNormal)).toBeLessThan(5e-6);
                }
              }
            }
          }
        }
        // These are strip widths, not a claim about native visible density.
        expect(widthFactor(0)).toBe(1);
        expect(widthFactor(1)).toBe(0);
        expect(widthFactor(1 / 3)).toBeLessThan(0.71);
        expect(widthFactor(2 / 3)).toBeLessThan(0.4);
      } finally {
        current.dispose();
        historical.dispose();
      }
    },
  );

  it.each([3, 4] as const)(
    "retains the rejected pointed control's measured area loss for %i near segments without changing topology",
    (nearSegments) => {
      const candidate = pointedControlCase(nearSegments);
      const control = broadCanopyControlCase(nearSegments);
      // Broadside projection into each blade's original width/Y plane, not
      // camera pixels or canopy coverage. Mesh area uses the actual 3D faces.
      const measure = (geometry: THREE.BufferGeometry, segments: number) => {
        const positions = geometry.getAttribute("position");
        const indices = geometry.getIndex();
        if (!indices) throw new Error("Grass must retain indexed triangles");
        const stride = segments * 2 + 1;
        let meshArea = 0;
        let projectedArea = 0;
        for (let face = 0; face < indices.count; face += 3) {
          const ia = indices.getX(face),
            ib = indices.getX(face + 1),
            ic = indices.getX(face + 2);
          const blade = Math.floor(ia / stride);
          expect(Math.floor(ib / stride)).toBe(blade);
          expect(Math.floor(ic / stride)).toBe(blade);
          const a = new THREE.Vector3().fromBufferAttribute(positions, ia);
          const b = new THREE.Vector3().fromBufferAttribute(positions, ib);
          const c = new THREE.Vector3().fromBufferAttribute(positions, ic);
          const cross = b.sub(a).cross(c.sub(a));
          const rootLeft = new THREE.Vector3().fromBufferAttribute(
            positions,
            blade * stride,
          );
          const width = new THREE.Vector3()
            .fromBufferAttribute(positions, blade * stride + 1)
            .sub(rootLeft)
            .normalize();
          const facing = width.cross(new THREE.Vector3(0, 1, 0));
          const signedProjection = cross.dot(facing);
          expect(cross.toArray().every(Number.isFinite)).toBe(true);
          expect(cross.length()).toBeGreaterThan(1e-6);
          // Every generated face keeps the original authored winding.
          expect(signedProjection).toBeGreaterThan(1e-6);
          meshArea += cross.length() * 0.5;
          projectedArea += signedProjection * 0.5;
        }
        return { meshArea, projectedArea };
      };
      const analyticProjectedArea = (
        segments: number,
        candidateWidth: boolean,
      ) => {
        let area = 0;
        for (let row = 0; row < segments; row++) {
          const t0 = row / segments,
            t1 = (row + 1) / segments;
          const width = (t: number) => {
            if (t === 1) return 0;
            if (candidateWidth) return Math.pow(1 - t, 0.85);
            const u = Math.min(1, 2 * t);
            return (1 - 0.85 * t * t) * (1 + 0.35 * u * u * (3 - 2 * u));
          };
          const y = (t: number) => 1.52 * t - 0.57 * t * t;
          area += (width(t0) + width(t1)) * (y(t1) - y(t0)) * 0.5;
        }
        return area;
      };
      try {
        const measurements: {
          lod: number;
          segments: number;
          vertices: number;
          triangles: number;
          controlArea: ReturnType<typeof measure>;
          candidateArea: ReturnType<typeof measure>;
          projectedReductionFraction: number;
          meshReductionFraction: number;
        }[] = [];
        for (let lod = 0; lod < 3; lod++) {
          const segments = lod === 0 ? nearSegments : lod === 1 ? 2 : 1;
          const actual = candidate.geometries[lod],
            original = control.geometries[lod];
          expect(actual.getAttribute("position").count).toBe(
            original.getAttribute("position").count,
          );
          expect(actual.index!.array).toEqual(original.index!.array);
          expect(geometryBytes(actual)).toBe(geometryBytes(original));
          const candidateArea = measure(actual, segments);
          const controlArea = measure(original, segments);
          const projectedRatio =
            candidateArea.projectedArea / controlArea.projectedArea;
          const meshRatio = candidateArea.meshArea / controlArea.meshArea;
          expect(projectedRatio).toBeCloseTo(
            analyticProjectedArea(segments, true) /
              analyticProjectedArea(segments, false),
            6,
          );
          if (lod === 2) {
            expect(candidateArea).toEqual(controlArea);
          } else {
            expect(projectedRatio).toBeGreaterThan(0.6);
            expect(projectedRatio).toBeLessThan(0.8);
            expect(meshRatio).toBeGreaterThan(0.6);
            expect(meshRatio).toBeLessThan(0.8);
          }
          measurements.push({
            lod,
            segments,
            vertices: actual.getAttribute("position").count,
            triangles: actual.index!.count / 3,
            controlArea,
            candidateArea,
            projectedReductionFraction: 1 - projectedRatio,
            meshReductionFraction: 1 - meshRatio,
          });
        }
        console.info("pointedFineBladeArea", { nearSegments, measurements });
      } finally {
        candidate.dispose();
        control.dispose();
      }
    },
  );

  it.each([3, 4] as const)(
    "restores broad leaf area with genuine lower-curve lean and derivative normals at %i near segments",
    (nearSegments) => {
      const candidate = fineGeometryCase(nearSegments);
      const broad = broadCanopyControlCase(nearSegments);
      const pointed = pointedControlCase(nearSegments);
      // Independent quadratic control points: root, root+.35*arc at .76h,
      // and the unchanged tip at .95h. This is geometry, not a lighting gain.
      const arcAt = (t: number) => 0.7 * t + 0.3 * t * t;
      const heightAt = (t: number) => 1.52 * t - 0.57 * t * t;
      const widthAt = (t: number) => {
        const u = Math.min(1, Math.max(0, t * 2));
        return (1 - 0.85 * t * t) * (1 + 0.35 * u * u * (3 - 2 * u));
      };
      const measure = (geometry: THREE.BufferGeometry, stride: number) => {
        const position = geometry.getAttribute("position");
        const index = geometry.getIndex();
        if (!index) throw new Error("Actual indexed grass geometry required");
        let meshArea = 0;
        let projectedArea = 0;
        for (let face = 0; face < index.count; face += 3) {
          const ia = index.getX(face);
          const ib = index.getX(face + 1);
          const ic = index.getX(face + 2);
          const blade = Math.floor(ia / stride);
          expect(Math.floor(ib / stride)).toBe(blade);
          expect(Math.floor(ic / stride)).toBe(blade);
          const a = new THREE.Vector3().fromBufferAttribute(position, ia);
          const b = new THREE.Vector3().fromBufferAttribute(position, ib);
          const c = new THREE.Vector3().fromBufferAttribute(position, ic);
          const cross = b.sub(a).cross(c.sub(a));
          const root = new THREE.Vector3().fromBufferAttribute(
            position,
            blade * stride,
          );
          const facing = new THREE.Vector3()
            .fromBufferAttribute(position, blade * stride + 1)
            .sub(root)
            .normalize()
            .cross(new THREE.Vector3(0, 1, 0));
          const projection = cross.dot(facing);
          expect(cross.toArray().every(Number.isFinite)).toBe(true);
          expect(cross.length()).toBeGreaterThan(1e-6);
          expect(projection).toBeGreaterThan(1e-6);
          meshArea += cross.length() * 0.5;
          projectedArea += projection * 0.5;
        }
        return { meshArea, projectedArea };
      };
      const measurements: {
        lod: number;
        segments: number;
        vertices: number;
        triangles: number;
        broad: ReturnType<typeof measure>;
        pointed: ReturnType<typeof measure>;
        candidate: ReturnType<typeof measure>;
        meshRatioToBroad: number;
        meshRatioToPointed: number;
        projectedRatioToBroad: number;
        projectedRatioToPointed: number;
      }[] = [];
      try {
        for (let lod = 0; lod < 3; lod++) {
          const segments = lod === 0 ? nearSegments : lod === 1 ? 2 : 1;
          const stride = segments * 2 + 1;
          const actual = candidate.geometries[lod];
          const original = broad.geometries[lod];
          const position = actual.getAttribute("position");
          const controlPosition = original.getAttribute("position");
          const normal = actual.getAttribute("normal");
          expect(position.count).toBe(controlPosition.count);
          expect(geometryBytes(actual)).toBe(geometryBytes(original));
          expect(actual.index!.array).toEqual(original.index!.array);
          expect(actual.attributes.uv.array).toEqual(
            original.attributes.uv.array,
          );
          expect(normal.array).not.toEqual(original.attributes.normal.array);
          for (let vertex = 0; vertex < position.count; vertex++)
            expect(position.getY(vertex)).toBe(controlPosition.getY(vertex));
          for (
            let blade = 0;
            blade < GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump;
            blade++
          ) {
            const base = blade * stride;
            const left = new THREE.Vector3().fromBufferAttribute(
              controlPosition,
              base,
            );
            const right = new THREE.Vector3().fromBufferAttribute(
              controlPosition,
              base + 1,
            );
            const tip = new THREE.Vector3().fromBufferAttribute(
              controlPosition,
              base + stride - 1,
            );
            const root = left.clone().add(right).multiplyScalar(0.5);
            const arc = tip.clone().sub(root).setY(0);
            const side = right.clone().sub(left).normalize();
            const rootWidth = left.distanceTo(right);
            const height = tip.y / 0.95;
            for (const offset of [0, 1, stride - 1])
              for (let axis = 0; axis < 3; axis++)
                expect(position.array[(base + offset) * 3 + axis]).toBe(
                  controlPosition.array[(base + offset) * 3 + axis],
                );
            const centerAt = (t: number) =>
              root
                .clone()
                .addScaledVector(arc, arcAt(t))
                .setY(height * heightAt(t));
            for (let row = 0; row <= segments; row++) {
              const t = row / segments;
              const vertex = base + Math.min(row * 2, stride - 1);
              const expectedNormal = side
                .clone()
                .cross(
                  new THREE.Vector3(
                    arc.x * (0.7 + 0.6 * t),
                    height * (1.52 - 1.14 * t),
                    arc.z * (0.7 + 0.6 * t),
                  ),
                )
                .normalize();
              const epsilon = 1e-5;
              const finiteNormal = side
                .clone()
                .cross(centerAt(t + epsilon).sub(centerAt(t - epsilon)))
                .normalize();
              expect(expectedNormal.distanceTo(finiteNormal)).toBeLessThan(
                1e-9,
              );
              for (const offset of row === segments ? [0] : [0, 1]) {
                const actualNormal = new THREE.Vector3().fromBufferAttribute(
                  normal,
                  vertex + offset,
                );
                expect(actualNormal.length()).toBeCloseTo(1, 6);
                expect(actualNormal.distanceTo(expectedNormal)).toBeLessThan(
                  5e-6,
                );
              }
              if (row === segments) continue;
              const actualLeft = new THREE.Vector3().fromBufferAttribute(
                position,
                vertex,
              );
              const actualRight = new THREE.Vector3().fromBufferAttribute(
                position,
                vertex + 1,
              );
              const center = actualLeft
                .clone()
                .add(actualRight)
                .multiplyScalar(0.5);
              expect(center.distanceTo(centerAt(t))).toBeLessThan(2e-7);
              expect(actualLeft.distanceTo(actualRight)).toBeCloseTo(
                rootWidth * widthAt(t),
                6,
              );
              if (row > 0) {
                const controlCenter = new THREE.Vector3()
                  .fromBufferAttribute(controlPosition, vertex)
                  .add(
                    new THREE.Vector3().fromBufferAttribute(
                      controlPosition,
                      vertex + 1,
                    ),
                  )
                  .multiplyScalar(0.5);
                const ratio = arcAt(t) / (t * t);
                // Compare in metres: division by a short Float32 arc magnifies
                // coordinate rounding. Both reconstructed centers have the
                // same 2e-7 m bound already tested above; scaling one by ratio
                // propagates that bound without relaxing the position checks.
                expect(
                  Math.abs(
                    center.clone().sub(root).setY(0).length() -
                      controlCenter.clone().sub(root).setY(0).length() * ratio,
                  ),
                ).toBeLessThan(2e-7 * (1 + ratio));
              }
            }
          }
          const actualArea = measure(actual, stride);
          const broadArea = measure(original, stride);
          const pointedArea = measure(pointed.geometries[lod], stride);
          expect(
            actualArea.projectedArea / broadArea.projectedArea,
          ).toBeCloseTo(1, 6);
          if (lod === 2) {
            expect(position.array).toEqual(controlPosition.array);
            expect(actualArea).toEqual(broadArea);
            expect(actualArea).toEqual(pointedArea);
          } else {
            expect(actualArea.meshArea / pointedArea.meshArea).toBeGreaterThan(
              1.35,
            );
            expect(
              actualArea.projectedArea / pointedArea.projectedArea,
            ).toBeGreaterThan(1.35);
          }
          measurements.push({
            lod,
            segments,
            vertices: position.count,
            triangles: actual.index!.count / 3,
            broad: broadArea,
            pointed: pointedArea,
            candidate: actualArea,
            meshRatioToBroad: actualArea.meshArea / broadArea.meshArea,
            meshRatioToPointed: actualArea.meshArea / pointedArea.meshArea,
            projectedRatioToBroad:
              actualArea.projectedArea / broadArea.projectedArea,
            projectedRatioToPointed:
              actualArea.projectedArea / pointedArea.projectedArea,
          });
        }
        console.info(
          "leaningFineBladeArea",
          JSON.stringify({ nearSegments, measurements }),
        );
      } finally {
        candidate.dispose();
        broad.dispose();
        pointed.dispose();
      }
    },
  );

  it("admits only the explicit fine physical material and freezes its exact thin-leaf recipe", () => {
    const owner = fine();
    try {
      const material = owner["material"];
      expect(material).toBeInstanceOf(MeshSSSNodeMaterial);
      if (!(material instanceof MeshSSSNodeMaterial))
        throw new Error("Fine physical grass requires the actual SSS material");
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
      expect(
        Object.getOwnPropertyDescriptor(material.userData, "fineGrassLighting"),
      ).toEqual({
        enumerable: true,
        configurable: false,
        writable: false,
        value: FINE_GRASS_THIN_LEAF_LIGHTING,
      });
      expect(material.userData.fineGrassLighting).toBe(
        FINE_GRASS_THIN_LEAF_LIGHTING,
      );
      for (const [key, expected] of [
        ["thicknessAttenuationNode", 0.2],
        ["thicknessScaleNode", 1],
        ["thicknessPowerNode", 2],
        ["thicknessDistortionNode", 0.1],
        ["thicknessAmbientNode", 0],
      ] as const)
        expect(colorValue(material[key], {})).toEqual([expected]);
      const lighting = material.setupLightingModel();
      expect(lighting.useSSS).toBe(true);
      for (const key of [
        "clearcoat",
        "sheen",
        "iridescence",
        "anisotropy",
        "transmission",
        "dispersion",
        "retroreflection",
      ] as const)
        expect(lighting[key]).toBe(false);
      for (const key of [
        "clearcoatNode",
        "sheenNode",
        "iridescenceNode",
        "anisotropyNode",
        "transmissionNode",
        "dispersionNode",
        "retroreflectivityNode",
      ] as const)
        expect(material[key]).toBeNull();
      expect(material.ior).toBe(1.5);
      expect(material.specularIntensity).toBe(1);
      expect(material.specularColor.toArray()).toEqual([1, 1, 1]);
      expect(material.roughness).toBe(1);
      expect(material.metalness).toBe(0);
      expect(material.emissive.toArray()).toEqual([0, 0, 0]);
      expect(graph(material.aoNode!).size).toBeGreaterThan(0);
    } finally {
      owner.destroy();
    }
  });

  it.each([0, 1, 2])(
    "preserves all six real SSS node identities through the LOD%i grounded binding clone",
    (lod) => {
      const owner = fine();
      const geometry = owner["lodGeometries"][lod].clone();
      let clone: MeshStandardNodeMaterial | undefined;
      try {
        const base = owner["material"];
        if (!(base instanceof MeshSSSNodeMaterial))
          throw new Error("Expected real fine SSS material");
        const layout = getGrassBladeLayout(
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        const count = 3;
        const roots = Float32Array.from(
          { length: count * layout.bladesPerClump * 2 },
          (_, i) => (i % 7) * 0.0001,
        );
        clone = createGroundedGrassMaterial(
          base,
          geometry,
          roots,
          count,
          lod,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        expect(clone).not.toBe(base);
        expect(clone).toBeInstanceOf(MeshSSSNodeMaterial);
        if (!(clone instanceof MeshSSSNodeMaterial))
          throw new Error("Grounding clone lost the SSS subclass");
        for (const key of [
          "thicknessColorNode",
          "thicknessAttenuationNode",
          "thicknessScaleNode",
          "thicknessPowerNode",
          "thicknessDistortionNode",
          "thicknessAmbientNode",
          "colorNode",
          "normalNode",
          "aoNode",
        ] as const)
          expect(clone[key]).toBe(base[key]);
        expect(clone.positionNode).not.toBe(base.positionNode);
        expect(clone.setupLightingModel().useSSS).toBe(true);
        // Raw NodeMaterial.clone JSON-copies metadata, but keeps actual nodes.
        // GVM publication below restores an immutable recipe on its owner.
        expect(clone.userData.fineGrassLighting).toEqual(
          FINE_GRASS_THIN_LEAF_LIGHTING,
        );
        expect(geometry.getAttribute("grassRootDeltas").array).toBe(roots);
        expect(geometry.getAttribute("grassRootDeltas").itemSize).toBe(2);
        expect(geometry.getAttribute("position").count).toBe(
          layout.verticesPerClump,
        );
        for (const height of [0, 0.05, 0.35, 0.65, 1]) {
          const inputs = {
            instanceGroundColor: [0.2, 0.4, 0.1],
            instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
            uv: [0.5, height],
          };
          expect(colorValue(clone.thicknessColorNode!, inputs)).toEqual(
            colorValue(base.thicknessColorNode!, inputs),
          );
        }
      } finally {
        clone?.dispose();
        geometry.dispose();
        owner.destroy();
      }
    },
  );

  it("publishes the immutable recipe and borrowed SSS nodes on its real representative mesh without simulating compilation", async () => {
    const owner = fine();
    let observed = false;
    try {
      const base = owner["material"];
      if (!(base instanceof MeshSSSNodeMaterial))
        throw new Error("Expected real fine SSS material");
      await owner.precompileRepresentativeChunk(async (object) => {
        if (!(object instanceof THREE.InstancedMesh))
          throw new Error("Expected actual representative InstancedMesh");
        const material = object.material;
        if (!(material instanceof MeshSSSNodeMaterial))
          throw new Error("Representative owner lost SSS material");
        observed = true;
        expect(material.thicknessColorNode).toBe(base.thicknessColorNode);
        expect(material.colorNode).toBe(base.colorNode);
        expect(material.normalNode).toBe(base.normalNode);
        expect(material.aoNode).toBe(base.aoNode);
        expect(material.userData.fineGrassLighting).toBe(
          FINE_GRASS_THIN_LEAF_LIGHTING,
        );
        expect(
          Object.getOwnPropertyDescriptor(
            material.userData,
            "fineGrassLighting",
          ),
        ).toMatchObject({ writable: false, configurable: false });
        expect(object.receiveShadow).toBe(true);
        expect(object.castShadow).toBe(false);
        expect(material.transmission).toBe(0);
        expect(material.transparent).toBe(false);
        expect(material.depthWrite).toBe(true);
      });
      expect(observed).toBe(true);
    } finally {
      owner.destroy();
    }
  });

  it("does not promote ordinary, fixed, compact or natural materials to the SSS trial", () => {
    const owners = [
      manager(),
      manager(STREAMING_GRASS_VISUAL_PROFILE),
      manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE),
      manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE),
      manager(
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        true,
        "natural-tuft-v1",
      ),
      manager({}, COMPACT_WORLD_TERRAIN_PROFILE),
      manager({}, SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE, false),
    ];
    try {
      for (const owner of owners) {
        const material = owner["material"];
        expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
        expect(material).not.toBeInstanceOf(MeshSSSNodeMaterial);
        expect(
          Object.prototype.hasOwnProperty.call(
            material.userData,
            "fineGrassLighting",
          ),
        ).toBe(false);
        expect(Reflect.has(material, "thicknessColorNode")).toBe(false);
      }
    } finally {
      for (const owner of owners) owner.destroy();
    }
  });

  it.each([3, 4] as const)(
    "keeps deterministic progressive roots with %i near segments",
    (nearSegments) => {
      const owner = fineGeometryCase(nearSegments);
      const repeated = fineGeometryCase(nearSegments);
      try {
        const geometries = owner.geometries;
        for (let lod = 0; lod < 3; lod++) {
          const geometry = geometries[lod];
          // The arc changes positions/normals at every tier. Keep historical
          // hashes as provenance, not newly blessed output snapshots; the exact
          // lateral change is independently checked against archived bytes below.
          expect(geometryDigest(geometry)).not.toBe(historicalHashes[lod]);
          expect(geometryDigest(geometry)).toBe(
            geometryDigest(repeated.geometries[lod]),
          );
          const tier = GRASS_CONFIG.LOD_TIERS[lod];
          const segments = lod === 0 ? nearSegments : tier.bladeSegments;
          const stride = segments * 2 + 1;
          const positions = geometry.getAttribute("position");
          const normals = geometry.getAttribute("normal");
          expect(positions.count).toBe(tier.bladesPerClump * stride);
          expect(geometry.index!.count / 3).toBe(
            tier.bladesPerClump * (segments * 2 - 1),
          );
          expect(Object.keys(geometry.attributes).sort()).toEqual([
            "normal",
            "position",
            "uv",
          ]);
          for (const attribute of ["position", "normal", "uv"]) {
            expect(geometry.attributes[attribute].array).toEqual(
              repeated.geometries[lod].attributes[attribute].array,
            );
          }
          const roots: THREE.Vector3[] = [];
          for (let blade = 0; blade < tier.bladesPerClump; blade++) {
            const base = blade * stride;
            const left = new THREE.Vector3().fromBufferAttribute(
              positions,
              base,
            );
            const right = new THREE.Vector3().fromBufferAttribute(
              positions,
              base + 1,
            );
            const tip = new THREE.Vector3().fromBufferAttribute(
              positions,
              base + stride - 1,
            );
            const root = left.clone().add(right).multiplyScalar(0.5);
            roots.push(root);
            expect(root.y).toBe(0);
            expect(tip.y).toBeGreaterThanOrEqual(
              FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MIN *
                FINE_MEADOW_APPEARANCE.BLADE_TIP_HEIGHT -
                1e-7,
            );
            expect(tip.y).toBeLessThanOrEqual(
              FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
                FINE_MEADOW_APPEARANCE.BLADE_TIP_HEIGHT +
                1e-7,
            );
            expect(
              left.distanceTo(right) /
                (tip.y / FINE_MEADOW_APPEARANCE.BLADE_TIP_HEIGHT),
            ).toBeCloseTo(FINE_MEADOW_APPEARANCE.BLADE_WIDTH_RATIO, 6);
            for (let vertex = base; vertex < base + stride; vertex++) {
              const normal = new THREE.Vector3().fromBufferAttribute(
                normals,
                vertex,
              );
              expect(normal.toArray().every(Number.isFinite)).toBe(true);
              expect(normal.length()).toBeCloseTo(1, 6);
            }
            if (lod > 0) {
              const near = geometries[0];
              const nearStride = nearSegments * 2 + 1;
              const nearBase = blade * nearStride;
              for (const [currentVertex, nearVertex] of [
                [base, nearBase],
                [base + 1, nearBase + 1],
                ...(lod === 1 && nearSegments === 4
                  ? [
                      [base + 2, nearBase + 4],
                      [base + 3, nearBase + 5],
                    ]
                  : []),
                [base + stride - 1, nearBase + nearStride - 1],
              ]) {
                for (const attribute of ["position", "normal", "uv"]) {
                  expect(
                    Array.from(geometry.attributes[attribute].array).slice(
                      currentVertex * geometry.attributes[attribute].itemSize,
                      (currentVertex + 1) *
                        geometry.attributes[attribute].itemSize,
                    ),
                  ).toEqual(
                    Array.from(near.attributes[attribute].array).slice(
                      nearVertex * near.attributes[attribute].itemSize,
                      (nearVertex + 1) * near.attributes[attribute].itemSize,
                    ),
                  );
                }
              }
            }
          }
          // Each tier covers the clump disk, rather than retaining only short
          // stems clustered at its center when detail is reduced.
          expect(
            Math.max(...roots.map((root) => root.length())),
          ).toBeGreaterThan(0.58);
          expect(roots.some((root) => root.x > 0.2)).toBe(true);
          expect(roots.some((root) => root.x < -0.2)).toBe(true);
          expect(
            new Set(roots.map((root) => root.toArray().join(","))).size,
          ).toBe(roots.length);
        }
      } finally {
        owner.dispose();
        repeated.dispose();
      }
    },
  );

  it.each([3, 4] as const)(
    "evaluates the historical linear-taper analytic curve at true %i-segment near rows",
    (nearSegments) => {
      const owner = historicalFineGeometryCase(nearSegments);
      try {
        for (const saved of historicalFineTemplates) {
          const lod = saved.lod;
          const geometry = owner.geometries[lod];
          const positions = geometry.getAttribute("position");
          const normals = geometry.getAttribute("normal");
          const uvs = geometry.getAttribute("uv");
          const oldValues = new Float32Array(
            Uint8Array.from(Buffer.from(saved.positionBase64, "base64")).buffer,
          );
          const original = new THREE.BufferAttribute(oldValues, 3);
          expect(digest(oldValues)).toBe(saved.hashes.position);
          expect(digest(normals.array)).not.toBe(saved.hashes.normal);
          if (lod === 1 || nearSegments === 3) {
            expect(digest(uvs.array)).toBe(saved.hashes.uv);
            expect(digest(geometry.index!.array)).toBe(saved.hashes.index);
          } else {
            expect(digest(uvs.array)).not.toBe(saved.hashes.uv);
            expect(digest(geometry.index!.array)).not.toBe(saved.hashes.index);
          }
          expect(digest(positions.array)).not.toBe(saved.hashes.position);
          const { bladesPerClump: blades, bladeSegments: oldSegments } =
            GRASS_CONFIG.LOD_TIERS[lod];
          const segments = lod === 0 ? nearSegments : oldSegments;
          const stride = segments * 2 + 1;
          const oldStride = oldSegments * 2 + 1;
          expect(positions.count).toBe(
            lod === 0 ? (nearSegments === 3 ? 168 : 216) : 60,
          );
          expect(geometry.index!.count / 3).toBe(
            lod === 0 ? (nearSegments === 3 ? 120 : 168) : 36,
          );
          let linearArea = 0;
          let shoulderArea = 0;
          let historicalLinearArea = 0;
          let historicalShoulderArea = 0;
          for (let blade = 0; blade < blades; blade++) {
            const base = blade * stride;
            const oldBase = blade * oldStride;
            const rootLeft = new THREE.Vector3().fromBufferAttribute(
              original,
              oldBase,
            );
            const rootRight = new THREE.Vector3().fromBufferAttribute(
              original,
              oldBase + 1,
            );
            const maximumWidth = rootLeft.distanceTo(rootRight);
            const rootCenter = rootLeft
              .clone()
              .add(rootRight)
              .multiplyScalar(0.5);
            const sideAxis = rootRight.clone().sub(rootLeft).normalize();
            const oldTip = new THREE.Vector3().fromBufferAttribute(
              original,
              oldBase + oldStride - 1,
            );
            const arcDelta = oldTip.clone().sub(rootCenter).setY(0);
            const height = original.getY(oldBase + oldStride - 1) / 0.95;
            let linearWidth = maximumWidth;
            let shoulderWidth = maximumWidth;
            let previousY = 0;
            for (let row = 0; row <= segments; row++) {
              const tip = row === segments;
              const offset = tip ? stride - 1 : row * 2;
              const left = new THREE.Vector3().fromBufferAttribute(
                positions,
                base + offset,
              );
              const right = tip
                ? left.clone()
                : new THREE.Vector3().fromBufferAttribute(
                    positions,
                    base + offset + 1,
                  );
              const center = left.clone().add(right).multiplyScalar(0.5);
              const t = row / segments;
              // Arc .48 / historical .30 = 1.6. The frozen native03 coordinates
              // independently supply roots, width, height and displacement.
              // Evaluate the quadratic itself, never interpolate old vertices:
              // the new .25/.5/.75 rows are not the old third-step polyline.
              const expectedCenter = rootCenter
                .clone()
                .addScaledVector(arcDelta, 1.6 * t * t)
                .setY(height * (1.52 * t - 0.57 * t * t));
              const expectedWidth = tip ? 0 : maximumWidth * (1 - 0.85 * t);
              for (const [side, actual] of [left, right].entries()) {
                const expected = expectedCenter
                  .clone()
                  .addScaledVector(sideAxis, (side - 0.5) * expectedWidth);
                expect(actual.distanceTo(expected)).toBeLessThan(2e-7);
                if (row === 0)
                  expect(actual.toArray()).toEqual(
                    [rootLeft, rootRight][side].toArray(),
                  );
              }
              expect(center.distanceTo(expectedCenter)).toBeLessThan(2e-7);
              const rowVertices = tip
                ? [base + offset]
                : [base + offset, base + offset + 1];
              for (const [side, vertex] of rowVertices.entries()) {
                expect(uvs.getX(vertex)).toBe(tip ? 0.5 : side);
                expect(uvs.getY(vertex)).toBe(Math.fround(t));
              }
              // Preserve the original equality assertions wherever the source
              // sampling really coincides: all mid rows, near roots and tip.
              if (Number.isInteger(t * oldSegments)) {
                const oldOffset = tip ? oldStride - 1 : t * oldSegments * 2;
                for (const [side, actual] of [left, right].entries()) {
                  const old = new THREE.Vector3().fromBufferAttribute(
                    original,
                    oldBase + oldOffset + (tip ? 0 : side),
                  );
                  expect(actual.y).toBe(old.y);
                }
              }
              const tangent = arcDelta
                .clone()
                .multiplyScalar(3.2 * t)
                .setY(height * (1.52 - 1.14 * t));
              const expectedNormal = sideAxis
                .clone()
                .cross(tangent)
                .normalize();
              for (const vertex of rowVertices) {
                const normal = new THREE.Vector3().fromBufferAttribute(
                  normals,
                  vertex,
                );
                expect(normal.toArray().every(Number.isFinite)).toBe(true);
                expect(normal.length()).toBeCloseTo(1, 6);
                // Root-edge differencing magnifies archived Float32 rounding;
                // this independent cross-product oracle is not a shader mock.
                expect(normal.distanceTo(expectedNormal)).toBeLessThan(5e-6);
              }
              const width = left.distanceTo(right);
              expect(width).toBeLessThanOrEqual(maximumWidth + 1.3e-7);
              // Explicit formulas are independent of the generator's taper
              // fields and helper. The last vertex remains a single point.
              expect(width).toBeCloseTo(expectedWidth, 6);
              const oldShoulderWidth = maximumWidth * (1 - t * t);
              expect(center.y).toBeCloseTo(
                height * (1.52 * t - 0.57 * t * t),
                7,
              );
              if (row > 0 && !tip) expect(width).toBeLessThan(oldShoulderWidth);
              if (row > 0) {
                // Exact side-axis/vertical orthographic strip area, not total
                // GPU coverage: arbitrary view yaw and occlusion can differ.
                linearArea +=
                  (center.y - previousY) * (linearWidth + width) * 0.5;
                shoulderArea +=
                  (center.y - previousY) *
                  (shoulderWidth + oldShoulderWidth) *
                  0.5;
              }
              linearWidth = width;
              shoulderWidth = oldShoulderWidth;
              previousY = center.y;
            }
            const expectedIndices: number[] = [];
            for (let row = 0; row < segments - 1; row++) {
              const left = base + row * 2;
              expectedIndices.push(
                left,
                left + 1,
                left + 2,
                left + 1,
                left + 3,
                left + 2,
              );
            }
            expectedIndices.push(
              base + stride - 3,
              base + stride - 2,
              base + stride - 1,
            );
            const indicesPerBlade = (segments * 2 - 1) * 3;
            expect(
              Array.from(geometry.index!.array).slice(
                blade * indicesPerBlade,
                (blade + 1) * indicesPerBlade,
              ),
            ).toEqual(expectedIndices);
            // Keep the historical three-step leaf-area evidence rather than
            // replacing its old ratio with a newly blessed candidate number.
            let oldLinearWidth = maximumWidth;
            let oldShoulderWidth = maximumWidth;
            let oldY = 0;
            for (let row = 1; row <= oldSegments; row++) {
              const t = row / oldSegments;
              const offset = row === oldSegments ? oldStride - 1 : row * 2;
              const left = new THREE.Vector3().fromBufferAttribute(
                original,
                oldBase + offset,
              );
              const right =
                row === oldSegments
                  ? left
                  : new THREE.Vector3().fromBufferAttribute(
                      original,
                      oldBase + offset + 1,
                    );
              const width = left.distanceTo(right);
              const shoulderWidth = maximumWidth * (1 - t * t);
              const deltaY = left.y - oldY;
              historicalLinearArea += deltaY * (oldLinearWidth + width) * 0.5;
              historicalShoulderArea +=
                deltaY * (oldShoulderWidth + shoulderWidth) * 0.5;
              oldLinearWidth = width;
              oldShoulderWidth = shoulderWidth;
              oldY = left.y;
            }
          }
          const historicalRatio =
            lod === 0 ? 21736 / 36000 / (3781 / 5400) : 7 / 8;
          expect(historicalLinearArea / historicalShoulderArea).toBeCloseTo(
            historicalRatio,
            5,
          );
          // Independent normalized trapezoids at the candidate's explicit rows.
          const rows =
            lod === 0
              ? nearSegments === 3
                ? [0, 1 / 3, 2 / 3, 1]
                : [0, 0.25, 0.5, 0.75, 1]
              : [0, 0.5, 1];
          const integral = (widthAt: (t: number) => number) =>
            rows.slice(1).reduce((area, t, i) => {
              const previousT = rows[i];
              const y = (t: number) => 1.52 * t - 0.57 * t * t;
              return (
                area +
                (y(t) - y(previousT)) * (widthAt(t) + widthAt(previousT)) * 0.5
              );
            }, 0);
          const expectedRatio =
            integral((t) => (t === 1 ? 0 : 1 - 0.85 * t)) /
            integral((t) => 1 - t * t);
          expect(linearArea / shoulderArea).toBeCloseTo(expectedRatio, 5);
          expect(linearArea).toBeLessThan(shoulderArea);
          // Source strip area is not visible density or performance approval.
          console.info("Fine swept-arc linear taper source geometry", {
            lod,
            segments,
            linearArea,
            shoulderArea,
            historicalLinearArea,
            historicalRatio,
            ratio: linearArea / shoulderArea,
            reductionFraction: 1 - linearArea / shoulderArea,
            positionSHA256: digest(positions.array),
          });
        }
      } finally {
        owner.dispose();
      }
    },
  );

  it("retains every lower-profile geometry byte against the archived production generator", () => {
    // Generated once from the actual source SHA above; neither Git nor an
    // alternate geometry implementation is executed by this regression.
    const ordinary = [
      "30d43cae657ad1a55190ed6e23dda8cc7973ee4bb684a248e9d39ee851f5a109",
      "06e6a222140aa84141061eb5775b6dc46a84a8a739b69d8ee00450de8b695b2d",
      "b6d82f6b4b98e0d3a5a40813c6a5f8bac7ff94559df4e77f058a1aba4ae4a26c",
    ];
    const cases = [
      { owner: manager(), hashes: ordinary },
      { owner: manager(STREAMING_GRASS_VISUAL_PROFILE), hashes: ordinary },
      {
        owner: manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE),
        hashes: [
          "da0d68b971e4b8024f1c5ef659e419929d3f694ec6195a2c8d88717a8d6102f2",
          "c45836f77f55cf0a993de40751b74577e4c8b2a612c7fd41e967e8d0ac6e0492",
          "76fcfa38d594984ae7402875df6a57918abd18336b3601f8489e965996acd800",
        ],
      },
      {
        owner: manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE),
        hashes: [
          "bc680313d0cece3938de8098fd1ecc9c39fa1ee773eb5453cb84a6ff133f55f8",
          "ae63acb18b8b806ff384eba8ddd87ce5c9dcd1255ff866a0ac91932a7524bd96",
          "dd8fae25ab7c2191d291ccfa2d02ed6a6f22ee0a1b6b537fae16d269a66d42a3",
        ],
      },
      {
        owner: manager(
          DENSE_MEADOW_GRASS_VISUAL_PROFILE,
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          true,
          "natural-tuft-v1",
        ),
        hashes: [
          "f92c0ab9100f5019712d41caa70b04103298ed16ad475fe929f18ce2d74fcd7f",
          "f950dd5dae60afd3be663921bb4dedf2dbb745b112609609cfccca9d1ba016ce",
          "f0a98c9abf09d522dbb6f22fb92f4f2dabb9e8e1191705e5be6550bee8609df1",
        ],
      },
    ];
    try {
      for (const { owner, hashes } of cases)
        expect(
          owner["lodGeometries"].map((geometry) => geometryDigest(geometry)),
        ).toEqual(hashes);
    } finally {
      for (const { owner } of cases) owner.destroy();
    }
  });

  it("keeps the candidate explicit, opaque and within existing material layout", () => {
    const owner = fine();
    const legacyBefore = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    const legacyAfter = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    try {
      expect(owner.getProfileReceipt()).toMatchObject({
        profileId: "fine-meadow-v1",
        eligibility: "compact-pbr-v1",
        minimumLodLevel: 0,
        clumpSpacing: 0.7,
        maxRenderDistance: 140,
        maxChunksPerFrame: 1,
        castShadow: false,
        placement: {
          mode: "world-cells-v1",
          cellSize: 25,
          nearLodDistance: 40,
        },
      });
      const material = owner["material"];
      expect(material.name).toBe("fine-meadow-v1");
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      expect(material.side).toBe(THREE.DoubleSide);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.emissive.getHex()).toBe(0);
      for (const root of [
        material.positionNode!,
        material.normalNode!,
        material.colorNode!,
      ])
        expect(
          [...graph(root)].some(
            (n) => Reflect.get(n, "isTextureNode") === true,
          ),
        ).toBe(false);
      for (let lod = 0; lod < 3; lod++) {
        for (const attribute of ["position", "normal", "uv"])
          expect(
            legacyAfter["lodGeometries"][lod].attributes[attribute].array,
          ).toEqual(
            legacyBefore["lodGeometries"][lod].attributes[attribute].array,
          );
      }
    } finally {
      owner.destroy();
      legacyBefore.destroy();
      legacyAfter.destroy();
    }
  });
});

describe("explicit natural-tuft appearance geometry and material (CPU only)", () => {
  const tuft = () =>
    manager(
      DENSE_MEADOW_GRASS_VISUAL_PROFILE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      true,
      NATURAL_TUFT_APPEARANCE.id,
    );

  it("preserves all LOD topology, UVs, buffer layouts and bytes while deterministically changing the authored shape", () => {
    const baseline = manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE);
    const candidate = tuft(),
      repeat = tuft();
    try {
      for (let lod = 0; lod < 3; lod++) {
        const original = baseline["lodGeometries"][lod];
        const geometry = candidate["lodGeometries"][lod];
        expect(Object.keys(geometry.attributes).sort()).toEqual([
          "normal",
          "position",
          "uv",
        ]);
        expect(geometry.attributes.position.count).toBe([168, 60, 12][lod]);
        expect(geometry.index!.count / 3).toBe([120, 36, 4][lod]);
        expect(geometry.index!.array).toBeInstanceOf(Uint16Array);
        expect(geometry.index!.array).toEqual(original.index!.array);
        expect(geometry.attributes.uv.array).toEqual(
          original.attributes.uv.array,
        );
        expect(geometryBytes(geometry)).toBe(geometryBytes(original));
        expect(geometry.groups).toEqual([]);
        expect(geometry.morphAttributes).toEqual({});
        expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
        for (const key of ["position", "normal", "uv"]) {
          const attribute = geometry.attributes[key];
          expect(attribute.array).toBeInstanceOf(Float32Array);
          expect(attribute.normalized).toBe(false);
          expect(attribute.array).toEqual(
            repeat["lodGeometries"][lod].attributes[key].array,
          );
          for (const value of attribute.array)
            expect(Number.isFinite(value)).toBe(true);
        }
        expect(geometry.attributes.position.array).not.toEqual(
          original.attributes.position.array,
        );
        const a = new THREE.Vector3(),
          b = new THREE.Vector3(),
          c = new THREE.Vector3();
        for (let i = 0; i < geometry.index!.count; i += 3) {
          a.fromBufferAttribute(
            geometry.attributes.position,
            geometry.index!.getX(i),
          );
          b.fromBufferAttribute(
            geometry.attributes.position,
            geometry.index!.getX(i + 1),
          );
          c.fromBufferAttribute(
            geometry.attributes.position,
            geometry.index!.getX(i + 2),
          );
          expect(b.sub(a).cross(c.sub(a)).length()).toBeGreaterThan(1e-7);
        }
      }
      expect(geometryBytes(candidate["lodGeometries"][1])).toBe(2136);
    } finally {
      baseline.destroy();
      candidate.destroy();
      repeat.destroy();
    }
  });

  it("builds separate four-blade rooted tufts with a shared height hierarchy, narrow widths and independently reconstructed quadratic curves", () => {
    const owner = tuft();
    try {
      const style = NATURAL_TUFT_APPEARANCE;
      expect(style.TUFT_BLADES).toBe(4);
      expect(Object.isFrozen(style)).toBe(true);
      expect(Object.isFrozen(style.TUFT_HEIGHT_FACTORS)).toBe(true);
      expect(Object.isFrozen(style.TUFT_ARC_FACTORS)).toBe(true);
      const heightFactors = [1, 0.62, 0.82, 0.54];
      const arcFactors = [0.35, 1.15, 0.65, 1.35];
      // Independently pinned first-member base heights retain the original
      // deterministic per-blade draw sequence, without importing its generator.
      const expectedBaseHeights = [
        [
          0.2, 0.3013473059, 0.3030034141, 0.3269077651, 0.4036382952,
          0.455648587,
        ],
        [0.2, 0.3421806393, 0.3846700808],
        [0.2],
      ];
      for (const [lod, tier] of GRASS_CONFIG.LOD_TIERS.entries()) {
        const geometry = owner["lodGeometries"][lod];
        const position = geometry.attributes.position,
          normal = geometry.attributes.normal,
          uv = geometry.attributes.uv;
        const vertices = tier.bladeSegments * 2 + 1;
        const groups = tier.bladesPerClump / 4;
        const centers: THREE.Vector3[] = [];
        for (let group = 0; group < groups; group++) {
          const azimuth = group * Math.PI * (3 - Math.sqrt(5));
          const radius = 0.52 * Math.sqrt((group + 0.5) / groups);
          const center = new THREE.Vector3(
            Math.cos(azimuth) * radius,
            0,
            Math.sin(azimuth) * radius,
          );
          centers.push(center);
          const roots: THREE.Vector3[] = [];
          const heights: number[] = [],
            arcs: number[] = [];
          for (let member = 0; member < 4; member++) {
            const root = (group * 4 + member) * vertices;
            const left = new THREE.Vector3().fromBufferAttribute(
              position,
              root,
            );
            const right = new THREE.Vector3().fromBufferAttribute(
              position,
              root + 1,
            );
            const base = left.clone().add(right).multiplyScalar(0.5);
            roots.push(base);
            expect(left.y).toBe(0);
            expect(right.y).toBe(0);
            expect(base.distanceTo(center)).toBeGreaterThanOrEqual(
              0.052 - 1e-7,
            );
            expect(base.distanceTo(center)).toBeLessThanOrEqual(0.065 + 1e-7);
            const tip = new THREE.Vector3().fromBufferAttribute(
              position,
              root + vertices - 1,
            );
            const h = tip.y / 0.92;
            heights.push(h);
            expect(h).toBeGreaterThanOrEqual(
              0.2 * heightFactors[member] - 1e-7,
            );
            expect(h).toBeLessThanOrEqual(0.55 * heightFactors[member] + 1e-7);
            expect(h).toBeCloseTo(
              expectedBaseHeights[lod][group] * heightFactors[member],
              6,
            );
            expect(left.distanceTo(right) / h).toBeCloseTo(0.095, 6);
            const horizontalArc =
              Math.hypot(tip.x - base.x, tip.z - base.z) / h;
            arcs.push(horizontalArc);
            expect(horizontalArc).toBeGreaterThanOrEqual(
              0.48 * 0.8 * arcFactors[member] - 1e-6,
            );
            expect(horizontalArc).toBeLessThanOrEqual(
              0.48 * 1.2 * arcFactors[member] + 1e-6,
            );
            const control = new THREE.Vector3(base.x, h * 0.78, base.z);
            const widthAxis = right.clone().sub(left).normalize();
            for (let v = 0; v < vertices; v++) {
              const index = root + v,
                t = uv.getY(index);
              const expected = base
                .clone()
                .multiplyScalar((1 - t) ** 2)
                .addScaledVector(control, 2 * (1 - t) * t)
                .addScaledVector(tip, t * t)
                .addScaledVector(
                  widthAxis,
                  (2 * uv.getX(index) - 1) *
                    h *
                    0.095 *
                    0.5 *
                    (1 - t * GRASS_CONFIG.BLADE_TAPER),
                );
              const actual = new THREE.Vector3().fromBufferAttribute(
                position,
                index,
              );
              expect(actual.distanceTo(expected)).toBeLessThan(1e-7);
              const tangent = control
                .clone()
                .sub(base)
                .multiplyScalar(2 * (1 - t))
                .addScaledVector(tip.clone().sub(control), 2 * t);
              const expectedNormal = widthAxis
                .clone()
                .cross(tangent)
                .normalize();
              const actualNormal = new THREE.Vector3().fromBufferAttribute(
                normal,
                index,
              );
              expect(actualNormal.length()).toBeCloseTo(1, 6);
              expect(actualNormal.distanceTo(expectedNormal)).toBeLessThan(
                4e-5,
              );
              expect(actualNormal.dot(tangent.clone().normalize())).toBeCloseTo(
                0,
                5,
              );
            }
          }
          for (const a of roots)
            for (const b of roots)
              expect(a.distanceTo(b)).toBeLessThanOrEqual(0.13 + 1e-7);
          for (let member = 0; member < 4; member++)
            expect(heights[member] / heights[0]).toBeCloseTo(
              heightFactors[member],
              6,
            );
          expect(heights[0]).toBeGreaterThan(heights[2]);
          expect(heights[2]).toBeGreaterThan(heights[1]);
          expect(heights[1]).toBeGreaterThan(heights[3]);
          expect(arcs[0]).toBeLessThan(arcs[2]);
          expect(arcs[2]).toBeLessThan(arcs[1]);
          expect(arcs[1]).toBeLessThan(arcs[3]);
        }
        for (let i = 0; i < centers.length; i++)
          for (let j = i + 1; j < centers.length; j++)
            expect(centers[i].distanceTo(centers[j])).toBeGreaterThan(0.2);
      }
    } finally {
      owner.destroy();
    }
  });

  it("is explicit, leaves every omitted-option profile unchanged, and rejects non-dense or invalid opt-ins", () => {
    for (const profile of [
      {},
      STREAMING_GRASS_VISUAL_PROFILE,
      COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      DENSE_MEADOW_GRASS_VISUAL_PROFILE,
    ]) {
      const before = manager(profile),
        candidate = tuft(),
        after = manager(profile);
      try {
        expect(after["material"].name).toBe(before["material"].name);
        expect(after["material"].name).not.toBe(NATURAL_TUFT_APPEARANCE.id);
        for (let lod = 0; lod < 3; lod++) {
          expect(after["lodGeometries"][lod].index!.array).toEqual(
            before["lodGeometries"][lod].index!.array,
          );
          for (const key of ["position", "normal", "uv"])
            expect(after["lodGeometries"][lod].attributes[key].array).toEqual(
              before["lodGeometries"][lod].attributes[key].array,
            );
        }
      } finally {
        before.destroy();
        candidate.destroy();
        after.destroy();
      }
      if (profile !== DENSE_MEADOW_GRASS_VISUAL_PROFILE)
        expect(() =>
          manager(
            profile,
            SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
            true,
            NATURAL_TUFT_APPEARANCE.id,
          ),
        ).toThrow("exact dense meadow profile");
    }
    expect(() =>
      manager(
        { ...DENSE_MEADOW_GRASS_VISUAL_PROFILE, clumpSpacingMultiplier: 1 },
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        true,
        NATURAL_TUFT_APPEARANCE.id,
      ),
    ).toThrow("Compact grass profile mismatch");
    expect(() =>
      manager(
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        true,
        "unknown-tuft" as NonNullable<
          ConstructorParameters<typeof GrassVisualManager>[13]
        >,
      ),
    ).toThrow("exact dense meadow profile");
  });

  it("retains the dense render budget and one opaque texture-free PBR material with sun-independent albedo", () => {
    const owner = tuft();
    try {
      const material = owner["material"];
      expect(material.name).toBe("natural-tuft-v1");
      expect(owner.getProfileReceipt()).toMatchObject({
        profileId: "compact-meadow-v2",
        eligibility: "compact-pbr-v1",
        minimumLodLevel: 1,
        clumpSpacing: 1.75,
        maxRenderDistance: 140,
        maxChunksPerFrame: 1,
        castShadow: false,
      });
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      expect(material.side).toBe(THREE.DoubleSide);
      expect(material.roughness).toBe(1);
      expect(material.metalness).toBe(0);
      expect(material.emissive.getHex()).toBe(0);
      expect(material.lights).toBe(true);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.alphaMap).toBeNull();
      const albedo = graph(material.colorNode!);
      expect(albedo.has(owner.shadeUniforms.tint)).toBe(false);
      expect(albedo.has(owner.shadeUniforms.strength)).toBe(false);
      expect(albedo.has(owner["sunDirUniform"]!)).toBe(false);
      expect(
        [...albedo]
          .filter((n) => n.type === "AttributeNode")
          .map((n) => Reflect.get(n, "_attributeName"))
          .sort(),
      ).toEqual(["instanceGrassTint", "instanceGroundColor", "uv"]);
      const normals = graph(material.normalNode!);
      for (const name of [
        "normal",
        "instanceGroundNormal",
        "instanceRotScaleHash",
      ])
        expect(
          [...normals].some((n) => Reflect.get(n, "_attributeName") === name),
        ).toBe(true);
      expect(normals.has(cameraViewMatrix)).toBe(true);
      expect([...normals].some((n) => n.type === "FrontFacingNode")).toBe(true);
      for (const root of [
        material.positionNode!,
        material.normalNode!,
        material.colorNode!,
      ])
        expect(
          [...graph(root)].some(
            (n) => Reflect.get(n, "isTextureNode") === true,
          ),
        ).toBe(false);
      for (const [height, expected] of [
        [0, [0.128, 0.256, 0.064]],
        [0.5, [0.179, 0.3355, 0.097]],
        [1, [0.23, 0.415, 0.13]],
      ] as const) {
        const actual = colorValue(expand(material.colorNode!), {
          instanceGroundColor: [0.2, 0.4, 0.1],
          instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
          uv: [0.5, height],
        });
        actual.forEach((value, i) =>
          expect(value).toBeCloseTo(expected[i], 12),
        );
      }
    } finally {
      owner.destroy();
    }
  });
});
