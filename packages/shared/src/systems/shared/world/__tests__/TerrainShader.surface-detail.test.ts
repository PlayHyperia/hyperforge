import { describe, expect, it } from "vitest";
import THREE, { float, uniform } from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import {
  TERRAIN_SURFACE_DETAIL,
  createTerrainMaterial,
  createTerrainSurfaceRoughnessNode,
} from "../TerrainShader";

// Inspect the actual arithmetic TSL DAG. Unknown operations fail closed; this
// is not a shader compiler, mock renderer, visual test or GPU performance claim.
function scalar(node: Node): number {
  const read = (key: string): unknown => Reflect.get(node, key);
  const input = (key: string): number => {
    const child = read(key);
    if (!(child instanceof THREE.Node)) throw new Error(`Missing ${key}`);
    return scalar(child);
  };
  if (typeof read("value") === "number") return read("value") as number;
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return input("node");
  const op = read("op");
  if (op === "+") return input("aNode") + input("bNode");
  if (op === "-") return input("aNode") - input("bNode");
  if (op === "*") return input("aNode") * input("bNode");
  const method = read("method");
  if (method === "clamp")
    return Math.max(input("bNode"), Math.min(input("cNode"), input("aNode")));
  if (method === "mix") {
    const a = input("aNode");
    return a + (input("bNode") - a) * input("cNode");
  }
  if (method === "smoothstep") {
    const a = input("aNode");
    const t = Math.max(
      0,
      Math.min(1, (input("cNode") - a) / (input("bNode") - a)),
    );
    return t * t * (3 - 2 * t);
  }
  throw new Error(`Unsupported real node ${node.type}/${String(op ?? method)}`);
}

function nodes(root: Node): Set<Node> {
  const seen = new Set<Node>();
  const visit = (node: Node) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return seen;
}

function textures(root: Node): Set<THREE.Texture> {
  const result = new Set<THREE.Texture>();
  for (const node of nodes(root)) {
    const value: unknown = Reflect.get(node, "value");
    if (value instanceof THREE.Texture) result.add(value);
  }
  return result;
}

function roughness(
  strength: number,
  distance: number,
  dirt: number,
  cliff: number,
  detail: number,
) {
  return scalar(
    createTerrainSurfaceRoughnessNode(
      float(strength),
      float(distance ** 2),
      float(dirt),
      float(cliff),
      float(detail),
    ),
  );
}

describe("opt-in terrain surface detail (real CPU graph scope)", () => {
  it("keeps the exact default matte response for every sampled surface", () => {
    for (const distance of [0, 55, 80, 110, 1000])
      for (const dirt of [-1, 0, 0.5, 1, 2])
        for (const cliff of [-1, 0, 0.5, 1, 2])
          for (const detail of [-100, 0.5, 100])
            expect(roughness(0, distance, dirt, cliff, detail)).toBe(1);
  });

  it("distinguishes grass, dirt and cliff without creating polished surfaces", () => {
    expect(roughness(1, 0, 0, 0, 0.5)).toBeCloseTo(
      TERRAIN_SURFACE_DETAIL.GRASS_ROUGHNESS,
      12,
    );
    expect(roughness(1, 0, 1, 0, 0.5)).toBeCloseTo(
      TERRAIN_SURFACE_DETAIL.DIRT_ROUGHNESS,
      12,
    );
    expect(roughness(1, 0, 1, 1, 0.5)).toBeCloseTo(
      TERRAIN_SURFACE_DETAIL.CLIFF_ROUGHNESS,
      12,
    );
    for (const dirt of [-10, 0, 0.5, 1, 10])
      for (const cliff of [-10, 0, 0.5, 1, 10])
        for (const detail of [-100, 0, 0.5, 1, 100]) {
          const result = roughness(1, 0, dirt, cliff, detail);
          expect(result).toBeGreaterThanOrEqual(
            TERRAIN_SURFACE_DETAIL.MIN_ROUGHNESS,
          );
          expect(result).toBeLessThanOrEqual(
            TERRAIN_SURFACE_DETAIL.MAX_ROUGHNESS,
          );
        }
  });

  it("fades only microvariation with distance and clamps the opt-in strength", () => {
    const base = TERRAIN_SURFACE_DETAIL.CLIFF_ROUGHNESS;
    expect(roughness(1, 55, 0, 1, 1)).toBeCloseTo(base + 0.03, 12);
    expect(roughness(1, 80, 0, 1, 1)).toBeGreaterThan(base);
    expect(roughness(1, 80, 0, 1, 1)).toBeLessThan(base + 0.03);
    expect(roughness(1, 110, 0, 1, 1)).toBeCloseTo(base, 12);
    expect(roughness(1, 1000, 0, 1, 0)).toBeCloseTo(base, 12);
    expect(roughness(-5, 0, 0, 1, 1)).toBe(1);
    expect(roughness(5, 0, 0, 1, 1)).toBe(roughness(1, 0, 0, 1, 1));
    const blend = uniform(0);
    const graph = createTerrainSurfaceRoughnessNode(
      blend,
      float(0),
      float(0),
      float(1),
      float(0.5),
    );
    expect(scalar(graph)).toBe(1);
    blend.value = 0.5;
    expect(scalar(graph)).toBeCloseTo((1 + base) / 2, 12);
  });

  it("owns default-off uniforms per material and leaves albedo, normals and geometry alone", () => {
    const first = createTerrainMaterial();
    const second = createTerrainMaterial();
    try {
      expect(first.terrainUniforms.surfaceDetailStrength.value).toBe(0);
      expect(second.terrainUniforms.surfaceDetailStrength.value).toBe(0);
      expect(first.terrainUniforms.surfaceDetailStrength).not.toBe(
        second.terrainUniforms.surfaceDetailStrength,
      );
      const albedo = first.colorNode;
      const version = first.version;
      expect(first.roughnessNode).toBeTruthy();
      expect(first.normalNode).toBeNull();
      expect(first.positionNode).toBeNull();
      expect(first.roughness).toBe(1);
      first.terrainUniforms.surfaceDetailStrength.value = 1;
      expect(first.version).toBe(version);
      expect(first.colorNode).toBe(albedo);
      expect(second.terrainUniforms.surfaceDetailStrength.value).toBe(0);
      expect(nodes(first.roughnessNode!)).toContain(
        first.terrainUniforms.surfaceDetailStrength,
      );
      expect(nodes(first.colorNode!)).not.toContain(
        first.terrainUniforms.surfaceDetailStrength,
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("reuses existing albedo texture objects without adding normal or displacement assets", () => {
    const material = createTerrainMaterial();
    try {
      const existing = textures(material.colorNode!);
      const detail = textures(material.roughnessNode!);
      expect(detail.size).toBe(4); // existing grass, dirt, cliff and shared noise
      for (const texture of detail) expect(existing).toContain(texture);
      expect(material.normalMap).toBeNull();
      expect(material.bumpMap).toBeNull();
      expect(material.displacementMap).toBeNull();
      expect(material.metalness).toBe(0);
    } finally {
      material.dispose();
    }
  });
});
