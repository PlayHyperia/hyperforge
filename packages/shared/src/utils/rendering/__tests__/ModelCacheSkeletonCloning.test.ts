import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import THREE from "../../../extras/three/three";
import { World } from "../../../core/World";
import { ClientLoader } from "../../../systems/client/ClientLoader";
import { modelCache } from "../ModelCache";

type LoadedModel = Awaited<ReturnType<typeof modelCache.loadModel>>;

// Small, genuine self-contained GLBs. Both joints have identity rest transforms:
// this isolates cloning from the separate transform-baking/import contract.
function createGLB(skinned: boolean): Buffer {
  const parts: Buffer[] = [];
  const bufferViews: {
    buffer: number;
    byteOffset: number;
    byteLength: number;
  }[] = [];
  let byteOffset = 0;
  function add(values: Float32Array | Uint16Array): number {
    const data = Buffer.from(
      values.buffer,
      values.byteOffset,
      values.byteLength,
    );
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length });
    const padding = Buffer.alloc((4 - (data.length % 4)) % 4);
    parts.push(data, padding);
    byteOffset += data.length + padding.length;
    return index;
  }
  const positions = add(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0]));
  const joints = add(new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const weights = add(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const inverseBind = add(
    new Float32Array([
      ...new THREE.Matrix4().elements,
      ...new THREE.Matrix4().elements,
    ]),
  );
  const times = add(new Float32Array([0, 1]));
  const translations = add(new Float32Array([0, 0, 0, 2, 0, 0]));
  const json = {
    asset: { version: "2.0", generator: "ModelCache skeleton regression" },
    scene: 0,
    scenes: [{ nodes: skinned ? [0, 3] : [0] }],
    nodes: skinned
      ? [
          { name: "Armature", children: [1] },
          { name: "RootJoint", children: [2] },
          { name: "TipJoint" },
          { name: "Body", mesh: 0, skin: 0 },
        ]
      : [{ name: "StaticBody", mesh: 0, translation: [3, 0, 0] }],
    meshes: [
      {
        primitives: [
          {
            attributes: skinned
              ? { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }
              : { POSITION: 0 },
            material: 0,
          },
        ],
      },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.6, 0.4, 0.2, 1] } },
    ],
    buffers: [{ byteLength: byteOffset }],
    bufferViews,
    accessors: [
      {
        bufferView: positions,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: joints, componentType: 5123, count: 3, type: "VEC4" },
      { bufferView: weights, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: inverseBind, componentType: 5126, count: 2, type: "MAT4" },
      {
        bufferView: times,
        componentType: 5126,
        count: 2,
        type: "SCALAR",
        min: [0],
        max: [1],
      },
      { bufferView: translations, componentType: 5126, count: 2, type: "VEC3" },
    ],
    ...(skinned
      ? {
          skins: [{ joints: [1, 2], skeleton: 1, inverseBindMatrices: 3 }],
          animations: [
            {
              name: "Walk",
              samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }],
              channels: [
                { sampler: 0, target: { node: 1, path: "translation" } },
              ],
            },
          ],
        }
      : {}),
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([
    text,
    Buffer.alloc((4 - (text.length % 4)) % 4, 0x20),
  ]);
  const binary = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonChunk.length + binary.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonChunk, binaryHeader, binary]);
}

function getMesh(scene: THREE.Object3D): THREE.Mesh {
  let mesh: THREE.Mesh | undefined;
  scene.traverse((node) => {
    if (node instanceof THREE.Mesh) mesh = node;
  });
  if (!mesh) throw new Error("Parsed GLB has no mesh");
  return mesh;
}

async function withThreeLoadPaths(
  skinned: boolean,
  verify: (models: LoadedModel[], url: string) => Promise<void> | void,
): Promise<void> {
  const bytes = createGLB(skinned);
  const responses: ServerResponse[] = [];
  let requests = 0;
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
  const models: LoadedModel[] = [];
  let url = "";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP address");
    url = `http://127.0.0.1:${address.port}/${skinned ? "skinned" : "static"}.glb`;
    const initialClones = modelCache.getStats().totalClones;
    const fresh = modelCache.loadModel(url, world);
    // A real HTTP request proves the fresh parse is in progress. The second
    // call must use ModelCache's in-flight path, not a second completed hit.
    await firstRequest;
    const inFlight = modelCache.loadModel(url, world);
    for (const response of responses) {
      response.writeHead(200, { "Content-Type": "model/gltf-binary" });
      response.end(bytes);
    }
    models.push(...(await Promise.all([fresh, inFlight])));
    models.push(await modelCache.loadModel(url, world));
    expect(models.map((model) => model.fromCache)).toEqual([false, true, true]);
    expect(requests).toBe(1);
    expect(modelCache.getStats().totalClones - initialClones).toBe(3);
    expect(modelCache.has(url)).toBe(true);
    await verify(models, url);
  } finally {
    for (const model of models) {
      model.scene.traverse((node) => {
        if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
      });
    }
    modelCache.remove(url);
    const materials = new Set<THREE.Material>();
    for (const model of models) {
      const material = getMesh(model.scene).material;
      for (const item of Array.isArray(material) ? material : [material])
        materials.add(item);
    }
    for (const material of materials) material.dispose();
    world.destroy();
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("ModelCache real GLB skeleton cloning", () => {
  it("isolates fresh, in-flight and cached actors' poses, skinning and skeleton teardown", async () => {
    await withThreeLoadPaths(true, (models, url) => {
      const meshes = models.map(({ scene }) => {
        const mesh = getMesh(scene);
        if (!(mesh instanceof THREE.SkinnedMesh))
          throw new Error("Expected skinned GLB");
        return mesh;
      });
      expect(new Set(meshes.map((mesh) => mesh.skeleton)).size).toBe(3);
      expect(new Set(meshes.flatMap((mesh) => mesh.skeleton.bones)).size).toBe(
        6,
      );
      for (const [index, mesh] of meshes.entries()) {
        expect(mesh.skeleton.bones).toHaveLength(2);
        for (const bone of mesh.skeleton.bones) {
          expect(models[index].scene.getObjectByName(bone.name)).toBe(bone);
        }
        expect(mesh.geometry).toBe(meshes[0].geometry);
        expect(mesh.material).toBe(meshes[0].material);
        expect(models[index].animations).toBe(models[0].animations);
        expect(mesh.skeleton.boneMatrices).not.toBe(
          meshes[(index + 1) % 3].skeleton.boneMatrices,
        );
        mesh.skeleton.computeBoneTexture();
      }
      const material = meshes[0].material;
      if (Array.isArray(material))
        throw new Error("Expected single GLB material");
      expect(modelCache.isManagedMaterial(material)).toBe(true);
      const originalPositions = Array.from(
        meshes[0].geometry.attributes.position.array,
      );
      const mixers = models.map(({ scene, animations }) => {
        const mixer = new THREE.AnimationMixer(scene);
        mixer.clipAction(animations[0]).play();
        return mixer;
      });
      function xAt(index: number, time: number): number {
        mixers[index].setTime(time);
        models[index].scene.updateMatrixWorld(true);
        meshes[index].skeleton.update();
        return meshes[index].getVertexPosition(0, new THREE.Vector3()).x;
      }
      try {
        expect(xAt(0, 0.25)).toBeCloseTo(1.5);
        expect(xAt(1, 0.75)).toBeCloseTo(2.5);
        expect(xAt(2, 0)).toBeCloseTo(1);
        expect(meshes[0].skeleton.bones[0].position.x).toBeCloseTo(0.5);
        expect(meshes[1].skeleton.bones[0].position.x).toBeCloseTo(1.5);
        expect(meshes[2].skeleton.bones[0].position.x).toBe(0);
        expect(
          Array.from(meshes[0].geometry.attributes.position.array),
        ).toEqual(originalPositions);

        let geometryDisposals = 0;
        let materialDisposals = 0;
        let survivorTextureDisposals = 0;
        meshes[0].geometry.addEventListener(
          "dispose",
          () => geometryDisposals++,
        );
        material.addEventListener("dispose", () => materialDisposals++);
        const survivorTexture = meshes[1].skeleton.boneTexture;
        if (!survivorTexture) throw new Error("Expected bone texture");
        survivorTexture.addEventListener(
          "dispose",
          () => survivorTextureDisposals++,
        );
        mixers[0].stopAllAction();
        mixers[0].uncacheRoot(models[0].scene);
        models[0].scene.removeFromParent();
        meshes[0].skeleton.dispose();
        expect(meshes[0].skeleton.boneTexture).toBeNull();
        expect(meshes[1].skeleton.boneTexture).toBe(survivorTexture);
        expect(survivorTextureDisposals).toBe(0);
        expect(geometryDisposals).toBe(0);
        expect(materialDisposals).toBe(0);
        expect(xAt(1, 0.5)).toBeCloseTo(2);
        expect(xAt(2, 0.125)).toBeCloseTo(1.25);
        expect(modelCache.remove(url)).toBe(true);
        expect(geometryDisposals).toBe(1);
        expect(materialDisposals).toBe(0);
        expect(modelCache.remove(url)).toBe(false);
        expect(geometryDisposals).toBe(1);
      } finally {
        for (const [index, mixer] of mixers.entries()) {
          mixer.stopAllAction();
          mixer.uncacheRoot(models[index].scene);
        }
      }
    });
  });

  it("preserves static GLB transform baking, shared resources and clone accounting", async () => {
    await withThreeLoadPaths(false, (models) => {
      const meshes = models.map(({ scene }) => getMesh(scene));
      expect(new Set(models.map((model) => model.scene)).size).toBe(3);
      expect(new Set(meshes).size).toBe(3);
      for (const [index, mesh] of meshes.entries()) {
        expect(mesh).not.toBeInstanceOf(THREE.SkinnedMesh);
        expect(mesh.geometry).toBe(meshes[0].geometry);
        expect(mesh.material).toBe(meshes[0].material);
        expect(mesh.geometry.attributes.position.getX(0)).toBe(4);
        expect(mesh.position.x).toBe(0);
        expect(models[index].animations).toEqual([]);
      }
      meshes[0].position.x = 7;
      expect(meshes[1].position.x).toBe(0);
      expect(meshes[2].position.x).toBe(0);
    });
  });
});
