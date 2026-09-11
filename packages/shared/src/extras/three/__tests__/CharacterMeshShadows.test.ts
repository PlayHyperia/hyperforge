// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { VRM, VRMHumanoid } from "@pixiv/three-vrm";
import * as THREE from "../three";
import {
  applyCharacterMeshShadowPolicy,
  isCharacterShadowCandidateActive,
} from "../CharacterMeshShadows";
import { prepareVRMMaterialsForWebGPU } from "../createVRMFactory";
import {
  attachEquipmentVisualToVRM,
  cloneEquipmentVisualModel,
  disposeEquipmentVisualMaterials,
  removeEquipmentVisual,
  type EquipmentVisualStore,
} from "../../../systems/client/EquipmentVisualHelpers";

// Actual DOM routing, Three meshes/materials/bones and VRM attachment. These
// CPU ownership controls do not prove rendered self-shadows, bias or GPU cost.
const releases: Array<() => void> = [];
afterEach(() => {
  window.history.replaceState(null, "", "/");
  for (const release of releases.splice(0).reverse()) release();
});

function candidate() {
  window.history.replaceState(
    null,
    "",
    "/stream.html?streamRenderProfile=shadows-720p60-v1",
  );
}

function mesh(material: THREE.Material | THREE.Material[]) {
  const geometry = new THREE.BoxGeometry(0.2, 0.4, 0.2);
  const object = new THREE.Mesh(geometry, material);
  releases.push(() => {
    geometry.dispose();
    for (const entry of new Set(
      Array.isArray(object.material) ? object.material : [object.material],
    ))
      entry.dispose();
  });
  return object;
}

function actor() {
  const scene = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "hips";
  const hand = new THREE.Bone();
  hand.name = "rightHand";
  scene.add(hips);
  hips.add(hand);
  const vrm = new VRM({
    scene,
    humanoid: new VRMHumanoid({
      hips: { node: hips },
      rightHand: { node: hand },
    }),
    meta: {
      metaVersion: "1",
      name: "shadow-policy-control",
      authors: ["test"],
      licenseUrl: "",
    },
  });
  const visuals: EquipmentVisualStore = {};
  releases.push(() => {
    for (const slot of Object.keys(visuals))
      removeEquipmentVisual(visuals, slot);
  });
  return { vrm, visuals, hips, hand };
}

describe("explicit character shadow candidate", () => {
  it("uses the existing validated route/profile contract without promoting defaults", () => {
    for (const path of [
      "/",
      "/stream.html",
      "/stream.html?streamRenderProfile=canonical-720p60-v1",
      "/stream.html?streamRenderProfile=fallback-720p30-v1",
    ]) {
      window.history.replaceState(null, "", path);
      expect(isCharacterShadowCandidateActive()).toBe(false);
    }
    candidate();
    expect(isCharacterShadowCandidateActive()).toBe(true);
    window.history.replaceState(
      null,
      "",
      "/?page=stream&streamRenderProfile=shadows-720p60-v1",
    );
    expect(isCharacterShadowCandidateActive()).toBe(true);
    for (const path of [
      "/?embedded=true&mode=spectator&streamRenderProfile=shadows-720p60-v1",
      "/stream.html?streamRenderProfile=shadows-720p60-v1&streamFps=30",
      "/stream.html?streamRenderProfile=shadows-720p60-v1&streamRenderProfile=canonical-720p60-v1",
    ]) {
      window.history.replaceState(null, "", path);
      expect(() => isCharacterShadowCandidateActive()).toThrow();
    }
  });

  it("retains all ordinary mesh flags, including legacy avatar casting", () => {
    const object = mesh(new THREE.MeshStandardMaterial());
    for (const cast of [false, true])
      for (const receive of [false, true]) {
        object.castShadow = cast;
        object.receiveShadow = receive;
        applyCharacterMeshShadowPolicy(object, false);
        expect([object.castShadow, object.receiveShadow]).toEqual([
          cast,
          receive,
        ]);
      }
    prepareVRMMaterialsForWebGPU(object);
    expect([object.castShadow, object.receiveShadow]).toEqual([true, false]);
  });

  it("admits opaque PBR and alpha-cutout surfaces without touching material state", () => {
    for (const material of [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshPhysicalMaterial({ metalness: 0.84, roughness: 0.3 }),
      new THREE.MeshStandardNodeMaterial(),
      new THREE.MeshPhysicalNodeMaterial(),
      new THREE.MeshStandardMaterial({ transparent: true, alphaTest: 0.5 }),
      new THREE.MeshStandardMaterial({ blending: THREE.NoBlending }),
    ]) {
      const object = mesh(material);
      const before = material.toJSON();
      const geometry = object.geometry;
      const version = material.version;
      applyCharacterMeshShadowPolicy(object, true);
      expect([object.castShadow, object.receiveShadow]).toEqual([true, true]);
      applyCharacterMeshShadowPolicy(object, true);
      expect(object.material).toBe(material);
      expect(object.geometry).toBe(geometry);
      expect(material.version).toBe(version);
      expect(material.toJSON()).toEqual(before);
    }
  });

  it("excludes transmissive, blended, unlit and overlay meshes rather than casting solid silhouettes", () => {
    for (const material of [
      new THREE.MeshPhysicalMaterial({ transmission: 1 }),
      new THREE.MeshStandardMaterial({ transparent: true }),
      new THREE.MeshStandardMaterial({
        opacity: 0.5,
        transparent: true,
        alphaTest: 0.2,
      }),
      new THREE.MeshStandardMaterial({ depthWrite: false }),
      new THREE.MeshStandardMaterial({ depthTest: false }),
      new THREE.MeshStandardMaterial({ colorWrite: false }),
      new THREE.MeshStandardMaterial({ visible: false }),
      new THREE.MeshStandardMaterial({ blending: THREE.AdditiveBlending }),
      new THREE.MeshBasicMaterial(),
      new THREE.ShaderMaterial(),
    ]) {
      const object = mesh(material);
      object.castShadow = object.receiveShadow = true;
      applyCharacterMeshShadowPolicy(object, true);
      expect([object.castShadow, object.receiveShadow]).toEqual([false, false]);
    }
    const mixed = mesh([
      new THREE.MeshStandardMaterial(),
      new THREE.MeshPhysicalMaterial({ transmission: 1 }),
    ]);
    applyCharacterMeshShadowPolicy(mixed, true);
    expect([mixed.castShadow, mixed.receiveShadow]).toEqual([false, false]);
  });

  it("applies after actual avatar conversion while preserving geometry, transforms and cornea properties", () => {
    candidate();
    const skin = mesh(
      new THREE.MeshStandardMaterial({ color: 0xdeb997, roughness: 0.7 }),
    );
    const cornea = mesh(
      new THREE.MeshPhysicalMaterial({
        transmission: 1,
        depthWrite: false,
        ior: 1.376,
      }),
    );
    const root = new THREE.Group();
    root.add(skin, cornea);
    root.position.set(3, 4, 5);
    root.rotation.set(0.1, 0.2, 0.3);
    root.updateMatrixWorld(true);
    const matrix = root.matrixWorld.clone();
    const vertices = Array.from(skin.geometry.attributes.position.array);
    prepareVRMMaterialsForWebGPU(root);
    expect([skin.castShadow, skin.receiveShadow]).toEqual([true, true]);
    expect([cornea.castShadow, cornea.receiveShadow]).toEqual([false, false]);
    expect(skin.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(cornea.material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
    expect(skin.material).toMatchObject({ roughness: 0.7 });
    expect(cornea.material).toMatchObject({
      transmission: 1,
      depthWrite: false,
      ior: 1.376,
    });
    expect(root.matrixWorld).toEqual(matrix);
    expect(Array.from(skin.geometry.attributes.position.array)).toEqual(
      vertices,
    );
  });

  it("attaches early/late held gear with physical shadows, preserving source templates and overlays", () => {
    candidate();
    const a = actor();
    const source = new THREE.Group();
    source.add(
      mesh(
        new THREE.MeshStandardMaterial({ color: 0x916238, metalness: 0.84 }),
      ),
      mesh(
        new THREE.MeshStandardMaterial({
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    source.userData.hyperia = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: new THREE.Matrix4().toArray(),
    };
    for (let i = 0; i < 2; i++) {
      const model = cloneEquipmentVisualModel(source);
      releases.push(() => disposeEquipmentVisualMaterials(model));
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting: { mode: "authored-scene" },
        }),
      ).toBe(true);
      const [solid, effect] = model.children;
      expect([solid.castShadow, solid.receiveShadow]).toEqual([true, true]);
      expect([effect.castShadow, effect.receiveShadow]).toEqual([false, false]);
      expect(model.parent).toBe(a.visuals.weapon);
      expect(model.parent?.name).toBe("EquipmentWrapper");
      expect(model.parent?.parent).toBe(a.hand);
      expect(model.parent?.matrix.toArray()).toEqual(
        new THREE.Matrix4().toArray(),
      );
      expect((solid as THREE.Mesh).geometry).toBe(
        (source.children[0] as THREE.Mesh).geometry,
      );
      expect((solid as THREE.Mesh).material).not.toBe(
        (source.children[0] as THREE.Mesh).material,
      );
      expect((solid as THREE.Mesh).material).toMatchObject({ metalness: 0.84 });
      expect(
        source.children.every(
          (child) => !child.castShadow && !child.receiveShadow,
        ),
      ).toBe(true);
    }
  });

  it("preserves real skin attributes, avatar skeleton/bind matrices and attachment cleanup", () => {
    candidate();
    const a = actor();
    const geometry = new THREE.BoxGeometry();
    const count = geometry.attributes.position.count;
    const indices = new THREE.Uint16BufferAttribute(
      new Uint16Array(count * 4),
      4,
    );
    const weights = new THREE.Float32BufferAttribute(
      new Float32Array(count * 4),
      4,
    );
    for (let i = 0; i < count; i++) weights.setX(i, 1);
    geometry.setAttribute("skinIndex", indices);
    geometry.setAttribute("skinWeight", weights);
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.8,
      roughness: 0.4,
    });
    const skeleton = new THREE.Skeleton([a.hips, a.hand]);
    releases.push(() => {
      geometry.dispose();
      material.dispose();
      skeleton.dispose();
    });
    const body = new THREE.SkinnedMesh(geometry, material);
    body.bind(skeleton);
    a.vrm.scene.add(body);
    const source = new THREE.Group();
    source.add(body.clone());
    const rigidTrim = mesh(new THREE.MeshStandardMaterial());
    source.add(rigidTrim);
    const model = cloneEquipmentVisualModel(source);
    releases.push(() => disposeEquipmentVisualMaterials(model));
    const gear = model.children[0] as THREE.SkinnedMesh;
    const bind = gear.bindMatrix.clone();
    expect(
      attachEquipmentVisualToVRM({
        slot: "body",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-scene" },
      }),
    ).toBe(true);
    expect([gear.castShadow, gear.receiveShadow]).toEqual([true, true]);
    expect([
      model.children[1].castShadow,
      model.children[1].receiveShadow,
    ]).toEqual([true, true]);
    expect(rigidTrim.castShadow).toBe(false);
    expect(gear.skeleton).toBe(skeleton);
    expect(gear.bindMatrix).toEqual(bind);
    expect(gear.geometry).toBe(geometry);
    expect(gear.geometry.attributes.skinIndex).toBe(indices);
    expect(gear.geometry.attributes.skinWeight).toBe(weights);
    expect(model.parent).toBe(a.vrm.scene);
    expect([body.castShadow, body.receiveShadow]).toEqual([false, false]);
    removeEquipmentVisual(a.visuals, "body");
    expect(model.parent).toBeNull();
    expect(body.skeleton).toBe(skeleton);
    expect(body.geometry).toBe(geometry);
  });
});
