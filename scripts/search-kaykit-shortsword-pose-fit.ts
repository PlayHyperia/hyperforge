import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import { MeshBVH } from "three-mesh-bvh";
import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import type { GLBData } from "../packages/shared/src/types";

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EVIDENCE_ROOT =
  "artifacts/duel-launch-avatar-bakeoff/kaykit-shortsword-pose-fit-20260905";
const FROZEN_ROOT =
  "artifacts/duel-launch-avatar-bakeoff/kaykit-shortsword-contact-20260905";
const FROZEN_INPUTS_SHA256 =
  "f2b87c0b7dab437147b4731b7f163bf0f6695a2c0529ba2d3c8af9d4c510262b";
const ASSET_ROOT = "packages/server/world/assets";
type Role = "idle" | "walk" | "run" | "sword";
type Region = "handle" | "pommel" | "guard" | "blade";
type JsonGlb = {
  materials?: Array<{ name?: string }>;
  images?: unknown;
  textures?: unknown;
  samplers?: unknown;
};
type FrozenInputs = {
  definitionSha256: string;
  avatar: { path: string; sha256: string };
  candidates: Array<{ candidatePath: string; sha256: string }>;
  runtimeAssets: Record<Role, { asset: string; sha256: string; url: string }>;
};
type Pose = {
  id: string;
  role: Role;
  seconds: number;
  wristWorld: THREE.Matrix4;
  hand: THREE.BufferGeometry;
  forbidden: THREE.BufferGeometry;
  handBvh: MeshBVH;
  forbiddenBvh: MeshBVH;
  handTriangleCount: number;
  forbiddenTriangleCount: number;
  initialHeight: number;
  normalizationScale: number;
};
const IDENTITY = new THREE.Matrix4();
const require = createRequire(import.meta.url);

function libraryVersion(name: string) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (data.name === name && typeof data.version === "string")
        return data.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot bind geometry library version: ${name}`);
    directory = parent;
  }
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readExact(relative: string, sha256: string) {
  if (
    path.isAbsolute(relative) ||
    relative.startsWith("../") ||
    path.posix.normalize(relative) !== relative ||
    relative.includes("\\")
  )
    throw new Error("Unsafe input path");
  const bytes = readFileSync(path.join(WORKSPACE, relative));
  if (digest(bytes) !== sha256)
    throw new Error(`Frozen input changed: ${relative}`);
  return bytes;
}

/** CPU loading only: material substitutions never change geometry/binary chunks or disk files. */
function cpuGeometryGlb(bytes: Buffer) {
  const length = bytes.readUInt32LE(12);
  const document = JSON.parse(
    bytes.subarray(20, 20 + length).toString("utf8"),
  ) as JsonGlb;
  document.materials = (document.materials ?? []).map((material) => ({
    name: material.name,
  }));
  delete document.images;
  delete document.textures;
  delete document.samplers;
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const header = Buffer.from(bytes.subarray(0, 20));
  const rest = bytes.subarray(20 + length);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Uint8Array.from(Buffer.concat([header, padded, rest])).buffer;
}
async function parse(bytes: Buffer, avatar = false): Promise<GLTF> {
  const loader = new GLTFLoader();
  if (avatar) loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader.parseAsync(cpuGeometryGlb(bytes), "");
}
function disposeScene(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      material.dispose();
  });
}

export function halton(index: number, base: number) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isInteger(base) ||
    base < 2
  )
    throw new Error("Invalid sequence input");
  let result = 0,
    fraction = 1;
  while (index > 0) {
    fraction /= base;
    result += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return result;
}

/** A finite scan, including key times and observed failures; not continuous-time acceptance. */
export function sampleClipTimes(duration: number, keyTimes: readonly number[]) {
  if (
    !Number.isFinite(duration) ||
    duration <= 0.001 ||
    keyTimes.some((time) => !Number.isFinite(time))
  )
    throw new Error("Invalid clip times");
  const end = duration;
  const proposed = [
    0,
    end,
    duration - 0.001,
    ...keyTimes,
    ...Array.from(
      { length: Math.floor(duration * 60) + 1 },
      (_, index) => index / 60,
    ),
    duration * 0.15,
    duration * 0.35,
    duration * 0.45,
    duration * 0.75,
    duration * 0.85,
  ];
  const sorted = proposed
    .map((time) => Math.min(Math.max(time, 0), end))
    .sort((a, b) => a - b);
  const unique: number[] = [];
  for (const time of sorted)
    if (unique.length === 0 || time - unique[unique.length - 1] > 1e-7)
      unique.push(time);
  // Float32 clip ends can sit nanoseconds after a 60 Hz sample. Keep the actual clamped endpoint.
  unique[unique.length - 1] = end;
  return unique;
}

export function generateRigidCandidates(
  base: THREE.Matrix4,
  scaledHandleCenter: THREE.Vector3,
  normalizationScale: number,
  count: number,
) {
  if (
    !Number.isFinite(normalizationScale) ||
    normalizationScale <= 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024 ||
    base.elements.some((value) => !Number.isFinite(value)) ||
    scaledHandleCenter.toArray().some((value) => !Number.isFinite(value))
  )
    throw new Error("Invalid candidate budget");
  const originalPosition = new THREE.Vector3(),
    originalRotation = new THREE.Quaternion(),
    originalScale = new THREE.Vector3();
  base.decompose(originalPosition, originalRotation, originalScale);
  const pivot = scaledHandleCenter.clone().applyMatrix4(base);
  return Array.from({ length: count }, (_, index) => {
    if (index === 0)
      return {
        index,
        translationMetres: [0, 0, 0],
        rotationDegrees: 0,
        matrix: base.clone(),
      };
    const translationMetres = [7, 11, 13].map(
      (prime) => (halton(index, prime) * 2 - 1) * 0.012,
    );
    const translation = new THREE.Vector3(...translationMetres).divideScalar(
      normalizationScale,
    );
    const axis = new THREE.Vector3(
      halton(index, 2) * 2 - 1,
      halton(index, 3) * 2 - 1,
      halton(index, 5) * 2 - 1,
    ).normalize();
    if (axis.lengthSq() === 0) axis.set(0, 1, 0);
    const rotationDegrees = halton(index, 17) * 20;
    const rotation = originalRotation
      .clone()
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          axis,
          THREE.MathUtils.degToRad(rotationDegrees),
        ),
      );
    const matrix = new THREE.Matrix4()
      .compose(pivot.clone().add(translation), rotation, originalScale)
      .multiply(
        new THREE.Matrix4().makeTranslation(
          ...scaledHandleCenter.clone().negate().toArray(),
        ),
      );
    return { index, translationMetres, rotationDegrees, matrix };
  });
}

/** Full rendered skin complement: no bone-region holes or arm/leg/cape exemption. */
function splitAvatarSurfaces(vrm: VRM) {
  const handBone = vrm.humanoid.getRawBoneNode("rightHand");
  if (!handBone) throw new Error("Missing actual raw right hand");
  const handPositions: number[] = [],
    forbiddenPositions: number[] = [];
  let handTriangles = 0,
    forbiddenTriangles = 0;
  const membership: Array<{
    mesh: string;
    handTriangles: number;
    forbiddenTriangles: number;
    allowedSourceTriangleIndices: number[];
    forbiddenSourceTriangleIndices: number[];
  }> = [];
  vrm.scene.traverse((object) => {
    if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh))
      throw new Error(
        "Unexpected rigid avatar surface would escape skin gates",
      );
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const mesh = object,
      position = mesh.geometry.getAttribute("position"),
      index = mesh.geometry.getIndex();
    const skinIndex = mesh.geometry.getAttribute("skinIndex"),
      skinWeight = mesh.geometry.getAttribute("skinWeight");
    if (!index || !skinIndex || !skinWeight)
      throw new Error("Incomplete rendered skin");
    const descendants = new Set<number>();
    mesh.skeleton.bones.forEach((bone, boneIndex) => {
      let current: THREE.Object3D | null = bone;
      while (current) {
        if (current === handBone) {
          descendants.add(boneIndex);
          break;
        }
        current = current.parent;
      }
    });
    mesh.skeleton.update();
    let allowedCount = 0,
      forbiddenCount = 0;
    const allowedSourceTriangleIndices: number[] = [],
      forbiddenSourceTriangleIndices: number[] = [];
    for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
      const vertices = [0, 1, 2].map((corner) =>
        index.getX(triangle * 3 + corner),
      );
      const allowed = vertices.every((vertex) => {
        let sum = 0;
        for (let k = 0; k < 4; k += 1)
          if (descendants.has(skinIndex.getComponent(vertex, k)))
            sum += skinWeight.getComponent(vertex, k);
        return sum >= 0.5;
      });
      const output = allowed ? handPositions : forbiddenPositions;
      if (allowed) {
        handTriangles += 1;
        allowedCount += 1;
        allowedSourceTriangleIndices.push(triangle);
      } else {
        forbiddenTriangles += 1;
        forbiddenCount += 1;
        forbiddenSourceTriangleIndices.push(triangle);
      }
      for (const vertex of vertices) {
        const point = new THREE.Vector3().fromBufferAttribute(position, vertex);
        mesh.applyBoneTransform(vertex, point);
        point.applyMatrix4(mesh.matrixWorld);
        output.push(...point.toArray());
      }
    }
    membership.push({
      mesh: mesh.name,
      handTriangles: allowedCount,
      forbiddenTriangles: forbiddenCount,
      allowedSourceTriangleIndices,
      forbiddenSourceTriangleIndices,
    });
  });
  if (
    handTriangles !== 136 ||
    forbiddenTriangles !== 5664 ||
    membership.length !== 9 ||
    membership.some(
      (entry) => entry.handTriangles > 0 && entry.mesh !== "Knight_ArmRight",
    )
  )
    throw new Error("Frozen 136-face gripping region changed");
  const geometry = (positions: number[]) =>
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
  return {
    hand: geometry(handPositions),
    forbidden: geometry(forbiddenPositions),
    handTriangles,
    forbiddenTriangles,
    membership,
  };
}

export async function searchKnightShortswordPoseFit({
  candidateCount = 1024,
  cpuBudgetMs = 90_000,
}: { candidateCount?: number; cpuBudgetMs?: number } = {}) {
  if (!Number.isFinite(cpuBudgetMs) || cpuBudgetMs <= 0 || cpuBudgetMs > 90_000)
    throw new Error("CPU budget must be within 90 seconds");
  if (
    !Number.isInteger(candidateCount) ||
    candidateCount < 1 ||
    candidateCount > 1024
  )
    throw new Error("Invalid candidate budget");
  const started = performance.now(),
    deadline = started + cpuBudgetMs;
  const frozenBytes = readExact(
    `${FROZEN_ROOT}/inputs.json`,
    FROZEN_INPUTS_SHA256,
  );
  const inputs = JSON.parse(frozenBytes.toString("utf8")) as FrozenInputs;
  const candidate = inputs.candidates.find((entry) =>
    entry.candidatePath.endsWith(
      "/authored-socket-surface-seated-candidate.glb",
    ),
  );
  if (!candidate) throw new Error("Missing exact frozen source candidate");
  const avatarBytes = readExact(inputs.avatar.path, inputs.avatar.sha256);
  const equipmentBytes = readExact(candidate.candidatePath, candidate.sha256);
  const motionBytes = Object.fromEntries(
    Object.entries(inputs.runtimeAssets).map(([role, item]) => [
      role,
      readExact(`${ASSET_ROOT}/${item.asset}`, item.sha256),
    ]),
  ) as Record<Role, Buffer>;
  const definition = JSON.parse(
    readExact(
      "scripts/kaykit-shortsword-semantic-grip-definition.json",
      inputs.definitionSha256,
    ).toString("utf8"),
  ) as { sourceTriangleRegions: Record<Region, Array<[number, number]>> };
  const equipment = await parse(equipmentBytes);
  equipment.scene.updateMatrixWorld(true);
  const wrapper = equipment.scene.getObjectByName("EquipmentWrapper"),
    content = equipment.scene.getObjectByName("EquipmentContent");
  const weapon = content?.getObjectByProperty("isMesh", true) as
    THREE.Mesh | undefined;
  if (
    !wrapper ||
    !content ||
    !weapon ||
    weapon.geometry.getIndex()?.count !== 900
  )
    throw new Error("Unexpected fixed sword topology");
  if (!weapon.matrix.equals(IDENTITY))
    throw new Error("Source mesh left its content frame");
  const originalWrapper = wrapper.matrix.clone(),
    contentMatrix = content.matrix.clone();
  const regions = Object.fromEntries(
    Object.entries(definition.sourceTriangleRegions).map(([name, ranges]) => {
      const geometry = weapon.geometry.clone(),
        index = weapon.geometry.getIndex()!;
      const selected = ranges.flatMap(([start, end]) =>
        Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
      );
      geometry.setIndex(
        selected.flatMap((triangle) =>
          [0, 1, 2].map((corner) => index.getX(triangle * 3 + corner)),
        ),
      );
      return [name, geometry];
    }),
  ) as Record<Region, THREE.BufferGeometry>;
  const handleBounds = new THREE.Box3();
  const hp = regions.handle.getAttribute("position"),
    hi = regions.handle.getIndex()!;
  for (let index = 0; index < hi.count; index += 1)
    handleBounds.expandByPoint(
      new THREE.Vector3().fromBufferAttribute(hp, hi.getX(index)),
    );
  const handleCenter = handleBounds
    .getCenter(new THREE.Vector3())
    .applyMatrix4(contentMatrix);
  const clips: Partial<Record<Role, { duration: number; times: number[] }>> =
    {};
  let membership:
    ReturnType<typeof splitAvatarSurfaces>["membership"] | undefined;
  async function loadPose(
    role: Role,
    time: { ratio: number } | { seconds: number },
  ): Promise<Pose> {
    const loaded = await parse(avatarBytes, true),
      vrm = loaded.userData.vrm as VRM;
    vrm.scene.updateMatrixWorld(true);
    vrm.humanoid.update();
    const initialHeight = new THREE.Box3()
      .setFromObject(vrm.scene, true)
      .getSize(new THREE.Vector3()).y;
    const normalizationScale = 1.6 / initialHeight;
    vrm.scene.scale.setScalar(normalizationScale);
    vrm.scene.updateMatrixWorld(true);
    const animated = await parse(motionBytes[role]);
    const clip = createEmoteFactory(
      animated as unknown as GLBData,
      inputs.runtimeAssets[role].asset,
    ).toClip({
      rootToHips: vrm.humanoid
        .getRawBoneNode("hips")!
        .getWorldPosition(new THREE.Vector3()).y,
      version: vrm.meta.metaVersion,
      getBoneName: (name: string) =>
        vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.name,
    });
    clips[role] ??= {
      duration: clip.duration,
      times: sampleClipTimes(
        clip.duration,
        clip.tracks.flatMap((track) => Array.from(track.times)),
      ),
    };
    const mixer = new THREE.AnimationMixer(vrm.scene),
      action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(0);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    const seconds = Math.min(
      "ratio" in time ? clip.duration * time.ratio : time.seconds,
      clip.duration,
    );
    mixer.setTime(seconds);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    const surfaces = splitAvatarSurfaces(vrm);
    membership ??= surfaces.membership;
    const result = {
      id: `${role}:${seconds.toFixed(9)}`,
      role,
      seconds,
      wristWorld: vrm.humanoid.getRawBoneNode("rightHand")!.matrixWorld.clone(),
      hand: surfaces.hand,
      forbidden: surfaces.forbidden,
      handBvh: new MeshBVH(surfaces.hand, { indirect: true, verbose: false }),
      forbiddenBvh: new MeshBVH(surfaces.forbidden, {
        indirect: true,
        verbose: false,
      }),
      handTriangleCount: surfaces.handTriangles,
      forbiddenTriangleCount: surfaces.forbiddenTriangles,
      initialHeight,
      normalizationScale,
    };
    mixer.stopAllAction();
    mixer.uncacheRoot(vrm.scene);
    disposeScene(vrm.scene);
    disposeScene(animated.scene);
    return result;
  }
  function disposePose(pose: Pose) {
    pose.hand.dispose();
    pose.forbidden.dispose();
  }
  function testPose(pose: Pose, matrix: THREE.Matrix4) {
    const toWorld = pose.wristWorld
      .clone()
      .multiply(matrix)
      .multiply(contentMatrix);
    // Match the grip audit's world-space Float32 handle soup, without changing its 80 faces.
    const handleWorld = regions.handle.toNonIndexed();
    handleWorld.applyMatrix4(toWorld);
    const handleContact = pose.handBvh.intersectsGeometry(
      handleWorld,
      IDENTITY,
    );
    handleWorld.dispose();
    if (!handleContact) return { predicate: "handle-contact", pose: pose.id };
    for (const region of ["blade", "guard", "pommel"] as const)
      if (pose.handBvh.intersectsGeometry(regions[region], toWorld))
        return {
          predicate: `${region}-gripping-hand-intersection`,
          pose: pose.id,
        };
    if (pose.forbiddenBvh.intersectsGeometry(weapon!.geometry, toWorld))
      return {
        predicate: "weapon-forbidden-avatar-intersection",
        pose: pose.id,
      };
    return null;
  }
  const coarse: Pose[] = [];
  const rejections: Array<{
    index: number;
    translationMetres: number[];
    rotationDegrees: number;
    predicate: string;
    pose: string;
    passedCoarsePoses: number;
    testedDensePoses: number;
  }> = [];
  let feasible: {
    index: number;
    matrix: number[];
    densePoseCount: number;
    translationMetres: number[];
    rotationDegrees: number;
  } | null = null;
  let budgetExhausted = false,
    attempted = 0,
    evaluated = 0,
    coarsePoseTests = 0,
    densePoseTests = 0;
  let interruptedCandidate: {
    index: number;
    passedCoarsePoses: number;
    testedDensePoses: number;
  } | null = null;
  try {
    for (const [role, ratio] of [
      ["sword", 0.85],
      ["sword", 0.45],
      ["sword", 0.15],
      ["idle", 0.35],
      ["walk", 0.15],
      ["run", 0.75],
    ] as const) {
      if (performance.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      coarse.push(await loadPose(role, { ratio }));
    }
    const candidates = budgetExhausted
      ? []
      : generateRigidCandidates(
          originalWrapper,
          handleCenter,
          coarse[0].normalizationScale,
          candidateCount,
        );
    for (const proposed of candidates) {
      if (performance.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      attempted += 1;
      let rejected = false,
        passedCoarsePoses = 0;
      for (const pose of coarse) {
        if (performance.now() >= deadline) {
          budgetExhausted = true;
          interruptedCandidate = {
            index: proposed.index,
            passedCoarsePoses,
            testedDensePoses: 0,
          };
          rejected = true;
          break;
        }
        const failure = testPose(pose, proposed.matrix);
        coarsePoseTests += 1;
        if (failure) {
          rejections.push({
            index: proposed.index,
            translationMetres: proposed.translationMetres,
            rotationDegrees: proposed.rotationDegrees,
            ...failure,
            passedCoarsePoses,
            testedDensePoses: 0,
          });
          evaluated += 1;
          rejected = true;
          break;
        }
        passedCoarsePoses += 1;
      }
      if (budgetExhausted) break;
      if (rejected) continue;
      let densePoseCount = 0;
      for (const role of ["sword", "idle", "walk", "run"] as const) {
        for (const seconds of clips[role]!.times) {
          if (performance.now() >= deadline) {
            budgetExhausted = true;
            rejected = true;
            break;
          }
          const pose = await loadPose(role, { seconds });
          const failure = testPose(pose, proposed.matrix);
          densePoseCount += 1;
          densePoseTests += 1;
          disposePose(pose);
          if (failure) {
            rejections.push({
              index: proposed.index,
              translationMetres: proposed.translationMetres,
              rotationDegrees: proposed.rotationDegrees,
              ...failure,
              passedCoarsePoses,
              testedDensePoses: densePoseCount,
            });
            evaluated += 1;
            rejected = true;
            break;
          }
        }
        if (rejected) break;
      }
      if (!rejected) {
        if (performance.now() >= deadline) {
          budgetExhausted = true;
          interruptedCandidate = {
            index: proposed.index,
            passedCoarsePoses,
            testedDensePoses: densePoseCount,
          };
          break;
        }
        evaluated += 1;
        feasible = {
          index: proposed.index,
          matrix: proposed.matrix.toArray(),
          densePoseCount,
          translationMetres: proposed.translationMetres,
          rotationDegrees: proposed.rotationDegrees,
        };
        break;
      }
      if (budgetExhausted) {
        interruptedCandidate = {
          index: proposed.index,
          passedCoarsePoses,
          testedDensePoses: densePoseCount,
        };
        break;
      }
    }
    return {
      schemaVersion: 1,
      productApproved: false,
      status: feasible
        ? "sampled-surface-predicates-feasible-not-approved"
        : budgetExhausted
          ? "budget-exhausted-no-approved-fit"
          : "no-feasible-transform-found-among-tested-candidates",
      inputHashes: {
        frozenInputs: digest(frozenBytes),
        avatar: inputs.avatar.sha256,
        sourceCandidate: candidate.sha256,
        semanticDefinition: inputs.definitionSha256,
        runtimeAssets: inputs.runtimeAssets,
        retargetHelper: digest(
          readFileSync(
            path.join(
              WORKSPACE,
              "packages/shared/src/extras/three/createEmoteFactory.ts",
            ),
          ),
        ),
      },
      geometryLibraryVersions: Object.fromEntries(
        ["three", "@pixiv/three-vrm", "three-mesh-bvh"].map((name) => [
          name,
          libraryVersion(name),
        ]),
      ),
      bounds: {
        maximumCandidates: candidateCount,
        cpuBudgetMs,
        budgetClock:
          "wall-clock deadline for CPU-only work; checked between indivisible pose loads/evaluations",
        maximumGripCenterAxisTranslationMetres: 0.012,
        maximumTotalRotationDegrees: 20,
        coordinateFrame:
          "one fixed raw-wrist-local matrix; rotation about scaled source handle center; unchanged content scale",
      },
      evaluated,
      attempted,
      coverage: { coarsePoseTests, densePoseTests, interruptedCandidate },
      elapsedMs: performance.now() - started,
      budgetExhausted,
      feasible,
      membership,
      coarsePoses: coarse.map((pose) => ({
        id: pose.id,
        handTriangleCount: pose.handTriangleCount,
        forbiddenTriangleCount: pose.forbiddenTriangleCount,
        initialHeight: pose.initialHeight,
        normalizationScale: pose.normalizationScale,
      })),
      plannedDenseClipSampleCounts: Object.fromEntries(
        Object.entries(clips).map(([role, clip]) => [role, clip.times.length]),
      ),
      plannedDenseClipTimesSeconds: Object.fromEntries(
        Object.entries(clips).map(([role, clip]) => [role, clip.times]),
      ),
      failureCounts: Object.fromEntries(
        [...new Set(rejections.map((failure) => failure.predicate))].map(
          (predicate) => [
            predicate,
            rejections.filter((failure) => failure.predicate === predicate)
              .length,
          ],
        ),
      ),
      rejections,
      limitations: [
        "This finite deterministic search is not an exhaustive feasibility proof over continuous transforms or time.",
        "Only the exact 136 gripping-hand faces may contact the exact 80 handle faces; all other avatar faces are forbidden to the entire weapon. Blade/guard/pommel also cannot intersect the gripping-hand region.",
        "Surface predicates do not prove absence of complete solid containment, acceptable contact depth or visually natural grip; those remain required before approval.",
        "No output GLB, active manifest, default, animation or source model is changed. A feasible matrix is only a proposal for independent review.",
      ],
    };
  } finally {
    coarse.forEach(disposePose);
    Object.values(regions).forEach((geometry) => geometry.dispose());
    disposeScene(equipment.scene);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((argument) => argument !== "--write-report"))
    throw new Error("Unknown search argument");
  const report = await searchKnightShortswordPoseFit();
  if (process.argv.includes("--write-report")) {
    const destination = path.join(
      WORKSPACE,
      EVIDENCE_ROOT,
      "search-exact-endpoint-1024.json",
    );
    if (existsSync(destination))
      throw new Error("Refusing to overwrite existing search evidence");
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      `${JSON.stringify({ ...report, scriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))) }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ...report, rejections: undefined, membership: report.membership?.map(({ mesh, handTriangles, forbiddenTriangles }) => ({ mesh, handTriangles, forbiddenTriangles })), plannedDenseClipTimesSeconds: undefined }, null, 2)}\n`,
  );
}
