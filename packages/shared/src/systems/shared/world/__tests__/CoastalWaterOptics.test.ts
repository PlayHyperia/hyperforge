import { describe, expect, it } from "vitest";
import type { Node } from "three/webgpu";
import THREE, {
  float,
  positionWorld,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "../../../../extras/three/three";
import {
  COASTAL_WATER_OPTICS,
  createCoastalWaterOpticalDistanceNode,
} from "../CoastalWaterOptics";

function graph(root: Node): Set<Node> {
  const nodes = new Set<Node>();
  const visit = (node: Node): void => {
    if (nodes.has(node)) return;
    nodes.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return nodes;
}

// Interpret only the actual scalar operations in this real TSL graph. Unknown
// nodes fail closed. This is CPU arithmetic/identity evidence, never GPU proof.
function scalar(node: Node): number {
  const read = (key: string): unknown => Reflect.get(node, key);
  const child = (key: string): number => {
    const value = read(key);
    if (!(value instanceof THREE.Node)) throw new Error(`Missing ${key}`);
    return scalar(value);
  };
  if (node.type === "VarNode" || node.type === "ConvertNode")
    return child("node");
  if (node.type === "ConstNode" || node.type === "UniformNode") {
    const value = read("value");
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Expected finite scalar input");
    return value;
  }
  if (node.type === "OperatorNode") {
    const a = child("aNode"),
      b = child("bNode");
    switch (read("op")) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
    }
  }
  if (node.type === "MathNode") {
    const a = child("aNode"),
      b = child("bNode");
    switch (read("method")) {
      case "max":
        return Math.max(a, b);
      case "mix": {
        const weight = child("cNode");
        return a * (1 - weight) + b * weight;
      }
      case "smoothstep": {
        const t = Math.min(1, Math.max(0, (child("cNode") - a) / (b - a)));
        return t * t * (3 - 2 * t);
      }
    }
  }
  throw new Error(`Unsupported scalar node ${node.type}`);
}

function fixture() {
  const legacy = uniform(50);
  const signed = uniform(0);
  const displacement = uniform(0);
  const enabled = uniform(1);
  const effective = createCoastalWaterOpticalDistanceNode(
    legacy,
    signed,
    displacement,
    enabled,
  );
  const evaluate = (depth: number, wave = 0, active = 1, previous = 50) => {
    signed.value = depth;
    displacement.value = wave;
    enabled.value = active;
    legacy.value = previous;
    return scalar(effective);
  };
  return { legacy, signed, displacement, enabled, effective, evaluate };
}

describe("coastal water optical calibration (actual TSL, not GPU proof)", () => {
  it("publishes immutable artist-calibration endpoints", () => {
    expect(Object.isFrozen(COASTAL_WATER_OPTICS)).toBe(true);
    expect(COASTAL_WATER_OPTICS).toEqual({
      id: "coastal-water-optics-v1",
      transitionStart: 6,
      transitionEnd: 8,
    });
  });

  it("clamps only after signed depth and displaced surface height are added", () => {
    const { evaluate } = fixture();
    for (const [depth, wave, expected] of [
      [-2, 0, 0],
      [-2, 3, 1],
      [-0.25, 0.5, 0.25],
      [0.25, -0.5, 0],
      [0, 0.5, 0.5],
      [5.75, 1.5, 7.25],
      [6, -2, 4],
    ]) {
      expect(evaluate(depth, wave)).toBe(expected);
    }
  });

  it("consumes signed bilinear values rather than interpolating clamped texels", () => {
    const { evaluate } = fixture();
    // Four real scalar samples at an equal-weight cell center. The module owns
    // no sampler; this checks its ordering contract for the supplied result.
    const texels = [-4, 2, 2, 2];
    const signedBilinear = texels.reduce((sum, value) => sum + value / 4, 0);
    const wronglyClamped = texels.reduce(
      (sum, value) => sum + Math.max(value, 0) / 4,
      0,
    );
    expect(signedBilinear).toBe(0.5);
    expect(evaluate(signedBilinear, -0.25)).toBe(0.25);
    expect(evaluate(wronglyClamped, -0.25)).toBe(1.25);
  });

  it("retains the exact supplied legacy parameter when disabled", () => {
    const { evaluate } = fixture();
    for (const previous of [0, 3.25, 8, 50, 80]) {
      for (const depth of [-100, -0.5, 0, 6, 7, 8, 13.5, 100]) {
        for (const wave of [-1e12, -20, 0, 20, 1e12]) {
          expect(evaluate(depth, wave, 0, previous)).toBe(previous);
        }
      }
    }
  });

  it("retains deep and gutter optics regardless of finite large wave offsets", () => {
    const { evaluate } = fixture();
    for (const depth of [8, 8.0001, 13.5, 50, 65504]) {
      for (const wave of [-1e12, -100, -8, 0, 8, 100, 1e12]) {
        expect(evaluate(depth, wave)).toBe(50);
        expect(evaluate(depth, wave, 1, 17.25)).toBe(17.25);
      }
    }
    // These values are finite arithmetic controls, not an assumed wind cap or
    // evidence that a particular bathymetry field's gutter passes admission.
  });

  it("uses the static 6-to-8 cubic fade, independent of displaced depth", () => {
    const { evaluate } = fixture();
    for (const [depth, near] of [
      [6, 1],
      [6.5, 0.84375],
      [7, 0.5],
      [7.5, 0.15625],
      [8, 0],
    ]) {
      for (const wave of [-10, -0.5, 0, 0.5, 10]) {
        const expected = 50 * (1 - near) + Math.max(depth + wave, 0) * near;
        expect(evaluate(depth, wave)).toBe(expected);
      }
    }
    expect(evaluate(7, 1)).toBe(29);
    expect(evaluate(7, -10)).toBe(25);
  });

  it("is continuous through the shoreline clamp and both fade endpoints", () => {
    const { evaluate } = fixture();
    const epsilon = 1e-5;
    for (const wave of [-2, 0, 2]) {
      for (const depth of [-wave, 6, 8]) {
        const center = evaluate(depth, wave);
        expect(Math.abs(evaluate(depth - epsilon, wave) - center)).toBeLessThan(
          2 * epsilon,
        );
        expect(Math.abs(evaluate(depth + epsilon, wave) - center)).toBeLessThan(
          2 * epsilon,
        );
      }
      // At the offshore endpoint the fading correction has zero first slope.
      expect(Math.abs(evaluate(8 - epsilon, wave) - 50)).toBeLessThan(1e-8);
    }
  });

  it("keeps the actual displacement input out of the static weight graph", () => {
    const seaY = uniform(16);
    const displacedY = positionWorld.y.sub(seaY);
    const signed = uniform(7);
    const enabled = uniform(1);
    const effective = createCoastalWaterOpticalDistanceNode(
      float(50),
      signed,
      displacedY,
      enabled,
    );
    const all = graph(effective);
    const weights = [...all].filter(
      (node) => Reflect.get(node, "name") === "coastalWaterOpticsNearWeight",
    );
    expect(weights).toHaveLength(1);
    const weightGraph = graph(weights[0]);
    expect(weightGraph.has(signed)).toBe(true);
    expect(weightGraph.has(enabled)).toBe(true);
    expect(weightGraph.has(displacedY)).toBe(false);
    expect(weightGraph.has(positionWorld)).toBe(false);
    expect(weightGraph.has(seaY)).toBe(false);
    expect(all.has(displacedY)).toBe(true);
    expect(all.has(positionWorld)).toBe(true);
    expect(all.has(seaY)).toBe(true);
    const clamps = [...all].filter(
      (node) => Reflect.get(node, "method") === "max",
    );
    expect(clamps).toHaveLength(1);
    expect(graph(clamps[0]).has(signed)).toBe(true);
    expect(graph(clamps[0]).has(displacedY)).toBe(true);
  });

  it("shares one returned node and adds no fetch to the caller's real texture graph", () => {
    const image = new THREE.DataTexture(
      new Uint16Array([THREE.DataUtils.toHalfFloat(-0.5)]),
      1,
      1,
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    const sampled = texture(image).sample(vec2(0.5)).level(float(0)).r;
    const effective = createCoastalWaterOpticalDistanceNode(
      float(50),
      sampled,
      float(0),
      uniform(1),
    );
    const material = new THREE.MeshStandardNodeMaterial();
    material.opacityNode = effective;
    material.outputNode = vec4(vec3(effective), 1);
    try {
      const opacity = material.opacityNode;
      if (!(opacity instanceof THREE.Node))
        throw new Error("The actual material opacity must be a TSL node");
      expect(opacity).toBe(effective);
      expect(graph(opacity).has(effective)).toBe(true);
      expect(graph(material.outputNode).has(effective)).toBe(true);
      const expectedTextures = [...graph(sampled)].filter(
        (node) => node.type === "TextureNode",
      );
      expect(expectedTextures.length).toBeGreaterThan(0);
      const actualTextures = [...graph(effective)].filter(
        (node) => node.type === "TextureNode",
      );
      expect(new Set(actualTextures)).toEqual(new Set(expectedTextures));
      expect(graph(effective).has(sampled)).toBe(true);
      expect(
        [...graph(effective)].filter(
          (node) => Reflect.get(node, "name") === "coastalWaterOpticalDistance",
        ),
      ).toEqual([effective]);
    } finally {
      image.dispose();
      material.dispose();
    }
  });

  it("does not mistake unsupported or nonfinite nodes for numeric evidence", () => {
    expect(() => scalar(positionWorld)).toThrow("Unsupported scalar node");
    expect(() => scalar(uniform(Number.NaN))).toThrow("Expected finite scalar");
    expect(() => scalar(uniform(Number.POSITIVE_INFINITY))).toThrow(
      "Expected finite scalar",
    );
  });
});
