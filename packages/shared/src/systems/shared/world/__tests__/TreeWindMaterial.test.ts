import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import { createStorageInstancedMesh } from "../../../../utils/rendering/createStorageInstancedMesh";
import {
  createTreeDissolveMaterial,
  type TreeMaterialOptions,
} from "../GPUMaterials";
import {
  TREE_WIND_ATTRIBUTE,
  cloneGeometryWithTreeWind,
  deriveTreeWindDescriptor,
} from "../TreeWind";
import { SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";

// Real materials, geometry, instance storage and NodeBuilder stacks only.
// No renderer/device/capability mock or native GPU qualification.
function fixture() {
  const map = new THREE.DataTexture(new Uint8Array([120, 160, 80, 192]), 1, 1);
  const normalMap = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
  );
  map.colorSpace = THREE.SRGBColorSpace;
  const source = new THREE.MeshStandardMaterial({
    name: "leaf",
    map,
    normalMap,
    roughnessMap: map,
    metalnessMap: map,
    aoMap: map,
    emissiveMap: map,
    color: 0x889966,
    roughness: 0.87,
    metalness: 0.02,
    emissive: 0x010203,
    emissiveIntensity: 0.2,
    alphaTest: 0.5,
    transparent: true,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BoxGeometry(2, 12, 2);
  geometry.translate(0, 6, 0);
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from({ length: geometry.attributes.position.count }, () => [
        1, 0.6, 0,
      ]).flat(),
      3,
    ),
  );
  const owned = cloneGeometryWithTreeWind(
    geometry,
    deriveTreeWindDescriptor([geometry], 0),
  );
  return {
    source,
    map,
    normalMap,
    geometry,
    owned,
    dispose() {
      owned.dispose();
      geometry.dispose();
      source.dispose();
      map.dispose();
      normalMap.dispose();
    },
  };
}

function node(value: unknown): Node {
  if (!(value instanceof THREE.Node))
    throw new Error("Expected actual Three Node");
  return value;
}

function expand(root: unknown, mesh: THREE.Mesh): Node[] {
  let actual = node(root);
  while (Reflect.get(actual, "isVarNode"))
    actual = node(Reflect.get(actual, "node"));
  const builder: unknown = Reflect.construct(THREE.NodeBuilder, [
    mesh,
    null,
    null,
  ]);
  if (!(builder instanceof THREE.NodeBuilder))
    throw new Error("Missing native builder");
  Reflect.set(builder, "camera", new THREE.PerspectiveCamera(50, 1, 0.1, 1000));
  Reflect.set(builder, "shaderStage", "vertex");
  const add: unknown = Reflect.get(builder, "addStack");
  const remove: unknown = Reflect.get(builder, "removeStack");
  if (typeof add !== "function" || typeof remove !== "function")
    throw new Error("Missing native stack API");
  add.call(builder);
  try {
    const shader: unknown = Reflect.get(actual, "shaderNode");
    const callback: unknown =
      shader instanceof THREE.Node ? Reflect.get(shader, "jsFunc") : undefined;
    const result =
      typeof callback === "function" ? node(callback(builder)) : actual;
    const stack: unknown = Reflect.get(builder, "stack");
    if (!(stack instanceof THREE.StackNode))
      throw new Error("Missing native stack");
    return [...stack.nodes, result];
  } finally {
    remove.call(builder);
  }
}

function nodes(roots: readonly Node[]) {
  const result = new Set<Node>();
  const visit = (n: Node) => {
    if (result.has(n)) return;
    if (result.size >= 4096) throw new Error("Bounded graph exceeded");
    result.add(n);
    for (const child of n.getChildren()) visit(child);
  };
  roots.forEach(visit);
  return result;
}

function structure(roots: readonly Node[]) {
  const seen = new Map<Node, number>();
  const visit = (n: Node): unknown => {
    const previous = seen.get(n);
    if (previous !== undefined) return { ref: previous };
    if (seen.size >= 4096) throw new Error("Bounded graph exceeded");
    seen.set(n, seen.size);
    const value: unknown = Reflect.get(n, "value");
    return {
      type: n.type,
      nodeType: n.nodeType,
      fields: [
        "op",
        "method",
        "components",
        "name",
        "snippet",
        "_attributeName",
      ].map((key) => Reflect.get(n, key)),
      value:
        typeof value === "number" || typeof value === "boolean"
          ? value
          : value instanceof THREE.Color ||
              value instanceof THREE.Vector2 ||
              value instanceof THREE.Vector3
            ? value.toArray()
            : value instanceof THREE.Texture
              ? value.uuid
              : undefined,
      children: [...n.getChildren()].map(visit),
    };
  };
  return roots.map(visit);
}

describe("tree material wind selection", () => {
  it("defaults to exact explicit legacy graph and keeps its immutable receipt separate", () => {
    const f = fixture();
    const defaultMaterial = createTreeDissolveMaterial(f.source);
    const explicit = createTreeDissolveMaterial(f.source, {
      treeWind: "legacy-leaf-v1",
    });
    const mesh = new THREE.Mesh(f.geometry, defaultMaterial);
    try {
      expect(structure(expand(defaultMaterial.positionNode, mesh))).toEqual(
        structure(expand(explicit.positionNode, mesh)),
      );
      const graph = nodes(expand(defaultMaterial.positionNode, mesh));
      expect(
        [...graph].some((n) => Reflect.get(n, "_attributeName") === "color"),
      ).toBe(true);
      for (const value of [1.8, 3.2, 0.65, 0.35, 0.006])
        expect([...graph].some((n) => Reflect.get(n, "value") === value)).toBe(
          true,
        );
      expect(defaultMaterial.treeWind).toEqual({ mode: "legacy-leaf-v1" });
      expect(Object.isFrozen(defaultMaterial.treeWind)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(defaultMaterial, "treeWind"),
      ).toMatchObject({
        writable: false,
        configurable: false,
        enumerable: true,
      });
      expect(
        Reflect.set(defaultMaterial.treeWind, "mode", "connected-v1"),
      ).toBe(false);
      expect(
        Reflect.set(defaultMaterial, "treeWind", { mode: "connected-v1" }),
      ).toBe(false);
      expect(defaultMaterial.treeLighting).toEqual(explicit.treeLighting);
      expect(
        Object.prototype.hasOwnProperty.call(
          defaultMaterial.treeLighting,
          "treeWind",
        ),
      ).toBe(false);
    } finally {
      defaultMaterial.dispose();
      explicit.dispose();
      f.dispose();
    }
  });

  it.each([true, false])(
    "connected mode reuses existing wind uniforms on actual batched=%s geometry",
    (batched) => {
      const f = fixture();
      const material = createTreeDissolveMaterial(f.source, {
        batched,
        treeWind: "connected-v1",
      });
      const mesh = batched
        ? new THREE.BatchedMesh(
            4,
            f.owned.attributes.position.count,
            f.owned.index?.count ?? 0,
            material,
          )
        : createStorageInstancedMesh(f.owned, material, 4);
      if (mesh instanceof THREE.BatchedMesh)
        mesh.addInstance(mesh.addGeometry(f.owned));
      mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(449, 28, 410));
      try {
        const graph = nodes(expand(material.positionNode, mesh));
        expect(material.treeWind).toEqual({ mode: "connected-v1" });
        expect(Object.isFrozen(material.treeWind)).toBe(true);
        for (const uniform of [
          material.treeUniforms.windTime,
          material.treeUniforms.windStrength,
          material.treeUniforms.windDirection,
        ]) {
          expect(graph.has(node(uniform))).toBe(true);
        }
        expect(material.treeUniforms.windTime.value).toBe(0);
        expect(material.treeUniforms.windStrength.value).toBe(0.3);
        expect(material.treeUniforms.windDirection.value.toArray()).toEqual([
          1, 0,
        ]);
        material.treeUniforms.windTime.value = 8.25;
        material.treeUniforms.windStrength.value = 1.4;
        material.treeUniforms.windDirection.value.set(0.6, 0.8);
        expect(Reflect.get(node(material.treeUniforms.windTime), "value")).toBe(
          8.25,
        );
        expect(
          Reflect.get(node(material.treeUniforms.windStrength), "value"),
        ).toBe(1.4);
        expect(
          [...graph].some(
            (n) => Reflect.get(n, "_attributeName") === TREE_WIND_ATTRIBUTE,
          ),
        ).toBe(true);
        expect(
          [...graph].some((n) => Reflect.get(n, "_attributeName") === "color"),
        ).toBe(false);
        expect(
          [...graph].filter((n) => Reflect.get(n, "isTextureNode")),
        ).toHaveLength(batched ? 2 : 0);
        if (mesh instanceof THREE.InstancedMesh) {
          const buffers = [...graph].filter((n) =>
            Reflect.get(n, "isStorageBufferNode"),
          );
          expect(buffers).toHaveLength(1);
          expect(Reflect.get(buffers[0], "value")).toBe(mesh.instanceMatrix);
        }
        expect(material.castShadowPositionNode).toBeNull();
        expect(f.geometry.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
      } finally {
        mesh.dispose();
        material.dispose();
        f.dispose();
      }
    },
  );

  it.each(
    [true, false].flatMap((compact) =>
      [true, false].map((batched) => ({ compact, batched })),
    ),
  )(
    "preserves all non-position material graphs and source owners: compact=$compact batched=$batched",
    ({ compact, batched }) => {
      const f = fixture();
      const options: TreeMaterialOptions = {
        batched,
        ...(compact
          ? {
              treePalette: {
                terrainProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
                species: "maple",
              },
            }
          : {}),
      };
      const legacy = createTreeDissolveMaterial(f.source, options);
      const connected = createTreeDissolveMaterial(f.source, {
        ...options,
        treeWind: "connected-v1",
      });
      const mesh = new THREE.Mesh(f.owned, connected);
      let textureDisposals = 0;
      const onDispose = () => {
        textureDisposals++;
      };
      f.map.addEventListener("dispose", onDispose);
      f.normalMap.addEventListener("dispose", onDispose);
      try {
        for (const field of [
          "colorNode",
          "aoNode",
          "opacityNode",
          "alphaTestNode",
          "outputNode",
        ] as const) {
          if (legacy[field] === null) expect(connected[field]).toBeNull();
          else
            expect(structure(expand(connected[field], mesh))).toEqual(
              structure(expand(legacy[field], mesh)),
            );
        }
        for (const field of [
          "roughness",
          "metalness",
          "emissiveIntensity",
          "side",
          "transparent",
          "depthWrite",
          "depthTest",
          "opacity",
          "alphaTest",
          "alphaToCoverage",
          "fog",
          "vertexColors",
          "blending",
          "toneMapped",
          "castShadowNode",
          "castShadowPositionNode",
          "shadowNode",
          "normalNode",
          "envNode",
        ] as const)
          expect(connected[field]).toEqual(legacy[field]);
        for (const field of [
          "map",
          "normalMap",
          "emissiveMap",
          "roughnessMap",
          "metalnessMap",
          "aoMap",
        ] as const) {
          expect(connected[field]).toBe(f.source[field]);
          expect(connected[field]).toBe(legacy[field]);
        }
        expect(connected.color).toEqual(legacy.color);
        expect(connected.emissive).toEqual(legacy.emissive);
        expect(connected.treeLighting).toEqual(legacy.treeLighting);
        expect(f.source.transparent).toBe(true);
        expect(f.source.vertexColors).toBe(true);
        expect(f.source.color.getHex()).toBe(0x889966);
      } finally {
        try {
          legacy.dispose();
          connected.dispose();
          expect(textureDisposals).toBe(0);
        } finally {
          f.map.removeEventListener("dispose", onDispose);
          f.normalMap.removeEventListener("dispose", onDispose);
          f.dispose();
        }
      }
    },
  );

  it("rejects unknown selection and missing connected geometry instead of a silent fallback", () => {
    const f = fixture();
    const material = createTreeDissolveMaterial(f.source, {
      treeWind: "connected-v1",
    });
    const mesh = createStorageInstancedMesh(f.geometry, material, 1);
    try {
      expect(() =>
        Reflect.apply(createTreeDissolveMaterial, undefined, [
          f.source,
          { treeWind: "unknown" },
        ]),
      ).toThrow("Unsupported tree wind mode");
      expect(() => expand(material.positionNode, mesh)).toThrow(
        "owned height metadata",
      );
      expect(material.treeWind.mode).toBe("connected-v1");
    } finally {
      mesh.dispose();
      material.dispose();
      f.dispose();
    }
  });
});
