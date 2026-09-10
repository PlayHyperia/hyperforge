import { VRMLoaderPlugin, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import THREE from "../packages/shared/src/extras/three/three";
import {
  avatarEmoteBlendSecondsFor,
  AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
  AVATAR_EMOTE_BLEND_SECONDS,
  fadeInAvatarEmote,
  fadeOutAvatarEmote,
} from "../packages/shared/src/extras/three/AvatarEmoteTransition";
import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import {
  attachEquipmentVisualToVRM,
  createTwoHandEquipmentGripController,
  extractEquipmentAttachmentData,
  validateStreamingEquipmentVisualModel,
} from "../packages/shared/src/systems/client/EquipmentVisualHelpers";
import {
  evaluateTwoHandPlaybackTelemetry,
  evaluateTwoHandPlaybackRenderTelemetry,
  TWO_HAND_PLAYBACK_DURATION_SECONDS,
  TWO_HAND_PLAYBACK_PHASES,
  TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
  twoHandPlaybackPhaseAt,
  type TwoHandPlaybackPhase,
  type TwoHandPlaybackTelemetry,
} from "./two-hand-candidate-playback-policy";

interface PlaybackClipDefinition {
  id: "idle" | "walk" | "run" | "attack";
  asset: string;
  loop: boolean;
  speed: number;
}

interface TwoHandCandidatePlaybackConfig {
  avatarAsset: string;
  avatarSha256: string;
  avatarId: string;
  equipmentAsset: string;
  equipmentSha256: string;
  itemId: string;
  clips: PlaybackClipDefinition[];
  activationStatus:
    "isolated-candidate" | "runtime-under-review" | "reviewed-production";
  approvedForRuntimeActivation: boolean;
  productApproval: {
    reviewerId: string;
    reviewedAt: string;
    record: { path: string; sha256: string };
    evidence: Array<{
      kind: "report" | "contact-sheet";
      path: string;
      sha256: string;
    }>;
  } | null;
}

const TRACKED_BONES = Object.freeze([
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const satisfies readonly VRMHumanBoneName[]);

const PHASE_CLIP_ID: Record<
  TwoHandPlaybackPhase["id"],
  PlaybackClipDefinition["id"]
> = {
  "idle-open": "idle",
  walk: "walk",
  run: "run",
  "idle-before-strike": "idle",
  attack: "attack",
  "idle-recovery": "idle",
  "walk-close": "walk",
};

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function finiteValues(values: number[]): boolean {
  return values.every(Number.isFinite);
}

function quaternionStepVectorDegrees(
  previous: THREE.Quaternion,
  current: THREE.Quaternion,
): THREE.Vector3 {
  const delta = previous.clone().invert().multiply(current).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const halfAngle = Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
  const sinHalfAngle = Math.sin(halfAngle);
  if (sinHalfAngle <= 1e-8) return new THREE.Vector3();
  return new THREE.Vector3(delta.x, delta.y, delta.z)
    .multiplyScalar(1 / sinHalfAngle)
    .multiplyScalar(THREE.MathUtils.radToDeg(halfAngle * 2));
}

function avatarBoundsExcludingEquipment(
  avatarRoot: THREE.Object3D,
  equipmentRoot: THREE.Object3D,
): THREE.Box3 {
  const excluded = new Set<THREE.Object3D>();
  equipmentRoot.traverse((object) => excluded.add(object));
  const bounds = new THREE.Box3();
  avatarRoot.traverse((object) => {
    if (excluded.has(object) || !(object instanceof THREE.Mesh)) return;
    bounds.union(new THREE.Box3().setFromObject(object, true));
  });
  return bounds;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas PNG encoding failed"));
    }, "image/png");
  });
}

export async function runTwoHandCandidatePlayback(
  config: TwoHandCandidatePlaybackConfig,
) {
  const width = 1280;
  const height = 720;
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = width;
  renderCanvas.height = height;
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  document.body.append(outputCanvas);
  const output = outputCanvas.getContext("2d", { alpha: false });
  if (!output) throw new Error("2D video compositor is unavailable");

  if (!navigator.gpu) {
    throw new Error("WebGPU is required for the two-hand playback gate");
  }
  const webGPUAdapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!webGPUAdapter) {
    throw new Error("Chrome did not expose a WebGPU adapter");
  }
  const renderer = new THREE.WebGPURenderer({
    canvas: renderCanvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  (
    renderer as unknown as {
      _getFallback: null;
    }
  )._getFallback = null;
  await renderer.init();
  const rendererBackend = (
    renderer as unknown as {
      backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
    }
  ).backend;
  if (
    rendererBackend?.isWebGPUBackend !== true ||
    rendererBackend.isWebGLBackend === true
  ) {
    renderer.dispose();
    throw new Error("Playback gate did not initialize a WebGPU backend");
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111a2d);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202025, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x68a2ff, 1.5);
  rim.position.set(-4, 3, -3);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1.35, 96),
    new THREE.MeshStandardMaterial({
      color: 0x0b1120,
      roughness: 0.9,
      metalness: 0.02,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const avatarLoader = new GLTFLoader();
  avatarLoader.register((parser) => new VRMLoaderPlugin(parser));
  const avatarGlb = await avatarLoader.loadAsync(
    `/asset/${config.avatarAsset}`,
  );
  const vrm = avatarGlb.userData.vrm;
  if (!vrm?.humanoid) throw new Error("Candidate avatar is not a humanoid VRM");
  scene.add(vrm.scene);
  vrm.scene.traverse((object: THREE.Object3D) => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
  vrm.scene.updateMatrixWorld(true);
  vrm.humanoid.update(0);
  const initialBounds = new THREE.Box3().setFromObject(vrm.scene, true);
  vrm.scene.scale.setScalar(
    1.6 / Math.max(initialBounds.getSize(new THREE.Vector3()).y, 0.001),
  );
  vrm.scene.updateMatrixWorld(true);

  const equipmentLoader = new GLTFLoader();
  const equipmentGlb = await equipmentLoader.loadAsync(
    `/asset/${config.equipmentAsset}`,
  );
  const equipmentRoot = equipmentGlb.scene;
  const equipmentValidation = validateStreamingEquipmentVisualModel(
    equipmentRoot,
    "weapon",
    { itemId: config.itemId, avatarId: config.avatarId, vrm },
  );
  if (!equipmentValidation.valid) {
    throw new Error(
      `Candidate equipment validation failed: ${equipmentValidation.reason}`,
    );
  }
  if (
    !attachEquipmentVisualToVRM({
      slot: "weapon",
      modelRoot: equipmentRoot,
      visuals: {},
      vrm,
    })
  ) {
    throw new Error("Candidate equipment attachment failed");
  }
  equipmentRoot.traverse((object: THREE.Object3D) => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
  const twoHandGrip = createTwoHandEquipmentGripController({
    modelRoot: equipmentRoot,
    vrm,
  });
  if (!twoHandGrip) throw new Error("Two-hand grip controller is unavailable");
  const attachmentData = extractEquipmentAttachmentData(equipmentRoot);
  const grip = attachmentData?.twoHandGrip;
  if (!grip) throw new Error("Two-hand grip metadata is unavailable");
  const secondaryHand = vrm.humanoid.getRawBoneNode(grip.secondaryBoneName);
  if (!secondaryHand) throw new Error("Secondary grip bone is unavailable");
  const secondaryOffset = grip.secondaryBoneLocalOffset
    ? new THREE.Vector3(...grip.secondaryBoneLocalOffset)
    : null;
  const sourceHandleAxis = new THREE.Vector3(
    ...grip.sourceHandleAxis,
  ).normalize();

  const rawHips = vrm.humanoid.getRawBoneNode("hips");
  const rootToHips = rawHips?.getWorldPosition(new THREE.Vector3()).y ?? 1;
  const version = vrm.meta?.metaVersion ?? "1";
  const getBoneName = (boneName: string): string | undefined =>
    vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)?.name;
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const actions = new Map<
    PlaybackClipDefinition["id"],
    THREE.AnimationAction
  >();
  const clipDurations: Record<string, number> = {};
  for (const definition of config.clips) {
    const animationGlb = await new GLTFLoader().loadAsync(
      `/asset/${definition.asset}`,
    );
    const emote = createEmoteFactory(animationGlb, definition.asset);
    const clip = emote.toClip({ rootToHips, version, getBoneName });
    if (
      !Number.isFinite(clip.duration) ||
      clip.duration <= 0 ||
      clip.tracks.length < 8 ||
      clip.tracks.some(
        (track) =>
          !finiteValues(Array.from(track.times)) ||
          !finiteValues(Array.from(track.values)),
      )
    ) {
      throw new Error(
        `${definition.asset} produced an invalid retargeted clip`,
      );
    }
    actions.set(definition.id, mixer.clipAction(clip));
    clipDurations[definition.id] = rounded(clip.duration);
  }
  if (actions.size !== config.clips.length) {
    throw new Error("Playback clip IDs must be unique");
  }

  const trackedBones = TRACKED_BONES.flatMap((boneName) => {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    return node ? [{ boneName, node }] : [];
  });
  if (trackedBones.length < 18) {
    throw new Error("Candidate avatar is missing tracked playback bones");
  }

  const camera = new THREE.PerspectiveCamera(28, width / height, 0.01, 50);
  const cameraTarget = new THREE.Vector3(0, 0.86, 0);
  let activeAction: THREE.AnimationAction | null = null;
  let activeDefinition: PlaybackClipDefinition | null = null;
  let activePhaseId: TwoHandPlaybackPhase["id"] | null = null;

  const transitionTo = (phase: TwoHandPlaybackPhase) => {
    const definition = config.clips.find(
      (candidate) => candidate.id === PHASE_CLIP_ID[phase.id],
    );
    const incoming = definition ? actions.get(definition.id) : null;
    if (!definition || !incoming) {
      throw new Error(`Playback phase ${phase.id} has no action`);
    }
    const blendDurationSeconds = avatarEmoteBlendSecondsFor(
      activeDefinition?.asset,
      definition.asset,
    );
    fadeOutAvatarEmote(activeAction, blendDurationSeconds);
    incoming.stop();
    incoming.enabled = true;
    incoming.paused = false;
    incoming.setEffectiveWeight(1);
    incoming.setEffectiveTimeScale(definition.speed);
    incoming.clampWhenFinished = !definition.loop;
    incoming.setLoop(
      definition.loop ? THREE.LoopRepeat : THREE.LoopOnce,
      definition.loop ? Infinity : 1,
    );
    fadeInAvatarEmote(incoming, blendDurationSeconds);
    activeAction = incoming;
    activeDefinition = definition;
    activePhaseId = phase.id;
  };

  const step = (elapsedSeconds: number, deltaSeconds: number) => {
    const phase = twoHandPlaybackPhaseAt(elapsedSeconds);
    if (phase.id !== activePhaseId) transitionTo(phase);
    mixer.update(deltaSeconds);
    vrm.humanoid.update(deltaSeconds);
    vrm.scene.updateMatrixWorld(true);
    twoHandGrip.update();
    return phase;
  };

  const resetPlayback = () => {
    mixer.stopAllAction();
    for (const action of actions.values()) {
      action.stop();
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
    }
    vrm.humanoid.resetNormalizedPose?.();
    vrm.humanoid.update(0);
    vrm.scene.updateMatrixWorld(true);
    activeAction = null;
    activeDefinition = null;
    activePhaseId = null;
  };

  const telemetry: TwoHandPlaybackTelemetry = {
    deterministicFrameCount: 0,
    nonFiniteSampleCount: 0,
    minimumAvatarBoundsYMetres: Number.POSITIVE_INFINITY,
    maximumAvatarBoundsYMetres: Number.NEGATIVE_INFINITY,
    minimumWeaponBoundsYMetres: Number.POSITIVE_INFINITY,
    maximumGripAxisDeviationDegrees: 0,
    maximumBoneStepDegrees: 0,
    maximumBoneAccelerationDegreesPerFrameSquared: 0,
    maximumWeaponStepDegrees: 0,
  };
  let previousBoneRotations: THREE.Quaternion[] | null = null;
  let previousBoneStepVectors: THREE.Vector3[] | null = null;
  let previousWeaponRotation: THREE.Quaternion | null = null;
  let maximumBoneStep: {
    boneName: string;
    deltaDegrees: number;
    elapsedSeconds: number;
    phaseId: TwoHandPlaybackPhase["id"];
  } = {
    boneName: "",
    deltaDegrees: 0,
    elapsedSeconds: 0,
    phaseId: TWO_HAND_PLAYBACK_PHASES[0].id,
  };
  let maximumWeaponStep: {
    deltaDegrees: number;
    elapsedSeconds: number;
    phaseId: TwoHandPlaybackPhase["id"];
  } = {
    deltaDegrees: 0,
    elapsedSeconds: 0,
    phaseId: TWO_HAND_PLAYBACK_PHASES[0].id,
  };
  let maximumBoneAcceleration: {
    boneName: string;
    deltaDegreesPerFrameSquared: number;
    elapsedSeconds: number;
    phaseId: TwoHandPlaybackPhase["id"];
  } = {
    boneName: "",
    deltaDegreesPerFrameSquared: 0,
    elapsedSeconds: 0,
    phaseId: TWO_HAND_PLAYBACK_PHASES[0].id,
  };
  const wrapperPosition = new THREE.Vector3();
  const wrapperRotation = new THREE.Quaternion();
  const secondaryPosition = new THREE.Vector3();
  const desiredGripAxis = new THREE.Vector3();
  const currentGripAxis = new THREE.Vector3();

  resetPlayback();
  const deterministicFrameCount =
    Math.round(
      TWO_HAND_PLAYBACK_DURATION_SECONDS * TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
    ) + 1;
  for (let frame = 0; frame < deterministicFrameCount; frame += 1) {
    const elapsedSeconds = frame / TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ;
    const phase = step(
      elapsedSeconds,
      frame === 0 ? 0 : 1 / TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ,
    );
    telemetry.deterministicFrameCount += 1;
    const avatarBounds = avatarBoundsExcludingEquipment(
      vrm.scene,
      equipmentRoot,
    );
    const weaponBounds = new THREE.Box3().setFromObject(equipmentRoot, true);
    twoHandGrip.wrapper.getWorldPosition(wrapperPosition);
    twoHandGrip.wrapper.getWorldQuaternion(wrapperRotation);
    if (secondaryOffset) {
      secondaryPosition.copy(secondaryOffset);
      secondaryHand.localToWorld(secondaryPosition);
    } else {
      secondaryHand.getWorldPosition(secondaryPosition);
    }
    desiredGripAxis.copy(secondaryPosition).sub(wrapperPosition).normalize();
    currentGripAxis
      .copy(sourceHandleAxis)
      .applyQuaternion(wrapperRotation)
      .normalize();
    const gripDeviationDegrees = THREE.MathUtils.radToDeg(
      currentGripAxis.angleTo(desiredGripAxis),
    );
    const boneRotations = trackedBones.map(({ node }) =>
      node.quaternion.clone(),
    );
    const boneStepVectors = previousBoneRotations
      ? boneRotations.map((rotation, index) =>
          quaternionStepVectorDegrees(previousBoneRotations![index], rotation),
        )
      : null;
    const finiteSample = finiteValues([
      avatarBounds.min.y,
      weaponBounds.min.y,
      gripDeviationDegrees,
      ...wrapperRotation.toArray(),
      ...boneRotations.flatMap((quaternion) => quaternion.toArray()),
    ]);
    if (!finiteSample) telemetry.nonFiniteSampleCount += 1;
    if (elapsedSeconds >= 0.25) {
      telemetry.minimumAvatarBoundsYMetres = Math.min(
        telemetry.minimumAvatarBoundsYMetres,
        avatarBounds.min.y,
      );
      telemetry.maximumAvatarBoundsYMetres = Math.max(
        telemetry.maximumAvatarBoundsYMetres,
        avatarBounds.min.y,
      );
      telemetry.minimumWeaponBoundsYMetres = Math.min(
        telemetry.minimumWeaponBoundsYMetres,
        weaponBounds.min.y,
      );
      telemetry.maximumGripAxisDeviationDegrees = Math.max(
        telemetry.maximumGripAxisDeviationDegrees,
        gripDeviationDegrees,
      );
      if (previousBoneRotations && boneStepVectors) {
        for (let index = 0; index < boneRotations.length; index += 1) {
          const deltaDegrees = boneStepVectors[index].length();
          if (deltaDegrees > maximumBoneStep.deltaDegrees) {
            maximumBoneStep = {
              boneName: trackedBones[index].boneName,
              deltaDegrees,
              elapsedSeconds,
              phaseId: phase.id,
            };
          }
          if (previousBoneStepVectors) {
            const accelerationDegreesPerFrameSquared = boneStepVectors[
              index
            ].distanceTo(previousBoneStepVectors[index]);
            if (
              accelerationDegreesPerFrameSquared >
              maximumBoneAcceleration.deltaDegreesPerFrameSquared
            ) {
              maximumBoneAcceleration = {
                boneName: trackedBones[index].boneName,
                deltaDegreesPerFrameSquared: accelerationDegreesPerFrameSquared,
                elapsedSeconds,
                phaseId: phase.id,
              };
            }
          }
        }
        telemetry.maximumBoneStepDegrees = maximumBoneStep.deltaDegrees;
        telemetry.maximumBoneAccelerationDegreesPerFrameSquared =
          maximumBoneAcceleration.deltaDegreesPerFrameSquared;
      }
      if (previousWeaponRotation) {
        const deltaDegrees = THREE.MathUtils.radToDeg(
          wrapperRotation.angleTo(previousWeaponRotation),
        );
        if (deltaDegrees > maximumWeaponStep.deltaDegrees) {
          maximumWeaponStep = {
            deltaDegrees,
            elapsedSeconds,
            phaseId: phase.id,
          };
        }
        telemetry.maximumWeaponStepDegrees = maximumWeaponStep.deltaDegrees;
      }
    }
    previousBoneRotations = boneRotations;
    previousBoneStepVectors = boneStepVectors;
    previousWeaponRotation = wrapperRotation.clone();
  }
  for (const key of Object.keys(telemetry) as Array<keyof typeof telemetry>) {
    telemetry[key] = rounded(telemetry[key]);
  }
  const motionEvaluation = evaluateTwoHandPlaybackTelemetry(telemetry);

  resetPlayback();
  step(0, 0);
  camera.position.set(0, 1.02, 4.25);
  camera.lookAt(cameraTarget);
  const warmupStartedAt = performance.now();
  await renderer.renderAsync(scene, camera);
  const webGPUFirstRenderMs = rounded(performance.now() - warmupStartedAt);
  let webGPUStabilizationFrameCount = 0;
  const webGPUStabilizationStartedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    let previousAt: number | null = null;
    const renderFrame = async (now: number) => {
      try {
        const deltaSeconds =
          previousAt === null ? 0 : (now - previousAt) / 1_000;
        previousAt = now;
        step(0, deltaSeconds);
        await renderer.renderAsync(scene, camera);
        webGPUStabilizationFrameCount += 1;
        if (performance.now() - webGPUStabilizationStartedAt >= 500) {
          resolve();
        } else {
          requestAnimationFrame((nextNow) => void renderFrame(nextNow));
        }
      } catch (error) {
        reject(error);
      }
    };
    requestAnimationFrame((now) => void renderFrame(now));
  });
  const webGPUStabilizationMs = rounded(
    performance.now() - webGPUStabilizationStartedAt,
  );
  resetPlayback();

  const runtimeFrameIntervals: number[] = [];
  let maximumRuntimeFrameInterval = {
    intervalMs: 0,
    elapsedSeconds: 0,
    phaseId: TWO_HAND_PLAYBACK_PHASES[0].id as TwoHandPlaybackPhase["id"],
  };
  let renderedFrameCount = 0;
  await new Promise<void>((resolve, reject) => {
    let startedAt: number | null = null;
    let previousAt: number | null = null;
    const renderFrame = async (now: number) => {
      try {
        startedAt ??= now;
        const elapsedSeconds = Math.min(
          (now - startedAt) / 1_000,
          TWO_HAND_PLAYBACK_DURATION_SECONDS,
        );
        const deltaSeconds =
          previousAt === null ? 0 : (now - previousAt) / 1_000;
        const frameIntervalMs = previousAt === null ? null : now - previousAt;
        if (frameIntervalMs !== null)
          runtimeFrameIntervals.push(frameIntervalMs);
        previousAt = now;
        const phase = step(elapsedSeconds, deltaSeconds);
        if (
          frameIntervalMs !== null &&
          frameIntervalMs > maximumRuntimeFrameInterval.intervalMs
        ) {
          maximumRuntimeFrameInterval = {
            intervalMs: frameIntervalMs,
            elapsedSeconds,
            phaseId: phase.id,
          };
        }
        const progress = elapsedSeconds / TWO_HAND_PLAYBACK_DURATION_SECONDS;
        const yaw = THREE.MathUtils.degToRad(-18 + progress * 36);
        camera.position.set(Math.sin(yaw) * 4.25, 1.02, Math.cos(yaw) * 4.25);
        camera.lookAt(cameraTarget);
        await renderer.renderAsync(scene, camera);
        renderedFrameCount += 1;
        if (elapsedSeconds >= TWO_HAND_PLAYBACK_DURATION_SECONDS) {
          resolve();
        } else {
          requestAnimationFrame((nextNow) => void renderFrame(nextNow));
        }
      } catch (error) {
        reject(error);
      }
    };
    requestAnimationFrame((now) => void renderFrame(now));
  });
  const runtimeFrameIntervalSummary = {
    p50: rounded(percentile(runtimeFrameIntervals, 0.5)),
    p95: rounded(percentile(runtimeFrameIntervals, 0.95)),
    maximum: rounded(Math.max(0, ...runtimeFrameIntervals)),
  };
  const renderEvaluation = evaluateTwoHandPlaybackRenderTelemetry({
    frameCount: renderedFrameCount,
    p95FrameIntervalMs: runtimeFrameIntervalSummary.p95,
    maximumFrameIntervalMs: runtimeFrameIntervalSummary.maximum,
  });
  resetPlayback();

  const recordingMimeTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const mimeType = recordingMimeTypes.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType) throw new Error("No supported browser video codec");
  const stream = outputCanvas.captureStream(TWO_HAND_PLAYBACK_SAMPLE_RATE_HZ);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      (event) => reject(new Error(`Video recorder failed: ${event.type}`)),
      { once: true },
    );
  });
  recorder.start();
  const recordingFrameIntervals: number[] = [];
  let maximumRecordedFrameInterval = {
    intervalMs: 0,
    elapsedSeconds: 0,
    phaseId: TWO_HAND_PLAYBACK_PHASES[0].id as TwoHandPlaybackPhase["id"],
  };
  let recordedFrameCount = 0;
  await new Promise<void>((resolve, reject) => {
    let startedAt: number | null = null;
    let previousAt: number | null = null;
    const renderFrame = async (now: number) => {
      try {
        startedAt ??= now;
        const elapsedSeconds = Math.min(
          (now - startedAt) / 1_000,
          TWO_HAND_PLAYBACK_DURATION_SECONDS,
        );
        const deltaSeconds =
          previousAt === null ? 0 : (now - previousAt) / 1_000;
        const frameIntervalMs = previousAt === null ? null : now - previousAt;
        if (frameIntervalMs !== null)
          recordingFrameIntervals.push(frameIntervalMs);
        previousAt = now;
        const phase = step(elapsedSeconds, deltaSeconds);
        if (
          frameIntervalMs !== null &&
          frameIntervalMs > maximumRecordedFrameInterval.intervalMs
        ) {
          maximumRecordedFrameInterval = {
            intervalMs: frameIntervalMs,
            elapsedSeconds,
            phaseId: phase.id,
          };
        }

        const progress = elapsedSeconds / TWO_HAND_PLAYBACK_DURATION_SECONDS;
        const yaw = THREE.MathUtils.degToRad(-18 + progress * 36);
        camera.position.set(Math.sin(yaw) * 4.25, 1.02, Math.cos(yaw) * 4.25);
        camera.lookAt(cameraTarget);
        await renderer.renderAsync(scene, camera);
        output.drawImage(renderCanvas, 0, 0);
        const header = output.createLinearGradient(0, 0, 0, 120);
        header.addColorStop(0, "rgba(5, 8, 15, 0.92)");
        header.addColorStop(1, "rgba(5, 8, 15, 0)");
        output.fillStyle = header;
        output.fillRect(0, 0, width, 120);
        output.fillStyle = "#f7f9ff";
        output.font = "700 30px Inter, system-ui, sans-serif";
        output.fillText("Hyperia · two-hand motion acceptance", 38, 48);
        output.fillStyle = "#8ea1c7";
        output.font = "16px ui-monospace, SFMono-Regular, Menlo, monospace";
        output.fillText(
          config.approvedForRuntimeActivation
            ? "PRODUCT APPROVED · real avatar · fitted weapon · responsive contextual blends"
            : config.activationStatus === "runtime-under-review"
              ? "RUNTIME UNDER REVIEW · technical evidence only · product approval required"
              : "ISOLATED CANDIDATE · technical evidence only · product approval required",
          40,
          78,
        );
        output.fillStyle = "rgba(5, 8, 15, 0.88)";
        output.fillRect(0, height - 84, width, 84);
        output.fillStyle = "#66e0ab";
        output.font = "700 24px Inter, system-ui, sans-serif";
        output.fillText(phase.name, 38, height - 42);
        output.fillStyle = "#a8b5ce";
        output.font = "15px ui-monospace, SFMono-Regular, Menlo, monospace";
        output.fillText(
          `${elapsedSeconds.toFixed(2)}s / ${TWO_HAND_PLAYBACK_DURATION_SECONDS.toFixed(2)}s`,
          width - 190,
          height - 42,
        );
        const barX = 38;
        const barY = height - 23;
        const barWidth = width - 76;
        output.fillStyle = "#27324a";
        output.fillRect(barX, barY, barWidth, 5);
        output.fillStyle = "#66e0ab";
        output.fillRect(barX, barY, barWidth * progress, 5);
        recordedFrameCount += 1;
        if (elapsedSeconds >= TWO_HAND_PLAYBACK_DURATION_SECONDS) {
          resolve();
        } else {
          requestAnimationFrame((nextNow) => void renderFrame(nextNow));
        }
      } catch (error) {
        reject(error);
      }
    };
    requestAnimationFrame((now) => void renderFrame(now));
  });
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const videoBlob = new Blob(chunks, { type: mimeType });
  if (videoBlob.size < 100_000) {
    throw new Error(`Recorded video is unexpectedly small: ${videoBlob.size}`);
  }

  const recordingFrameIntervalSummary = {
    p50: rounded(percentile(recordingFrameIntervals, 0.5)),
    p95: rounded(percentile(recordingFrameIntervals, 0.95)),
    maximum: rounded(Math.max(0, ...recordingFrameIntervals)),
  };

  resetPlayback();
  const attackDefinition = config.clips.find(
    (definition) => definition.id === "attack",
  );
  const attackAction = actions.get("attack");
  if (!attackDefinition || !attackAction) {
    throw new Error("Exact-angle review requires the attack clip");
  }
  const exactAnglePhases = [
    { id: "ready", ratio: 0.1 },
    { id: "wind-up", ratio: 0.2 },
    { id: "accelerate", ratio: 0.35 },
    { id: "impact", ratio: 0.5 },
    { id: "follow-through", ratio: 0.65 },
    { id: "recover", ratio: 0.8 },
    { id: "guard", ratio: 0.95 },
  ] as const;
  const exactCameraAngles = [
    { id: "front", yawDegrees: 0 },
    { id: "profile-left", yawDegrees: -90 },
    { id: "rear", yawDegrees: 180 },
    { id: "profile-right", yawDegrees: 90 },
  ] as const;
  const exactAngleContactSheet = document.createElement("canvas");
  const exactCellWidth = 320;
  const exactCellHeight = 180;
  exactAngleContactSheet.width = exactCellWidth * exactCameraAngles.length;
  exactAngleContactSheet.height = exactCellHeight * exactAnglePhases.length;
  const exactOutput = exactAngleContactSheet.getContext("2d", {
    alpha: false,
  });
  if (!exactOutput) throw new Error("Exact-angle compositor is unavailable");
  exactOutput.fillStyle = "#080b13";
  exactOutput.fillRect(
    0,
    0,
    exactAngleContactSheet.width,
    exactAngleContactSheet.height,
  );
  attackAction.stop();
  attackAction.enabled = true;
  attackAction.paused = false;
  attackAction.setEffectiveWeight(1);
  attackAction.setEffectiveTimeScale(1);
  attackAction.clampWhenFinished = true;
  attackAction.setLoop(THREE.LoopOnce, 1);
  attackAction.play();
  for (const [row, phase] of exactAnglePhases.entries()) {
    attackAction.time = clipDurations.attack * phase.ratio;
    mixer.update(0);
    vrm.humanoid.update(0);
    vrm.scene.updateMatrixWorld(true);
    twoHandGrip.update();
    for (const [column, angle] of exactCameraAngles.entries()) {
      const yaw = THREE.MathUtils.degToRad(angle.yawDegrees);
      camera.position.set(Math.sin(yaw) * 4.25, 1.02, Math.cos(yaw) * 4.25);
      camera.lookAt(cameraTarget);
      await renderer.renderAsync(scene, camera);
      const x = column * exactCellWidth;
      const y = row * exactCellHeight;
      exactOutput.drawImage(
        renderCanvas,
        0,
        0,
        width,
        height,
        x,
        y,
        exactCellWidth,
        exactCellHeight,
      );
      exactOutput.fillStyle = "rgba(5, 8, 15, 0.82)";
      exactOutput.fillRect(x, y + exactCellHeight - 29, exactCellWidth, 29);
      exactOutput.fillStyle = "#f7f9ff";
      exactOutput.font = "700 13px Inter, system-ui, sans-serif";
      exactOutput.fillText(
        `${phase.id} · ${angle.id}`,
        x + 10,
        y + exactCellHeight - 10,
      );
    }
  }
  const exactAngleContactSheetBlob = await canvasToBlob(exactAngleContactSheet);
  if (exactAngleContactSheetBlob.size < 100_000) {
    throw new Error(
      `Exact-angle contact sheet is unexpectedly small: ${exactAngleContactSheetBlob.size}`,
    );
  }

  const evaluation = {
    thresholds: {
      motion: motionEvaluation.thresholds,
      render: renderEvaluation.thresholds,
    },
    expectedDeterministicFrameCount: motionEvaluation.expectedFrameCount,
    minimumRenderedFrameCount: renderEvaluation.minimumFrameCount,
    checks: [
      ...motionEvaluation.checks,
      ...renderEvaluation.checks,
      {
        id: "webgpu-backend",
        passed: true,
        actual: "webgpu",
        expected: "webgpu",
      },
    ],
    passed: motionEvaluation.passed && renderEvaluation.passed,
  };
  const adapterInfo = webGPUAdapter.info;
  const report = {
    schemaVersion: 2,
    activationStatus: config.activationStatus,
    approvedForRuntimeActivation: config.approvedForRuntimeActivation,
    productApproval: config.productApproval,
    avatar: {
      asset: config.avatarAsset,
      sha256: config.avatarSha256,
      id: config.avatarId,
    },
    equipment: {
      asset: config.equipmentAsset,
      sha256: config.equipmentSha256,
      itemId: config.itemId,
      validation: equipmentValidation,
    },
    clips: config.clips.map((definition) => ({
      ...definition,
      durationSeconds: clipDurations[definition.id],
      effectiveDurationSeconds: rounded(
        clipDurations[definition.id] / definition.speed,
      ),
    })),
    runtimeBlendPolicy: {
      defaultSeconds: AVATAR_EMOTE_BLEND_SECONDS,
      controlledGuardLocomotionSeconds:
        AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    },
    sequence: TWO_HAND_PLAYBACK_PHASES,
    deterministicTelemetry: telemetry,
    deterministicDiagnostics: {
      maximumBoneStep: {
        ...maximumBoneStep,
        deltaDegrees: rounded(maximumBoneStep.deltaDegrees),
        elapsedSeconds: rounded(maximumBoneStep.elapsedSeconds),
      },
      maximumWeaponStep: {
        ...maximumWeaponStep,
        deltaDegrees: rounded(maximumWeaponStep.deltaDegrees),
        elapsedSeconds: rounded(maximumWeaponStep.elapsedSeconds),
      },
      maximumBoneAcceleration: {
        ...maximumBoneAcceleration,
        deltaDegreesPerFrameSquared: rounded(
          maximumBoneAcceleration.deltaDegreesPerFrameSquared,
        ),
        elapsedSeconds: rounded(maximumBoneAcceleration.elapsedSeconds),
      },
    },
    evaluation,
    runtimePerformance: {
      durationSeconds: TWO_HAND_PLAYBACK_DURATION_SECONDS,
      frameCount: renderedFrameCount,
      webGPUWarmup: {
        firstRenderMs: webGPUFirstRenderMs,
        stabilizationMs: webGPUStabilizationMs,
        stabilizationFrameCount: webGPUStabilizationFrameCount,
      },
      frameIntervalMs: runtimeFrameIntervalSummary,
      maximumFrameIntervalDiagnostic: {
        ...maximumRuntimeFrameInterval,
        intervalMs: rounded(maximumRuntimeFrameInterval.intervalMs),
        elapsedSeconds: rounded(maximumRuntimeFrameInterval.elapsedSeconds),
      },
    },
    recording: {
      mimeType,
      durationSeconds: TWO_HAND_PLAYBACK_DURATION_SECONDS,
      frameCount: recordedFrameCount,
      videoByteLength: videoBlob.size,
      frameIntervalMs: recordingFrameIntervalSummary,
      maximumFrameIntervalDiagnostic: {
        ...maximumRecordedFrameInterval,
        intervalMs: rounded(maximumRecordedFrameInterval.intervalMs),
        elapsedSeconds: rounded(maximumRecordedFrameInterval.elapsedSeconds),
      },
    },
    exactAngleReview: {
      rendererBackend: "webgpu",
      motionAsset: attackDefinition.asset,
      sampleCount: exactAnglePhases.length * exactCameraAngles.length,
      phases: exactAnglePhases,
      cameraAngles: exactCameraAngles,
    },
    trackedBoneCount: trackedBones.length,
    renderer: {
      backend: "webgpu",
      vendor: adapterInfo.vendor || null,
      architecture: adapterInfo.architecture || null,
      device: adapterInfo.device || null,
      description: adapterInfo.description || null,
    },
    userAgent: navigator.userAgent,
  };
  twoHandGrip.dispose();
  mixer.stopAllAction();
  renderer.dispose();
  return {
    report,
    videoBase64: await blobToBase64(videoBlob),
    exactAngleContactSheetBase64: await blobToBase64(
      exactAngleContactSheetBlob,
    ),
  };
}
