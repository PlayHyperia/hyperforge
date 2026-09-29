import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import THREE from "../../../extras/three/three";
import { ClientLoader } from "../../../systems/client/ClientLoader";
import {
  EntityType,
  InteractionType,
  NPCType,
  type NPCEntityConfig,
} from "../../../types/entities";
import { modelCache } from "../../../utils/rendering/ModelCache";
import { NPCEntity } from "../NPCEntity";

const assets = new URL("../../../../../server/world/assets/", import.meta.url);
const sourceFiles = {
  glb: "trees/mushroom.glb",
  vrm: "avatars/duel-candidates/duel-kaykit-knight.vrm",
  // Real image-free GLB through the real avatar parser/factory's supported
  // static fallback. Textured/skinned VRM rendering remains a native gate.
  avatarFallback: "trees/mushroom.glb",
  skinnedGlb: "models/mobs/goblin/goblin_rigged.glb",
} as const;

function cpuSkinnedFixture(source: Buffer): Buffer {
  const jsonLength = source.readUInt32LE(12);
  const original: {
    materials: Record<string, unknown>[];
    skins: unknown[];
    animations: unknown[];
  } = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  const fixture = structuredClone(original);
  const stripMaterialTextures = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      const record = value as Record<string, unknown>;
      if (key.endsWith("Texture")) delete record[key];
      else stripMaterialTextures(record[key]);
    }
  };
  // Node has no image decoder. Change only material texture references in this
  // in-memory CPU fixture, never the resident asset. Native uses the original.
  stripMaterialTextures(fixture.materials);
  expect(fixture.materials).not.toEqual(original.materials);
  expect({ ...fixture, materials: undefined }).toEqual({
    ...original,
    materials: undefined,
  });
  expect(fixture.skins.length).toBeGreaterThan(0);
  expect(fixture.animations.length).toBeGreaterThan(0);
  const json = Buffer.from(JSON.stringify(fixture));
  const padded = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const binary = source.subarray(20 + jsonLength);
  const header = Buffer.from(source.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12);
  const result = Buffer.concat([header, padded, binary]);
  expect(result.subarray(20 + result.readUInt32LE(12))).toEqual(binary);
  return result;
}

function config(id: string, model: string): NPCEntityConfig {
  return {
    id,
    name: "Lifetime clerk",
    type: EntityType.NPC,
    position: { x: 2, y: 0, z: 3 },
    rotation: new THREE.Quaternion(),
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: InteractionType.TALK,
    interactionDistance: 2,
    description: "Real loader lifecycle regression",
    model,
    npcType: NPCType.BANK,
    npcId: "bank_clerk",
    dialogueLines: ["Hello"],
    services: ["bank"],
    inventory: [],
    skillsOffered: [],
    questsAvailable: [],
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      npcComponent: {
        behavior: "friendly",
        state: "idle",
        currentTarget: null,
        spawnPoint: { x: 2, y: 0, z: 3 },
        wanderRadius: 0,
        aggroRange: 0,
        isHostile: false,
        combatLevel: 0,
        aggressionLevel: 0,
        dialogueLines: ["Hello"],
        dialogue: null,
        services: ["bank"],
      },
      dialogue: ["Hello"],
      shopInventory: [],
      questGiver: false,
    },
  };
}

// Real production loader and real resident assets. The HTTP response, not a
// replacement loader/promise, holds the fetch open until after NPC destruction.
async function withPendingAsset(
  kind: keyof typeof sourceFiles,
  verify: (fixture: {
    world: World;
    loader: ClientLoader;
    url: string;
    requested: Promise<void>;
    release: (status?: number) => void;
    create: (id: string) => NPCEntity;
  }) => Promise<void>,
): Promise<void> {
  const source = readFileSync(new URL(sourceFiles[kind], assets));
  const bytes = kind === "skinnedGlb" ? cpuSkinnedFixture(source) : source;
  const responses: ServerResponse[] = [];
  const npcs: NPCEntity[] = [];
  let signalRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    signalRequest = resolve;
  });
  let status: number | undefined;
  const respond = (response: ServerResponse) => {
    response.writeHead(status ?? 200, { "Content-Type": "model/gltf-binary" });
    response.end(status === 404 ? "Missing fixture asset" : bytes);
  };
  const server = createServer((_request, response) => {
    responses.push(response);
    signalRequest();
    if (status !== undefined) respond(response);
  });
  const world = new World();
  world.register("loader", ClientLoader);
  const loader = world.getSystem("loader");
  if (!(loader instanceof ClientLoader)) throw new Error("Missing real loader");
  let url = "";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    url = `http://127.0.0.1:${address.port}/lifetime.${kind === "avatarFallback" ? "vrm" : kind === "skinnedGlb" ? "glb" : kind}`;
    await verify({
      world,
      loader,
      url,
      requested,
      release(nextStatus = 200) {
        status = nextStatus;
        for (const response of responses) {
          if (!response.writableEnded) respond(response);
        }
      },
      create(id) {
        const npc = new NPCEntity(world, config(id, url));
        npcs.push(npc);
        return npc;
      },
    });
  } finally {
    for (const npc of npcs) npc.destroy();
    status ??= 404;
    for (const response of responses) {
      if (!response.writableEnded) respond(response);
    }
    await Promise.allSettled(loader.promises.values());
    modelCache.remove(url);
    world.destroy();
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function expectRetired(npc: NPCEntity, world: World): void {
  expect(npc.destroyed).toBe(true);
  expect(npc.mesh === null).toBe(true);
  expect(npc.node.parent).toBeNull();
  expect(npc.node.children).toHaveLength(0);
  expect(world.hot.has(npc)).toBe(false);
  expect(npc["_avatarInstance"]).toBeNull();
  expect(npc["_raycastProxy"]).toBeNull();
  expect("mixer" in npc ? npc.mixer : undefined).toBeUndefined();
  const owned: THREE.Object3D[] = [];
  world.stage.scene.traverse((node) => {
    if (node.userData.entityId === npc.id) owned.push(node);
  });
  expect(owned).toHaveLength(0);
}

describe("NPCEntity real pending model lifetime", () => {
  for (const kind of ["glb", "vrm"] as const) {
    // Successful textured VRM factory/mixer publication is qualified in the
    // native browser with the same real cached-load/remove/re-add sequence.
    // Node has no image decoder; do not replace it with a fabricated loader.
    if (kind === "glb")
      it(`does not publish a late ${kind} result and preserves a living shared-load replacement`, async () => {
        await withPendingAsset(kind, async (f) => {
          const retired = f.create(`retired-${kind}`);
          const loading = retired.init();
          await f.requested;
          const proxy = retired["_raycastProxy"];
          if (!proxy || Array.isArray(proxy.material))
            throw new Error("Missing proxy");
          expect(proxy.parent).toBe(f.world.stage.scene);
          let proxyGeometryDisposals = 0;
          let proxyMaterialDisposals = 0;
          proxy.geometry.addEventListener(
            "dispose",
            () => proxyGeometryDisposals++,
          );
          proxy.material.addEventListener(
            "dispose",
            () => proxyMaterialDisposals++,
          );
          retired.destroy();
          const living = f.create(`living-${kind}`);
          const replacement = living.init();
          f.release();
          await Promise.all([loading, replacement]);
          expectRetired(retired, f.world);
          expect(living.mesh).not.toBeNull();
          expect(f.world.hot.has(living)).toBe(true);
          expect(living["_raycastProxy"]?.parent).toBe(f.world.stage.scene);
          expect(living.mesh?.parent).toBe(living.node);
          expect(modelCache.has(f.url)).toBe(true);
          let sharedDisposals = 0;
          living.mesh?.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) return;
            node.geometry.addEventListener("dispose", () => sharedDisposals++);
            const materials = Array.isArray(node.material)
              ? node.material
              : [node.material];
            for (const material of materials) {
              material.addEventListener("dispose", () => sharedDisposals++);
            }
          });
          // A completed cache hit also yields at await; destruction in that
          // microtask window must not publish or register hot ownership either.
          const cached = f.create(`cached-${kind}`);
          const cachedLoading = cached.init();
          cached.destroy();
          await cachedLoading;
          expectRetired(cached, f.world);
          expect(sharedDisposals).toBe(0);
          expect(proxyGeometryDisposals).toBe(1);
          expect(proxyMaterialDisposals).toBe(1);
          expect(living.serialize()).toMatchObject({
            npcId: "bank_clerk",
            npcType: NPCType.BANK,
            services: ["bank"],
          });
          living.destroy();
          expect(f.world.hot.has(living)).toBe(false);
        });
      });

    it(`does not create a fallback or hot entry after a dead ${kind} load rejects`, async () => {
      await withPendingAsset(kind, async (f) => {
        const npc = f.create(`failed-${kind}`);
        const loading = npc.init();
        await f.requested;
        npc.destroy();
        f.release(404);
        await loading;
        expectRetired(npc, f.world);
        await npc.init();
        expectRetired(npc, f.world);
      });
    });

    it(`retains the living placeholder behavior after a real ${kind} fetch rejects`, async () => {
      await withPendingAsset(kind, async (f) => {
        const npc = f.create(`living-fallback-${kind}`);
        const loading = npc.init();
        await f.requested;
        f.release(404);
        await loading;
        expect(npc.destroyed).toBe(false);
        expect(npc.mesh instanceof THREE.Mesh).toBe(true);
        expect(npc.mesh?.parent).toBe(npc.node);
        expect(npc["_raycastProxy"]?.parent).toBe(f.world.stage.scene);
        expect(f.world.hot.has(npc)).toBe(true);
        npc.destroy();
        expect(f.world.hot.has(npc)).toBe(false);
      });
    });
  }
});

function firstMesh(scene: THREE.Object3D | null): THREE.Mesh {
  let found: THREE.Mesh | undefined;
  scene?.traverse((node) => {
    if (!found && node instanceof THREE.Mesh) found = node;
  });
  if (!found) throw new Error("Real parsed asset has no mesh");
  return found;
}

function singleMaterial(mesh: THREE.Mesh): THREE.Material {
  if (Array.isArray(mesh.material))
    throw new Error("Expected one source material");
  return mesh.material;
}

describe("NPCEntity loaded model resource ownership", () => {
  it("does not resume model acquisition after synchronous proxy-attachment retirement", async () => {
    await withPendingAsset("glb", async (f) => {
      const npc = f.create("proxy-attachment-retirement");
      const onAdded = (event: THREE.Object3DEventMap["childadded"]) => {
        if (event.child === npc["_raycastProxy"]) npc.destroy();
      };
      f.world.stage.scene.addEventListener("childadded", onAdded);
      try {
        await npc.init();
        expectRetired(npc, f.world);
        expect(f.loader.filePromises.size).toBe(0);
        expect(modelCache.has(f.url)).toBe(false);
      } finally {
        f.world.stage.scene.removeEventListener("childadded", onAdded);
      }
    });
  });

  it("releases only the real GLB clone skeleton and mixer while its peer remains animated", async () => {
    await withPendingAsset("skinnedGlb", async (f) => {
      const first = f.create("skinned-first");
      const loading = first.init();
      await f.requested;
      f.release();
      await loading;
      const second = f.create("skinned-second");
      await second.init();
      const firstModel = firstMesh(first.mesh);
      const secondModel = firstMesh(second.mesh);
      if (
        !(firstModel instanceof THREE.SkinnedMesh) ||
        !(secondModel instanceof THREE.SkinnedMesh)
      ) {
        throw new Error("Shipped goblin skin was not parsed");
      }
      const firstMixer = "mixer" in first ? first.mixer : undefined;
      const secondMixer = "mixer" in second ? second.mixer : undefined;
      if (
        !(firstMixer instanceof THREE.AnimationMixer) ||
        !(secondMixer instanceof THREE.AnimationMixer)
      ) {
        throw new Error("NPC did not create real GLB mixers");
      }
      const loaded = await modelCache.loadModel(f.url, f.world);
      try {
        expect(firstModel.skeleton === secondModel.skeleton).toBe(false);
        expect(firstModel.geometry === secondModel.geometry).toBe(true);
        expect(firstModel.material === secondModel.material).toBe(true);
        // CPU-only, before any renderer upload. Never resize boneMatrices by
        // calling computeBoneTexture on a live WebGPU-rendered skeleton.
        firstModel.skeleton.computeBoneTexture();
        secondModel.skeleton.computeBoneTexture();
        const firstTexture = firstModel.skeleton.boneTexture;
        const secondTexture = secondModel.skeleton.boneTexture;
        if (!firstTexture || !secondTexture)
          throw new Error("Missing bone textures");
        expect(firstTexture === secondTexture).toBe(false);
        let firstBones = 0;
        let secondBones = 0;
        let shared = 0;
        firstTexture.addEventListener("dispose", () => firstBones++);
        secondTexture.addEventListener("dispose", () => secondBones++);
        firstModel.geometry.addEventListener("dispose", () => shared++);
        singleMaterial(firstModel).addEventListener("dispose", () => shared++);
        // The original clip is walking, so production correctly leaves a
        // service NPC idle. Exercise its real mixer with that unchanged clip.
        firstMixer.clipAction(loaded.animations[0]).play();
        secondMixer.clipAction(loaded.animations[0]).play();
        expect(firstMixer.stats.actions.total).toBe(1);
        first.destroy();
        first.destroy();
        expect(firstBones).toBe(1);
        expect(secondBones).toBe(0);
        expect(shared).toBe(0);
        expect(firstModel.skeleton.boneTexture).toBeNull();
        expect(firstMixer.stats.actions.total).toBe(0);
        expect(firstMixer.stats.bindings.total).toBe(0);
        expect(secondMixer.stats.actions.inUse).toBe(1);
        secondMixer.update(0.1);
        expect(secondMixer.time).toBeCloseTo(0.1);
        expectRetired(first, f.world);
        second.destroy();
        expect(secondBones).toBe(1);
        expect(shared).toBe(0);
      } finally {
        loaded.scene.traverse((node) => {
          if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
        });
      }
    });
  });

  for (const kind of ["glb", "avatarFallback"] as const) {
    it(`preserves shared ${kind} geometry and disposes only instance-owned materials`, async () => {
      await withPendingAsset(kind, async (f) => {
        const first = f.create(`first-${kind}`);
        const loading = first.init();
        await f.requested;
        f.release();
        await loading;
        const second = f.create(`second-${kind}`);
        await second.init();
        const firstModel = firstMesh(first.mesh);
        const secondModel = firstMesh(second.mesh);
        const firstMaterial = singleMaterial(firstModel);
        const secondMaterial = singleMaterial(secondModel);
        expect(firstModel.geometry === secondModel.geometry).toBe(true);
        expect(firstMaterial === secondMaterial).toBe(kind === "glb");
        if (kind === "avatarFallback") {
          expect(first["_avatarInstance"] !== null).toBe(true);
          expect(second["_avatarInstance"] !== null).toBe(true);
        }
        const positions = Array.from(
          firstModel.geometry.attributes.position.array,
        );
        let geometryDisposed = 0;
        let firstMaterialDisposed = 0;
        let secondMaterialDisposed = 0;
        firstModel.geometry.addEventListener(
          "dispose",
          () => geometryDisposed++,
        );
        firstMaterial.addEventListener(
          "dispose",
          () => firstMaterialDisposed++,
        );
        secondMaterial.addEventListener(
          "dispose",
          () => secondMaterialDisposed++,
        );
        first.destroy();
        first.destroy();
        expect(geometryDisposed).toBe(0);
        expectRetired(first, f.world);
        expect(firstMaterialDisposed).toBe(kind === "glb" ? 0 : 1);
        expect(secondMaterialDisposed).toBe(0);
        expect(
          Array.from(secondModel.geometry.attributes.position.array),
        ).toEqual(positions);
        expect(f.world.hot.has(second)).toBe(true);
        // Cached consumers after retirement must inherit the same still-owned
        // geometry, not trigger a reload to repair an invalidated cache entry.
        const third = f.create(`third-${kind}`);
        await third.init();
        expect(firstMesh(third.mesh).geometry === secondModel.geometry).toBe(
          true,
        );
        second.destroy();
        third.destroy();
        expect(geometryDisposed).toBe(0);
        expect(secondMaterialDisposed).toBe(kind === "glb" ? 0 : 1);
        if (kind === "glb") {
          modelCache.remove(f.url);
          expect(geometryDisposed).toBe(1);
        }
      });
    });
  }

  it("disposes a living placeholder's own material and geometry once under reentrant destroy", async () => {
    await withPendingAsset("glb", async (f) => {
      const npc = f.create("placeholder-resource-owner");
      const loading = npc.init();
      await f.requested;
      f.release(404);
      await loading;
      const mesh = firstMesh(npc.mesh);
      const material = singleMaterial(mesh);
      let geometries = 0;
      let materials = 0;
      mesh.geometry.addEventListener("dispose", () => {
        geometries++;
        npc.destroy();
      });
      material.addEventListener("dispose", () => materials++);
      npc.destroy();
      npc.destroy();
      expectRetired(npc, f.world);
      expect(geometries).toBe(1);
      expect(materials).toBe(1);
    });
  });

  it("releases the new factory instance when scene attachment synchronously retires the NPC", async () => {
    await withPendingAsset("avatarFallback", async (f) => {
      const npc = f.create("factory-attachment-retirement");
      let entered = false;
      let geometries = 0;
      let materials = 0;
      const beforeItems = f.world.stage.octree.root.count;
      const onAdded = (event: THREE.Object3DEventMap["childadded"]) => {
        if (event.child.name.startsWith("NPC_RaycastProxy_") || entered) return;
        entered = true;
        const mesh = firstMesh(event.child);
        mesh.geometry.addEventListener("dispose", () => geometries++);
        singleMaterial(mesh).addEventListener("dispose", () => materials++);
        npc.destroy();
      };
      f.world.stage.scene.addEventListener("childadded", onAdded);
      try {
        const loading = npc.init();
        await f.requested;
        f.release();
        await loading;
        expect(entered).toBe(true);
        expectRetired(npc, f.world);
        expect(geometries).toBe(0);
        expect(materials).toBe(1);
        expect(f.world.stage.octree.root.count).toBe(beforeItems);
      } finally {
        f.world.stage.scene.removeEventListener("childadded", onAdded);
      }
    });
  });

  it("detaches a failed real GLB attachment before publishing its fallback", async () => {
    await withPendingAsset("glb", async (f) => {
      const npc = f.create("glb-attachment-failure");
      let failedClone: THREE.Object3D | undefined;
      let sharedDisposals = 0;
      const onAdded = (event: THREE.Object3DEventMap["childadded"]) => {
        if (failedClone) return;
        failedClone = event.child;
        const mesh = firstMesh(event.child);
        mesh.geometry.addEventListener("dispose", () => sharedDisposals++);
        singleMaterial(mesh).addEventListener(
          "dispose",
          () => sharedDisposals++,
        );
        throw new Error("Actual Object3D attachment listener failure");
      };
      npc.node.addEventListener("childadded", onAdded);
      try {
        const loading = npc.init();
        await f.requested;
        f.release();
        await loading;
        expect(failedClone !== undefined).toBe(true);
        expect(failedClone?.parent).toBeNull();
        expect(npc.node.children).toHaveLength(1);
        expect(npc.node.children[0] === npc.mesh).toBe(true);
        expect(npc.mesh !== failedClone).toBe(true);
        expect(sharedDisposals).toBe(0);
        expect(f.world.hot.has(npc)).toBe(true);
      } finally {
        npc.node.removeEventListener("childadded", onAdded);
      }
    });
  });

  it("finishes independent cleanup after a real proxy disposal listener throws", async () => {
    await withPendingAsset("avatarFallback", async (f) => {
      const npc = f.create("dispose-listener-failure");
      const loading = npc.init();
      await f.requested;
      f.release();
      await loading;
      const proxy = npc["_raycastProxy"];
      if (!proxy) throw new Error("Missing actual proxy");
      let first = true;
      let proxyMaterials = 0;
      let modelMaterials = 0;
      singleMaterial(proxy).addEventListener("dispose", () => proxyMaterials++);
      singleMaterial(firstMesh(npc.mesh)).addEventListener(
        "dispose",
        () => modelMaterials++,
      );
      proxy.geometry.addEventListener("dispose", () => {
        if (first) {
          first = false;
          throw new Error("Actual proxy disposal listener failure");
        }
      });
      expect(() => npc.destroy()).toThrow(
        "Actual proxy disposal listener failure",
      );
      expectRetired(npc, f.world);
      expect(proxy.parent).toBeNull();
      expect(proxyMaterials).toBe(1);
      expect(modelMaterials).toBe(1);
      npc.destroy();
      expect(proxyMaterials).toBe(1);
      expect(modelMaterials).toBe(1);
    });
  });
});
