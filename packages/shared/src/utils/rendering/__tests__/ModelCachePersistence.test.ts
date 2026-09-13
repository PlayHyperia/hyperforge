import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
function makeGLB(
  corrupt = false,
  pbr: AuthoredPbr = DEFAULT_PBR,
  bufferUri?: string,
): ArrayBuffer {
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
      buffers: [
        {
          byteLength: positions.byteLength,
          ...(bufferUri ? { uri: bufferUri } : {}),
        },
      ],
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
  concurrency: "in-flight" | "same-turn" = "in-flight",
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
    const sameTurn =
      concurrency === "same-turn"
        ? modelCache.loadModel(url, world)
        : undefined;
    // Hold an actual HTTP response until the second call joins the in-flight
    // load. This tests the existing cache path without impersonating a loader.
    await firstRequest;
    const pending = sameTurn ?? modelCache.loadModel(url, world);
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

async function withLoadLifecycle(
  verify: (context: {
    url: string;
    world: World;
    createWorld: () => World;
    load: (world?: World) => Promise<Loaded>;
    waitForRequests: (count: number) => Promise<void>;
    respond: (index: number, bytes?: ArrayBuffer | Uint8Array) => void;
    requests: ServerResponse[];
    parsed: {
      metalness: number;
      disposals: Map<THREE.EventDispatcher, number>;
    }[];
  }) => Promise<void>,
) {
  const requests: ServerResponse[] = [];
  const server = createServer((_request, response) => requests.push(response));
  const worlds: World[] = [];
  const createWorld = () => {
    const world = new World();
    world.register("loader", ClientLoader);
    worlds.push(world);
    return world;
  };
  const world = createWorld();
  const pending: Promise<Loaded>[] = [];
  const loaded: Loaded[] = [];
  const parsed: {
    metalness: number;
    disposals: Map<THREE.EventDispatcher, number>;
  }[] = [];
  const parser: unknown = Reflect.get(modelCache, "gltfLoader");
  if (!(parser instanceof GLTFLoader)) throw new Error("No real GLTFLoader");
  const descriptor = Object.getOwnPropertyDescriptor(parser, "parseAsync");
  const original = parser.parseAsync;
  // Observe actual parser-owned resources without substituting parsing, bytes,
  // network, material setup or its return value. No renderer/IndexedDB claims.
  parser.parseAsync = function (...args) {
    return original.apply(this, args).then((gltf) => {
      const disposals = new Map<THREE.EventDispatcher, number>();
      const sources = meshes(gltf.scene);
      for (const mesh of sources) {
        for (const resource of [
          mesh.geometry,
          ...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]),
        ]) {
          if (disposals.has(resource)) continue;
          disposals.set(resource, 0);
          resource.addEventListener("dispose", () =>
            disposals.set(resource, disposals.get(resource)! + 1),
          );
        }
      }
      parsed.push({
        metalness: (sources[0].material as THREE.MeshStandardMaterial)
          .metalness,
        disposals,
      });
      return gltf;
    });
  };
  let url = "";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP address");
    url = `http://127.0.0.1:${address.port}/model.glb`;
    await verify({
      url,
      world,
      createWorld,
      load: (sourceWorld = world) => {
        const promise = modelCache.loadModel(url, sourceWorld);
        pending.push(promise);
        // Observe real outcomes for cleanup; rejected waves remain caller-visible.
        void promise.then(
          (result) => loaded.push(result),
          () => undefined,
        );
        return promise;
      },
      waitForRequests: async (count) => {
        while (requests.length < count) await once(server, "request");
      },
      respond: (index, bytes = makeGLB()) => {
        requests[index].writeHead(200, { "Content-Type": "model/gltf-binary" });
        requests[index].end(Buffer.from(bytes));
      },
      requests,
      parsed,
    });
  } finally {
    server.closeAllConnections();
    await Promise.allSettled(pending);
    if (descriptor) Object.defineProperty(parser, "parseAsync", descriptor);
    else Reflect.deleteProperty(parser, "parseAsync");
    modelCache.remove(url);
    const materials = new Set<THREE.Material>();
    for (const result of loaded) {
      for (const mesh of meshes(result.scene)) {
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material])
          materials.add(material);
      }
    }
    for (const material of materials) material.dispose();
    for (const instance of worlds) instance.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("ModelCache cold-load ownership with real HTTP and World lifetimes", () => {
  it("shares one rejected parse and permits one clean concurrent retry", async () => {
    await withLoadLifecycle(
      async ({ load, world, url, waitForRequests, respond, requests }) => {
        const wave = Promise.allSettled([load(), load(), load()]);
        await waitForRequests(1);
        respond(0, new TextEncoder().encode("not a GLB or glTF document"));
        const failures = await wave;
        expect(failures.map((result) => result.status)).toEqual([
          "rejected",
          "rejected",
          "rejected",
        ]);
        const reasons = failures.map((result) =>
          result.status === "rejected" ? result.reason : null,
        );
        expect(reasons[1]).toBe(reasons[0]);
        expect(reasons[2]).toBe(reasons[0]);
        expect(modelCache.has(url)).toBe(false);
        await world.getSystem<ClientLoader>("loader")!.clearCachedFile(url);
        const retry = Promise.all([load(), load(), load()]);
        await waitForRequests(2);
        respond(1);
        const results = await retry;
        expect(results.map((result) => result.fromCache)).toEqual([
          false,
          true,
          true,
        ]);
        expect(
          new Set(results.map((result) => meshes(result.scene)[0].material))
            .size,
        ).toBe(1);
        expect(requests).toHaveLength(2);
        expect((await load()).fromCache).toBe(true);
      },
    );
  });

  for (const operation of ["remove", "clear"] as const) {
    const invalidate = (url: string) =>
      operation === "clear" ? modelCache.clear() : modelCache.remove(url);
    it(`${operation} can retire same-turn work before its first asynchronous initialization`, async () => {
      await withLoadLifecycle(
        async ({ load, url, requests, waitForRequests, respond }) => {
          const retired = Promise.allSettled([load(), load()]);
          const result = invalidate(url);
          if (operation === "remove") expect(result).toBe(true);
          expect((await retired).map((result) => result.status)).toEqual([
            "rejected",
            "rejected",
          ]);
          expect(requests).toHaveLength(0);
          expect(modelCache.has(url)).toBe(false);
          const next = Promise.all([load(), load()]);
          await waitForRequests(1);
          respond(0);
          expect((await next).map((result) => result.fromCache)).toEqual([
            false,
            true,
          ]);
        },
      );
    });

    for (const oldCompletesFirst of [true, false]) {
      it(`${operation} prevents a retired response from ${oldCompletesFirst ? "erasing a replacement in flight" : "overwriting a replacement already published"}`, async () => {
        await withLoadLifecycle(
          async ({
            load,
            url,
            createWorld,
            waitForRequests,
            respond,
            requests,
          }) => {
            const retired = Promise.allSettled([load(), load()]);
            await waitForRequests(1);
            invalidate(url);
            const replacementWorld = createWorld();
            const first = load(replacementWorld);
            const second = load(replacementWorld);
            await waitForRequests(2);
            if (oldCompletesFirst) {
              respond(0);
              expect(
                (await retired).every((result) => result.status === "rejected"),
              ).toBe(true);
              expect(modelCache.has(url)).toBe(false);
            }
            const third = load(replacementWorld);
            respond(
              1,
              makeGLB(false, { metallicFactor: 0.43, roughnessFactor: 0.31 }),
            );
            const replacement = await Promise.all([first, second, third]);
            expect(replacement.map((result) => result.fromCache)).toEqual([
              false,
              true,
              true,
            ]);
            if (!oldCompletesFirst) {
              respond(0);
              expect(
                (await retired).every((result) => result.status === "rejected"),
              ).toBe(true);
            }
            const current = await load(replacementWorld);
            expect(current.fromCache).toBe(true);
            const material = meshes(current.scene)[0].material;
            expect(material).toBe(meshes(replacement[0].scene)[0].material);
            expect(material).toMatchObject({
              metalness: 0.43,
              roughness: 0.31,
            });
            expect(requests).toHaveLength(2);
          },
        );
      });
    }
    for (const parseSucceeds of [true, false]) {
      it(`${operation} retires an actual GLB parser awaiting its external buffer (${parseSucceeds ? "success is disposed" : "failure cannot retry"})`, async () => {
        await withLoadLifecycle(
          async ({
            load,
            url,
            createWorld,
            waitForRequests,
            respond,
            requests,
            parsed,
          }) => {
            const retired = Promise.allSettled([load(), load()]);
            await waitForRequests(1);
            respond(0, makeGLB(false, DEFAULT_PBR, `${url}/geometry.bin`));
            // This real second HTTP request comes from GLTFLoader, proving that
            // invalidation happens during parsing rather than the file fetch.
            await waitForRequests(2);
            invalidate(url);
            const replacementWorld = createWorld();
            const next = load(replacementWorld);
            await waitForRequests(3);
            respond(
              2,
              makeGLB(false, { metallicFactor: 0.43, roughnessFactor: 0.31 }),
            );
            const replacement = await next;
            respond(
              1,
              parseSucceeds
                ? new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]).buffer
                : new ArrayBuffer(1),
            );
            expect(
              (await retired).every((result) => result.status === "rejected"),
            ).toBe(true);
            const current = await load(replacementWorld);
            expect(meshes(current.scene)[0].material).toBe(
              meshes(replacement.scene)[0].material,
            );
            expect(requests).toHaveLength(3);
            const lateScene = parsed.find(
              (result) => result.metalness === DEFAULT_PBR.metallicFactor,
            );
            if (parseSucceeds) {
              expect(lateScene).toBeDefined();
              expect(lateScene!.disposals.size).toBe(2);
              expect([...lateScene!.disposals.values()]).toEqual([1, 1]);
            } else expect(lateScene).toBeUndefined();
          },
        );
      });
    }
  }
});

describe("ModelCache v7 real GLB/World/ClientLoader integration (CPU, no IndexedDB claim)", () => {
  it("shares one cold representation for calls issued in the same JS turn", async () => {
    await realLoad(
      false,
      async (loaded, _world, _url, _bytes, saves) => {
        expect(loaded.fromCache).toBe(false);
        expect(saves).toHaveLength(1);
      },
      DEFAULT_PBR,
      "same-turn",
    );
  });

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

  it.each(["remove", "clear"] as const)(
    "%s retires cached ownership before disposal callbacks can start a replacement",
    async (operation) => {
      const invalidate = (url: string) =>
        operation === "clear" ? modelCache.clear() : modelCache.remove(url);
      await withLoadLifecycle(
        async ({ load, url, waitForRequests, respond, requests }) => {
          const first = load();
          await waitForRequests(1);
          respond(0);
          const original = await first;
          const mesh = meshes(original.scene)[0];
          let replacement: Promise<Loaded> | undefined;
          let materialDisposals = 0;
          const material = mesh.material as THREE.MeshStandardMaterial;
          material.addEventListener("dispose", () => materialDisposals++);
          mesh.geometry.addEventListener("dispose", () => {
            replacement ??= load();
          });
          invalidate(url);
          expect(replacement).toBeDefined();
          const result = await replacement!;
          expect(result.fromCache).toBe(false);
          expect(meshes(result.scene)[0].geometry).not.toBe(mesh.geometry);
          expect(meshes(result.scene)[0].material).not.toBe(material);
          // Cache removal still preserves materials already borrowed by callers.
          expect(materialDisposals).toBe(0);
          const current = await load();
          expect(current.fromCache).toBe(true);
          expect(meshes(current.scene)[0].geometry).toBe(
            meshes(result.scene)[0].geometry,
          );
          expect(requests).toHaveLength(1);
        },
      );
    },
  );

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
