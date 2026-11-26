import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import THREE from "../../../../extras/three/three";
import { modelCache } from "../../../../utils/rendering/ModelCache";
import {
  CompactRockOutcropVisuals,
  type CompactRockPlacement,
} from "../CompactRockOutcropVisuals";

type Document = {
  nodes: {
    name: string;
    mesh: number;
    translation?: [number, number, number];
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews: {
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
};
const owned: { dispose(): void }[] = [];
afterEach(() => {
  for (const value of owned.splice(0)) value.dispose();
});

/** Actual packaged geometry and transforms. DataTextures exercise material
 * ownership only; these CPU tests make no JPEG decode or WebGPU image claim.
 */
function library() {
  const bytes = readFileSync(
    new URL(
      "../../../../../../server/world/assets/rocks/compact-outcrops-v1/rock-moss-set.glb",
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "62c8c753c57b7108f79c98ee0f1bbb2497c27e3fe55a15979765fa02da184c55",
  );
  const length = bytes.readUInt32LE(12);
  const document = JSON.parse(
    bytes.subarray(20, 20 + length).toString(),
  ) as Document;
  const binary = bytes.subarray(28 + length);
  const attribute = (index: number) => {
    const a = document.accessors[index],
      view = document.bufferViews[a.bufferView];
    expect(view.byteStride).toBeUndefined();
    const size = a.type === "VEC3" ? 3 : a.type === "VEC2" ? 2 : 1;
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const componentBytes = a.componentType === 5123 ? 2 : 4;
    const copy = Uint8Array.from(
      binary.subarray(offset, offset + a.count * size * componentBytes),
    ).buffer;
    const data =
      a.componentType === 5126
        ? new Float32Array(copy)
        : a.componentType === 5123
          ? new Uint16Array(copy)
          : new Uint32Array(copy);
    return new THREE.BufferAttribute(data, size);
  };
  const map = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  owned.push(map);
  const material = new THREE.MeshStandardMaterial({
    map,
    normalMap: map,
    roughnessMap: map,
  });
  owned.push(material);
  const scene = new THREE.Group();
  for (const node of document.nodes) {
    const primitive = document.meshes[node.mesh].primitives[0];
    const geometry = new THREE.BufferGeometry();
    owned.push(geometry);
    for (const [key, name] of [
      ["POSITION", "position"],
      ["NORMAL", "normal"],
      ["TEXCOORD_0", "uv"],
    ])
      geometry.setAttribute(name, attribute(primitive.attributes[key]));
    geometry.setIndex(attribute(primitive.indices));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = node.name;
    mesh.position.fromArray(node.translation ?? [0, 0, 0]);
    scene.add(mesh);
  }
  (
    modelCache as unknown as { setupMaterials(scene: THREE.Object3D): void }
  ).setupMaterials(scene);
  owned.push((scene.children[0] as THREE.Mesh).material as THREE.Material);
  return scene;
}

const placements: readonly CompactRockPlacement[] = [
  { id: "low", variant: "rock10", x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
  { id: "split", variant: "rock11", x: 3, y: 0, z: 0, yaw: 1, scale: 1 },
  { id: "tall", variant: "rock13", x: 6, y: 0, z: 0, yaw: 2, scale: 1 },
];
function setup() {
  const source = library(),
    owner = new CompactRockOutcropVisuals(placements);
  owned.push(owner);
  owner.install(source);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
  camera.position.set(3, 2, 4);
  camera.updateMatrixWorld(true);
  return { owner, camera, source };
}

describe("compact scanned outcrop LOD owner", () => {
  it("retains medium in the hysteresis band on approach rather than resetting all rocks to near", () => {
    const source = library();
    const placement: CompactRockPlacement = {
      id: "edge",
      variant: "rock13",
      x: 330.5,
      y: 28.43324434816837,
      z: 332.8,
      yaw: 4.2,
      scale: 0.9,
    };
    const owner = new CompactRockOutcropVisuals([placement]);
    owned.push(owner);
    owner.install(source);
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
    camera.position.set(322, 30.019301523097685, 321);
    camera.updateMatrixWorld(true);
    const surfaceDistance =
      camera.position.distanceTo(
        new THREE.Vector3(placement.x, placement.y, placement.z),
      ) -
      1.8 * placement.scale;
    const mediumError =
      (0.014 * placement.scale * 720) /
      (2 * Math.tan((26 * Math.PI) / 180) * surfaceDistance);
    expect(mediumError).toBeGreaterThan(0.52);
    expect(mediumError).toBeLessThan(0.78);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().levels).toEqual([0]);
    camera.position.set(427.5, 101.4193, 407);
    camera.updateMatrixWorld(true);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().levels).toEqual([2]);
    camera.position.set(322, 30.019301523097685, 321);
    camera.updateMatrixWorld(true);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().levels).toEqual([1]);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().uploads).toBe(3);
  });

  it("renders exactly one level per placement and shares the actual cache material", () => {
    const { owner, camera, source } = setup();
    owner.update(camera, 720);
    const receipt = owner.getDiagnostics();
    expect(receipt.levels).toEqual([0, 0, 0]);
    expect(receipt.batches.reduce((n, row) => n + row.count, 0)).toBe(3);
    expect(receipt.batches.reduce((n, row) => n + row.triangles, 0)).toBe(
      23928,
    );
    expect(new Set(receipt.batches.map((row) => row.material)).size).toBe(1);
    expect(source.parent).toBeNull();
    expect(owner.group.children).toHaveLength(9);
    expect(
      owner.group.children.every((mesh) => mesh instanceof THREE.InstancedMesh),
    ).toBe(true);
  });

  it("chooses reduced LODs at distance and avoids unchanged matrix uploads", () => {
    const { owner, camera } = setup();
    owner.update(camera, 720);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().uploads).toBe(1);
    camera.position.set(3, 2, 100);
    camera.updateMatrixWorld(true);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().levels).toEqual([2, 2, 2]);
    expect(
      owner.getDiagnostics().batches.reduce((n, row) => n + row.triangles, 0),
    ).toBe(1500);
    camera.position.set(3, 2, 4);
    camera.updateMatrixWorld(true);
    owner.update(camera, 720);
    expect(owner.getDiagnostics().levels).toEqual([0, 0, 0]);
    expect(() => owner.update(camera, NaN)).toThrow("native render projection");
  });

  it("preserves rock13's vertical child transform, placement rotation and scale", () => {
    const { owner, camera, source } = setup();
    owner.update(camera, 720);
    const child = source.getObjectByName(
      "compact-outcrop-rock13-lod0",
    ) as THREE.Mesh;
    const mesh = owner.group.getObjectByName(child.name) as THREE.InstancedMesh;
    const actual = new THREE.Matrix4();
    mesh.getMatrixAt(0, actual);
    const expected = new THREE.Matrix4().makeRotationY(2);
    expected.setPosition(6, 0, 0);
    expected.multiply(child.matrixWorld);
    for (let i = 0; i < 16; i++)
      expect(actual.elements[i]).toBeCloseTo(expected.elements[i], 6);
    expect(mesh.boundingBox!.min.y).toBeLessThan(0);
    expect(mesh.boundingBox!.max.y).toBeGreaterThan(0.9);
  });

  it("rejects incomplete or independently cloned material libraries before allocating", () => {
    const source = library();
    source.remove(source.children[0]);
    const owner = new CompactRockOutcropVisuals(placements);
    owned.push(owner);
    expect(() => owner.install(source)).toThrow("exactly nine");
    expect(owner.group.children).toHaveLength(0);
    const different = library();
    const mesh = different.children[0] as THREE.Mesh;
    mesh.material = (mesh.material as THREE.Material).clone();
    owned.push(mesh.material);
    expect(() => owner.install(different)).toThrow(
      "one shared converted material",
    );
    expect(owner.group.children).toHaveLength(0);
  });

  it("releases instance buffers without disposing borrowed source data; late install is inert", () => {
    const { owner, source } = setup();
    let released = 0,
      borrowed = 0;
    for (const mesh of owner.group.children)
      mesh.addEventListener("dispose", () => released++);
    for (const child of source.children)
      (child as THREE.Mesh).geometry.addEventListener(
        "dispose",
        () => borrowed++,
      );
    owner.dispose();
    owner.dispose();
    owner.install(source);
    expect(released).toBe(9);
    expect(borrowed).toBe(0);
    expect(owner.group.children).toHaveLength(0);
    expect(owner.getDiagnostics().disposed).toBe(true);
  });

  it("rejects oversized, nonfinite and duplicate placement inputs", () => {
    expect(() => new CompactRockOutcropVisuals([])).toThrow();
    expect(
      () => new CompactRockOutcropVisuals([placements[0], placements[0]]),
    ).toThrow();
    expect(
      () => new CompactRockOutcropVisuals([{ ...placements[0], scale: 10 }]),
    ).toThrow();
    expect(
      () => new CompactRockOutcropVisuals([{ ...placements[0], y: NaN }]),
    ).toThrow();
  });
});
