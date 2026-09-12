import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import THREE, {
  cameraPosition,
  positionWorld,
} from "../../../extras/three/three";
import type { Node } from "three/webgpu";
import { TerrainSystem } from "./TerrainSystem";
import { TerrainQuadTree, type TerrainQuadNode } from "./TerrainQuadTree";
import { WaterSystem } from "./WaterSystem";
import { WaterVisualManager } from "./WaterVisualManager";
import { Wind } from "./Wind";
import { FOG_FAR } from "./FogConfig";

type Continuation = {
  bands: number;
  edgeCount: number;
  baseVertexCount: number;
  baseIndexCount: number;
  addedVertices: number;
  addedIndices: number;
  rootCenterX: number;
  rootCenterZ: number;
  rootHalfSize: number;
  outerHalfSize: number;
};

/** Resolve this actual r186 zero-argument TSL factory without a renderer. */
function opacityGraph(node: Node): Node {
  // r186 Fn.call returns a VarNode intent around its ShaderCallNodeInternal.
  if (node.type === "VarNode") {
    const child: unknown = Reflect.get(node, "node");
    if (!(child instanceof THREE.Node))
      throw new Error("Missing TSL intent node");
    node = child;
  }
  const shader = Reflect.get(node, "shaderNode") as unknown;
  if (shader === null || typeof shader !== "object")
    throw new Error("Missing actual TSL shader factory");
  const factory = Reflect.get(shader, "jsFunc") as unknown;
  if (typeof factory !== "function" || factory.length !== 0)
    throw new Error("Unexpected opacity factory inputs");
  const result: unknown = Reflect.apply(factory, undefined, []);
  if (!(result instanceof THREE.Node))
    throw new Error("Opacity factory did not return a Node");
  return result;
}

/**
 * Evaluate only operations in the actual opacity graph. Shader inputs are
 * explicit arithmetic samples, not replacements for a camera or GPU renderer.
 * Unknown nodes throw rather than pretending to execute unsupported shader work.
 */
function opacityValue(
  root: Node,
  shoreDistance: number,
  cosView: number,
): number {
  const read = (node: Node): number[] => {
    if (node === cameraPosition)
      return [Math.sqrt(1 - cosView * cosView), cosView, 0];
    if (node === positionWorld) return [0, 0, 0];
    const property = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string): number[] => {
      const value = property(key);
      if (!(value instanceof THREE.Node))
        throw new Error(`Missing ${node.type}.${key}`);
      return read(value);
    };
    if (
      node.type === "AttributeNode" &&
      property("_attributeName") === "shoreDistance"
    )
      return [shoreDistance];
    const value = property("value");
    if (typeof value === "number") return [value];
    if (value instanceof THREE.Vector3) return value.toArray();
    if (node.type === "ConvertNode" || node.type === "VarNode")
      return child("node");
    if (node.type === "JoinNode")
      return (property("nodes") as Node[]).flatMap(read);
    const pair = (fn: (a: number, b: number) => number) => {
      const a = child("aNode"),
        b = child("bNode");
      return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
        fn(a[a.length === 1 ? 0 : i], b[b.length === 1 ? 0 : i]),
      );
    };
    const triple = (fn: (a: number, b: number, c: number) => number) => {
      const a = child("aNode"),
        b = child("bNode"),
        c = child("cNode");
      return Array.from(
        { length: Math.max(a.length, b.length, c.length) },
        (_, i) =>
          fn(
            a[a.length === 1 ? 0 : i],
            b[b.length === 1 ? 0 : i],
            c[c.length === 1 ? 0 : i],
          ),
      );
    };
    switch (property("op")) {
      case "+":
        return pair((a, b) => a + b);
      case "-":
        return pair((a, b) => a - b);
      case "*":
        return pair((a, b) => a * b);
    }
    switch (property("method")) {
      case "max":
        return pair(Math.max);
      case "pow":
        return pair(Math.pow);
      case "dot":
        return [pair((a, b) => a * b).reduce((sum, v) => sum + v, 0)];
      case "normalize": {
        const a = child("aNode"),
          length = Math.hypot(...a);
        return a.map((v) => v / length);
      }
      case "mix":
        return triple((a, b, t) => a * (1 - t) + b * t);
      case "smoothstep":
        return triple((a, b, v) => {
          const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
          return t * t * (3 - 2 * t);
        });
    }
    throw new Error(`Unsupported opacity node ${node.type}`);
  };
  const values = read(root);
  if (values.length !== 1 || !Number.isFinite(values[0]))
    throw new Error("Invalid scalar opacity result");
  return values[0];
}

describe("compact ocean continuation (actual CPU classes; no rendered-water claim)", () => {
  let world: World;
  let terrain: TerrainSystem;
  let water: WaterSystem;
  let wind: Wind;
  const owners: { manager: WaterVisualManager; tree: TerrainQuadTree }[] = [];

  beforeAll(async () => {
    await DataManager.getInstance().initialize();
    world = new World();
    wind = world.register("wind", Wind) as Wind;
    terrain = new TerrainSystem(world);
    await terrain.init();
    terrain.loadWaterBodiesFromManifest();
    terrain.loadFlatZonesFromManifest();
    water = new WaterSystem(world);
    // Real TSL construction and the production CPU procedural-texture fallback.
    // No fake renderer, GPU, World, material or quad-tree callback is installed.
    await water.init();
  });

  afterEach(() => {
    for (const { tree, manager } of owners.splice(0)) {
      tree.dispose();
      manager.destroy();
    }
    expect(water.waterMeshCount).toBe(0);
    wind.setStrength(1);
    water.update(0);
  });

  afterAll(() => {
    water.destroy();
    terrain.destroy();
  });

  function createOwner(radius = 0, initializedWater = water) {
    const container = new THREE.Group();
    const profile = terrain.getWorldTerrainProfile();
    const manager = new WaterVisualManager(
      container,
      initializedWater,
      (x, z) => terrain.getHeightAtComputed(x, z),
      (x, z) =>
        (
          terrain as unknown as { getIslandMask(x: number, z: number): number }
        ).getIslandMask(x, z),
      profile.water.threshold,
      [],
      profile,
    );
    const tree = new TerrainQuadTree({
      minSize: 100,
      maxDepth: 4,
      splitRatio: 0,
      rootChunkRadius: radius,
    });
    // Establish actual roots, then attach the real owner. Tests explicitly
    // request geometry through the production tree's event method below.
    tree.update(0, 0);
    tree.setListener(manager);
    owners.push({ manager, tree });
    const root = tree
      .getFinalNodes()
      .find((node) => node.centerX === 0 && node.centerZ === 0)!;
    return { tree, root, manager, container };
  }

  function leafAt(
    root: TerrainQuadNode,
    x: number,
    z: number,
    depth: number,
  ): TerrainQuadNode {
    let node = root;
    while (node.depth < depth) {
      if (!node.splitted) node.split();
      node = Array.from(node.children.values()).find(
        (child) =>
          x >= child.boundingBox.xMin &&
          x < child.boundingBox.xMax &&
          z >= child.boundingBox.zMin &&
          z < child.boundingBox.zMax,
      )!;
    }
    return node;
  }

  function publish(
    owner: ReturnType<typeof createOwner>,
    node: TerrainQuadNode,
  ) {
    owner.tree.requestTerrainGeneration(node);
    return owner.container.children.find((child) =>
      child.name.includes(`_wq_${node.id}_`),
    ) as THREE.Mesh<THREE.PlaneGeometry>;
  }

  function worldVertex(mesh: THREE.Mesh, index: number) {
    const position = mesh.geometry.getAttribute("position");
    // GPU attributes and model translation use Float32 arithmetic. Copying an
    // edge means the same shader inputs, including all three wave components.
    return [
      Math.fround(
        Math.fround(position.getX(index)) + Math.fround(mesh.position.x),
      ),
      Math.fround(
        Math.fround(position.getY(index)) + Math.fround(mesh.position.y),
      ),
      Math.fround(
        Math.fround(position.getZ(index)) + Math.fround(mesh.position.z),
      ),
    ];
  }

  it("uses the actual ocean TSL graph to reach exact offshore alpha 1 at every sampled angle", () => {
    const material = water.getMaterial("ocean")!;
    const graph = opacityGraph(material.opacityNode!);
    const smooth = (lo: number, hi: number, value: number) => {
      const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
      return t * t * (3 - 2 * t);
    };
    for (const angle of [-1, 0, 0.01, 0.25, 0.5, 0.75, 1]) {
      let previous = 0;
      for (const distance of [0, 0.2, 0.4, 1, 4, 7.999, 8, 50, 500]) {
        const actual = opacityValue(graph, distance, angle);
        const depthFade = smooth(0.4, 8, distance);
        const old =
          smooth(0, 0.4, distance) *
          (0.3 + 0.55 * depthFade) *
          (0.9 + 0.1 * (1 - Math.max(0, angle)) ** 3);
        expect(actual).toBeCloseTo(old * (1 - depthFade) + depthFade, 14);
        if (distance <= 0.4) expect(actual).toBeCloseTo(old, 14);
        if (distance >= 8) expect(actual).toBe(1);
        expect(actual).toBeGreaterThanOrEqual(previous);
        expect(actual).toBeLessThanOrEqual(1);
        previous = actual;
      }
      expect(opacityValue(graph, 8 - 1e-5, angle)).toBeCloseTo(1, 10);
    }
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(true);
    expect(material.fog).toBe(false);
  });

  it("uses the same opaque shoreDistance 50 graph on original ocean and collar vertices, not the lake graph", () => {
    const owner = createOwner();
    const interior = publish(owner, leafAt(owner.root, -100, -100, 3));
    const boundary = publish(owner, leafAt(owner.root, 700, 700, 3));
    const material = water.getMaterial("ocean")!;
    const lake = water.getMaterial("lake")!;
    const lakeOpacity = lake.opacityNode;
    const graph = opacityGraph(material.opacityNode!);
    for (const mesh of [interior, boundary]) {
      expect(mesh.material).toBe(material);
      const attribute = mesh.geometry.getAttribute("shoreDistance");
      for (let i = 0; i < attribute.count; i++)
        expect(attribute.getX(i)).toBe(50);
      for (const angle of [0, 0.5, 1])
        expect(opacityValue(graph, attribute.getX(0), angle)).toBe(1);
    }
    expect(interior.geometry.userData.oceanContinuation).toBeUndefined();
    expect(boundary.geometry.userData.oceanContinuation).toBeDefined();
    expect(lake.opacityNode).toBe(lakeOpacity);
    expect(lake.opacityNode).not.toBe(material.opacityNode);
    expect(lake.transparent).toBe(true);
    // Numerical graph/input proof only; pixel compositing and the separate
    // far sky/fog-camera disagreement still require the next native capture.
  });

  it("preserves every original attribute and index while extending only exposed root sides", () => {
    const owner = createOwner();
    const leaf = leafAt(owner.root, 700, 700, 3);
    const mesh = publish(owner, leaf);
    const geometry = mesh.geometry;
    const receipt = geometry.userData.oceanContinuation as Continuation;
    const original = new THREE.PlaneGeometry(200, 200, 12, 12);
    original.rotateX(-Math.PI / 2);
    original.setAttribute(
      "normal",
      new THREE.BufferAttribute(
        Float32Array.from({ length: 169 * 3 }, (_, i) => (i % 3 === 1 ? 1 : 0)),
        3,
      ),
    );
    original.setAttribute(
      "shoreDistance",
      new THREE.BufferAttribute(new Float32Array(169).fill(50), 1),
    );
    try {
      for (const name of ["position", "normal", "uv", "shoreDistance"]) {
        const expected = original.getAttribute(name).array;
        expect(
          geometry.getAttribute(name).array.slice(0, expected.length),
        ).toEqual(expected);
      }
      expect(
        geometry.getIndex()!.array.slice(0, original.getIndex()!.count),
      ).toEqual(original.getIndex()!.array);
      expect(receipt).toMatchObject({
        bands: 8,
        edgeCount: 2,
        baseVertexCount: 169,
        baseIndexCount: 864,
        addedVertices: 208,
        addedIndices: 1152,
        outerHalfSize: 1800,
      });
      expect(mesh.material).toBe(water.getMaterial("ocean"));
      expect(mesh.position.toArray()).toEqual([700, 16, 700]);
      expect(mesh.frustumCulled).toBe(true);
      expect(owner.container.children).toHaveLength(1);
      expect(water.waterMeshCount).toBe(1);
      expect(publish(owner, leaf)).toBe(mesh);

      const positions = geometry.getAttribute("position");
      const index = geometry.getIndex()!;
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        c = new THREE.Vector3();
      for (let i = receipt.baseIndexCount; i < index.count; i += 3) {
        a.fromBufferAttribute(positions, index.getX(i));
        b.fromBufferAttribute(positions, index.getX(i + 1));
        c.fromBufferAttribute(positions, index.getX(i + 2));
        const centerX = (a.x + b.x + c.x) / 3 + mesh.position.x;
        const centerZ = (a.z + b.z + c.z) / 3 + mesh.position.z;
        expect(Math.max(Math.abs(centerX), Math.abs(centerZ))).toBeGreaterThan(
          800,
        );
        expect(b.sub(a).cross(c.sub(a)).y).toBeGreaterThan(0);
      }
    } finally {
      original.dispose();
    }
  });

  it("joins mixed 400/8 and 200/12 leaf pitches with identical radial endpoint chains", () => {
    const owner = createOwner();
    const coarse = publish(owner, leafAt(owner.root, 600, 600, 2));
    const fine = publish(owner, leafAt(owner.root, 700, 300, 3));
    const chains = [coarse, fine].map((mesh) => {
      const receipt = mesh.geometry.userData.oceanContinuation as Continuation;
      const rows = new Map<string, number[]>();
      for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
        const p = worldVertex(mesh, i);
        if (p[0] >= 800 && p[0] === p[2] * 2) rows.set(p.join(","), p);
      }
      expect(receipt.bands).toBe(8);
      return Array.from(rows.values()).sort((a, b) => a[0] - b[0]);
    });
    expect(chains[0]).toEqual(chains[1]);
    expect(chains[0]).toHaveLength(9);
    expect(chains[0][0]).toEqual([800, 16, 400]);
    expect(chains[0][8]).toEqual([1800, 16, 900]);

    // Both sides of a root corner meet on the same nine-point diagonal.
    const corner = coarse.geometry.userData.oceanContinuation as Continuation;
    const diagonal = new Map<string, number>();
    for (
      let i = corner.baseVertexCount;
      i < coarse.geometry.getAttribute("position").count;
      i++
    ) {
      const p = worldVertex(coarse, i);
      if (p[0] === p[2])
        diagonal.set(p.join(","), (diagonal.get(p.join(",")) ?? 0) + 1);
    }
    expect(diagonal.size).toBe(8);
    expect(Array.from(diagonal.values())).toEqual(new Array(8).fill(2));
  });

  it("retains ordinary exploration geometry and interior compact leaves", () => {
    const exploration = createOwner(1);
    const mesh = publish(exploration, leafAt(exploration.root, 700, 700, 3));
    expect(mesh.geometry.userData.oceanContinuation).toBeUndefined();
    expect(mesh.geometry.getAttribute("position").count).toBe(169);
    expect(mesh.geometry.getIndex()!.count).toBe(864);
    const compact = createOwner();
    const interior = publish(compact, leafAt(compact.root, -100, -100, 3));
    expect(interior.geometry.userData.oceanContinuation).toBeUndefined();
    expect(interior.geometry.getAttribute("position").count).toBe(169);
  });

  it("bounds the complete finest settled perimeter without adding meshes", () => {
    const owner = createOwner();
    let addedIndices = 0,
      addedVertices = 0,
      pieces = 0,
      area = 0;
    for (let ix = 0; ix < 16; ix++)
      for (let iz = 0; iz < 16; iz++) {
        if (ix !== 0 && ix !== 15 && iz !== 0 && iz !== 15) continue;
        const mesh = publish(
          owner,
          leafAt(owner.root, -750 + ix * 100, -750 + iz * 100, 4),
        );
        const receipt = mesh.geometry.userData
          .oceanContinuation as Continuation;
        addedIndices += receipt.addedIndices;
        addedVertices += receipt.addedVertices;
        pieces += receipt.edgeCount;
        expect(mesh.geometry.getIndex()!.array).toBeInstanceOf(Uint16Array);
        const positions = mesh.geometry.getAttribute("position");
        const index = mesh.geometry.getIndex()!;
        for (let i = receipt.baseIndexCount; i < index.count; i += 3) {
          const a = index.getX(i),
            b = index.getX(i + 1),
            c = index.getX(i + 2);
          area +=
            ((positions.getZ(b) - positions.getZ(a)) *
              (positions.getX(c) - positions.getX(a)) -
              (positions.getX(b) - positions.getX(a)) *
                (positions.getZ(c) - positions.getZ(a))) /
            2;
        }
        for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
          const p = worldVertex(mesh, i);
          expect(p.every(Number.isFinite)).toBe(true);
          expect(Math.max(Math.abs(p[0]), Math.abs(p[2]))).toBeLessThanOrEqual(
            1800,
          );
        }
      }
    expect(owner.container.children).toHaveLength(60);
    expect(water.waterMeshCount).toBe(60);
    expect(pieces).toBe(64);
    expect(addedIndices / 3).toBe(16384);
    expect(addedVertices * 36 + addedIndices * 2).toBe(411648);
    expect(area).toBe(3600 ** 2 - 1600 ** 2);
  });

  it("refreshes conservative XYZ bounds from actual uncapped wind without replacing bound objects", () => {
    const owner = createOwner();
    const mesh = publish(owner, leafAt(owner.root, 700, 700, 3));
    const box = mesh.geometry.boundingBox!,
      sphere = mesh.geometry.boundingSphere!;
    const base = new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.getAttribute("position") as THREE.BufferAttribute,
    );
    const position = mesh.geometry.getAttribute("position");
    const positionArray = position.array;
    const material = mesh.material;
    const waves = [
      [0.07, 20, 0.3, 0.7, 0.71],
      [0.05, 14, 0.25, -0.5, 0.87],
      [0.035, 8, 0.22, 0.9, -0.44],
      [0.025, 5, 0.2, 0.26, 0.97],
      [0.015, 2.5, 0.15, -0.8, 0.6],
    ];
    for (const strength of [0, 1, 25, 1000000, 1]) {
      wind.setStrength(strength);
      water.update(0.25);
      const uniforms = water.waterUniformsByType.ocean!;
      const amplitude = 0.2535 * Math.abs(uniforms.windStrength.value);
      expect(box.max.y).toBeGreaterThanOrEqual(base.max.y + amplitude);
      expect(box.min.y).toBeLessThanOrEqual(base.min.y - amplitude);
      expect(box.max.x - base.max.x).toBeGreaterThan(0.040274);
      expect(box.max.z - base.max.z).toBeGreaterThan(0.0459849);
      expect(mesh.geometry.boundingBox).toBe(box);
      expect(mesh.geometry.boundingSphere).toBe(sphere);
      expect(position.array).toBe(positionArray);
      expect(mesh.material).toBe(material);
      expect(mesh.frustumCulled).toBe(true);
      const sample = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        sample.fromBufferAttribute(position, i);
        let dx = 0,
          dy = 0,
          dz = 0;
        for (const [a, wavelength, q, dirX, dirZ] of waves) {
          const frequency = (2 * Math.PI) / wavelength;
          const phase =
            frequency *
              ((sample.x + mesh.position.x) * dirX +
                (sample.z + mesh.position.z) * dirZ) +
            Math.sqrt(9.81 * frequency) * uniforms.time.value;
          dx += 1.3 * q * a * dirX * Math.cos(phase);
          dy += 1.3 * a * uniforms.windStrength.value * Math.sin(phase);
          dz += 1.3 * q * a * dirZ * Math.cos(phase);
        }
        sample.add(new THREE.Vector3(dx, dy, dz));
        expect(box.containsPoint(sample)).toBe(true);
        expect(sphere.containsPoint(sample)).toBe(true);
      }
    }
    const saved = box.clone();
    wind.setStrength(Infinity);
    expect(() => water.update(0)).toThrow(
      "non-finite or non-Float32 ocean wind",
    );
    expect(box.equals(saved)).toBe(true);
    wind.setStrength(1e50);
    expect(() => water.update(0)).toThrow(
      "non-finite or non-Float32 ocean wind",
    );
    expect(box.equals(saved)).toBe(true);
    wind.setStrength(NaN);
    expect(() => water.update(0)).toThrow(
      "non-finite or non-Float32 ocean wind",
    );
    expect(box.equals(saved)).toBe(true);
    wind.setStrength(1);
    water.update(0);
  });

  it("rejects changed bound ownership without updating a replacement geometry", () => {
    const owner = createOwner();
    const mesh = publish(owner, leafAt(owner.root, 700, 700, 3));
    const owned = mesh.geometry;
    const borrowed = new THREE.PlaneGeometry(2, 2);
    borrowed.computeBoundingBox();
    const before = borrowed.boundingBox!.clone();
    mesh.geometry = borrowed;
    try {
      expect(() => water.update(0.1)).toThrow("changed ownership");
      expect(borrowed.boundingBox!.equals(before)).toBe(true);
    } finally {
      mesh.geometry = owned;
      borrowed.dispose();
    }
    const sphere = owned.boundingSphere;
    owned.boundingSphere = null;
    expect(() => water.update(0)).toThrow("changed ownership");
    owned.boundingSphere = sphere;
    water.update(0);
  });

  it("rejects invalid initial wind before publishing a mesh or retaining a bounds record", () => {
    const owner = createOwner();
    const uniforms = water.waterUniformsByType.ocean!;
    uniforms.windStrength.value = Infinity;
    expect(() => publish(owner, owner.root)).toThrow(
      "non-finite or non-Float32 ocean wind",
    );
    expect(owner.container.children).toHaveLength(0);
    expect(water.waterMeshCount).toBe(0);
    const records = (
      water as unknown as { oceanDisplacementBounds: readonly unknown[] }
    ).oceanDisplacementBounds;
    expect(records).toHaveLength(0);
    water.update(0);
    publish(owner, owner.root);
    expect(records).toHaveLength(1);
    owner.tree.requestTerrainDestruction(owner.root);
    expect(records).toHaveLength(0);
    expect(water.waterMeshCount).toBe(0);
  });

  it("ties collar retirement, shared material survival and recentering to actual node ownership", () => {
    const owner = createOwner();
    const rootMesh = publish(owner, owner.root);
    let rootDisposals = 0,
      materialDisposals = 0;
    rootMesh.geometry.addEventListener("dispose", () => rootDisposals++);
    const material = water.getMaterial("ocean")!;
    const onMaterialDispose = () => materialDisposals++;
    material.addEventListener("dispose", onMaterialDispose);
    try {
      owner.root.split();
      const children = Array.from(owner.root.children.values());
      for (const child of children) publish(owner, child);
      // Existing transition overlap is deliberate; no independent ring survives.
      expect(owner.container.children).toHaveLength(5);
      for (const child of children) child.setReady();
      expect(rootDisposals).toBe(1);
      expect(owner.container.children).toHaveLength(4);
      owner.root.unsplit();
      const replacement = publish(owner, owner.root);
      expect(replacement).not.toBe(rootMesh);
      owner.root.setReady();
      expect(owner.container.children).toHaveLength(1);
      expect(materialDisposals).toBe(0);
      const removedBox = rootMesh.geometry.boundingBox!.clone();
      wind.setStrength(20);
      water.update(0.1);
      expect(rootMesh.geometry.boundingBox!.equals(removedBox)).toBe(true);

      owner.tree.update(1601, 0);
      const newRoot = owner.tree
        .getFinalNodes()
        .find((node) => node.parent === null)!;
      const recentered = publish(owner, newRoot);
      expect(owner.container.children).toHaveLength(1);
      expect(recentered.geometry.userData.oceanContinuation).toMatchObject({
        rootCenterX: 1600,
        rootCenterZ: 0,
      });
      expect(recentered.position.x).toBe(1600);
      owner.tree.update(-1601, -1601);
      const negativeRoot = owner.tree
        .getFinalNodes()
        .find((node) => node.parent === null)!;
      const negative = publish(owner, negativeRoot);
      expect(owner.container.children).toHaveLength(1);
      expect(negative.geometry.userData.oceanContinuation).toMatchObject({
        rootCenterX: -1600,
        rootCenterZ: -1600,
      });
      expect(negative.position.toArray()).toEqual([-1600, 16, -1600]);
      owner.manager.destroy();
      owner.manager.destroy();
      owner.tree.requestTerrainGeneration(negativeRoot);
      expect(owner.container.children).toHaveLength(0);
      expect(water.waterMeshCount).toBe(0);
      expect(materialDisposals).toBe(0);
    } finally {
      material.removeEventListener("dispose", onMaterialDispose);
    }
  });

  it("publishes nothing before actual water initialization, then admits the same node", async () => {
    const coldWater = new WaterSystem(world);
    const owner = createOwner(0, coldWater);
    try {
      owner.tree.requestTerrainGeneration(owner.root);
      expect(owner.container.children).toHaveLength(0);
      expect(coldWater.waterMeshCount).toBe(0);
      await coldWater.init();
      expect(publish(owner, owner.root)).toBeInstanceOf(THREE.Mesh);
      expect(coldWater.waterMeshCount).toBe(1);
      owner.manager.destroy();
      expect(coldWater.waterMeshCount).toBe(0);
    } finally {
      coldWater.destroy();
    }
  });

  it("retires exactly once if a real synchronous scene event destroys the manager during publication", () => {
    const owner = createOwner();
    let disposals = 0;
    owner.container.addEventListener("childadded", ({ child }) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry.addEventListener("dispose", () => disposals++);
      owner.manager.destroy();
    });
    owner.tree.requestTerrainGeneration(owner.root);
    expect(disposals).toBe(1);
    expect(owner.container.children).toHaveLength(0);
    expect(water.waterMeshCount).toBe(0);
    owner.manager.destroy();
    owner.tree.requestTerrainGeneration(owner.root);
    expect(disposals).toBe(1);
  });

  it("retires ownership before removal/disposal callbacks and preserves a same-key replacement", () => {
    const owner = createOwner();
    const original = publish(owner, owner.root);
    let originalDisposals = 0;
    original.geometry.addEventListener("dispose", () => {
      originalDisposals++;
      owner.tree.requestTerrainDestruction(owner.root);
    });
    owner.container.addEventListener("childremoved", ({ child }) => {
      if (child !== original) return;
      owner.tree.requestTerrainDestruction(owner.root);
      publish(owner, owner.root);
    });
    owner.tree.requestTerrainDestruction(owner.root);
    expect(originalDisposals).toBe(1);
    expect(owner.container.children).toHaveLength(1);
    const replacement = owner.container.children[0] as THREE.Mesh;
    expect(replacement).not.toBe(original);
    expect(publish(owner, owner.root)).toBe(replacement);
    expect(water.waterMeshCount).toBe(1);
    let replacementDisposals = 0;
    replacement.geometry.addEventListener("dispose", () => {
      replacementDisposals++;
      owner.tree.requestTerrainDestruction(owner.root);
    });
    owner.manager.destroy();
    expect(replacementDisposals).toBe(1);
    expect(originalDisposals).toBe(1);
    expect(water.waterMeshCount).toBe(0);
    expect(owner.container.children).toHaveLength(0);
  });

  it("places the recorded bay boundary beyond complete fog and inside the unchanged actual camera far plane", () => {
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 10000);
    camera.position.set(407, 48, 455);
    camera.quaternion.set(
      0.06510225149475078,
      0.9065055875005507,
      0.15190525348775183,
      -0.38850239464309316,
    );
    camera.updateMatrixWorld(true);
    const oldCorner = new THREE.Vector3(800, 16, 800).project(camera);
    expect((oldCorner.x + 1) * 640).toBeCloseTo(608.9674023797543, 6);
    expect((1 - oldCorner.y) * 360).toBeCloseTo(155.01174440287687, 6);
    const minimumOuterDistance = Math.min(
      1800 - Math.abs(camera.position.x),
      1800 - Math.abs(camera.position.z),
    );
    expect(minimumOuterDistance).toBe(1345);
    expect(minimumOuterDistance).toBeGreaterThan(FOG_FAR);
    for (const x of [-1800, 1800])
      for (const z of [-1800, 1800]) {
        expect(
          camera.position.distanceTo(new THREE.Vector3(x, 16, z)),
        ).toBeLessThan(camera.far);
      }
    // Coverage of this recorded camera is not a pixel, motion or FPS approval.
  });
});
