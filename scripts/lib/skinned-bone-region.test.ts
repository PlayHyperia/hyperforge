import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NodeIO, type Node as GltfNode } from "@gltf-transform/core";

import { createSkinnedBoneRegionGeometry } from "./skinned-bone-region";

const includeDescendants = { includeDescendantSkinBones: true };
const kayKitPath = new URL(
  "../../artifacts/duel-launch-avatar-bakeoff/kaykit-knight.vrm",
  import.meta.url,
);

type Influence = readonly [bone: THREE.Bone, weight: number];

function createWeightedMesh(
  bones: THREE.Bone[],
  vertexInfluences: ReadonlyArray<ReadonlyArray<Influence>>,
  indexed = false,
) {
  const positions: number[] = [];
  const indices: number[] = [];
  const weights: number[] = [];
  vertexInfluences.forEach((influences, vertex) => {
    const corner = vertex % 3;
    positions.push(
      Math.floor(vertex / 3) * 2 + Number(corner === 1),
      Number(corner === 2),
      0,
    );
    for (let component = 0; component < 4; component += 1) {
      const influence = influences[component];
      indices.push(influence ? bones.indexOf(influence[0]) : 0);
      weights.push(influence?.[1] ?? 0);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(indices, 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(weights, 4),
  );
  if (indexed) geometry.setIndex(vertexInfluences.map((_, index) => index));
  return new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
}

function createDescendantFixture() {
  const torso = new THREE.Bone();
  const forearm = new THREE.Bone();
  const hand = new THREE.Bone();
  const finger = new THREE.Bone();
  const intermediary = new THREE.Group();
  const otherHand = new THREE.Bone();
  const otherFinger = new THREE.Bone();
  const nonSkinBone = new THREE.Bone();
  torso.add(forearm, otherHand);
  forearm.add(hand);
  hand.add(intermediary, nonSkinBone);
  intermediary.add(finger);
  otherHand.add(otherFinger);
  hand.name = otherHand.name = "hand";
  finger.name = otherFinger.name = "finger";
  // Deliberately unrelated ordering and duplicate names: selection is ancestry
  // plus per-skeleton membership, never a name or contiguous index range.
  const bones = [otherFinger, finger, torso, hand, otherHand, forearm];
  const mesh = createWeightedMesh(
    bones,
    bones.flatMap((bone) =>
      Array.from({ length: 3 }, () => [[bone, 1] as const]),
    ),
  );
  mesh.add(torso);
  mesh.bind(new THREE.Skeleton(bones));
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh, bones, hand, finger, forearm, otherHand, nonSkinBone };
}

function createFixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
      3,
    ),
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      4,
    ),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      4,
    ),
  );
  const target = new THREE.Bone();
  target.name = "TargetHand";
  const other = new THREE.Bone();
  other.name = "OtherHand";
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(target, other);
  mesh.bind(new THREE.Skeleton([target, other]));
  const root = new THREE.Group();
  root.add(mesh);
  root.updateMatrixWorld(true);
  return { root, mesh, target, other };
}

describe("createSkinnedBoneRegionGeometry", () => {
  it("extracts only triangles fully controlled by the requested bone", () => {
    const { root, target } = createFixture();
    const result = createSkinnedBoneRegionGeometry(root, target);
    expect(result.sourceMeshCount).toBe(1);
    expect(result.triangleCount).toBe(1);
    expect(Array.from(result.geometry.getAttribute("position").array)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
  });

  it("uses the posed bone transform and world transform", () => {
    const { root, target } = createFixture();
    target.position.set(0.25, 0.5, -0.75);
    root.position.set(3, 4, 5);
    const result = createSkinnedBoneRegionGeometry(root, target);
    const positions = Array.from(
      result.geometry.getAttribute("position").array,
    );
    expect(positions.slice(0, 3)).toEqual([3.25, 4.5, 4.25]);
  });

  it("rejects invalid influence gates", () => {
    const { root, target } = createFixture();
    expect(() => createSkinnedBoneRegionGeometry(root, target, 0)).toThrow(
      /minimumVertexWeight/u,
    );
    expect(() => createSkinnedBoneRegionGeometry(root, target, 1.1)).toThrow(
      /minimumVertexWeight/u,
    );
  });

  it("opts in to actual skin descendants without changing default or body-region selection", () => {
    const { root, hand, forearm } = createDescendantFixture();
    expect(createSkinnedBoneRegionGeometry(root, hand).triangleCount).toBe(1);
    expect(
      createSkinnedBoneRegionGeometry(root, hand, 0.5, {
        includeDescendantSkinBones: false,
      }).triangleCount,
    ).toBe(1);
    const result = createSkinnedBoneRegionGeometry(
      root,
      hand,
      0.5,
      includeDescendants,
    );
    expect(result.triangleCount).toBe(2);
    expect(result.sourceMeshCount).toBe(1);
    // Finger triangle (index 1) and hand triangle (index 3), but not forearm,
    // torso, opposite hand or its identically named finger.
    expect(Array.from(result.geometry.getAttribute("position").array)).toEqual([
      2, 0, 0, 3, 0, 0, 2, 1, 0, 6, 0, 0, 7, 0, 0, 6, 1, 0,
    ]);
    expect(
      createSkinnedBoneRegionGeometry(root, forearm, 0.25).triangleCount,
    ).toBe(1);
  });

  it("retains the wrist-only zero-geometry regression and sums selected influences at the unchanged gate", () => {
    const { root, mesh, bones, hand, finger, forearm } =
      createDescendantFixture();
    const weighted = createWeightedMesh(
      bones,
      [
        ...Array.from(
          { length: 3 },
          () =>
            [
              [hand, 0.25],
              [finger, 0.25],
              [forearm, 0.5],
            ] as const,
        ),
        ...Array.from({ length: 2 }, () => [[finger, 1]] as const),
        [
          [hand, 0.25],
          [finger, 0.125],
          [forearm, 0.625],
        ],
      ],
      true,
    );
    mesh.geometry.dispose();
    mesh.geometry = weighted.geometry;
    const before = createSkinnedBoneRegionGeometry(root, hand);
    expect(before.sourceMeshCount).toBe(1);
    expect(before.triangleCount).toBe(0);
    expect(before.geometry.boundingBox).toBeNull();
    const after = createSkinnedBoneRegionGeometry(
      root,
      hand,
      0.5,
      includeDescendants,
    );
    // The second indexed triangle is rejected because just one vertex is below
    // 0.5. Forearm weight never contributes to the selected region.
    expect(after.triangleCount).toBe(1);
    expect(
      createSkinnedBoneRegionGeometry(root, hand, 0.75, includeDescendants)
        .triangleCount,
    ).toBe(0);
  });

  it("excludes an independently skinned item attached below the hand", () => {
    const { root, hand } = createDescendantFixture();
    const itemHand = new THREE.Bone();
    itemHand.name = hand.name;
    const item = createWeightedMesh(
      [itemHand],
      Array.from({ length: 3 }, () => [[itemHand, 1]] as const),
    );
    item.add(itemHand);
    hand.add(item);
    item.bind(new THREE.Skeleton([itemHand]));
    const result = createSkinnedBoneRegionGeometry(
      root,
      hand,
      0.5,
      includeDescendants,
    );
    expect(result.sourceMeshCount).toBe(1);
    expect(result.triangleCount).toBe(2);
  });

  it("leaves absent or unweighted bone regions empty instead of manufacturing contact geometry", () => {
    const { root, hand, mesh, nonSkinBone } = createDescendantFixture();
    const absent = createSkinnedBoneRegionGeometry(
      root,
      nonSkinBone,
      0.5,
      includeDescendants,
    );
    expect(absent.sourceMeshCount).toBe(0);
    expect(absent.triangleCount).toBe(0);
    mesh.geometry.deleteAttribute("skinWeight");
    const unweighted = createSkinnedBoneRegionGeometry(
      root,
      hand,
      0.5,
      includeDescendants,
    );
    expect(unweighted.triangleCount).toBe(0);
    expect(unweighted.geometry.getAttribute("position").count).toBe(0);
    expect(unweighted.geometry.boundingBox).toBeNull();
    expect(unweighted.geometry.boundingSphere).toBeNull();
  });

  it("measures descendant skinning in world space after changing poses and nonidentity bind transforms", () => {
    const { root, mesh, hand, finger } = createDescendantFixture();
    mesh.position.set(0.1, 0.2, 0.3);
    root.updateMatrixWorld(true);
    mesh.bind(mesh.skeleton);
    root.position.set(3, 4, 5);
    root.rotation.set(0.3, -0.5, 0.8);
    root.scale.set(0.8, 1.2, 1.1);
    for (const angle of [0.4, -0.7]) {
      hand.position.set(0.2, -0.1, 0.3);
      finger.position.set(0.25, 0.5, -0.75);
      finger.rotation.z = angle;
      const result = createSkinnedBoneRegionGeometry(
        root,
        hand,
        0.5,
        includeDescendants,
      );
      const actual = result.geometry.getAttribute("position");
      expect(result.triangleCount).toBe(2);
      [3, 4, 5, 9, 10, 11].forEach((vertexIndex, outputIndex) => {
        const expected = mesh
          .getVertexPosition(vertexIndex, new THREE.Vector3())
          .applyMatrix4(mesh.matrixWorld);
        expect(actual.getX(outputIndex)).toBeCloseTo(expected.x, 5);
        expect(actual.getY(outputIndex)).toBeCloseTo(expected.y, 5);
        expect(actual.getZ(outputIndex)).toBeCloseTo(expected.z, 5);
      });
    }
  });

  // Candidate artifacts are not installed in every checkout. When available,
  // pin the unchanged bytes and exercise their real hierarchy/accessors through
  // actual Three skinning. This is not VRM loading, material or runtime proof.
  it.skipIf(!existsSync(kayKitPath))(
    "measures 136 triangles per actual KayKit hand where the mapped wrist alone measures zero",
    async () => {
      const bytes = readFileSync(kayKitPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        "b288656410986780a0df81d684e4888633be07751b0e57136d9e3c89512e713f",
      );
      const document = await new NodeIO().readBinary(bytes);
      const source = document.getRoot();
      expect(source.listSkins()).toHaveLength(1);
      const skin = source.listSkins()[0];
      const joints = skin.listJoints();
      const objects = new Map<GltfNode, THREE.Object3D>();
      for (const node of source.listNodes()) {
        const object = joints.includes(node)
          ? new THREE.Bone()
          : new THREE.Group();
        object.name = node.getName();
        object.applyMatrix4(new THREE.Matrix4().fromArray(node.getMatrix()));
        objects.set(node, object);
      }
      function objectFor(node: GltfNode): THREE.Object3D {
        const object = objects.get(node);
        if (!object) throw new Error("Missing source node");
        return object;
      }
      for (const node of source.listNodes()) {
        for (const child of node.listChildren())
          objectFor(node).add(objectFor(child));
      }
      const root = new THREE.Group();
      for (const node of source.listScenes()[0].listChildren())
        root.add(objectFor(node));
      root.updateMatrixWorld(true);
      const inverseBindMatrices = skin.getInverseBindMatrices();
      if (!inverseBindMatrices)
        throw new Error("Missing source inverse bind matrices");
      const skeleton = new THREE.Skeleton(
        joints.map((node) => {
          const object = objectFor(node);
          if (!(object instanceof THREE.Bone))
            throw new Error("Source joint is not a bone");
          return object;
        }),
        joints.map((_, index) =>
          new THREE.Matrix4().fromArray(
            inverseBindMatrices.getElement(index, []),
          ),
        ),
      );
      for (const node of source.listNodes()) {
        if (!node.getSkin()) continue;
        expect(node.getSkin()).toBe(skin);
        const sourceMesh = node.getMesh();
        if (!sourceMesh) throw new Error("Missing source mesh");
        for (const primitive of sourceMesh.listPrimitives()) {
          const geometry = new THREE.BufferGeometry();
          for (const [attributeName, sourceName] of [
            ["position", "POSITION"],
            ["skinIndex", "JOINTS_0"],
            ["skinWeight", "WEIGHTS_0"],
          ]) {
            const accessor = primitive.getAttribute(sourceName);
            const array = accessor?.getArray();
            if (!accessor || !array)
              throw new Error(`Missing source ${sourceName}`);
            geometry.setAttribute(
              attributeName,
              new THREE.BufferAttribute(
                array,
                accessor.getElementSize(),
                accessor.getNormalized(),
              ),
            );
          }
          const indices = primitive.getIndices()?.getArray();
          if (!indices) throw new Error("Missing source indices");
          geometry.setIndex(new THREE.BufferAttribute(indices, 1));
          const mesh = new THREE.SkinnedMesh(geometry);
          objectFor(node).add(mesh);
          // Match GLTFLoader's skin binding: accessor inverses plus identity bind.
          mesh.bind(skeleton, new THREE.Matrix4());
        }
      }
      for (const name of ["wrist.l", "wrist.r"]) {
        const hand = root.getObjectByName(name);
        if (!hand) throw new Error(`Missing mapped hand ${name}`);
        const before = createSkinnedBoneRegionGeometry(root, hand);
        expect(before.sourceMeshCount).toBe(9);
        expect(before.triangleCount).toBe(0);
        const after = createSkinnedBoneRegionGeometry(
          root,
          hand,
          0.5,
          includeDescendants,
        );
        expect(after.sourceMeshCount).toBe(9);
        expect(after.triangleCount).toBe(136);
        expect(
          Array.from(after.geometry.getAttribute("position").array).every(
            Number.isFinite,
          ),
        ).toBe(true);
        before.geometry.dispose();
        after.geometry.dispose();
      }
      root.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      skeleton.dispose();
    },
  );
});
