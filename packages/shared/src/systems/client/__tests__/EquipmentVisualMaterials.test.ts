import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { VRM, VRMHumanoid } from "@pixiv/three-vrm";
import {
  attachEquipmentVisualToVRM,
  cloneEquipmentVisualModel,
  disposeEquipmentVisualMaterials,
  isolateEquipmentVisualMaterials,
  removeEquipmentVisual,
  type EquipmentVisualLighting,
  type EquipmentVisualStore,
} from "../EquipmentVisualHelpers";

// Real Three/VRM objects and disposal events. These ownership controls do not
// substitute for authored-asset rendering or a complete game lifecycle test.
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});

function template() {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.02, 0.1, 0.02);
  const texture = new THREE.Texture();
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0x916238,
    metalness: 0.84,
    roughness: 0.3,
    ior: 1.5,
    map: texture,
    normalMap: texture,
  });
  const leather = new THREE.MeshStandardMaterial({
    metalness: 0,
    roughness: 0.7,
  });
  root.add(new THREE.Mesh(geometry, metal));
  root.add(new THREE.Mesh(geometry, [metal, leather, metal]));
  root.userData.hyperia = {
    version: 2,
    vrmBoneName: "rightHand",
    relativeMatrix: new THREE.Matrix4().toArray(),
  };
  cleanup.push(() => {
    geometry.dispose();
    texture.dispose();
    metal.dispose();
    leather.dispose();
  });
  return { root, geometry, texture, metal, leather };
}

function privateClone(source: THREE.Object3D) {
  const clone = cloneEquipmentVisualModel(source);
  cleanup.push(() => disposeEquipmentVisualMaterials(clone));
  return clone;
}

function firstMaterial(root: THREE.Object3D): THREE.MeshPhysicalMaterial {
  return (root.children[0] as THREE.Mesh)
    .material as THREE.MeshPhysicalMaterial;
}

function disposalCounter(
  material: THREE.Material | THREE.Texture | THREE.BufferGeometry,
) {
  let count = 0;
  material.addEventListener("dispose", () => count++);
  return () => count;
}

function avatar() {
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
      name: "material-owner-control",
      authors: ["test"],
      licenseUrl: "",
    },
  });
  const visuals: EquipmentVisualStore = {};
  cleanup.push(() => {
    for (const slot of Object.keys(visuals))
      removeEquipmentVisual(visuals, slot);
  });
  return { vrm, hand, hips, visuals };
}

describe("equipment-instance material ownership", () => {
  it("inherits the live scene environment for early and late equipment without private maps", () => {
    const source = template();
    source.metal.metalnessMap = source.texture;
    source.metal.roughnessMap = source.texture;
    const sourceEnvironment = new THREE.Texture();
    const earlyEnvironment = new THREE.Texture();
    const lateEnvironment = new THREE.Texture();
    cleanup.push(() => {
      sourceEnvironment.dispose();
      earlyEnvironment.dispose();
      lateEnvironment.dispose();
    });
    source.metal.envMap = sourceEnvironment;
    source.metal.envMapIntensity = 0.4;
    const sourceDisposals = disposalCounter(source.metal);
    const textureDisposals = disposalCounter(source.texture);
    const environmentDisposals = [
      sourceEnvironment,
      earlyEnvironment,
      lateEnvironment,
    ].map(disposalCounter);
    const stage = new THREE.Scene();
    const actors = [avatar(), avatar()];
    actors.forEach((actor) => stage.add(actor.vrm.scene));
    const early = privateClone(source.root);
    const waiting = privateClone(source.root);
    stage.environment = earlyEnvironment;
    stage.environmentIntensity = 0.7;
    const earlyMaterial = firstMaterial(early);
    const cacheCallback = earlyMaterial.customProgramCacheKey;
    const cacheDescriptor = Object.getOwnPropertyDescriptor(
      earlyMaterial,
      "customProgramCacheKey",
    );
    const earlyDisposals = disposalCounter(earlyMaterial);
    const attach = (model: THREE.Object3D, index: number) =>
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...actors[index],
        lighting: { mode: "authored-scene" },
      });

    expect(attach(early, 0)).toBe(true);
    const version = earlyMaterial.version;
    expect(attach(early, 0)).toBe(true);
    expect(earlyMaterial.version).toBe(version);
    expect(firstMaterial(early)).toBe(earlyMaterial);
    expect(earlyMaterial.customProgramCacheKey).toBe(cacheCallback);
    expect(
      Object.getOwnPropertyDescriptor(earlyMaterial, "customProgramCacheKey"),
    ).toEqual(cacheDescriptor);
    expect(stage.environment).toBe(earlyEnvironment);
    expect(stage.environmentIntensity).toBe(0.7);
    expect(firstMaterial(waiting).envMap).toBe(sourceEnvironment);
    expect(firstMaterial(waiting).metalness).toBe(0.84);

    // An already-cloned pending item must not pin the old scene map when it
    // attaches later. No lighting-policy update is needed on the early item.
    stage.environment = lateEnvironment;
    stage.environmentIntensity = 0.2;
    expect(attach(waiting, 1)).toBe(true);
    const lateMaterial = firstMaterial(waiting);
    for (const material of [earlyMaterial, lateMaterial]) {
      expect(material.envMap).toBeNull();
      expect(material.metalness).toBe(0.84);
      expect(material.envMapIntensity).toBe(0.4);
      expect(material.roughness).toBe(0.3);
      expect(material.ior).toBe(1.5);
      expect(material.metalnessMap).toBe(source.texture);
      expect(material.roughnessMap).toBe(source.texture);
      expect(material.map).toBe(source.texture);
      expect(material.normalMap).toBe(source.texture);
      expect(material.color.equals(source.metal.color)).toBe(true);
    }
    expect(earlyMaterial.version).toBe(version);
    expect(lateMaterial).not.toBe(earlyMaterial);
    expect(source.metal.envMap).toBe(sourceEnvironment);
    expect(source.metal.metalness).toBe(0.84);
    expect(stage.environment).toBe(lateEnvironment);
    expect(stage.environmentIntensity).toBe(0.2);
    removeEquipmentVisual(actors[0].visuals, "weapon");
    removeEquipmentVisual(actors[0].visuals, "weapon");
    expect(earlyDisposals()).toBe(1);
    expect(actors[1].visuals.weapon?.parent).toBe(actors[1].hand);
    expect(sourceDisposals()).toBe(0);
    expect(textureDisposals()).toBe(0);
    expect(environmentDisposals.map((count) => count())).toEqual([0, 0, 0]);
  });

  it.each([false, true])(
    "restores cache ownership through explicit, scene and legacy policies (own callback: %s)",
    (custom) => {
      const source = template();
      const sourceEnvironment = new THREE.Texture();
      const borrowedEnvironment = new THREE.Texture();
      cleanup.push(() => {
        sourceEnvironment.dispose();
        borrowedEnvironment.dispose();
      });
      source.metal.envMap = sourceEnvironment;
      source.metal.envMapIntensity = 0.4;
      const a = avatar();
      const model = privateClone(source.root);
      const material = firstMaterial(model);
      if (custom)
        Object.defineProperty(material, "customProgramCacheKey", {
          value: function (this: THREE.Material) {
            return `authored:${this.type}`;
          },
          configurable: true,
          enumerable: false,
          writable: false,
        });
      const original = Object.getOwnPropertyDescriptor(
        material,
        "customProgramCacheKey",
      );
      const originalKeys = Object.keys(material);
      const originalCallback = material.customProgramCacheKey;
      const attach = (lighting?: EquipmentVisualLighting) =>
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting,
        });
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(attach()).toBe(true);
        expect(material.metalness).toBe(0);
        expect(
          attach({
            mode: "authored-pbr",
            environmentMap: borrowedEnvironment,
            intensity: 0.75,
          }),
        ).toBe(true);
        expect(material.envMap).toBe(borrowedEnvironment);
        const borrowedVersion = material.version;
        expect(attach({ mode: "authored-scene" })).toBe(true);
        expect(material.version).toBeGreaterThan(borrowedVersion);
        expect(material.metalness).toBe(0.84);
        expect(material.envMap).toBeNull();
        expect(material.envMapIntensity).toBe(0.4);
        expect(material.customProgramCacheKey).toBe(originalCallback);
        expect(
          Object.getOwnPropertyDescriptor(material, "customProgramCacheKey"),
        ).toEqual(original);
        expect(Object.keys(material)).toEqual(originalKeys);
        const sceneVersion = material.version;
        expect(attach({ mode: "authored-scene" })).toBe(true);
        expect(material.version).toBe(sceneVersion);
        expect(attach()).toBe(true);
        expect(material.metalness).toBe(0);
        expect(material.envMap).toBe(sourceEnvironment);
        expect(material.envMapIntensity).toBe(0.4);
      }
    },
  );

  it("does not require a writable cache override for direct scene inheritance", () => {
    const source = template();
    const a = avatar();
    const model = privateClone(source.root);
    const material = firstMaterial(model);
    Object.defineProperty(material, "customProgramCacheKey", {
      value: () => "immutable-authored-key",
      configurable: false,
      writable: false,
    });
    const original = Object.getOwnPropertyDescriptor(
      material,
      "customProgramCacheKey",
    );
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-scene" },
      }),
    ).toBe(true);
    expect(material.envMap).toBeNull();
    expect(material.metalness).toBe(0.84);
    expect(
      Object.getOwnPropertyDescriptor(material, "customProgramCacheKey"),
    ).toEqual(original);
  });

  it("recovers authored metalness from a legacy-held clone for scene-lit reattachment", () => {
    const source = template();
    source.metal.metalnessMap = source.texture;
    const a = avatar();
    const b = avatar();
    const legacy = privateClone(source.root);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: legacy, ...a }),
    ).toBe(true);
    expect(firstMaterial(legacy).metalness).toBe(0);
    const sceneLit = privateClone(legacy);
    const material = firstMaterial(sceneLit);
    expect(material.metalness).toBe(0);
    const count = disposalCounter(material);
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: sceneLit,
        ...b,
        lighting: { mode: "authored-scene" },
      }),
    ).toBe(true);
    expect(material.metalness).toBe(0.84);
    expect(material.metalnessMap).toBe(source.texture);
    expect(material.envMap).toBeNull();
    expect(firstMaterial(legacy).metalness).toBe(0);
    expect(source.metal.metalness).toBe(0.84);
    removeEquipmentVisual(a.visuals, "weapon");
    expect(count()).toBe(0);
    expect(b.visuals.weapon?.parent).toBe(b.hand);
    removeEquipmentVisual(b.visuals, "weapon");
    expect(count()).toBe(1);
  });

  it("borrows a per-item environment without changing authored PBR or the global scene", () => {
    const source = template();
    source.metal.roughnessMap = source.texture;
    source.metal.metalnessMap = source.texture;
    const a = avatar();
    const stage = new THREE.Scene();
    stage.add(a.vrm.scene);
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    const environmentDisposals = disposalCounter(environmentMap);
    const waiting = privateClone(source.root);
    const model = privateClone(source.root);
    const material = firstMaterial(model);
    const originalVersion = material.version;
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-pbr", environmentMap, intensity: 0.75 },
      }),
    ).toBe(true);
    expect(material.metalness).toBe(0.84);
    expect(material.envMap).toBe(environmentMap);
    expect(material.envMapIntensity).toBe(0.75);
    expect(material.version).toBeGreaterThan(originalVersion);
    expect(material.roughness).toBe(0.3);
    expect(material.ior).toBe(1.5);
    expect(material.color.toArray()).toEqual(source.metal.color.toArray());
    for (const key of [
      "map",
      "normalMap",
      "roughnessMap",
      "metalnessMap",
    ] as const)
      expect(material[key]).toBe(source.texture);
    for (const root of [source.root, waiting]) {
      expect(firstMaterial(root).metalness).toBe(0.84);
      expect(firstMaterial(root).envMap).toBeNull();
      expect(firstMaterial(root).envMapIntensity).toBe(1);
    }
    expect(stage.environment).toBeNull();
    removeEquipmentVisual(a.visuals, "weapon");
    expect(environmentDisposals()).toBe(0);
  });

  it("restores authored metalness across lighting changes and clones of held gear", () => {
    const source = template();
    const sourceEnvironment = new THREE.Texture();
    const environmentMap = new THREE.Texture();
    const secondEnvironment = new THREE.Texture();
    cleanup.push(() => {
      sourceEnvironment.dispose();
      environmentMap.dispose();
      secondEnvironment.dispose();
    });
    source.metal.envMap = sourceEnvironment;
    source.metal.envMapIntensity = 0.4;
    const a = avatar();
    const model = privateClone(source.root);
    const material = firstMaterial(model);
    const count = disposalCounter(material);
    material.customProgramCacheKey = function () {
      return `existing:${this.type}`;
    };
    const attach = (authored: boolean) =>
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...a,
        lighting: authored
          ? { mode: "authored-pbr", environmentMap, intensity: 0.8 }
          : undefined,
      });
    expect(attach(false)).toBe(true);
    expect(material.metalness).toBe(0);
    const heldClone = privateClone(model);
    expect(firstMaterial(heldClone).metalness).toBe(0);
    expect(attach(true)).toBe(true);
    expect(material.metalness).toBe(0.84);
    expect(material.envMap).toBe(environmentMap);
    expect(material.envMapIntensity).toBe(0.8);
    const version = material.version;
    expect(attach(true)).toBe(true);
    expect(material.version).toBe(version);
    const firstKey = material.customProgramCacheKey();
    expect(firstKey.startsWith(`existing:${material.type}`)).toBe(true);
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...a,
        lighting: {
          mode: "authored-pbr",
          environmentMap: secondEnvironment,
          intensity: 0.8,
        },
      }),
    ).toBe(true);
    expect(material.customProgramCacheKey()).not.toBe(firstKey);
    expect(material.version).toBeGreaterThan(version);
    expect(material.envMap).toBe(secondEnvironment);
    expect(attach(true)).toBe(true);
    expect(material.customProgramCacheKey()).toBe(firstKey);
    expect(attach(false)).toBe(true);
    expect(material.metalness).toBe(0);
    expect(material.envMap).toBe(sourceEnvironment);
    expect(material.envMapIntensity).toBe(0.4);
    expect(count()).toBe(0);
    const b = avatar();
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: heldClone,
        ...b,
        lighting: { mode: "authored-pbr", environmentMap, intensity: 1 },
      }),
    ).toBe(true);
    expect(firstMaterial(heldClone).metalness).toBe(0.84);
    expect(material.metalness).toBe(0);
    expect(source.metal.metalness).toBe(0.84);
    expect(source.metal.envMap).toBe(sourceEnvironment);
  });

  it("restores the exact original cache callback descriptor and enumerable keys", () => {
    const source = template();
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    for (const custom of [false, true]) {
      const a = avatar();
      const model = privateClone(source.root);
      const material = firstMaterial(model);
      if (custom)
        Object.defineProperty(material, "customProgramCacheKey", {
          value: function (this: THREE.Material) {
            return `custom:${this.type}`;
          },
          enumerable: false,
          configurable: true,
          writable: false,
        });
      const original = Object.getOwnPropertyDescriptor(
        material,
        "customProgramCacheKey",
      );
      const keys = Object.keys(material);
      const callback = material.customProgramCacheKey;
      const key = callback.call(material);
      const attach = (authored: boolean) =>
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting: authored
            ? { mode: "authored-pbr", environmentMap, intensity: 1 }
            : undefined,
        });
      expect(attach(false)).toBe(true);
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(attach(true)).toBe(true);
        expect(material.customProgramCacheKey()).toBe(
          `${key}:equipment-env:${environmentMap.uuid}`,
        );
        const version = material.version;
        expect(attach(false)).toBe(true);
        expect(material.version).toBeGreaterThan(version);
        expect(material.customProgramCacheKey).toBe(callback);
        expect(
          Object.getOwnPropertyDescriptor(material, "customProgramCacheKey"),
        ).toEqual(original);
        expect(Object.keys(material)).toEqual(keys);
      }
    }
  });

  it("rejects immutable cache callbacks before replacing attached equipment", () => {
    const source = template();
    const a = avatar();
    const current = privateClone(source.root);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: current, ...a }),
    ).toBe(true);
    const previous = a.visuals.weapon;
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    for (const writable of [false, true]) {
      const model = privateClone(source.root);
      const material = firstMaterial(model);
      Object.defineProperty(material, "customProgramCacheKey", {
        value: () => "locked",
        configurable: false,
        writable,
      });
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting: { mode: "authored-pbr", environmentMap, intensity: 1 },
        }),
      ).toBe(false);
      expect(a.visuals.weapon).toBe(previous);
      expect(model.parent).toBeNull();
      expect(material.metalness).toBe(0.84);
      expect(material.envMap).toBeNull();
      expect(material.customProgramCacheKey()).toBe("locked");
    }
  });

  it("does not overwrite a controller's replacement cache callback", () => {
    const source = template();
    const a = avatar();
    const model = privateClone(source.root);
    const material = firstMaterial(model);
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-pbr", environmentMap, intensity: 1 },
      }),
    ).toBe(true);
    const previous = a.visuals.weapon;
    const installed = Object.getOwnPropertyDescriptor(
      material,
      "customProgramCacheKey",
    )!;
    const replacement = () => "controller";
    material.customProgramCacheKey = replacement;
    for (const lighting of [undefined, { mode: "authored-scene" }] satisfies (
      EquipmentVisualLighting | undefined
    )[]) {
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting,
        }),
      ).toBe(false);
    }
    expect(material.customProgramCacheKey).toBe(replacement);
    expect(material.envMap).toBe(environmentMap);
    expect(material.metalness).toBe(0.84);
    expect(a.visuals.weapon).toBe(previous);
    Object.defineProperty(material, "customProgramCacheKey", installed);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: model, ...a }),
    ).toBe(true);
  });

  it("rejects invalid authored-lighting intensity without replacing the live attachment", () => {
    const source = template();
    const a = avatar();
    const current = privateClone(source.root);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: current, ...a }),
    ).toBe(true);
    const original = a.visuals.weapon;
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    for (const intensity of [-1, NaN, Infinity]) {
      const model = privateClone(source.root);
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting: { mode: "authored-pbr", environmentMap, intensity },
        }),
      ).toBe(false);
      expect(a.visuals.weapon).toBe(original);
      expect(model.parent).toBeNull();
      expect(firstMaterial(model).metalness).toBe(0.84);
      expect(firstMaterial(model).envMap).toBeNull();
    }
  });

  it("rejects a custom environment-node override before taking attachment ownership", () => {
    const source = template();
    const a = avatar();
    const current = privateClone(source.root);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: current, ...a }),
    ).toBe(true);
    const previous = a.visuals.weapon;
    const model = privateClone(source.root);
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    Object.defineProperty(firstMaterial(model), "envNode", {
      value: new THREE.Vector3(),
    });
    for (const lighting of [
      { mode: "authored-pbr", environmentMap, intensity: 1 },
      { mode: "authored-scene" },
    ] satisfies EquipmentVisualLighting[]) {
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting,
        }),
      ).toBe(false);
    }
    expect(a.visuals.weapon).toBe(previous);
    expect(model.parent).toBeNull();
    expect(firstMaterial(model).envMap).toBeNull();
    expect(firstMaterial(model).metalness).toBe(0.84);
  });

  it("does not accept a non-PBR material as authored environment lighting", () => {
    const a = avatar();
    const material = new THREE.MeshBasicMaterial();
    const geometry = new THREE.BoxGeometry();
    const environmentMap = new THREE.Texture();
    cleanup.push(() => {
      material.dispose();
      geometry.dispose();
      environmentMap.dispose();
    });
    const model = new THREE.Mesh(geometry, material);
    for (const lighting of [
      { mode: "authored-pbr", environmentMap, intensity: 1 },
      { mode: "authored-scene" },
    ] satisfies EquipmentVisualLighting[]) {
      expect(
        attachEquipmentVisualToVRM({
          slot: "weapon",
          modelRoot: model,
          ...a,
          lighting,
        }),
      ).toBe(false);
    }
    expect(model.material).toBe(material);
    expect(model.parent).toBeNull();
    expect(a.visuals.weapon).toBeUndefined();
  });

  it("clones distinct materials once per instance while sharing geometry and texture data", () => {
    const source = template();
    const a = privateClone(source.root);
    const b = privateClone(source.root);
    const ma = firstMaterial(a);
    const mb = firstMaterial(b);
    const array = (a.children[1] as THREE.Mesh).material as THREE.Material[];
    expect(array[0]).toBe(ma);
    expect(array[2]).toBe(ma);
    expect(ma).not.toBe(source.metal);
    expect(ma).not.toBe(mb);
    expect(array[1]).not.toBe(source.leather);
    for (const root of [source.root, a, b]) {
      expect((root.children[0] as THREE.Mesh).geometry).toBe(source.geometry);
      const material = firstMaterial(root);
      expect(material.map).toBe(source.texture);
      expect(material.normalMap).toBe(source.texture);
      expect(material.metalness).toBe(0.84);
      expect(material.roughness).toBe(0.3);
      expect(material.ior).toBe(1.5);
    }
    isolateEquipmentVisualMaterials(a);
    expect(firstMaterial(a)).toBe(ma);
    ma.metalness = 0;
    ma.color.set(0xff0000);
    expect(mb.metalness).toBe(0.84);
    expect(source.metal.metalness).toBe(0.84);
    expect(mb.color.toArray()).toEqual(source.metal.color.toArray());
  });

  it("keeps line, point and sprite materials private too", () => {
    const source = template();
    const lineMaterial = new THREE.LineBasicMaterial();
    const pointMaterial = new THREE.PointsMaterial();
    const spriteMaterial = new THREE.SpriteMaterial({ map: source.texture });
    cleanup.push(() => {
      lineMaterial.dispose();
      pointMaterial.dispose();
      spriteMaterial.dispose();
    });
    source.root.add(new THREE.Line(source.geometry, lineMaterial));
    source.root.add(new THREE.Points(source.geometry, pointMaterial));
    source.root.add(new THREE.Sprite(spriteMaterial));
    const clone = privateClone(source.root);
    expect((clone.children[2] as THREE.Line).material).not.toBe(lineMaterial);
    expect((clone.children[3] as THREE.Points).material).not.toBe(
      pointMaterial,
    );
    const clonedSprite = (clone.children[4] as THREE.Sprite).material;
    expect(clonedSprite).not.toBe(spriteMaterial);
    expect(clonedSprite.map).toBe(source.texture);
  });

  it("leaves the scene assignments untouched if actual Material.clone rejects circular metadata", () => {
    const source = template();
    source.leather.userData.circular = source.leather.userData;
    const direct = source.root.clone(true);
    const originalArray = (direct.children[1] as THREE.Mesh).material;
    expect(() => isolateEquipmentVisualMaterials(direct)).toThrow();
    expect(firstMaterial(direct)).toBe(source.metal);
    expect((direct.children[1] as THREE.Mesh).material).toBe(originalArray);
    delete source.leather.userData.circular;
  });

  it("releases only owned materials once through a wrapper, even without a parent", () => {
    const source = template();
    const a = privateClone(source.root);
    const b = privateClone(source.root);
    const countA = disposalCounter(firstMaterial(a));
    const countB = disposalCounter(firstMaterial(b));
    const countSource = disposalCounter(source.metal);
    const countGeometry = disposalCounter(source.geometry);
    const countTexture = disposalCounter(source.texture);
    const wrapper = new THREE.Group();
    wrapper.add(a);
    const visuals: EquipmentVisualStore = { weapon: wrapper };
    removeEquipmentVisual(visuals, "Weapon");
    disposeEquipmentVisualMaterials(wrapper);
    removeEquipmentVisual(visuals, "weapon");
    expect(visuals.weapon).toBeUndefined();
    expect(countA()).toBe(1);
    expect([countB(), countSource(), countGeometry(), countTexture()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("does not acquire disposal rights over cached or later controller-owned materials", () => {
    const source = template();
    const sourceCount = disposalCounter(source.metal);
    disposeEquipmentVisualMaterials(source.root);
    const clone = privateClone(source.root);
    const controllerMaterial = new THREE.LineBasicMaterial();
    cleanup.push(() => controllerMaterial.dispose());
    const controllerCount = disposalCounter(controllerMaterial);
    clone.add(new THREE.Line(source.geometry, controllerMaterial));
    disposeEquipmentVisualMaterials(clone);
    expect(sourceCount()).toBe(0);
    expect(controllerCount()).toBe(0);
  });

  it("gives a held-to-world clone independent lifetime from the held instance", () => {
    const source = template();
    const held = privateClone(source.root);
    firstMaterial(held).metalness = 0;
    const world = privateClone(held);
    const worldCount = disposalCounter(firstMaterial(world));
    expect(firstMaterial(world)).not.toBe(firstMaterial(held));
    expect(firstMaterial(world).metalness).toBe(0);
    expect(firstMaterial(world).map).toBe(source.texture);
    disposeEquipmentVisualMaterials(held);
    expect(worldCount()).toBe(0);
    disposeEquipmentVisualMaterials(world);
    expect(worldCount()).toBe(1);
  });

  it("isolates direct native scene clones before the real legacy attachment policy mutates them", () => {
    const source = template();
    const a = avatar();
    const model = source.root.clone(true);
    const waiting = source.root.clone(true);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: model, ...a }),
    ).toBe(true);
    const equipped = firstMaterial(model);
    expect(equipped).not.toBe(source.metal);
    expect(equipped.metalness).toBe(0);
    expect(firstMaterial(waiting).metalness).toBe(0.84);
    expect(source.metal.metalness).toBe(0.84);
    expect(a.visuals.weapon?.name).toBe("EquipmentWrapper");
    expect(a.visuals.weapon?.parent).toBe(a.hand);
  });

  it("replaces and removes private equipment without disposing a neighbor's materials", () => {
    const source = template();
    const a = avatar();
    const b = avatar();
    const first = privateClone(source.root);
    const neighbor = privateClone(source.root);
    const next = privateClone(source.root);
    const firstCount = disposalCounter(firstMaterial(first));
    const nextCount = disposalCounter(firstMaterial(next));
    const neighborCount = disposalCounter(firstMaterial(neighbor));
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: first, ...a }),
    ).toBe(true);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: neighbor, ...b }),
    ).toBe(true);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: next, ...a }),
    ).toBe(true);
    expect(firstCount()).toBe(1);
    expect(neighborCount()).toBe(0);
    removeEquipmentVisual(a.visuals, "weapon");
    expect(nextCount()).toBe(1);
    expect(neighborCount()).toBe(0);
    expect(b.visuals.weapon?.parent).toBe(b.hand);
  });

  it("does not dispose an existing attachment when reattaching the same owned root", () => {
    const source = template();
    const a = avatar();
    const model = privateClone(source.root);
    const material = firstMaterial(model);
    const count = disposalCounter(material);
    for (let i = 0; i < 3; i++) {
      expect(
        attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: model, ...a }),
      ).toBe(true);
      expect(firstMaterial(model)).toBe(material);
      expect(count()).toBe(0);
      expect(a.visuals.weapon?.parent).toBe(a.hand);
    }
    removeEquipmentVisual(a.visuals, "weapon");
    expect(count()).toBe(1);
  });

  it("retains the old attachment on rejected target and allows caller-owned candidate cleanup", () => {
    const source = template();
    const a = avatar();
    const original = privateClone(source.root);
    expect(
      attachEquipmentVisualToVRM({ slot: "weapon", modelRoot: original, ...a }),
    ).toBe(true);
    const oldVisual = a.visuals.weapon;
    const candidate = privateClone(source.root);
    candidate.userData.hyperia.vrmBoneName = "leftHand";
    const candidateCount = disposalCounter(firstMaterial(candidate));
    const oldCount = disposalCounter(firstMaterial(original));
    expect(
      attachEquipmentVisualToVRM({
        slot: "weapon",
        modelRoot: candidate,
        ...a,
      }),
    ).toBe(false);
    expect(a.visuals.weapon).toBe(oldVisual);
    disposeEquipmentVisualMaterials(candidate);
    expect(candidateCount()).toBe(1);
    expect(oldCount()).toBe(0);
  });

  it("does not dispose the avatar skeleton or shared skin data when skinned gear is removed", () => {
    const source = template();
    const a = avatar();
    const skeleton = new THREE.Skeleton([a.hips, a.hand]);
    skeleton.computeBoneTexture();
    const boneTexture = skeleton.boneTexture!;
    const boneTextureCount = disposalCounter(boneTexture);
    cleanup.push(() => skeleton.dispose());
    const vertexCount = source.geometry.getAttribute("position").count;
    const skinWeights = new THREE.Float32BufferAttribute(
      new Float32Array(vertexCount * 4),
      4,
    );
    for (let i = 0; i < vertexCount; i++) skinWeights.setX(i, 1);
    source.geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(new Uint16Array(vertexCount * 4), 4),
    );
    source.geometry.setAttribute("skinWeight", skinWeights);
    const body = new THREE.SkinnedMesh(source.geometry, source.metal);
    body.bind(skeleton);
    a.vrm.scene.add(body);
    const gearRoot = new THREE.Group();
    gearRoot.add(body.clone());
    const model = privateClone(gearRoot);
    const gear = model.children[0] as THREE.SkinnedMesh;
    const bodyBind = body.bindMatrix.toArray();
    const gearMaterialCount = disposalCounter(gear.material as THREE.Material);
    expect(
      attachEquipmentVisualToVRM({ slot: "body", modelRoot: model, ...a }),
    ).toBe(true);
    expect(gear.skeleton).toBe(skeleton);
    const environmentMap = new THREE.Texture();
    cleanup.push(() => environmentMap.dispose());
    const environmentDisposals = disposalCounter(environmentMap);
    expect(
      attachEquipmentVisualToVRM({
        slot: "body",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-pbr", environmentMap, intensity: 0.6 },
      }),
    ).toBe(true);
    expect((gear.material as THREE.MeshPhysicalMaterial).metalness).toBe(0.84);
    expect((gear.material as THREE.MeshPhysicalMaterial).envMap).toBe(
      environmentMap,
    );
    expect(
      attachEquipmentVisualToVRM({
        slot: "body",
        modelRoot: model,
        ...a,
        lighting: { mode: "authored-scene" },
      }),
    ).toBe(true);
    expect((gear.material as THREE.MeshPhysicalMaterial).envMap).toBeNull();
    expect((gear.material as THREE.MeshPhysicalMaterial).metalness).toBe(0.84);
    expect(gear.skeleton).toBe(skeleton);
    expect(source.metal.envMap).toBeNull();
    removeEquipmentVisual(a.visuals, "body");
    expect(gearMaterialCount()).toBe(1);
    expect(environmentDisposals()).toBe(0);
    expect(boneTextureCount()).toBe(0);
    expect(skeleton.boneTexture).toBe(boneTexture);
    expect(body.bindMatrix.toArray()).toEqual(bodyBind);
    expect(body.geometry).toBe(source.geometry);
    expect(body.material).toBe(source.metal);
    expect(source.metal.metalness).toBe(0.84);
  });

  it("attempts every owned material and clears ownership before reporting disposal-listener errors", () => {
    const source = template();
    const model = privateClone(source.root);
    const materials = (model.children[1] as THREE.Mesh)
      .material as THREE.Material[];
    const firstCount = disposalCounter(materials[0]);
    const secondCount = disposalCounter(materials[1]);
    materials[0].addEventListener("dispose", () => {
      throw new Error("Deliberate disposal-listener failure");
    });
    expect(() => disposeEquipmentVisualMaterials(model)).toThrow(
      AggregateError,
    );
    expect(firstCount()).toBe(1);
    expect(secondCount()).toBe(1);
    expect(() => disposeEquipmentVisualMaterials(model)).not.toThrow();
  });
});
