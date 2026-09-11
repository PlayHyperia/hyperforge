import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ClientLoader } from "../../../../systems/client/ClientLoader";
import { ResourceEntity } from "../../ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import { EventType } from "../../../../types/events";
import { modelCache } from "../../../../utils/rendering/ModelCache";
import * as instanced from "../../../../systems/shared/world/GLBTreeInstancer";
import * as batched from "../../../../systems/shared/world/GLBTreeBatchedInstancer";
import { GPU_VEG_CONFIG } from "../../../../systems/shared/world/GPUMaterials";
import { clearProxyGeometryCache } from "../TreeGLBVisualStrategy";

// Actual texture-free GLB parsed by ClientLoader + ModelCache + GLTFLoader.
// A delayed HTTP body, not a replaced loader/pool method, controls cold loading.
function treeGLB(): Buffer {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 2, 0]);
  const binary = Buffer.from(positions.buffer);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.2, 1] } },
      ],
      buffers: [{ byteLength: binary.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [-0.5, 0, 0],
          max: [0.5, 2, 0],
        },
      ],
    }),
  );
  const text = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + binary.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, binary]);
}

function resource(
  world: World,
  url: string,
  useBatch: boolean,
  id = "tree_1_1",
) {
  const entity = new ResourceEntity(world, {
    id,
    name: "Lifecycle tree",
    type: EntityType.RESOURCE,
    position: { x: 1, y: 0, z: 1 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 2,
    description: "Real GLB lifetime fixture",
    model: url,
    modelVariants: useBatch ? [url] : undefined,
    modelScale: 1,
    resourceType: ResourceType.TREE,
    resourceId: "tree_general",
    harvestSkill: "woodcutting",
    requiredLevel: 1,
    harvestTime: 3000,
    respawnTime: 0,
    harvestYield: [],
    depleted: false,
    lastHarvestTime: 0,
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      resourceType: ResourceType.TREE,
      harvestable: true,
      respawnTime: 0,
      toolRequired: "bronze_hatchet",
      skillRequired: "woodcutting",
      xpReward: 0,
    },
  });
  world.stage.scene.add(entity.node);
  return entity;
}

async function withColdTree(
  verify: (fixture: {
    world: World;
    url: string;
    requested: Promise<void>;
    release(): void;
    track<T>(operation: Promise<T>): Promise<T>;
    entities: ResourceEntity[];
  }) => Promise<void>,
  heldPath = "/tree.glb",
) {
  const bytes = treeGLB();
  const held: ServerResponse[] = [];
  const paths = new Set<string>();
  let released = false;
  let signal!: () => void;
  const requested = new Promise<void>((resolve) => {
    signal = resolve;
  });
  function respond(response: ServerResponse) {
    response.writeHead(200, { "Content-Type": "model/gltf-binary" });
    response.end(bytes);
  }
  const server = createServer((request, response) => {
    paths.add(request.url!);
    if (request.url === heldPath && !released) {
      held.push(response);
      signal();
    } else respond(response);
  });
  const world = new World();
  world.register("loader", ClientLoader);
  instanced.initGLBTreeInstancer(world.stage.scene, world);
  batched.initGLBTreeBatchedInstancer(world.stage.scene, world);
  const operations: Promise<unknown>[] = [];
  const entities: ResourceEntity[] = [];
  let base = "";
  const release = () => {
    released = true;
    for (const response of held.splice(0)) respond(response);
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    base = `http://127.0.0.1:${address.port}`;
    await verify({
      world,
      url: `${base}/tree.glb`,
      requested,
      release,
      entities,
      track<T>(operation: Promise<T>): Promise<T> {
        operations.push(operation);
        return operation;
      },
    });
  } finally {
    release();
    await Promise.allSettled(operations);
    for (const entity of entities) entity.destroy();
    instanced.destroyGLBTreeInstancer();
    batched.destroyGLBTreeBatchedInstancer();
    clearProxyGeometryCache();
    for (const path of paths) modelCache.remove(`${base}${path}`);
    world.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function poolMeshes(
  world: World,
  useBatch: boolean,
): Array<THREE.BatchedMesh | THREE.InstancedMesh> {
  return world.stage.scene.children.filter(
    (child): child is THREE.BatchedMesh | THREE.InstancedMesh =>
      useBatch
        ? child instanceof THREE.BatchedMesh
        : child instanceof THREE.InstancedMesh,
  );
}

function initialDissolve(world: World, useBatch: boolean): number {
  const mesh = poolMeshes(world, useBatch)[0];
  if (!mesh) throw new Error("No actual tree pool mesh");
  if (mesh instanceof THREE.InstancedMesh) {
    expect(mesh.count).toBe(1);
    return mesh.geometry.getAttribute("instanceDissolve").getX(0);
  }
  expect(mesh.instanceCount).toBe(1);
  const color = new THREE.Color();
  mesh.getColorAt(0, color);
  return 1 - color.b;
}

describe("real cold GLB resource visual lifetime", () => {
  for (const useBatch of [false, true]) {
    const label = useBatch ? "batched" : "instanced";
    const api = useBatch ? batched : instanced;

    it(`${label}: destroyed cold actor cannot insert, revive hot state, register interaction or remove its replacement`, async () => {
      await withColdTree(
        async ({ world, url, requested, release, track, entities }) => {
          const baseline = world.listenerCount(EventType.ENTITY_INTERACT);
          const old = resource(world, url, useBatch);
          entities.push(old);
          const oldInit = track(old.init());
          await requested;
          old.destroy();
          const next = resource(world, url, useBatch);
          entities.push(next);
          const nextInit = track(next.init());
          release();
          await Promise.all([oldInit, nextInit]);
          expect(old.destroyed).toBe(true);
          expect(old.mesh).toBeNull();
          expect(old.node.children).toHaveLength(0);
          expect(old.node.parent).toBeNull();
          expect(world.hot.has(old)).toBe(false);
          expect(world.hot.has(next)).toBe(true);
          expect(world.listenerCount(EventType.ENTITY_INTERACT)).toBe(
            baseline + 1,
          );
          expect(api.hasInstance(next.id)).toBe(true);
          expect(next.mesh?.name).toBe(`TreeProxy_${next.id}`);
          old.destroy();
          old.updateFromNetwork({ depleted: true });
          await old.init();
          expect(api.hasInstance(next.id)).toBe(true);
          expect(initialDissolve(world, useBatch)).toBe(0);
          next.destroy();
          expect(api.hasInstance(next.id)).toBe(false);
          expect(world.listenerCount(EventType.ENTITY_INTERACT)).toBe(baseline);
          expect(world.hot.has(next)).toBe(false);
        },
      );
    });

    for (const finalDepleted of [true, false]) {
      it(`${label}: pending authoritative depletion resolves atomically to ${finalDepleted}`, async () => {
        await withColdTree(
          async ({ world, url, requested, release, track, entities }) => {
            const entity = resource(world, url, useBatch);
            entities.push(entity);
            const loading = track(entity.init());
            await requested;
            entity.updateFromNetwork({ depleted: true });
            if (!finalDepleted) entity.updateFromNetwork({ depleted: false });
            release();
            await loading;
            expect(entity.config.depleted).toBe(finalDepleted);
            expect(initialDissolve(world, useBatch)).toBeCloseTo(
              finalDepleted ? GPU_VEG_CONFIG.DISSOLVE_MAX : 0,
              6,
            );
            expect(api.hasInstance(entity.id)).toBe(true);
          },
        );
      });
    }

    it(`${label}: exact pending and inserted token ownership; legacy add/remove remains supported`, async () => {
      await withColdTree(async ({ world, url, requested, release, track }) => {
        const a = { isCurrent: () => true, getInitialDissolve: () => 0 };
        const b = { isCurrent: () => true, getInitialDissolve: () => 0 };
        const add = (lifetime?: instanced.TreeInstanceLifetime) =>
          useBatch
            ? batched.addInstance(
                "general",
                [url],
                0,
                "same",
                new THREE.Vector3(),
                0,
                1,
                0,
                lifetime,
              )
            : instanced.addInstance(
                url,
                "same",
                new THREE.Vector3(),
                0,
                1,
                null,
                null,
                0,
                lifetime,
              );
        const first = track(add(a));
        await requested;
        const replacement = track(add(b));
        api.removeInstance("same", a);
        release();
        expect(await first).toBe(false);
        expect(await replacement).toBe(true);
        expect(api.hasInstance("same", a)).toBe(false);
        expect(api.hasInstance("same", b)).toBe(true);
        api.removeInstance("same", a);
        expect(api.hasInstance("same", b)).toBe(true);
        api.removeInstance("same", b);
        expect(api.hasInstance("same")).toBe(false);
        expect(await add()).toBe(true);
        expect(initialDissolve(world, useBatch)).toBe(0);
        api.removeInstance("same");
        expect(api.hasInstance("same")).toBe(false);
      });
    });

    for (const heldPath of ["/tree.glb", "/tree_lod1.glb", "/tree_lod2.glb"]) {
      it(`${label}: world retirement during ${heldPath} cannot publish or erase a successor pool`, async () => {
        await withColdTree(
          async ({ world, url, requested, release, track }) => {
            const add = (id: string) =>
              useBatch
                ? batched.addInstance(
                    "general",
                    [url],
                    0,
                    id,
                    new THREE.Vector3(),
                    0,
                    1,
                  )
                : instanced.addInstance(url, id, new THREE.Vector3(), 0, 1);
            const old = track(add("retired"));
            await requested;
            expect(poolMeshes(world, useBatch)).toHaveLength(0);
            if (useBatch) batched.destroyGLBTreeBatchedInstancer();
            else instanced.destroyGLBTreeInstancer();
            const successor = new World();
            successor.register("loader", ClientLoader);
            try {
              if (useBatch)
                batched.initGLBTreeBatchedInstancer(
                  successor.stage.scene,
                  successor,
                );
              else
                instanced.initGLBTreeInstancer(
                  successor.stage.scene,
                  successor,
                );
              const next = track(add("successor"));
              release();
              expect(await old).toBe(false);
              const sibling = track(add("sibling"));
              expect(await next).toBe(true);
              expect(await sibling).toBe(true);
              expect(api.hasInstance("retired")).toBe(false);
              expect(api.hasInstance("successor")).toBe(true);
              expect(api.hasInstance("sibling")).toBe(true);
              expect(poolMeshes(world, useBatch)).toHaveLength(0);
              // Exactly one shared pool with all three real parsed LODs, not two
              // overlapping pools after a stale pendingEnsure finally callback.
              expect(poolMeshes(successor, useBatch)).toHaveLength(3);
            } finally {
              if (useBatch) batched.destroyGLBTreeBatchedInstancer();
              else instanced.destroyGLBTreeInstancer();
              successor.destroy();
            }
          },
          heldPath,
        );
      });
    }

    it(`${label}: actor teardown disposes private proxy material, never borrowed proxy/pool geometry`, async () => {
      await withColdTree(async ({ world, url, release, track, entities }) => {
        release();
        const first = resource(world, url, useBatch, "tree_1_1");
        const second = resource(world, url, useBatch, "tree_2_1");
        entities.push(first, second);
        await track(Promise.all([first.init(), second.init()]));
        expect(first.mesh).toBeInstanceOf(THREE.Mesh);
        expect(second.mesh).toBeInstanceOf(THREE.Mesh);
        const firstProxy = first.mesh as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.Material
        >;
        const secondProxy = second.mesh as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.Material
        >;
        expect(firstProxy.geometry).toBe(secondProxy.geometry);
        let geometryDisposals = 0;
        let materialDisposals = 0;
        let poolDisposals = 0;
        firstProxy.geometry.addEventListener("dispose", () => {
          geometryDisposals++;
        });
        firstProxy.material.addEventListener("dispose", () => {
          materialDisposals++;
        });
        for (const mesh of poolMeshes(world, useBatch))
          mesh.geometry.addEventListener("dispose", () => {
            poolDisposals++;
          });
        first.destroy();
        first.destroy();
        expect(materialDisposals).toBe(1);
        expect(geometryDisposals).toBe(0);
        expect(poolDisposals).toBe(0);
        expect(firstProxy.parent).toBeNull();
        expect(first.mesh).toBeNull();
        expect(secondProxy.parent).toBe(second.node);
        expect(api.hasInstance(second.id)).toBe(true);
        second.destroy();
        expect(geometryDisposals).toBe(0);
        clearProxyGeometryCache();
        expect(geometryDisposals).toBe(1);
      });
    });
  }
});
