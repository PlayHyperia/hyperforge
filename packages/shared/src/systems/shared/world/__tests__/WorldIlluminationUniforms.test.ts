import { describe, expect, it } from "vitest";
import THREE, {
  vec3,
  type Node,
  reflector,
} from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { WorldIlluminationUniforms } from "../WorldIlluminationUniforms";
import { createTreeDissolveMaterial } from "../GPUMaterials";
import { WaterSystem } from "../WaterSystem";

// Real Three TSL graphs and real World/material factories. CPU graph/ownership
// controls only: no mock renderer, shader compilation, pixel or GPU claim.
function unwrap(node: Node): Node {
  while (Reflect.get(node, "isVarNode")) {
    const inner: unknown = Reflect.get(node, "node");
    if (!(inner instanceof THREE.Node)) throw new Error("Invalid real VarNode");
    node = inner;
  }
  return node;
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

function outputGraph(material: THREE.MeshStandardNodeMaterial): Node {
  if (!material.outputNode) throw new Error("Missing output graph");
  const node = unwrap(material.outputNode);
  const shader = Reflect.get(node, "shaderNode");
  const callback: unknown = shader && Reflect.get(shader, "jsFunc");
  if (typeof callback !== "function") throw new Error("Expected actual TSL Fn");
  const result: unknown = callback(); // These zero-input factories require no builder.
  if (!(result instanceof THREE.Node)) throw new Error("Not a real Three node");
  return result;
}

// Bounded numeric inspection of ONLY the actual helper's arithmetic DAG.
// Unknown nodes fail; this is not a substitute for real WebGPU evaluation.
function numeric(node: Node): number[] {
  node = unwrap(node);
  const get = (key: string): unknown => Reflect.get(node, key);
  const input = (key: string): number[] => {
    const child = get(key);
    if (!(child instanceof THREE.Node)) throw new Error(`Missing ${key}`);
    return numeric(child);
  };
  const value = get("value");
  if (typeof value === "number") return [value];
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (value instanceof THREE.Vector3) return value.toArray();
  if (node.type === "JoinNode")
    return (get("nodes") as Node[]).flatMap(numeric);
  if (node.type === "ConvertNode") return input("node");
  if (node.type === "SplitNode") {
    const components = get("components");
    if (typeof components !== "string" || !/^[xyzw]{1,4}$/.test(components))
      throw new Error("Unsupported real swizzle components");
    const source = input("node");
    return [...components].map((component) => {
      const value = source["xyzw".indexOf(component)];
      if (!Number.isFinite(value)) throw new Error("Swizzle exceeds source");
      return value;
    });
  }
  const op = get("op"),
    method = get("method");
  const pair = (fn: (a: number, b: number) => number): number[] => {
    const a = input("aNode"),
      b = input("bNode");
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      fn(a[i % a.length], b[i % b.length]),
    );
  };
  if (op === "+") return pair((a, b) => a + b);
  if (op === "*") return pair((a, b) => a * b);
  if (method === "max") return pair(Math.max);
  if (method === "normalize") {
    const a = input("aNode"),
      norm = Math.hypot(...a);
    return a.map((v) => v / norm);
  }
  if (method === "dot")
    return [pair((a, b) => a * b).reduce((a, b) => a + b, 0)];
  throw new Error(
    `Unsupported numeric node ${node.constructor.name}/${String(op ?? method)}`,
  );
}

describe("custom world illumination (CPU real-graph scope)", () => {
  it("reads actual color channels without decoding, reordering or stale values", () => {
    const u = new WorldIlluminationUniforms();
    const rgb = u.keyColor.rgb;
    const bgr = u.keyColor.bgr;
    const builder = new THREE.NodeBuilder(null, null);
    u.keyColor.value.setRGB(0.125, 0.75, 4);
    expect(rgb.getNodeType(builder)).toBe("vec3");
    expect(numeric(rgb)).toEqual([0.125, 0.75, 4]);
    expect(numeric(bgr)).toEqual([4, 0.75, 0.125]);
    u.keyColor.value.setRGB(3, 2, 1);
    expect(numeric(rgb)).toEqual([3, 2, 1]);
    expect(numeric(bgr)).toEqual([1, 2, 3]);
  });

  it("owns independent default-off real uniforms with exact linear defaults", () => {
    const a = new WorldIlluminationUniforms(),
      b = new WorldIlluminationUniforms();
    expect(a.blend.value).toBe(0);
    expect(a.keyColor.value.toArray()).toEqual([1, 1, 1]);
    expect(a.fillColor.value.toArray()).toEqual([0, 0, 0]);
    expect(a.keyDirection.value.toArray()).toEqual([0, 1, 0]);
    expect(a.keyDirection.value).not.toBe(b.keyDirection.value);
    expect(a.keyColor).not.toBe(b.keyColor);
    expect(a.keyColor.value).not.toBe(b.keyColor.value);
    a.keyColor.value.setRGB(0.2, 0.3, 0.4);
    expect(b.keyColor.value.toArray()).toEqual([1, 1, 1]);
  });

  it.each([
    [0, 2, 0],
    [0, -2, 0],
    [2, 0, 0],
    [2, 2, 0],
  ])(
    "uses geometric clamped cosine and irradiance/PI for normal (%s,%s,%s)",
    (x, y, z) => {
      const u = new WorldIlluminationUniforms();
      u.keyColor.value.setRGB(1, 2, 3);
      u.fillColor.value.setRGB(0.1, 0.2, 0.3);
      u.keyDirection.value.set(0, 5, 0);
      const graph = u.diffuse(vec3(0.2, 0.4, 0.6), vec3(x, y, z));
      const cosine = Math.max(y / Math.hypot(x, y, z), 0);
      const expected = [0.2, 0.4, 0.6].map(
        (a, i) => (a * ((i + 1) * cosine + (i + 1) * 0.1)) / Math.PI,
      );
      numeric(graph).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 14));
      expect(nodes(graph).has(u.keyColor)).toBe(true);
      expect(nodes(graph).has(u.fillColor)).toBe(true);
      expect(nodes(graph).has(u.keyDirection)).toBe(true);
    },
  );

  it("responds to live values without graph rebuild and has no unlit diffuse floor", () => {
    const u = new WorldIlluminationUniforms();
    const graph = u.diffuse(vec3(0.3, 0.5, 0.7), vec3(0, 1, 0));
    const members = [...nodes(graph)];
    u.keyColor.value.setRGB(0, 0, 0);
    expect(numeric(graph)).toEqual([0, 0, 0]);
    u.fillColor.value.setRGB(Math.PI, Math.PI, Math.PI);
    expect(numeric(graph)).toEqual([0.3, 0.5, 0.7]);
    expect(numeric(u.fillRadiance())).toEqual([1, 1, 1]);
    expect([...nodes(graph)]).toEqual(members);
  });

  it("uses explicit actual light-target direction, including positional Y offset", () => {
    const u = new WorldIlluminationUniforms(),
      light = new THREE.DirectionalLight();
    light.position.set(400, 100, 0);
    light.target.position.set(0, 0, 0);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
    const target = light.target.getWorldPosition(new THREE.Vector3());
    light.getWorldPosition(u.keyDirection.value).sub(target);
    const graph = u.diffuse(vec3(1, 1, 1), vec3(0, 1, 0));
    const expected = 100 / Math.hypot(400, 100) / Math.PI;
    numeric(graph).forEach((v) => expect(v).toBeCloseTo(expected, 14));
    u.keyDirection.value.negate();
    expect(numeric(graph)).toEqual([0, 0, 0]);
    light.dispose();
  });

  it("retains the exact legacy branch at blend<=0 and clamps the mixed branch", () => {
    const u = new WorldIlluminationUniforms(),
      legacy = vec3(0.1, 0.2, 0.3);
    const candidate = vec3(0.7, 0.8, 0.9),
      graph = u.select(legacy, candidate);
    expect(Reflect.get(graph, "ifNode")).toBe(legacy);
    const condition = unwrap(Reflect.get(graph, "condNode"));
    expect(Reflect.get(condition, "op")).toBe("<=");
    expect(Reflect.get(condition, "aNode")).toBe(u.blend);
    expect(Reflect.get(Reflect.get(condition, "bNode"), "value")).toBe(0);
    expect(
      [...nodes(graph)].some((n) => Reflect.get(n, "method") === "clamp"),
    ).toBe(true);
    for (const blend of [0, 1, 0.5, 0]) {
      u.blend.value = blend;
      expect(Reflect.get(graph, "ifNode")).toBe(legacy);
    }
  });

  it("wires actual tree uniforms into RGB without changing source maps or vertex path", () => {
    const map = new THREE.DataTexture(
      new Uint8Array([255, 128, 64, 255]),
      1,
      1,
    );
    const source = new THREE.MeshStandardMaterial({ map, vertexColors: true });
    const before = source.toJSON();
    const a = createTreeDissolveMaterial(source),
      b = createTreeDissolveMaterial(source);
    try {
      const graph = outputGraph(a),
        all = nodes(graph),
        u = a.treeUniforms.illumination;
      for (const uniform of [u.blend, u.keyColor, u.fillColor, u.keyDirection])
        expect(all.has(uniform)).toBe(true);
      expect(u).not.toBe(b.treeUniforms.illumination);
      expect(a.map).toBe(map);
      expect(a.positionNode).toBeTruthy();
      expect(a.opacityNode).toBeTruthy();
      expect(a.alphaTest).toBe(0.5);
      expect(a.fog).toBe(false);
      expect(source.toJSON()).toEqual(before);
      const version = a.version,
        output = a.outputNode,
        position = a.positionNode;
      u.blend.value = 1;
      u.keyColor.value.setRGB(0.8, 0.9, 1);
      expect(a.version).toBe(version);
      expect(a.outputNode).toBe(output);
      expect(a.positionNode).toBe(position);
    } finally {
      a.dispose();
      b.dispose();
      source.dispose();
      map.dispose();
    }
  });

  it("wires both real WaterSystem material factories independently without init/render", () => {
    const world = new World(),
      system = new WaterSystem(world);
    for (const key of ["normalTex", "flowTex", "foamTex"]) {
      Reflect.set(
        system,
        key,
        new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
      );
    }
    Reflect.set(system, "reflection", reflector());
    try {
      for (const type of ["lake", "ocean"] as const) {
        const method: unknown = Reflect.get(
          system,
          type === "lake" ? "createLakeMaterial" : "createOceanMaterial",
        );
        if (typeof method !== "function")
          throw new Error("Missing actual factory");
        const material: THREE.MeshStandardNodeMaterial = method.call(system);
        Reflect.set(
          system,
          type === "lake" ? "lakeMaterial" : "oceanMaterial",
          material,
        );
        const row = system.waterUniformsByType[type];
        if (!row) throw new Error(`Missing ${type} uniforms`);
        const all = nodes(outputGraph(material)),
          u = row.illumination;
        for (const uniform of [
          u.blend,
          u.keyColor,
          u.fillColor,
          u.keyDirection,
        ])
          expect(all.has(uniform)).toBe(true);
        expect(u.blend.value).toBe(0);
        const version = material.version,
          position = material.positionNode,
          opacity = material.opacityNode;
        u.blend.value = 1;
        u.fillColor.value.setRGB(0.1, 0.2, 0.3);
        u.keyDirection.value.set(4, 1, 0);
        system.update(0.1);
        expect(u.blend.value).toBe(1);
        expect(u.fillColor.value.toArray()).toEqual([0.1, 0.2, 0.3]);
        expect(u.keyDirection.value.toArray()).toEqual([4, 1, 0]);
        expect(material.version).toBe(version);
        expect(material.positionNode).toBe(position);
        expect(material.opacityNode).toBe(opacity);
      }
      expect(system.waterUniformsByType.lake?.illumination).not.toBe(
        system.waterUniformsByType.ocean?.illumination,
      );
    } finally {
      system.destroy();
      world.destroy();
    }
  });
});
