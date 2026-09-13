import { describe, expect, it } from "vitest";
import THREE, {
  MeshStandardNodeMaterial,
  float,
} from "../../../extras/three/three";
import {
  decodeProcessedModel,
  encodeProcessedModel,
  identifyProcessedModelSource,
  PROCESSED_MODEL_LIMITS,
  type ProcessedModelRecord,
} from "../ProcessedModelCodec";

// Real GLB containers and real Three CPU objects; no renderer or IndexedDB impersonation.
function glb(extra: Record<string, unknown> = {}): ArrayBuffer {
  const json = new TextEncoder().encode(
    JSON.stringify({ asset: { version: "2.0" }, scenes: [{}], ...extra }),
  );
  const size = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + size),
    view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}
function fixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 3, 0], 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  );
  geometry.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      [1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1],
      4,
    ),
  );
  for (const name of ["uv", "uv1", "uv2", "uv3"])
    geometry.setAttribute(
      name,
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2),
    );
  const backing = new Uint8Array([
    91, 91, 255, 128, 0, 0, 127, 255, 32, 64, 96, 91,
  ]);
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Uint8Array(backing.buffer, 2, 9), 3, true),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.addGroup(0, 3, 0);
  geometry.setDrawRange(0, 3);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1, -2, -3),
    new THREE.Vector3(4, 5, 6),
  );
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(1, 2, 3), 12);
  geometry.userData = { collisionHint: "keep" };
  const arm = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(127), 4, 4);
  arm.name = "shared ARM";
  arm.channel = 1;
  arm.wrapS = THREE.RepeatWrapping;
  arm.wrapT = THREE.MirroredRepeatWrapping;
  arm.minFilter = THREE.LinearMipmapLinearFilter;
  arm.magFilter = THREE.LinearFilter;
  arm.generateMipmaps = true;
  arm.flipY = true;
  arm.anisotropy = 8;
  arm.unpackAlignment = 4;
  arm.repeat.set(2, 3);
  arm.offset.set(0.2, 0.4);
  arm.center.set(0.5, 0.5);
  arm.rotation = 0.35;
  arm.updateMatrix();
  arm.matrixAutoUpdate = false;
  arm.userData = { role: "ARM" };
  const material = new MeshStandardNodeMaterial();
  material.name = "shared material";
  material.aoMap = arm;
  material.roughnessMap = arm;
  material.metalnessMap = arm;
  material.color.setRGB(0.123456789, 0.987654321, 1.75);
  material.emissive.setRGB(2.125, 0.0001234, 0.5);
  material.metalness = 0.7;
  material.roughness = 0.65;
  material.envMapIntensity = 1.75;
  material.alphaTest = 0.35;
  material.shadowSide = THREE.BackSide;
  material.normalScale.set(0.7, -0.8);
  material.userData = { authored: { keep: true } };
  const scene = new THREE.Group();
  scene.name = "root";
  scene.userData = { extras: "keep" };
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `LOD${i}`;
    mesh.position.set(i, 2, 3);
    mesh.layers.set(i);
    mesh.renderOrder = i;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = i !== 2;
    mesh.updateMatrix();
    scene.add(mesh);
  }
  return { scene, geometry, material, arm };
}
function dispose(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  scene.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      geometries.add(node.geometry);
      for (const m of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        materials.add(m);
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  textures.forEach((t) => t.dispose());
}
async function encoded(f = fixture()) {
  const source = await identifyProcessedModelSource(glb());
  expect(source).not.toBeNull();
  const record = encodeProcessedModel("fixture.glb", source!, f.scene, []);
  expect(record).not.toBeNull();
  return { f, source: source!, record: record! };
}

describe("ProcessedModelCodec exact static CPU representation", () => {
  it.each(["static-r186-rgba8-v1", "static-r186-rgba8-authored-pbr-v2"])(
    "rejects the exact prior %s policy without publishing materials",
    async (policy) => {
      const { f, source, record } = await encoded();
      const stale = structuredClone(record);
      stale.policy = policy;
      if (policy === "static-r186-rgba8-v1")
        stale.materials[0].state.metalness = 0;
      let setups = 0;
      try {
        expect(record.policy).toBe("static-r186-rgba8-float-transform-v3");
        expect(
          decodeProcessedModel(stale, "fixture.glb", source, () => setups++),
        ).toBeNull();
        expect(setups).toBe(0);
        expect(record.materials[0].state.metalness).toBe(0.7);
      } finally {
        dispose(f.scene);
      }
    },
  );

  it("preserves three LOD aliases, one ARM source and all supported scalar/UV/sampler/bounds state", async () => {
    const { f, source, record } = await encoded();
    let restored: ReturnType<typeof decodeProcessedModel> = null;
    try {
      expect([
        record.materials.length,
        record.textures.length,
        record.sources.length,
        record.geometries.length,
      ]).toEqual([1, 1, 1, 1]);
      expect(record.sources[0].pixels.byteLength).toBe(64);
      restored = decodeProcessedModel(
        structuredClone(record),
        "fixture.glb",
        source,
      );
      expect(restored).not.toBeNull();
      const meshes = restored!.scene.children as THREE.Mesh[];
      expect(meshes[0].geometry).toBe(meshes[2].geometry);
      expect(meshes[0].material).toBe(meshes[2].material);
      const material = meshes[0].material as MeshStandardNodeMaterial;
      expect(material.aoMap).toBe(material.roughnessMap);
      expect(material.aoMap).toBe(material.metalnessMap);
      expect(material.color.toArray()).toEqual(f.material.color.toArray());
      expect(material.emissive.toArray()).toEqual(
        f.material.emissive.toArray(),
      );
      expect(material.alphaTest).toBe(0.35);
      expect(material.envMapIntensity).toBe(1.75);
      expect(material.metalness).toBe(0.7);
      expect(material.aoMap!.source).not.toBe(f.arm.source);
      expect(material.aoMap!.channel).toBe(1);
      expect(material.aoMap!.matrix.elements).toEqual(f.arm.matrix.elements);
      expect(material.aoMap!.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      expect(meshes[0].geometry.attributes.color.array).toEqual(
        new Uint8Array([255, 128, 0, 0, 127, 255, 32, 64, 96]),
      );
      expect(meshes[0].geometry.attributes.color.normalized).toBe(true);
      expect(
        encodeProcessedModel("fixture.glb", source, restored!.scene, []),
      ).toEqual(record);
    } finally {
      dispose(f.scene);
      if (restored) dispose(restored.scene);
    }
  });

  it("keeps distinct same-name materials and texture views while retaining shared source identity", async () => {
    const f = fixture(),
      other = f.arm.clone();
    other.channel = 3;
    other.offset.set(0.8, 0.1);
    other.updateMatrix();
    const second = f.material.clone();
    second.aoMap = other;
    second.roughnessMap = other;
    second.metalnessMap = other;
    (f.scene.children[1] as THREE.Mesh).material = second;
    const { source, record } = await encoded(f);
    const restored = decodeProcessedModel(
      structuredClone(record),
      "fixture.glb",
      source,
    );
    try {
      expect([
        record.materials.length,
        record.textures.length,
        record.sources.length,
      ]).toEqual([2, 2, 1]);
      expect(restored).not.toBeNull();
      const meshes = restored!.scene.children as THREE.Mesh[];
      const a = meshes[0].material as MeshStandardNodeMaterial,
        b = meshes[1].material as MeshStandardNodeMaterial;
      expect(a).not.toBe(b);
      expect(a.name).toBe(b.name);
      expect(a.aoMap).not.toBe(b.aoMap);
      expect(a.aoMap!.source).toBe(b.aoMap!.source);
      expect(b.aoMap!.channel).toBe(3);
      expect(b.aoMap!.offset.toArray()).toEqual([0.8, 0.1]);
    } finally {
      dispose(f.scene);
      if (restored) dispose(restored.scene);
    }
  });

  it("deinterleaves raw normalized integer values without denormalizing twice", async () => {
    const f = fixture();
    const data = new THREE.InterleavedBuffer(
      new Uint8Array([8, 255, 128, 0, 8, 0, 127, 255, 8, 32, 64, 96]),
      4,
    );
    f.geometry.setAttribute(
      "color",
      new THREE.InterleavedBufferAttribute(data, 3, 1, true),
    );
    const { source, record } = await encoded(f);
    const result = decodeProcessedModel(record, "fixture.glb", source);
    try {
      expect(result).not.toBeNull();
      expect(
        (
          result!.scene.children[0] as THREE.Mesh
        ).geometry.attributes.color.getY(0),
      ).toBe(128 / 255);
    } finally {
      dispose(f.scene);
      if (result) dispose(result.scene);
    }
  });

  it.each([
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
  ] as const)(
    "rejects a non-DataTexture %s for the whole scene without touching borrowed resources",
    async (slot) => {
      const f = fixture(),
        unsupported = new THREE.Texture();
      f.material[slot] = unsupported;
      const source = (await identifyProcessedModelSource(glb()))!;
      let disposals = 0;
      unsupported.addEventListener("dispose", () => disposals++);
      f.arm.addEventListener("dispose", () => disposals++);
      expect(
        encodeProcessedModel("fixture.glb", source, f.scene, []),
      ).toBeNull();
      expect(disposals).toBe(0);
      expect(f.material[slot]).toBe(unsupported);
      dispose(f.scene);
    },
  );

  it("rejects HDR/instanced/morph/custom-node/custom-geometry and upload-callback data", async () => {
    const source = (await identifyProcessedModelSource(glb()))!;
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      (f) => {
        f.arm.type = THREE.HalfFloatType;
      },
      (f) => {
        f.material.colorNode = float(0.5);
      },
      (f) => {
        f.geometry.setAttribute(
          "position",
          new THREE.InstancedBufferAttribute(new Float32Array(9), 3),
        );
      },
      (f) => {
        f.geometry.setAttribute(
          "position",
          new THREE.InterleavedBufferAttribute(
            new THREE.InstancedInterleavedBuffer(new Float32Array(9), 3),
            3,
            0,
          ),
        );
      },
      (f) => {
        const data = new THREE.InterleavedBuffer(new Float32Array(9), 3);
        data.onUpload(() => undefined);
        f.geometry.setAttribute(
          "position",
          new THREE.InterleavedBufferAttribute(data, 3, 0),
        );
      },
      (f) => {
        f.geometry.morphAttributes.position = [f.geometry.attributes.position];
      },
      (f) => {
        Reflect.set(f.geometry, "customGeometryPolicy", true);
      },
      (f) => {
        f.scene.add(new THREE.SkinnedMesh(f.geometry, f.material));
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      try {
        mutate(f);
        expect(
          encodeProcessedModel("fixture.glb", source, f.scene, []),
        ).toBeNull();
      } finally {
        dispose(f.scene);
      }
    }
    const f = fixture();
    try {
      expect(
        encodeProcessedModel("fixture.glb", source, f.scene, [
          new THREE.AnimationClip("not-static", 1, []),
        ]),
      ).toBeNull();
    } finally {
      dispose(f.scene);
    }
  });

  it("rejects a real DOM image-backed normal/ARM texture as a complete-scene fallback", async () => {
    // Actual DOM objects, not a browser/GPU color-readback or ImageBitmap claim.
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><img width='4' height='4'>");
    const f = fixture();
    const image = dom.window.document.querySelector("img")!;
    const texture = new THREE.Texture(image);
    f.material.normalMap = texture;
    f.material.roughnessMap = texture;
    try {
      const source = (await identifyProcessedModelSource(glb()))!;
      expect(
        encodeProcessedModel("dom-source.glb", source, f.scene, []),
      ).toBeNull();
      expect(f.material.normalMap).toBe(texture);
      expect(texture.source.data).toBe(image);
    } finally {
      dispose(f.scene);
      dom.window.close();
    }
  });

  it("rejects corrupt metadata/references/state before setup or partial publication", async () => {
    const { f, source, record } = await encoded();
    const mutations: ((r: ProcessedModelRecord) => void)[] = [
      (r) => {
        r.version = 6;
      },
      (r) => {
        r.policy = "different-material-policy";
      },
      (r) => {
        r.materials[0].state.colorNode = 123;
      },
      (r) => {
        r.materials[0].state.outputNode = 123;
      },
      (r) => {
        r.materials[0].state.shadowSide = 123;
      },
      (r) => {
        r.materials.push(structuredClone(r.materials[0]));
      },
      (r) => {
        r.nodes = Array(PROCESSED_MODEL_LIMITS.nodes + 1).fill(r.nodes[0]);
      },
      (r) => {
        r.materials[0].state.isNodeMaterial = false;
      },
      (r) => {
        r.materials[0].state.alphaTest = Infinity;
      },
      (r) => {
        r.sources[0].width++;
      },
      (r) => {
        r.textures[0].source = 999;
      },
      (r) => {
        r.textures[0].state.channel = 4;
      },
      (r) => {
        r.textures[0].state.wrapS = "1000";
      },
      (r) => {
        delete r.geometries[0].attributes.uv1;
      },
      (r) => {
        r.nodes[0].children.push(0);
      },
      (r) => {
        r.geometries[0].groups[0].count = 100;
      },
      (r) => {
        r.geometries[0].attributes.position.data = new ArrayBuffer(2);
      },
    ];
    let setup = 0;
    try {
      for (const mutate of mutations) {
        const bad = structuredClone(record);
        mutate(bad);
        expect(
          decodeProcessedModel(bad, "fixture.glb", source, () => setup++),
        ).toBeNull();
      }
      expect(setup).toBe(0);
    } finally {
      dispose(f.scene);
    }
  });

  it("bounds aggregate extras across individually-small objects", async () => {
    const { f, source, record } = await encoded();
    const half = "x".repeat(PROCESSED_MODEL_LIMITS.jsonBytes / 4 + 1);
    record.nodes[0].userData = { a: half };
    record.nodes[1].userData = { a: half };
    try {
      expect(decodeProcessedModel(record, "fixture.glb", source)).toBeNull();
      f.scene.userData = { a: half };
      f.geometry.userData = { a: half };
      expect(
        encodeProcessedModel("fixture.glb", source, f.scene, []),
      ).toBeNull();
    } finally {
      dispose(f.scene);
    }
  });

  it("rolls back each newly owned material/texture once when real consumer setup throws", async () => {
    const { f, source, record } = await encoded();
    let sourceDisposals = 0,
      materialsDisposed = 0,
      texturesDisposed = 0;
    f.material.addEventListener("dispose", () => sourceDisposals++);
    f.arm.addEventListener("dispose", () => sourceDisposals++);
    let geometriesDisposed = 0;
    const descriptor = Object.getOwnPropertyDescriptor(
      THREE.BufferGeometry.prototype,
      "dispose",
    )!;
    const originalDispose = THREE.BufferGeometry.prototype.dispose;
    Object.defineProperty(THREE.BufferGeometry.prototype, "dispose", {
      ...descriptor,
      value: function (this: THREE.BufferGeometry) {
        geometriesDisposed++;
        return originalDispose.call(this);
      },
    });
    try {
      expect(
        decodeProcessedModel(record, "fixture.glb", source, (material) => {
          material.addEventListener("dispose", () => {
            materialsDisposed++;
            throw new Error("consumer disposal listener");
          });
          material.aoMap!.addEventListener("dispose", () => texturesDisposed++);
          throw new Error("consumer setup rejection");
        }),
      ).toBeNull();
      expect([materialsDisposed, texturesDisposed, sourceDisposals]).toEqual([
        1, 1, 0,
      ]);
      expect(geometriesDisposed).toBe(1);
    } finally {
      Object.defineProperty(
        THREE.BufferGeometry.prototype,
        "dispose",
        descriptor,
      );
      dispose(f.scene);
    }
  });
});

describe("exact self-contained source provenance", () => {
  it("hashes all exact GLB bytes, distinguishing equal-size changed content", async () => {
    const a = glb({ extras: { revision: "a" } }),
      b = glb({ extras: { revision: "b" } });
    expect(a.byteLength).toBe(b.byteLength);
    const sa = await identifyProcessedModelSource(a),
      sb = await identifyProcessedModelSource(b);
    expect(sa!.sha256).not.toBe(sb!.sha256);
    expect(await identifyProcessedModelSource(a.slice(0))).toEqual(sa);
    const f = fixture();
    try {
      const record = encodeProcessedModel("same-url", sa!, f.scene, []);
      expect(decodeProcessedModel(record, "same-url", sb!)).toBeNull();
    } finally {
      dispose(f.scene);
    }
  });
  it.each([
    { buffers: [{ uri: "external.bin", byteLength: 16 }] },
    { images: [{ uri: "external.png" }] },
    { extensionsUsed: ["UNQUALIFIED_resource_loader"] },
    { extensionsRequired: ["KHR_texture_transform"] },
    { materials: [{ extensions: { UNDECLARED_external: {} } }] },
    {
      extensionsUsed: ["KHR_texture_transform"],
      materials: [
        { extensions: { KHR_texture_transform: { uri: "external" } } },
      ],
    },
  ])("rejects incomplete dependency closure %j", async (input) => {
    expect(await identifyProcessedModelSource(glb(input))).toBeNull();
  });
  it("rejects malformed GLB length and accepts declared embedded texture-transform metadata", async () => {
    const bytes = glb();
    new DataView(bytes).setUint32(8, bytes.byteLength - 4, true);
    expect(await identifyProcessedModelSource(bytes)).toBeNull();
    expect(
      await identifyProcessedModelSource(
        glb({
          extensionsUsed: ["KHR_texture_transform"],
          extensionsRequired: ["KHR_texture_transform"],
          materials: [{ extensions: { KHR_texture_transform: {} } }],
        }),
      ),
    ).not.toBeNull();
  });
});
