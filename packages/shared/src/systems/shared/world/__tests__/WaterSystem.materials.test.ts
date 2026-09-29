import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import type { World } from "../../../../types";
import THREE from "../../../../extras/three/three";
import { WaterSystem, type WaterUniforms } from "../WaterSystem";
import { World as RealWorld } from "../../../../core/World";
import { NodeFrame, type Node } from "three/webgpu";
import {
  NodeUpdateType,
  positionWorld,
  positionLocal,
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
      node === positionLocal ||
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
    else if (op === "<=") result = pair((a, b) => Number(a <= b));
    else if (method === "max") result = pair(Math.max);
    else if (method === "pow") result = pair(Math.pow);
    else if (method === "exp2") result = child("aNode").map((v) => 2 ** v);
    else if (method === "negate") result = child("aNode").map((v) => -v);
    else if (method === "length") result = [Math.hypot(...child("aNode"))];
    else if (method === "cos") result = child("aNode").map(Math.cos);
    else if (method === "sin") result = child("aNode").map(Math.sin);
    else if (method === "smoothstep") {
      const low = child("aNode"),
        high = child("bNode"),
        value = child("cNode");
      result = zip(
        zip(value, low, (v, l) => v - l),
        zip(high, low, (h, l) => h - l),
        (v, span) => {
          const t = Math.max(0, Math.min(1, v / span));
          return t * t * (3 - 2 * t);
        },
      );
    } else if (method === "dot")
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

  it("composes pond surface and transmitted background with actual straight-alpha output", () => {
    const h = pondLightingHarness();
    try {
      h.water.getQuietPondUniform()!.value = 1;
      expect(h.material.blending).toBe(THREE.NormalBlending);
      expect(h.material.premultipliedAlpha).toBe(false);
      const final = [...h.graph.nodes].find((node) => {
        const children: unknown = Reflect.get(node, "nodes");
        return (
          node.type === "JoinNode" &&
          Array.isArray(children) &&
          children.length === 2 &&
          unwrap(children[1]).type === "ConditionalNode"
        );
      });
      expect(final).toBeDefined();
      const rgb = (Reflect.get(final!, "nodes") as Node[])[0];
      h.inputs.set(nodeChild(unwrap(rgb), "cNode"), [0]);
      h.inputs.set(nodeChild(unwrap(rgb), "bNode"), [0.2, 0.3, 0.4]);
      h.inputs.set(h.graph.named("lakeAxisDepthGap"), [1]);
      h.inputs.set(h.graph.named("compactPondDepthPixelWidth"), [0.01]);
      h.uniforms.illumination.fillColor.value.setRGB(Math.PI, Math.PI, Math.PI);
      const background = [0.35, 0.22, 0.13],
        sample = [0.9, 0.7, 0.4];
      h.inputs.set(h.graph.named("compactPondReflectionSample"), sample);
      const f0 = ((1.333 - 1) / (1.333 + 1)) ** 2;
      for (const worldLane of [false, true]) {
        h.uniforms.illumination.blend.value = worldLane ? 1 : 0;
        for (const cosine of [1, 0.5, 1e-6, 0]) {
          h.inputs.set(h.view, [Math.sqrt(1 - cosine ** 2), cosine, 0]);
          const fresnel = f0 + (1 - f0) * (1 - cosine) ** 5;
          for (const transmission of [0, 2 ** -10, 0.5, 1]) {
            h.inputs.set(h.graph.named("compactPondTransmittance"), [
              transmission,
            ]);
            for (const enabled of [false, true]) {
              h.water.setReflectionsEnabled(enabled);
              for (const captured of [0, 1]) {
                h.water["lakeReflectionPlaneUniform"]!.value = captured;
                const captureWeight = enabled ? 0.4 * captured : 0;
                const opacity = 1 - (1 - fresnel) * transmission;
                const rgba = numeric(final!, h.inputs, h.graph.expanded);
                expect(rgba[3]).toBeCloseTo(opacity, 12);
                for (let channel = 0; channel < 3; channel++) {
                  const tint = [0.02, 0.085, 0.095][channel];
                  const litTint = tint * (1 + 1 / Math.PI);
                  const body = worldLane
                    ? litTint * (0.8 + 0.2 * (0.15 + cosine))
                    : 0.03 + tint * (0.8 + 0.2 * cosine);
                  const ambient = worldLane ? 1 : 0.1;
                  const reflection =
                    ambient * (1 - captureWeight) +
                    sample[channel] * captureWeight;
                  const direct = cosine > 0 ? 5 * cosine ** 100 : 0;
                  const expected =
                    (1 - fresnel) * (1 - transmission) * body +
                    fresnel * (reflection + direct) +
                    (1 - opacity) * background[channel];
                  // Installed r186 NormalBlending: source RGB * source alpha +
                  // destination RGB * (1-source alpha), not source RGB alone.
                  const blended =
                    rgba[channel] * rgba[3] +
                    background[channel] * (1 - rgba[3]);
                  expect(blended).toBeCloseTo(expected, 11);
                }
                expect(rgba.every(Number.isFinite)).toBe(true);
                // A perfectly clear body still reflects; disabled/missing
                // planar captures use ambient rather than black at grazing.
                if (transmission === 1) expect(rgba[3]).toBeGreaterThan(0);
                if (cosine === 0 && !enabled)
                  expect(rgba[0]).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    } finally {
      h.water.destroy();
    }
  });

  it("zeros uncovered pond pixels and feathers depth contact in an unconditional fragment stack", () => {
    const h = pondLightingHarness();
    try {
      const coverage = h.graph.named("compactPondCoverage");
      const derivative = h.graph.named("compactPondDepthPixelWidth");
      const root = [...h.graph.nodes].find(
        (node) =>
          node.type === "StackNode" &&
          (Reflect.get(node, "nodes") as Node[]).includes(derivative),
      );
      expect(root).toBeDefined();
      const stack = Reflect.get(root!, "nodes") as Node[];
      // VarNode.toStack() appends these before output's conditional selections;
      // constructing the JS node outside Fn would not establish uniform flow.
      expect(stack).toContain(coverage);
      expect(stack.indexOf(derivative)).toBeLessThan(stack.indexOf(coverage));
      const final = unwrap(nodeChild(root!, "outputNode"));
      expect(final.type).toBe("JoinNode");
      expect(inspectGraph(final).nodes.has(coverage)).toBe(true);
      expect(Reflect.get(unwrap(derivative), "method")).toBe("fwidth");
      for (const pixelWidth of [0, 1e-6, 0.01, 0.5]) {
        h.inputs.set(derivative, [pixelWidth]);
        for (const gap of [-2, -1e-8, 0, 0.0005, 0.005, 0.25, 1]) {
          h.inputs.set(h.graph.named("lakeAxisDepthGap"), [gap]);
          const t = Math.max(0, Math.min(1, gap / Math.max(pixelWidth, 0.001)));
          const expected = t * t * (3 - 2 * t);
          expect(numeric(coverage, h.inputs, h.graph.expanded)[0]).toBeCloseTo(
            expected,
            12,
          );
          if (gap <= 0) expect(expected).toBe(0);
        }
      }
    } finally {
      h.water.destroy();
    }
  });

  it("owns pond lighting per draw without leaking into ordinary water or displacement and composes fog once", () => {
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
        expect(ordinary.has(h.graph.named(`compactPond${lane}Source`))).toBe(
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
      // Ordinary water retains its original fog-to-opaque expression. Compact
      // pond fogs straight RGB only, over an already equally fogged destination.
      const final = [...h.graph.nodes].find((n) => {
        const children: unknown = Reflect.get(n, "nodes");
        return (
          n.type === "JoinNode" &&
          Array.isArray(children) &&
          children.length === 2 &&
          Reflect.get(unwrap(children[0]), "method") === "mix" &&
          unwrap(children[1]).type === "ConditionalNode"
        );
      });
      expect(final).toBeDefined();
      const [rgb, alpha] = Reflect.get(final!, "nodes") as Node[];
      const factor = nodeChild(unwrap(rgb), "cNode");
      const ordinaryAlpha = nodeChild(unwrap(alpha), "elseNode");
      expect(nodeChild(unwrap(ordinaryAlpha), "cNode")).toBe(factor);
      expect(
        inspectGraph(nodeChild(unwrap(ordinaryAlpha), "aNode")).nodes.has(
          quiet,
        ),
      ).toBe(false);
      const fogInputs = new Map<Node, number[]>([
        [nodeChild(unwrap(rgb), "aNode"), [10, 20, 30]],
        [nodeChild(unwrap(rgb), "bNode"), [0.2, 0.3, 0.4]],
        [nodeChild(unwrap(ordinaryAlpha), "aNode"), [0.37]],
        [factor, [1]],
      ]);
      expect(numeric(final!, fogInputs)).toEqual([0.2, 0.3, 0.4, 1]);
      fogInputs.set(factor, [0]);
      expect(numeric(final!, fogInputs)).toEqual([10, 20, 30, 0.37]);
      quiet.value = 1;
      const source = [0.4, 0.7, 0.2],
        destination = [0.2, 0.3, 0.8],
        fog = [0.15, 0.2, 0.25];
      fogInputs.set(nodeChild(unwrap(rgb), "aNode"), source);
      fogInputs.set(nodeChild(unwrap(rgb), "bNode"), fog);
      for (const coverage of [0, 0.5, 1]) {
        fogInputs.set(h.graph.named("compactPondCoverage"), [coverage]);
        fogInputs.set(h.graph.named("compactPondCompositeOpacity"), [0.37]);
        for (const fogFactor of [0, 0.2, 0.8, 1]) {
          fogInputs.set(factor, [fogFactor]);
          const rgba = numeric(final!, fogInputs);
          const a = coverage * 0.37;
          expect(rgba[3]).toBe(a);
          for (let channel = 0; channel < 3; channel++) {
            const foggedDestination =
              destination[channel] * (1 - fogFactor) + fog[channel] * fogFactor;
            const actual = rgba[channel] * a + foggedDestination * (1 - a);
            const unfogged =
              source[channel] * a + destination[channel] * (1 - a);
            expect(actual).toBeCloseTo(
              unfogged * (1 - fogFactor) + fog[channel] * fogFactor,
              12,
            );
          }
        }
      }
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

describe("WaterSystem reflection-only grass submission footprint", () => {
  // Actual Three cameras, targets and uninitialized WebGPU renderer. Invoking
  // its scene callbacks tests the CPU lease, not native raster/pixel parity.
  function fixture(perspective = false) {
    const dom = new JSDOM("<!doctype html><canvas></canvas>");
    const renderer = new THREE.WebGPURenderer({
      canvas: dom.window.document.querySelector("canvas")!,
    });
    const water = new WaterSystem(new RealWorld());
    const scene = new THREE.Scene();
    const camera = perspective
      ? new THREE.PerspectiveCamera(65, 100 / 80, 0.1, 100)
      : new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 100);
    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.position.set(0, 0, 20);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const target = new THREE.RenderTarget(100, 80, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const pixels = new THREE.Vector4(60, 10, 25, 20);
    const full = () =>
      new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        ),
        camera.coordinateSystem,
        camera.reversedDepth,
      );
    const box = (x: number, y: number) =>
      new THREE.Box3(
        new THREE.Vector3(x - 0.1, y - 0.1, 0),
        new THREE.Vector3(x + 0.1, y + 0.1, 1),
      );
    const begin = () =>
      water["beginLakeGrassFootprint"](renderer, scene, camera, target, pixels);
    const before = (
      view: THREE.Camera = camera,
      rt: THREE.RenderTarget = target,
    ) => {
      renderer.setRenderTarget(rt);
      return Reflect.apply(scene.onBeforeRender, scene, [
        renderer,
        scene,
        view,
        rt,
      ]);
    };
    const after = (
      view: THREE.Camera = camera,
      rt: THREE.RenderTarget = target,
    ) => Reflect.apply(scene.onAfterRender, scene, [renderer, scene, view, rt]);
    return {
      dom,
      renderer,
      water,
      scene,
      camera,
      target,
      pixels,
      full,
      box,
      begin,
      before,
      after,
      dispose() {
        renderer.setRenderTarget(null);
        target.dispose();
        water.destroy();
        dom.window.close();
      },
    };
  }

  it("is default-off independently of raster scissor and never changes target or camera state", () => {
    const h = fixture();
    try {
      expect(h.water["reflectionGrassFootprintEnabled"]).toBe(false);
      expect(h.water["reflectionFootprintEnabled"]).toBe(false);
      const original = h.scene.onBeforeRender;
      const projection = h.camera.projectionMatrix.clone();
      const viewport = h.target.viewport.clone(),
        scissor = h.target.scissor.clone();
      expect(h.begin()).toBeNull();
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(true);
      h.water.setReflectionGrassFootprintEnabled(true);
      const release = h.begin()!;
      try {
        h.before();
        expect(
          h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
        ).toBe(false);
        h.water.setReflectionGrassFootprintEnabled(false);
        expect(
          h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
        ).toBe(true);
      } finally {
        release();
      }
      expect(h.scene.onBeforeRender).toBe(original);
      expect(
        Object.prototype.hasOwnProperty.call(h.scene, "onBeforeRender"),
      ).toBe(false);
      expect(h.camera.projectionMatrix).toEqual(projection);
      expect(h.target.viewport).toEqual(viewport);
      expect(h.target.scissor).toEqual(scissor);
      expect(h.target.scissorTest).toBe(false);
      expect(h.renderer.getScissorTest()).toBe(false);
      expect(h.water["reflectionFootprintEnabled"]).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("keeps every sampled pixel in an asymmetric top-left crop without a second X flip", () => {
    const h = fixture();
    h.water.setReflectionGrassFootprintEnabled(true);
    const release = h.begin()!;
    try {
      // The lease is acquired before mirror-camera updates; it must use the
      // final camera, not a projection cached at acquisition.
      h.camera.position.x = 13;
      h.camera.updateMatrixWorld(true);
      h.before();
      const full = h.full();
      let admitted = 0;
      for (const depth of [0.01, 0.5, 0.99]) {
        for (let ix = 0; ix <= 20; ix++)
          for (let iy = 0; iy <= 20; iy++) {
            const u = (60 + (ix * 25) / 20) / 100;
            const v = (10 + (iy * 20) / 20) / 80;
            const p = new THREE.Vector3(2 * u - 1, 1 - 2 * v, depth).unproject(
              h.camera,
            );
            const bounds = new THREE.Box3().setFromCenterAndSize(
              p,
              new THREE.Vector3(1e-5, 1e-5, 1e-5),
            );
            expect(full.intersectsBox(bounds)).toBe(true);
            expect(h.water.intersectsReflectionGrassBounds(full, bounds)).toBe(
              true,
            );
            admitted++;
          }
      }
      expect(admitted).toBe(1323);
      expect(h.water.intersectsReflectionGrassBounds(full, h.box(3, -10))).toBe(
        false,
      );
      expect(h.water.intersectsReflectionGrassBounds(full, h.box(23, 8))).toBe(
        true,
      );
      // Another pass may reuse the SAME frustum object with changed planes.
      full.planes[0].constant += 0.001;
      expect(h.water.intersectsReflectionGrassBounds(full, h.box(3, -10))).toBe(
        true,
      );
      h.camera.projectionMatrix.elements[0] += 0.01;
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(3, -10)),
      ).toBe(true);
    } finally {
      release();
      h.dispose();
    }
  });

  it("preserves perspective oblique clip Z/W while retaining the complete sampled rectangle", () => {
    const h = fixture(true);
    // CPU algebra only: nonzero oblique third-row X/Y, just as the reflector
    // modifies its actual camera. No native mirror construction is simulated.
    const e = h.camera.projectionMatrix.elements;
    e[2] = 0.025;
    e[6] = -0.04;
    e[10] = -1.005;
    e[14] = -0.25;
    h.camera.projectionMatrixInverse.copy(h.camera.projectionMatrix).invert();
    h.camera.rotation.set(-0.18, 0.31, 0.07);
    h.camera.updateMatrixWorld(true);
    const projection = h.camera.projectionMatrix.clone();
    h.water.setReflectionGrassFootprintEnabled(true);
    const release = h.begin()!;
    try {
      h.before();
      const full = h.full();
      const scope = h.water["reflectionGrassFootprint"]!;
      expect(scope).not.toBeNull();
      for (const depth of [0.01, 0.25, 0.8]) {
        for (let ix = 0; ix <= 10; ix++)
          for (let iy = 0; iy <= 10; iy++) {
            const u = (60 + ix * 2.5) / 100;
            const v = (10 + iy * 2) / 80;
            const point = new THREE.Vector3(
              2 * u - 1,
              1 - 2 * v,
              depth,
            ).unproject(h.camera);
            const clip = new THREE.Vector4(point.x, point.y, point.z, 1)
              .applyMatrix4(h.camera.matrixWorldInverse)
              .applyMatrix4(projection);
            expect(clip.w).toBeGreaterThan(0);
            const box = new THREE.Box3().setFromCenterAndSize(
              point,
              new THREE.Vector3(1e-5, 1e-5, 1e-5),
            );
            expect(full.intersectsBox(box)).toBe(true);
            expect(h.water.intersectsReflectionGrassBounds(full, box)).toBe(
              true,
            );
          }
      }
      const outside = new THREE.Vector3(-0.8, -0.6, 0.5).unproject(h.camera);
      const box = new THREE.Box3().setFromCenterAndSize(
        outside,
        new THREE.Vector3(1e-5, 1e-5, 1e-5),
      );
      expect(full.intersectsBox(box)).toBe(true);
      expect(h.water.intersectsReflectionGrassBounds(full, box)).toBe(false);
      expect(scope.crop.planes[4]).toEqual(scope.full.planes[4]);
      expect(scope.crop.planes[5]).toEqual(scope.full.planes[5]);
      expect(h.camera.projectionMatrix).toEqual(projection);
    } finally {
      release();
      h.dispose();
    }
  });

  it("suppresses the lease for nested shadow/main passes and restores exact callback descriptors", () => {
    const h = fixture();
    const originalBefore = h.scene.onBeforeRender;
    const originalAfter = h.scene.onAfterRender;
    Object.defineProperty(h.scene, "onBeforeRender", {
      value: originalBefore,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(h.scene, "onAfterRender", {
      value: originalAfter,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const descriptors = [
      Object.getOwnPropertyDescriptor(h.scene, "onBeforeRender"),
      Object.getOwnPropertyDescriptor(h.scene, "onAfterRender"),
    ];
    const shadow = new THREE.RenderTarget(64, 64);
    h.water.setReflectionGrassFootprintEnabled(true);
    const release = h.begin()!;
    try {
      expect(h.before()).toBeUndefined();
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(false);
      const otherCamera = h.camera.clone(); // Equal matrices are not camera ownership.
      h.before(otherCamera, shadow);
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(true);
      expect(h.after(otherCamera, shadow)).toBeUndefined();
      h.renderer.setRenderTarget(h.target);
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(false);
      h.before(otherCamera); // Main/other camera even on the same target.
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(true);
      h.after(otherCamera);
      h.after();
      expect(
        h.water.intersectsReflectionGrassBounds(h.full(), h.box(-10, -10)),
      ).toBe(true);
    } finally {
      release();
      release();
      shadow.dispose();
    }
    expect([
      Object.getOwnPropertyDescriptor(h.scene, "onBeforeRender"),
      Object.getOwnPropertyDescriptor(h.scene, "onAfterRender"),
    ]).toEqual(descriptors);
    h.dispose();
  });

  it("fails open on unsupported samplers, dimensions, projections and callback ownership", () => {
    const h = fixture();
    h.water.setReflectionGrassFootprintEnabled(true);
    try {
      h.target.texture.generateMipmaps = true;
      expect(h.begin()).toBeNull();
      h.target.texture.generateMipmaps = false;
      h.pixels.x = -1;
      expect(h.begin()).toBeNull();
      h.pixels.x = 60;
      Object.defineProperty(h.scene, "onAfterRender", {
        configurable: false,
        value: h.scene.onAfterRender,
      });
      expect(h.begin()).toBeNull();
    } finally {
      h.dispose();
    }
    const f = fixture();
    f.water.setReflectionGrassFootprintEnabled(true);
    const release = f.begin()!;
    try {
      f.camera.projectionMatrix.elements[0] = NaN;
      f.before();
      expect(f.water["reflectionGrassFootprint"]).toBeNull();
      f.after();
      f.camera.updateProjectionMatrix();
      f.before();
      const nonfinite = f.box(0, 0);
      nonfinite.min.x = NaN;
      expect(f.water.intersectsReflectionGrassBounds(f.full(), nonfinite)).toBe(
        true,
      );
      f.target.setSize(101, 80);
      expect(
        f.water.intersectsReflectionGrassBounds(f.full(), f.box(-10, -10)),
      ).toBe(true);
      const foreign = () => {};
      f.scene.onBeforeRender = foreign;
      release();
      expect(f.scene.onBeforeRender).toBe(foreign);
      expect(
        Object.prototype.hasOwnProperty.call(f.scene, "onAfterRender"),
      ).toBe(false);
      expect(f.water["reflectionGrassFootprint"]).toBeNull();
    } finally {
      release();
      f.dispose();
    }
  });

  it.each(["before", "after"] as const)(
    "declines an unknown %s callback without invoking or replacing it",
    (which) => {
      const h = fixture();
      const throwing = () => {
        throw new Error("callback failure");
      };
      if (which === "before") h.scene.onBeforeRender = throwing;
      else h.scene.onAfterRender = throwing;
      const originalBefore = h.scene.onBeforeRender,
        originalAfter = h.scene.onAfterRender;
      h.water.setReflectionGrassFootprintEnabled(true);
      try {
        expect(h.begin()).toBeNull();
        expect(h.scene.onBeforeRender).toBe(originalBefore);
        expect(h.scene.onAfterRender).toBe(originalAfter);
        expect(h.water["reflectionGrassFootprint"]).toBeNull();
      } finally {
        h.dispose();
      }
    },
  );

  it("restores the remaining callback even when a foreign descriptor makes the first restoration throw", () => {
    const h = fixture();
    h.water.setReflectionGrassFootprintEnabled(true);
    const release = h.begin()!;
    try {
      h.before();
      Object.defineProperty(h.scene, "onBeforeRender", { configurable: false });
      expect(release).toThrow();
      expect(
        Object.prototype.hasOwnProperty.call(h.scene, "onAfterRender"),
      ).toBe(false);
      expect(h.water["reflectionGrassFootprint"]).toBeNull();
    } finally {
      release();
      h.dispose();
    }
  });

  it("releases an active nested lease after a synchronous render failure", () => {
    const h = fixture();
    h.water.setReflectionGrassFootprintEnabled(true);
    const release = h.begin()!;
    try {
      expect(() => {
        try {
          h.before();
          h.before(h.camera.clone());
          throw new Error("render failure");
        } finally {
          release();
        }
      }).toThrow("render failure");
      expect(
        Object.prototype.hasOwnProperty.call(h.scene, "onBeforeRender"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(h.scene, "onAfterRender"),
      ).toBe(false);
      expect(h.water["reflectionGrassFootprint"]).toBeNull();
    } finally {
      release();
      h.dispose();
    }
  });
});

describe("WaterSystem conservative reflection footprint", () => {
  const width = 1512;
  const height = 806;

  function createFootprintHarness() {
    const h = createLakePlaneHarness();
    const lake = h.addLake(0);
    const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 200);
    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.position.set(0, 60, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const scissor = new THREE.Vector4();
    const compute = () =>
      h.water["computeLakeReflectionScissor"](
        camera,
        plane,
        width,
        height,
        scissor,
      );
    return { ...h, lake, camera, plane, scissor, compute };
  }

  function expectValidScissor(rect: THREE.Vector4) {
    expect(rect.toArray().every(Number.isSafeInteger)).toBe(true);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.z).toBeGreaterThan(0);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.x + rect.z).toBeLessThanOrEqual(width);
    expect(rect.y + rect.w).toBeLessThanOrEqual(height);
    expect(rect.z * rect.w).toBeLessThan(width * height);
  }

  it("defaults the opt-in off and leaves native reflection policy and resources unchanged", () => {
    const h = createFootprintHarness();
    try {
      expect(h.water["reflectionFootprintEnabled"]).toBe(false);
      const before = h.reflection.reflector.updateBefore;
      const material = h.water.getMaterial("lake")!;
      const position = material.positionNode;
      const reflectionIntensity =
        h.water.waterUniforms!.reflectionIntensity.value;
      for (const enabled of [true, false, true, false]) {
        h.water.setReflectionFootprintEnabled(enabled);
        expect(h.water["reflectionFootprintEnabled"]).toBe(enabled);
        expect(h.reflection.reflector.updateBefore).toBe(before);
        expect(h.reflection.reflector.getUpdateBeforeType()).toBe(
          NodeUpdateType.RENDER,
        );
        expect(h.reflection.reflector.resolutionScale).toBe(0.5);
        expect(material.positionNode).toBe(position);
        expect(h.water.waterUniforms!.reflectionIntensity.value).toBe(
          reflectionIntensity,
        );
      }
      // The pure bounds calculation does not perform renderer work, allocate
      // a virtual camera, or claim a successfully captured reflection.
      expect(h.compute()).toBe(true);
      expect(h.reflection.reflector.renderTargets.size).toBe(0);
      expect(h.reflection.reflector.virtualCameras.has(h.camera)).toBe(false);
      expect(h.water["lastLakeReflectionOwner"]).toBeNull();
    } finally {
      h.water.destroy();
    }
  });

  it.each([1, 2, 16])(
    "admits the non-mip bilinear sampler with texture anisotropy default %s unchanged",
    (anisotropy) => {
      const previous = THREE.Texture.DEFAULT_ANISOTROPY;
      const h = createFootprintHarness();
      let target: THREE.RenderTarget | undefined;
      try {
        THREE.Texture.DEFAULT_ANISOTROPY = anisotropy;
        target = new THREE.RenderTarget(32, 16, {
          type: THREE.HalfFloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: false,
        });
        const texture = target.texture;
        expect(texture.anisotropy).toBe(anisotropy);
        const version = texture.version;
        expect(h.water["hasBilinearLakeReflectionSampler"](texture)).toBe(true);
        expect(texture.anisotropy).toBe(anisotropy);
        expect(texture.version).toBe(version);
      } finally {
        THREE.Texture.DEFAULT_ANISOTROPY = previous;
        target?.dispose();
        h.water.destroy();
      }
    },
  );

  it("rejects mipmapped, nearest or repeating reflection samplers", () => {
    const h = createFootprintHarness();
    const target = new THREE.RenderTarget(32, 16);
    const texture = target.texture;
    const unsupported: Array<Partial<THREE.Texture>> = [
      { generateMipmaps: true },
      { minFilter: THREE.NearestFilter },
      { minFilter: THREE.LinearMipmapLinearFilter },
      { minFilter: THREE.LinearMipmapNearestFilter },
      { magFilter: THREE.NearestFilter },
      { wrapS: THREE.RepeatWrapping },
      { wrapT: THREE.MirroredRepeatWrapping },
    ];
    try {
      for (const change of unsupported) {
        Object.assign(texture, {
          generateMipmaps: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          anisotropy: 16,
        });
        expect(h.water["hasBilinearLakeReflectionSampler"](texture)).toBe(true);
        Object.assign(texture, change);
        expect(h.water["hasBilinearLakeReflectionSampler"](texture)).toBe(
          false,
        );
      }
    } finally {
      target.dispose();
      h.water.destroy();
    }
  });

  it("uses reflected X and top-left Y coordinates, including non-square target rounding", () => {
    const h = createFootprintHarness();
    try {
      h.lake.scale.setScalar(0.4);
      h.lake.position.set(18, 0, -14);
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      expectValidScissor(h.scissor);
      expect(h.scissor.x + h.scissor.z).toBeLessThan(width / 2);
      expect(h.scissor.y + h.scissor.w).toBeLessThan(height / 2);
      const first = h.scissor.clone();
      h.lake.position.x += 8;
      h.lake.position.z += 6;
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      // One tenth of the camera span moves left in reflection U, down in V.
      expect(Math.abs(h.scissor.x - first.x + width / 10)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(h.scissor.y - first.y - height / 10)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(h.scissor.z - first.z)).toBeLessThanOrEqual(1);
      expect(Math.abs(h.scissor.w - first.w)).toBeLessThanOrEqual(1);
    } finally {
      h.water.destroy();
    }
  });

  it("unions every coplanar registered consumer but does not include another elevation", () => {
    const h = createFootprintHarness();
    try {
      h.lake.position.x = -18;
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      const first = h.scissor.clone();
      h.water.unregisterWaterMesh(h.lake);
      const second = h.addLake(0);
      second.position.x = 18;
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      const other = h.scissor.clone();
      h.water.registerWaterMesh(h.lake);
      expect(h.compute()).toBe(true);
      const union = h.scissor.clone();
      expect(union.toArray()).toEqual([
        Math.min(first.x, other.x),
        Math.min(first.y, other.y),
        Math.max(first.x + first.z, other.x + other.z) -
          Math.min(first.x, other.x),
        Math.max(first.y + first.w, other.y + other.w) -
          Math.min(first.y, other.y),
      ]);
      const elevated = h.addLake(12);
      elevated.position.set(32, 12, -22);
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      expect(h.scissor.equals(union)).toBe(true);
      h.plane.negate();
      expect(h.compute()).toBe(true);
      expect(h.scissor.equals(union)).toBe(true);
    } finally {
      h.water.destroy();
    }
  });

  it("contains actual wave-graph samples, distortion extrema and bilinear taps under transformed parents", () => {
    const h = createFootprintHarness();
    try {
      const parent = new THREE.Group();
      parent.position.set(3, 7, -5);
      parent.rotation.set(0.18, 0.4, -0.15);
      parent.scale.set(1.5, 0.8, 1.2);
      h.scene.add(parent);
      parent.add(h.lake);
      h.lake.position.y = 2;
      h.lake.rotation.y = 0.31;
      h.scene.updateMatrixWorld(true);
      expect(h.water["readLakeReflectionPlane"](h.lake, h.plane)).toBe(true);
      const center = h.lake.getWorldPosition(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 250);
      camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
      camera.position.copy(center).add(new THREE.Vector3(18, 35, 45));
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      const material = h.water.getMaterial("lake")!;
      const positionNode: unknown = material.positionNode;
      if (!(positionNode instanceof THREE.Node))
        throw new Error("Missing lake wave graph");
      const graph = inspectGraph(positionNode, camera);
      const shoreNodes = [...graph.nodes].filter(
        (node) =>
          node.type === "AttributeNode" &&
          Reflect.get(node, "_attributeName") === "shoreDistance",
      );
      expect(shoreNodes).toHaveLength(1);
      const attribute = h.lake.geometry.getAttribute("position");
      const indices = h.lake.geometry.getIndex()!;
      const originalPositions = Array.from(attribute.array);
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < attribute.count; i++)
        points.push(new THREE.Vector3().fromBufferAttribute(attribute, i));
      let seed = 0x732ab1;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      // Actual triangle barycentrics, including edge vertices, not points
      // invented outside the submitted lake geometry.
      for (let i = 0; i < 64; i++) {
        const triangle = Math.floor(random() * (indices.count / 3)) * 3;
        const a = new THREE.Vector3().fromBufferAttribute(
          attribute,
          indices.getX(triangle),
        );
        const b = new THREE.Vector3().fromBufferAttribute(
          attribute,
          indices.getX(triangle + 1),
        );
        const c = new THREE.Vector3().fromBufferAttribute(
          attribute,
          indices.getX(triangle + 2),
        );
        const u = Math.sqrt(random());
        const v = random();
        points.push(
          a
            .multiplyScalar(1 - u)
            .addScaledVector(b, u * (1 - v))
            .addScaledVector(c, u * v),
        );
      }
      const clipMatrix = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      let checkedSamples = 0;
      for (const wind of [-3, 0, 2.75]) {
        h.water.waterUniforms!.windStrength.value = wind;
        expect(
          h.water["computeLakeReflectionScissor"](
            camera,
            h.plane,
            width,
            height,
            h.scissor,
          ),
        ).toBe(true);
        expectValidScissor(h.scissor);
        for (const time of [0, 3.25, 17]) {
          h.water.waterUniforms!.time.value = time;
          for (let i = 0; i < points.length; i++) {
            const local = points[i];
            const undisplacedWorld = local
              .clone()
              .applyMatrix4(h.lake.matrixWorld);
            const displaced = numeric(
              positionNode,
              new Map<Node, number[]>([
                [positionLocal, local.toArray()],
                [positionWorld, undisplacedWorld.toArray()],
                [shoreNodes[0], [[0, 1, 10][i % 3]]],
              ]),
              graph.expanded,
            );
            expect(displaced).toHaveLength(3);
            const clip = new THREE.Vector4(
              displaced[0],
              displaced[1],
              displaced[2],
              1,
            )
              .applyMatrix4(h.lake.matrixWorld)
              .applyMatrix4(clipMatrix);
            expect(clip.w).toBeGreaterThan(0);
            expect(Math.abs(clip.x / clip.w)).toBeLessThan(1);
            expect(Math.abs(clip.y / clip.w)).toBeLessThan(1);
            for (const distortionX of [-0.015, 0, 0.015])
              for (const distortionY of [-0.015, 0, 0.015]) {
                const u = (1 - clip.x / clip.w) / 2 + distortionX;
                const v = (1 - clip.y / clip.w) / 2 + distortionY;
                const ix = Math.floor(u * width - 0.5);
                const iy = Math.floor(v * height - 0.5);
                for (const dx of [0, 1])
                  for (const dy of [0, 1]) {
                    const x = Math.min(width - 1, Math.max(0, ix + dx));
                    const y = Math.min(height - 1, Math.max(0, iy + dy));
                    expect(x).toBeGreaterThanOrEqual(h.scissor.x);
                    expect(x).toBeLessThan(h.scissor.x + h.scissor.z);
                    expect(y).toBeGreaterThanOrEqual(h.scissor.y);
                    expect(y).toBeLessThan(h.scissor.y + h.scissor.w);
                  }
                checkedSamples++;
              }
          }
        }
      }
      expect(checkedSamples).toBe(points.length * 81);
      expect(Array.from(attribute.array)).toEqual(originalPositions);
      expect(h.reflection.reflector.renderTargets.size).toBe(0);
    } finally {
      h.water.destroy();
    }
  });

  it("expands symmetrically for negative and positive wind and re-reads parent transforms", () => {
    const h = createFootprintHarness();
    try {
      h.camera.position.set(0, 35, 45);
      h.camera.up.set(0, 1, 0);
      h.camera.lookAt(0, 0, 0);
      h.camera.updateMatrixWorld(true);
      h.water.waterUniforms!.windStrength.value = 0;
      expect(h.compute()).toBe(true);
      const calm = h.scissor.clone();
      h.water.waterUniforms!.windStrength.value = 8;
      expect(h.compute()).toBe(true);
      const positive = h.scissor.clone();
      expect(positive.y).toBeLessThan(calm.y);
      expect(positive.y + positive.w).toBeGreaterThan(calm.y + calm.w);
      h.water.waterUniforms!.windStrength.value = -8;
      expect(h.compute()).toBe(true);
      expect(h.scissor.equals(positive)).toBe(true);
      const parent = new THREE.Group();
      h.scene.add(parent);
      parent.add(h.lake);
      parent.position.x = 8;
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      expect(h.scissor.x).toBeLessThan(positive.x);
    } finally {
      h.water.destroy();
    }
  });

  it("falls back for an eye-plane crossing, non-finite projection and array cameras", () => {
    const h = createFootprintHarness();
    try {
      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 200);
      camera.position.set(0, 0.1, 0);
      camera.lookAt(0, 0.1, -1);
      camera.updateMatrixWorld(true);
      expect(
        h.water["computeLakeReflectionScissor"](
          camera,
          h.plane,
          width,
          height,
          h.scissor,
        ),
      ).toBe(false);
      camera.position.set(0, 30, 40);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      camera.projectionMatrix.elements[0] = NaN;
      expect(
        h.water["computeLakeReflectionScissor"](
          camera,
          h.plane,
          width,
          height,
          h.scissor,
        ),
      ).toBe(false);
      const array = new THREE.ArrayCamera([new THREE.PerspectiveCamera()]);
      expect(
        h.water["computeLakeReflectionScissor"](
          array,
          h.plane,
          width,
          height,
          h.scissor,
        ),
      ).toBe(false);
    } finally {
      h.water.destroy();
    }
  });

  it("falls back for invalid extents, wind, world transforms and absent consumers", () => {
    const h = createFootprintHarness();
    try {
      for (const [w, t] of [
        [0, height],
        [width, 0],
        [-1, height],
        [width, 1.5],
        [Infinity, height],
        [width, NaN],
      ])
        expect(
          h.water["computeLakeReflectionScissor"](
            h.camera,
            h.plane,
            w,
            t,
            h.scissor,
          ),
        ).toBe(false);
      const wind = h.water.waterUniforms!.windStrength.value;
      for (const value of [NaN, Infinity, -Infinity]) {
        h.water.waterUniforms!.windStrength.value = value;
        expect(h.compute()).toBe(false);
      }
      h.water.waterUniforms!.windStrength.value = wind;
      const matrix = h.lake.matrixWorld.clone();
      h.lake.matrixWorld.elements[0] = Infinity;
      expect(h.compute()).toBe(false);
      h.lake.matrixWorld.copy(matrix).scale(new THREE.Vector3(0, 1, 1));
      expect(h.compute()).toBe(false);
      h.lake.matrixWorld.copy(matrix);
      h.water.unregisterWaterMesh(h.lake);
      expect(h.compute()).toBe(false);
    } finally {
      h.water.destroy();
    }
  });

  it("falls back for non-finite or non-unit owner planes", () => {
    const h = createFootprintHarness();
    try {
      expect(h.compute()).toBe(true);
      for (const plane of [
        new THREE.Plane(new THREE.Vector3(NaN, 1, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, Infinity, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), NaN),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), Infinity),
        new THREE.Plane(new THREE.Vector3(0, 0, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 2, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 0.5, 0), 0),
      ]) {
        h.plane.copy(plane);
        expect(h.compute()).toBe(false);
      }
      h.plane.setComponents(0, 1, 0, 0);
      expect(h.compute()).toBe(true);
    } finally {
      h.water.destroy();
    }
  });

  it("falls back for stale geometry versions, custom callbacks, morphs and replaced displacement", () => {
    const h = createFootprintHarness();
    try {
      expect(h.compute()).toBe(true);
      const position = h.lake.geometry.getAttribute("position");
      position.needsUpdate = true;
      expect(h.compute()).toBe(false);
      h.water.unregisterWaterMesh(h.lake);
      h.water.registerWaterMesh(h.lake);
      expect(h.compute()).toBe(true);
      const callback = h.lake.onBeforeRender;
      h.lake.onBeforeRender = () => {
        h.lake.position.x += 1;
      };
      expect(h.compute()).toBe(false);
      expect(h.lake.position.x).toBe(0);
      h.lake.onBeforeRender = callback;
      h.lake.geometry.morphAttributes.position = [position.clone()];
      h.lake.updateMorphTargets();
      expect(h.compute()).toBe(false);
      delete h.lake.geometry.morphAttributes.position;
      h.lake.updateMorphTargets();
      expect(h.compute()).toBe(true);
      const material = h.water.getMaterial("lake")!;
      const vertex = material.vertexNode;
      material.vertexNode = positionLocal;
      expect(h.compute()).toBe(false);
      material.vertexNode = vertex;
      expect(h.compute()).toBe(true);
      material.positionNode = positionLocal;
      expect(h.compute()).toBe(false);
    } finally {
      h.water.destroy();
    }
  });

  it("falls back for real instanced, skinned and batched mesh consumers", () => {
    const h = createFootprintHarness();
    const material = h.water.getMaterial("lake")!;
    const instance = new THREE.InstancedMesh(h.lake.geometry, material, 1);
    instance.setMatrixAt(0, new THREE.Matrix4());
    const skinned = new THREE.SkinnedMesh(h.lake.geometry, material);
    const batched = new THREE.BatchedMesh(1, 100, 200, material);
    const geometryId = batched.addGeometry(h.lake.geometry);
    batched.addInstance(geometryId);
    try {
      for (const mesh of [instance, skinned, batched]) {
        h.scene.add(mesh);
        h.scene.updateMatrixWorld(true);
        h.water.registerWaterMesh(mesh);
        expect(h.compute()).toBe(false);
        h.water.unregisterWaterMesh(mesh);
        h.scene.remove(mesh);
        expect(h.compute()).toBe(true);
      }
    } finally {
      instance.dispose();
      batched.dispose();
      h.water.destroy();
    }
  });

  it("uses full fallback for a full-screen or empty projected footprint and bounds edge samples", () => {
    const h = createFootprintHarness();
    try {
      h.lake.position.set(38, 0, -28);
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(true);
      expectValidScissor(h.scissor);
      expect(h.scissor.x).toBe(0);
      expect(h.scissor.y).toBe(0);
      h.lake.scale.setScalar(30);
      h.lake.position.set(0, 0, 0);
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(false);
      h.lake.scale.setScalar(1);
      h.lake.position.x = 200;
      h.scene.updateMatrixWorld(true);
      expect(h.compute()).toBe(false);
    } finally {
      h.water.destroy();
    }
  });
});
