import { describe, expect, it } from "vitest";
import * as THREE from "../three";
import {
  createVRMFactory,
  prepareVRMMaterialsForWebGPU,
} from "../createVRMFactory";

describe("production VRM material normalization", () => {
  it("preserves texture, alpha, color, and side inputs without changing the rig or geometry", () => {
    const texture = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const emissiveMap = new THREE.Texture();
    const original = new THREE.MeshStandardMaterial({
      map: texture,
      normalMap,
      emissiveMap,
      color: 0x416283,
      emissive: 0x112233,
      opacity: 0.7,
      transparent: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
    });
    original.name = "authored-avatar";
    let disposals = 0;
    original.addEventListener("dispose", () => {
      disposals += 1;
    });
    const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
      geometry,
      original,
    );
    const root = new THREE.Group();
    root.position.set(3, 4, 5);
    root.rotation.set(0.1, 0.2, 0.3);
    root.scale.setScalar(1.2);
    root.add(mesh);
    root.updateMatrixWorld(true);
    const before = root.matrixWorld.clone();
    const vertices = Array.from(geometry.attributes.position.array);

    prepareVRMMaterialsForWebGPU(root);

    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    const converted = mesh.material as THREE.MeshStandardNodeMaterial;
    expect(converted.map).toBe(texture);
    expect(converted.normalMap).toBe(normalMap);
    expect(converted.emissiveMap).toBe(emissiveMap);
    expect(converted.color.equals(original.color)).toBe(true);
    expect(converted.emissive.equals(original.emissive)).toBe(true);
    expect(converted).toMatchObject({
      name: "authored-avatar",
      opacity: 0.7,
      transparent: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      emissiveIntensity: 1,
      envMapIntensity: 1,
    });
    expect(disposals).toBe(1);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
    expect(root.matrixWorld.elements).toEqual(before.elements);
    expect(mesh.geometry).toBe(geometry);
    expect(Array.from(geometry.attributes.position.array)).toEqual(vertices);
    converted.dispose();
    geometry.dispose();
    texture.dispose();
    normalMap.dispose();
    emissiveMap.dispose();
  });

  it("preserves authored PBR maps and factors, shares conversions and is idempotent", () => {
    const orm = new THREE.Texture();
    const normal = new THREE.Texture();
    const original = new THREE.MeshStandardMaterial({
      roughness: 0.57,
      metalness: 0.84,
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      aoMapIntensity: 0.4,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.6, 0.8),
      emissiveIntensity: 0,
      vertexColors: true,
    });
    original.userData = { asset: "authored-pbr-surface" };
    let disposals = 0;
    original.addEventListener("dispose", () => {
      disposals += 1;
    });
    const geometry = new THREE.BoxGeometry();
    const first = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
      geometry,
      original,
    );
    const second = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
      geometry,
      original,
    );
    const root = new THREE.Group();
    root.add(first, second);

    prepareVRMMaterialsForWebGPU(root);

    const converted = first.material as THREE.MeshStandardNodeMaterial;
    expect(converted).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(second.material).toBe(converted);
    expect(disposals).toBe(1);
    expect(converted.roughnessMap).toBe(orm);
    expect(converted.metalnessMap).toBe(orm);
    expect(converted.aoMap).toBe(orm);
    expect(converted.normalMap).toBe(normal);
    expect(converted.normalScale.toArray()).toEqual([0.6, 0.8]);
    expect(converted.normalScale).not.toBe(original.normalScale);
    expect(converted).toMatchObject({
      roughness: 0.57,
      metalness: 0.84,
      aoMapIntensity: 0.4,
      emissiveIntensity: 0,
      vertexColors: true,
      userData: { asset: "authored-pbr-surface" },
    });
    prepareVRMMaterialsForWebGPU(root);
    expect(first.material).toBe(converted);
    expect(second.material).toBe(converted);
    expect(disposals).toBe(1);
    converted.dispose();
    expect(disposals).toBe(1);
    geometry.dispose();
    orm.dispose();
    normal.dispose();
  });

  it("preserves physical cornea and coating settings in a physical node material", () => {
    const transmissionMap = new THREE.Texture();
    const coatNormalMap = new THREE.Texture();
    const original = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      transmissionMap,
      thickness: 0.002,
      attenuationColor: 0xfaf6ed,
      attenuationDistance: 0.4,
      ior: 1.376,
      roughness: 0.04,
      clearcoat: 0.3,
      clearcoatRoughness: 0.08,
      clearcoatNormalMap: coatNormalMap,
      clearcoatNormalScale: new THREE.Vector2(0.2, 0.3),
      specularIntensity: 0.7,
      specularColor: 0xfafafa,
      depthWrite: false,
    });
    const geometry = new THREE.SphereGeometry(0.01, 16, 8);
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
      geometry,
      original,
    );
    prepareVRMMaterialsForWebGPU(mesh);
    const converted = mesh.material as THREE.MeshPhysicalNodeMaterial;
    expect(converted).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
    expect(converted.transmissionMap).toBe(transmissionMap);
    expect(converted.clearcoatNormalMap).toBe(coatNormalMap);
    expect(converted.clearcoatNormalScale.toArray()).toEqual([0.2, 0.3]);
    expect(converted.attenuationColor.equals(original.attenuationColor)).toBe(
      true,
    );
    expect(converted.specularColor.equals(original.specularColor)).toBe(true);
    expect(converted).toMatchObject({
      transmission: 1,
      thickness: 0.002,
      attenuationDistance: 0.4,
      ior: 1.376,
      roughness: 0.04,
      clearcoat: 0.3,
      clearcoatRoughness: 0.08,
      specularIntensity: 0.7,
      depthWrite: false,
    });
    prepareVRMMaterialsForWebGPU(mesh);
    expect(mesh.material).toBe(converted);
    converted.dispose();
    geometry.dispose();
    transmissionMap.dispose();
    coatNormalMap.dispose();
  });

  it("replaces shader-only materials and every material-array entry with node materials", () => {
    const shader = new THREE.ShaderMaterial();
    const basic = new THREE.MeshBasicMaterial({ color: 0x123456 });
    const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(geometry, [shader, basic]);
    prepareVRMMaterialsForWebGPU(mesh);
    expect(mesh.material).toHaveLength(2);
    for (const material of mesh.material) {
      expect(material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
      material.dispose();
    }
    geometry.dispose();
  });
});

type MaterialMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

/** Real factory/scene cloning via its static fallback, not skinning or GPU proof. */
function createTwoMaterialClones(material: THREE.Material | THREE.Material[]) {
  const geometry = new THREE.BoxGeometry();
  if (Array.isArray(material)) {
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
  }
  const source = new THREE.Scene();
  const first = new THREE.Mesh(geometry, material);
  first.name = "material-fixture-first";
  const second = new THREE.Mesh(geometry, material);
  second.name = "material-fixture-second";
  source.add(first, second);
  const factory = createVRMFactory({ scene: source });
  const display = new THREE.Scene();
  const a = factory.create(new THREE.Matrix4(), { scene: display });
  const b = factory.create(new THREE.Matrix4(), { scene: display });
  if (!a || !b) throw new Error("Real static factory fixture did not clone");

  function materials(root: THREE.Object3D, name = first.name) {
    const mesh = root.getObjectByName(name);
    if (!(mesh instanceof THREE.Mesh)) throw new Error("Missing fixture mesh");
    expect(mesh.geometry).toBe(geometry);
    const entry = (mesh as MaterialMesh).material;
    return Array.isArray(entry) ? entry : [entry];
  }

  return {
    source: materials(source),
    a: materials(a.raw.scene),
    b: materials(b.raw.scene),
    siblingA: materials(a.raw.scene, second.name),
    dispose() {
      const owned = new Set<THREE.Material>();
      for (const root of [source, a.raw.scene, b.raw.scene]) {
        for (const name of [first.name, second.name]) {
          for (const entry of materials(root, name)) owned.add(entry);
        }
      }
      a.destroy();
      b.destroy();
      for (const entry of owned) entry.dispose();
      geometry.dispose();
    },
  };
}

describe("production factory static-clone material regression", () => {
  it("retains standard ORM maps, authored factors and render state in both actual clones", () => {
    const orm = new THREE.Texture();
    const normal = new THREE.Texture();
    const alpha = new THREE.Texture();
    const base = new THREE.Texture();
    const original = new THREE.MeshStandardMaterial({
      map: base,
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      normalMap: normal,
      alphaMap: alpha,
      normalScale: new THREE.Vector2(0.6, 0.8),
      roughness: 0.57,
      metalness: 0.84,
      aoMapIntensity: 0.4,
      emissiveIntensity: 0,
      opacity: 0.7,
      transparent: true,
      alphaTest: 0.2,
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 3,
    });
    original.name = "authored-standard-clone";
    const fixture = createTwoMaterialClones(original);
    try {
      for (const entry of [fixture.source[0], fixture.a[0], fixture.b[0]]) {
        expect(entry).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
        expect(entry).not.toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
        const material = entry as THREE.MeshStandardNodeMaterial;
        expect(material.isMeshStandardNodeMaterial).toBe(true);
        expect(material.map).toBe(base);
        expect(material.roughnessMap).toBe(orm);
        expect(material.metalnessMap).toBe(orm);
        expect(material.aoMap).toBe(orm);
        expect(material.normalMap).toBe(normal);
        expect(material.alphaMap).toBe(alpha);
        expect(material.normalScale.toArray()).toEqual([0.6, 0.8]);
        expect(material).toMatchObject({
          name: "authored-standard-clone",
          roughness: 0.57,
          metalness: 0.84,
          aoMapIntensity: 0.4,
          emissiveIntensity: 0,
          opacity: 0.7,
          transparent: true,
          alphaTest: 0.2,
          vertexColors: true,
          side: THREE.DoubleSide,
          shadowSide: THREE.BackSide,
          depthWrite: false,
          depthTest: false,
          colorWrite: false,
          blending: THREE.AdditiveBlending,
          premultipliedAlpha: true,
          polygonOffset: true,
          polygonOffsetFactor: 2,
          polygonOffsetUnits: 3,
        });
      }
      expect(
        new Set([
          fixture.source[0],
          fixture.a[0],
          fixture.b[0],
          fixture.siblingA[0],
        ]).size,
      ).toBe(4);
      const a = fixture.a[0] as THREE.MeshStandardNodeMaterial;
      const b = fixture.b[0] as THREE.MeshStandardNodeMaterial;
      const source = fixture.source[0] as THREE.MeshStandardNodeMaterial;
      a.normalScale.set(9, 8);
      a.color.set(0xff0000);
      a.emissive.set(0x112233);
      a.roughness = 0.1;
      for (const unchanged of [source, b]) {
        expect(unchanged.normalScale.toArray()).toEqual([0.6, 0.8]);
        expect(unchanged.color.getHex()).toBe(0xffffff);
        expect(unchanged.emissive.getHex()).toBe(0);
        expect(unchanged.roughness).toBe(0.57);
      }
    } finally {
      fixture.dispose();
      for (const texture of [orm, normal, alpha, base]) texture.dispose();
    }
  });

  it("preserves mixed physical/standard arrays and isolates physical mutable values", () => {
    const transmission = new THREE.Texture();
    const coatNormal = new THREE.Texture();
    const original = new THREE.MeshPhysicalMaterial({
      ior: 1.376,
      transmission: 0.9,
      transmissionMap: transmission,
      thickness: 0.002,
      attenuationDistance: 0.4,
      attenuationColor: 0xfaf6ed,
      clearcoat: 0.3,
      clearcoatRoughness: 0.08,
      clearcoatNormalMap: coatNormal,
      clearcoatNormalScale: new THREE.Vector2(0.2, 0.3),
      specularIntensity: 0.7,
      specularColor: 0xfafafa,
      depthWrite: false,
    });
    original.userData = { nested: { label: "authored" } };
    const fixture = createTwoMaterialClones([
      original,
      new THREE.MeshStandardMaterial({ roughness: 0.64, metalness: 0.21 }),
    ]);
    try {
      for (const entries of [
        fixture.source,
        fixture.a,
        fixture.b,
        fixture.siblingA,
      ]) {
        expect(entries).toHaveLength(2);
        expect(entries[0]).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
        expect(entries[1]).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
        expect(entries[1]).not.toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
        const physical = entries[0] as THREE.MeshPhysicalNodeMaterial;
        expect(physical.isMeshPhysicalNodeMaterial).toBe(true);
        expect(physical.transmissionMap).toBe(transmission);
        expect(physical.clearcoatNormalMap).toBe(coatNormal);
        expect(physical.clearcoatNormalScale.toArray()).toEqual([0.2, 0.3]);
        expect(
          physical.attenuationColor.equals(original.attenuationColor),
        ).toBe(true);
        expect(physical.specularColor.equals(original.specularColor)).toBe(
          true,
        );
        expect(physical).toMatchObject({
          ior: 1.376,
          transmission: 0.9,
          thickness: 0.002,
          attenuationDistance: 0.4,
          clearcoat: 0.3,
          clearcoatRoughness: 0.08,
          specularIntensity: 0.7,
          depthWrite: false,
          userData: { nested: { label: "authored" } },
        });
        expect(entries[1]).toMatchObject({ roughness: 0.64, metalness: 0.21 });
      }
      for (const index of [0, 1]) {
        expect(
          new Set([
            fixture.source[index],
            fixture.a[index],
            fixture.b[index],
            fixture.siblingA[index],
          ]).size,
        ).toBe(4);
      }
      const a = fixture.a[0] as THREE.MeshPhysicalNodeMaterial;
      a.ior = 1.9;
      a.clearcoatNormalScale.set(7, 6);
      a.attenuationColor.set(0xff0000);
      a.specularColor.set(0x00ff00);
      (a.userData.nested as { label: string }).label = "only-a";
      for (const entry of [
        fixture.source[0],
        fixture.b[0],
        fixture.siblingA[0],
      ]) {
        const unchanged = entry as THREE.MeshPhysicalNodeMaterial;
        expect(unchanged.ior).toBe(1.376);
        expect(unchanged.clearcoatNormalScale.toArray()).toEqual([0.2, 0.3]);
        expect(
          unchanged.attenuationColor.equals(original.attenuationColor),
        ).toBe(true);
        expect(unchanged.specularColor.equals(original.specularColor)).toBe(
          true,
        );
        expect(unchanged.userData).toEqual({ nested: { label: "authored" } });
      }
    } finally {
      fixture.dispose();
      transmission.dispose();
      coatNormal.dispose();
    }
  });

  it("does not transfer prepared runtime node graphs or share new per-avatar uniforms", () => {
    const original = new THREE.MeshPhysicalNodeMaterial();
    const sourceToggle = THREE.uniform(0.25);
    original.outputNode = THREE.vec4(sourceToggle, 0, 0, 1);
    original.colorNode = THREE.vec3(sourceToggle);
    original.normalNode = THREE.vec3(0, 0, 1);
    original.positionNode = THREE.vec3(0, 0, 0);
    original.emissiveNode = THREE.vec3(sourceToggle);
    original.opacityNode = sourceToggle;
    original.roughnessNode = sourceToggle;
    original.metalnessNode = sourceToggle;
    original.iorNode = sourceToggle;
    original.clearcoatNode = sourceToggle;
    original.transmissionNode = sourceToggle;
    const sourceNodes = {
      outputNode: original.outputNode,
      colorNode: original.colorNode,
      normalNode: original.normalNode,
      positionNode: original.positionNode,
      emissiveNode: original.emissiveNode,
      opacityNode: original.opacityNode,
      roughnessNode: original.roughnessNode,
      metalnessNode: original.metalnessNode,
      iorNode: original.iorNode,
      clearcoatNode: original.clearcoatNode,
      transmissionNode: original.transmissionNode,
    };
    const fixture = createTwoMaterialClones(original);
    try {
      expect(fixture.source[0]).toBe(original);
      for (const entry of [fixture.a[0], fixture.b[0], fixture.siblingA[0]]) {
        const material = entry as THREE.MeshPhysicalNodeMaterial;
        for (const key of Object.keys(
          sourceNodes,
        ) as (keyof typeof sourceNodes)[]) {
          expect(original[key]).toBe(sourceNodes[key]);
          expect(material[key]).toBeNull();
        }
      }
      const a = fixture.a[0] as THREE.MeshPhysicalNodeMaterial;
      const b = fixture.b[0] as THREE.MeshPhysicalNodeMaterial;
      const toggleA = THREE.uniform(0);
      const toggleB = THREE.uniform(0);
      a.outputNode = THREE.vec4(toggleA, 0, 0, 1);
      b.outputNode = THREE.vec4(toggleB, 0, 0, 1);
      expect(a.outputNode).not.toBe(b.outputNode);
      expect(a.outputNode).not.toBe(original.outputNode);
      toggleA.value = 1;
      expect(toggleA.value).toBe(1);
      expect(toggleB.value).toBe(0);
      expect(sourceToggle.value).toBe(0.25);
      expect(original.outputNode).toBe(sourceNodes.outputNode);
    } finally {
      fixture.dispose();
    }
  });
});
