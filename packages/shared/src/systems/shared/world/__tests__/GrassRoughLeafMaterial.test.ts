import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import type Node from "three/src/nodes/core/Node.js";
import { float, vec2, vec3, uniform, texture, Fn } from "three/tsl";
import {
  GrassRoughLeafMaterial,
  createRoughLeafDielectricResponse,
  createRoughLeafGGXVisibility,
  setRoughLeafEnvironment,
  supportsRoughLeafRecipe,
} from "../GrassRoughLeafMaterial";

function leaf() {
  const material = new GrassRoughLeafMaterial();
  material.roughness = 1;
  material.metalness = 0;
  material.fog = false;
  material.thicknessColorNode = vec3(0.12, 0.3, 0.05);
  return material;
}

/** Evaluate only the actual pure TSL arithmetic under test. No renderer, shader
 * or GPU is replaced; unknown node types/operations fail closed. */
function evaluate(root: Node): number[] {
  const cache = new Map<Node, number[]>();
  const visit = (node: Node): number[] => {
    const old = cache.get(node);
    if (old) return old;
    const get = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string): number[] => {
      const value = get(key);
      if (!(value instanceof THREE.Node))
        throw new Error(`Missing ${key} on ${node.type}`);
      return visit(value);
    };
    const calculate = (): number[] => {
      const value = get("value");
      if (typeof value === "number") return [value];
      if (
        value instanceof THREE.Vector2 ||
        value instanceof THREE.Vector3 ||
        value instanceof THREE.Vector4
      )
        return value.toArray();
      if (node.type === "VarNode" || node.type === "ConvertNode")
        return child("node");
      if (node.type === "SplitNode")
        return [...String(get("components"))].map(
          (c) => child("node")["xyzw".indexOf(c)],
        );
      if (node.type === "JoinNode") {
        const nodes = get("nodes");
        if (!Array.isArray(nodes)) throw new Error("Missing joined nodes");
        return nodes.flatMap((next: unknown) => {
          if (!(next instanceof THREE.Node))
            throw new Error("Invalid joined node");
          return visit(next);
        });
      }
      const a = child("aNode");
      if (node.type === "MathNode") {
        const method = get("method");
        if (method === "oneMinus") return a.map((x) => 1 - x);
        if (method === "reciprocal") return a.map((x) => 1 / x);
        if (method === "max") {
          const b = child("bNode");
          return a.map((x, i) => Math.max(x, b[i % b.length]));
        }
        throw new Error(`Unsupported math ${String(method)}`);
      }
      if (node.type === "OperatorNode") {
        const b = child("bNode");
        return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
          const x = a[i % a.length],
            y = b[i % b.length];
          switch (get("op")) {
            case "+":
              return x + y;
            case "-":
              return x - y;
            case "*":
              return x * y;
            case "/":
              return x / y;
            default:
              throw new Error(`Unsupported operator ${String(get("op"))}`);
          }
        });
      }
      throw new Error(`Unsupported node ${node.type}`);
    };
    const result = calculate();
    cache.set(node, result);
    return result;
  };
  return visit(root);
}

describe("rough leaf material ownership (not native image/performance acceptance)", () => {
  it("requires an explicit supported owned environment and retains stock SSS otherwise", () => {
    const material = leaf();
    expect(material).toBeInstanceOf(THREE.MeshSSSNodeMaterial);
    expect(supportsRoughLeafRecipe(material)).toBe(true);
    expect(material.roughLeafLightingActive).toBe(false);
    const stock = new THREE.MeshSSSNodeMaterial().setupLightingModel();
    expect(material.setupLightingModel().constructor).toBe(stock.constructor);
    const environment = uniform(new THREE.Vector3(0.1, 0.2, 0.3));
    const version = material.version;
    setRoughLeafEnvironment(material, environment);
    expect(material.envNode).toBe(environment);
    expect(material.roughLeafLightingActive).toBe(true);
    expect(material.version).toBe(version + 1);
    expect(material.setupLightingModel()).toBeInstanceOf(
      THREE.PhysicalLightingModel,
    );
    expect(material.setupLightingModel().constructor).not.toBe(
      stock.constructor,
    );
    expect(material.setupLightingModel().useSSS).toBe(true);
    setRoughLeafEnvironment(material, environment);
    environment.value.set(0.5, 0.4, 0.1);
    expect(material.version).toBe(version + 1);
    setRoughLeafEnvironment(material, null);
    expect(material.envNode).toBeNull();
    expect(material.roughLeafLightingActive).toBe(false);
    expect(material.setupLightingModel().constructor).toBe(stock.constructor);
    expect(material.version).toBe(version + 2);
    material.dispose();
  });

  it.each([
    ["roughness", 0.99],
    ["metalness", 0.01],
    ["ior", 1.4],
    ["specularIntensity", 0.9],
    ["transmission", 0.1],
    ["clearcoat", 0.1],
    ["sheen", 0.1],
    ["iridescence", 0.1],
    ["anisotropy", 0.1],
    ["dispersion", 0.1],
    ["retroreflectivity", 0.1],
    ["lights", false],
  ] as const)("falls back when %s leaves the fixed recipe", (field, value) => {
    const material = leaf(),
      environment = vec3(0.1);
    setRoughLeafEnvironment(material, environment);
    Reflect.set(material, field, value);
    expect(supportsRoughLeafRecipe(material)).toBe(false);
    expect(material.roughLeafLightingActive).toBe(false);
    const version = material.version;
    setRoughLeafEnvironment(material, environment);
    expect(material.envNode).toBeNull();
    expect(material.version).toBe(version + 1);
    material.dispose();
  });

  it.each([
    "roughnessNode",
    "metalnessNode",
    "iorNode",
    "specularColorNode",
    "specularIntensityNode",
    "contextNode",
    "lightsNode",
    "fragmentNode",
    "backdropNode",
    "clearcoatNode",
    "transmissionNode",
    "sheenNode",
  ])("rejects a custom %s", (field) => {
    const material = leaf();
    Reflect.set(material, field, float(1));
    expect(supportsRoughLeafRecipe(material)).toBe(false);
    setRoughLeafEnvironment(material, vec3(0.1));
    expect(material.envNode).toBeNull();
    material.dispose();
  });

  it.each([
    "useAnisotropy",
    "useClearcoat",
    "useRetroreflection",
    "useTransmission",
    "useSheen",
    "useIridescence",
    "useDispersion",
  ])("rejects an overridden %s even with zero scalar", (field) => {
    const material = leaf();
    Object.defineProperty(material, field, { value: true });
    expect(supportsRoughLeafRecipe(material)).toBe(false);
    material.dispose();
  });

  it("preserves cloned graph roots, borrowed binding and original disposal listeners", () => {
    const material = leaf(),
      environment = uniform(new THREE.Vector3(0.2, 0.3, 0.1));
    material.positionNode = vec3(1, 2, 3);
    material.normalNode = vec3(0, 1, 0);
    material.colorNode = vec3(0.1, 0.2, 0.3);
    material.outputNode = vec3(0.2);
    let originalDisposals = 0;
    material.addEventListener("dispose", () => originalDisposals++);
    setRoughLeafEnvironment(material, environment);
    const clone = material.clone();
    expect(clone).toBeInstanceOf(GrassRoughLeafMaterial);
    expect(clone.roughLeafLightingActive).toBe(true);
    for (const key of [
      "positionNode",
      "normalNode",
      "colorNode",
      "outputNode",
      "thicknessColorNode",
      "envNode",
    ] as const)
      expect(clone[key]).toBe(material[key]);
    clone.dispose();
    expect(originalDisposals).toBe(0);
    expect(material.roughLeafLightingActive).toBe(true);
    expect(clone.roughLeafLightingActive).toBe(false);
    setRoughLeafEnvironment(clone, environment);
    expect(clone.envNode).toBeNull();
    material.dispose();
    expect(originalDisposals).toBe(1);
  });

  it("never overwrites foreign env nodes before binding, after takeover, on copy or disposal", () => {
    const environment = vec3(0.2),
      foreign = vec3(0.7),
      material = leaf();
    material.envNode = foreign;
    setRoughLeafEnvironment(material, environment);
    expect(material.envNode).toBe(foreign);
    expect(material.roughLeafLightingActive).toBe(false);
    material.envNode = null;
    setRoughLeafEnvironment(material, environment);
    material.envNode = foreign;
    const clone = material.clone();
    expect(clone.envNode).toBe(foreign);
    expect(clone.roughLeafLightingActive).toBe(false);
    const version = material.version;
    setRoughLeafEnvironment(material, null);
    expect(material.envNode).toBe(foreign);
    expect(material.version).toBe(version + 1);
    material.dispose();
    clone.dispose();
    expect(material.envNode).toBe(foreign);
    expect(clone.envNode).toBe(foreign);
  });

  it("does not bind ordinary materials or dispose borrowed environment textures", () => {
    const ordinary = new THREE.MeshSSSNodeMaterial(),
      material = leaf();
    const target = new THREE.RenderTarget(4, 4);
    const environment = texture(target.texture).rgb;
    let disposals = 0;
    target.addEventListener("dispose", () => disposals++);
    setRoughLeafEnvironment(ordinary, environment);
    expect(ordinary.envNode).toBeNull();
    setRoughLeafEnvironment(material, environment);
    material.dispose();
    ordinary.dispose();
    expect(disposals).toBe(0);
    target.dispose();
    expect(disposals).toBe(1);
  });
});

describe("rough leaf actual TSL scalar response", () => {
  it("expands real material lighting stages with the canonical TSL stack and retained SSS inputs", () => {
    const dom = new JSDOM("<canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas");
    if (!canvas) throw new Error("Missing real constructor canvas");
    const renderer = new THREE.WebGPURenderer({ canvas });
    const material = leaf(),
      geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    setRoughLeafEnvironment(
      material,
      uniform(new THREE.Vector3(0.1, 0.2, 0.3)),
    );
    try {
      const builder = new THREE.WGSLNodeBuilder(mesh, renderer);
      builder.scene = new THREE.Scene();
      builder.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      builder.lightsNode = new THREE.LightsNode().setLights([
        new THREE.DirectionalLight(0xffffff, 1),
        new THREE.AmbientLight(0xffffff, 0.1),
      ]);
      const prebuild: unknown = Reflect.get(builder, "prebuild");
      if (typeof prebuild !== "function")
        throw new Error("Missing real material prebuild");
      prebuild.call(builder);
      builder.setBuildStage("setup");
      for (const stage of ["vertex", "fragment"] as const) {
        builder.setShaderStage(stage);
        for (const node of builder.flowNodes[stage]) node.build(builder);
      }
      // Generate requires actual native texture capabilities for the untouched
      // DFG LUT. Here the installed builder expands its real setup graph only.
      const found = new Set<Node>();
      const visit = (node: Node): void => {
        if (found.has(node)) return;
        found.add(node);
        for (const child of node.getChildren()) visit(child);
        const visitValue = (value: unknown): void => {
          if (value instanceof THREE.Node) visit(value);
          else if (Array.isArray(value)) value.forEach(visitValue);
        };
        for (const value of Object.values(builder.getNodeProperties(node)))
          visitValue(value);
        for (const stage of ["vertex", "fragment"] as const) {
          const data = builder.getDataFromNode(node, stage);
          for (const value of Object.values(data)) visitValue(value);
        }
      };
      for (const node of builder.flowNodes.fragment) visit(node);
      const names = [...found].map((node) => Reflect.get(node, "name"));
      expect(names).toContain("roughLeafDfg");
      expect(names).toContain("roughLeafFresnel");
      expect(names).toContain("directDiffuse");
      expect(names).toContain("indirectSpecular");
      expect(found.has(material.thicknessColorNode!)).toBe(true);
      expect(found.has(material.thicknessDistortionNode)).toBe(true);
      expect(found.has(material.thicknessPowerNode)).toBe(true);
      expect(found.has(material.thicknessScaleNode)).toBe(true);
      expect(found.has(material.thicknessAmbientNode)).toBe(true);
      expect(found.has(material.thicknessAttenuationNode)).toBe(true);
      expect(names).not.toContain("singleScatteringMetallic");
      expect(names).not.toContain("multiScatteringMetallic");
      const textureValues = new Set(
        [...found]
          .map((node) => Reflect.get(node, "value"))
          .filter(
            (value): value is THREE.DataTexture =>
              value instanceof THREE.DataTexture,
          ),
      );
      expect(textureValues.size).toBe(1);
      const [dfgTexture] = textureValues;
      expect(dfgTexture.type).toBe(THREE.HalfFloatType);
      expect(dfgTexture.format).toBe(THREE.RGFormat);
      expect(dfgTexture.image.width).toBe(16);
      expect(dfgTexture.image.height).toBe(16);
    } finally {
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      dom.window.close();
    }
  });

  it("retains r186 dielectric single/multiple scattering and compensation across the DFG domain", () => {
    const f0 = ((1.5 - 1) / (1.5 + 1)) ** 2;
    for (const scale of [0, 1e-5, 0.03, 0.15, 0.31, 0.7, 1])
      for (const bias of [0, 1e-5, 0.004, 0.1, 0.3, 0.7]) {
        const energy = scale + bias;
        if (energy <= 0 || energy > 1) continue;
        const response = createRoughLeafDielectricResponse(
          vec2(scale, bias),
          float(f0),
        );
        const single = f0 * scale + bias;
        const missing = 1 - energy;
        const average = f0 + (1 - f0) * 0.047619;
        const multi = ((single * average) / (1 - missing * average)) * missing;
        expect(evaluate(response.single)[0]).toBeCloseTo(single, 14);
        expect(evaluate(response.multi)[0]).toBeCloseTo(multi, 14);
        expect(evaluate(response.compensation)[0]).toBeCloseTo(
          1 + f0 * (1 / energy - 1),
          12,
        );
      }
  });

  it("matches original alpha1 Smith visibility including grazing and clamped negative dot inputs", () => {
    const epsilon = 1e-6;
    for (const rawL of [-1, -1e-8, 0, 1e-12, 1e-7, 0.001, 0.2, 0.9, 1])
      for (const rawV of [-1, -1e-8, 0, 1e-12, 1e-7, 0.001, 0.2, 0.9, 1]) {
        const l = Math.max(0, Math.min(1, rawL)),
          v = Math.max(0, Math.min(1, rawV));
        const original =
          0.5 /
          Math.max(
            l * Math.sqrt(1 + 0 * v * v) + v * Math.sqrt(1 + 0 * l * l),
            epsilon,
          );
        const actual = evaluate(
          createRoughLeafGGXVisibility(float(l), float(v)),
        )[0];
        expect(Number.isFinite(actual)).toBe(true);
        expect(actual).toBeCloseTo(original, 12);
      }
  });

  it("constructs the actual installed r186 candidate model and real geometry without GPU substitution", () => {
    const dom = new JSDOM("<canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas");
    if (!canvas) throw new Error("Missing real constructor canvas");
    const renderer = new THREE.WebGPURenderer({ canvas });
    const material = leaf(),
      geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    setRoughLeafEnvironment(material, vec3(0.1));
    try {
      const builder = new THREE.WGSLNodeBuilder(mesh, renderer);
      expect(builder.material).toBe(material);
      expect(builder.geometry).toBe(geometry);
      const model = material.setupLightingModel();
      expect(model).toBeInstanceOf(THREE.LightingModel);
      expect(model.useSSS).toBe(true);
      expect(material.lights).toBe(true);
      expect(material.lightsNode).toBeNull();
      expect(material.fragmentNode).toBeNull();
      expect(material.roughness).toBe(1);
      expect(material.metalness).toBe(0);
      builder.setShaderStage("fragment");
      const generate: unknown = Reflect.get(builder, "flowStagesNode");
      if (typeof generate !== "function")
        throw new Error("Missing actual r186 flowStagesNode");
      const response = Fn(() => {
        const terms = createRoughLeafDielectricResponse(
          vec2(0.3, 0.02),
          float(0.04),
        );
        const accumulator = vec3().toVar("roughLeafAccumulator");
        new THREE.ConvertNode<"vec3">(accumulator, "vec3").addAssign(
          vec3(terms.single, terms.multi, terms.compensation).mul(
            createRoughLeafGGXVisibility(float(0.7), float(0.2)),
          ),
        );
        return accumulator;
      }, "vec3")();
      const flow: unknown = generate.call(builder, response, "vec3");
      if (
        !flow ||
        typeof flow !== "object" ||
        !("code" in flow) ||
        typeof flow.code !== "string"
      )
        throw new Error("Missing actual WGSL arithmetic flow");
      expect(flow.code).toContain("roughLeafSingleScatter");
      expect(flow.code).toContain("roughLeafDirectCompensation");
      expect(flow.code).toMatch(
        /roughLeafAccumulator = \( roughLeafAccumulator \+/,
      );
      expect(flow.code).not.toMatch(/vec3<f32>\( roughLeafAccumulator \) =/);
      expect(flow.code).not.toMatch(/textureSample|dpdx|dpdy/);
    } finally {
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      dom.window.close();
    }
  });
});
