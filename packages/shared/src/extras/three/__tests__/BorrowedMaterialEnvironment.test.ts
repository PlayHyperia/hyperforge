import { describe, expect, it } from "vitest";
import * as THREE from "../three";
import { BorrowedMaterialEnvironment } from "../BorrowedMaterialEnvironment";

// Real Three materials/textures/TSL nodes; CPU ownership only, not GPU PMREM proof.
function pmrem() {
  return Object.assign(new THREE.Texture(), {
    mapping: THREE.CubeUVReflectionMapping,
    isPMREMTexture: true,
  });
}
function fields(material: THREE.Material) {
  return ["envMap", "envMapIntensity", "customProgramCacheKey"].map((key) =>
    Object.getOwnPropertyDescriptor(material, key),
  );
}

describe("borrowed private material environment", () => {
  it.each([
    THREE.MeshStandardMaterial,
    THREE.MeshPhysicalMaterial,
    THREE.MeshStandardNodeMaterial,
    THREE.MeshPhysicalNodeMaterial,
  ])(
    "binds/restores real %s without owning materials or textures",
    (MaterialClass) => {
      const original = pmrem(),
        borrowed = pmrem(),
        base = new THREE.Texture();
      const material = new MaterialClass();
      material.envMap = original;
      material.envMapIntensity = 0.31;
      material.map = base;
      material.metalness = 0.83;
      material.roughness = 0.4;
      const before = fields(material),
        originalKey = material.customProgramCacheKey();
      const version = material.version;
      let disposed = 0;
      for (const resource of [original, borrowed, material])
        resource.addEventListener("dispose", () => {
          disposed++;
          throw new Error("Must remain borrowed");
        });
      const owner = new BorrowedMaterialEnvironment([material], borrowed, 0.75);
      expect(owner.active).toBe(true);
      expect(owner.materialCount).toBe(1);
      expect(material.envMap).toBe(borrowed);
      expect(material.customProgramCacheKey()).toBe(
        `${originalKey}:borrowed-environment:${borrowed.uuid}`,
      );
      expect(material.version).toBe(version + 1);
      const boundKey = material.customProgramCacheKey;
      for (const intensity of [0.75, 0.15, 0, 0.75])
        owner.updateIntensity(intensity);
      expect(material.envMapIntensity).toBe(0.75);
      expect(material.version).toBe(version + 1);
      expect(material.customProgramCacheKey).toBe(boundKey);
      owner.dispose();
      owner.dispose();
      expect(owner.active).toBe(false);
      expect(fields(material)).toEqual(before);
      expect(material.version).toBe(version + 2);
      expect(material.customProgramCacheKey()).toBe(originalKey);
      expect(material).toMatchObject({
        map: base,
        metalness: 0.83,
        roughness: 0.4,
      });
      expect(disposed).toBe(0);
      expect(() => owner.updateIntensity(1)).toThrow("disposed");
    },
  );

  it("preserves an own cache descriptor and its receiver, then permits a different environment", () => {
    const material = new THREE.MeshStandardNodeMaterial();
    material.name = "private-body";
    const key = function (this: THREE.Material) {
      return this.name;
    };
    Object.defineProperty(material, "customProgramCacheKey", {
      value: key,
      configurable: true,
      writable: false,
      enumerable: false,
    });
    const before = fields(material),
      a = pmrem(),
      b = pmrem();
    const first = new BorrowedMaterialEnvironment([material], a, 0.5);
    expect(material.customProgramCacheKey()).toBe(
      `private-body:borrowed-environment:${a.uuid}`,
    );
    first.dispose();
    expect(fields(material)).toEqual(before);
    const second = new BorrowedMaterialEnvironment([material], b, 0.5);
    expect(material.customProgramCacheKey()).not.toContain(a.uuid);
    second.dispose();
    expect(fields(material)).toEqual(before);
  });

  it("preflights the complete list before unsupported types or envNodes can mutate earlier rows", () => {
    const first = new THREE.MeshStandardMaterial(),
      invalid = new THREE.MeshBasicMaterial();
    const node = new THREE.MeshStandardNodeMaterial();
    node.envNode = THREE.vec3(1);
    const before = fields(first),
      version = first.version;
    for (const last of [invalid, node])
      expect(
        () => new BorrowedMaterialEnvironment([first, last], pmrem(), 1),
      ).toThrow();
    expect(fields(first)).toEqual(before);
    expect(first.version).toBe(version);
  });

  it("rejects empty, duplicate and overlapping owners before changing unowned rows", () => {
    const a = new THREE.MeshStandardMaterial(),
      b = new THREE.MeshStandardNodeMaterial();
    expect(() => new BorrowedMaterialEnvironment([], pmrem(), 1)).toThrow(
      "unique",
    );
    expect(() => new BorrowedMaterialEnvironment([a, a], pmrem(), 1)).toThrow(
      "unique",
    );
    const owner = new BorrowedMaterialEnvironment([a], pmrem(), 1);
    const before = fields(b);
    expect(() => new BorrowedMaterialEnvironment([b, a], pmrem(), 1)).toThrow(
      "owned",
    );
    expect(fields(b)).toEqual(before);
    owner.dispose();
  });

  it.each([NaN, Infinity, -1])(
    "rejects invalid intensity %s without mutations",
    (value) => {
      const material = new THREE.MeshStandardMaterial(),
        borrowed = pmrem();
      const before = fields(material);
      expect(
        () => new BorrowedMaterialEnvironment([material], borrowed, value),
      ).toThrow();
      expect(fields(material)).toEqual(before);
      const owner = new BorrowedMaterialEnvironment([material], borrowed, 0.5);
      const bound = fields(material),
        version = material.version;
      expect(() => owner.updateIntensity(value)).toThrow();
      expect(fields(material)).toEqual(bound);
      expect(material.version).toBe(version);
      owner.dispose();
    },
  );

  it("rejects an unqualified texture without installing any binding", () => {
    const material = new THREE.MeshStandardMaterial(),
      before = fields(material);
    expect(
      () => new BorrowedMaterialEnvironment([material], new THREE.Texture(), 1),
    ).toThrow("PMREM");
    expect(fields(material)).toEqual(before);
  });

  it.each([
    "envMap",
    "envMapIntensity",
    "customProgramCacheKey",
    "envNode",
    "needsUpdate",
    "version",
  ])(
    "rejects a real material's %s accessor before invoking it or changing another row",
    (key) => {
      const first = new THREE.MeshStandardMaterial(),
        last = new THREE.MeshStandardNodeMaterial();
      let calls = 0;
      Object.defineProperty(last, key, {
        configurable: true,
        get() {
          calls++;
          throw new Error("foreign getter");
        },
        set() {
          calls++;
          throw new Error("foreign setter");
        },
      });
      const before = fields(first),
        version = first.version;
      expect(
        () => new BorrowedMaterialEnvironment([first, last], pmrem(), 1),
      ).toThrow();
      expect(calls).toBe(0);
      expect(fields(first)).toEqual(before);
      expect(first.version).toBe(version);
    },
  );

  it.each(["envMap", "envMapIntensity", "customProgramCacheKey", "envNode"])(
    "refuses a foreign %s edit atomically and permits explicit repaired retry",
    (key) => {
      const first = new THREE.MeshStandardMaterial(),
        last = new THREE.MeshStandardNodeMaterial();
      const before = [fields(first), fields(last)];
      const owner = new BorrowedMaterialEnvironment(
        [first, last],
        pmrem(),
        0.5,
      );
      const installed = Object.getOwnPropertyDescriptor(last, key)!;
      // Same value, changed descriptor: identity checks alone must not pass.
      Object.defineProperty(last, key, {
        ...installed,
        enumerable: !installed.enumerable,
      });
      const held = [fields(first), fields(last)],
        versions = [first.version, last.version];
      expect(() => owner.updateIntensity(0.25)).toThrow("ownership");
      expect(() => owner.dispose()).toThrow("ownership");
      expect(owner.active).toBe(true);
      expect([fields(first), fields(last)]).toEqual(held);
      expect([first.version, last.version]).toEqual(versions);
      Object.defineProperty(last, key, installed);
      owner.dispose();
      expect([fields(first), fields(last)]).toEqual(before);
    },
  );
});
