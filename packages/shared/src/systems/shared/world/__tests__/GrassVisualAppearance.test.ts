import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE, {
  cameraViewMatrix,
  cameraPosition,
  positionWorld,
  modelWorldMatrix,
  output,
} from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
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
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
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
  appearanceCandidate?: ConstructorParameters<typeof GrassVisualManager>[13],
  habitat?: ConstructorParameters<typeof GrassVisualManager>[14],
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
    undefined,
    undefined,
    undefined,
    appearanceCandidate,
    habitat,
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
  if (node === cameraPosition) return attributes._cameraPosition;
  if (node === positionWorld) return attributes._positionWorld;
  if (node === modelWorldMatrix) return attributes._modelWorldMatrix;
  if (node.type === "FrontFacingNode") return attributes._frontFacing;
  if (node.type === "AttributeNode") {
    const value = attributes[String(read("_attributeName"))];
    if (!value) throw new Error("Unexpected albedo attribute");
    return value;
  }
  const value = read("value");
  if (typeof value === "number") return [value];
  if (
    value instanceof THREE.Vector2 ||
    value instanceof THREE.Vector3 ||
    value instanceof THREE.Vector4 ||
    value instanceof THREE.Matrix4
  )
    return value.toArray();
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
      const dirt = [0.13570346695867627, 0.10530763563352, 0.06788700038018664];
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
      const builder = new THREE.NodeBuilder(null, null);
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
    const signature = (root: Node) => {
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
        else if (
          value instanceof THREE.Vector2 ||
          value instanceof THREE.Vector3 ||
          value instanceof THREE.Vector4 ||
          value instanceof THREE.Matrix3 ||
          value instanceof THREE.Matrix4
        )
          fields.value = value.toArray();
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

  it("keeps the revised slender leaf and non-emissive albedo contract explicit", () => {
    expect(FINE_MEADOW_APPEARANCE).toEqual({
      id: "fine-meadow-v1",
      BLADE_HEIGHT_MIN: 0.38,
      BLADE_HEIGHT_MAX: 0.86,
      BLADE_WIDTH_RATIO: 0.045,
      BLADE_TAPER: 0.85,
      BLADE_TAPER_POWER: 1,
      BLADE_ARC_RATIO: 0.48,
      BLADE_CONTROL_HEIGHT: 0.76,
      BLADE_TIP_HEIGHT: 0.95,
      BLADE_NORMAL_WEIGHT: 0.2,
      ROOT_BRIGHTNESS: 0.9,
      TIP_BRIGHTNESS: 1.2,
      ROOT_OCCLUSION: 0.55,
      ROOT_OCCLUSION_END: 0.6,
      GRAZING_GAIN: 0.35,
      GRAZING_GAIN_ROOT_START: 0.05,
      GRAZING_GAIN_ROOT_END: 0.65,
      PROGRESSIVE_ROOTS: true,
    });
    const owner = fine();
    try {
      const albedo = expand(owner["material"].colorNode!);
      for (const [height, expected] of [
        [0, [0.18, 0.36, 0.09]],
        [0.5, [0.228, 0.429, 0.123]],
        [1, [0.276, 0.498, 0.156]],
      ] as const) {
        const actual = colorValue(albedo, {
          instanceGroundColor: [0.2, 0.4, 0.1],
          instanceGrassTint: [0.3, 0.45, 0.2, 0.3],
          instanceGroundNormal: [0, 1, 0],
          // Overhead gain=0 preserves this historical base-albedo oracle.
          _cameraPosition: [350, 40, 320],
          _positionWorld: [350, 28, 320],
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

  it("uses independent slender roots with deterministic prefix-stable detail tiers", () => {
    const owner = fine();
    const repeated = fine();
    try {
      const geometries = owner["lodGeometries"];
      for (let lod = 0; lod < 3; lod++) {
        const geometry = geometries[lod];
        // The arc changes positions/normals at every tier. Keep historical
        // hashes as provenance, not newly blessed output snapshots; the exact
        // lateral change is independently checked against archived bytes below.
        expect(geometryDigest(geometry)).not.toBe(historicalHashes[lod]);
        expect(geometryDigest(geometry)).toBe(
          geometryDigest(repeated["lodGeometries"][lod]),
        );
        const tier = GRASS_CONFIG.LOD_TIERS[lod];
        const stride = tier.bladeSegments * 2 + 1;
        const positions = geometry.getAttribute("position");
        const normals = geometry.getAttribute("normal");
        expect(positions.count).toBe(tier.bladesPerClump * stride);
        expect(geometry.index!.count / 3).toBe(
          tier.bladesPerClump * (tier.bladeSegments * 2 - 1),
        );
        expect(Object.keys(geometry.attributes).sort()).toEqual([
          "normal",
          "position",
          "uv",
        ]);
        for (const attribute of ["position", "normal", "uv"]) {
          expect(geometry.attributes[attribute].array).toEqual(
            repeated["lodGeometries"][lod].attributes[attribute].array,
          );
        }
        const roots: THREE.Vector3[] = [];
        for (let blade = 0; blade < tier.bladesPerClump; blade++) {
          const base = blade * stride;
          const left = new THREE.Vector3().fromBufferAttribute(positions, base);
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
            const nearBase = blade * 7;
            for (const [currentVertex, nearVertex] of [
              [base, nearBase],
              [base + 1, nearBase + 1],
              [base + stride - 1, nearBase + 6],
            ]) {
              for (const attribute of ["position", "normal"]) {
                expect(
                  new THREE.Vector3()
                    .fromBufferAttribute(
                      geometry.attributes[attribute],
                      currentVertex,
                    )
                    .toArray(),
                ).toEqual(
                  new THREE.Vector3()
                    .fromBufferAttribute(near.attributes[attribute], nearVertex)
                    .toArray(),
                );
              }
            }
          }
        }
        // Each tier covers the clump disk, rather than retaining only short
        // stems clustered at its center when detail is reduced.
        expect(Math.max(...roots.map((root) => root.length()))).toBeGreaterThan(
          0.58,
        );
        expect(roots.some((root) => root.x > 0.2)).toBe(true);
        expect(roots.some((root) => root.x < -0.2)).toBe(true);
        expect(
          new Set(roots.map((root) => root.toArray().join(","))).size,
        ).toBe(roots.length);
      }
    } finally {
      owner.destroy();
      repeated.destroy();
    }
  });

  it("changes only the archived linear centerline arc and analytic normals while retaining the explicit leaf-area cost", () => {
    const owner = fine();
    try {
      for (const saved of historicalFineTemplates) {
        const lod = saved.lod;
        const geometry = owner["lodGeometries"][lod];
        const positions = geometry.getAttribute("position");
        const normals = geometry.getAttribute("normal");
        const oldValues = new Float32Array(
          Uint8Array.from(Buffer.from(saved.positionBase64, "base64")).buffer,
        );
        const original = new THREE.BufferAttribute(oldValues, 3);
        expect(digest(oldValues)).toBe(saved.hashes.position);
        expect(digest(normals.array)).not.toBe(saved.hashes.normal);
        expect(digest(geometry.getAttribute("uv").array)).toBe(saved.hashes.uv);
        expect(digest(geometry.index!.array)).toBe(saved.hashes.index);
        expect(digest(positions.array)).not.toBe(saved.hashes.position);
        const { bladesPerClump: blades, bladeSegments: segments } =
          GRASS_CONFIG.LOD_TIERS[lod];
        const stride = segments * 2 + 1;
        let linearArea = 0;
        let shoulderArea = 0;
        for (let blade = 0; blade < blades; blade++) {
          const base = blade * stride;
          const rootLeft = new THREE.Vector3().fromBufferAttribute(
            original,
            base,
          );
          const rootRight = new THREE.Vector3().fromBufferAttribute(
            original,
            base + 1,
          );
          const maximumWidth = rootLeft.distanceTo(rootRight);
          const rootCenter = rootLeft
            .clone()
            .add(rootRight)
            .multiplyScalar(0.5);
          const sideAxis = rootRight.clone().sub(rootLeft).normalize();
          const oldTip = new THREE.Vector3().fromBufferAttribute(
            original,
            base + stride - 1,
          );
          const arcDelta = oldTip.clone().sub(rootCenter).setY(0);
          const height = original.getY(base + stride - 1) / 0.95;
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
            const oldLeft = new THREE.Vector3().fromBufferAttribute(
              original,
              base + offset,
            );
            const right = tip
              ? left.clone()
              : new THREE.Vector3().fromBufferAttribute(
                  positions,
                  base + offset + 1,
                );
            const oldRight = tip
              ? oldLeft.clone()
              : new THREE.Vector3().fromBufferAttribute(
                  original,
                  base + offset + 1,
                );
            const center = left.clone().add(right).multiplyScalar(0.5);
            const oldCenter = oldLeft.clone().add(oldRight).multiplyScalar(0.5);
            const t = row / segments;
            // Arc .48 / historical .30 = 1.6. The frozen native03 coordinates
            // supply the root, side axis and displacement independently of the
            // current generator. Every edge moves by the same lateral delta.
            const lateralChange = oldCenter
              .clone()
              .sub(rootCenter)
              .setY(0)
              .multiplyScalar(0.6);
            for (const [actual, old] of [
              [left, oldLeft],
              [right, oldRight],
            ]) {
              expect(actual.y).toBe(old.y);
              const expected = old.clone().add(lateralChange);
              // Source and expected coordinates have independent Float32 edge
              // rounding; retain a two-ulp-scale absolute comparison.
              expect(actual.distanceTo(expected)).toBeLessThan(2e-7);
              if (row === 0) expect(actual.toArray()).toEqual(old.toArray());
            }
            expect(
              center.distanceTo(
                rootCenter
                  .clone()
                  .addScaledVector(arcDelta, 1.6 * t * t)
                  .setY(height * (1.52 * t - 0.57 * t * t)),
              ),
            ).toBeLessThan(2e-7);
            const tangent = arcDelta
              .clone()
              .multiplyScalar(3.2 * t)
              .setY(height * (1.52 - 1.14 * t));
            const expectedNormal = sideAxis.clone().cross(tangent).normalize();
            for (const vertex of tip
              ? [base + offset]
              : [base + offset, base + offset + 1]) {
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
            expect(Math.abs(width - oldLeft.distanceTo(oldRight))).toBeLessThan(
              2e-7,
            );
            expect(width).toBeLessThanOrEqual(maximumWidth + 1.3e-7);
            // Explicit formulas are independent of the generator's taper
            // fields and helper. The last vertex remains a single point.
            expect(width).toBeCloseTo(
              tip ? 0 : maximumWidth * (1 - 0.85 * t),
              6,
            );
            const oldShoulderWidth = maximumWidth * (1 - t * t);
            expect(center.y).toBeCloseTo(height * (1.52 * t - 0.57 * t * t), 7);
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
        }
        // Independent piecewise trapezoid integrals at the actual vertex rows.
        const expectedRatio = lod === 0 ? 21736 / 36000 / (3781 / 5400) : 7 / 8;
        expect(linearArea / shoulderArea).toBeCloseTo(expectedRatio, 5);
        expect(linearArea).toBeLessThan(shoulderArea);
        // This loss is a geometric cost of the finer silhouette, not a claim
        // of improved visible density: approximately 13.77% near / 12.5% mid.
        console.info("Fine swept-arc linear taper source geometry", {
          lod,
          linearArea,
          shoulderArea,
          ratio: linearArea / shoulderArea,
          reductionFraction: 1 - linearArea / shoulderArea,
          positionSHA256: digest(positions.array),
        });
      }
    } finally {
      owner.destroy();
    }
  });

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
