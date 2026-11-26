import { readFileSync, statSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import THREE, { type Node } from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { TerrainSystem } from "../TerrainSystem";
import { createTreeDissolveMaterial } from "../GPUMaterials";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  LEGACY_TERRAIN_PROFILE_FIXTURE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
} from "../WorldTerrainProfile";

type GlbDescription = {
  materials: Array<{
    name: string;
    pbrMetallicRoughness: {
      baseColorFactor: [number, number, number, number];
      baseColorTexture: { index: number };
      roughnessFactor: number;
    };
  }>;
  textures: Array<{ source: number }>;
  images: Array<{ bufferView: number; mimeType: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
};

/** Read only the two resident source models; no GLTF network/decoder substitutes. */
function actualLeafSource(species: "maple" | "magic") {
  const file = new URL(
    `../../../../../../server/world/assets/models/trees/${species}/${species}_01.glb`,
    import.meta.url,
  );
  expect(statSync(file).size).toBeLessThan(4_000_000);
  const bytes = readFileSync(file);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLength = bytes.readUInt32LE(12);
  expect(jsonLength).toBeLessThan(1_000_000);
  const glb = JSON.parse(
    bytes.subarray(20, 20 + jsonLength).toString("utf8"),
  ) as GlbDescription;
  const leaf = glb.materials.find((material) => material.name === "leaf")!;
  expect(leaf).toBeDefined();
  const texture =
    glb.textures[leaf.pbrMetallicRoughness.baseColorTexture.index];
  const image = glb.images[texture.source];
  expect(image.mimeType).toBe("image/png");
  const view = glb.bufferViews[image.bufferView];
  const start = 28 + jsonLength + (view.byteOffset ?? 0);
  expect(start + view.byteLength).toBeLessThanOrEqual(bytes.length);
  const decoded = PNG.sync.read(bytes.subarray(start, start + view.byteLength));
  const data = new Uint8Array(decoded.data);
  const map = new THREE.DataTexture(data, decoded.width, decoded.height);
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  const source = new THREE.MeshStandardMaterial({
    map,
    roughness: leaf.pbrMetallicRoughness.roughnessFactor,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  source.color.fromArray(leaf.pbrMetallicRoughness.baseColorFactor);
  source.name = leaf.name;
  return { source, map, data };
}

function outputNodes(material: THREE.MeshStandardNodeMaterial): Set<Node> {
  // Compact trees now feed tinted albedo into native PBR before output, rather
  // than rebuilding it in outputNode. Inspect that actual graph stage.
  let node = material.colorNode ?? material.outputNode!;
  while (Reflect.get(node, "isVarNode")) node = Reflect.get(node, "node");
  const shader: object = Reflect.get(node, "shaderNode");
  const callback: unknown = Reflect.get(shader, "jsFunc");
  if (typeof callback !== "function") throw new Error("Expected actual TSL Fn");
  // Invoke the real zero-input graph constructor, never a mock shader builder.
  const root: unknown = callback();
  if (!(root instanceof THREE.Node)) throw new Error("Expected real TSL node");
  const nodes = new Set<Node>();
  const visit = (current: Node) => {
    if (nodes.has(current)) return;
    if (nodes.size > 4096) throw new Error("Tree graph inspection bound");
    nodes.add(current);
    for (const child of current.getChildren()) visit(child);
  };
  visit(root);
  return nodes;
}

function constantVector(node: Node): number[] | null {
  const value: unknown = Reflect.get(node, "value");
  if (value instanceof THREE.Vector3) return value.toArray();
  if (node.type !== "JoinNode") return null;
  const children: Node[] = Reflect.get(node, "nodes");
  const values: unknown[] = children.map((child) =>
    Reflect.get(child, "value"),
  );
  return values.every((v): v is number => typeof v === "number")
    ? values
    : null;
}

describe("compact authored tree leaf palette", () => {
  for (const [species, sourceRgb, targetHex] of [
    ["maple", [183, 87, 87], 0x96534c],
    ["magic", [26, 124, 141], 0x4f7e77],
  ] as const) {
    it(`uses the real ${species} leaf texture to reach its restrained linear-RGB target without modifying map/alpha/AO`, () => {
      const { source, map, data } = actualLeafSource(species);
      const before = data.slice();
      const material = createTreeDissolveMaterial(source, {
        batched: true,
        treePalette: {
          terrainProfile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          species,
        },
      });
      try {
        let visible = 0;
        let unexpectedRgbComponents = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          visible++;
          for (let channel = 0; channel < 3; channel++)
            if (data[i + channel] !== sourceRgb[channel])
              unexpectedRgbComponents++;
        }
        expect(visible).toBeGreaterThan(50_000);
        expect(unexpectedRgbComponents).toBe(0);
        const expected = new THREE.Color(targetHex);
        const sampledAlbedo = new THREE.Color()
          .setRGB(
            sourceRgb[0] / 255,
            sourceRgb[1] / 255,
            sourceRgb[2] / 255,
            THREE.SRGBColorSpace,
          )
          .multiply(material.color);
        for (const channel of ["r", "g", "b"] as const)
          expect(sampledAlbedo[channel]).toBeCloseTo(expected[channel], 12);
        expect(source.color.getHex()).toBe(0xffffff);
        expect(material.map).toBe(map);
        expect(data).toEqual(before);
        // COLOR_0 remains available as wind/AO masks, not a PBR RGB multiplier.
        expect(material.vertexColors).toBe(false);
        expect(material.alphaTest).toBe(0.5);
        expect(material.opacityNode).toBeTruthy();
        expect(material.positionNode).toBeTruthy();
        expect(material.roughness).toBe(source.roughness);
        const nodes = outputNodes(material);
        // The output graph captured the tint during construction, not afterwards.
        expect(
          [...nodes].some((node) => {
            const vector = constantVector(node);
            return (
              vector?.length === 3 &&
              vector.every((value, i) => value === material.color.toArray()[i])
            );
          }),
        ).toBe(true);
        expect(
          [...nodes].some(
            (node) =>
              Reflect.get(node, "isTextureNode") &&
              Reflect.get(node, "value") === map,
          ),
        ).toBe(true);
        expect(
          [...nodes].some(
            (node) =>
              node.type === "AttributeNode" &&
              Reflect.get(node, "_attributeName") === "color",
          ),
        ).toBe(true);
      } finally {
        material.dispose();
        source.dispose();
        map.dispose();
      }
    });
  }

  it("does not tint bark/bark2, unrecognized material names, other species or other profiles", () => {
    const source = new THREE.MeshStandardMaterial({ color: 0x8a7254 });
    try {
      for (const [name, species, terrainProfile] of [
        ["bark", "maple", SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE],
        ["bark2", "magic", SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE],
        ["Leaves", "magic", SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE],
        ["leaf", "oak", SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE],
        ["leaf", "maple", COMPACT_WORLD_TERRAIN_PROFILE],
        ["leaf", "magic", LEGACY_TERRAIN_PROFILE_FIXTURE],
      ] as const) {
        source.name = name;
        const material = createTreeDissolveMaterial(source, {
          treePalette: { terrainProfile, species },
        });
        expect(material.color).toEqual(source.color);
        material.dispose();
      }
    } finally {
      source.dispose();
    }
  });

  it("uses the owning real terrain profile without changing shared source materials or default callers", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const source = new THREE.MeshStandardMaterial();
    source.name = "leaf";
    try {
      await terrain.init();
      const profile = world
        .getSystem<TerrainSystem>("terrain")!
        .getWorldTerrainProfile();
      const compact = createTreeDissolveMaterial(source, {
        treePalette: { terrainProfile: profile, species: "maple" },
      });
      const ordinary = createTreeDissolveMaterial(source);
      try {
        expect(compact.color).not.toEqual(ordinary.color);
        expect(ordinary.color).toEqual(source.color);
        expect(source.color.getHex()).toBe(0xffffff);
        expect(compact.treeUniforms.windStrength.value).toBe(
          ordinary.treeUniforms.windStrength.value,
        );
        expect(compact.treeUniforms.illumination.blend.value).toBe(
          ordinary.treeUniforms.illumination.blend.value,
        );
      } finally {
        compact.dispose();
        ordinary.dispose();
      }
    } finally {
      source.dispose();
      world.destroy();
    }
  });
});
