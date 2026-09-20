import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import THREE, {
  positionLocal,
  positionWorld,
} from "../../../extras/three/three";
import type { Node } from "three/webgpu";
import { TerrainSystem } from "./TerrainSystem";
import { TerrainVisualManager } from "./TerrainVisualManager";
import { createCompactPreparationDetailRegions } from "./CompactIslandDetail";
import {
  CompositeQuadTreeListener,
  type TerrainQuadNode,
  type TerrainQuadTree,
} from "./TerrainQuadTree";
import {
  WaterVisualManager,
  COMPACT_CONFORMING_WATER,
} from "./WaterVisualManager";
import { WaterSystem } from "./WaterSystem";
import type {
  ConformingWaterGridInput,
  WaterGridSide,
} from "./ConformingWaterGrid";

type Metadata = Pick<ConformingWaterGridInput, "bounds" | "spacing"> & {
  edges: Record<WaterGridSide, number[]>;
};
type Owner = {
  tree: TerrainQuadTree;
  root: TerrainQuadNode;
  visual: TerrainVisualManager;
  manager: WaterVisualManager;
  container: THREE.Group;
  material: THREE.MeshBasicMaterial;
  terrainContainer: THREE.Group;
};

const expandedFactories = new WeakMap<Node, Node>();
/** Actual arithmetic graph only; not a renderer or GPU result. */
function displaced(root: unknown, local: number[], world: number[]): number[] {
  if (!(root instanceof THREE.Node))
    throw new Error("Missing actual position Node");
  const read = (node: Node): number[] => {
    if (node === positionLocal) return local;
    if (node === positionWorld) return world;
    const get = (name: string): unknown => Reflect.get(node, name);
    const child = (name: string) => {
      const value = get(name);
      if (!(value instanceof THREE.Node))
        throw new Error(`Missing ${node.type}.${name}`);
      return read(value);
    };
    if (
      node.type === "AttributeNode" &&
      get("_attributeName") === "shoreDistance"
    )
      return [50];
    if (node.type === "VarNode" || node.type === "ConvertNode")
      return child("node");
    const shader: unknown = get("shaderNode");
    if (shader && typeof shader === "object") {
      const existing = expandedFactories.get(node);
      if (existing) return read(existing);
      const factory: unknown = Reflect.get(shader, "jsFunc");
      if (typeof factory !== "function" || factory.length !== 0)
        throw new Error("Unknown water factory");
      const result: unknown = Reflect.apply(factory, undefined, []);
      if (!(result instanceof THREE.Node))
        throw new Error("Water factory must return actual Node");
      expandedFactories.set(node, result);
      return read(result);
    }
    const value = get("value");
    if (typeof value === "number") return [value];
    if (node.type === "SplitNode") {
      const source = child("node"),
        components = get("components");
      if (typeof components !== "string") throw new Error("Invalid split");
      return [...components].map((c) => source["xyzw".indexOf(c)]);
    }
    if (node.type === "JoinNode") return (get("nodes") as Node[]).flatMap(read);
    const pair = (fn: (a: number, b: number) => number) => {
      const a = child("aNode"),
        b = child("bNode");
      return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
        fn(a[a.length === 1 ? 0 : i], b[b.length === 1 ? 0 : i]),
      );
    };
    if (get("op") === "+") return pair((a, b) => a + b);
    if (get("op") === "*") return pair((a, b) => a * b);
    if (get("method") === "sin") return child("aNode").map(Math.sin);
    if (get("method") === "cos") return child("aNode").map(Math.cos);
    if (get("method") === "smoothstep") {
      const a = child("aNode")[0],
        b = child("bNode")[0],
        x = child("cNode")[0];
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return [t * t * (3 - 2 * t)];
    }
    throw new Error(`Unsupported real wave node ${node.type}`);
  };
  const result = read(root);
  if (result.length !== 3 || !result.every(Number.isFinite))
    throw new Error("Invalid displaced vertex");
  return result;
}

describe("live conforming water ownership (real CPU classes, no native/performance approval)", () => {
  let terrain: TerrainSystem, water: WaterSystem;
  const owners: Owner[] = [];
  beforeAll(async () => {
    await DataManager.getInstance().initialize();
    const world = new World();
    terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    water = new WaterSystem(world);
    await water.init();
  });
  afterEach(() => {
    for (const owner of owners.splice(0)) {
      owner.manager.destroy();
      owner.visual.dispose();
      owner.material.dispose();
    }
    expect(water.waterMeshCount).toBe(0);
  });
  afterAll(() => {
    water.destroy();
    terrain.destroy();
  });

  function fixture(rootX = 0, pond = false): Owner {
    const setup = terrain["buildGrassWorkerSetup"]();
    const terrainContainer = new THREE.Group(),
      container = new THREE.Group(),
      material = new THREE.MeshBasicMaterial();
    const visual = new TerrainVisualManager(
      {
        minSize: 100,
        maxDepth: 4,
        rootChunkRadius: 0,
        resolution: 2,
        splitRatio: 0,
        // Keep the deliberately sparse ocean fixture, but bind the EXACT
        // production local-detail policy. An authored pond must not be squeezed
        // into one resolution2 parent: its retained cell cap intentionally
        // rejects that unsupported geometry instead of discarding bank detail.
        fineDetailRegions: createCompactPreparationDetailRegions(
          terrain.getWorldTerrainProfile(),
          DataManager.getInstance().getAllWorldAreas(),
          terrain["CONFIG"].QUADTREE_RESOLUTION,
        ),
      },
      terrain["buildChunkTerrainProvider"](),
      terrainContainer,
      material,
      setup.terrainConfig,
      setup.seed,
      setup.biomeCenters,
      setup.biomes,
    );
    const tree = visual.getQuadTree();
    const manager = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain["getHeightAtComputed"](x, z),
      (x, z) => terrain["getIslandMask"](x, z),
      terrain.getWorldTerrainProfile().water.threshold,
      pond ? terrain["waterBodyRegistry"].getAllBodies() : [],
      terrain.getWorldTerrainProfile(),
      visual,
    );
    const listener = new CompositeQuadTreeListener();
    listener.add(visual);
    listener.add(manager);
    tree.setListener(listener);
    tree.update(rootX, 0);
    let root = tree.getFinalNodes()[0];
    while (root.parent) root = root.parent;
    const result = {
      tree,
      root,
      visual,
      manager,
      container,
      material,
      terrainContainer,
    };
    owners.push(result);
    return result;
  }
  function publish(owner: ReturnType<typeof fixture>, node: TerrainQuadNode) {
    owner.tree.requestTerrainGeneration(node);
    owner.visual["generateChunkSync"](node);
    expect(owner.visual.hasInstalledChunk(node)).toBe(true);
  }
  function settle(owner: ReturnType<typeof fixture>) {
    for (
      let i = 0;
      i < 512 && !owner.manager.getConformingReadiness().ready;
      i++
    ) {
      owner.manager.update();
      expect(owner.manager.getConformingReadiness().error).toBeNull();
    }
    expect(owner.manager.getConformingReadiness().ready).toBe(true);
  }
  function meshes(owner: ReturnType<typeof fixture>) {
    return owner.container.children.filter(
      (v): v is THREE.Mesh =>
        v instanceof THREE.Mesh &&
        v.userData.waterType === "ocean" &&
        v.visible,
    );
  }
  function split(owner: ReturnType<typeof fixture>, node: TerrainQuadNode) {
    node.split();
    const children = [...node.children.values()];
    for (const child of children) publish(owner, child);
    return children;
  }
  function leaves(node: TerrainQuadNode): TerrainQuadNode[] {
    return node.children.size
      ? [...node.children.values()].flatMap(leaves)
      : [node];
  }

  /** Compare actual published chunks with ordinary auto-updating Three meshes.
   * These temporary parent transforms test matrix inheritance, not admission of
   * a transformed world-XZ water partition. Restore before any topology update. */
  function checkRigidMatrices(chunkMeshes: readonly THREE.Mesh[]) {
    expect(chunkMeshes.length).toBeGreaterThan(0);
    for (const mesh of chunkMeshes) {
      const parent = mesh.parent!;
      expect(parent).toBeInstanceOf(THREE.Group);
      const originalParent = parent.parent;
      const scene = new THREE.Scene(),
        first = new THREE.Group(),
        second = new THREE.Group(),
        referenceParent = new THREE.Group();
      referenceParent.position.copy(parent.position);
      referenceParent.quaternion.copy(parent.quaternion);
      referenceParent.scale.copy(parent.scale);
      const geometry = mesh.geometry,
        material = mesh.material,
        local = mesh.matrix.clone();
      const attributes = [
        ...Object.values(geometry.attributes),
        ...(geometry.index ? [geometry.index] : []),
      ];
      const buffers = attributes.map((attribute) => {
        const array =
          attribute instanceof THREE.InterleavedBufferAttribute
            ? attribute.data.array
            : attribute.array;
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength,
        );
        return { bytes, before: bytes.slice() };
      });
      const reference = new THREE.Mesh(geometry, material);
      reference.position.copy(mesh.position);
      reference.quaternion.copy(mesh.quaternion);
      reference.scale.copy(mesh.scale);
      referenceParent.add(reference);
      scene.add(first, second);
      try {
        expect(mesh.matrixAutoUpdate).toBe(false);
        expect(mesh.matrixWorldAutoUpdate).toBe(true);
        for (const ancestor of [first, second]) {
          ancestor.position.set(-13, 5, 23);
          ancestor.rotation.set(0.11, 0.27, -0.08);
          ancestor.scale.set(-1.1, 0.9, 1.2);
          ancestor.add(parent, referenceParent);
          for (let frame = 0; frame < 4; frame++) {
            ancestor.position.z += 7;
            scene.updateMatrixWorld(true);
            expect(mesh.matrix.elements).toEqual(local.elements);
            expect(mesh.matrixWorld.elements).toEqual(
              reference.matrixWorld.elements,
            );
            expect(parent.matrixAutoUpdate).toBe(true);
            expect(parent.matrixWorldAutoUpdate).toBe(true);
            const bounds = new THREE.Box3().setFromObject(reference);
            const center = bounds.getCenter(new THREE.Vector3());
            const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
            const camera = new THREE.PerspectiveCamera(
              60,
              1,
              0.1,
              (radius + 1) * 10,
            );
            camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
            camera.updateProjectionMatrix();
            camera.position
              .copy(center)
              .add(new THREE.Vector3(0, 0, (radius + 1) * 3));
            for (const expected of [true, false]) {
              camera.lookAt(
                expected
                  ? center
                  : camera.position.clone().add(new THREE.Vector3(0, 0, 1)),
              );
              camera.updateMatrixWorld(true);
              const frustum = new THREE.Frustum().setFromProjectionMatrix(
                new THREE.Matrix4().multiplyMatrices(
                  camera.projectionMatrix,
                  camera.matrixWorldInverse,
                ),
                camera.coordinateSystem,
              );
              expect(reference.intersectsFrustum(frustum)).toBe(expected);
              expect(mesh.intersectsFrustum(frustum)).toBe(expected);
            }
          }
        }
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(material);
        for (const { bytes, before } of buffers) expect(bytes).toEqual(before);
      } finally {
        parent.removeFromParent();
        originalParent?.add(parent);
        parent.updateWorldMatrix(true, true);
      }
    }
  }

  it("keeps frozen terrain and conforming-water local matrices exact through parent changes and tile replacement", () => {
    const owner = fixture(3200, true);
    publish(owner, owner.root);
    settle(owner);
    const terrainMesh = owner.terrainContainer.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    )!;
    const ocean = meshes(owner)[0];
    checkRigidMatrices([
      terrainMesh,
      ...owner.container.children.filter(
        (child): child is THREE.Mesh => child instanceof THREE.Mesh,
      ),
    ]);
    let terrainDisposals = 0,
      oceanDisposals = 0;
    terrainMesh.geometry.addEventListener("dispose", () => terrainDisposals++);
    ocean.geometry.addEventListener("dispose", () => oceanDisposals++);
    const oldPositions = terrainMesh.geometry
      .getAttribute("position")
      .array.slice();
    owner.visual.onNodeDestroyGeometry(owner.root);
    publish(owner, owner.root);
    const replacement = owner.terrainContainer.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    )!;
    expect(replacement).not.toBe(terrainMesh);
    expect(replacement.material).toBe(terrainMesh.material);
    expect(replacement.geometry.getAttribute("position").array).toEqual(
      oldPositions,
    );
    expect(terrainDisposals).toBe(1);
    expect(terrainMesh.parent).toBeNull();
    checkRigidMatrices([replacement]);
    split(owner, owner.root);
    settle(owner);
    expect(oceanDisposals).toBe(1);
    expect(ocean.parent).toBeNull();
    expect(meshes(owner)).toHaveLength(4);
    checkRigidMatrices(meshes(owner));
  });

  it("freezes direct legacy water leaves and authored ponds without changing their replacement ownership", () => {
    const owner = fixture(3200);
    const container = new THREE.Group();
    const direct = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain["getHeightAtComputed"](x, z),
      (x, z) => terrain["getIslandMask"](x, z),
      terrain.getWorldTerrainProfile().water.threshold,
      terrain["waterBodyRegistry"].getAllBodies(),
    );
    try {
      direct.onNodeNeedsGeometry(owner.root);
      const all = container.children.filter(
        (child): child is THREE.Mesh => child instanceof THREE.Mesh,
      );
      expect(all.some((mesh) => mesh.userData.elevated === true)).toBe(true);
      const leaf = all.find((mesh) => mesh.userData.elevated !== true)!;
      expect(leaf).toBeDefined();
      checkRigidMatrices(all);
      let disposals = 0;
      leaf.geometry.addEventListener("dispose", () => disposals++);
      direct.onNodeDestroyGeometry(owner.root);
      direct.onNodeNeedsGeometry(owner.root);
      expect(disposals).toBe(1);
      expect(leaf.parent).toBeNull();
      const replacement = container.children.find(
        (child): child is THREE.Mesh =>
          child instanceof THREE.Mesh && child.userData.elevated !== true,
      )!;
      expect(replacement).not.toBe(leaf);
      expect(replacement.material).toBe(leaf.material);
      checkRigidMatrices([replacement]);
    } finally {
      direct.destroy();
    }
  });

  it("waits for a complete dry-inclusive installed partition, then performs bounded hidden staging", () => {
    const owner = fixture();
    // A small, genuinely mixed-depth complete partition includes the real dry
    // meadow leaf350,350; no fake terrain or fabricated ready flags.
    let target = owner.root;
    for (const key of ["se", "nw", "se", "se"] as const) {
      if (target.children.size === 0) target.split();
      target = target.children.get(key)!;
    }
    const all = leaves(owner.root);
    const dry = all.find((n) => n.centerX === 350 && n.centerZ === 350)!;
    expect(dry).toBeDefined();
    expect(terrain["getHeightAtComputed"](350, 350)).toBeGreaterThan(
      terrain.getWorldTerrainProfile().water.threshold,
    );
    for (const node of all.filter((n) => n !== dry)) publish(owner, node);
    owner.manager.update();
    expect(meshes(owner)).toHaveLength(0);
    expect(owner.manager.getConformingReadiness().pending).toBe(true);
    publish(owner, dry);
    let previous = 0;
    for (
      let i = 0;
      i < 512 && !owner.manager.getConformingReadiness().ready;
      i++
    ) {
      owner.manager.update();
      const receipt = owner.manager.getConformingReadiness();
      expect(receipt.error).toBeNull();
      if (!receipt.ready) {
        expect(meshes(owner)).toHaveLength(0);
        expect(receipt.stagedChunks - previous).toBeLessThanOrEqual(
          COMPACT_CONFORMING_WATER.maxMeshesPerUpdate,
        );
        previous = receipt.stagedChunks;
      }
    }
    expect(owner.manager.getConformingReadiness().ready).toBe(true);
    expect(owner.manager.getConformingReadiness().partitionLeaves).toBe(
      all.length,
    );
    expect(meshes(owner).length).toBeLessThan(all.length);
    expect(meshes(owner).some((m) => m.name.includes(`_wq_${dry.id}_`))).toBe(
      false,
    );
  });

  it("retains the complete old water through split/merge staging and reuses unchanged owners", () => {
    const owner = fixture(3200);
    publish(owner, owner.root);
    settle(owner);
    const old = meshes(owner)[0];
    let oldDisposals = 0;
    old.geometry.addEventListener("dispose", () => oldDisposals++);
    owner.root.split();
    const children = [...owner.root.children.values()];
    for (const child of children.slice(0, 3)) publish(owner, child);
    settle(owner);
    expect(meshes(owner)).toEqual([old]);
    publish(owner, children[3]);
    owner.manager.update();
    expect(meshes(owner)).toEqual([old]);
    expect(oldDisposals).toBe(0);
    settle(owner);
    expect(meshes(owner)).toHaveLength(4);
    expect(oldDisposals).toBe(1);
    const before = meshes(owner),
      geometry = before.map((m) => m.geometry),
      revision = owner.manager.getConformingReadiness().revision;
    for (let i = 0; i < 8; i++) owner.manager.update();
    expect(meshes(owner)).toEqual(before);
    expect(meshes(owner).map((m) => m.geometry)).toEqual(geometry);
    expect(owner.manager.getConformingReadiness().revision).toBe(revision);
    // A descendant transition only rebuilds its own area and neighbors whose
    // explicit edge lists change; opposite corner stays the exact same owner.
    const opposite = children.find(
      (node) =>
        node.centerX !== children[0].centerX &&
        node.centerZ !== children[0].centerZ,
    )!;
    const untouched = before.find((m) =>
      m.name.includes(`_wq_${opposite.id}_`),
    )!;
    split(owner, children[0]);
    settle(owner);
    expect(meshes(owner)).toContain(untouched);
    owner.root.unsplit();
    publish(owner, owner.root);
    settle(owner);
    expect(meshes(owner)).toHaveLength(1);
  });

  it("cancels split reversal staging without retiring the currently visible partition", () => {
    const owner = fixture(3200);
    publish(owner, owner.root);
    settle(owner);
    const before = meshes(owner)[0];
    split(owner, owner.root);
    owner.manager.update();
    const staged = owner.container.children.filter(
      (c) => !c.visible,
    ) as THREE.Mesh[];
    expect(staged.length).toBeGreaterThan(0);
    let disposed = 0;
    for (const mesh of staged)
      mesh.geometry.addEventListener("dispose", () => disposed++);
    owner.root.unsplit();
    publish(owner, owner.root);
    settle(owner);
    expect(disposed).toBe(staged.length);
    expect(meshes(owner)).toEqual([before]);
  });

  it("gates real TerrainSystem streaming readiness until the owned water partition commits", () => {
    const owner = fixture();
    const previousTerrain = terrain["quadTreeVisualManager"],
      previousWater = terrain["waterVisualManager"];
    // Bind actual managers, as TerrainSystem initialization does. No readiness
    // result, tree state, owner, renderer or terrain sampler is substituted.
    terrain["quadTreeVisualManager"] = owner.visual;
    terrain["waterVisualManager"] = owner.manager;
    try {
      for (const node of leaves(owner.root)) publish(owner, node);
      const partition = leaves(owner.root);
      const installed = owner.terrainContainer.children.filter(
        (child): child is THREE.Mesh => child instanceof THREE.Mesh,
      );
      expect(installed).toHaveLength(partition.length);
      console.info(
        "production-detail-water-fixture",
        JSON.stringify({
          leaves: partition.length,
          resolutions: [...new Set(partition.map((node) => node.resolution))]
            .sort((a, b) => a - b)
            .map((resolution) => ({
              resolution,
              leaves: partition.filter((node) => node.resolution === resolution)
                .length,
            })),
          verticesIncludingSkirts: installed.reduce(
            (sum, mesh) => sum + mesh.geometry.getAttribute("position").count,
            0,
          ),
          trianglesIncludingSkirts: installed.reduce(
            (sum, mesh) => sum + mesh.geometry.index!.count / 3,
            0,
          ),
          nativeOrPerformanceApproval: false,
        }),
      );
      const pending = terrain.getStreamingVisualReadiness();
      expect(pending.terrain?.ready).toBe(true);
      expect(pending.waterTopology).toEqual(
        owner.manager.getConformingReadiness(),
      );
      expect(pending.waterTopology?.required).toBe(true);
      expect(pending.ready).toBe(false);
      settle(owner);
      expect(terrain.getStreamingVisualReadiness().ready).toBe(true);
      owner.manager.destroy();
      expect(terrain.getStreamingVisualReadiness().ready).toBe(false);
    } finally {
      terrain["quadTreeVisualManager"] = previousTerrain;
      terrain["waterVisualManager"] = previousWater;
    }
  });

  it("retains the old complete world-space ocean while a translated root is unavailable", () => {
    const owner = fixture();
    for (const node of leaves(owner.root)) publish(owner, node);
    settle(owner);
    const old = meshes(owner);
    const oldPositions = old.map((mesh) =>
      mesh.geometry.getAttribute("position").array.slice(),
    );
    let disposed = 0;
    for (const mesh of old)
      mesh.geometry.addEventListener("dispose", () => disposed++);
    owner.tree.update(3200, 0);
    owner.manager.update();
    expect(meshes(owner)).toEqual(old);
    for (const [index, mesh] of old.entries())
      expect(mesh.geometry.getAttribute("position").array).toEqual(
        oldPositions[index],
      );
    expect(owner.manager.getConformingReadiness().ready).toBe(false);
    const next = owner.tree.getFinalNodes()[0];
    expect(next.centerX).toBe(3200);
    publish(owner, next);
    settle(owner);
    expect(disposed).toBe(old.length);
    const current = meshes(owner)[0];
    expect(current.position.toArray()).toEqual([
      0,
      terrain.getWorldTerrainProfile().water.threshold,
      0,
    ]);
    expect(current.geometry.userData.oceanContinuation.rootCenterX).toBe(3200);
    expect(current.geometry.boundingBox!.min.x).toBeLessThanOrEqual(1400);
    expect(current.geometry.boundingBox!.max.x).toBeGreaterThanOrEqual(5000);
  });

  it("survives reentrant added cancellation and commits before removed listeners run", () => {
    const owner = fixture(3200);
    publish(owner, owner.root);
    settle(owner);
    const old = meshes(owner)[0];
    split(owner, owner.root);
    const cancel = () => {
      owner.container.removeEventListener("childadded", cancel);
      owner.manager.onNodeNeedsGeometry(owner.root);
    };
    owner.container.addEventListener("childadded", cancel);
    owner.manager.update();
    expect(meshes(owner)).toEqual([old]);
    expect(owner.manager.getConformingReadiness().stagedChunks).toBe(0);
    let removalSeen = false;
    old.addEventListener("removed", () => {
      removalSeen = true;
      expect(meshes(owner)).toHaveLength(4);
      expect(owner.manager.getConformingReadiness().waterChunks).toBe(4);
      owner.manager.update(); // Reentrant update cannot start another transaction.
    });
    settle(owner);
    expect(removalSeen).toBe(true);
  });

  it("disposes staged/active ownership exactly once on reentrant destroy and leaves borrowed materials alive", () => {
    const owner = fixture(3200, true);
    publish(owner, owner.root);
    settle(owner);
    const active = [...owner.container.children] as THREE.Mesh[];
    let disposal = 0,
      materialDisposal = 0;
    for (const mesh of active)
      mesh.geometry.addEventListener("dispose", () => disposal++);
    const borrowed = water.getMaterial("ocean")!;
    const onMaterial = () => materialDisposal++;
    borrowed.addEventListener("dispose", onMaterial);
    split(owner, owner.root);
    const destroy = () => {
      owner.container.removeEventListener("childadded", destroy);
      owner.manager.destroy();
    };
    owner.container.addEventListener("childadded", destroy);
    owner.manager.update();
    owner.manager.destroy();
    expect(owner.container.children).toHaveLength(0);
    expect(water.waterMeshCount).toBe(0);
    expect(disposal).toBe(active.length);
    expect(materialDisposal).toBe(0);
    borrowed.removeEventListener("dispose", onMaterial);
  });

  it("preserves the exact quiet pond across ocean refinement", () => {
    const owner = fixture(3200, true);
    const pond = owner.container.children[0] as THREE.Mesh;
    const geometry = pond.geometry,
      material = pond.material,
      position = pond.position.toArray();
    publish(owner, owner.root);
    settle(owner);
    split(owner, owner.root);
    settle(owner);
    expect(pond.parent).toBe(owner.container);
    expect(pond.geometry).toBe(geometry);
    expect(pond.material).toBe(material);
    expect(pond.position.toArray()).toEqual(position);
    expect(pond.userData.compactQuietPond).toBe(true);
  });

  it("shares exact mixed-depth and continuation boundary inputs and actual displaced graph outputs", () => {
    const owner = fixture(3200);
    publish(owner, owner.root);
    settle(owner);
    let selected = split(owner, owner.root)[0];
    for (let depth = 2; depth <= 4; depth++)
      selected = split(owner, selected)[0];
    settle(owner);
    const current = meshes(owner),
      material = water.getMaterial("ocean")!;
    const duplicates = new Map<
      string,
      Array<{ mesh: THREE.Mesh; index: number }>
    >();
    for (const mesh of current) {
      expect(mesh.position.toArray()).toEqual([
        0,
        terrain.getWorldTerrainProfile().water.threshold,
        0,
      ]);
      expect(mesh.material).toBe(material);
      const meta = mesh.geometry.userData.conformingWater as Metadata;
      const positions = mesh.geometry.getAttribute("position"),
        shore = mesh.geometry.getAttribute("shoreDistance");
      expect(shore.count).toBe(positions.count);
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i),
          z = positions.getZ(i);
        expect(shore.getX(i)).toBe(50);
        expect(positions.getY(i)).toBe(0);
        const key = `${x},${z}`,
          rows = duplicates.get(key) ?? [];
        rows.push({ mesh, index: i });
        duplicates.set(key, rows);
      }
      for (const side of Object.keys(meta.edges) as WaterGridSide[]) {
        const ids = meta.edges[side];
        expect(ids.length).toBeGreaterThanOrEqual(2);
        for (const id of ids) expect(id).toBeLessThan(positions.count);
      }
      expect(mesh.geometry.boundingBox!.min.y).toBeLessThan(0);
      expect(mesh.geometry.boundingBox!.max.y).toBeGreaterThan(0);
    }
    const shared = [...duplicates.values()].filter(
      (rows) => new Set(rows.map((r) => r.mesh)).size > 1,
    );
    expect(shared.length).toBeGreaterThan(30);
    const uniforms = water["oceanUniforms"]!;
    const previous = [uniforms.time.value, uniforms.windStrength.value];
    try {
      for (const time of [0, 1.75, 93])
        for (const wind of [0, 0.6, 3]) {
          uniforms.time.value = time;
          uniforms.windStrength.value = wind;
          for (const rows of shared) {
            const values = rows.map(({ mesh, index }) => {
              const p = mesh.geometry.getAttribute("position");
              const local = [p.getX(index), p.getY(index), p.getZ(index)];
              return displaced(material.positionNode!, local, [
                local[0],
                local[1] + mesh.position.y,
                local[2],
              ]);
            });
            for (const value of values) expect(value).toEqual(values[0]);
          }
        }
    } finally {
      [uniforms.time.value, uniforms.windStrength.value] = previous;
    }
  });
});
