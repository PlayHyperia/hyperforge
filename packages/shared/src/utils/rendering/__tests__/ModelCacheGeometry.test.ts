import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { modelCache } from "../ModelCache";

type ModelCacheInternals = {
  setupMaterials: (scene: THREE.Object3D) => void;
  bakeTransformsToGeometry: (scene: THREE.Object3D) => void;
};

describe("ModelCache geometry setup", () => {
  it("bakes the actual quantized mushroom without integer wrap or source mutation", async () => {
    const bytes = readFileSync(
      new URL(
        "../../../../../server/world/assets/trees/mushroom.glb",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "5da74176d6295c8f20a761ac96014160567e4175ec2a809c9b8325090a176778",
    );
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    );
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.push(node);
    });
    expect(meshes).toHaveLength(1);
    const mesh = meshes[0],
      original = mesh.geometry;
    const source = original.getAttribute("position");
    expect(source.array).toBeInstanceOf(Int16Array);
    expect(source.normalized).toBe(true);
    expect(source.count).toBe(3161);
    expect(original.index!.count).toBe(15039);
    const originalBytes = new Uint8Array(source.array.buffer).slice();
    gltf.scene.updateMatrixWorld(true);
    const matrix = mesh.matrixWorld.clone(),
      vertex = new THREE.Vector3();
    const expected = new Float32Array(source.count * 3);
    for (let i = 0; i < source.count; i++) {
      // GPU-compatible Float32 workspace, then world transform. Do not round
      // transformed coordinates back into normalized integer storage.
      vertex.fromBufferAttribute(source, i).toArray(expected, i * 3);
      vertex.fromArray(expected, i * 3).applyMatrix4(matrix);
      vertex.toArray(expected, i * 3);
    }
    const expectedGeometry = new THREE.BufferGeometry();
    expectedGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(expected, 3),
    );
    expectedGeometry.setIndex(original.index!.clone());
    expectedGeometry.computeVertexNormals();
    const originalMaterial = mesh.material;
    try {
      const cache = modelCache as unknown as ModelCacheInternals;
      cache.bakeTransformsToGeometry(gltf.scene);
      cache.setupMaterials(gltf.scene);
      const actual = mesh.geometry.getAttribute("position");
      let maximumError = 0;
      const expectedVertex = new THREE.Vector3();
      for (let i = 0; i < source.count; i++) {
        vertex.fromBufferAttribute(actual, i);
        maximumError = Math.max(
          maximumError,
          vertex.distanceTo(expectedVertex.fromArray(expected, i * 3)),
        );
      }
      expect(maximumError).toBeLessThan(2e-7);
      expect(actual.array).toBeInstanceOf(Float32Array);
      expect(actual.normalized).toBe(false);
      expect(mesh.geometry.getAttribute("normal").array).toEqual(
        expectedGeometry.getAttribute("normal").array,
      );
      expect(mesh.geometry.index!.array).toEqual(original.index!.array);
      expect(mesh.geometry.getAttribute("color").array).toEqual(
        original.getAttribute("color").array,
      );
      expect(mesh.geometry.getAttribute("color").normalized).toBe(
        original.getAttribute("color").normalized,
      );
      expect(new Uint8Array(source.array.buffer)).toEqual(originalBytes);
      expect(mesh.matrixWorld.elements).toEqual(new THREE.Matrix4().elements);
      expect(mesh.material).toBeInstanceOf(MeshStandardNodeMaterial);
    } finally {
      expectedGeometry.dispose();
      original.dispose();
      if (mesh.geometry !== original) mesh.geometry.dispose();
      for (const material of new Set([
        ...(Array.isArray(originalMaterial)
          ? originalMaterial
          : [originalMaterial]),
        ...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]),
      ]))
        material.dispose();
    }
  });

  it.each([
    "normalized-int16",
    "interleaved-int16",
    "unnormalized-int16",
    "float16",
    "float32",
    "interleaved-float32",
  ] as const)(
    "bakes %s positions, normals and tangent handedness in decoded space",
    (storage) => {
      const geometry = new THREE.BufferGeometry();
      const interleaved = storage.startsWith("interleaved-");
      const normalized =
        storage === "normalized-int16" || storage === "interleaved-int16";
      const floating =
        storage === "float32" || storage === "interleaved-float32";
      const data = interleaved
        ? new THREE.InterleavedBuffer(
            floating ? new Float32Array(36) : new Int16Array(36),
            12,
          ).setUsage(THREE.DynamicDrawUsage)
        : undefined;
      const positions = [
        [0.98, -1, 0.4],
        [-0.2, 0.65, 0.7],
        [0.34, -0.8, -0.95],
      ];
      const normals = [
        [0.6, 0.8, 0],
        [0, 0.6, 0.8],
        [0.8, 0, 0.6],
      ];
      const tangents = [
        [0.8, -0.6, 0, -1],
        [0, 0.8, -0.6, 1],
        [0.6, 0, -0.8, -1],
      ];
      const originalArrays: Array<{
        attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        bytes: Uint8Array;
      }> = [];
      const expected = new THREE.BufferGeometry();
      for (const [name, values, offset] of [
        ["position", positions, 0],
        ["normal", normals, 3],
        ["tangent", tangents, 6],
      ] as const) {
        const size = name === "tangent" ? 4 : 3;
        const attribute = data
          ? new THREE.InterleavedBufferAttribute(data, size, offset, normalized)
          : storage === "float16"
            ? new THREE.Float16BufferAttribute(new Uint16Array(3 * size), size)
            : new THREE.BufferAttribute(
                floating
                  ? new Float32Array(3 * size)
                  : new Int16Array(3 * size),
                size,
                normalized,
              ).setUsage(THREE.DynamicDrawUsage);
        attribute.name = `authored-${name}`;
        for (let i = 0; i < 3; i++) {
          const value = values[i];
          const scale = storage === "unnormalized-int16" ? 100 : 1;
          attribute.setXYZ(
            i,
            value[0] * scale,
            value[1] * scale,
            value[2] * scale,
          );
          if (size === 4) attribute.setW(i, value[3]);
        }
        geometry.setAttribute(name, attribute);
        const decoded = new Float32Array(3 * size);
        for (let i = 0; i < 3; i++) {
          new THREE.Vector3()
            .fromBufferAttribute(attribute, i)
            .toArray(decoded, i * size);
          if (size === 4) decoded[i * size + 3] = attribute.getW(i);
        }
        expected.setAttribute(name, new THREE.BufferAttribute(decoded, size));
      }
      if (data) for (let i = 0; i < 3; i++) data.array[i * 12 + 11] = 97;
      for (const attribute of Object.values(geometry.attributes))
        originalArrays.push({
          attribute,
          bytes: new Uint8Array(attribute.array.buffer).slice(),
        });
      const uv = new THREE.BufferAttribute(
        new Uint16Array([0, 65535, 32768, 16384, 65535, 0]),
        2,
        true,
      );
      const color = new THREE.BufferAttribute(
        new Uint8Array([255, 128, 32, 32, 64, 255, 255, 0, 128]),
        3,
        true,
      );
      geometry.setAttribute("uv", uv);
      geometry.setAttribute("color", color);
      geometry.setIndex([0, 1, 2]);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(7.2, -3.5, 2.1);
      mesh.rotation.set(0.7, -1.2, 0.6);
      mesh.scale.set(1.4, 0.6, 2.3);
      const parent = new THREE.Group();
      parent.position.set(-2, 4, 9);
      parent.rotation.set(-0.3, 0.9, 0.1);
      parent.scale.set(0.75, 1.7, 0.8);
      parent.add(mesh);
      const scene = new THREE.Group();
      scene.add(parent);
      scene.updateMatrixWorld(true);
      expected.applyMatrix4(mesh.matrixWorld);
      try {
        (modelCache as unknown as ModelCacheInternals).bakeTransformsToGeometry(
          scene,
        );
        for (const name of ["position", "normal", "tangent"]) {
          const actual = mesh.geometry.getAttribute(name);
          expect(actual.array).toBeInstanceOf(Float32Array);
          expect(actual.normalized).toBe(false);
          // Three's existing interleaved clone omits the attribute name.
          expect(actual.name).toBe(interleaved ? "" : `authored-${name}`);
          for (let i = 0; i < 3; i++) {
            const expectedAttribute = expected.getAttribute(name);
            expect(actual.getX(i)).toBe(expectedAttribute.getX(i));
            expect(actual.getY(i)).toBe(expectedAttribute.getY(i));
            expect(actual.getZ(i)).toBe(expectedAttribute.getZ(i));
            if (name === "tangent") expect(actual.getW(i)).toBe(tangents[i][3]);
          }
        }
        for (const { attribute, bytes } of originalArrays)
          expect(new Uint8Array(attribute.array.buffer)).toEqual(bytes);
        for (const name of ["uv", "color"]) {
          expect(mesh.geometry.getAttribute(name).array).toEqual(
            geometry.getAttribute(name).array,
          );
          expect(mesh.geometry.getAttribute(name).normalized).toBe(true);
        }
        expect(mesh.geometry.index!.array).toEqual(geometry.index!.array);
        expect(mesh.matrixWorld.elements).toEqual(new THREE.Matrix4().elements);
        expect(parent.matrixWorld.elements).toEqual(
          new THREE.Matrix4().elements,
        );
        expected.computeBoundingBox();
        expected.computeBoundingSphere();
        expect(mesh.geometry.boundingBox).toEqual(expected.boundingBox);
        expect(mesh.geometry.boundingSphere).toEqual(expected.boundingSphere);
      } finally {
        expected.dispose();
        geometry.dispose();
        if (mesh.geometry !== geometry) mesh.geometry.dispose();
        material.dispose();
      }
    },
  );

  it.each([
    THREE.MeshStandardMaterial,
    THREE.MeshPhysicalMaterial,
    MeshStandardNodeMaterial,
    THREE.MeshPhysicalNodeMaterial,
  ])(
    "retains authored PBR factors and data maps from %s on repeated setup",
    (MaterialClass) => {
      for (const [metalness, roughness] of [
        [0, 1],
        [0.73, 0.28],
        [1, 0],
      ]) {
        const geometry = new THREE.BoxGeometry();
        const arm = new THREE.DataTexture(
          new Uint8Array([51, 102, 204, 255]),
          1,
          1,
        );
        const normal = new THREE.DataTexture(
          new Uint8Array([128, 128, 255, 255]),
          1,
          1,
        );
        const source = new MaterialClass();
        source.metalness = metalness;
        source.roughness = roughness;
        source.envMapIntensity = 0;
        source.roughnessMap = arm;
        source.metalnessMap = arm;
        source.aoMap = arm;
        source.aoMapIntensity = 0.63;
        source.normalMap = normal;
        source.normalScale.set(0.6, -0.7);
        source.alphaTest = 0.41;
        const mesh = new THREE.Mesh(geometry, source);
        const scene = new THREE.Group();
        scene.add(mesh);
        try {
          const internals = modelCache as unknown as ModelCacheInternals;
          internals.setupMaterials(scene);
          const converted = mesh.material;
          internals.setupMaterials(scene);
          expect(mesh.material).toBe(converted);
          expect(mesh.material).toBeInstanceOf(MeshStandardNodeMaterial);
          expect(mesh.material).toMatchObject({
            metalness,
            roughness,
            envMapIntensity: 0,
            alphaTest: 0.41,
            roughnessMap: arm,
            metalnessMap: arm,
            aoMap: arm,
            aoMapIntensity: 0.63,
            normalMap: normal,
          });
          expect(mesh.material.normalScale.toArray()).toEqual([0.6, -0.7]);
          expect(arm.colorSpace).toBe(THREE.NoColorSpace);
          expect(normal.colorSpace).toBe(THREE.NoColorSpace);
          expect(arm.image.data).toEqual(new Uint8Array([51, 102, 204, 255]));
        } finally {
          geometry.dispose();
          source.dispose();
          if (mesh.material !== source) mesh.material.dispose();
          arm.dispose();
          normal.dispose();
        }
      }
    },
  );

  it("converts one source material once across static LOD meshes", () => {
    const geometry = new THREE.BoxGeometry();
    const map = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255]),
      1,
      1,
    );
    const original = new THREE.MeshStandardMaterial({ map, roughness: 0.92 });
    const scene = new THREE.Group();
    for (let i = 0; i < 9; i++) scene.add(new THREE.Mesh(geometry, original));
    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);
    const materials = scene.children.map(
      (child) =>
        (child as THREE.Mesh).material as THREE.MeshStandardNodeMaterial,
    );
    expect(new Set(materials).size).toBe(1);
    expect(materials[0]).not.toBe(original);
    expect(materials[0].map).toBe(map);
    expect(materials[0].roughness).toBe(0.92);
    geometry.dispose();
    original.dispose();
    materials[0].dispose();
    map.dispose();
  });

  it("keeps different effective vertex-color variants separate without converting each twice", () => {
    const plain = new THREE.BoxGeometry();
    const colored = plain.clone();
    colored.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        new Float32Array(colored.getAttribute("position").count * 3).fill(1),
        3,
      ),
    );
    const original = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    for (const geometry of [plain, colored, plain, colored])
      scene.add(new THREE.Mesh(geometry, original));
    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);
    const materials = scene.children.map(
      (child) =>
        (child as THREE.Mesh).material as THREE.MeshStandardNodeMaterial,
    );
    expect(materials[0]).toBe(materials[2]);
    expect(materials[1]).toBe(materials[3]);
    expect(materials[0]).not.toBe(materials[1]);
    expect(materials[0].vertexColors).toBe(false);
    expect(materials[1].vertexColors).toBe(true);
    expect(original.vertexColors).toBe(false);
    plain.dispose();
    colored.dispose();
    original.dispose();
    for (const material of new Set(materials)) material.dispose();
  });

  it("computes normals before converting meshes to lit WebGPU materials", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3),
    );

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    );
    const scene = new THREE.Scene();
    scene.add(mesh);

    (modelCache as unknown as ModelCacheInternals).setupMaterials(scene);

    expect(mesh.geometry.attributes.normal).toBeDefined();
    expect(mesh.material).toBeInstanceOf(MeshStandardNodeMaterial);
  });
});
