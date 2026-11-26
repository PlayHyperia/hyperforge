import { VRMLoaderPlugin, type VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import { createSkinnedBoneRegionGeometry } from "./lib/skinned-bone-region";

const MAX_ROTATION_RECONSTRUCTION_ERROR_DEGREES = 0.02;

interface FitDefinition {
  itemId: string;
  attachmentBone: "leftHand" | "rightHand";
  sourcePath: string;
  sourceSha256: string;
  targetLengthMetres: number;
  desiredWorldEulerDegrees: [number, number, number];
  desiredWorldOffsetMetres: [number, number, number];
  sourceGripPoint?: [number, number, number];
  primaryGripAnchor?: "hand-mesh-center";
  alignHandleToSecondaryHand?: {
    sourceHandleAxis: [number, number, number];
    secondaryGripAnchor?: "hand-mesh-center";
  };
  referenceMotion: {
    path: string;
    sha256: string;
    sampleRatio: number;
  };
}

interface FitConfig {
  avatar: {
    id: string;
    path: string;
    sha256: string;
    normalizedHeight: number;
  };
  fits: FitDefinition[];
}

export interface BrowserRigidFitResult {
  itemId: string;
  attachmentBone: "leftHand" | "rightHand";
  relativeMatrix: number[];
  contentScale: number;
  sourceLongestDimension: number;
  targetLengthMetres: number;
  referenceMotionDurationSeconds: number;
  referenceMotionSampleSeconds: number;
  referenceHandSeparationMetres: number;
  referenceMotionHandSeparationRangeMetres: {
    minimum: number;
    maximum: number;
    samples: Array<{ ratio: number; distance: number }>;
  };
  targetBoneWorldScale: number;
  primaryHandMeshCenterBoneLocal: [number, number, number];
  secondaryHandMeshCenterBoneLocal: [number, number, number];
  fittedWorldPositionErrorMetres: number;
  fittedWorldRotationErrorDegrees: number;
}

declare global {
  interface Window {
    __fitReport?: BrowserRigidFitResult[];
  }
}

function finiteVector(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

function roundArray(values: readonly number[]): number[] {
  return values.map(round);
}

function skinnedBoneRegionWorldCenter(
  avatarRoot: THREE.Object3D,
  bone: THREE.Object3D,
  label: string,
): THREE.Vector3 {
  const region = createSkinnedBoneRegionGeometry(avatarRoot, bone);
  try {
    if (region.triangleCount === 0 || !region.geometry.boundingBox) {
      throw new Error(`${label} has no skinned hand-region geometry`);
    }
    return region.geometry.boundingBox.getCenter(new THREE.Vector3());
  } finally {
    region.geometry.dispose();
  }
}

async function fitOne(
  config: FitConfig,
  definition: FitDefinition,
): Promise<BrowserRigidFitResult> {
  const avatarLoader = new GLTFLoader();
  avatarLoader.register((parser) => new VRMLoaderPlugin(parser));
  const avatarGlb = await avatarLoader.loadAsync(
    `/asset/${config.avatar.path}`,
  );
  const vrm = avatarGlb.userData.vrm;
  if (!vrm?.humanoid) {
    throw new Error(`${config.avatar.path} is not a humanoid VRM`);
  }
  const avatarBounds = new THREE.Box3().setFromObject(vrm.scene, true);
  const avatarHeight = avatarBounds.getSize(new THREE.Vector3()).y;
  if (!Number.isFinite(avatarHeight) || avatarHeight <= 0) {
    throw new Error("Canonical avatar has invalid bounds");
  }
  vrm.scene.scale.setScalar(config.avatar.normalizedHeight / avatarHeight);
  vrm.scene.updateMatrixWorld(true);

  const rawHips = vrm.humanoid.getRawBoneNode("hips");
  const rootToHips = rawHips?.getWorldPosition(new THREE.Vector3()).y ?? 1;
  const version = vrm.meta?.metaVersion ?? "1";
  const getBoneName = (boneName: string): string | undefined =>
    vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)?.name;

  const animationLoader = new GLTFLoader();
  const animationGlb = await animationLoader.loadAsync(
    `/asset/${definition.referenceMotion.path}`,
  );
  const emote = createEmoteFactory(
    animationGlb,
    definition.referenceMotion.path,
  );
  const clip = emote.toClip({ rootToHips, version, getBoneName });
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
    throw new Error(`${definition.itemId} reference motion is invalid`);
  }
  const sampleSeconds = Math.min(
    Math.max(clip.duration * definition.referenceMotion.sampleRatio, 0),
    Math.max(clip.duration - 0.001, 0),
  );
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const leftHand = vrm.humanoid.getRawBoneNode("leftHand");
  const rightHand = vrm.humanoid.getRawBoneNode("rightHand");
  if (!leftHand || !rightHand) {
    throw new Error(`${config.avatar.id} is missing a required hand bone`);
  }
  const handSeparationSamples = Array.from({ length: 11 }, (_, index) => {
    const ratio = index / 10;
    const time = Math.min(
      Math.max(clip.duration * ratio, 0),
      Math.max(clip.duration - 0.001, 0),
    );
    mixer.setTime(time);
    vrm.humanoid.update(0);
    vrm.scene.updateMatrixWorld(true);
    return {
      ratio,
      distance: leftHand
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(rightHand.getWorldPosition(new THREE.Vector3())),
    };
  });
  mixer.setTime(sampleSeconds);
  vrm.humanoid.update(0);
  vrm.scene.updateMatrixWorld(true);

  const targetBone = vrm.humanoid.getRawBoneNode(definition.attachmentBone);
  if (!targetBone) {
    throw new Error(
      `${config.avatar.id} is missing ${definition.attachmentBone}`,
    );
  }
  targetBone.updateWorldMatrix(true, false);
  const secondaryBone =
    definition.attachmentBone === "rightHand" ? leftHand : rightHand;
  const primaryHandMeshCenter = skinnedBoneRegionWorldCenter(
    vrm.scene,
    targetBone,
    `${definition.itemId} primary hand`,
  );
  const secondaryHandMeshCenter = skinnedBoneRegionWorldCenter(
    vrm.scene,
    secondaryBone,
    `${definition.itemId} secondary hand`,
  );
  const primaryHandMeshCenterBoneLocal = targetBone.worldToLocal(
    primaryHandMeshCenter.clone(),
  );
  const secondaryHandMeshCenterBoneLocal = secondaryBone.worldToLocal(
    secondaryHandMeshCenter.clone(),
  );
  const referenceHandSeparation = leftHand
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(rightHand.getWorldPosition(new THREE.Vector3()));

  const equipmentLoader = new GLTFLoader();
  const equipmentGlb = await equipmentLoader.loadAsync(
    `/asset/${definition.sourcePath}`,
  );
  const equipmentBounds = new THREE.Box3().setFromObject(
    equipmentGlb.scene,
    true,
  );
  const equipmentSize = equipmentBounds.getSize(new THREE.Vector3());
  const sourceLongestDimension = Math.max(
    equipmentSize.x,
    equipmentSize.y,
    equipmentSize.z,
  );
  if (
    !finiteVector(equipmentSize.toArray()) ||
    !Number.isFinite(sourceLongestDimension) ||
    sourceLongestDimension <= 0
  ) {
    throw new Error(`${definition.itemId} source geometry has invalid bounds`);
  }

  const targetPosition = (
    definition.primaryGripAnchor === "hand-mesh-center"
      ? primaryHandMeshCenter
      : targetBone.getWorldPosition(new THREE.Vector3())
  )
    .clone()
    .add(new THREE.Vector3(...definition.desiredWorldOffsetMetres));
  const authoredQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      ...(definition.desiredWorldEulerDegrees.map(THREE.MathUtils.degToRad) as [
        number,
        number,
        number,
      ]),
      "XYZ",
    ),
  );
  const desiredQuaternion = authoredQuaternion.clone();
  if (definition.alignHandleToSecondaryHand) {
    const sourceHandleAxis = new THREE.Vector3(
      ...definition.alignHandleToSecondaryHand.sourceHandleAxis,
    );
    const targetHandleAxis = (
      definition.alignHandleToSecondaryHand.secondaryGripAnchor ===
      "hand-mesh-center"
        ? secondaryHandMeshCenter
        : secondaryBone.getWorldPosition(new THREE.Vector3())
    )
      .clone()
      .sub(targetPosition);
    if (
      !finiteVector(sourceHandleAxis.toArray()) ||
      !finiteVector(targetHandleAxis.toArray()) ||
      sourceHandleAxis.lengthSq() <= 1e-8 ||
      targetHandleAxis.lengthSq() <= 1e-8
    ) {
      throw new Error(`${definition.itemId} two-hand alignment is invalid`);
    }
    desiredQuaternion
      .setFromUnitVectors(
        sourceHandleAxis.normalize(),
        targetHandleAxis.normalize(),
      )
      .multiply(authoredQuaternion)
      .normalize();
  }
  const boneWorldQuaternion = targetBone.getWorldQuaternion(
    new THREE.Quaternion(),
  );
  const localQuaternion = boneWorldQuaternion
    .clone()
    .invert()
    .multiply(desiredQuaternion)
    .normalize();
  const localPosition = targetBone.worldToLocal(targetPosition.clone());
  const boneWorldScale = targetBone.getWorldScale(new THREE.Vector3());
  if (
    !finiteVector(boneWorldScale.toArray()) ||
    boneWorldScale.x <= 0 ||
    Math.max(
      Math.abs(boneWorldScale.x - boneWorldScale.y),
      Math.abs(boneWorldScale.x - boneWorldScale.z),
    ) > 0.000001
  ) {
    throw new Error(
      `${definition.itemId} target bone does not have a finite uniform scale`,
    );
  }
  const targetScale = definition.targetLengthMetres / sourceLongestDimension;
  const contentScale = targetScale / boneWorldScale.x;

  const verificationWrapper = new THREE.Group();
  verificationWrapper.position.copy(localPosition);
  verificationWrapper.quaternion.copy(localQuaternion);
  targetBone.add(verificationWrapper);
  const worldCorrection = new THREE.Quaternion();
  const localCorrection = new THREE.Quaternion();
  for (let iteration = 0; iteration < 4; iteration += 1) {
    verificationWrapper.updateMatrixWorld(true);
    const reconstructed = verificationWrapper.getWorldQuaternion(
      new THREE.Quaternion(),
    );
    if (
      THREE.MathUtils.radToDeg(reconstructed.angleTo(desiredQuaternion)) <=
      0.000001
    ) {
      break;
    }
    worldCorrection
      .copy(desiredQuaternion)
      .multiply(reconstructed.clone().invert())
      .normalize();
    localCorrection
      .copy(boneWorldQuaternion)
      .invert()
      .multiply(worldCorrection)
      .multiply(boneWorldQuaternion)
      .normalize();
    localQuaternion.premultiply(localCorrection).normalize();
    verificationWrapper.quaternion.copy(localQuaternion);
  }
  verificationWrapper.updateMatrixWorld(true);
  const fittedPosition = verificationWrapper.getWorldPosition(
    new THREE.Vector3(),
  );
  const fittedQuaternion = verificationWrapper.getWorldQuaternion(
    new THREE.Quaternion(),
  );
  const positionError = fittedPosition.distanceTo(targetPosition);
  const rotationError = THREE.MathUtils.radToDeg(
    fittedQuaternion.angleTo(desiredQuaternion),
  );
  targetBone.remove(verificationWrapper);
  const relativeMatrix = new THREE.Matrix4().compose(
    localPosition,
    localQuaternion,
    new THREE.Vector3(1, 1, 1),
  );

  mixer.stopAllAction();
  mixer.uncacheRoot(vrm.scene);
  if (
    positionError > 0.000001 ||
    rotationError > MAX_ROTATION_RECONSTRUCTION_ERROR_DEGREES
  ) {
    throw new Error(
      `${definition.itemId} fit reconstruction drifted (${positionError}m, ${rotationError}deg)`,
    );
  }

  const result: BrowserRigidFitResult = {
    itemId: definition.itemId,
    attachmentBone: definition.attachmentBone,
    relativeMatrix: roundArray(relativeMatrix.elements),
    contentScale: round(contentScale),
    sourceLongestDimension: round(sourceLongestDimension),
    targetLengthMetres: definition.targetLengthMetres,
    referenceMotionDurationSeconds: round(clip.duration),
    referenceMotionSampleSeconds: round(sampleSeconds),
    referenceHandSeparationMetres: round(referenceHandSeparation),
    referenceMotionHandSeparationRangeMetres: {
      minimum: round(
        Math.min(...handSeparationSamples.map((sample) => sample.distance)),
      ),
      maximum: round(
        Math.max(...handSeparationSamples.map((sample) => sample.distance)),
      ),
      samples: handSeparationSamples.map((sample) => ({
        ratio: sample.ratio,
        distance: round(sample.distance),
      })),
    },
    targetBoneWorldScale: round(boneWorldScale.x),
    primaryHandMeshCenterBoneLocal: roundArray(
      primaryHandMeshCenterBoneLocal.toArray(),
    ) as [number, number, number],
    secondaryHandMeshCenterBoneLocal: roundArray(
      secondaryHandMeshCenterBoneLocal.toArray(),
    ) as [number, number, number],
    fittedWorldPositionErrorMetres: round(positionError),
    fittedWorldRotationErrorDegrees: round(rotationError),
  };
  if (
    !finiteVector(result.relativeMatrix) ||
    !finiteVector([
      result.contentScale,
      result.sourceLongestDimension,
      result.referenceMotionDurationSeconds,
      result.referenceMotionSampleSeconds,
      result.referenceHandSeparationMetres,
      result.referenceMotionHandSeparationRangeMetres.minimum,
      result.referenceMotionHandSeparationRangeMetres.maximum,
      ...result.referenceMotionHandSeparationRangeMetres.samples.flatMap(
        (sample) => [sample.ratio, sample.distance],
      ),
      result.targetBoneWorldScale,
      ...result.primaryHandMeshCenterBoneLocal,
      ...result.secondaryHandMeshCenterBoneLocal,
      result.fittedWorldPositionErrorMetres,
      result.fittedWorldRotationErrorDegrees,
    ])
  ) {
    throw new Error(`${definition.itemId} fit contains a non-finite result`);
  }
  return result;
}

export async function deriveSteveRigidEquipmentFits(
  config: FitConfig,
): Promise<BrowserRigidFitResult[]> {
  const results: BrowserRigidFitResult[] = [];
  for (const definition of config.fits) {
    results.push(await fitOne(config, definition));
  }
  return results;
}
