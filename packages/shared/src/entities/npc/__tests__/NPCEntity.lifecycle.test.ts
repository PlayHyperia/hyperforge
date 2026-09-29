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
} as const;

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
  const bytes = readFileSync(new URL(sourceFiles[kind], assets));
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
    url = `http://127.0.0.1:${address.port}/lifetime.${kind}`;
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
