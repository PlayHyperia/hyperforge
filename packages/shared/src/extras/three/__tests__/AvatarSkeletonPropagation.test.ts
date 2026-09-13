import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  VRMHumanoid,
  type VRMHumanBones,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import * as THREE from "../three";
import {
  AvatarSkeletonPropagation,
  createVRMFactory,
} from "../createVRMFactory";
import {
  Authored38ArmRetarget,
  type Arm38Humanoid,
} from "../Authored38ArmRetarget";
import { createEmoteFactory } from "../createEmoteFactory";
import { PlayerHitReactionController } from "../PlayerHitReactionController";

// Counters delegate to real Three hierarchy methods; no renderer or matrix mock.
class CountedBone extends THREE.Bone {
  visits = 0;
  override updateMatrixWorld(force?: boolean): void {
    this.visits++;
    super.updateMatrixWorld(force);
  }
}

class CountedGroup extends THREE.Group {
  visits = 0;
  override updateMatrixWorld(force?: boolean): void {
    this.visits++;
    super.updateMatrixWorld(force);
  }
}

function named<T extends THREE.Object3D>(node: T, name: string): T {
  node.name = name;
  return node;
}

function makeMesh(skeleton: THREE.Skeleton): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-0.2, 0.15, 0.3, 0.4, 0.8, -0.1, -0.5, 1.1, 0.2],
      3,
    ),
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3),
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute([0, 1, 2, 3, 3, 2, 1, 0, 0, 2, 3, 1], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      [0.1, 0.2, 0.3, 0.4, 0.25, 0.25, 0.25, 0.25, 0.5, 0.125, 0.125, 0.25],
      4,
    ),
  );
  const mesh = named(
    new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()),
    "skin",
  );
  mesh.bind(skeleton, new THREE.Matrix4());
  return mesh;
}

function makeRig() {
  const world = named(new CountedGroup(), "world");
  const avatar = named(new CountedGroup(), "avatar");
  const armature = named(new CountedGroup(), "armature");
  const root = named(new CountedBone(), "root");
  const bridge = named(new CountedGroup(), "non-bone bridge");
  const upper = named(new CountedBone(), "upper");
  const hand = named(new CountedBone(), "hand");
  const leg = named(new CountedBone(), "leg");
  const other = named(new CountedBone(), "other root");
  const attachment = named(new CountedGroup(), "weapon attachment");
  world.add(avatar);
  avatar.add(armature);
  armature.add(root, other);
  root.add(bridge, leg);
  bridge.add(upper);
  upper.add(hand);
  hand.add(attachment);
  world.position.set(4, -2, 7);
  world.rotation.set(0.1, -0.3, 0.2);
  world.scale.set(1.1, 0.9, 1.2);
  avatar.position.set(2, 3, -1);
  avatar.rotation.set(0.2, 0.4, -0.1);
  avatar.scale.set(0.8, 1.3, 0.7);
  armature.position.set(0, 0.2, 0.1);
  armature.rotation.set(0.1, 0.2, 0);
  root.position.set(0, 0.9, 0);
  bridge.position.set(0.15, 0.3, 0);
  upper.position.set(0.25, 0.2, 0);
  hand.position.set(0.3, 0.1, 0.02);
  leg.position.set(-0.1, -0.5, 0);
  other.position.set(-0.3, 0.6, 0.1);
  attachment.position.set(0.06, 0.04, -0.1);
  attachment.rotation.set(0.3, 1.2, -0.2);
  world.updateMatrixWorld(true);
  // Deliberately unordered and duplicated: array order must not select a leaf
  // as the only root or drop a disconnected skeleton subtree.
  const skeleton = new THREE.Skeleton([hand, root, other, upper, hand, leg]);
  const mesh = makeMesh(skeleton);
  avatar.add(mesh);
  world.updateMatrixWorld(true);
  const nodes: THREE.Object3D[] = [];
  world.traverse((node) => nodes.push(node));
  const counted = [
    world,
    avatar,
    armature,
    root,
    bridge,
    upper,
    hand,
    leg,
    other,
    attachment,
  ];
  const propagation = new AvatarSkeletonPropagation(skeleton);
  const reset = () => {
    for (const node of counted) node.visits = 0;
  };
  const visits = () => counted.reduce((n, node) => n + node.visits, 0);
  return {
    world,
    avatar,
    armature,
    root,
    bridge,
    upper,
    hand,
    leg,
    other,
    attachment,
    skeleton,
    mesh,
    nodes,
    counted,
    propagation,
    reset,
    visits,
  };
}

type Rig = ReturnType<typeof makeRig>;

function legacyUpdate(skeleton: THREE.Skeleton): void {
  for (let i = 0; i < skeleton.bones.length; i++)
    skeleton.bones[i].updateMatrixWorld();
  skeleton.update();
}

function skinReceipt(mesh: THREE.SkinnedMesh, samples?: readonly number[]) {
  const { position, normal, skinIndex, skinWeight } = mesh.geometry.attributes;
  const positions: number[][] = [],
    normals: number[][] = [];
  for (const i of samples ??
    Array.from({ length: position.count }, (_, index) => index)) {
    // Actual Three CPU skinning accessor. Normals below independently use the
    // r186 Skinning.js weighted palette/bind transform, without a GPU claim.
    positions.push(
      mesh
        .applyBoneTransform(
          i,
          new THREE.Vector3().fromBufferAttribute(position, i),
        )
        .toArray(),
    );
    const weighted = new THREE.Matrix4();
    weighted.elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const bone = skinIndex.getComponent(i, j),
        weight = skinWeight.getComponent(i, j);
      for (let k = 0; k < 16; k++)
        weighted.elements[k] +=
          weight * mesh.skeleton.boneMatrices[bone * 16 + k];
    }
    weighted.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
    normals.push(
      new THREE.Vector3()
        .fromBufferAttribute(normal, i)
        .applyMatrix3(new THREE.Matrix3().setFromMatrix4(weighted))
        .toArray(),
    );
  }
  return { positions, normals };
}

function expectParity(before: Rig, after: Rig): void {
  expect(after.skeleton.boneMatrices).toEqual(before.skeleton.boneMatrices);
  expect(after.nodes.map((node) => node.matrixWorld.elements)).toEqual(
    before.nodes.map((node) => node.matrixWorld.elements),
  );
  expect(
    after.nodes.map((node) => [
      node.matrixAutoUpdate,
      node.matrixWorldAutoUpdate,
      node.matrixWorldNeedsUpdate,
    ]),
  ).toEqual(
    before.nodes.map((node) => [
      node.matrixAutoUpdate,
      node.matrixWorldAutoUpdate,
      node.matrixWorldNeedsUpdate,
    ]),
  );
  if (after.skeleton.bones.length > 0) {
    expect(skinReceipt(after.mesh)).toEqual(skinReceipt(before.mesh));
  }
  expect(after.skeleton.boneInverses.map((m) => m.elements)).toEqual(
    before.skeleton.boneInverses.map((m) => m.elements),
  );
}

function advance(before: Rig, after: Rig): void {
  before.reset();
  after.reset();
  legacyUpdate(before.skeleton);
  after.propagation.update();
  after.skeleton.update();
  expectParity(before, after);
}

function disposeRig(rig: Rig): void {
  rig.skeleton.dispose();
  rig.mesh.geometry.dispose();
  (rig.mesh.material as THREE.Material).dispose();
}

describe("AvatarSkeletonPropagation: actual Three hierarchy", () => {
  it("updates unordered/duplicate members and non-bone descendants once per disjoint root", () => {
    const before = makeRig(),
      after = makeRig();
    try {
      for (let frame = 0; frame < 40; frame++) {
        for (const rig of [before, after]) {
          rig.root.rotation.y = frame * 0.04;
          rig.bridge.rotation.z = frame * -0.03;
          rig.upper.rotation.x = frame * 0.01;
          rig.hand.rotation.z = frame * 0.05;
          rig.other.scale.set(1 + frame * 0.01, 0.9, 1.1);
        }
        advance(before, after);
        expect(after.visits()).toBe(7);
        expect(before.visits()).toBe(15);
        for (const node of [
          after.root,
          after.bridge,
          after.upper,
          after.hand,
          after.leg,
          after.other,
          after.attachment,
        ])
          expect(node.visits).toBe(1);
        expect(after.armature.visits).toBe(0);
      }
    } finally {
      disposeRig(before);
      disposeRig(after);
    }
  });

  it("invalidates topology on intermediate reparenting and observes new attachment descendants", () => {
    const before = makeRig(),
      after = makeRig();
    try {
      advance(before, after);
      for (const rig of [before, after]) {
        rig.other.add(rig.bridge); // Bone.parent is unchanged; an intermediate edge changed.
        const newAttachment = named(new CountedGroup(), "new tool anchor");
        newAttachment.position.set(0.2, -0.1, 0.3);
        rig.hand.add(newAttachment);
        rig.nodes.push(newAttachment);
        rig.counted.push(newAttachment);
        rig.root.rotation.set(0.4, 0.3, 0.2);
        rig.other.rotation.set(-0.2, 0.6, 0.1);
      }
      advance(before, after);
      expect(after.visits()).toBe(8);
      for (const rig of [before, after]) rig.root.add(rig.other); // Previously disjoint roots merge.
      advance(before, after);
      expect(after.visits()).toBe(8);
      for (const rig of [before, after]) rig.armature.add(rig.hand); // A new disjoint member root.
      advance(before, after);
      expect(after.visits()).toBe(8);
    } finally {
      disposeRig(before);
      disposeRig(after);
    }
  });

  it("rebuilds for member replacement/reorder/removal and empty skeletons", () => {
    const before = makeRig(),
      after = makeRig();
    try {
      advance(before, after);
      for (const rig of [before, after]) {
        rig.skeleton.bones = [
          rig.upper,
          rig.other,
          rig.hand,
          rig.leg,
          rig.upper,
          rig.other,
        ];
        rig.skeleton.calculateInverses();
        rig.upper.rotation.set(0.2, 0.3, 0.4);
        rig.other.rotation.set(-0.4, 0.1, 0.6);
      }
      advance(before, after);
      for (const rig of [before, after]) {
        rig.skeleton.bones.reverse();
        rig.skeleton.calculateInverses();
        rig.upper.position.y += 0.4;
      }
      advance(before, after);
      for (const rig of [before, after]) {
        rig.skeleton.bones.length = 4;
        rig.skeleton.calculateInverses();
      }
      advance(before, after);
      for (const rig of [before, after]) rig.skeleton.bones.length = 0;
      advance(before, after);
      expect(after.visits()).toBe(0);
      const empty = new AvatarSkeletonPropagation(new THREE.Skeleton());
      expect(() => empty.update()).not.toThrow();
    } finally {
      disposeRig(before);
      disposeRig(after);
    }
  });

  it.each([false, true])(
    "retains manual matrices and no-force semantics, dirty=%s",
    (dirty) => {
      const before = makeRig(),
        after = makeRig();
      try {
        for (const rig of [before, after]) {
          rig.avatar.matrixAutoUpdate = false;
          rig.avatar.matrixWorldAutoUpdate = false;
          rig.root.matrixAutoUpdate = false;
          rig.root.matrix.makeRotationY(0.6);
          rig.root.matrix.setPosition(0.1, 1.2, -0.3);
          rig.root.matrixWorldNeedsUpdate = dirty;
          rig.bridge.matrixAutoUpdate = false;
          rig.bridge.matrixWorldAutoUpdate = false;
          rig.bridge.matrixWorld.makeTranslation(20, 30, 40);
          rig.hand.matrixAutoUpdate = false;
          rig.hand.matrix.makeScale(0.7, 1.2, 0.9);
          rig.hand.matrixWorldNeedsUpdate = dirty;
          // Stale external ancestors must not be refreshed by the new algorithm.
          rig.armature.position.set(60, 70, 80);
        }
        advance(before, after);
        expect(after.armature.visits).toBe(0);
        expect(after.bridge.matrixWorld.elements).toEqual(
          new THREE.Matrix4().makeTranslation(20, 30, 40).elements,
        );
      } finally {
        disposeRig(before);
        disposeRig(after);
      }
    },
  );

  it("keeps separate avatar owners isolated", () => {
    const first = makeRig(),
      second = makeRig();
    try {
      second.propagation.update();
      second.skeleton.update();
      const saved = second.skeleton.boneMatrices.slice();
      second.reset();
      first.hand.position.set(9, 8, 7);
      first.propagation.update();
      first.skeleton.update();
      expect(second.skeleton.boneMatrices).toEqual(saved);
      expect(second.visits()).toBe(0);
      expect(first.skeleton.boneMatrices).not.toEqual(saved);
    } finally {
      disposeRig(first);
      disposeRig(second);
    }
  });
});

const humanHierarchy: ReadonlyArray<
  readonly [VRMHumanBoneName, VRMHumanBoneName | null, number, number, number]
> = [
  ["hips", null, 0, 1, 0],
  ["spine", "hips", 0, 0.2, 0],
  ["chest", "spine", 0, 0.2, 0],
  ["upperChest", "chest", 0, 0.15, 0],
  ["neck", "upperChest", 0, 0.1, 0],
  ["head", "neck", 0, 0.2, 0],
  ["leftUpperArm", "upperChest", 0.2, 0, 0],
  ["leftLowerArm", "leftUpperArm", 0.3, 0, 0],
  ["leftHand", "leftLowerArm", 0.25, 0, 0],
  ["rightUpperArm", "upperChest", -0.2, 0, 0],
  ["rightLowerArm", "rightUpperArm", -0.3, 0, 0],
  ["rightHand", "rightLowerArm", -0.25, 0, 0],
  ["leftUpperLeg", "hips", 0.1, -0.1, 0],
  ["leftLowerLeg", "leftUpperLeg", 0, -0.4, 0],
  ["leftFoot", "leftLowerLeg", 0, -0.4, 0.1],
  ["rightUpperLeg", "hips", -0.1, -0.1, 0],
  ["rightLowerLeg", "rightUpperLeg", 0, -0.4, 0],
  ["rightFoot", "rightLowerLeg", 0, -0.4, 0.1],
];

function makeHumanoid() {
  const scene = new THREE.Scene(),
    armature = new THREE.Group();
  scene.add(armature);
  const humanBones = {} as VRMHumanBones;
  for (const [name, parent, x, y, z] of humanHierarchy) {
    const node = named(new THREE.Bone(), name);
    node.position.set(x, y, z);
    humanBones[name] = { node };
    (parent ? humanBones[parent]!.node : armature).add(node);
  }
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(humanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const skeleton = new THREE.Skeleton(
    humanHierarchy.map(([name]) => humanBones[name]!.node as THREE.Bone),
  );
  const mesh = makeMesh(skeleton);
  scene.add(mesh);
  const attachment = new THREE.Group();
  attachment.position.set(0.12, -0.04, 0.03);
  humanBones.rightHand.node.add(attachment);
  scene.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(scene);
  const end = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.5, -0.4, 0.2),
  );
  const clip = new THREE.AnimationClip("pose parity", 1, [
    new THREE.QuaternionKeyframeTrack(
      humanoid.getNormalizedBoneNode("chest")!.name + ".quaternion",
      [0, 0.5, 1],
      [0, 0, 0, 1, ...end.toArray(), 0, 0, 0, 1],
    ),
    new THREE.VectorKeyframeTrack(
      humanoid.getNormalizedBoneNode("hips")!.name + ".position",
      [0, 0.5, 1],
      [0, 1, 0, 0.1, 1.1, -0.1, 0, 1, 0],
    ),
  ]);
  mixer.clipAction(clip).play();
  const recoil = new PlayerHitReactionController(humanoid);
  const propagation = new AvatarSkeletonPropagation(skeleton);
  return {
    scene,
    armature,
    humanBones,
    humanoid,
    skeleton,
    mesh,
    attachment,
    mixer,
    clip,
    recoil,
    propagation,
  };
}

describe("AvatarSkeletonPropagation: actual VRM normalized/raw animation pipeline", () => {
  it("preserves mixer, hit-reaction, first-person collapse, movement and attachment results", () => {
    const before = makeHumanoid(),
      after = makeHumanoid();
    try {
      for (let frame = 0; frame < 80; frame++) {
        for (const rig of [before, after]) {
          // Same manual world-root contract as factory move(); movement remains
          // a separate complete propagation before the animation update.
          rig.scene.matrixAutoUpdate = false;
          rig.scene.matrixWorldAutoUpdate = false;
          rig.scene.matrix.compose(
            new THREE.Vector3(350 + frame * 0.1, 28, 330),
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(0.1, frame * 0.02, -0.1),
            ),
            new THREE.Vector3(0.9, 1.2, 0.8),
          );
          rig.scene.matrixWorld.copy(rig.scene.matrix);
          rig.scene.updateMatrixWorld(true);
          rig.recoil.beforeMixerUpdate();
          rig.mixer.update(1 / 60);
          if (frame === 8 || frame === 16)
            rig.recoil.trigger(0.9, frame === 8 ? 1 : -1);
          rig.recoil.afterMixerUpdate(1 / 60);
          rig.humanoid
            .getRawBoneNode("neck")!
            .scale.setScalar(frame >= 30 && frame < 45 ? 0 : 1);
          rig.humanoid.update();
        }
        legacyUpdate(before.skeleton);
        after.propagation.update();
        after.skeleton.update();
        expect(after.skeleton.boneMatrices).toEqual(
          before.skeleton.boneMatrices,
        );
        expect(after.humanoid.getRawAbsolutePose()).toEqual(
          before.humanoid.getRawAbsolutePose(),
        );
        expect(after.attachment.matrixWorld.elements).toEqual(
          before.attachment.matrixWorld.elements,
        );
        expect(after.armature.matrixWorld.elements).toEqual(
          before.armature.matrixWorld.elements,
        );
        expect(skinReceipt(after.mesh)).toEqual(skinReceipt(before.mesh));
        expect(after.recoil.getDiagnostics()).toEqual(
          before.recoil.getDiagnostics(),
        );
      }
    } finally {
      for (const rig of [before, after]) {
        rig.mixer.stopAllAction();
        rig.mixer.uncacheRoot(rig.scene);
        rig.skeleton.dispose();
        rig.mesh.geometry.dispose();
        (rig.mesh.material as THREE.Material).dispose();
      }
    }
  });
});

const authoredAvatar = new URL(
  "../../../../../server/world/assets/avatars/asset-studio-test/authored-body38-light01-test.vrm",
  import.meta.url,
);
const authoredAvatarSha =
  "620e08491e3906e6b84d2a6b05bbc4970c833d82156d792304e2137a7df7bf67";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function loadAuthoredRigGeometry() {
  const original = readFileSync(authoredAvatar);
  expect(sha(original)).toBe(authoredAvatarSha);
  expect(original.readUInt32LE(0)).toBe(0x46546c67);
  expect(original.readUInt32LE(4)).toBe(2);
  const jsonLength = original.readUInt32LE(12);
  const json = JSON.parse(
    original.subarray(20, 20 + jsonLength).toString("utf8"),
  ) as {
    materials?: unknown;
    images?: unknown;
    textures?: unknown;
    samplers?: unknown;
    meshes: Array<{ primitives: Array<{ material?: number }> }>;
  };
  // Explicit geometry/rig-only parse of the exact package: preserve its entire
  // binary chunk, nodes, skin, weights, inverse binds and animations. Omitting
  // material/image JSON avoids inventing browser image APIs in this CPU test.
  delete json.materials;
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  const encoded = Buffer.from(JSON.stringify(json)),
    padding = (4 - (encoded.length % 4)) % 4;
  const tail = original.subarray(20 + jsonLength),
    total = 20 + encoded.length + padding + tail.length;
  const bytes = Buffer.alloc(total, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(total, 8);
  bytes.writeUInt32LE(encoded.length + padding, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(bytes, 20);
  tail.copy(bytes, 20 + encoded.length + padding);
  const gltf = await new GLTFLoader()
    .register((parser) => new VRMLoaderPlugin(parser))
    .parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    );
  return gltf;
}

async function makeAuthoredRig() {
  const gltf = await loadAuthoredRigGeometry();
  const humanoid = gltf.userData.vrm.humanoid as VRMHumanoid;
  const retarget = new Authored38ArmRetarget(
    humanoid as unknown as Arm38Humanoid,
    authoredAvatarSha,
  );
  retarget.initializeNormalizedPose();
  humanoid.update();
  gltf.scene.updateMatrixWorld(true);
  const meshes: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh)
      meshes.push(node as THREE.SkinnedMesh);
  });
  expect(meshes.length).toBeGreaterThan(0);
  const skeleton = meshes[0].skeleton;
  expect(skeleton.bones).toHaveLength(52);
  const attachment = new THREE.Group();
  attachment.position.set(0.06, 0.04, -0.1);
  attachment.rotation.set(0.3, 1.2, -0.2);
  humanoid.getRawBoneNode("rightHand")!.add(attachment);
  const mixer = new THREE.AnimationMixer(gltf.scene),
    recoil = new PlayerHitReactionController(humanoid);
  const propagation = new AvatarSkeletonPropagation(skeleton);
  const immutable = () =>
    meshes.map((mesh) => ({
      attributes: Object.fromEntries(
        Object.entries(mesh.geometry.attributes).map(([name, attr]) => [
          name,
          sha(
            new Uint8Array(
              attr.array.buffer,
              attr.array.byteOffset,
              attr.array.byteLength,
            ),
          ),
        ]),
      ),
      index: mesh.geometry.index
        ? sha(
            new Uint8Array(
              mesh.geometry.index.array.buffer,
              mesh.geometry.index.array.byteOffset,
              mesh.geometry.index.array.byteLength,
            ),
          )
        : null,
      inverses: mesh.skeleton.boneInverses.map((matrix) =>
        matrix.elements.slice(),
      ),
      rest: humanoid.rawRestPose,
    }));
  return {
    gltf,
    humanoid,
    retarget,
    meshes,
    skeleton,
    attachment,
    mixer,
    recoil,
    propagation,
    immutable,
  };
}

function countActualPropagationVisits(
  root: THREE.Object3D,
  update: () => void,
): number {
  const nodes: THREE.Object3D[] = [];
  root.traverse((node) => nodes.push(node));
  const originals = nodes.map((node) => ({
    node,
    method: node.updateMatrixWorld,
    descriptor: Object.getOwnPropertyDescriptor(node, "updateMatrixWorld"),
  }));
  let visits = 0;
  try {
    for (const { node, method } of originals) {
      Object.defineProperty(node, "updateMatrixWorld", {
        configurable: true,
        writable: true,
        value: function (this: THREE.Object3D, force?: boolean) {
          visits++;
          return method.call(this, force);
        },
      });
    }
    update();
    return visits;
  } finally {
    for (const { node, descriptor } of originals) {
      if (descriptor)
        Object.defineProperty(node, "updateMatrixWorld", descriptor);
      else Reflect.deleteProperty(node, "updateMatrixWorld");
    }
  }
}

describe("AvatarSkeletonPropagation: packaged authored52 rig", () => {
  it("matches legacy palettes and sampled skinning through seven real authored clips", async () => {
    const before = await makeAuthoredRig(),
      after = await makeAuthoredRig();
    const immutableBefore = JSON.stringify(before.immutable()),
      immutableAfter = JSON.stringify(after.immutable());
    try {
      const legacyVisits = countActualPropagationVisits(before.gltf.scene, () =>
        legacyUpdate(before.skeleton),
      );
      const optimizedVisits = countActualPropagationVisits(
        after.gltf.scene,
        () => {
          after.propagation.update();
          after.skeleton.update();
        },
      );
      // Preserve every source/loader-created descendant outside the 52-joint
      // palette as well as this test's actual hand attachment.
      expect(optimizedVisits).toBe(61);
      expect(legacyVisits).toBe(457);
      process.stdout.write(
        `[AvatarSkeletonPropagation] actual authored52 visits: ${legacyVisits} -> ${optimizedVisits}\n`,
      );
      for (const file of [
        "emote-idle.glb",
        "emote-walk.glb",
        "emote-run.glb",
        "emote_sword_swing.glb",
        "emote-range.glb",
        "emote-spell-cast.glb",
        "emote-death.glb",
      ]) {
        const bytes = readFileSync(
          new URL(
            "../../../../../server/world/assets/emotes/" + file,
            import.meta.url,
          ),
        );
        const animation = await new GLTFLoader().parseAsync(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          "",
        );
        animation.scene.updateMatrixWorld(true);
        const emote = createEmoteFactory(
          animation as unknown as Parameters<typeof createEmoteFactory>[0],
          "asset://emotes/" + file,
        );
        const actions = [before, after].map((rig) => {
          const clip = emote.toClip({
            version: "1",
            getBoneName: (name) =>
              rig.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)
                ?.name,
          });
          const prepared = rig.retarget.prepareClip(clip);
          return rig.mixer.clipAction(prepared).play();
        });
        for (const [index, fraction] of [0, 0.35, 0.8].entries()) {
          for (const rig of [before, after]) {
            rig.gltf.scene.matrixAutoUpdate = false;
            rig.gltf.scene.matrixWorldAutoUpdate = false;
            rig.gltf.scene.matrix.compose(
              new THREE.Vector3(350 + index, 28, 330 - index),
              new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0.1, index * 0.4, -0.1),
              ),
              new THREE.Vector3(0.9, 1.2, 0.8),
            );
            rig.gltf.scene.matrixWorld.copy(rig.gltf.scene.matrix);
            rig.gltf.scene.updateMatrixWorld(true);
            rig.recoil.beforeMixerUpdate();
            rig.mixer.setTime(actions[0].getClip().duration * fraction);
            if (index === 1 && !file.includes("death"))
              rig.recoil.trigger(0.8, -1);
            rig.recoil.afterMixerUpdate(1 / 60);
            rig.humanoid
              .getRawBoneNode("neck")!
              .scale.setScalar(index === 2 ? 0 : 1);
            rig.humanoid.update();
          }
          legacyUpdate(before.skeleton);
          after.propagation.update();
          after.skeleton.update();
          // Read matrices directly: getWorldPosition/Quaternion would refresh
          // ancestors and could conceal a missing propagation step.
          expect(
            after.skeleton.bones.map((bone) => bone.matrixWorld.elements),
          ).toEqual(
            before.skeleton.bones.map((bone) => bone.matrixWorld.elements),
          );
          expect(after.skeleton.boneMatrices).toEqual(
            before.skeleton.boneMatrices,
          );
          expect(after.attachment.matrixWorld.elements).toEqual(
            before.attachment.matrixWorld.elements,
          );
          for (let m = 0; m < after.meshes.length; m++) {
            const count = after.meshes[m].geometry.attributes.position.count;
            const samples = Array.from(
              { length: Math.min(64, count) },
              (_, i) =>
                Math.floor(
                  (i * (count - 1)) / Math.max(1, Math.min(64, count) - 1),
                ),
            );
            expect(skinReceipt(after.meshes[m], samples)).toEqual(
              skinReceipt(before.meshes[m], samples),
            );
          }
        }
        for (const rig of [before, after]) {
          rig.recoil.clear();
          rig.mixer.stopAllAction();
        }
      }
      expect(JSON.stringify(before.immutable())).toBe(immutableBefore);
      expect(JSON.stringify(after.immutable())).toBe(immutableAfter);
      expect(sha(readFileSync(authoredAvatar))).toBe(authoredAvatarSha);
    } finally {
      for (const rig of [before, after]) {
        rig.mixer.stopAllAction();
        rig.mixer.uncacheRoot(rig.gltf.scene);
        rig.retarget.dispose();
        for (const mesh of rig.meshes) {
          mesh.skeleton.dispose();
          mesh.geometry.dispose();
          for (const material of Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material])
            material.dispose();
        }
      }
    }
  });

  it("runs the actual factory pass without changing movement or clone ownership", async () => {
    const source = await loadAuthoredRigGeometry();
    const factory = createVRMFactory(
      source as unknown as Parameters<typeof createVRMFactory>[0],
      undefined,
      { sourceSHA256: authoredAvatarSha },
    );
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera();
    const first = factory.create(new THREE.Matrix4(), { scene, camera })!;
    const second = factory.create(
      new THREE.Matrix4().makeTranslation(3, 0, 0),
      { scene, camera },
    )!;
    try {
      first.disableRateCheck();
      second.disableRateCheck();
      first.update(1 / 60);
      second.update(1 / 60);
      const firstMeshes: THREE.SkinnedMesh[] = [],
        secondMeshes: THREE.SkinnedMesh[] = [];
      first.raw.scene.traverse((node) => {
        if ((node as THREE.SkinnedMesh).isSkinnedMesh)
          firstMeshes.push(node as THREE.SkinnedMesh);
      });
      second.raw.scene.traverse((node) => {
        if ((node as THREE.SkinnedMesh).isSkinnedMesh)
          secondMeshes.push(node as THREE.SkinnedMesh);
      });
      const firstSkeleton = firstMeshes[0].skeleton,
        secondSkeleton = secondMeshes[0].skeleton;
      const secondBefore = secondSkeleton.boneMatrices.slice();
      expect(
        firstSkeleton.bones.every(
          (bone, i) => bone !== secondSkeleton.bones[i],
        ),
      ).toBe(true);
      first.move(
        new THREE.Matrix4().compose(
          new THREE.Vector3(350, 28, 330),
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            1.2,
          ),
          new THREE.Vector3(1, 1, 1),
        ),
      );
      first.triggerHitReaction(0.7, 1);
      first.setFirstPerson(true);
      first.update(1 / 60);
      const optimized = firstSkeleton.boneMatrices.slice(),
        attachment = first.getBoneTransform("rightHand")!.clone();
      legacyUpdate(firstSkeleton);
      expect(firstSkeleton.boneMatrices).toEqual(optimized);
      expect(first.getBoneTransform("rightHand")!.elements).toEqual(
        attachment.elements,
      );
      expect(firstSkeleton.getBoneByName("neck")!.scale.toArray()).toEqual([
        0, 0, 0,
      ]);
      expect(secondSkeleton.boneMatrices).toEqual(secondBefore);
      first.setFirstPerson(false);
      first.update(1 / 60);
      expect(firstSkeleton.getBoneByName("neck")!.scale.toArray()).toEqual([
        1, 1, 1,
      ]);
    } finally {
      first.destroy();
      second.destroy();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const skeletons = new Set<THREE.Skeleton>();
      for (const root of [source.scene, first.raw.scene, second.raw.scene]) {
        root.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            const mesh = node as THREE.Mesh;
            geometries.add(mesh.geometry);
            for (const material of Array.isArray(mesh.material)
              ? mesh.material
              : [mesh.material])
              materials.add(material);
          }
          if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
            skeletons.add((node as THREE.SkinnedMesh).skeleton);
          }
        });
      }
      for (const skeleton of skeletons) skeleton.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    }
  });
});
