import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { diffuseColor, output, vec3 } from "three/tsl";
import WGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
import { createTreeDissolveMaterial } from "../GPUMaterials";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  LEGACY_TERRAIN_PROFILE_FIXTURE,
} from "../WorldTerrainProfile";

// Actual r186 material and NodeBuilder graph construction. No renderer, device,
// browser, shader replacement, or claim of GPU execution is involved.
function fixture({ compact = true, batched = true, name = "leaf" } = {}) {
  const map = new THREE.DataTexture(new Uint8Array([183, 87, 87, 87]), 1, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  const source = new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.87,
    metalness: 0,
  });
  source.name = name;
  const material = createTreeDissolveMaterial(source, {
    batched,
    treePalette: {
      terrainProfile: compact
        ? SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE
        : LEGACY_TERRAIN_PROFILE_FIXTURE,
      species: "maple",
    },
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      [1, 0.2, 0, 1, 0.4, 0, 1, 0.6, 0, 1, 0.8, 0],
      3,
    ),
  );
  const mesh = batched
    ? new THREE.BatchedMesh(4, 8, 12, material)
    : new THREE.InstancedMesh(geometry, material, 1);
  if (batched) {
    const id = mesh.addInstance(mesh.addGeometry(geometry));
    // R hover, G snow, B depletion. Zero green must never erase leaf green.
    mesh.setColorAt(id, new THREE.Color(1, 0, 1));
  } else {
    mesh.setColorAt(0, new THREE.Color(1, 0, 1));
  }
  return {
    map,
    source,
    material,
    geometry,
    mesh,
    dispose() {
      if (batched) mesh.dispose();
      geometry.dispose();
      material.dispose();
      source.dispose();
      map.dispose();
    },
  };
}

function unwrap(node) {
  while (node?.isVarNode) node = node.node;
  return node;
}

function expand(node) {
  const unwrapped = unwrap(node);
  if (unwrapped.shaderNode?.jsFunc) return unwrapped.shaderNode.jsFunc();
  return unwrapped;
}

function nodes(root) {
  const all = new Set();
  const visit = (node) => {
    if (!node?.isNode || all.has(node)) return;
    expect(all.size).toBeLessThan(4096);
    all.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return all;
}

function diffuseSetup(f, setup = f.material.setupDiffuseColor) {
  const builder = new THREE.NodeBuilder(f.mesh, null, null);
  builder.shaderStage = "fragment";
  builder.addStack();
  try {
    setup.call(f.material, builder);
    return [...builder.stack.nodes];
  } finally {
    builder.removeStack();
  }
}

function assignment(node) {
  node = unwrap(node);
  expect(node.isAssignNode).toBe(true);
  return node;
}

function graphStructure(node) {
  return {
    type: node.type,
    nodeType: node.nodeType,
    op: node.op,
    method: node.method,
    components: node.components,
    name: node.name,
    snippet: node.snippet,
    value: typeof node.value === "number" ? node.value : undefined,
    children: [...node.getChildren()].map(graphStructure),
  };
}

describe("compact tree native scene lighting", () => {
  it.each([true, false])(
    "preserves native alpha/discard setup and replaces only mask-multiplied RGB (batched=%s)",
    (batched) => {
      expect(THREE.REVISION).toBe("186");
      const f = fixture({ batched });
      try {
        const native = diffuseSetup(
          f,
          THREE.MeshStandardNodeMaterial.prototype.setupDiffuseColor,
        );
        const actual = diffuseSetup(f);
        // Native r186 setup contains RGB, opacity, alpha-test discard, and
        // opaque alpha normalization. Our sole extra operation is last.
        expect(actual.length).toBe(native.length + 1);
        expect(actual.slice(0, -1).map((node) => node.type)).toEqual(
          native.map((node) => node.type),
        );
        expect(actual.slice(0, -1).map(graphStructure)).toEqual(
          native.map(graphStructure),
        );
        const discard = native.find((node) => node.type === "ConditionalNode");
        expect(discard).toBeDefined();
        expect(discard.ifNode.snippet).toBe("discard");
        expect(nodes(discard.condNode).has(f.material.alphaTestNode)).toBe(
          true,
        );
        const originalRGB = assignment(
          native.find(
            (node) => node.isAssignNode && node.targetNode === diffuseColor,
          ),
        );
        expect(originalRGB.targetNode).toBe(diffuseColor);
        const nativeInputs = nodes(originalRGB.sourceNode);
        expect(
          [...nativeInputs].some(
            (node) =>
              node.name === (batched ? "vBatchColor" : "vInstanceColor"),
          ),
        ).toBe(true);
        const replacement = assignment(actual.at(-1));
        expect(replacement.targetNode.node).toBe(diffuseColor);
        expect(replacement.targetNode.components).toBe("xyz");
        const converted = unwrap(replacement.sourceNode);
        expect(converted.type).toBe("ConvertNode");
        expect(converted.convertTo).toBe("vec3");
        expect(converted.node).toBe(f.material.colorNode);
        // No alpha reassignment/discard replacement is introduced by our hook.
        const alpha = assignment(actual.at(-2));
        expect(alpha.targetNode.node).toBe(diffuseColor);
        expect(alpha.targetNode.components).toBe("w");
        expect(unwrap(alpha.sourceNode).value).toBe(1);
        expect(f.material.opacityNode).toBeTruthy();
        expect(f.material.alphaTestNode).toBeTruthy();
        expect(f.material.alphaTest).toBe(0.5);
      } finally {
        f.dispose();
      }
    },
  );

  it("generates intact replacement RGB with a real zero-green batch mask", () => {
    const f = fixture();
    try {
      // A controlled actual color-node input tests the native setup boundary;
      // separate real-asset palette tests qualify the textured albedo graph.
      f.material.colorNode = vec3(0.2, 0.4, 0.6);
      const actual = diffuseSetup(f);
      const replacement = assignment(actual.at(-1));
      const builder = new WGSLNodeBuilder(f.mesh, null);
      builder.shaderStage = "fragment";
      const generated = builder.flowStagesNode(replacement.sourceNode, "vec3");
      expect(generated.code).toBe("");
      expect(generated.result).toBe("vec3<f32>( 0.2, 0.4, 0.6 )");
      const batchMask = new THREE.Color();
      f.mesh.getColorAt(0, batchMask);
      expect(batchMask.toArray()).toEqual([1, 0, 1]);
    } finally {
      f.dispose();
    }
  });

  it("uses native lit RGB/alpha and retains hover and sky fog, not custom ramp/SSS/saturation", () => {
    const f = fixture();
    try {
      const graph = nodes(expand(f.material.outputNode));
      const channels = [...graph]
        .filter((node) => node.node === output)
        .map((node) => node.components);
      expect(channels).toContain("xyz");
      expect(channels).toContain("w");
      expect(graph.has(f.material.treeUniforms.sunIntensity)).toBe(false);
      expect(graph.has(f.material.treeUniforms.shadeColor)).toBe(false);
      expect(graph.has(f.material.treeUniforms.illumination.blend)).toBe(false);
      expect(graph.has(f.material.highlightColor)).toBe(true);
      expect([...graph].some((node) => node.name === "vBatchColor")).toBe(true);
      expect([...graph].some((node) => node.isTextureNode)).toBe(true);
      expect(f.material.envMap).toBeNull();
      expect(f.material.envNode).toBeNull();
      expect(f.material.lights).toBe(true);
      expect(f.material.fog).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("keeps map, wind, AO and snow as separate material inputs without source mutation", () => {
    const f = fixture();
    try {
      expect(f.material.map).toBe(f.map);
      expect(f.source.vertexColors).toBe(true);
      expect(f.material.vertexColors).toBe(false);
      expect(f.source.color.getHex()).toBe(0xffffff);
      expect([...f.map.image.data]).toEqual([183, 87, 87, 87]);
      expect(f.material.roughness).toBe(f.source.roughness);
      expect(f.material.metalness).toBe(f.source.metalness);
      const albedo = nodes(expand(f.material.colorNode));
      expect(
        [...albedo].some((n) => n.isTextureNode && n.value === f.map),
      ).toBe(true);
      expect([...albedo].some((n) => n.name === "vBatchColor")).toBe(true);
      expect([...albedo].some((n) => n._attributeName === "color")).toBe(true);
      const ao = nodes(f.material.aoNode);
      expect([...ao].some((n) => n._attributeName === "color")).toBe(true);
      expect([...ao].some((n) => n.name === "vBatchColor")).toBe(false);
      const wind = nodes(expand(f.material.positionNode));
      expect(wind.has(f.material.treeUniforms.windTime)).toBe(true);
      expect([...wind].some((n) => n._attributeName === "color")).toBe(true);
      expect(f.material.treeLighting).toEqual({
        mode: "scene-pbr-mask-safe-v1",
        sourceMaterialName: "leaf",
        species: "maple",
        compactPaletteApplied: true,
      });
      expect(Object.isFrozen(f.material.treeLighting)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(f.material, "treeLighting").writable,
      ).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("keeps bark untinted and noncompact legacy material behavior opt-in", () => {
    const bark = fixture({ name: "bark" });
    const legacy = fixture({ compact: false });
    try {
      expect(bark.material.color).toEqual(bark.source.color);
      expect(bark.material.treeLighting.compactPaletteApplied).toBe(false);
      expect(bark.material.treeLighting.mode).toBe("scene-pbr-mask-safe-v1");
      expect(legacy.material.treeLighting.mode).toBe("legacy-custom-rgb");
      expect(legacy.material.vertexColors).toBe(true);
      expect(legacy.material.colorNode).toBeNull();
      expect(legacy.material.aoNode).toBeNull();
      expect(legacy.material.setupDiffuseColor).toBe(
        THREE.MeshStandardNodeMaterial.prototype.setupDiffuseColor,
      );
      const graph = nodes(expand(legacy.material.outputNode));
      expect(graph.has(legacy.material.treeUniforms.illumination.blend)).toBe(
        true,
      );
    } finally {
      bark.dispose();
      legacy.dispose();
    }
  });
});
