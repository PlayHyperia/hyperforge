import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { VRM, VRMHumanoid } from "@pixiv/three-vrm";
import { GLTFLoader } from "../../../libs/gltfloader/GLTFLoader";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { World } from "../../../core/World";
import { Entity } from "../../../entities/Entity";
import { EventType } from "../../../types/events";
import { EquipmentVisualSystem } from "../EquipmentVisualSystem";
import { NeutralShortsWearState } from "../NeutralShortsWearState";
import {
  attachEquipmentVisualToVRM,
  type EquipmentVisualStore,
} from "../EquipmentVisualHelpers";

// Small authored scene fixtures use real Three meshes, VRM, GLTF parser,
// World/Entity and equipment lifecycle. No rendering or asset-fit approval is
// implied by these deterministic state/structural tests.
const resources: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.dispose();
});

function skin(name: string, skeleton: THREE.Skeleton): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(new Uint16Array(12), 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const material = new THREE.MeshStandardMaterial();
  resources.push(geometry, material);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.bind(skeleton);
  return mesh;
}

function avatar() {
  const scene = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "hips";
  scene.add(hips);
  const skeleton = new THREE.Skeleton([hips]);
  resources.push(skeleton);
  const body = skin("TestBody", skeleton);
  body.userData.hyperiaAvatarSurface = "body";
  const shorts = skin("TestNeutralShorts", skeleton);
  shorts.userData.hyperiaAvatarSurface = "neutral-shorts";
  scene.add(body, shorts);
  scene.userData.hyperiaNeutralClothing = {
    schemaVersion: 1,
    shortsMeshName: shorts.name,
    bodyMeshNames: [body.name],
  };
  const vrm = new VRM({
    scene,
    humanoid: new VRMHumanoid({ hips: { node: hips } }),
    meta: {
      metaVersion: "1",
      name: "wear-state-fixture",
      authors: ["test"],
      licenseUrl: "",
    },
  });
  return { vrm, body, shorts, skeleton };
}

async function legs(
  a: ReturnType<typeof avatar>,
  itemId = "test_legs",
  complete = true,
) {
  const gltf = await new GLTFLoader().parseAsync(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [] }],
    }),
    "",
  );
  const model = skin("TestLegClothing", a.skeleton);
  gltf.scene.add(model);
  gltf.scene.userData.hyperia = {
    vrmBoneName: "hips",
    duelFit: {
      schemaVersion: 1,
      itemId,
      slot: "legs",
      compatibleAvatarIds: ["bandit"],
      rigFingerprint: "a".repeat(64),
    },
    ...(complete
      ? {
          clothingReplacement: {
            schemaVersion: 1,
            coverage: "waist-to-ankles",
            replaces: "neutral-shorts",
          },
        }
      : {}),
  };
  return gltf;
}

function commit(
  state: NeutralShortsWearState,
  a: ReturnType<typeof avatar>,
  gltf: GLTF,
  playerId = "p",
  itemId = "test_legs",
) {
  state.commit({
    playerId,
    modelRoot: gltf.scene,
    slot: "legs",
    itemId,
    avatarId: "bandit",
    vrm: a.vrm,
  });
}

describe("explicit neutral shorts replacement", () => {
  it("hides only the verified separate shorts after attachment and restores exactly", async () => {
    const a = avatar();
    const gltf = await legs(a);
    const state = new NeutralShortsWearState();
    resources.push(state);
    commit(state, a, gltf);
    expect(a.shorts.visible).toBe(true); // Loaded but not attached.
    const visuals: EquipmentVisualStore = {};
    expect(
      attachEquipmentVisualToVRM({
        slot: "legs",
        modelRoot: gltf.scene,
        visuals,
        vrm: a.vrm,
      }),
    ).toBe(true);
    const geometry = a.body.geometry;
    const weights = Array.from(geometry.attributes.skinWeight.array);
    commit(state, a, gltf);
    expect(a.shorts.visible).toBe(false);
    expect(a.body.visible).toBe(true);
    expect(a.body.geometry).toBe(geometry);
    expect(Array.from(geometry.attributes.skinWeight.array)).toEqual(weights);
    state.clear("p");
    state.clear("p");
    expect(a.shorts.visible).toBe(true);
    a.shorts.visible = false;
    commit(state, a, gltf);
    state.dispose();
    expect(a.shorts.visible).toBe(false); // Original visibility, not forced on.
  });

  it.each([
    "partial",
    "unknown-coverage",
    "missing-shorts",
    "missing-body",
    "duplicate-name",
    "wrong-role",
    "body-as-shorts",
    "nonleaf",
    "missing-avatar-contract",
    "invalid-fit",
    "wrong-avatar",
    "equipment-impersonation",
    "hidden-model",
    "hidden-skin",
  ])(
    "fails closed for %s without hiding body or arbitrary meshes",
    async (failure) => {
      const a = avatar();
      const gltf = await legs(a, "test_legs", failure !== "partial");
      a.vrm.scene.add(gltf.scene);
      const contract = a.vrm.scene.userData.hyperiaNeutralClothing;
      if (failure === "unknown-coverage")
        gltf.scene.userData.hyperia.clothingReplacement.coverage = "knees";
      if (failure === "missing-shorts") a.shorts.removeFromParent();
      if (failure === "missing-body") a.body.removeFromParent();
      if (failure === "duplicate-name") a.vrm.scene.add(a.shorts.clone());
      if (failure === "wrong-role")
        a.shorts.userData.hyperiaAvatarSurface = "body";
      if (failure === "body-as-shorts") contract.shortsMeshName = a.body.name;
      if (failure === "nonleaf") a.shorts.add(a.body);
      if (failure === "missing-avatar-contract")
        delete a.vrm.scene.userData.hyperiaNeutralClothing;
      if (failure === "invalid-fit")
        delete gltf.scene.userData.hyperia.duelFit.rigFingerprint;
      if (failure === "wrong-avatar")
        gltf.scene.userData.hyperia.duelFit.compatibleAvatarIds = ["other"];
      if (failure === "equipment-impersonation") gltf.scene.add(a.shorts);
      if (failure === "hidden-model") gltf.scene.visible = false;
      if (failure === "hidden-skin") gltf.scene.children[0].visible = false;
      const state = new NeutralShortsWearState();
      commit(state, a, gltf);
      expect(a.shorts.visible).toBe(true);
      expect(a.body.visible).toBe(true);
      expect(state.retains("p", gltf.scene, a.vrm)).toBe(false);
      state.dispose();
    },
  );

  it("isolates two avatars and restores both when disposed", async () => {
    const first = avatar();
    const second = avatar();
    const one = await legs(first);
    const two = await legs(second);
    first.vrm.scene.add(one.scene);
    second.vrm.scene.add(two.scene);
    const state = new NeutralShortsWearState();
    commit(state, first, one, "one");
    commit(state, second, two, "two");
    expect(first.shorts.visible).toBe(false);
    expect(second.shorts.visible).toBe(false);
    state.clear("one");
    expect(first.shorts.visible).toBe(true);
    expect(second.shorts.visible).toBe(false);
    state.dispose();
    expect(second.shorts.visible).toBe(true);
    expect(first.body.visible && second.body.visible).toBe(true);
  });
});

type SystemAccess = {
  handleEquipmentChange(data: {
    playerId: string;
    slot: string;
    itemId: string | null;
  }): Promise<void>;
  cleanupPlayerEquipment(playerId: string): void;
  invalidatePlayerVisualAttachments(playerId: string): void;
  weaponCache: Map<string, GLTF>;
  weaponLoadPromises: Map<string, Promise<GLTF | null>>;
  playerEquipment: Map<string, EquipmentVisualStore>;
  attachedEquipmentItemIds: Map<string, Map<string, string>>;
  desiredEquipmentItemIds: Map<string, Map<string, string | null>>;
  eventSubscriptions: Set<unknown>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function systemFixture() {
  const a = avatar();
  const world = new World();
  const entity = new Entity(world, {
    id: "p",
    type: "player",
    name: "Test",
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  });
  const player = Object.assign(entity, {
    avatarUrl: "asset://avatars/duel-candidates/duel-bandit.vrm",
    avatar: {
      instance: { raw: { scene: a.vrm.scene, userData: { vrm: a.vrm } } },
    },
  });
  world.entities.items.set("p", player);
  const system = new EquipmentVisualSystem(world);
  resources.push({ dispose: () => system.destroy() });
  const access = system as unknown as SystemAccess;
  const equip = (itemId: string | null) =>
    access.handleEquipmentChange({ playerId: "p", slot: "legs", itemId });
  const cache = (id: string, gltf: GLTF) =>
    access.weaponCache.set(`bandit\0${id}`, gltf);
  const wait = (id: string) => {
    const pending = deferred<GLTF | null>();
    access.weaponLoadPromises.set(`bandit\0${id}`, pending.promise);
    return pending;
  };
  return { ...a, world, player, system, access, equip, cache, wait };
}

describe("equipment lifecycle clothing transactions", () => {
  it("replays both slots on the real avatar-load event after an old material listener fails", async () => {
    const f = systemFixture();
    await f.system.init();
    f.cache("replacement-legs", await legs(f, "replacement-legs"));
    const sourceBoots = await legs(f, "replacement-boots", false);
    sourceBoots.scene.userData.hyperia.duelFit.slot = "boots";
    f.cache("replacement-boots", sourceBoots);
    await f.equip("replacement-legs");
    await f.access.handleEquipmentChange({
      playerId: "p",
      slot: "boots",
      itemId: "replacement-boots",
    });
    const oldLegs = f.access.playerEquipment.get("p")!.legs!;
    const oldBoots = f.access.playerEquipment.get("p")!.boots!;
    const oldMaterial = (oldLegs.children[0] as THREE.SkinnedMesh)
      .material as THREE.Material;
    const oldBootMaterial = (oldBoots.children[0] as THREE.SkinnedMesh)
      .material as THREE.Material;
    let bootDisposals = 0;
    oldMaterial.addEventListener("dispose", () => {
      throw new Error("intentional replaced-avatar material failure");
    });
    oldBootMaterial.addEventListener("dispose", () => bootDisposals++);
    const replacement = avatar();
    f.player.avatar.instance.raw = {
      scene: replacement.vrm.scene,
      userData: { vrm: replacement.vrm },
    };
    f.world.$eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
      playerId: "p",
      success: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(oldLegs.parent).toBe(null);
    expect(oldBoots.parent).toBe(null);
    expect(bootDisposals).toBe(1);
    const current = f.access.playerEquipment.get("p")!;
    expect(current.legs?.parent).toBe(replacement.vrm.scene);
    expect(current.boots?.parent).toBe(replacement.vrm.scene);
    expect(f.access.attachedEquipmentItemIds.get("p")?.get("legs")).toBe(
      "replacement-legs",
    );
    expect(f.access.attachedEquipmentItemIds.get("p")?.get("boots")).toBe(
      "replacement-boots",
    );
    expect(f.shorts.visible).toBe(true);
    expect(replacement.shorts.visible).toBe(false);
    expect(f.body.visible && replacement.body.visible).toBe(true);
  });

  it("tears down other players and real event subscriptions after a material listener failure", async () => {
    const f = systemFixture();
    await f.system.init();
    const neighbor = avatar();
    const other = new Entity(f.world, {
      id: "other",
      type: "player",
      name: "Other",
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
    });
    Object.assign(other, {
      avatarUrl: f.player.avatarUrl,
      avatar: {
        instance: {
          raw: { scene: neighbor.vrm.scene, userData: { vrm: neighbor.vrm } },
        },
      },
    });
    f.world.entities.items.set("other", other);
    f.cache("first-player", await legs(f, "first-player"));
    f.cache("other-player", await legs(neighbor, "other-player"));
    await f.equip("first-player");
    await f.access.handleEquipmentChange({
      playerId: "other",
      slot: "legs",
      itemId: "other-player",
    });
    const first = f.access.playerEquipment.get("p")!.legs!;
    const second = f.access.playerEquipment.get("other")!.legs!;
    const material = (first.children[0] as THREE.SkinnedMesh)
      .material as THREE.Material;
    const nextMaterial = (second.children[0] as THREE.SkinnedMesh)
      .material as THREE.Material;
    let nextDisposals = 0;
    material.addEventListener("dispose", () => {
      throw new Error("intentional first-player disposal failure");
    });
    nextMaterial.addEventListener("dispose", () => nextDisposals++);
    expect(f.access.eventSubscriptions.size).toBeGreaterThan(0);
    expect(() => f.system.destroy()).toThrow(AggregateError);
    expect(nextDisposals).toBe(1);
    expect(first.parent).toBe(null);
    expect(second.parent).toBe(null);
    expect(f.access.playerEquipment.size).toBe(0);
    expect(f.access.eventSubscriptions.size).toBe(0);
    expect(f.shorts.visible && neighbor.shorts.visible).toBe(true);
    expect(f.body.visible && neighbor.body.visible).toBe(true);
    expect(() => f.system.destroy()).not.toThrow();
    expect(nextDisposals).toBe(1);
  });

  it.each(["cleanup", "avatar-change", "destroy"])(
    "finishes every slot and clears ownership when a material listener throws during %s",
    async (mode) => {
      const f = systemFixture();
      const sourceLegs = await legs(f, "failing-listener-legs");
      const sourceBoots = await legs(f, "remaining-boots", false);
      sourceBoots.scene.userData.hyperia.duelFit.slot = "boots";
      f.cache("failing-listener-legs", sourceLegs);
      f.cache("remaining-boots", sourceBoots);
      await f.equip("failing-listener-legs");
      await f.access.handleEquipmentChange({
        playerId: "p",
        slot: "boots",
        itemId: "remaining-boots",
      });
      const equipment = f.access.playerEquipment.get("p")!;
      const first = equipment.legs!;
      const second = equipment.boots!;
      const firstMaterial = (first.children[0] as THREE.SkinnedMesh)
        .material as THREE.Material;
      const secondMaterial = (second.children[0] as THREE.SkinnedMesh)
        .material as THREE.Material;
      let firstDisposals = 0;
      let secondDisposals = 0;
      firstMaterial.addEventListener("dispose", () => {
        firstDisposals++;
        throw new Error("intentional real material listener failure");
      });
      secondMaterial.addEventListener("dispose", () => secondDisposals++);
      const cleanup = () => {
        if (mode === "cleanup") f.access.cleanupPlayerEquipment("p");
        else if (mode === "avatar-change")
          f.access.invalidatePlayerVisualAttachments("p");
        else f.system.destroy();
      };
      expect(cleanup).toThrow(AggregateError);
      expect(firstDisposals).toBe(1);
      expect(secondDisposals).toBe(1);
      expect(first.parent).toBe(null);
      expect(second.parent).toBe(null);
      expect(f.access.playerEquipment.has("p")).toBe(false);
      expect(f.access.attachedEquipmentItemIds.has("p")).toBe(false);
      expect(f.shorts.visible).toBe(true);
      expect(f.body.visible).toBe(true);
      expect(cleanup).not.toThrow();
      expect([firstDisposals, secondDisposals]).toEqual([1, 1]);
    },
  );

  it("keeps shared templates and a neighboring system intact through material replacement and unequip", async () => {
    const first = systemFixture();
    const neighbor = systemFixture();
    const source = await legs(first, "shared");
    const sourceMesh = source.scene.children[0] as THREE.SkinnedMesh;
    const sourceMaterial = sourceMesh.material as THREE.MeshStandardMaterial;
    const map = new THREE.DataTexture(new Uint8Array([90, 60, 30, 255]), 1, 1);
    resources.push(map);
    sourceMaterial.map = map;
    sourceMaterial.metalness = 0.84;
    let sourceDisposals = 0;
    let geometryDisposals = 0;
    let textureDisposals = 0;
    sourceMaterial.addEventListener("dispose", () => sourceDisposals++);
    sourceMesh.geometry.addEventListener("dispose", () => geometryDisposals++);
    map.addEventListener("dispose", () => textureDisposals++);
    first.cache("shared", source);
    neighbor.cache("shared", source);
    await first.equip("shared");
    await neighbor.equip("shared");
    const firstVisual = first.access.playerEquipment.get("p")!.legs!;
    const neighborVisual = neighbor.access.playerEquipment.get("p")!.legs!;
    const firstMaterial = (firstVisual.children[0] as THREE.SkinnedMesh)
      .material as THREE.MeshStandardMaterial;
    const neighborMaterial = (neighborVisual.children[0] as THREE.SkinnedMesh)
      .material as THREE.MeshStandardMaterial;
    expect(firstMaterial).not.toBe(sourceMaterial);
    expect(neighborMaterial).not.toBe(sourceMaterial);
    expect(firstMaterial).not.toBe(neighborMaterial);
    expect(firstMaterial.map).toBe(map);
    expect(neighborMaterial.map).toBe(map);
    expect(firstMaterial.metalness).toBe(0); // Existing policy, not a PBR pass.
    expect(sourceMaterial.metalness).toBe(0.84);
    let firstDisposals = 0;
    let neighborDisposals = 0;
    firstMaterial.addEventListener("dispose", () => firstDisposals++);
    neighborMaterial.addEventListener("dispose", () => neighborDisposals++);
    const next = await legs(first, "next");
    first.cache("next", next);
    await first.equip("next");
    expect(firstDisposals).toBe(1);
    expect(firstVisual.parent).toBe(null);
    const nextVisual = first.access.playerEquipment.get("p")!.legs!;
    const nextMaterial = (nextVisual.children[0] as THREE.SkinnedMesh)
      .material as THREE.Material;
    let nextDisposals = 0;
    nextMaterial.addEventListener("dispose", () => nextDisposals++);
    await first.equip(null);
    await first.equip(null);
    expect(nextDisposals).toBe(1);
    expect(firstDisposals).toBe(1);
    expect(neighborDisposals).toBe(0);
    expect(neighborVisual.parent).toBe(neighbor.vrm.scene);
    expect(neighbor.shorts.visible).toBe(false);
    expect(first.shorts.visible).toBe(true);
    expect([sourceDisposals, geometryDisposals, textureDisposals]).toEqual([
      0, 0, 0,
    ]);
    expect(sourceMaterial.metalness).toBe(0.84);
  });

  it.each(["cleanup", "avatar-change", "destroy", "missing-avatar-unequip"])(
    "releases private materials once on %s without disposing avatar skin resources",
    async (mode) => {
      const f = systemFixture();
      const source = await legs(f, "owned");
      const sourceMaterial = (source.scene.children[0] as THREE.SkinnedMesh)
        .material as THREE.Material;
      let sourceDisposals = 0;
      sourceMaterial.addEventListener("dispose", () => sourceDisposals++);
      f.skeleton.computeBoneTexture();
      const boneTexture = f.skeleton.boneTexture!;
      let skeletonTextureDisposals = 0;
      boneTexture.addEventListener("dispose", () => skeletonTextureDisposals++);
      f.cache("owned", source);
      await f.equip("owned");
      const attached = f.access.playerEquipment.get("p")!.legs!;
      const material = (attached.children[0] as THREE.SkinnedMesh)
        .material as THREE.Material;
      expect(material).not.toBe(sourceMaterial);
      let instanceDisposals = 0;
      material.addEventListener("dispose", () => instanceDisposals++);
      for (let i = 0; i < 2; i++) {
        if (mode === "cleanup") f.access.cleanupPlayerEquipment("p");
        else if (mode === "avatar-change")
          f.access.invalidatePlayerVisualAttachments("p");
        else if (mode === "destroy") f.system.destroy();
        else {
          f.world.entities.items.delete("p");
          await f.equip(null);
        }
      }
      expect(instanceDisposals).toBe(1);
      expect(sourceDisposals).toBe(0);
      expect(skeletonTextureDisposals).toBe(0);
      expect(f.skeleton.boneTexture).toBe(boneTexture);
      expect(attached.parent).toBe(null);
      expect(f.shorts.visible).toBe(true);
      expect(f.body.visible).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps per-slot avatar ownership during a cross-slot swap (early duplicate legs: %s)",
    async (duplicateBeforeReady) => {
      const f = systemFixture();
      await f.system.init();
      f.cache("complete", await legs(f, "complete"));
      await f.equip("complete");
      const oldLegs = f.access.playerEquipment.get("p")?.legs;
      const replacement = avatar();
      f.player.avatar.instance.raw = {
        scene: replacement.vrm.scene,
        userData: { vrm: replacement.vrm },
      };
      const boots = await legs(replacement, "new_boots", false);
      boots.scene.userData.hyperia.duelFit.slot = "boots";
      f.cache("new_boots", boots);
      await f.access.handleEquipmentChange({
        playerId: "p",
        slot: "boots",
        itemId: "new_boots",
      });
      const attachedBoots = f.access.playerEquipment.get("p")?.boots;
      expect(attachedBoots?.parent).toBe(replacement.vrm.scene);
      f.system.setStreamingDuelEquipmentVisualContract({
        cycleId: "cross-slot-avatar",
        requirements: [],
        currentEquipment: [{ playerId: "p", slot: "legs", itemId: "complete" }],
      });
      expect(f.system.getStreamingDuelEquipmentVisualReadiness().ready).toBe(
        false,
      );
      if (duplicateBeforeReady) {
        await f.equip("complete");
        expect(f.access.playerEquipment.get("p")?.legs?.parent).toBe(
          replacement.vrm.scene,
        );
        expect(oldLegs?.parent).toBe(null);
      }
      f.world.$eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
        playerId: "p",
        success: true,
      });
      await Promise.resolve();
      const currentLegs = f.access.playerEquipment.get("p")?.legs;
      expect(currentLegs?.parent).toBe(replacement.vrm.scene);
      expect(oldLegs?.parent).toBe(null);
      expect(f.access.playerEquipment.get("p")?.boots).toBe(attachedBoots);
      expect(f.shorts.visible).toBe(true);
      expect(replacement.shorts.visible).toBe(false);
      expect(f.body.visible && replacement.body.visible).toBe(true);
      expect(f.system.getStreamingDuelEquipmentVisualReadiness().ready).toBe(
        true,
      );
      await f.equip("complete");
      expect(f.access.playerEquipment.get("p")?.legs).toBe(currentLegs);
      await f.equip(null);
      expect(replacement.shorts.visible).toBe(true);
    },
  );

  it.each([true, false])(
    "refreshes complete clothing after hidden-avatar readiness, preserving shorts baseline %s",
    async (originalVisibility) => {
      const f = systemFixture();
      await f.system.init();
      f.shorts.visible = originalVisibility;
      f.vrm.scene.visible = false;
      f.cache("complete", await legs(f, "complete"));
      await f.equip("complete");
      const attached = f.access.playerEquipment.get("p")?.legs;
      expect(attached?.parent).toBe(f.vrm.scene);
      expect(f.shorts.visible).toBe(originalVisibility);
      f.vrm.scene.visible = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        f.world.$eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
          playerId: "p",
          success: true,
        });
        await Promise.resolve();
        expect(f.shorts.visible).toBe(false);
        expect(f.access.playerEquipment.get("p")?.legs).toBe(attached);
      }
      f.vrm.scene.visible = false;
      await f.equip("complete");
      expect(f.shorts.visible).toBe(false); // Existing lease survives ancestor hiding.
      f.vrm.scene.visible = true;
      await f.equip(null);
      expect(f.shorts.visible).toBe(originalVisibility);
      expect(f.body.visible).toBe(true);
    },
  );

  it.each(["model", "skin"])(
    "does not qualify a hidden %s when its avatar becomes ready",
    async (hidden) => {
      const f = systemFixture();
      await f.system.init();
      f.vrm.scene.visible = false;
      const garment = await legs(f, "complete");
      (hidden === "model" ? garment.scene : garment.scene.children[0]).visible =
        false;
      f.cache("complete", garment);
      await f.equip("complete");
      f.vrm.scene.visible = true;
      f.world.$eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
        playerId: "p",
        success: true,
      });
      await Promise.resolve();
      await f.equip("complete");
      expect(f.shorts.visible).toBe(true);
      expect(f.body.visible).toBe(true);
    },
  );

  it("keeps shorts during loading/failure, then hides only after the ready attachment", async () => {
    const f = systemFixture();
    const pending = f.wait("first");
    const load = f.equip("first");
    expect(f.shorts.visible).toBe(true);
    pending.resolve(null);
    await load;
    expect(f.shorts.visible).toBe(true);
    f.cache("ready", await legs(f, "ready"));
    await f.equip("ready");
    expect(f.shorts.visible).toBe(false);
    expect(f.access.attachedEquipmentItemIds.get("p")?.get("legs")).toBe(
      "ready",
    );
    f.system.setStreamingDuelEquipmentVisualContract({
      cycleId: "wear-state",
      requirements: [],
      currentEquipment: [{ playerId: "p", slot: "legs", itemId: "ready" }],
    });
    expect(f.system.getStreamingDuelEquipmentVisualReadiness().ready).toBe(
      true,
    );
    await f.equip(null);
    expect(f.shorts.visible).toBe(true);
    expect(f.body.visible).toBe(true);
  });

  it.each([
    "missing-model",
    "rejected-load",
    "bad-skeleton",
    "bad-partial-skeleton",
    "invalid-fit",
  ])("retains old complete clothing on %s", async (failure) => {
    const f = systemFixture();
    f.cache("old", await legs(f, "old"));
    await f.equip("old");
    const old = f.access.playerEquipment.get("p")?.legs;
    const pending = f.wait("new");
    const load = f.equip("new");
    expect(old?.parent).toBe(f.vrm.scene);
    expect(f.shorts.visible).toBe(false);
    if (failure === "rejected-load")
      pending.reject(new Error("expected load failure"));
    else if (failure === "bad-skeleton" || failure === "bad-partial-skeleton") {
      const bad = await legs(f, "new", failure !== "bad-partial-skeleton");
      const badBone = new THREE.Bone();
      badBone.name = "wrong";
      const badSkeleton = new THREE.Skeleton([badBone]);
      resources.push(badSkeleton);
      (bad.scene.children[0] as THREE.SkinnedMesh).bind(badSkeleton);
      pending.resolve(bad);
    } else if (failure === "invalid-fit") {
      const bad = await legs(f, "new");
      delete bad.scene.userData.hyperia.duelFit.rigFingerprint;
      pending.resolve(bad);
    } else pending.resolve(null);
    await load;
    expect(f.access.playerEquipment.get("p")?.legs).toBe(old);
    expect(f.access.attachedEquipmentItemIds.get("p")?.get("legs")).toBe("old");
    expect(f.access.desiredEquipmentItemIds.get("p")?.get("legs")).toBe("new");
    expect(f.shorts.visible).toBe(false);
    expect(f.body.visible).toBe(true);
    f.system.setStreamingDuelEquipmentVisualContract({
      cycleId: "failed-swap",
      requirements: [],
      currentEquipment: [{ playerId: "p", slot: "legs", itemId: "new" }],
    });
    expect(f.system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
      ready: false,
      attachmentMismatches: [
        {
          playerId: "p",
          slot: "legs",
          itemId: "new",
          desiredItemId: "new",
          attachedItemId: "old",
        },
      ],
    });
  });

  it("atomically swaps complete clothing and restores shorts for partial coverage", async () => {
    const f = systemFixture();
    f.cache("old", await legs(f, "old"));
    await f.equip("old");
    const old = f.access.playerEquipment.get("p")?.legs;
    f.cache("new", await legs(f, "new"));
    await f.equip("new");
    expect(old?.parent).toBe(null);
    expect(f.shorts.visible).toBe(false);
    f.cache("partial", await legs(f, "partial", false));
    await f.equip("partial");
    expect(f.shorts.visible).toBe(true);
    expect(f.body.visible).toBe(true);
  });

  it("does not let a late load hide shorts after unequip", async () => {
    const f = systemFixture();
    const pending = f.wait("late");
    const load = f.equip("late");
    await f.equip(null);
    pending.resolve(await legs(f, "late"));
    await load;
    expect(f.shorts.visible).toBe(true);
    expect(f.access.playerEquipment.get("p")?.legs).toBeUndefined();
  });

  it("keeps the newest request when a prior swap finishes last", async () => {
    const f = systemFixture();
    f.cache("old", await legs(f, "old"));
    await f.equip("old");
    const pending = f.wait("late");
    const load = f.equip("late");
    f.cache("partial", await legs(f, "partial", false));
    await f.equip("partial");
    pending.resolve(await legs(f, "late"));
    await load;
    expect(f.access.attachedEquipmentItemIds.get("p")?.get("legs")).toBe(
      "partial",
    );
    expect(f.shorts.visible).toBe(true);
  });

  it("does not reuse a stale request token after cleanup and same-ID rejoin", async () => {
    const f = systemFixture();
    const stale = f.wait("same");
    const oldLoad = f.equip("same");
    f.access.cleanupPlayerEquipment("p");
    const current = f.wait("same");
    const newLoad = f.equip("same");
    const newModel = await legs(f, "same");
    newModel.scene.name = "current";
    current.resolve(newModel);
    await newLoad;
    const attached = f.access.playerEquipment.get("p")?.legs;
    expect(attached?.name).toBe("current");
    const staleModel = await legs(f, "same");
    staleModel.scene.name = "stale";
    stale.resolve(staleModel);
    await oldLoad;
    expect(f.access.playerEquipment.get("p")?.legs).toBe(attached);
    expect(f.shorts.visible).toBe(false);
  });

  it.each(["cleanup", "avatar-change", "destroy", "missing-avatar-unequip"])(
    "restores on %s and rejects stale completion",
    async (mode) => {
      const f = systemFixture();
      f.cache("old", await legs(f, "old"));
      await f.equip("old");
      const pending = f.wait("late");
      const load = f.equip("late");
      if (mode === "cleanup") {
        f.access.cleanupPlayerEquipment("p");
        // Same player ID and same desired item must not revive the old request.
        const repeat = f.equip("late");
        pending.resolve(null);
        await repeat;
      } else if (mode === "avatar-change") {
        f.access.invalidatePlayerVisualAttachments("p");
        const replacement = avatar();
        f.player.avatar.instance.raw = {
          scene: replacement.vrm.scene,
          userData: { vrm: replacement.vrm },
        };
      } else if (mode === "destroy") f.system.destroy();
      else {
        f.world.entities.items.delete("p");
        await f.equip(null);
      }
      expect(f.shorts.visible).toBe(true);
      pending.resolve(await legs(f, "late"));
      await load;
      expect(f.shorts.visible).toBe(true);
      expect(f.body.visible).toBe(true);
      expect(f.access.playerEquipment.get("p")?.legs).toBeUndefined();
    },
  );
});
