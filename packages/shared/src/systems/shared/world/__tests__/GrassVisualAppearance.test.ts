import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE, {
  cameraViewMatrix,
  output,
} from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  COMPACT_MEADOW_APPEARANCE,
  CURVED_MEADOW_APPEARANCE,
  GRASS_CONFIG,
  GrassVisualManager,
  STREAMING_GRASS_VISUAL_PROFILE,
  type GrassVisualProfile,
  type GrassWorkerSetup,
} from "../GrassVisualManager";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
} from "../WorldTerrainProfile";

/** Real geometry/material construction; no renderer or GPU is simulated. */
function manager(
  profile: GrassVisualProfile = {},
  terrain = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  withWorkerSetup = true,
) {
  const config = createTerrainWorkerConfig(terrain, 16);
  const setup: GrassWorkerSetup = {
    terrainConfig: config,
    seed: terrain.seed,
    biomeCenters: [],
    biomes: {},
    grassConfigs: {},
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
  );
}

// Expand the actual material's construction-time Fn, not a replacement shader.
function expand(node: Node): Node {
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

function graph(root: Node): Set<Node> {
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
  node: Node,
  attributes: Record<string, number[]>,
): number[] {
  const read = (key: string): unknown => Reflect.get(node, key);
  const child = (key: string): number[] => {
    const value = read(key);
    if (!(value instanceof THREE.Node))
      throw new Error(
        `Missing ${key} on ${node.type}: ${Object.keys(node).join(",")}`,
      );
    return colorValue(value, attributes);
  };
  if (node === cameraViewMatrix) return attributes._cameraViewMatrix;
  if (node.type === "FrontFacingNode") return attributes._frontFacing;
  if (node.type === "AttributeNode") {
    const value = attributes[String(read("_attributeName"))];
    if (!value) throw new Error("Unexpected albedo attribute");
    return value;
  }
  const value = read("value");
  if (typeof value === "number") return [value];
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
    return nodes.flatMap((n) => colorValue(n, attributes));
  }
  if (node.type === "SplitNode")
    return [...String(read("components"))].map(
      (component) => child("node")["xyzw".indexOf(component)],
    );
  const aValues = child("aNode");
  if (read("method") === "normalize") {
    const length = Math.hypot(...aValues);
    return aValues.map((x) => x / length);
  }
  if (read("method") === "sin") return aValues.map(Math.sin);
  if (read("method") === "cos") return aValues.map(Math.cos);
  if (read("method") === "negate") return aValues.map((x) => -x);
  const operands = [aValues, child("bNode")];
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
                camera.position.set(...view);
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
