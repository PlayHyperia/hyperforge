import {
  VRMLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import {
  extractFishingWorldVisualPlacement,
  validateStreamingEquipmentVisualModel,
} from "../packages/shared/src/systems/client/EquipmentVisualHelpers";
import {
  EquipmentVisualSystem,
  type StreamingPreparationVisualPlayerDiagnostics,
} from "../packages/shared/src/systems/client/EquipmentVisualSystem";
import { EventType } from "../packages/shared/src/types/events";

type FishingItemId = "small_fishing_net" | "lobster_pot";

interface FishingItemAuditDefinition {
  itemId: FishingItemId;
  heldAsset: string;
  heldSha256: string;
  worldAsset: string;
  worldSha256: string;
  deployMotionAsset: string;
  deployMotionSha256: string;
  avatarPosition: [number, number, number];
  targetPosition: [number, number, number];
  releaseDelaySeconds: number;
  releaseArcHeightMetres: number;
}

export interface FishingWorldPresentationAuditConfig {
  schemaVersion: 1;
  exportedAt: string;
  title: string;
  avatar: { id: "steve"; asset: string; sha256: string };
  idleMotion: { asset: string; sha256: string };
  retrievalMotion: { asset: string; sha256: string };
  items: FishingItemAuditDefinition[];
  retrievalPickupDelaySeconds: number;
  pose: {
    minimumHeldArmDeviationDegrees: number;
    minimumActionArmDeviationDegrees: number;
  };
  performance: {
    iterations: number;
    maximumP95FrameWorkMs: number;
    maximumSingleFrameWorkMs: number;
  };
}

interface EventSubscription {
  unsubscribe(): void;
}

class AuditEventBus {
  private handlers = new Map<
    string,
    Set<(event: { data: unknown }) => void | Promise<void>>
  >();

  subscribe(
    type: string,
    handler: (event: { data: unknown }) => void | Promise<void>,
  ): EventSubscription {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return { unsubscribe: () => handlers.delete(handler) };
  }

  emitEvent(type: string, data: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) {
      void handler({ data });
    }
  }
}

interface ActiveFishingWorldPropAudit {
  interactionId: string;
  itemId: FishingItemId;
  phase: string;
  object: THREE.Object3D;
  targetPosition: THREE.Vector3;
  transition: unknown | null;
  visualKind: "held_clone" | "world_model";
}

interface EquipmentVisualInternals {
  loadEquipmentModel(itemId: string): Promise<GLTF | null>;
  playerEquipment: Map<
    string,
    {
      weapon?: THREE.Object3D;
      shield?: THREE.Object3D;
      gatheringtool?: THREE.Object3D;
    }
  >;
  fishingWorldProps: Map<string, ActiveFishingWorldPropAudit>;
}

interface AuditPlayer {
  id: string;
  avatarUrl: string;
  data: Record<string, unknown>;
  _avatar: {
    instance: { raw: { userData: { vrm: VRM }; scene: THREE.Object3D } };
  };
  node: THREE.Object3D;
}

interface TransformSnapshot {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

interface AvatarPoseController {
  pose(asset: string, seconds: number): void;
  armPoseDeviationDegrees(): number;
  dispose(): void;
}

type EmoteFactory = ReturnType<typeof createEmoteFactory>;

interface PhaseSnapshot {
  id: string;
  itemId: FishingItemId;
  playerId: string;
  expectedLocation: "held" | "flight" | "target" | "none";
  expectedWorldVisualKind: "held_clone" | "world_model" | null;
  worldVisualKind: "held_clone" | "world_model" | null;
  diagnostics: StreamingPreparationVisualPlayerDiagnostics | null;
  heldTransform: TransformSnapshot | null;
  worldTransform: TransformSnapshot | null;
  distanceToHeldMetres: number | null;
  distanceToTargetMetres: number | null;
  arcAboveLinearMetres: number | null;
  armPoseDeviationDegrees: number;
  minimumArmPoseDeviationDegrees: number;
  failures: string[];
}

const ARM_POSE_BONES = Object.freeze([
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
] as const satisfies readonly VRMHumanBoneName[]);

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
  ];
}

function visibleInHierarchy(object: THREE.Object3D | undefined): boolean {
  if (!object) return false;
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function snapshotTransform(object: THREE.Object3D): TransformSnapshot {
  object.updateWorldMatrix(true, false);
  const position = object.getWorldPosition(new THREE.Vector3());
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const scale = object.getWorldScale(new THREE.Vector3());
  return {
    position: position.toArray().map(rounded) as [number, number, number],
    quaternion: quaternion.toArray().map(rounded) as [
      number,
      number,
      number,
      number,
    ],
    scale: scale.toArray().map(rounded) as [number, number, number],
  };
}

function quaternionDeviationDegrees(
  left: THREE.Quaternion,
  right: THREE.Quaternion,
): number {
  return THREE.MathUtils.radToDeg(left.angleTo(right));
}

async function waitFor(
  system: EquipmentVisualSystem,
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000,
  diagnostics?: () => unknown,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      const detail = diagnostics ? `: ${JSON.stringify(diagnostics())}` : "";
      throw new Error(`Timed out: ${label}${detail}`);
    }
    system.update(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loadAvatar(asset: string): Promise<{
  vrm: VRM;
  raw: { userData: { vrm: VRM }; scene: THREE.Object3D };
}> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(`/asset/${asset}`);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm?.humanoid) throw new Error(`${asset} is not a humanoid VRM`);
  const bounds = new THREE.Box3().setFromObject(vrm.scene, true);
  vrm.scene.scale.setScalar(
    1.6 / Math.max(bounds.getSize(new THREE.Vector3()).y, 0.001),
  );
  vrm.scene.updateMatrixWorld(true);
  vrm.humanoid.update();
  return { vrm, raw: { userData: { vrm }, scene: vrm.scene } };
}

function createAvatarPoseController(
  vrm: VRM,
  motionFactories: ReadonlyMap<string, EmoteFactory>,
): AvatarPoseController {
  const rawHips = vrm.humanoid.getRawBoneNode("hips");
  const rootToHips = rawHips?.getWorldPosition(new THREE.Vector3()).y ?? 1;
  const version = vrm.meta?.metaVersion ?? "1";
  const rawArmBones = ARM_POSE_BONES.map((boneName) => {
    const node = vrm.humanoid.getRawBoneNode(boneName);
    if (!node) throw new Error(`Steve VRM is missing ${boneName}`);
    return { boneName, node, baseline: node.quaternion.clone() };
  });
  const getBoneName = (boneName: string): string | undefined =>
    vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)?.name;
  const clips = new Map(
    [...motionFactories].map(([asset, factory]) => {
      const clip = factory.toClip({
        rootToHips,
        version,
        getBoneName,
      });
      if (
        !Number.isFinite(clip.duration) ||
        clip.duration <= 0 ||
        clip.tracks.length < 8
      ) {
        throw new Error(`${asset} did not retarget into a valid body motion`);
      }
      return [asset, clip] as const;
    }),
  );
  const mixer = new THREE.AnimationMixer(vrm.scene);
  return {
    pose(asset, seconds) {
      const clip = clips.get(asset);
      if (!clip) throw new Error(`Missing retargeted motion ${asset}`);
      mixer.stopAllAction();
      const action = mixer.clipAction(clip);
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(0);
      mixer.setTime(
        THREE.MathUtils.clamp(seconds, 0, Math.max(0, clip.duration - 0.001)),
      );
      vrm.humanoid.update(0);
      vrm.scene.updateMatrixWorld(true);
    },
    armPoseDeviationDegrees() {
      return rounded(
        Math.max(
          ...rawArmBones.map(({ node, baseline }) =>
            quaternionDeviationDegrees(baseline, node.quaternion),
          ),
        ),
      );
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(vrm.scene);
    },
  };
}

function addPhaseCard(
  rendererCanvas: HTMLCanvasElement,
  title: string,
  phase: PhaseSnapshot,
): void {
  const card = document.createElement("article");
  card.dataset.status = phase.failures.length === 0 ? "pass" : "fail";
  const image = document.createElement("img");
  image.alt = title;
  image.src = rendererCanvas.toDataURL("image/png");
  const details = document.createElement("div");
  details.className = "meta";
  const location =
    phase.expectedLocation === "none"
      ? "no world prop"
      : `${phase.expectedLocation} · held ${phase.distanceToHeldMetres ?? "—"} m · target ${phase.distanceToTargetMetres ?? "—"} m`;
  const visualKind = phase.worldVisualKind ? ` · ${phase.worldVisualKind}` : "";
  details.innerHTML = `<div class="name"></div><div class="stats"></div>`;
  details.querySelector(".name")!.textContent = title;
  details.querySelector(".stats")!.textContent =
    phase.failures.length === 0
      ? `PASS · ${location}${visualKind} · arm pose ${phase.armPoseDeviationDegrees}°`
      : `FAIL · ${phase.failures.join(" · ")}`;
  card.append(image, details);
  document.querySelector("main")!.append(card);
}

export async function runFishingWorldPresentationAudit(
  config: FishingWorldPresentationAuditConfig,
): Promise<{
  renderer: string;
  userAgent: string;
  equipmentValidation: Array<{
    itemId: string;
    heldValid: boolean;
    heldReason: string | null;
    worldPlacementValid: boolean;
  }>;
  phases: PhaseSnapshot[];
  lateJoin: Array<{
    itemId: FishingItemId;
    diagnostics: StreamingPreparationVisualPlayerDiagnostics | null;
    failures: string[];
  }>;
  performance: {
    iterations: number;
    p50FrameWorkMs: number;
    p95FrameWorkMs: number;
    p99FrameWorkMs: number;
    maximumFrameWorkMs: number;
    framesOver16_67Ms: number;
    framesOver33_33Ms: number;
    failures: string[];
  };
  staleRevisionRejected: boolean;
  cleanupPassed: boolean;
  failures: string[];
}> {
  const canvas = document.createElement("canvas");
  canvas.width = 560;
  canvas.height = 480;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(560, 480, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = debug
    ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172139);
  scene.add(new THREE.HemisphereLight(0xd4e5ff, 0x252022, 2.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6ca8ff, 1.5);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 96),
    new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.005;
  scene.add(ground);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(1.65, 96),
    new THREE.MeshStandardMaterial({
      color: 0x165a7b,
      transparent: true,
      opacity: 0.72,
      roughness: 0.22,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.07, 0.82);
  scene.add(water);
  const camera = new THREE.PerspectiveCamera(31, 560 / 480, 0.01, 30);

  const gltfLoader = new GLTFLoader();
  const heldModels = new Map<FishingItemId, GLTF>();
  const worldModels = new Map<FishingItemId, GLTF>();
  const motionAssets = [
    config.idleMotion.asset,
    config.retrievalMotion.asset,
    ...config.items.map((item) => item.deployMotionAsset),
  ];
  const motionGlbs = new Map(
    await Promise.all(
      motionAssets.map(
        async (asset) =>
          [asset, await gltfLoader.loadAsync(`/asset/${asset}`)] as const,
      ),
    ),
  );
  const motionFactories = new Map(
    [...motionGlbs].map(
      ([asset, gltf]) => [asset, createEmoteFactory(gltf, asset)] as const,
    ),
  );
  const players = new Map<string, AuditPlayer>();
  const avatars = new Map<string, VRM>();
  const poseControllers = new Map<string, AvatarPoseController>();

  for (const [index, definition] of config.items.entries()) {
    const [held, worldModel, avatar] = await Promise.all([
      gltfLoader.loadAsync(`/asset/${definition.heldAsset}`),
      gltfLoader.loadAsync(`/asset/${definition.worldAsset}`),
      loadAvatar(config.avatar.asset),
    ]);
    heldModels.set(definition.itemId, held);
    worldModels.set(definition.itemId, worldModel);
    avatar.vrm.scene.position.fromArray(definition.avatarPosition);
    avatar.vrm.scene.rotation.y = index === 0 ? -0.12 : 0.12;
    avatar.vrm.scene.updateMatrixWorld(true);
    scene.add(avatar.vrm.scene);
    const playerId = `audit-${definition.itemId}`;
    const player: AuditPlayer = {
      id: playerId,
      avatarUrl: "asset://avatars/duel-candidates/duel-steve.vrm",
      data: {
        avatar: "asset://avatars/duel-candidates/duel-steve.vrm",
        e: "idle",
      },
      _avatar: { instance: { raw: avatar.raw } },
      node: avatar.vrm.scene,
    };
    players.set(playerId, player);
    avatars.set(playerId, avatar.vrm);
    const poseController = createAvatarPoseController(
      avatar.vrm,
      motionFactories,
    );
    poseController.pose(config.idleMotion.asset, 0.3);
    poseControllers.set(playerId, poseController);
  }

  let serverTimeSeconds = 100;
  const eventBus = new AuditEventBus();
  const lastEquipmentByPlayerId = Object.fromEntries(
    config.items.map((definition) => [
      `audit-${definition.itemId}`,
      {
        gatheringTool: {
          itemId: definition.itemId,
          item: {
            id: definition.itemId,
            modelPath: `asset://${definition.worldAsset}`,
            gatheringModelPathsByAvatar: {
              steve: `asset://${definition.heldAsset}`,
            },
          },
        },
      },
    ]),
  );
  const world = {
    isServer: false,
    $eventBus: eventBus,
    entities: players,
    stage: { scene },
    assetsUrl: `${window.location.origin}/asset`,
    network: {
      connected: true,
      getTime: () => serverTimeSeconds,
      lastEquipmentByPlayerId,
    },
    loader: {
      loadFile: async (url: string): Promise<File> => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        return new File(
          [await response.arrayBuffer()],
          url.split("/").at(-1)!,
          {
            type: response.headers.get("content-type") ?? "model/gltf-binary",
          },
        );
      },
    },
  };
  const system = new EquipmentVisualSystem(world as never);
  await system.init();
  const internals = system as unknown as EquipmentVisualInternals;
  internals.loadEquipmentModel = async (itemId) =>
    heldModels.get(itemId as FishingItemId) ?? null;

  const equipmentValidation = config.items.map((definition) => {
    const playerId = `audit-${definition.itemId}`;
    const held = validateStreamingEquipmentVisualModel(
      heldModels.get(definition.itemId)!.scene,
      "gatheringtool",
      {
        itemId: definition.itemId,
        avatarId: "steve",
        vrm: avatars.get(playerId)!,
      },
    );
    return {
      itemId: definition.itemId,
      heldValid: held.valid,
      heldReason: held.reason,
      worldPlacementValid: Boolean(
        extractFishingWorldVisualPlacement(
          worldModels.get(definition.itemId)!.scene,
          definition.itemId,
        ),
      ),
    };
  });
  if (
    equipmentValidation.some(
      (result) => !result.heldValid || !result.worldPlacementValid,
    )
  ) {
    throw new Error("Active fishing model validation failed");
  }

  const render = (focusX = 0): void => {
    system.update(1 / 60);
    for (const vrm of avatars.values()) {
      vrm.scene.updateMatrixWorld(true);
    }
    camera.position.set(focusX, 1.03, 4.55);
    camera.lookAt(focusX, 0.82, 0.22);
    renderer.render(scene, camera);
    gl.finish();
  };

  const getDiagnostics = (
    playerId: string,
  ): StreamingPreparationVisualPlayerDiagnostics | null =>
    system
      .getStreamingPreparationVisualDiagnostics([playerId])
      .players.find((player) => player.playerId === playerId) ?? null;

  const phases: PhaseSnapshot[] = [];
  const capturePhase = (
    definition: FishingItemAuditDefinition,
    id: string,
    expectedLocation: PhaseSnapshot["expectedLocation"],
    expectedPhase: string | null,
    expectedHeldVisible: boolean,
    expectedWorldVisible: boolean,
    minimumArmPoseDeviationDegrees = 0,
    expectedWorldVisualKind: PhaseSnapshot["expectedWorldVisualKind"] = null,
  ): PhaseSnapshot => {
    const playerId = `audit-${definition.itemId}`;
    const diagnostics = getDiagnostics(playerId);
    const heldRoot = internals.playerEquipment.get(playerId)?.gatheringtool;
    const heldWrapper = heldRoot?.getObjectByName("EquipmentWrapper");
    const worldProp = internals.fishingWorldProps.get(playerId);
    const heldPosition = heldWrapper?.getWorldPosition(new THREE.Vector3());
    const worldPosition = worldProp?.object.getWorldPosition(
      new THREE.Vector3(),
    );
    const placement = worldProp
      ? extractFishingWorldVisualPlacement(worldProp.object, definition.itemId)
      : null;
    const targetPosition = placement
      ? new THREE.Vector3(...definition.targetPosition).add(
          new THREE.Vector3(...placement.positionOffset),
        )
      : null;
    const distanceToHeldMetres =
      heldPosition && worldPosition
        ? rounded(heldPosition.distanceTo(worldPosition))
        : null;
    const distanceToTargetMetres =
      targetPosition && worldPosition
        ? rounded(targetPosition.distanceTo(worldPosition))
        : null;
    let arcAboveLinearMetres: number | null = null;
    if (
      expectedLocation === "flight" &&
      heldPosition &&
      worldPosition &&
      targetPosition
    ) {
      arcAboveLinearMetres = rounded(
        worldPosition.y - (heldPosition.y + targetPosition.y) / 2,
      );
    }
    const failures: string[] = [];
    const armPoseDeviationDegrees = poseControllers
      .get(playerId)!
      .armPoseDeviationDegrees();
    if (armPoseDeviationDegrees < minimumArmPoseDeviationDegrees) {
      failures.push(
        `arm pose ${armPoseDeviationDegrees}° is below ${minimumArmPoseDeviationDegrees}°`,
      );
    }
    if ((worldProp?.visualKind ?? null) !== expectedWorldVisualKind) {
      failures.push("fishing world visual identity mismatch");
    }
    if (!diagnostics) failures.push("missing streaming diagnostics");
    if (diagnostics?.fishingPhase !== expectedPhase) {
      failures.push("fishing phase mismatch");
    }
    if (diagnostics?.heldVisualVisible !== expectedHeldVisible) {
      failures.push("held visibility mismatch");
    }
    if (diagnostics?.worldVisualVisible !== expectedWorldVisible) {
      failures.push("world visibility mismatch");
    }
    if (expectedPhase !== null && diagnostics?.ready !== true) {
      failures.push("streaming presentation readiness is not exact");
    }
    if (expectedLocation === "none") {
      if (worldProp) failures.push("world prop should be absent");
    } else if (!worldProp || !heldWrapper || !placement || !targetPosition) {
      failures.push("required held/world transform is absent");
    } else if (expectedLocation === "held") {
      const heldQuaternion = heldWrapper.getWorldQuaternion(
        new THREE.Quaternion(),
      );
      const worldQuaternion = worldProp.object.getWorldQuaternion(
        new THREE.Quaternion(),
      );
      const heldScale = heldWrapper.getWorldScale(new THREE.Vector3());
      const worldScale = worldProp.object.getWorldScale(new THREE.Vector3());
      if (
        (distanceToHeldMetres ?? Infinity) > 0.001 ||
        quaternionDeviationDegrees(heldQuaternion, worldQuaternion) > 0.01 ||
        heldScale.distanceTo(worldScale) > 0.0001
      ) {
        failures.push("world prop did not inherit the exact fitted wrapper");
      }
    } else if (expectedLocation === "target") {
      const expectedQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          ...placement.rotationEulerDegrees.map(THREE.MathUtils.degToRad),
        ),
      );
      const worldQuaternion = worldProp.object.getWorldQuaternion(
        new THREE.Quaternion(),
      );
      const expectedScale = new THREE.Vector3().setScalar(placement.scale);
      const worldScale = worldProp.object.getWorldScale(new THREE.Vector3());
      if (
        (distanceToTargetMetres ?? Infinity) > 0.001 ||
        quaternionDeviationDegrees(expectedQuaternion, worldQuaternion) >
          0.01 ||
        expectedScale.distanceTo(worldScale) > 0.0001
      ) {
        failures.push("world prop did not reach its exact authored target");
      }
    } else if (
      (distanceToHeldMetres ?? 0) < 0.05 ||
      (distanceToTargetMetres ?? 0) < 0.05 ||
      (arcAboveLinearMetres ?? -Infinity) <
        definition.releaseArcHeightMetres - 0.04
    ) {
      failures.push("release did not produce the certified in-flight arc");
    }

    for (const [candidatePlayerId, candidateAvatar] of avatars) {
      candidateAvatar.scene.visible = candidatePlayerId === playerId;
    }
    render(definition.avatarPosition[0]);
    const phase: PhaseSnapshot = {
      id,
      itemId: definition.itemId,
      playerId,
      expectedLocation,
      expectedWorldVisualKind,
      worldVisualKind: worldProp?.visualKind ?? null,
      diagnostics,
      heldTransform: heldWrapper ? snapshotTransform(heldWrapper) : null,
      worldTransform: worldProp ? snapshotTransform(worldProp.object) : null,
      distanceToHeldMetres,
      distanceToTargetMetres,
      arcAboveLinearMetres,
      armPoseDeviationDegrees,
      minimumArmPoseDeviationDegrees,
      failures,
    };
    phases.push(phase);
    addPhaseCard(canvas, `${definition.itemId} · ${id}`, phase);
    return phase;
  };

  const fishingState = (
    definition: FishingItemAuditDefinition,
    revision: number,
    interactionId: string | null,
    phase: string,
    outcome: string,
    elapsedSeconds: number,
  ) => ({
    playerId: `audit-${definition.itemId}`,
    revision,
    interactionId,
    resourceId: interactionId ? `resource-${definition.itemId}` : null,
    itemId: interactionId ? definition.itemId : null,
    phase,
    outcome,
    attempt: interactionId ? 1 : 0,
    serverTick: revision,
    phaseStartedAtServerTimeMs: interactionId
      ? (serverTimeSeconds - elapsedSeconds) * 1_000
      : undefined,
    targetPosition: interactionId
      ? {
          x: definition.targetPosition[0],
          y: definition.targetPosition[1],
          z: definition.targetPosition[2],
        }
      : null,
  });

  let staleRevisionRejected = true;
  for (const definition of config.items) {
    const playerId = `audit-${definition.itemId}`;
    for (const [candidatePlayerId, candidateAvatar] of avatars) {
      candidateAvatar.scene.visible = candidatePlayerId === playerId;
    }
    const pose = poseControllers.get(playerId)!;
    pose.pose(definition.deployMotionAsset, 0.12);
    eventBus.emitEvent(EventType.GATHERING_TOOL_SHOW, {
      playerId,
      itemId: definition.itemId,
      slot: "weapon",
      revision: 1,
    });
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        1,
        `held-${definition.itemId}`,
        "held",
        "none",
        0,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.ready === true,
      `${definition.itemId} held readiness`,
      5_000,
      () => getDiagnostics(playerId),
    );
    capturePhase(
      definition,
      "held",
      "none",
      "held",
      true,
      false,
      config.pose.minimumHeldArmDeviationDegrees,
    );

    pose.pose(definition.deployMotionAsset, 0.42);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        2,
        `handoff-${definition.itemId}`,
        "released",
        "none",
        definition.releaseDelaySeconds / 2,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.worldVisualVisible === true,
      `${definition.itemId} handoff world clone`,
    );
    capturePhase(
      definition,
      "release-before-transfer",
      "held",
      "released",
      false,
      true,
      config.pose.minimumActionArmDeviationDegrees,
      "held_clone",
    );

    pose.pose(config.idleMotion.asset, 0.3);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(definition, 3, null, "idle", "none", 0),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.worldVisualPresent === false,
      `${definition.itemId} handoff reset`,
    );
    const releaseMidpoint =
      definition.releaseDelaySeconds +
      (0.6 - definition.releaseDelaySeconds) / 2;
    pose.pose(definition.deployMotionAsset, 0.78);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        4,
        `cycle-${definition.itemId}`,
        "released",
        "none",
        releaseMidpoint,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.worldVisualVisible === true,
      `${definition.itemId} mid-flight world clone`,
    );
    capturePhase(
      definition,
      "release-mid-flight",
      "flight",
      "released",
      false,
      true,
      config.pose.minimumActionArmDeviationDegrees,
      "held_clone",
    );

    pose.pose(config.idleMotion.asset, 0.3);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        5,
        `cycle-${definition.itemId}`,
        "deployed",
        "verifying",
        0,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.fishingPhase === "deployed",
      `${definition.itemId} deployed`,
    );
    capturePhase(
      definition,
      "deployed-verifying",
      "target",
      "deployed",
      false,
      true,
      0,
      "world_model",
    );

    pose.pose(config.retrievalMotion.asset, 0.42);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        6,
        `cycle-${definition.itemId}`,
        "retrieving",
        "caught",
        config.retrievalPickupDelaySeconds / 2,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.fishingPhase === "retrieving",
      `${definition.itemId} retrieval pickup delay`,
    );
    capturePhase(
      definition,
      "retrieve-before-pickup",
      "target",
      "retrieving",
      false,
      true,
      config.pose.minimumActionArmDeviationDegrees,
      "world_model",
    );

    const retrievalStartedAt = performance.now();
    const retrievalDurationMs = 800;
    while (performance.now() - retrievalStartedAt < retrievalDurationMs) {
      const retrievalProgress = THREE.MathUtils.clamp(
        (performance.now() - retrievalStartedAt) / retrievalDurationMs,
        0,
        1,
      );
      pose.pose(
        config.retrievalMotion.asset,
        THREE.MathUtils.lerp(0.42, 0.78, retrievalProgress),
      );
      system.update(1 / 60);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    pose.pose(config.retrievalMotion.asset, 0.78);
    await waitFor(
      system,
      () => internals.fishingWorldProps.get(playerId)?.transition === null,
      `${definition.itemId} retrieval handoff completion`,
      2_000,
      () => getDiagnostics(playerId),
    );
    capturePhase(
      definition,
      "retrieve-to-hand",
      "held",
      "retrieving",
      false,
      true,
      config.pose.minimumActionArmDeviationDegrees,
      "held_clone",
    );

    pose.pose(definition.deployMotionAsset, 0.12);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        7,
        `cycle-${definition.itemId}`,
        "held",
        "caught",
        0,
      ),
    );
    await waitFor(
      system,
      () =>
        getDiagnostics(playerId)?.heldVisualVisible === true &&
        getDiagnostics(playerId)?.worldVisualPresent === false,
      `${definition.itemId} held restoration`,
    );
    capturePhase(
      definition,
      "caught-held-restored",
      "none",
      "held",
      true,
      false,
      config.pose.minimumHeldArmDeviationDegrees,
    );

    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        6,
        `stale-${definition.itemId}`,
        "deployed",
        "pending",
        0,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    system.update(0);
    staleRevisionRejected &&=
      getDiagnostics(playerId)?.fishingPhase === "held" &&
      getDiagnostics(playerId)?.worldVisualPresent === false;

    pose.pose(config.idleMotion.asset, 0.3);
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(definition, 8, null, "idle", "none", 0),
    );
    eventBus.emitEvent(EventType.GATHERING_TOOL_HIDE, {
      playerId,
      slot: "weapon",
      revision: 2,
    });
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.presentationActive === false,
      `${definition.itemId} cancellation cleanup`,
    );
    capturePhase(definition, "cancelled-clean", "none", null, false, false);
  }

  const lateJoin = [];
  for (const [index, definition] of config.items.entries()) {
    const avatar = await loadAvatar(config.avatar.asset);
    const playerId = `late-${definition.itemId}`;
    avatar.vrm.scene.position.set(
      definition.avatarPosition[0],
      0,
      -0.25 - index * 0.05,
    );
    avatar.vrm.scene.visible = false;
    scene.add(avatar.vrm.scene);
    avatars.set(playerId, avatar.vrm);
    const poseController = createAvatarPoseController(
      avatar.vrm,
      motionFactories,
    );
    poseController.pose(config.idleMotion.asset, 0.3);
    poseControllers.set(playerId, poseController);
    const state = {
      ...fishingState(
        definition,
        20,
        `late-${definition.itemId}`,
        "deployed",
        "verifying",
        4,
      ),
    };
    delete (state as { playerId?: string }).playerId;
    const player: AuditPlayer = {
      id: playerId,
      avatarUrl: "asset://avatars/duel-candidates/duel-steve.vrm",
      data: {
        avatar: "asset://avatars/duel-candidates/duel-steve.vrm",
        e: "idle",
        gatheringToolPresentation: {
          revision: 20,
          itemId: definition.itemId,
        },
        fishingInteractionPresentation: state,
      },
      _avatar: { instance: { raw: avatar.raw } },
      node: avatar.vrm.scene,
    };
    players.set(playerId, player);
    lastEquipmentByPlayerId[playerId] = {
      gatheringTool: {
        itemId: definition.itemId,
        item: {
          id: definition.itemId,
          modelPath: `asset://${definition.worldAsset}`,
          gatheringModelPathsByAvatar: {
            steve: `asset://${definition.heldAsset}`,
          },
        },
      },
    };
    eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
      playerId,
      success: true,
    });
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.ready === true,
      `${definition.itemId} late-join hydration`,
    );
    const diagnostics = getDiagnostics(playerId);
    const failures: string[] = [];
    if (
      diagnostics?.gatheringToolItemId !== definition.itemId ||
      diagnostics.fishingPhase !== "deployed" ||
      diagnostics.worldVisualVisible !== true ||
      diagnostics.heldVisualVisible !== false ||
      diagnostics.gatheringRevision !== 20 ||
      diagnostics.fishingRevision !== 20
    ) {
      failures.push("late-join snapshot did not reconstruct exact state");
    }
    lateJoin.push({ itemId: definition.itemId, diagnostics, failures });
    eventBus.emitEvent(EventType.PLAYER_CLEANUP, { playerId });
    players.delete(playerId);
    poseController.dispose();
    poseControllers.delete(playerId);
    avatar.vrm.scene.parent?.remove(avatar.vrm.scene);
  }

  for (const definition of config.items) {
    const playerId = `audit-${definition.itemId}`;
    avatars.get(playerId)!.scene.visible = true;
    poseControllers.get(playerId)!.pose(config.idleMotion.asset, 0.3);
    eventBus.emitEvent(EventType.GATHERING_TOOL_SHOW, {
      playerId,
      itemId: definition.itemId,
      slot: "weapon",
      revision: 3,
    });
    eventBus.emitEvent(
      EventType.FISHING_INTERACTION_PRESENTATION,
      fishingState(
        definition,
        30,
        `performance-${definition.itemId}`,
        "deployed",
        "verifying",
        0,
      ),
    );
    await waitFor(
      system,
      () => getDiagnostics(playerId)?.ready === true,
      `${definition.itemId} performance setup`,
    );
  }
  for (let index = 0; index < 20; index += 1) render(0);
  const frameWorkDurations = [];
  for (let index = 0; index < config.performance.iterations; index += 1) {
    const startedAt = performance.now();
    render(0);
    frameWorkDurations.push(performance.now() - startedAt);
  }
  const p95FrameWorkMs = percentile(frameWorkDurations, 0.95);
  const maximumFrameWorkMs = Math.max(...frameWorkDurations);
  const performanceFailures: string[] = [];
  if (p95FrameWorkMs > config.performance.maximumP95FrameWorkMs) {
    performanceFailures.push(
      `p95 frame work ${p95FrameWorkMs.toFixed(3)} ms exceeds ${config.performance.maximumP95FrameWorkMs} ms`,
    );
  }
  if (maximumFrameWorkMs > config.performance.maximumSingleFrameWorkMs) {
    performanceFailures.push(
      `maximum frame work ${maximumFrameWorkMs.toFixed(3)} ms exceeds ${config.performance.maximumSingleFrameWorkMs} ms`,
    );
  }

  for (const definition of config.items) {
    eventBus.emitEvent(EventType.PLAYER_CLEANUP, {
      playerId: `audit-${definition.itemId}`,
    });
  }
  const cleanupPassed =
    internals.playerEquipment.size === 0 &&
    internals.fishingWorldProps.size === 0;
  for (const controller of poseControllers.values()) controller.dispose();
  system.destroy();
  renderer.dispose();
  renderer.forceContextLoss();

  const failures = [
    ...phases.flatMap((phase) =>
      phase.failures.map((failure) => `${phase.id}: ${failure}`),
    ),
    ...lateJoin.flatMap((entry) =>
      entry.failures.map((failure) => `${entry.itemId}: ${failure}`),
    ),
    ...performanceFailures,
    ...(staleRevisionRejected ? [] : ["stale revision resurrected a prop"]),
    ...(cleanupPassed ? [] : ["player cleanup left fishing visuals behind"]),
  ];
  return {
    renderer: rendererName,
    userAgent: navigator.userAgent,
    equipmentValidation,
    phases,
    lateJoin,
    performance: {
      iterations: config.performance.iterations,
      p50FrameWorkMs: rounded(percentile(frameWorkDurations, 0.5)),
      p95FrameWorkMs: rounded(p95FrameWorkMs),
      p99FrameWorkMs: rounded(percentile(frameWorkDurations, 0.99)),
      maximumFrameWorkMs: rounded(maximumFrameWorkMs),
      framesOver16_67Ms: frameWorkDurations.filter(
        (duration) => duration > 16.67,
      ).length,
      framesOver33_33Ms: frameWorkDurations.filter(
        (duration) => duration > 33.33,
      ).length,
      failures: performanceFailures,
    },
    staleRevisionRejected,
    cleanupPassed,
    failures,
  };
}
