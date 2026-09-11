import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import THREE, {
  positionLocal,
  type Node,
} from "../../../../extras/three/three";
import { sampleSkyCycle, SkySystem } from "../SkySystem";

// Actual CPU Three objects/TSL graph constructors only. These controls do not
// initialize a renderer, compile a shader, capture PMREM, or approve artwork.
function skyMesh(
  scene: THREE.Scene,
): THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicNodeMaterial> {
  const mesh = scene.getObjectByName("LightingCaptureSky");
  if (
    !(mesh instanceof THREE.Mesh) ||
    !(mesh.geometry instanceof THREE.SphereGeometry) ||
    !(mesh.material instanceof THREE.MeshBasicNodeMaterial)
  )
    throw new Error("Missing actual sky mesh");
  return mesh;
}

function graphNodes(root: Node): Set<Node> {
  const seen = new Set<Node>();
  const visit = (node: Node) => {
    if (seen.has(node)) return;
    if (seen.size > 2048) throw new Error("Capture graph inspection bound");
    seen.add(node);
    const shader: unknown = Reflect.get(node, "shaderNode");
    if (shader && typeof shader === "object") {
      const callback: unknown = Reflect.get(shader, "jsFunc");
      if (typeof callback === "function") {
        // The literal starless factory is a zero-argument TSL Fn. Expand its
        // real graph without providing a substitute builder or renderer.
        const result: unknown = callback();
        if (!(result instanceof THREE.Node))
          throw new Error("Invalid TSL graph");
        visit(result);
      }
    }
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return seen;
}

function uniformValues(nodes: Set<Node>): unknown[] {
  return [...nodes]
    .filter((node) => Reflect.get(node, "isUniformNode") === true)
    .map((node) => Reflect.get(node, "value"));
}

// Bounded double-precision interpretation of this real TSL arithmetic DAG.
// positionLocal is the explicit query input. Unknown nodes fail closed; this
// checks CPU/formula parity, not WGSL float precision, texture filtering or GPU.
function skyGraphEvaluator(root: Node) {
  const expanded = new Map<Node, Node>();
  const evaluate = (node: Node, direction: THREE.Vector3): number[] => {
    if (node === positionLocal) return direction.toArray();
    const get = (key: string): unknown => Reflect.get(node, key);
    const input = (key: string): number[] => {
      const child = get(key);
      if (!(child instanceof THREE.Node)) throw new Error(`Missing ${key}`);
      return evaluate(child, direction);
    };
    if (get("isVarNode")) return input("node");
    const shader = get("shaderNode");
    if (shader && typeof shader === "object") {
      let graph = expanded.get(node);
      if (!graph) {
        const callback: unknown = Reflect.get(shader, "jsFunc");
        if (typeof callback !== "function")
          throw new Error("Invalid TSL factory");
        const result: unknown = callback();
        if (!(result instanceof THREE.Node))
          throw new Error("Invalid TSL output");
        graph = result;
        expanded.set(node, graph);
      }
      return evaluate(graph, direction);
    }
    const value = get("value");
    if (typeof value === "number") return [value];
    if (value instanceof THREE.Color || value instanceof THREE.Vector3)
      return value.toArray();
    if (node.type === "JoinNode") {
      const children = get("nodes");
      if (
        !Array.isArray(children) ||
        !children.every((child) => child instanceof THREE.Node)
      )
        throw new Error("Invalid join");
      return children.flatMap((child) => evaluate(child, direction));
    }
    if (node.type === "ConvertNode") return input("node");
    if (node.type === "SplitNode") {
      const components = get("components");
      if (typeof components !== "string" || !/^[xyzw]{1,4}$/.test(components))
        throw new Error("Unsupported swizzle");
      const source = input("node");
      return [...components].map(
        (component) => source["xyzw".indexOf(component)],
      );
    }
    const pair = (fn: (a: number, b: number) => number) => {
      const a = input("aNode"),
        b = input("bNode");
      return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
        fn(a[i % a.length], b[i % b.length]),
      );
    };
    const triple = (fn: (a: number, b: number, c: number) => number) => {
      const a = input("aNode"),
        b = input("bNode"),
        c = input("cNode");
      return Array.from(
        { length: Math.max(a.length, b.length, c.length) },
        (_, i) => fn(a[i % a.length], b[i % b.length], c[i % c.length]),
      );
    };
    switch (get("op")) {
      case "+":
        return pair((a, b) => a + b);
      case "-":
        return pair((a, b) => a - b);
      case "*":
        return pair((a, b) => a * b);
    }
    switch (get("method")) {
      case "abs":
        return input("aNode").map(Math.abs);
      case "normalize": {
        const a = input("aNode"),
          length = Math.hypot(...a);
        return a.map((value) => value / length);
      }
      case "dot":
        return [pair((a, b) => a * b).reduce((a, b) => a + b, 0)];
      case "pow":
        return pair(Math.pow);
      case "mix":
        return triple((a, b, t) => a * (1 - t) + b * t);
      case "clamp":
        return triple((x, a, b) => Math.max(a, Math.min(b, x)));
      case "smoothstep":
        return triple((a, b, x) => {
          const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
          return t * t * (3 - 2 * t);
        });
    }
    throw new Error(
      `Unsupported actual sky node ${node.type}/${String(get("method"))}`,
    );
  };
  return (direction: THREE.Vector3) => evaluate(root, direction);
}

// Independent copy of the pre-extraction cycle equations, including thresholds.
function originalCycle(phase: number) {
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  let intensity: number;
  if (phase < 0.22 || phase >= 0.78) intensity = 0;
  else if (phase < 0.28) intensity = smooth(0.22, 0.28, phase);
  else if (phase < 0.72)
    intensity = 0.85 + (1 - Math.abs(phase - 0.5) * 2) * (1 - 0.85);
  else intensity = 1 - smooth(0.72, 0.78, phase);
  const angle = (phase - 0.25) * Math.PI * 2;
  const elevation = Math.sin(angle),
    azimuth = Math.cos(angle);
  return {
    intensity,
    direction: new THREE.Vector3(
      azimuth * Math.max(0.1, 1 - Math.abs(elevation)),
      elevation,
      0.3 * azimuth,
    ).normalize(),
  };
}

describe("isolated sky lighting capture", () => {
  it("preserves actual cycle equations and the caller's direction identity", () => {
    const direction = new THREE.Vector3();
    const phases = [
      ...Array.from({ length: 1001 }, (_, i) => i / 1000),
      ...[0.22, 0.25, 0.28, 0.5, 0.72, 0.75, 0.78].flatMap((p) => [
        p - 1e-12,
        p,
        p + 1e-12,
      ]),
    ];
    for (const phase of phases) {
      const expected = originalCycle(phase);
      expect(sampleSkyCycle(phase, direction)).toBe(expected.intensity);
      expect(direction.toArray()).toEqual(expected.direction.toArray());
      expect(direction.length()).toBeCloseTo(1, 14);
    }
  });

  it("explicitly retains the existing .28 and .72 intensity discontinuities", () => {
    const direction = new THREE.Vector3();
    expect(sampleSkyCycle(0.28 - 1e-10, direction)).toBeCloseTo(1, 12);
    expect(sampleSkyCycle(0.28, direction)).toBeCloseTo(0.934, 14);
    expect(sampleSkyCycle(0.72 - 1e-10, direction)).toBeCloseTo(0.934, 9);
    expect(sampleSkyCycle(0.72, direction)).toBe(1);
  });

  it("owns two opaque linear-radiance meshes with an explicit lower hemisphere", () => {
    const world = new World(),
      sky = new SkySystem(world);
    const capture = sky.createLightingCapture();
    try {
      expect(capture.scene).not.toBe(world.stage.scene);
      expect(capture.scene.children).toHaveLength(2);
      expect(capture.scene.environment).toBeNull();
      expect(capture.scene.fog).toBeNull();
      const dome = skyMesh(capture.scene);
      expect(dome.geometry.parameters.radius).toBe(10);
      const ground = capture.scene.getObjectByName("LightingCaptureGround");
      if (
        !(ground instanceof THREE.Mesh) ||
        !(ground.geometry instanceof THREE.SphereGeometry)
      )
        throw new Error("Missing actual lower hemisphere");
      expect(ground.geometry.parameters).toMatchObject({
        radius: 9,
        thetaStart: Math.PI / 2,
        thetaLength: Math.PI / 2,
      });
      for (const mesh of [dome, ground]) {
        expect(mesh.layers.mask).toBe(1);
        expect(mesh.frustumCulled).toBe(false);
        expect(mesh.material).toMatchObject({
          toneMapped: false,
          fog: false,
          depthTest: false,
          depthWrite: false,
          transparent: false,
          side: THREE.BackSide,
        });
      }
      expect(ground.renderOrder).toBeGreaterThan(dome.renderOrder);
      capture.scene.updateMatrixWorld(true);
      const down = new THREE.Raycaster(
        new THREE.Vector3(),
        new THREE.Vector3(0, -1, 0),
      );
      expect(down.intersectObject(ground)[0]?.distance).toBeCloseTo(9, 5);
      const up = new THREE.Raycaster(
        new THREE.Vector3(),
        new THREE.Vector3(0, 1, 0),
      );
      expect(up.intersectObject(ground)).toHaveLength(0);
    } finally {
      capture.dispose();
      sky.destroy();
      world.destroy();
    }
  });

  it("snapshots palette and independently updates phase/HDR radiance without touching live state", () => {
    const world = new World(),
      sky = new SkySystem(world);
    const a = sky.createLightingCapture(),
      b = sky.createLightingCapture();
    try {
      const liveState = {
        phase: sky.dayPhase,
        intensity: sky.dayIntensity,
        sun: sky.sunDirection.toArray(),
        worldChildren: [...world.stage.scene.children],
      };
      const aMesh = skyMesh(a.scene),
        bMesh = skyMesh(b.scene);
      const aNodes = graphNodes(aMesh.material.colorNode!),
        bNodes = graphNodes(bMesh.material.colorNode!);
      const values = uniformValues(aNodes),
        bValues = uniformValues(bNodes);
      const palette = Object.values(sky.skyPaletteUniforms);
      const colors = values.filter(
        (value): value is THREE.Color => value instanceof THREE.Color,
      );
      expect(colors).toHaveLength(8);
      for (const live of palette) {
        expect(aNodes.has(live)).toBe(false);
        expect(colors).not.toContain(live.value);
        expect(colors.some((value) => value.equals(live.value))).toBe(true);
      }
      const beforeColors = colors.map((color) => color.toArray());
      const beforeB = bValues.map((v) =>
        v instanceof THREE.Vector3 || v instanceof THREE.Color
          ? v.toArray()
          : v,
      );
      const graph = aMesh.material.colorNode,
        version = aMesh.material.version;
      sky.skyPaletteUniforms.dayZenith.value.setRGB(4, 3, 2);
      a.setPhase(0.375, 3, [2, 1, 0]);
      const updated = uniformValues(aNodes);
      expect(updated.filter((v) => typeof v === "number").sort()).toEqual(
        [0.375, originalCycle(0.375).intensity, 3].sort(),
      );
      const direction = updated.find(
        (v): v is THREE.Vector3 => v instanceof THREE.Vector3,
      );
      expect(direction?.toArray()).toEqual(
        originalCycle(0.375).direction.toArray(),
      );
      expect(colors.map((color) => color.toArray())).toEqual(beforeColors);
      expect(
        bValues.map((v) =>
          v instanceof THREE.Vector3 || v instanceof THREE.Color
            ? v.toArray()
            : v,
        ),
      ).toEqual(beforeB);
      expect(aMesh.material.colorNode).toBe(graph);
      expect(aMesh.material.version).toBe(version);
      expect({
        phase: sky.dayPhase,
        intensity: sky.dayIntensity,
        sun: sky.sunDirection.toArray(),
        worldChildren: [...world.stage.scene.children],
      }).toEqual(liveState);
    } finally {
      a.dispose();
      b.dispose();
      sky.destroy();
      world.destroy();
    }
  });

  it("rejects invalid capture inputs before changing any phase/radiance state", () => {
    const world = new World(),
      sky = new SkySystem(world),
      capture = sky.createLightingCapture();
    try {
      const nodes = graphNodes(skyMesh(capture.scene).material.colorNode!);
      const snapshot = () =>
        uniformValues(nodes).map((v) =>
          v instanceof THREE.Vector3 || v instanceof THREE.Color
            ? v.toArray()
            : v,
        );
      capture.setPhase(0.5, 2, [0.1, 0.2, 0.3]);
      const before = snapshot();
      for (const phase of [-1, 1.1, NaN, Infinity])
        expect(() => capture.setPhase(phase, 1, [0, 0, 0])).toThrow();
      for (const scale of [-1, NaN, Infinity])
        expect(() => capture.setPhase(0, scale, [0, 0, 0])).toThrow();
      for (const value of [-1, NaN, Infinity])
        expect(() => capture.setPhase(0, 1, [0, value, 0])).toThrow();
      expect(snapshot()).toEqual(before);
      capture.setPhase(1, 0, [0, 0, 0]); // Endpoint and zero radiance are legitimate.
    } finally {
      capture.dispose();
      sky.destroy();
      world.destroy();
    }
  });

  it("matches snapshot CPU radiance to the actual shared TSL DAG across phases and directions", () => {
    const world = new World(),
      sky = new SkySystem(world);
    const capture = sky.createLightingCapture();
    try {
      const evaluate = skyGraphEvaluator(
        skyMesh(capture.scene).material.colorNode!,
      );
      const output = new THREE.Color();
      const directions = [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(2, 0.15, -3),
        new THREE.Vector3(-2, -0.3, 1),
      ];
      for (const phase of [
        0,
        0.125,
        0.22,
        0.25,
        0.28 - 1e-10,
        0.28,
        0.32,
        0.5,
        0.68,
        0.72 - 1e-10,
        0.72,
        0.75,
        0.78,
        0.875,
        1,
      ]) {
        capture.setPhase(phase, 1, [0, 0, 0]);
        for (const direction of directions) {
          capture.sampleRadiance(phase, direction, output);
          const actual = evaluate(direction);
          expect(actual).toHaveLength(4);
          expect(actual[3]).toBe(1);
          output.toArray().forEach((value, i) => {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeCloseTo(actual[i], 12);
          });
        }
      }
      capture.sampleRadiance(0.25, directions[2], output);
      const unscaled = output.toArray();
      capture.setPhase(0.25, 4, [8, 7, 6]);
      capture.sampleRadiance(0.25, directions[2], output);
      expect(output.toArray()).toEqual(unscaled);
      evaluate(directions[2])
        .slice(0, 3)
        .forEach((value, i) => {
          expect(value).toBeCloseTo(unscaled[i] * 4, 12);
        });
      sky.skyPaletteUniforms.dayZenith.value.setRGB(8, 6, 4);
      capture.sampleRadiance(0.25, directions[2], output);
      expect(output.toArray()).toEqual(unscaled);
      for (const badDirection of [
        new THREE.Vector3(),
        new THREE.Vector3(NaN, 0, 0),
        new THREE.Vector3(Infinity, 0, 0),
      ]) {
        expect(() =>
          capture.sampleRadiance(0.5, badDirection, output),
        ).toThrow();
        expect(output.toArray()).toEqual(unscaled);
      }
    } finally {
      capture.dispose();
      sky.destroy();
      world.destroy();
    }
  });

  it("disposes each owned geometry/material exactly once without retiring another capture", () => {
    const world = new World(),
      sky = new SkySystem(world);
    const a = sky.createLightingCapture(),
      b = sky.createLightingCapture();
    const resources = a.scene.children.flatMap((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material))
        throw new Error("Invalid capture mesh");
      return [object.geometry, object.material];
    });
    const counts = resources.map(() => 0);
    resources.forEach((resource, i) =>
      resource.addEventListener("dispose", () => counts[i]++),
    );
    try {
      a.dispose();
      a.dispose();
      expect(counts).toEqual([1, 1, 1, 1]);
      expect(a.scene.children).toHaveLength(0);
      expect(b.scene.children).toHaveLength(2);
      expect(() => a.setPhase(0.5, 1, [0, 0, 0])).toThrow("disposed");
      expect(() =>
        a.sampleRadiance(0.5, new THREE.Vector3(0, 1, 0), new THREE.Color()),
      ).toThrow("disposed");
      b.setPhase(0.5, 1, [0, 0, 0]);
    } finally {
      b.dispose();
      sky.destroy();
      world.destroy();
    }
  });
});
