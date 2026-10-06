import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ClientLoader } from "../../../client/ClientLoader";
import { ClientGraphics } from "../../../client/ClientGraphics";
import { modelCache } from "../../../../utils/rendering/ModelCache";
import * as single from "../GLBTreeInstancer";
import * as batched from "../GLBTreeBatchedInstancer";
import { GPU_VEG_CONFIG, type TreeDissolveMaterial } from "../GPUMaterials";
import { getLODDistances } from "../LODConfig";
import { TREE_WIND_ATTRIBUTE, type TreeWindMode } from "../TreeWind";
import { Wind } from "../Wind";

type Kind = "single" | "batched";
type Part = "bark" | "leaf";
type PoolMesh = THREE.InstancedMesh | THREE.BatchedMesh;
const variants = ["a", "b", "c"] as const;
const parts = ["bark", "leaf"] as const;
const base = (variant: number) => -2 - variant * 2;
const top = (variant: number) => 6 + variant * 4;
const pathFor = (variant: number, lod: number) =>
  `/${variants[variant]}${lod ? `_lod${lod}` : ""}.glb`;

function authoredPositions(variant: number, lod: number, part: Part): number[] {
  const x = variant * 4 + lod * 0.5;
  const low = base(variant) - lod;
  const high = top(variant) + lod * 2;
  const join = (low + high) / 2;
  return part === "bark"
    ? [x, low, 0, x + 0.25, low, 0, x + 0.5, join, 0]
    : [x + 0.5, join, 0, x + 0.75, high, 0, x + 1, join, 0];
}

// Actual texture-free glTF binary. Deliberately reversed material/mesh order in
// alternating variants/LODs catches slot matching based on traversal order.
// Lower LODs extend below the base and above LOD0's top to expose clamping or
// accidentally deriving a new per-LOD/per-material wind descriptor.
function treeGLB(variant: number, lod: number, leafMask?: number): Buffer {
  const order: Part[] = (variant + lod) % 2 ? ["leaf", "bark"] : [...parts];
  const positions = order.map((part) => authoredPositions(variant, lod, part));
  const attributes = [
    ...positions,
    ...(leafMask === undefined
      ? []
      : order.map((part) =>
          Array.from({ length: 9 }, (_, i) =>
            i % 3 === 0 ? (part === "leaf" ? leafMask : 0) : 1,
          ),
        )),
  ];
  const chunks = attributes.map((values) =>
    Buffer.from(new Float32Array(values).buffer),
  );
  const binary = Buffer.concat(chunks);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: order.map((name, mesh) => ({ name, mesh })),
      meshes: order.map((_, index) => ({
        primitives: [
          {
            attributes: {
              POSITION: index,
              ...(leafMask === undefined
                ? {}
                : { COLOR_0: index + positions.length }),
            },
            material: index,
          },
        ],
      })),
      materials: order.map((name) => ({
        name,
        pbrMetallicRoughness: {
          baseColorFactor:
            name === "bark" ? [0.35, 0.15, 0.05, 1] : [0.05, 0.55, 0.1, 1],
        },
      })),
      buffers: [{ byteLength: binary.length }],
      bufferViews: chunks.map((chunk, index) => ({
        buffer: 0,
        byteOffset: index * chunk.length,
        byteLength: chunk.length,
      })),
      accessors: attributes.map((values, bufferView) => ({
        bufferView,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 1, 2].map((axis) =>
          Math.min(values[axis], values[axis + 3], values[axis + 6]),
        ),
        max: [0, 1, 2].map((axis) =>
          Math.max(values[axis], values[axis + 3], values[axis + 6]),
        ),
      })),
    }),
  );
  const text = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + binary.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, binary]);
}

class TreePool {
  constructor(
    readonly kind: Kind,
    readonly world: World,
    readonly urls: string[],
    readonly treeType = "wind-fixture",
  ) {}
  init(mode?: TreeWindMode, lodCandidate?: "projected-v1") {
    const options = { windMode: mode, lodCandidate };
    if (this.kind === "single")
      single.initGLBTreeInstancer(this.world.stage.scene, this.world, options);
    else
      batched.initGLBTreeBatchedInstancer(
        this.world.stage.scene,
        this.world,
        options,
      );
  }
  destroy() {
    if (this.kind === "single") single.destroyGLBTreeInstancer();
    else batched.destroyGLBTreeBatchedInstancer();
  }
  add(
    variant: number,
    id: string,
    x = 10 + variant * 10,
    lifetime?: single.TreeInstanceLifetime,
    scale = 1.25,
  ) {
    const position = new THREE.Vector3(x, 2, 0);
    return this.kind === "single"
      ? single.addInstance(
          this.urls[variant],
          id,
          position,
          0.37,
          scale,
          null,
          null,
          0,
          lifetime,
        )
      : batched.addInstance(
          this.treeType,
          this.urls,
          variant,
          id,
          position,
          0.37,
          scale,
          0,
          lifetime,
        );
  }
  remove(id: string) {
    (this.kind === "single" ? single : batched).removeInstance(id);
  }
  has(id: string) {
    return (this.kind === "single" ? single : batched).hasInstance(id);
  }
  deplete(id: string, direction: 1 | -1) {
    (this.kind === "single" ? single : batched).startDissolve(
      id,
      direction,
      true,
    );
  }
  proxy(id: string) {
    return (this.kind === "single" ? single : batched).getProxyGeometry(id);
  }
  update(lod: 0 | 1 | 2) {
    const distances = getLODDistances(
      this.kind === "single" ? "resource" : "tree",
    );
    const distance =
      lod === 0
        ? 0
        : lod === 1
          ? (distances.lod1Distance + distances.lod2Distance) / 2
          : distances.lod2Distance + 200;
    this.world.camera.position.set(20, 5, distance);
    this.world.camera.lookAt(20, 2, 0);
    this.world.camera.updateMatrixWorld(true);
    this.world.frame++;
    if (this.kind === "single") single.updateGLBTreeInstancer(1 / 60);
    else batched.updateGLBTreeBatchedInstancer(1 / 60);
  }
  meshes(): PoolMesh[] {
    return this.world.stage.scene.children.filter((node): node is PoolMesh =>
      this.kind === "single"
        ? node instanceof THREE.InstancedMesh
        : node instanceof THREE.BatchedMesh,
    );
  }
  ownership(
    expectedWorld = this.world,
    expectedScene = this.world.stage.scene,
  ) {
    return this.kind === "single"
      ? single.getGLBTreeRenderOwnership(expectedWorld, expectedScene)
      : batched.getGLBTreeBatchedRenderOwnership(expectedWorld, expectedScene);
  }
}

function newWorld(): World {
  const world = new World();
  world.register("loader", ClientLoader);
  return world;
}

async function withTrees(
  kind: Kind,
  verify: (fixture: {
    pool: TreePool;
    requested: Promise<void>;
    release(): void;
    track<T>(promise: Promise<T>): Promise<T>;
    source(
      variant: number,
      lod: number,
    ): Promise<Map<Part, THREE.BufferGeometry>>;
  }) => Promise<void>,
  options: {
    missingMiddleLods?: number[];
    heldPath?: string;
    mode?: TreeWindMode;
    lodCandidate?: "projected-v1";
    leafMask?: number;
  } = {},
) {
  const files = new Map<string, Buffer>();
  for (let variant = 0; variant < 3; variant++)
    for (let lod = 0; lod < 3; lod++) {
      if (variant === 1 && options.missingMiddleLods?.includes(lod)) continue;
      files.set(pathFor(variant, lod), treeGLB(variant, lod, options.leafMask));
    }
  let released = !options.heldPath,
    signal!: () => void;
  const requested = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held: Array<{ path: string; response: ServerResponse }> = [];
  const respond = (path: string, response: ServerResponse) => {
    const bytes = files.get(path);
    response.writeHead(bytes ? 200 : 404, {
      "Content-Type": "model/gltf-binary",
    });
    response.end(bytes);
  };
  const server = createServer((request, response) => {
    const path = request.url!;
    if (path === options.heldPath && !released) {
      held.push({ path, response });
      signal();
    } else respond(path, response);
  });
  const release = () => {
    released = true;
    for (const item of held.splice(0)) respond(item.path, item.response);
  };
  const operations: Promise<unknown>[] = [];
  const world = newWorld();
  let origin = "";
  let pool: TreePool | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture HTTP address");
    origin = `http://127.0.0.1:${address.port}`;
    pool = new TreePool(
      kind,
      world,
      variants.map((_, index) => origin + pathFor(index, 0)),
    );
    pool.init(options.mode ?? "connected-v1", options.lodCandidate);
    await verify({
      pool,
      requested,
      release,
      track<T>(promise: Promise<T>) {
        operations.push(promise);
        return promise;
      },
      async source(variant, lod) {
        const loaded = await modelCache.loadModel(
          origin + pathFor(variant, lod),
          world,
        );
        const result = new Map<Part, THREE.BufferGeometry>();
        loaded.scene.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            const material = node.material as THREE.Material;
            if (material.name !== "bark" && material.name !== "leaf")
              throw new Error("Unexpected real GLB material");
            result.set(material.name, node.geometry);
          }
        });
        expect([...result.keys()].sort()).toEqual(["bark", "leaf"]);
        return result;
      },
    });
  } finally {
    release();
    await Promise.allSettled(operations);
    pool?.destroy();
    for (let variant = 0; variant < 3; variant++)
      for (let lod = 0; lod < 3; lod++)
        modelCache.remove(origin + pathFor(variant, lod));
    world.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function geometryState(geometry: THREE.BufferGeometry) {
  return {
    attributes: Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        {
          array: Array.from(attribute.array),
          itemSize: attribute.itemSize,
          normalized: attribute.normalized,
        },
      ]),
    ),
    index: geometry.index ? Array.from(geometry.index.array) : null,
    groups: geometry.groups.map((group) => ({ ...group })),
    bounds: geometry.boundingBox?.clone() ?? null,
    sphere: geometry.boundingSphere?.clone() ?? null,
  };
}

function activeRows(pool: TreePool) {
  const rows: Array<{
    mesh: PoolMesh;
    slot: number;
    start: number;
    count: number;
    matrix: THREE.Matrix4;
    dissolve: number;
    part: Part;
  }> = [];
  for (const mesh of pool.meshes()) {
    const material = mesh.material as TreeDissolveMaterial;
    const part = material.treeLighting.sourceMaterialName;
    if (part !== "bark" && part !== "leaf")
      throw new Error("Lost source material identity");
    if (mesh instanceof THREE.InstancedMesh) {
      for (let slot = 0; slot < mesh.count; slot++) {
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(slot, matrix);
        rows.push({
          mesh,
          slot,
          matrix,
          start: 0,
          count: mesh.geometry.getAttribute("position").count,
          part,
          dissolve: mesh.geometry.getAttribute("instanceDissolve").getX(slot),
        });
      }
    } else {
      let found = 0;
      for (
        let slot = 0;
        found < mesh.instanceCount && slot < mesh.maxInstanceCount;
        slot++
      ) {
        let geometryId: number;
        try {
          geometryId = mesh.getGeometryIdAt(slot);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("instanceId")
          )
            throw error;
          continue;
        }
        const range = mesh.getGeometryRangeAt(geometryId),
          matrix = new THREE.Matrix4(),
          color = new THREE.Color();
        if (!range)
          throw new Error("Active tree instance lost its geometry range");
        mesh.getMatrixAt(slot, matrix);
        mesh.getColorAt(slot, color);
        found++;
        rows.push({
          mesh,
          slot,
          matrix,
          start: range.vertexStart,
          count: range.vertexCount,
          part,
          dissolve: 1 - color.b,
        });
      }
      expect(found).toBe(mesh.instanceCount);
    }
  }
  return rows;
}

function verifyRow(
  row: ReturnType<typeof activeRows>[number],
  variant: number,
  lod: number,
  kind: Kind,
) {
  const geometry = row.mesh.geometry,
    positions = geometry.getAttribute("position"),
    metadata = geometry.getAttribute(TREE_WIND_ATTRIBUTE);
  const expected = authoredPositions(variant, lod, row.part);
  const root = kind === "single" ? base(variant) : 0,
    height = top(variant) - root;
  expect(row.count).toBe(3);
  expect(metadata.itemSize).toBe(2);
  for (let index = 0; index < row.count; index++) {
    const offset = row.start + index;
    expect([
      positions.getX(offset),
      positions.getY(offset),
      positions.getZ(offset),
    ]).toEqual(expected.slice(index * 3, index * 3 + 3));
    expect(metadata.getX(offset)).toBe(expected[index * 3 + 1] - root);
    expect(metadata.getY(offset)).toBe(height);
  }
  expect((row.mesh.material as TreeDissolveMaterial).treeWind.mode).toBe(
    "connected-v1",
  );
  expect(
    Object.isFrozen((row.mesh.material as TreeDissolveMaterial).treeWind),
  ).toBe(true);
}

// Real DOM canvas and r186 renderer, deliberately never initialized on a GPU.
// This tests public drawing-buffer sizing/CPU selection, not rendering quality.
async function withTreeViewport(
  world: World,
  verify: (renderer: THREE.WebGPURenderer) => Promise<void>,
) {
  const dom = new JSDOM("<canvas></canvas>");
  const canvas = dom.window.document.querySelector("canvas")!;
  const renderer = new THREE.WebGPURenderer({ canvas });
  const graphics = world.register("graphics", ClientGraphics);
  if (!(graphics instanceof ClientGraphics))
    throw new Error("Expected actual registered graphics system");
  graphics.renderer = renderer;
  renderer.setSize(1000, 500);
  world.camera.aspect = 2;
  world.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  world.camera.updateProjectionMatrix();
  world.camera.position.set(20, 5, 200);
  world.camera.lookAt(20, 2, 0);
  world.camera.updateMatrixWorld(true);
  try {
    await verify(renderer);
  } finally {
    // This CPU fixture owns the uninitialized renderer; normal graphics teardown
    // calls setAnimationLoop and would initialize a device even for null.
    Reflect.deleteProperty(graphics, "renderer");
    await renderer.dispose();
    dom.window.close();
  }
}

describe("actual GLB tree read-only render ownership", () => {
  for (const kind of ["single", "batched"] as const) {
    it(`${kind}: refuses uninitialized/foreign owners and observes cold publication without loading or mutating it`, async () => {
      await withTrees(
        kind,
        async ({ pool, requested, release, track }) => {
          pool.destroy();
          expect(pool.ownership()).toBeNull();
          pool.init("connected-v1");
          const empty = pool.ownership();
          expect(empty).not.toBeNull();
          expect(empty!.records).toHaveLength(0);
          const otherWorld = newWorld();
          try {
            expect(pool.ownership(otherWorld)).toBeNull();
            expect(pool.ownership(pool.world, new THREE.Scene())).toBeNull();
            expect(
              pool.ownership(otherWorld, otherWorld.stage.scene),
            ).toBeNull();
            expect(pool.ownership()).toEqual(empty);
          } finally {
            otherWorld.destroy();
          }
          const add = track(pool.add(0, "owner"));
          await requested;
          const children = pool.world.stage.scene.children.slice();
          expect(pool.ownership()).toEqual(empty);
          expect(pool.ownership()).toEqual(empty);
          expect(pool.world.stage.scene.children).toEqual(children);
          expect(pool.has("owner")).toBe(false);
          release();
          expect(await add).toBe(true);
          const snapshot = pool.ownership()!;
          expect(snapshot.generation).toBe(empty!.generation);
          expect(empty!.records).toHaveLength(0);
          expect(snapshot.records).toHaveLength(6);
          expect(
            snapshot.records.map(({ lod, materialSlot }) => [
              lod,
              materialSlot,
            ]),
          ).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
            [2, 0],
            [2, 1],
          ]);
          expect(new Set(snapshot.records.map((row) => row.pool))).toEqual(
            new Set([kind === "single" ? pool.urls[0] : pool.treeType]),
          );
          expect(new Set(snapshot.records.map((row) => row.mesh))).toEqual(
            new Set(pool.meshes()),
          );
          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.records)).toBe(true);
          expect(Reflect.set(snapshot, "generation", -1)).toBe(false);
          expect(Reflect.set(snapshot.records, "length", 0)).toBe(false);
          const before = snapshot.records.map(
            ({ mesh, geometry, material }) => ({
              mesh,
              geometry,
              material,
              visible: mesh.visible,
              parent: mesh.parent,
              count:
                mesh instanceof THREE.InstancedMesh
                  ? mesh.count
                  : mesh.instanceCount,
              materialVersion: material.version,
              positions: Array.from(geometry.getAttribute("position").array),
            }),
          );
          for (const row of snapshot.records) {
            expect(Object.isFrozen(row)).toBe(true);
            expect(Reflect.set(row, "mesh", row.mesh)).toBe(false);
            expect(Object.isFrozen(row.mesh)).toBe(false);
            expect(row.geometry).toBe(row.mesh.geometry);
            expect(row.material).toBe(row.mesh.material);
          }
          expect(pool.ownership()).toEqual(snapshot);
          expect(
            snapshot.records.map(({ mesh, geometry, material }) => ({
              mesh,
              geometry,
              material,
              visible: mesh.visible,
              parent: mesh.parent,
              count:
                mesh instanceof THREE.InstancedMesh
                  ? mesh.count
                  : mesh.instanceCount,
              materialVersion: material.version,
              positions: Array.from(geometry.getAttribute("position").array),
            })),
          ).toEqual(before);
          expect(before.filter((row) => row.count === 0)).toHaveLength(4);
          const first = snapshot.records[0];
          const foreign = new THREE.MeshBasicMaterial();
          try {
            first.mesh.material = foreign;
            expect(pool.ownership()).toBeNull();
            expect(first.mesh.material).toBe(foreign);
            first.mesh.material = [first.material];
            expect(pool.ownership()).toBeNull();
          } finally {
            first.mesh.material = first.material;
            foreign.dispose();
          }
          expect(pool.ownership()).toEqual(snapshot);
        },
        { heldPath: "/a.glb" },
      );
    }, 15_000);

    it(`${kind}: retains hidden/empty membership, detects additional pools, and separates destroyed/reinitialized lifetimes`, async () => {
      await withTrees(kind, async ({ pool, track }) => {
        expect(await track(pool.add(0, "first"))).toBe(true);
        const first = pool.ownership()!;
        const otherPool = new TreePool(
          kind,
          pool.world,
          pool.urls,
          "second-owner",
        );
        expect(await track(otherPool.add(1, "second"))).toBe(true);
        const expanded = pool.ownership()!;
        expect(expanded.generation).toBe(first.generation);
        expect(first.records).toHaveLength(6);
        expect(expanded.records).toHaveLength(12);
        for (const lod of [0, 1, 2] as const) {
          pool.update(lod);
          expect(pool.ownership()).toEqual(expanded);
        }
        pool.remove("first");
        otherPool.remove("second");
        for (const row of expanded.records) row.mesh.visible = false;
        expect(pool.ownership()).toEqual(expanded);
        expect(activeRows(pool)).toHaveLength(0);
        const disposed = new Map<
          THREE.BufferGeometry | THREE.Material,
          number
        >();
        for (const row of expanded.records) {
          for (const resource of [row.geometry, row.material]) {
            disposed.set(resource, 0);
            resource.addEventListener("dispose", () => {
              disposed.set(resource, disposed.get(resource)! + 1);
            });
          }
        }
        pool.ownership();
        expect([...disposed.values()]).toEqual(Array(disposed.size).fill(0));
        pool.destroy();
        expect(pool.ownership()).toBeNull();
        expect([...disposed.values()]).toEqual(Array(disposed.size).fill(1));
        pool.init("connected-v1");
        const successor = pool.ownership()!;
        expect(successor.generation).toBeGreaterThan(expanded.generation);
        expect(successor.records).toHaveLength(0);
        expect(await track(pool.add(0, "successor"))).toBe(true);
        const oldMeshes = new Set(expanded.records.map((row) => row.mesh));
        expect(pool.ownership()!.records).toHaveLength(6);
        expect(
          pool.ownership()!.records.every((row) => !oldMeshes.has(row.mesh)),
        ).toBe(true);
        expect([...disposed.values()]).toEqual(Array(disposed.size).fill(1));
      });
    }, 15_000);
  }
});

describe("actual GLB projected tree LOD candidate", () => {
  it("encloses actual legacy COLOR.R wind without changing source vertices", async () => {
    await withTrees(
      "batched",
      async ({ pool, track, source }) => {
        await withTreeViewport(pool.world, async () => {
          const wind = pool.world.register("wind", Wind);
          if (!(wind instanceof Wind)) throw new Error("Expected actual Wind");
          wind.setStrength(0);
          const geometry = (await source(0, 0)).get("leaf")!;
          const original = geometryState(geometry);
          expect(geometry.getAttribute("color").getX(0)).toBe(1);
          expect(await track(pool.add(0, "legacy"))).toBe(true);
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          const lod1Meshes = activeRows(pool).map((row) => row.mesh);
          expect(lod1Meshes).toHaveLength(2);
          // A large but finite public uniform deliberately stresses the envelope;
          // this is not a proposed production wind setting.
          wind.setStrength(1000);
          pool.world.frame++;
          batched.updateGLBTreeBatchedInstancer(0);
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          expect(
            activeRows(pool).every((row) => !lod1Meshes.includes(row.mesh)),
          ).toBe(true);
          for (const row of activeRows(pool))
            expect(
              (row.mesh.material as TreeDissolveMaterial).treeWind.mode,
            ).toBe("legacy-leaf-v1");
          wind.setStrength(0);
          pool.world.frame++;
          batched.updateGLBTreeBatchedInstancer(0);
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          expect(activeRows(pool).map((row) => row.mesh)).toEqual(lod1Meshes);
          expect(geometryState(geometry)).toEqual(original);
        });
      },
      { mode: "legacy-leaf-v1", lodCandidate: "projected-v1", leafMask: 1 },
    );
  });

  it("keeps the ordinary distance defaults without an explicit selection", async () => {
    await withTrees("batched", async ({ pool, track }) => {
      await withTreeViewport(pool.world, async () => {
        expect(await track(pool.add(0, "default"))).toBe(true);
        batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
        for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
      });
    });
  });

  it("uses native pixels, keeps per-frame membership and preserves interaction geometry/state", async () => {
    await withTrees(
      "batched",
      async ({ pool, track, source }) => {
        await withTreeViewport(pool.world, async (renderer) => {
          expect(await track(pool.add(0, "projected"))).toBe(true);
          const original = [...(await source(0, 2)).values()];
          const snapshots = original.map(geometryState);
          const proxy = pool.proxy("projected")!;
          expect(proxy.geometries).toEqual(original);
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          pool.deplete("projected", 1);
          const before = activeRows(pool).map((row) => row.dissolve);
          const step = () => {
            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          };
          step();
          // A secondary render in this world frame cannot reselect the meshes.
          renderer.setPixelRatio(10);
          expect(renderer.domElement.width).toBe(10000);
          expect(renderer.domElement.style.width).toBe("1000px");
          batched.updateGLBTreeBatchedInstancer(0);
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          step();
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          expect(activeRows(pool).map((row) => row.dissolve)).toEqual(before);
          renderer.setPixelRatio(1);
          pool.world.camera.position.z = 2000;
          pool.world.camera.updateMatrixWorld(true);
          step();
          // This first trial never admits LOD2, even beyond the old 1000m cutoff.
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          expect(pool.proxy("projected")!.geometries).toEqual(proxy.geometries);
          expect(original.map(geometryState)).toEqual(snapshots);
        });
      },
      { lodCandidate: "projected-v1" },
    );
  });

  it("prepares the finalized primary camera once without ticking dissolve twice", async () => {
    await withTrees(
      "batched",
      async ({ pool, track }) => {
        await withTreeViewport(pool.world, async () => {
          const camera = pool.world.camera;
          const expectPublishedRoots = (visibleLOD: 0 | 1 | null) => {
            const records = pool.ownership()!.records;
            // Resource inventory includes hidden/empty roots, not draw calls.
            expect(records).toHaveLength(6);
            for (const record of records)
              expect(record.mesh.visible).toBe(record.lod === visibleLOD);
          };
          expect(await track(pool.add(0, "late-camera"))).toBe(true);
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          expectPublishedRoots(1);

          batched.startDissolve("late-camera", 1, false);
          pool.world.frame++;
          batched.updateGLBTreeBatchedInstancer(0.03);
          for (const row of activeRows(pool)) {
            verifyRow(row, 0, 1, "batched");
            expect(row.dissolve).toBeCloseTo(0.1);
          }
          expectPublishedRoots(1);

          // A camera owner changes pose after hot updates. Deliberately leave
          // its matrixWorld stale: primary preparation must finalize it.
          camera.position.set(10, 5, 20);
          camera.lookAt(10, 5, 100);
          const secondary = camera.clone();
          secondary.lookAt(10, 2, 0);
          batched.prepareGLBTreeBatchedInstancerForRender(secondary);
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          for (const row of activeRows(pool)) {
            verifyRow(row, 0, 0, "batched");
            expect(
              (row.mesh.material as TreeDissolveMaterial).dissolveUniforms
                .cameraPos.value,
            ).toEqual(camera.position);
            expect((row.mesh as THREE.BatchedMesh).getVisibleAt(row.slot)).toBe(
              false,
            );
            expect(row.dissolve).toBeCloseTo(0.1);
          }
          expectPublishedRoots(null);
          expect(activeRows(pool)).toHaveLength(2);

          // Repeated preparation, hot updates and secondary cameras cannot
          // change membership/visibility or advance animation in this frame.
          camera.lookAt(10, 2, 0);
          batched.updateGLBTreeBatchedInstancer(0.03);
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          batched.prepareGLBTreeBatchedInstancerForRender(secondary);
          for (const row of activeRows(pool)) {
            expect((row.mesh as THREE.BatchedMesh).getVisibleAt(row.slot)).toBe(
              false,
            );
            expect(row.dissolve).toBeCloseTo(0.1);
          }
          expectPublishedRoots(null);
          pool.world.frame++;
          batched.updateGLBTreeBatchedInstancer(0.03);
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          for (const row of activeRows(pool)) {
            verifyRow(row, 0, 0, "batched");
            expect((row.mesh as THREE.BatchedMesh).getVisibleAt(row.slot)).toBe(
              true,
            );
            expect(row.dissolve).toBeCloseTo(0.2);
          }
          expectPublishedRoots(0);

          pool.world.frame++;
          batched.updateGLBTreeBatchedInstancer(0.03);
          camera.position.set(20, 5, 200);
          camera.lookAt(20, 2, 0);
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          for (const row of activeRows(pool)) {
            verifyRow(row, 0, 1, "batched");
            expect(row.dissolve).toBeCloseTo(0.3);
            expect(
              (row.mesh.material as TreeDissolveMaterial).dissolveUniforms
                .cameraPos.value,
            ).toEqual(camera.position);
          }
          expectPublishedRoots(1);

          // Reinitializing at the same world.frame must not retain preparation
          // ownership from the destroyed pool.
          pool.destroy();
          pool.init("connected-v1", "projected-v1");
          expect(await track(pool.add(0, "reinitialized"))).toBe(true);
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          batched.prepareGLBTreeBatchedInstancerForRender(camera);
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
        });
      },
      { lodCandidate: "projected-v1" },
    );
  });

  it("unhides an awaited late add before another preparation and reuses removed native slots", async () => {
    await withTrees(
      "batched",
      async ({ pool, track }) => {
        await withTreeViewport(pool.world, async () => {
          const camera = pool.world.camera;
          const wind = pool.world.register("wind", Wind);
          if (!(wind instanceof Wind)) throw new Error("Expected actual Wind");
          const priorStrength = wind.getStrength(),
            priorDirection = wind.getDirection(),
            priorIntensity = wind.getIntensity();
          try {
            expect(await track(pool.add(0, "recycled"))).toBe(true);
            const initialLod0 = activeRows(pool);
            expect(initialLod0).toHaveLength(2);
            const records = pool.ownership()!.records;
            expect(records).toHaveLength(6);
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");

            pool.remove("recycled");
            expect(pool.has("recycled")).toBe(false);
            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            expect(activeRows(pool)).toHaveLength(0);
            for (const record of records) {
              expect((record.mesh as THREE.BatchedMesh).instanceCount).toBe(0);
              expect(record.mesh.visible).toBe(false);
            }

            // Hidden roots remain live wind/material owners.
            wind.setStrength(0.7);
            wind.setDirection(new THREE.Vector3(3, 0, 4));
            wind.update(0.25);
            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            for (const record of records) {
              const uniforms = (record.material as TreeDissolveMaterial)
                .treeUniforms;
              expect(record.mesh.visible).toBe(false);
              expect(uniforms.windTime.value).toBe(0.25);
              expect(uniforms.windStrength.value).toBe(0.7);
              expect(uniforms.windDirection.value.x).toBeCloseTo(0.6);
              expect(uniforms.windDirection.value.y).toBeCloseTo(0.8);
            }

            const preparedFrame = pool.world.frame;
            expect(await track(pool.add(0, "recycled", 12))).toBe(true);
            expect(pool.world.frame).toBe(preparedFrame);
            expect(pool.has("recycled")).toBe(true);
            const readded = activeRows(pool);
            expect(readded).toHaveLength(2);
            for (const row of readded) {
              const original = initialLod0.find(
                (item) => item.part === row.part,
              )!;
              expect(row.mesh).toBe(original.mesh);
              expect(row.slot).toBe(original.slot);
              expect(row.matrix.elements[12]).toBe(12);
              verifyRow(row, 0, 0, "batched");
            }
            for (const record of records)
              expect(record.mesh.visible).toBe(record.lod === 0);
            // Awaited insertion must unhide immediately, even after this frame's
            // sole primary preparation; a repeated prepare cannot rescue it.
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            expect(activeRows(pool).map((row) => row.mesh)).toEqual(
              readded.map((row) => row.mesh),
            );
            for (const row of readded) expect(row.mesh.visible).toBe(true);

            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            const transferred = activeRows(pool);
            expect(transferred).toHaveLength(2);
            for (const row of transferred) {
              verifyRow(row, 0, 1, "batched");
              expect(readded.some((prior) => prior.mesh === row.mesh)).toBe(
                false,
              );
            }
            for (const record of records)
              expect(record.mesh.visible).toBe(record.lod === 1);

            pool.remove("recycled");
            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(camera);
            expect(activeRows(pool)).toHaveLength(0);
            expect(records.every((record) => !record.mesh.visible)).toBe(true);
            // Ownership still inventories all six allocations, not submissions.
            expect(
              pool.ownership()!.records.map((record) => record.mesh),
            ).toEqual(records.map((record) => record.mesh));
          } finally {
            wind.setStrength(priorStrength);
            wind.setDirection(priorDirection);
            wind.setIntensity(priorIntensity);
          }
        });
      },
      { lodCandidate: "projected-v1" },
    );
  });

  it("uses shared batch-parent transforms and retains full detail on basis disagreement", async () => {
    await withTrees(
      "batched",
      async ({ pool, track }) => {
        await withTreeViewport(pool.world, async () => {
          expect(await track(pool.add(0, "parents"))).toBe(true);
          const meshes = pool.meshes();
          const parent = new THREE.Group();
          pool.world.stage.scene.add(parent);
          for (const mesh of meshes) parent.add(mesh);
          const step = () => {
            pool.world.stage.scene.updateMatrixWorld(true);
            pool.world.frame++;
            batched.updateGLBTreeBatchedInstancer(0);
            batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          };
          // Put all batches back at the scene root for the shared row reader,
          // preserving their identical complete parent-space affine transform.
          parent.position.set(0, 0, 185);
          parent.scale.set(2, 1.5, 1);
          parent.rotation.y = 0.2;
          step();
          for (const mesh of meshes) pool.world.stage.scene.attach(mesh);
          parent.removeFromParent();
          step();
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          for (const mesh of meshes) {
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
          }
          step();
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          const otherParent = new THREE.Group();
          pool.world.stage.scene.add(otherParent);
          otherParent.add(meshes[0]);
          step();
          pool.world.stage.scene.add(meshes[0]);
          otherParent.removeFromParent();
          // The selection already returned to LOD0; reparenting alone cannot run it.
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
          step();
          for (const row of activeRows(pool)) verifyRow(row, 0, 1, "batched");
          meshes[0].position.x = 1;
          step();
          for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
        });
      },
      { lodCandidate: "projected-v1" },
    );
  });

  it("fails closed before renderer readiness and when a variant has no admitted LOD1", async () => {
    await withTrees(
      "batched",
      async ({ pool, track }) => {
        expect(await track(pool.add(0, "not-ready"))).toBe(true);
        for (const row of activeRows(pool)) verifyRow(row, 0, 0, "batched");
        expect(() => pool.init("connected-v1")).toThrow("requires teardown");
        pool.remove("not-ready");
        await withTreeViewport(pool.world, async () => {
          expect(await track(pool.add(1, "missing-lod1"))).toBe(true);
          batched.prepareGLBTreeBatchedInstancerForRender(pool.world.camera);
          for (const row of activeRows(pool)) verifyRow(row, 1, 0, "batched");
        });
      },
      { lodCandidate: "projected-v1", missingMiddleLods: [1] },
    );
  });
});

describe("actual GLB tree pool connected-wind integration", () => {
  for (const kind of ["single", "batched"] as const) {
    it(`${kind}: actual cached GLBs retain full-tree metadata, material identity, borrowed geometry and LOD ownership`, async () => {
      await withTrees(kind, async ({ pool, source, track }) => {
        const sources: Array<{
          geometry: THREE.BufferGeometry;
          snapshot: ReturnType<typeof geometryState>;
          disposed: number;
        }> = [];
        for (let variant = 0; variant < 3; variant++)
          for (let lod = 0; lod < 3; lod++)
            for (const geometry of (await source(variant, lod)).values()) {
              const entry = {
                geometry,
                snapshot: geometryState(geometry),
                disposed: 0,
              };
              geometry.addEventListener("dispose", () => {
                entry.disposed++;
              });
              sources.push(entry);
            }
        for (let variant = 0; variant < 3; variant++)
          expect(await track(pool.add(variant, `tree-${variant}`))).toBe(true);
        const meshes = pool.meshes();
        expect(meshes).toHaveLength(kind === "single" ? 18 : 6);
        for (const mesh of meshes)
          expect(
            sources.some((entry) => entry.geometry === mesh.geometry),
          ).toBe(false);
        for (const lod of [0, 1, 2, 0] as const) {
          pool.update(lod);
          const rows = activeRows(pool);
          expect(rows).toHaveLength(6);
          for (const row of rows) {
            const variant = Math.round((row.matrix.elements[12] - 10) / 10);
            verifyRow(row, variant, lod, kind);
            expect(row.matrix.elements[13]).toBeCloseTo(
              2 + (kind === "single" ? -base(variant) * 1.25 : 0),
            );
          }
          for (let variant = 0; variant < 3; variant++) {
            const proxy = pool.proxy(`tree-${variant}`);
            expect(proxy).not.toBeNull();
            const expected = [...(await source(variant, 2)).values()];
            expect(proxy!.geometries).toHaveLength(2);
            for (const geometry of proxy!.geometries) {
              expect(expected).toContain(geometry);
              expect(geometry.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
            }
          }
        }
        const disposals = new Map<
          THREE.BufferGeometry | THREE.Material,
          number
        >();
        for (const mesh of meshes)
          for (const owned of [
            mesh.geometry,
            mesh.material as THREE.Material,
          ]) {
            if (disposals.has(owned)) continue;
            disposals.set(owned, 0);
            owned.addEventListener("dispose", () =>
              disposals.set(owned, disposals.get(owned)! + 1),
            );
          }
        pool.destroy();
        expect(pool.meshes()).toHaveLength(0);
        for (const count of disposals.values()) expect(count).toBe(1);
        for (const entry of sources) {
          expect(entry.disposed).toBe(0);
          expect(geometryState(entry.geometry)).toEqual(entry.snapshot);
        }
      });
    }, 15_000);

    it(`${kind}: depletion, dense-slot removal/reuse and LOD migration preserve wind metadata and per-instance state`, async () => {
      await withTrees(kind, async ({ pool, track }) => {
        for (let index = 0; index < 3; index++)
          expect(
            await track(pool.add(0, `slot-${index}`, 10 + index * 10)),
          ).toBe(true);
        pool.deplete("slot-2", 1);
        pool.remove("slot-0");
        for (const lod of [0, 1, 2] as const) {
          pool.update(lod);
          const rows = activeRows(pool);
          expect(rows).toHaveLength(4);
          for (const row of rows) {
            verifyRow(row, 0, lod, kind);
            expect(row.dissolve).toBeCloseTo(
              row.matrix.elements[12] === 30 ? GPU_VEG_CONFIG.DISSOLVE_MAX : 0,
              5,
            );
          }
        }
        pool.update(0);
        expect(await track(pool.add(0, "replacement", 40))).toBe(true);
        pool.deplete("slot-2", -1);
        pool.update(0);
        const rows = activeRows(pool);
        expect(rows).toHaveLength(6);
        expect(new Set(rows.map((row) => row.matrix.elements[12]))).toEqual(
          new Set([20, 30, 40]),
        );
        for (const row of rows) {
          verifyRow(row, 0, 0, kind);
          expect(row.dissolve).toBeCloseTo(0, 5);
        }
        for (const id of ["slot-1", "slot-2", "replacement"]) pool.remove(id);
        expect(activeRows(pool)).toHaveLength(0);
      });
    }, 15_000);

    it(`${kind}: pending/live mode changes reject atomically and teardown restores the legacy default`, async () => {
      await withTrees(
        kind,
        async ({ pool, requested, release, track }) => {
          const add = track(pool.add(0, "pending"));
          await requested;
          expect(() => pool.init("legacy-leaf-v1")).toThrow(
            /requires.*teardown/,
          );
          const otherWorld = newWorld(),
            otherOwner = new TreePool(kind, otherWorld, pool.urls);
          try {
            expect(() => otherOwner.init("connected-v1")).toThrow(
              /requires.*teardown/,
            );
          } finally {
            otherWorld.destroy();
          }
          release();
          expect(await add).toBe(true);
          expect(() => pool.init("legacy-leaf-v1")).toThrow(
            /requires.*teardown/,
          );
          const liveOtherWorld = newWorld();
          try {
            expect(() =>
              new TreePool(kind, liveOtherWorld, pool.urls).init(
                "connected-v1",
              ),
            ).toThrow(/requires.*teardown/);
          } finally {
            liveOtherWorld.destroy();
          }
          expect(pool.has("pending")).toBe(true);
          for (const mesh of pool.meshes())
            expect((mesh.material as TreeDissolveMaterial).treeWind.mode).toBe(
              "connected-v1",
            );
          pool.destroy();
          pool.init();
          expect(await track(pool.add(0, "legacy"))).toBe(true);
          for (const mesh of pool.meshes()) {
            expect((mesh.material as TreeDissolveMaterial).treeWind.mode).toBe(
              "legacy-leaf-v1",
            );
            expect(mesh.geometry.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
          }
        },
        { heldPath: "/a.glb" },
      );
    }, 15_000);

    it(`${kind}: invalid untokenized replacement preserves both pending and inserted actors`, async () => {
      await withTrees(
        kind,
        async ({ pool, requested, release, track }) => {
          const pending = track(pool.add(0, "owner"));
          await requested;
          expect(await track(pool.add(0, "owner", 40, undefined, -1))).toBe(
            false,
          );
          release();
          expect(await pending).toBe(true);
          const original = activeRows(pool).map((row) => [
            ...row.matrix.elements,
          ]);
          expect(await track(pool.add(0, "owner", 50, undefined, 0))).toBe(
            false,
          );
          expect(pool.has("owner")).toBe(true);
          expect(
            activeRows(pool).map((row) => [...row.matrix.elements]),
          ).toEqual(original);
        },
        { heldPath: "/a.glb" },
      );
    }, 15_000);

    it(`${kind}: full destination cannot erase a replacement's original actor; same-full-pool replacement keeps its slot`, async () => {
      await withTrees(kind, async ({ pool, track }) => {
        expect(await track(pool.add(0, "original", 10))).toBe(true);
        const target = new TreePool(
          kind,
          pool.world,
          pool.urls,
          "full-destination",
        );
        for (let index = 0; index < 512; index++)
          expect(await track(target.add(1, `full-${index}`, 20))).toBe(true);
        expect(await track(target.add(1, "original", 30))).toBe(false);
        expect(pool.has("original")).toBe(true);
        const originalRows = activeRows(pool).filter(
          (row) => row.matrix.elements[12] === 10,
        );
        expect(originalRows).toHaveLength(2);
        for (const row of originalRows) verifyRow(row, 0, 0, kind);
        expect(await track(target.add(1, "full-0", 21))).toBe(true);
        const rows = activeRows(pool);
        expect(rows).toHaveLength(1026);
        expect(
          rows.filter((row) => row.matrix.elements[12] === 21),
        ).toHaveLength(2);
      });
    }, 15_000);

    it(`${kind}: a late connected LOD cannot publish into or contaminate a successor legacy pool`, async () => {
      await withTrees(
        kind,
        async ({ pool, requested, release, track }) => {
          const stale = track(pool.add(0, "retired"));
          await requested;
          expect(pool.meshes()).toHaveLength(0);
          pool.destroy();
          const successorWorld = newWorld(),
            successor = new TreePool(kind, successorWorld, pool.urls);
          try {
            successor.init();
            const next = track(successor.add(0, "successor"));
            release();
            expect(await stale).toBe(false);
            expect(await next).toBe(true);
            expect(pool.meshes()).toHaveLength(0);
            expect(successor.has("retired")).toBe(false);
            expect(successor.has("successor")).toBe(true);
            expect(successor.meshes()).toHaveLength(6);
            for (const mesh of successor.meshes()) {
              expect(
                (mesh.material as TreeDissolveMaterial).treeWind.mode,
              ).toBe("legacy-leaf-v1");
              expect(mesh.geometry.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(
                false,
              );
            }
          } finally {
            successor.destroy();
            successorWorld.destroy();
          }
        },
        { heldPath: "/a_lod1.glb" },
      );
    }, 15_000);
  }

  for (const missing of [[1, 2], [2]]) {
    it(`batched: missing MIDDLE variant LODs ${missing.join(",")} never shift geometry identity or collision proxies`, async () => {
      await withTrees(
        "batched",
        async ({ pool, track, source }) => {
          for (let variant = 0; variant < 3; variant++)
            expect(await track(pool.add(variant, `variant-${variant}`))).toBe(
              true,
            );
          for (const requestedLod of [0, 1, 2, 0] as const) {
            pool.update(requestedLod);
            const rows = activeRows(pool);
            expect(rows).toHaveLength(6);
            for (const row of rows) {
              const variant = Math.round((row.matrix.elements[12] - 10) / 10);
              let actualLod: number = requestedLod;
              while (variant === 1 && missing.includes(actualLod)) actualLod--;
              verifyRow(row, variant, actualLod, "batched");
            }
          }
          for (let variant = 0; variant < 3; variant++) {
            let proxyLod = 2;
            while (variant === 1 && missing.includes(proxyLod)) proxyLod--;
            const expected = [...(await source(variant, proxyLod)).values()];
            const proxy = pool.proxy(`variant-${variant}`);
            expect(proxy).not.toBeNull();
            for (const geometry of proxy!.geometries)
              expect(expected).toContain(geometry);
          }
        },
        { missingMiddleLods: missing },
      );
    }, 15_000);
  }
});
