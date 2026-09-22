import { describe, expect, it } from "vitest";

import type { World } from "../../../../types";
import THREE from "../../../../extras/three/three";
import { WaterSystem, type WaterUniforms } from "../WaterSystem";
import { World as RealWorld } from "../../../../core/World";
import { NodeFrame, type Node } from "three/webgpu";
import {
  NodeUpdateType,
  positionWorld,
  positionView,
  cameraPosition,
  cameraNear,
  cameraFar,
  output,
} from "three/tsl";

type WaterMaterialHarness = {
  normalTex?: THREE.Texture;
  flowTex?: THREE.Texture;
  foamTex?: THREE.Texture;
  oceanMaterial?: THREE.MeshStandardNodeMaterial;
  oceanUniforms: WaterUniforms | null;
  createOceanMaterial(): THREE.MeshStandardNodeMaterial;
};

function createTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  texture.needsUpdate = true;
  return texture;
}

function createLakePlaneHarness() {
  const world = new RealWorld();
  const water = new WaterSystem(world);
  water["normalTex"] = createTexture();
  water["flowTex"] = createTexture();
  water["foamTex"] = createTexture();
  const reflection = water["createReflection"]();
  water["reflection"] = reflection;
  water["lakeMaterial"] = water["createLakeMaterial"]();
  const scene = new THREE.Scene();
  water.addToScene(scene);
  const frame = new NodeFrame();
  frame.camera = world.camera;
  frame.scene = scene;
  frame.frameId = 7;
  frame.renderId = 11;
  const addLake = (height: number, parent: THREE.Object3D = scene) => {
    const geometry = new THREE.CircleGeometry(7.5, 45);
    geometry.rotateX(-Math.PI / 2);
    const lake = new THREE.Mesh(geometry, water.getMaterial("lake"));
    lake.position.y = height;
    parent.add(lake);
    scene.updateMatrixWorld(true);
    water.registerWaterMesh(lake);
    return lake;
  };
  return { water, reflection, frame, scene, addLake };
}

function nodeChild(node: Node, key: string): Node {
  const child: unknown = Reflect.get(node, key);
  if (!(child instanceof THREE.Node)) throw new Error(`Missing node ${key}`);
  return child;
}

function unwrap(node: Node): Node {
  while (Reflect.get(node, "isVarNode")) node = nodeChild(node, "node");
  return node;
}

function inspectGraph(
  root: Node | Node[],
  camera:
    | THREE.PerspectiveCamera
    | THREE.OrthographicCamera = new THREE.PerspectiveCamera(),
) {
  const builder: unknown = Reflect.construct(THREE.NodeBuilder, [null, null]);
  if (!(builder instanceof THREE.NodeBuilder))
    throw new Error("Expected Three builder");
  Object.assign(builder, { camera });
  const nodes = new Set<Node>();
  const expanded = new Map<Node, Node>();
  const visit = (node: Node) => {
    if (nodes.has(node)) return;
    nodes.add(node);
    if (
      node === positionWorld ||
      node === positionView ||
      node === cameraPosition ||
      node === output
    )
      return;
    const expand: unknown = Reflect.get(node, "getOutputNode");
    if (typeof expand === "function") {
      const result: unknown = Reflect.apply(expand, node, [builder]);
      if (!(result instanceof THREE.Node))
        throw new Error("Invalid TSL output");
      expanded.set(node, result);
      visit(result);
    } else for (const child of node.getChildren()) visit(child);
  };
  for (const node of Array.isArray(root) ? root : [root]) visit(node);
  return {
    nodes,
    expanded,
    named(name: string) {
      const matches = [...nodes].filter(
        (node) => Reflect.get(node, "name") === name,
      );
      expect(matches).toHaveLength(1);
      return matches[0];
    },
  };
}

// Bounded inspection of the ACTUAL material arithmetic. Only view/normal,
// sampled radiance and body-color inputs are substituted; no duplicate shader
// formula, fake renderer or claim of GPU evaluation. Unknown operations fail.
function numeric(
  root: Node,
  inputs: Map<Node, number[]>,
  expanded: ReadonlyMap<Node, Node> = new Map(),
): number[] {
  const memo = new Map<Node, number[]>();
  let visits = 0;
  const visit = (node: Node): number[] => {
    if (++visits > 10000) throw new Error("Numeric graph budget exceeded");
    const supplied = inputs.get(node) ?? memo.get(node);
    if (supplied) return supplied;
    const expansion = expanded.get(node);
    if (expansion) return visit(expansion);
    if (memo.size > 1000) throw new Error("Numeric graph budget exceeded");
    const get = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string) => visit(nodeChild(node, key));
    const zip = (
      a: number[],
      b: number[],
      fn: (a: number, b: number) => number,
    ) =>
      Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
        fn(a[i % a.length], b[i % b.length]),
      );
    const pair = (fn: (a: number, b: number) => number) =>
      zip(child("aNode"), child("bNode"), fn);
    const value = get("value"),
      op = get("op"),
      method = get("method");
    let result: number[];
    if (node.type === "StackNode") result = child("outputNode");
    else if (get("isVarNode") || node.type === "ConvertNode")
      result = child("node");
    else if (typeof value === "number") result = [value];
    else if (value instanceof THREE.Vector3) result = value.toArray();
    else if (value instanceof THREE.Color) result = [value.r, value.g, value.b];
    else if (node.type === "JoinNode")
      result = (get("nodes") as Node[]).flatMap(visit);
    else if (node.type === "SplitNode") {
      const channels = get("components");
      if (typeof channels !== "string" || !/^[xyzwrgba]{1,4}$/.test(channels))
        throw new Error("Unknown swizzle");
      const source = child("node");
      result = [...channels].map(
        (c) => source[("xyzw".includes(c) ? "xyzw" : "rgba").indexOf(c)],
      );
    } else if (node.type === "ConditionalNode")
      result = child("condNode")[0] ? child("ifNode") : child("elseNode");
    else if (op === "+") result = pair((a, b) => a + b);
    else if (op === "-") result = pair((a, b) => a - b);
    else if (op === "*") result = pair((a, b) => a * b);
    else if (op === "/") result = pair((a, b) => a / b);
    else if (op === ">") result = pair((a, b) => Number(a > b));
    else if (method === "max") result = pair(Math.max);
    else if (method === "pow") result = pair(Math.pow);
    else if (method === "exp2") result = child("aNode").map((v) => 2 ** v);
    else if (method === "negate") result = child("aNode").map((v) => -v);
    else if (method === "length") result = [Math.hypot(...child("aNode"))];
    else if (method === "cos") result = child("aNode").map(Math.cos);
    else if (method === "dot")
      result = [pair((a, b) => a * b).reduce((a, b) => a + b, 0)];
    else if (method === "normalize") {
      const a = child("aNode"),
        norm = Math.hypot(...a);
      result = a.map((v) => v / norm);
    } else if (method === "clamp")
      result = zip(pair(Math.max), child("cNode"), Math.min);
    else if (method === "mix") {
      const a = child("aNode"),
        b = child("bNode"),
        t = child("cNode");
      result = zip(
        zip(a, t, (x, f) => x * (1 - f)),
        zip(b, t, (y, f) => y * f),
        (x, y) => x + y,
      );
    } else
      throw new Error(
        `Unsupported numeric node ${node.type}/${String(op ?? method)}`,
      );
    if (!result.length || !result.every(Number.isFinite))
      throw new Error("Non-finite actual graph result");
    memo.set(node, result);
    return result;
  };
  return visit(root);
}

function pondLightingHarness() {
  const harness = createLakePlaneHarness();
  const material = harness.water.getMaterial("lake")!;
  const graph = inspectGraph(material.outputNode!);
  const dot = unwrap(graph.named("compactPondNdotV"));
  const normal = nodeChild(dot, "aNode"),
    view = nodeChild(dot, "bNode");
  const uniforms = harness.water.waterUniforms!;
  const inputs = new Map<Node, number[]>([
    [normal, [0, 1, 0]],
    [view, [0, 1, 0]],
  ]);
  uniforms.sunDirection.value.set(0, 1, 0);
  uniforms.sunIntensity.value = 2;
  uniforms.dayIntensity.value = 1;
  uniforms.illumination.keyDirection.value.set(0, 1, 0);
  uniforms.illumination.keyColor.value.setRGB(1, 1, 1);
  return { ...harness, material, graph, normal, view, inputs, uniforms };
}

describe("WaterSystem material graph", () => {
  it.each(["perspective", "orthographic"] as const)(
    "reconstructs compact pond screen-ray length with a real %s camera",
    (kind) => {
      const h = createLakePlaneHarness();
      try {
        const camera =
          kind === "perspective"
            ? new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 500)
            : new THREE.OrthographicCamera(-9, 9, 5, -5, 0.3, 500);
        camera.position.set(387, 27, 426.5);
        camera.lookAt(401, 25, 423);
        camera.updateMatrixWorld(true);
        const material = h.water.getMaterial("lake")!;
        const opacityNode: unknown = material.opacityNode;
        if (!(opacityNode instanceof THREE.Node))
          throw new Error("Expected actual lake opacity node");
        const graph = inspectGraph(opacityNode, camera);
        const axis = graph.named("lakeAxisDepthGap");
        const rayLength = graph.named("compactPondRayLength");
        const transmittance = graph.named("compactPondTransmittance");
        const depths = [...graph.nodes].filter(
          (node) => Reflect.get(node, "scope") === "linearDepth",
        );
        expect(depths).toHaveLength(2);
        const sceneDepth = depths.find(
          (node) => Reflect.get(node, "valueNode") !== null,
        )!;
        const fragmentDepth = depths.find(
          (node) => Reflect.get(node, "valueNode") === null,
        )!;
        expect(sceneDepth).toBeDefined();
        expect(fragmentDepth).toBeDefined();
        h.water.getQuietPondUniform()!.value = 1;
        const raycaster = new THREE.Raycaster();
        for (const ndc of [
          new THREE.Vector2(0, 0),
          new THREE.Vector2(-0.75, 0.5),
          new THREE.Vector2(0.8, -0.5),
        ]) {
          raycaster.setFromCamera(ndc, camera);
          const surface = raycaster.ray.at(20, new THREE.Vector3());
          const surfaceView = surface
            .clone()
            .applyMatrix4(camera.matrixWorldInverse);
          let previousOpacity = -1;
          for (const distance of [-2, 0, 1e-6, 0.5, 3, 6, 30, 60]) {
            const bottom = raycaster.ray.at(20 + distance, new THREE.Vector3());
            const bottomView = bottom
              .clone()
              .applyMatrix4(camera.matrixWorldInverse);
            // Supply only depth-attachment and camera-space inputs. The real
            // Camera/Raycaster creates independent world-space segment lengths;
            // evaluate the material's own axis conversion and attenuation DAG.
            const toLinear = (z: number) =>
              (-z - camera.near) / (camera.far - camera.near);
            const inputs = new Map<Node, number[]>([
              [sceneDepth, [toLinear(bottomView.z)]],
              [fragmentDepth, [toLinear(surfaceView.z)]],
              [positionView, surfaceView.toArray()],
              [cameraNear, [camera.near]],
              [cameraFar, [camera.far]],
            ]);
            expect(numeric(axis, inputs, graph.expanded)[0]).toBeCloseTo(
              surfaceView.z - bottomView.z,
              10,
            );
            const expectedLength = Math.min(30, Math.max(0, distance));
            expect(numeric(rayLength, inputs, graph.expanded)[0]).toBeCloseTo(
              expectedLength,
              9,
            );
            const transmission = numeric(
              transmittance,
              inputs,
              graph.expanded,
            )[0];
            expect(transmission).toBeCloseTo(2 ** (-expectedLength / 3), 10);
            const opacity = numeric(opacityNode, inputs, graph.expanded)[0];
            expect(opacity).toBeCloseTo(1 - transmission, 12);
            expect(opacity).toBeGreaterThanOrEqual(previousOpacity);
            previousOpacity = opacity;
            if ([0, 3, 6].includes(distance))
              expect(opacity).toBeCloseTo(
                distance === 0 ? 0 : distance === 3 ? 0.5 : 0.75,
                10,
              );
            // A tilted surface normal does not enter this geometry: dividing
            // by N.V would incorrectly exaggerate an already camera-axis gap.
            if (kind === "perspective" && ndc.lengthSq() > 0 && distance === 3)
              expect(numeric(axis, inputs, graph.expanded)[0]).toBeLessThan(3);
          }
        }
        const rayNodes = inspectGraph(rayLength, camera).nodes;
        expect(rayNodes.has(positionView)).toBe(kind === "perspective");
        expect(
          [...rayNodes].some((node) => Reflect.get(node, "method") === "dot"),
        ).toBe(false);
        if (kind === "perspective") {
          const boundaryInputs = new Map<Node, number[]>([
            [axis, [1]],
            [positionView, [1, 0, 0]],
          ]);
          expect(numeric(rayLength, boundaryInputs, graph.expanded)).toEqual([
            30,
          ]);
          boundaryInputs.set(axis, [-1]);
          expect(numeric(rayLength, boundaryInputs, graph.expanded)).toEqual([
            0,
          ]);
        }
      } finally {
        h.water.destroy();
      }
    },
  );

  it("isolates fixed compact tint and exponential opacity from the exact ordinary lake expressions", () => {
    const h = createLakePlaneHarness();
    try {
      const material = h.water.getMaterial("lake")!;
      const quiet = h.water.getQuietPondUniform()!;
      const opacity: unknown = material.opacityNode;
      if (!(opacity instanceof THREE.Node))
        throw new Error("Expected actual lake opacity node");
      const colorGraph = inspectGraph(material.outputNode!);
      const opacityGraph = inspectGraph(opacity);
      const body = colorGraph.named("compactPondBodyColor");
      expect(numeric(body, new Map(), colorGraph.expanded)).toEqual([
        0.02, 0.085, 0.095,
      ]);
      const selections = [...colorGraph.nodes].filter(
        (node) =>
          node.type === "ConditionalNode" &&
          unwrap(nodeChild(node, "ifNode")) === unwrap(body),
      );
      expect(selections).toHaveLength(1);
      const selectedColor = selections[0];
      const ordinaryColor = nodeChild(selectedColor, "elseNode");
      expect(inspectGraph(ordinaryColor).nodes.has(body)).toBe(false);
      expect(inspectGraph(ordinaryColor).nodes.has(quiet)).toBe(false);
      const opacitySelections = [...opacityGraph.nodes].filter(
        (node) => node.type === "ConditionalNode",
      );
      expect(opacitySelections).toHaveLength(1);
      const ordinaryOpacity = nodeChild(opacitySelections[0], "elseNode");
      expect(inspectGraph(ordinaryOpacity).nodes.has(quiet)).toBe(false);
      expect(
        inspectGraph(ordinaryOpacity).nodes.has(
          opacityGraph.named("compactPondTransmittance"),
        ),
      ).toBe(false);
      const axis = opacityGraph.named("lakeAxisDepthGap");
      expect(colorGraph.named("lakeAxisDepthGap")).toBe(axis);
      for (const gap of [-2, 0, 0.5, 3, 6, 15, 30, 60]) {
        for (const distance of [0, 10, 200, 400]) {
          const inputs = new Map<Node, number[]>([
            [axis, [gap]],
            [positionWorld, [0, 0, 0]],
            [cameraPosition, [0, 0, distance]],
          ]);
          const depth = Math.min(30, Math.max(0, gap));
          const colorLerp =
            Math.max(0, Math.min(1, 1 - depth / 50)) ** 3 *
            Math.min(1, Math.max(0.01, 1 - distance / 200));
          const expectedColor = [
            [-0.4569, 0.0311],
            [-0.3095, 0.1374],
            [-0.2654, 0.1692],
          ].map(([offset, amplitude]) =>
            Math.min(
              1,
              Math.max(
                0,
                offset +
                  amplitude * 0.5 * Math.cos(Math.PI * colorLerp + Math.PI) +
                  0.5,
              ),
            ),
          );
          quiet.value = 0;
          const actualColor = numeric(
            selectedColor,
            inputs,
            colorGraph.expanded,
          );
          actualColor.forEach((value, i) =>
            expect(value).toBeCloseTo(expectedColor[i], 12),
          );
          expect(
            numeric(opacity, inputs, opacityGraph.expanded)[0],
          ).toBeCloseTo(1 - Math.max(0, Math.min(1, 1 - depth / 15)) ** 3, 12);
          quiet.value = 1;
          expect(numeric(selectedColor, inputs, colorGraph.expanded)).toEqual([
            0.02, 0.085, 0.095,
          ]);
        }
      }
      // Both roots use one real builder, matching one material compilation;
      // separate builders legitimately create separate lazy depth samples.
      const combined = inspectGraph([material.outputNode!, opacity]).nodes;
      expect(
        [...combined].filter(
          (node) => node.type === "ViewportDepthTextureNode",
        ),
      ).toHaveLength(1);
      for (const [texture, samples] of [
        [h.water["normalTex"], 5],
        [h.water["flowTex"], 1],
        [h.water["foamTex"], 1],
      ] as const)
        expect(
          [...combined].filter(
            (node) =>
              Reflect.get(node, "isTextureNode") &&
              Reflect.get(node, "value") === texture,
          ),
        ).toHaveLength(samples);
      const ocean = h.water["createOceanMaterial"]();
      h.water["oceanMaterial"] = ocean;
      for (const node of [
        ocean.outputNode,
        ocean.opacityNode,
        material.positionNode,
      ]) {
        if (!(node instanceof THREE.Node))
          throw new Error("Expected actual ocean or lake displacement node");
        const nodes = inspectGraph(node).nodes;
        expect(nodes.has(quiet)).toBe(false);
        expect(nodes.has(body)).toBe(false);
        expect(nodes.has(opacityGraph.named("compactPondRayLength"))).toBe(
          false,
        );
      }
    } finally {
      h.water.destroy();
    }
  });

  it("keeps compact direct light independent of planar radiance and continuously gates horizon/night", () => {
    const h = pondLightingHarness();
    try {
      const legacy = h.graph.named("compactPondLegacyDirectLight");
      const world = h.graph.named("compactPondWorldDirectLight");
      const both = () => [legacy, world].map((node) => numeric(node, h.inputs));
      expect(both()).toEqual([
        [5, 5, 5],
        [5, 5, 5],
      ]);
      for (const enabled of [false, true]) {
        h.water.setReflectionsEnabled(enabled);
        for (const sample of [
          [0, 0, 0],
          [1, 0.2, 8],
        ]) {
          h.inputs.set(h.graph.named("compactPondReflectionSample"), sample);
          expect(both()).toEqual([
            [5, 5, 5],
            [5, 5, 5],
          ]);
        }
      }
      // Mirrored view: the lobe is exactly aligned. Both paths contain ONE
      // N.L, so a vanishing incident cosine cannot pop to full brightness.
      for (const cosine of [1, 0.5, 1e-4, 1e-8, 0, -1e-8, -0.5]) {
        const x = Math.sqrt(1 - cosine * cosine);
        h.uniforms.sunDirection.value.set(x, cosine, 0);
        h.uniforms.illumination.keyDirection.value.copy(
          h.uniforms.sunDirection.value,
        );
        h.inputs.set(h.view, [-x, cosine, 0]);
        for (const rgb of both())
          for (const channel of rgb)
            expect(channel).toBeCloseTo(5 * Math.max(cosine, 0), 10);
      }
      h.uniforms.sunDirection.value.set(0, 1, 0);
      h.uniforms.illumination.keyDirection.value.set(0, 1, 0);
      for (const degrees of [0, 5, 10, 45, 90, 120]) {
        const angle = (degrees * Math.PI) / 180;
        h.inputs.set(h.view, [Math.sin(angle), Math.cos(angle), 0]);
        const expected = 5 * Math.pow(Math.max(Math.cos(angle), 0), 100);
        for (const rgb of both())
          for (const channel of rgb) expect(channel).toBeCloseTo(expected, 12);
      }
      h.inputs.set(h.view, [0, 1, 0]);
      for (const day of [-1, 0, 1e-8, 0.5, 1, 2]) {
        h.uniforms.dayIntensity.value = day;
        for (const rgb of both())
          for (const channel of rgb)
            expect(channel).toBeCloseTo(5 * Math.min(1, Math.max(day, 0)), 12);
      }
      // Positive moon intensity is not permission for a full-night sun glint.
      h.uniforms.dayIntensity.value = 0;
      h.uniforms.sunIntensity.value = 0.2;
      expect(both()).toEqual([
        [0, 0, 0],
        [0, 0, 0],
      ]);
      h.uniforms.dayIntensity.value = 1;
      for (const intensity of [-1, 0, 1, 2, 3]) {
        h.uniforms.sunIntensity.value = intensity;
        expect(numeric(legacy, h.inputs)).toEqual(
          Array(3).fill((5 * Math.min(2, Math.max(0, intensity))) / 2),
        );
        // keyColor already carries world irradiance: no second intensity scale.
        expect(numeric(world, h.inputs)).toEqual([5, 5, 5]);
      }
      h.uniforms.illumination.keyColor.value.setRGB(0.2, 0.4, 0.8);
      expect(numeric(world, h.inputs)).toEqual([1, 2, 4]);
      h.uniforms.illumination.keyColor.value.setRGB(0, 0, 0);
      expect(numeric(world, h.inputs)).toEqual([0, 0, 0]);
    } finally {
      h.water.destroy();
    }
  });

  it("retains full reflection contribution without counting the pond highlight twice", () => {
    const h = pondLightingHarness();
    try {
      h.water.getQuietPondUniform()!.value = 1;
      for (const lane of ["Legacy", "World"]) {
        const albedo = h.graph.named(`compactPond${lane}Albedo`);
        const reflectionMix = unwrap(nodeChild(unwrap(albedo), "aNode"));
        const selected = unwrap(h.graph.named(`lakeSelected${lane}Lighting`));
        const pondColor = unwrap(nodeChild(selected, "ifNode"));
        h.inputs.set(nodeChild(reflectionMix, "aNode"), [0, 0, 0]);
        h.inputs.set(nodeChild(pondColor, "bNode"), [0, 0, 0]);
        h.uniforms.illumination.fillColor.value.setRGB(
          Math.PI,
          Math.PI,
          Math.PI,
        );
        for (const cosine of [1, 0.5]) {
          const x = Math.sqrt(1 - cosine * cosine);
          h.uniforms.sunDirection.value.set(x, cosine, 0);
          h.uniforms.illumination.keyDirection.value.copy(
            h.uniforms.sunDirection.value,
          );
          h.inputs.set(h.view, [-x, cosine, 0]);
          const fresnel = 0.3 + 0.7 * (1 - cosine) ** 5;
          for (const intensity of [0, 0.4])
            for (const captured of [0, 1])
              for (const sample of [0, 1]) {
                h.uniforms.reflectionIntensity.value = intensity;
                h.water["lakeReflectionPlaneUniform"]!.value = captured;
                h.inputs.set(h.graph.named("compactPondReflectionSample"), [
                  sample,
                  sample,
                  sample,
                ]);
                const expected =
                  0.2 *
                  fresnel *
                  ((0.1 + 0.9 * sample) * intensity * captured + 5 * cosine);
                for (const channel of numeric(
                  h.graph.named(`lakeSelected${lane}Lighting`),
                  h.inputs,
                ))
                  expect(channel).toBeCloseTo(expected, 12);
              }
        }
        h.uniforms.sunDirection.value.set(0, 1, 0);
        h.uniforms.illumination.keyDirection.value.set(0, 1, 0);
        h.inputs.set(h.view, [0, 1, 0]);
      }
    } finally {
      h.water.destroy();
    }
  });

  it("owns pond lighting per draw without leaking into ordinary water or displacement and retains fog alpha", () => {
    const h = pondLightingHarness();
    try {
      const quiet = h.water.getQuietPondUniform()!;
      for (const lane of ["Legacy", "World"]) {
        const direct = inspectGraph(
          h.graph.named(`compactPond${lane}DirectLight`),
        ).nodes;
        expect(direct.has(h.reflection)).toBe(false);
        expect(direct.has(h.uniforms.reflectionIntensity)).toBe(false);
        expect(direct.has(h.water["lakeReflectionPlaneUniform"]!)).toBe(false);
        const selected = unwrap(h.graph.named(`lakeSelected${lane}Lighting`));
        const ordinary = inspectGraph(nodeChild(selected, "elseNode")).nodes;
        expect(
          ordinary.has(h.graph.named(`compactPond${lane}DirectLight`)),
        ).toBe(false);
        expect(ordinary.has(h.graph.named(`compactPond${lane}Albedo`))).toBe(
          false,
        );
        const sentinel = [0.11, 0.22, 0.33];
        h.inputs.set(nodeChild(selected, "elseNode"), sentinel);
        quiet.value = 0;
        expect(numeric(selected, h.inputs)).toEqual(sentinel);
      }
      const opacity: unknown = h.material.opacityNode;
      const position: unknown = h.material.positionNode;
      if (!(opacity instanceof THREE.Node) || !(position instanceof THREE.Node))
        throw new Error("Expected actual lake opacity and displacement nodes");
      expect(inspectGraph(opacity).nodes.has(quiet)).toBe(true);
      expect(inspectGraph(position).nodes.has(quiet)).toBe(false);
      expect(
        [...h.graph.nodes].filter(
          (n) =>
            Reflect.get(n, "isTextureNode") &&
            Reflect.get(n, "value") === h.water["normalTex"],
        ),
      ).toHaveLength(5);
      const ocean = h.water["createOceanMaterial"]();
      h.water["oceanMaterial"] = ocean;
      expect(inspectGraph(ocean.outputNode!).nodes.has(quiet)).toBe(false);
      expect([
        h.material.transparent,
        h.material.depthWrite,
        h.material.side,
        h.material.fog,
      ]).toEqual([true, true, THREE.DoubleSide, false]);
      // The final vec4 still fogs RGB and alpha with one shared factor. The
      // pond contribution is upstream of that mix, never added after full fog.
      const final = [...h.graph.nodes].find((n) => {
        const children: unknown = Reflect.get(n, "nodes");
        return (
          n.type === "JoinNode" &&
          Array.isArray(children) &&
          children.length === 2 &&
          children.every(
            (c: Node) => Reflect.get(unwrap(c), "method") === "mix",
          )
        );
      });
      expect(final).toBeDefined();
      const [rgb, alpha] = Reflect.get(final!, "nodes") as Node[];
      const factor = nodeChild(unwrap(rgb), "cNode");
      expect(nodeChild(unwrap(alpha), "cNode")).toBe(factor);
      expect(
        inspectGraph(nodeChild(unwrap(alpha), "aNode")).nodes.has(quiet),
      ).toBe(false);
      const fogInputs = new Map<Node, number[]>([
        [nodeChild(unwrap(rgb), "aNode"), [10, 20, 30]],
        [nodeChild(unwrap(rgb), "bNode"), [0.2, 0.3, 0.4]],
        [nodeChild(unwrap(alpha), "aNode"), [0.37]],
        [factor, [1]],
      ]);
      expect(numeric(final!, fogInputs)).toEqual([0.2, 0.3, 0.4, 1]);
      fogInputs.set(factor, [0]);
      expect(numeric(final!, fogInputs)).toEqual([10, 20, 30, 0.37]);
    } finally {
      h.water.destroy();
    }
  });

  it("calms only owned pond surface detail without new normal samples or changed wave graphs", () => {
    const { water, frame, addLake } = createLakePlaneHarness();
    try {
      // Expand the actual lazy TSL functions using Three's builder. This checks
      // graph ownership and sampling cost, not rendered quality or GPU time.
      const graph = (root: Node) => inspectGraph(root).nodes;
      const material = water.getMaterial("lake")!;
      const nodes = graph(material.outputNode!);
      const quiet = water.getQuietPondUniform()!;
      const child = (node: Node, field: string): Node => {
        const value: unknown = Reflect.get(node, field);
        if (!(value instanceof THREE.Node)) throw new Error(`Missing ${field}`);
        return value;
      };
      const named = (name: string) => {
        const matches = [...nodes].filter(
          (node) => Reflect.get(node, "name") === name,
        );
        expect(matches).toHaveLength(1);
        return matches[0];
      };
      // r186 wraps operations authored outside Fn in anonymous variable
      // intents. Follow those real wrappers; do not substitute shader math.
      const operation = (node: Node): Node =>
        node.type === "VarNode" && Reflect.get(node, "name") === null
          ? operation(child(node, "node"))
          : node;
      const expectMix = (input: Node, legacy: number, pond: number) => {
        const node = operation(input);
        expect(Reflect.get(node, "method")).toBe("mix");
        expect(
          Reflect.get(operation(child(node, "aNode")), "value"),
        ).toBeCloseTo(legacy, 7);
        expect(
          Reflect.get(operation(child(node, "bNode")), "value"),
        ).toBeCloseTo(pond, 7);
        expect(operation(child(node, "cNode"))).toBe(quiet);
      };
      expectMix(child(named("lakeSurfaceNormalStrength"), "node"), 1.5, 0.65);
      expectMix(
        child(named("lakeSurfaceReflectionDistortion"), "node"),
        0.015,
        0.006,
      );
      const clock = operation(child(named("lakeSurfaceDetailTime"), "node"));
      expect(Reflect.get(clock, "op")).toBe("*");
      expect(operation(child(clock, "aNode"))).toBe(water["uniforms"]!.time);
      expectMix(child(clock, "bNode"), 1, 0.55);
      expect(
        [...nodes].filter(
          (node) =>
            Reflect.get(node, "isTextureNode") === true &&
            Reflect.get(node, "value") === water["normalTex"],
        ),
      ).toHaveLength(5);
      const opacity: unknown = material.opacityNode;
      const position: unknown = material.positionNode;
      if (!(opacity instanceof THREE.Node) || !(position instanceof THREE.Node))
        throw new Error("Expected actual lake opacity and displacement nodes");
      expect(graph(opacity).has(quiet)).toBe(true);
      expect(graph(position).has(quiet)).toBe(false);

      const pond = addLake(27.8),
        lake = addLake(16);
      pond.userData.compactQuietPond = true;
      for (const [object, expected] of [
        [pond, 1],
        [lake, 0],
        [pond, 1],
        [lake, 0],
      ] as const) {
        frame.object = object;
        frame.updateNode(quiet);
        expect(quiet.value).toBe(expected);
      }
    } finally {
      water.destroy();
    }
  });

  it("does not consume native render admission for non-lake precompile objects", () => {
    const { water, reflection, frame, scene } = createLakePlaneHarness();
    const unregistered = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      water.getMaterial("lake"),
    );
    scene.add(unregistered);
    try {
      // Use installed NodeFrame's real scheduling map; no replacement callback
      // or renderer is supplied. Entering the GPU path would fail this test.
      const actualFrame = frame as NodeFrame & {
        updateBeforeMap: WeakMap<object, { renderId: number; frameId: number }>;
      };
      for (const object of [null, new THREE.Object3D(), unregistered]) {
        frame.object = object;
        frame.updateBeforeNode(reflection.reflector);
        expect(
          actualFrame.updateBeforeMap.get(reflection.reflector)?.renderId,
        ).toBe(0);
        expect(water["lastLakeReflectionOwner"]).toBeNull();
      }
      expect(reflection.reflector.renderTargets.size).toBe(0);
      expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
        false,
      );
    } finally {
      unregistered.geometry.dispose();
      water.destroy();
    }
  });
  it("binds the actual elevated lake plane without changing ocean-level ownership", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      water.setWaterLevel(16);
      const lake = addLake(27.8);
      frame.object = lake;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target);
      expect(owner?.mesh).toBe(lake);
      expect(owner?.plane.normal.toArray()).toEqual([0, 1, 0]);
      expect(owner?.plane.constant).toBeCloseTo(-27.8, 12);
      expect(water["waterLevel"]).toBe(16);
      expect(
        new THREE.Vector3().setFromMatrixPosition(reflection.target.matrixWorld)
          .y,
      ).toBeCloseTo(27.8, 12);
      const reflectedEye = new THREE.Vector3(346, 34, 305);
      reflectedEye.addScaledVector(
        owner!.plane.normal,
        -2 * owner!.plane.distanceToPoint(reflectedEye),
      );
      expect(reflectedEye.y).toBeCloseTo(21.6, 12);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(true);
      // Plane mathematics/admission is not a fake GPU capture: before native
      // ReflectorNode has completed, the actual object uniform stays disabled.
      frame.updateNode(water["lakeReflectionPlaneUniform"]!);
      expect(water["lakeReflectionPlaneUniform"]!.value).toBe(0);
      expect(owner?.captured).toBe(false);
      expect(reflection.reflector.renderTargets.size).toBe(0);
      expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
        false,
      );
    } finally {
      water.destroy();
    }
  });

  it("shares only coplanar lake draws in the same real NodeFrame camera and render", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      const first = addLake(27.8);
      const samePlane = addLake(27.8);
      samePlane.position.x = 20;
      samePlane.updateMatrixWorld(true);
      const otherHeight = addLake(31);
      frame.object = first;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target);
      frame.object = samePlane;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(true);
      frame.object = otherHeight;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      expect(water["lastLakeReflectionOwner"]).toBe(owner);
      frame.object = samePlane;
      const camera = frame.camera;
      frame.camera = new THREE.PerspectiveCamera();
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.camera = camera;
      frame.renderId++;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.object = otherHeight;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target)?.plane
          .constant,
      ).toBeCloseTo(-31, 12);
      frame.frameId++;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      const otherFrame = new NodeFrame();
      Object.assign(otherFrame, {
        camera,
        scene: frame.scene,
        object: otherHeight,
        frameId: frame.frameId,
        renderId: frame.renderId,
      });
      expect(water["matchesLakeReflectionPlane"](otherFrame)).toBe(false);
    } finally {
      water.destroy();
    }
  });

  it("uses inverse-transpose world planes under rotated, nonuniform parent transforms", () => {
    const { water, reflection, frame, scene, addLake } =
      createLakePlaneHarness();
    try {
      const parent = new THREE.Group();
      parent.position.set(12, 9, -8);
      parent.rotation.set(0.2, 0.6, -0.13);
      parent.scale.set(1.7, 0.8, 1.2);
      scene.add(parent);
      const lake = addLake(4, parent);
      lake.rotation.set(0.14, 0.3, 0.05);
      scene.updateMatrixWorld(true);
      frame.object = lake;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target)!;
      const a = new THREE.Vector3(-2, 0, 1).applyMatrix4(lake.matrixWorld);
      const b = new THREE.Vector3(3, 0, 1).applyMatrix4(lake.matrixWorld);
      const c = new THREE.Vector3(-2, 0, -3).applyMatrix4(lake.matrixWorld);
      const expected = new THREE.Plane().setFromCoplanarPoints(a, b, c);
      expect(owner.plane.normal.distanceTo(expected.normal)).toBeLessThan(
        1e-12,
      );
      expect(Math.abs(owner.plane.constant - expected.constant)).toBeLessThan(
        1e-12,
      );
      const targetNormal = new THREE.Vector3(0, 0, 1).transformDirection(
        reflection.target.matrixWorld,
      );
      expect(targetNormal.distanceTo(expected.normal)).toBeLessThan(1e-12);
      for (const point of [a, b, c])
        expect(Math.abs(owner.plane.distanceToPoint(point))).toBeLessThan(
          1e-12,
        );
      // Exactly the native nested-render protection; the parent scene may be
      // transformed and forced to update, but cannot replace the bound plane.
      const bound = reflection.target.matrixWorld.clone();
      reflection.target.matrixWorldAutoUpdate = false;
      scene.updateMatrixWorld(true);
      expect(reflection.target.matrixWorld.equals(bound)).toBe(true);
      reflection.target.matrixWorldAutoUpdate = true;
    } finally {
      water.destroy();
    }
  });

  it("rejects ocean, changed/nonplanar geometry, retired and stale owners without allocating captures", () => {
    const { water, reflection, frame, scene, addLake } =
      createLakePlaneHarness();
    const oceanMaterial = new THREE.MeshStandardNodeMaterial();
    try {
      const ocean = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 10),
        oceanMaterial,
      );
      scene.add(ocean);
      water.registerWaterMesh(ocean);
      frame.object = ocean;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      const lake = addLake(27.8);
      frame.object = lake;
      water["bindLakeReflectionPlane"](frame, reflection.target);
      water.unregisterWaterMesh(lake);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water["lastLakeReflectionOwner"]).toBeNull();
      water.registerWaterMesh(lake);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      const position = lake.geometry.getAttribute("position");
      position.needsUpdate = true;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.renderId++;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      position.setY(0, 1);
      water.unregisterWaterMesh(lake);
      water.registerWaterMesh(lake);
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      expect(reflection.reflector.renderTargets.size).toBe(0);
    } finally {
      water.destroy();
      oceanMaterial.dispose();
    }
  });

  it("invalidates plane leases across reflection preferences and disposal while preserving the native gate", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    const lake = addLake(27.8);
    frame.object = lake;
    const update = reflection.reflector.updateBefore;
    try {
      water["bindLakeReflectionPlane"](frame, reflection.target);
      water.setReflectionsEnabled(false);
      frame.updateBeforeNode(reflection.reflector);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water.waterUniforms?.reflectionIntensity.value).toBe(0);
      expect(reflection.reflector.renderTargets.size).toBe(0);
      water.setReflectionsEnabled(true);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water.waterUniforms?.reflectionIntensity.value).toBe(0.4);
      expect(reflection.reflector.updateBefore).toBe(update);
      expect(reflection.reflector.getUpdateBeforeType()).toBe(
        NodeUpdateType.RENDER,
      );
    } finally {
      water.destroy();
    }
    expect(water["lakePlaneSources"].size).toBe(0);
    expect(water["lastLakeReflectionOwner"]).toBeNull();
    expect(water["lakeReflectionPlaneUniform"]).toBeNull();
  });

  it("rejects singular and non-finite actual world transforms before capture admission", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      const lake = addLake(27.8);
      frame.object = lake;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).not.toBeNull();
      const original = lake.matrixWorld.clone();
      const singular = original.clone().scale(new THREE.Vector3(0, 1, 1));
      const infinite = original.clone();
      infinite.elements[0] = Infinity;
      const notANumber = original.clone();
      notANumber.elements[13] = NaN;
      for (const matrix of [singular, infinite, notANumber]) {
        lake.matrixWorld.copy(matrix);
        expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
        frame.renderId++;
        expect(
          water["bindLakeReflectionPlane"](frame, reflection.target),
        ).toBeNull();
        // Exercise the real native scheduling entry, not only the math helper.
        // It must return before attempting GPU camera/target allocation.
        frame.updateBeforeNode(reflection.reflector);
        frame.updateNode(water["lakeReflectionPlaneUniform"]!);
        expect(water["lakeReflectionPlaneUniform"]!.value).toBe(0);
        expect(reflection.reflector.renderTargets.size).toBe(0);
        expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
          false,
        );
      }
    } finally {
      water.destroy();
    }
  });

  it("skips real NodeFrame reflection scheduling when disabled before initialization", () => {
    const world = new RealWorld();
    const water = new WaterSystem(world);
    water.setReflectionsEnabled(false);
    const node = water["createReflection"]();
    const reflection = node.reflector;
    try {
      // A real NodeFrame without a GPU renderer: a disabled node must never
      // enter the native draw or allocate any camera/target. Not a GPU test.
      const frame = new NodeFrame();
      frame.camera = world.camera;
      frame.renderId = 1;
      expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
      expect(reflection.getUpdateBeforeType(frame)).toBe(NodeUpdateType.NONE);
      frame.updateBeforeNode(reflection);
      expect(reflection.virtualCameras.has(world.camera)).toBe(false);
      expect(reflection.renderTargets.size).toBe(0);
      expect(reflection.resolutionScale).toBe(0.5);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("retains the registered node and native update policy across preference toggles", () => {
    const water = new WaterSystem(new RealWorld());
    const node = water["createReflection"]();
    const reflection = node.reflector;
    const update = reflection.updateBefore;
    const gate = reflection.getUpdateBeforeType;
    try {
      for (const enabled of [true, false, true, false, true]) {
        water.setReflectionsEnabled(enabled);
        expect(reflection.getUpdateBeforeType()).toBe(
          enabled ? NodeUpdateType.RENDER : NodeUpdateType.NONE,
        );
        // NodeBuilder registers by the property, NodeFrame dispatches by the
        // method. Keeping registration permits re-enable without a recompile.
        expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
        expect(reflection.updateBefore).toBe(update);
        expect(reflection.getUpdateBeforeType).toBe(gate);
        expect(node.reflector).toBe(reflection);
      }
      reflection.updateBeforeType = NodeUpdateType.FRAME;
      expect(reflection.getUpdateBeforeType()).toBe(NodeUpdateType.FRAME);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("constructs the ocean graph with updateable runtime uniform values", () => {
    const world = {
      isServer: false,
      camera: null,
      getSystem: () => null,
    } as unknown as World;
    const system = new WaterSystem(world);
    const harness = system as unknown as WaterMaterialHarness;
    harness.normalTex = createTexture();
    harness.flowTex = createTexture();
    harness.foamTex = createTexture();

    const material = harness.createOceanMaterial();
    harness.oceanMaterial = material;

    expect(material.positionNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.outputNode).toBeTruthy();
    expect(harness.oceanUniforms?.time.value).toBe(0);
    expect(harness.oceanUniforms?.windStrength.value).toBe(1.2);
    expect(harness.oceanUniforms?.sunDirection.value).toBeInstanceOf(
      THREE.Vector3,
    );

    system.update(0.25);
    expect(harness.oceanUniforms?.time.value).toBe(0.25);
    expect(typeof harness.oceanUniforms?.windStrength.value).toBe("number");

    system.destroy();
  });
});
