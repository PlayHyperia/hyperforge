import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { World } from "../../../core/World";
import { ClientLoader } from "../../../systems/client/ClientLoader";
import { modelCache } from "../ModelCache";
import {
  decodeProcessedModel,
  encodeProcessedModel,
  identifyProcessedModelSource,
  type ProcessedModelSource,
} from "../ProcessedModelCodec";

type AuthoredPbr = { metallicFactor?: number; roughnessFactor?: number };
const DEFAULT_PBR = { metallicFactor: 0.75, roughnessFactor: 0.65 };
function makeGLB(corrupt = false, pbr: AuthoredPbr = DEFAULT_PBR): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]);
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: [0, 1, 2].map((i) => ({
        name: `LOD${i}`,
        mesh: 0,
        translation: [i * 3, 0, 0],
        extras: { level: i },
      })),
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          name: "same authored material",
          alphaMode: "MASK",
          alphaCutoff: 0.35,
          pbrMetallicRoughness: {
            baseColorFactor: [0.123456789, 0.333333333, 0.99999999, 1],
            ...pbr,
          },
        },
      ],
      buffers: [{ byteLength: positions.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: corrupt ? 900 : 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [2, 3, 0],
        },
      ],
    }),
  );
  const size = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(28 + size + positions.byteLength),
    view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, size).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  view.setUint32(20 + size, positions.byteLength, true);
  view.setUint32(24 + size, 0x004e4942, true);
  new Uint8Array(bytes, 28 + size).set(new Uint8Array(positions.buffer));
  return bytes;
}
type Loaded = Awaited<ReturnType<typeof modelCache.loadModel>>;
function meshes(scene: THREE.Object3D) {
  const result: THREE.Mesh[] = [];
  scene.traverse((node) => {
    if (node instanceof THREE.Mesh) result.push(node);
  });
  return result;
}
function disposeMaterials(scene: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  for (const mesh of meshes(scene))
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      materials.add(material);
  materials.forEach((m) => m.dispose());
}
async function realLoad(
  corrupt: boolean,
  verify: (
    loaded: Loaded,
    world: World,
    url: string,
    bytes: ArrayBuffer,
    saves: ProcessedModelSource[],
  ) => Promise<void>,
  pbr: AuthoredPbr = DEFAULT_PBR,
) {
  const bytes = makeGLB(false, pbr);
  let requests = 0;
  const responses: ServerResponse[] = [];
  let signalRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    signalRequest = resolve;
  });
  const server = createServer((_request, response) => {
    requests++;
    responses.push(response);
    signalRequest();
  });
  const world = new World();
  world.register("loader", ClientLoader);
  const loader = world.getSystem<ClientLoader>("loader")!;
  let url = "",
    loaded: Loaded | undefined;
  const saves: ProcessedModelSource[] = [];
  // Observe, do not replace, the real save method. Node has no native IndexedDB;
  // these receipts prove load provenance, not a successful persistent transaction.
  const descriptor = Object.getOwnPropertyDescriptor(
    modelCache,
    "saveProcessedModel",
  );
  const original: unknown = Reflect.get(modelCache, "saveProcessedModel");
  if (typeof original !== "function") throw new Error("No real save method");
  Object.defineProperty(modelCache, "saveProcessedModel", {
    configurable: true,
    writable: true,
    value: function (
      this: typeof modelCache,
      ...args: [
        string,
        ProcessedModelSource,
        THREE.Object3D,
        THREE.AnimationClip[],
      ]
    ) {
      saves.push(args[1]);
      return Reflect.apply(original, this, args);
    },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No native HTTP address");
    url = `http://127.0.0.1:${address.port}/model.glb`;
    if (corrupt)
      loader.setFile(url, new File([makeGLB(true, pbr)], "model.glb"));
    const first = modelCache.loadModel(url, world);
    // Hold an actual HTTP response until the second call joins the in-flight
    // load. This tests the existing cache path without impersonating a loader.
    await firstRequest;
    const pending = modelCache.loadModel(url, world);
    for (const response of responses) {
      response.writeHead(200, { "Content-Type": "model/gltf-binary" });
      response.end(Buffer.from(bytes));
    }
    const [cold, inFlight] = await Promise.all([first, pending]);
    loaded = cold;
    expect(inFlight.fromCache).toBe(true);
    meshes(cold.scene).forEach((mesh, i) => {
      expect(meshes(inFlight.scene)[i].material).toBe(mesh.material);
      expect(meshes(inFlight.scene)[i].geometry).toBe(mesh.geometry);
    });
    expect(requests).toBe(1);
    await verify(loaded, world, url, bytes, saves);
  } finally {
    if (descriptor)
      Object.defineProperty(modelCache, "saveProcessedModel", descriptor);
    else Reflect.deleteProperty(modelCache, "saveProcessedModel");
    modelCache.remove(url);
    if (loaded) disposeMaterials(loaded.scene);
    world.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("ModelCache v7 real GLB/World/ClientLoader integration (CPU, no IndexedDB claim)", () => {
  it.each([
    {
      pbr: { metallicFactor: 0, roughnessFactor: 1 },
      metalness: 0,
      roughness: 1,
    },
    {
      pbr: { metallicFactor: 1, roughnessFactor: 0 },
      metalness: 1,
      roughness: 0,
    },
    { pbr: {}, metalness: 1, roughness: 1 },
  ])(
    "retains zero, full-metal and omitted glTF factors: $pbr",
    async ({ pbr, metalness, roughness }) => {
      await realLoad(
        false,
        async (loaded) => {
          for (const mesh of meshes(loaded.scene)) {
            expect(mesh.material).toMatchObject({ metalness, roughness });
          }
        },
        pbr,
      );
    },
  );

  it("preserves authored PBR and cutout state through cold loading, memory reuse and processed decoding", async () => {
    await realLoad(false, async (loaded, world, url, bytes, saves) => {
      const source = (await identifyProcessedModelSource(bytes))!;
      expect(saves).toEqual([source]);
      expect(loaded.fromCache).toBe(false);
      const cold = meshes(loaded.scene);
      expect(cold).toHaveLength(3);
      for (const mesh of cold) {
        expect(mesh.material).toBeInstanceOf(MeshStandardNodeMaterial);
        const m = mesh.material as MeshStandardNodeMaterial;
        expect(m.metalness).toBe(0.75);
        expect(m.roughness).toBe(0.65);
        expect(m.alphaTest).toBe(0.35);
      }
      const record = encodeProcessedModel(
        url,
        source,
        loaded.scene,
        loaded.animations,
        loaded.collision,
      );
      expect(record).not.toBeNull();
      const warm = decodeProcessedModel(
        structuredClone(record),
        url,
        source,
        (material) => world.setupMaterial(material),
      );
      try {
        expect(warm).not.toBeNull();
        for (const mesh of meshes(warm!.scene)) {
          expect(mesh.material).toMatchObject({
            metalness: 0.75,
            roughness: 0.65,
            alphaTest: 0.35,
          });
        }
        expect(encodeProcessedModel(url, source, warm!.scene, [])).toEqual(
          record,
        );
        expect(record!.materials.length).toBe(
          new Set(cold.map((mesh) => mesh.material)).size,
        );
        const memory = await modelCache.loadModel(url, world);
        expect(memory.fromCache).toBe(true);
        expect(saves).toHaveLength(1);
        const cached = meshes(memory.scene);
        cold.forEach((mesh, i) => {
          expect(cached[i].material).toBe(mesh.material);
          expect(cached[i].geometry).toBe(mesh.geometry);
          expect(cached[i].material).toMatchObject({
            metalness: 0.75,
            roughness: 0.65,
          });
        });
      } finally {
        if (warm) {
          new Set(meshes(warm.scene).map((mesh) => mesh.geometry)).forEach(
            (g) => g.dispose(),
          );
          disposeMaterials(warm.scene);
        }
      }
    });
  });

  it("does not save a genuine direct-load retry under the corrupted cached File's provenance", async () => {
    await realLoad(true, async (loaded, world, url, bytes, saves) => {
      expect(await identifyProcessedModelSource(makeGLB(true))).not.toBeNull();
      expect(
        (await identifyProcessedModelSource(makeGLB(true)))!.sha256,
      ).not.toBe((await identifyProcessedModelSource(bytes))!.sha256);
      expect(meshes(loaded.scene)).toHaveLength(3);
      expect(saves).toEqual([]);
      expect((await modelCache.loadModel(url, world)).fromCache).toBe(true);
      expect(saves).toEqual([]);
    });
  });
});
