import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ClientLoader } from "../../../client/ClientLoader";
import { modelCache } from "../../../../utils/rendering/ModelCache";
import * as single from "../GLBTreeInstancer";
import * as batched from "../GLBTreeBatchedInstancer";
import { GPU_VEG_CONFIG, type TreeDissolveMaterial } from "../GPUMaterials";
import { getLODDistances } from "../LODConfig";
import { TREE_WIND_ATTRIBUTE, type TreeWindMode } from "../TreeWind";

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
function treeGLB(variant: number, lod: number): Buffer {
  const order: Part[] = (variant + lod) % 2 ? ["leaf", "bark"] : [...parts];
  const positions = order.map((part) => authoredPositions(variant, lod, part));
  const chunks = positions.map((values) =>
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
        primitives: [{ attributes: { POSITION: index }, material: index }],
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
      accessors: positions.map((values, bufferView) => ({
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
  init(mode?: TreeWindMode) {
    const options = mode ? { windMode: mode } : undefined;
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
  } = {},
) {
  const files = new Map<string, Buffer>();
  for (let variant = 0; variant < 3; variant++)
    for (let lod = 0; lod < 3; lod++) {
      if (variant === 1 && options.missingMiddleLods?.includes(lod)) continue;
      files.set(pathFor(variant, lod), treeGLB(variant, lod));
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
    pool.init(options.mode ?? "connected-v1");
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
