import {
  VRMLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import Color4 from "three/src/renderers/common/Color4.js";
import { MeshBVH, type HitPointInfo } from "three-mesh-bvh";

import type { AvatarAuthoredMotionDiagnostics } from "../packages/shared/src/extras/three/AvatarAuthoredMotionDiagnostics";
import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import {
  createVRMFactory,
  prepareVRMMaterialsForWebGPU,
} from "../packages/shared/src/extras/three/createVRMFactory";
import {
  PLAYER_HIT_REACTION_BONES,
  PlayerHitReactionController,
  type PlayerHitReactionDiagnostics,
} from "../packages/shared/src/extras/three/PlayerHitReactionController";
import THREE from "../packages/shared/src/extras/three/three";
import {
  attachEquipmentVisualToVRM,
  createDynamicBowStringController,
  createStableHeldEquipmentPoseController,
  createTwoHandEquipmentGripController,
  extractEquipmentAttachmentData,
  shouldRenderHeldEquipmentVisual,
  validateStreamingEquipmentVisualModel,
} from "../packages/shared/src/systems/client/EquipmentVisualHelpers";
import { nearestMeshSurfaceDistance } from "./lib/nearest-mesh-surface-distance";
import { createObjectAxisRegionGeometry } from "./lib/object-axis-region";
import { createSkinnedBoneRegionGeometry } from "./lib/skinned-bone-region";
import { collectProjectedMaskMeshes } from "./lib/projected-mask-meshes";

export interface DuelAvatarMotionDefinition {
  id: string;
  name: string;
  asset: string;
  sampleRatio: number;
  cameraYawDegrees?: number;
  cameraPitchDegrees?: number;
  cameraTarget?: "primary-grip";
  heldEquipmentEmote?: string;
  equipmentClearance?: {
    minimumFloorClearanceMetres?: number;
    minimumBodySurfaceDistanceMetres?: number;
    maximumProjectedBodyOverlapRatio?: number;
  };
  avatarGrounding?: {
    minimumBoundsYMetres: number;
    maximumBoundsYMetres: number;
  };
  waterContact?: "clear" | "contact";
  hitReaction?: {
    intensity: number;
    side: -1 | 1;
    elapsedSeconds: number;
  };
}

export interface DuelAvatarEquipmentDefinition {
  asset: string;
  sha256: string;
  itemId: string;
  avatarId: string;
  slot: "weapon" | "shield" | "gatheringtool";
  grip: "one-hand" | "two-hand";
}

export interface DuelAvatarMotionAuditConfig {
  avatarAsset: string;
  avatarSha256: string;
  motions: DuelAvatarMotionDefinition[];
  framing?: "avatar" | "avatar-and-equipment";
  equipment?: DuelAvatarEquipmentDefinition | null;
  equipments?: DuelAvatarEquipmentDefinition[] | null;
  environment?: {
    waterSurfaceBelowFeet: number;
  };
  productionVrmOverlap?: {
    authoredMotion: {
      asset: string;
      sha256: string;
    };
    idleMotion: {
      asset: string;
      sha256: string;
    };
  };
}

type ProductionVrmOverlapSnapshotId =
  | "authored-baseline"
  | "hit-overlap"
  | "idle-only"
  | "paused-authored"
  | "no-weight";

interface ProductionVrmOverlapSnapshot {
  id: ProductionVrmOverlapSnapshotId;
  expectedOverlap: boolean;
  observedOverlap: boolean;
  authoredMotion: AvatarAuthoredMotionDiagnostics;
  hitReaction: PlayerHitReactionDiagnostics;
  visiblePixelCount: number;
  failures: string[];
}

interface ProductionVrmFactoryOverlapResult {
  schemaVersion: 1;
  implementation: "createVRMFactory";
  avatarAsset: string;
  avatarSha256: string;
  authoredMotionAsset: string;
  authoredMotionSha256: string;
  idleMotionAsset: string;
  idleMotionSha256: string;
  snapshots: ProductionVrmOverlapSnapshot[];
  failures: string[];
}

interface EquipmentMotionResult {
  itemId: string;
  asset: string;
  metadataValid: boolean;
  metadataReason: string | null;
  attached: boolean;
  visible: boolean;
  weaponType: string | null;
  dynamicBowStringActive: boolean;
  stableHeldPoseActive: boolean;
  twoHandGripActive: boolean;
  stablePoseDeviationDegrees: number | null;
  stablePosePositionDeviationMetres: number | null;
  nockedArrowVisible: boolean;
  nockedArrowNockDistance: number | null;
  nockedArrowAimDeviationDegrees: number | null;
  nockedArrowDrawHandMeshContact: HandMeshContactResult | null;
  gripZoneContacts: Array<
    HandMeshContactResult & {
      id: "primary" | "secondary";
      boneName: "leftHand" | "rightHand";
      equipmentTriangleCount: number;
      minimumSourceProjection: number;
      maximumSourceProjection: number;
    }
  >;
  bodyRegionContacts: Array<
    HandMeshContactResult & {
      boneName: (typeof BODY_CLEARANCE_BONES)[number];
    }
  >;
  projectedBodyOverlap: {
    isolationControlPixels: number;
    isolatedMeshCount: number;
    bodyPixels: number;
    equipmentPixels: number;
    overlapPixels: number;
    equipmentOverlapRatio: number;
  } | null;
  actionDirectionWorld: [number, number, number] | null;
  attachmentBone: string | null;
  orientation: {
    wrapperNodeName: string;
    wrapperWorldQuaternion: [number, number, number, number];
    wrapperAvatarLocalQuaternion: [number, number, number, number];
    primaryToSecondaryDirection: [number, number, number] | null;
    metadataHandleAxisWorld: [number, number, number] | null;
    metadataHandleToSecondaryDeviationDegrees: number | null;
  } | null;
  bounds: {
    width: number;
    height: number;
    depth: number;
    minimumY: number;
    maximumY: number;
  };
  rightHandNearestVertexDistance: number;
  leftHandNearestVertexDistance: number;
  headNearestVertexDistance: number;
  torsoNearestVertexDistance: number;
  rightHandNearestSurfaceDistance: number;
  leftHandNearestSurfaceDistance: number;
  headNearestSurfaceDistance: number;
  torsoNearestSurfaceDistance: number;
  rightHandMeshContact: HandMeshContactResult;
  leftHandMeshContact: HandMeshContactResult;
}

interface HandMeshContactResult {
  sourceMeshCount: number;
  triangleCount: number;
  intersects: boolean | null;
  minimumSurfaceDistance: number | null;
  avatarPoint: [number, number, number] | null;
  equipmentPoint: [number, number, number] | null;
  equipmentToAvatarVector: [number, number, number] | null;
}

interface ObjectPairMeasurement {
  intersects: boolean;
  minimumSurfaceDistance: number | null;
  firstPoint: [number, number, number] | null;
  secondPoint: [number, number, number] | null;
}

interface MotionResult {
  id: string;
  name: string;
  asset: string;
  durationSeconds: number;
  sampleSeconds: number;
  cameraYawDegrees?: number;
  cameraPitchDegrees?: number;
  cameraTarget?: "primary-grip";
  heldEquipmentEmote?: string;
  hitReaction?: {
    intensity: number;
    side: -1 | 1;
    elapsedSeconds: number;
    availableBoneCount: number;
    triggerCount: number;
    active: boolean;
    currentWeight: number;
  };
  trackCount: number;
  targetBoneCount: number;
  changedBoneCount: number;
  maximumBoneDeltaDegrees: number;
  bounds: {
    width: number;
    height: number;
    depth: number;
    minimumY: number;
    maximumY: number;
  };
  rootDrift: number;
  equipment?: EquipmentMotionResult;
  equipments?: EquipmentMotionResult[];
  equipmentPairs?: EquipmentPairMotionResult[];
  waterContact?: {
    expectation: "clear" | "contact";
    waterSurfaceY: number;
    equipmentMinimumY: number;
    equipmentMaximumY: number;
    intersects: boolean;
  };
  avatarGrounding?: {
    minimumBoundsYMetres: number;
    maximumBoundsYMetres: number;
    passed: boolean;
  };
  failures: string[];
}

interface EquipmentPairMotionResult {
  itemIds: [string, string];
  evaluated: boolean;
  intersects: boolean | null;
  minimumSurfaceDistance: number | null;
}

interface LoadedEquipment {
  definition: DuelAvatarEquipmentDefinition;
  root: THREE.Object3D;
  validation: ReturnType<typeof validateStreamingEquipmentVisualModel>;
  attached: boolean;
  dynamicBowString: ReturnType<typeof createDynamicBowStringController> | null;
  stableHeldPose: ReturnType<
    typeof createStableHeldEquipmentPoseController
  > | null;
  twoHandGrip: ReturnType<typeof createTwoHandEquipmentGripController> | null;
}

export interface DuelAvatarMotionBrowserReport {
  avatarAsset: string;
  avatarSha256: string;
  framing?: "avatar-and-equipment";
  userAgent: string;
  renderer: string;
  rendererBackend: "webgpu";
  rendererAdapter: {
    vendor: string | null;
    architecture: string | null;
    device: string | null;
    description: string | null;
  };
  environment?: {
    waterSurfaceBelowFeet: number;
  };
  motions: MotionResult[];
  productionVrmOverlap?: ProductionVrmFactoryOverlapResult;
  failures: string[];
}

const REQUIRED_BODY_BONES: VRMHumanBoneName[] = [
  "hips",
  "spine",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
];

const BODY_CLEARANCE_BONES = [
  "head",
  "chest",
  "spine",
  "hips",
  "leftUpperLeg",
  "rightUpperLeg",
] as const satisfies readonly VRMHumanBoneName[];

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function vectorDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.distanceTo(b);
}

function nearestVertexDistance(
  root: THREE.Object3D,
  point: THREE.Vector3,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  const vertex = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const position = mesh.geometry?.getAttribute?.("position");
    if (!position) return;
    for (let index = 0; index < position.count; index += 1) {
      vertex
        .fromBufferAttribute(position, index)
        .applyMatrix4(object.matrixWorld);
      nearest = Math.min(nearest, vertex.distanceTo(point));
    }
  });
  return nearest;
}

function getEquipmentDefinitions(
  config: DuelAvatarMotionAuditConfig,
): DuelAvatarEquipmentDefinition[] {
  if (config.equipment && config.equipments?.length) {
    throw new Error(
      "single equipment and equipment set cannot both be configured",
    );
  }
  const definitions = config.equipments?.length
    ? [...config.equipments]
    : config.equipment
      ? [config.equipment]
      : [];
  if (definitions.length > 10) {
    throw new Error("equipment set exceeds the ten-item audit limit");
  }
  const itemIds = new Set<string>();
  const slots = new Set<string>();
  for (const definition of definitions) {
    if (itemIds.has(definition.itemId)) {
      throw new Error(`duplicate equipment item ID ${definition.itemId}`);
    }
    if (slots.has(definition.slot)) {
      throw new Error(`duplicate equipment slot ${definition.slot}`);
    }
    itemIds.add(definition.itemId);
    slots.add(definition.slot);
  }
  const avatarIds = new Set(
    definitions.map((definition) => definition.avatarId),
  );
  if (avatarIds.size > 1) {
    throw new Error("equipment set targets more than one avatar ID");
  }
  const weapon = definitions.find((definition) => definition.slot === "weapon");
  if (slots.has("shield") && weapon?.grip === "two-hand") {
    throw new Error("two-hand equipment cannot be combined with a shield");
  }
  return definitions;
}

function meshObjects(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const position = mesh.geometry?.getAttribute?.("position");
    if (position && position.count >= 3) meshes.push(mesh);
  });
  return meshes;
}

function createHitPointInfo(): HitPointInfo {
  return {
    point: new THREE.Vector3(),
    distance: Number.POSITIVE_INFINITY,
    faceIndex: -1,
  };
}

function measureEquipmentPair(
  first: LoadedEquipment,
  second: LoadedEquipment,
  evaluated: boolean,
): EquipmentPairMotionResult {
  const result: EquipmentPairMotionResult = {
    itemIds: [first.definition.itemId, second.definition.itemId],
    evaluated,
    intersects: null,
    minimumSurfaceDistance: null,
  };
  if (!evaluated) return result;

  const measured = measureObjectPair(first.root, second.root);
  result.intersects = measured.intersects;
  result.minimumSurfaceDistance = measured.minimumSurfaceDistance;
  return result;
}

function measureObjectPair(
  firstRoot: THREE.Object3D,
  secondRoot: THREE.Object3D,
): ObjectPairMeasurement {
  const firstMeshes = meshObjects(firstRoot);
  const secondMeshes = meshObjects(secondRoot);
  const bvhCache = new Map<THREE.BufferGeometry, MeshBVH>();
  const getBvh = (geometry: THREE.BufferGeometry): MeshBVH => {
    let bvh = bvhCache.get(geometry);
    if (!bvh) {
      bvh = new MeshBVH(geometry, { indirect: true, verbose: false });
      bvhCache.set(geometry, bvh);
    }
    return bvh;
  };
  let intersects = false;
  let minimumDistance = Number.POSITIVE_INFINITY;
  let closestFirstPoint: THREE.Vector3 | null = null;
  let closestSecondPoint: THREE.Vector3 | null = null;
  firstRoot.updateMatrixWorld(true);
  secondRoot.updateMatrixWorld(true);
  for (const firstMesh of firstMeshes) {
    const firstBvh = getBvh(firstMesh.geometry);
    const inverseFirst = firstMesh.matrixWorld.clone().invert();
    for (const secondMesh of secondMeshes) {
      const secondBvh = getBvh(secondMesh.geometry);
      const secondGeometry = secondMesh.geometry as THREE.BufferGeometry & {
        boundsTree?: MeshBVH;
      };
      const previousBoundsTree = secondGeometry.boundsTree;
      secondGeometry.boundsTree = secondBvh;
      const secondToFirst = inverseFirst
        .clone()
        .multiply(secondMesh.matrixWorld);
      try {
        if (firstBvh.intersectsGeometry(secondGeometry, secondToFirst)) {
          intersects = true;
          minimumDistance = 0;
          closestFirstPoint = null;
          closestSecondPoint = null;
          continue;
        }
        const firstPoint = createHitPointInfo();
        const secondPoint = createHitPointInfo();
        const closest = firstBvh.closestPointToGeometry(
          secondGeometry,
          secondToFirst,
          firstPoint,
          secondPoint,
        );
        if (closest) {
          const worldFirst = firstPoint.point
            .clone()
            .applyMatrix4(firstMesh.matrixWorld);
          const worldSecond = secondPoint.point
            .clone()
            .applyMatrix4(secondMesh.matrixWorld);
          const distance = worldFirst.distanceTo(worldSecond);
          if (distance < minimumDistance) {
            minimumDistance = distance;
            closestFirstPoint = worldFirst;
            closestSecondPoint = worldSecond;
          }
        }
      } finally {
        secondGeometry.boundsTree = previousBoundsTree;
      }
    }
  }
  return {
    intersects,
    minimumSurfaceDistance: finite(minimumDistance)
      ? rounded(minimumDistance)
      : null,
    firstPoint: closestFirstPoint
      ? (closestFirstPoint.toArray().map(rounded) as [number, number, number])
      : null,
    secondPoint: closestSecondPoint
      ? (closestSecondPoint.toArray().map(rounded) as [number, number, number])
      : null,
  };
}

function measureSkinnedBoneMeshContact(
  avatarRoot: THREE.Object3D,
  handBone: THREE.Object3D | null,
  equipmentRoot: THREE.Object3D,
  includeDescendantSkinBones = false,
): HandMeshContactResult {
  if (!handBone) {
    return {
      sourceMeshCount: 0,
      triangleCount: 0,
      intersects: null,
      minimumSurfaceDistance: null,
      avatarPoint: null,
      equipmentPoint: null,
      equipmentToAvatarVector: null,
    };
  }
  const region = createSkinnedBoneRegionGeometry(avatarRoot, handBone, 0.5, {
    includeDescendantSkinBones,
  });
  if (region.triangleCount === 0) {
    region.geometry.dispose();
    return {
      sourceMeshCount: region.sourceMeshCount,
      triangleCount: 0,
      intersects: null,
      minimumSurfaceDistance: null,
      avatarPoint: null,
      equipmentPoint: null,
      equipmentToAvatarVector: null,
    };
  }
  const regionMesh = new THREE.Mesh(region.geometry);
  const measured = measureObjectPair(regionMesh, equipmentRoot);
  region.geometry.dispose();
  const equipmentToAvatarVector =
    measured.firstPoint && measured.secondPoint
      ? new THREE.Vector3(...measured.firstPoint)
          .sub(new THREE.Vector3(...measured.secondPoint))
          .toArray()
          .map(rounded)
      : null;
  return {
    sourceMeshCount: region.sourceMeshCount,
    triangleCount: region.triangleCount,
    intersects: measured.intersects,
    minimumSurfaceDistance: measured.minimumSurfaceDistance,
    avatarPoint: measured.firstPoint,
    equipmentPoint: measured.secondPoint,
    equipmentToAvatarVector: equipmentToAvatarVector as
      [number, number, number] | null,
  };
}

async function measureProjectedBodyOverlap(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  avatarRoot: THREE.Object3D,
  vrm: VRM,
  equipmentRoot: THREE.Object3D,
): Promise<NonNullable<EquipmentMotionResult["projectedBodyOverlap"]>> {
  const width = 480;
  const height = 440;
  const bodyGroup = new THREE.Group();
  const bodyMeshes = new Set<THREE.Mesh>();
  for (const boneName of BODY_CLEARANCE_BONES) {
    const bone = vrm.humanoid.getRawBoneNode(boneName);
    if (!bone) continue;
    const region = createSkinnedBoneRegionGeometry(avatarRoot, bone, 0.25);
    if (region.triangleCount === 0) {
      region.geometry.dispose();
      continue;
    }
    const mesh = new THREE.Mesh(region.geometry);
    bodyMeshes.add(mesh);
    bodyGroup.add(mesh);
  }
  scene.add(bodyGroup);
  const equipmentMeshes = new Set(meshObjects(equipmentRoot));
  const sceneMeshes = collectProjectedMaskMeshes(scene);
  const visibility = new Map(
    sceneMeshes.map((mesh) => [mesh, mesh.visible] as const),
  );
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const previousTarget = renderer.getRenderTarget();
  const previousBackground = scene.background;
  const previousOverrideMaterial = scene.overrideMaterial;
  const previousClearColor = renderer.getClearColor(new Color4()).getHex();
  const previousClearAlpha = renderer.getClearAlpha();
  const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const renderMask = async (included: Set<THREE.Mesh>) => {
    for (const mesh of sceneMeshes) mesh.visible = included.has(mesh);
    scene.background = null;
    scene.overrideMaterial = maskMaterial;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    await renderer.renderAsync(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      width,
      height,
    );
    const mask = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = pixels[index * 4] > 127 ? 1 : 0;
    }
    return mask;
  };
  try {
    const emptyMask = await renderMask(new Set());
    const leakedPixels = emptyMask.reduce((sum, pixel) => sum + pixel, 0);
    if (leakedPixels !== 0) {
      throw new Error(
        `Projected mask isolation failed: ${leakedPixels} pixels remain with all ${sceneMeshes.length} collected meshes hidden`,
      );
    }
    const bodyMask = await renderMask(bodyMeshes);
    const equipmentMask = await renderMask(equipmentMeshes);
    let bodyPixels = 0;
    let equipmentPixels = 0;
    let overlapPixels = 0;
    for (let index = 0; index < bodyMask.length; index += 1) {
      if (bodyMask[index]) bodyPixels += 1;
      if (equipmentMask[index]) equipmentPixels += 1;
      if (bodyMask[index] && equipmentMask[index]) overlapPixels += 1;
    }
    return {
      isolationControlPixels: leakedPixels,
      isolatedMeshCount: sceneMeshes.length,
      bodyPixels,
      equipmentPixels,
      overlapPixels,
      equipmentOverlapRatio: rounded(
        equipmentPixels > 0 ? overlapPixels / equipmentPixels : 1,
      ),
    };
  } finally {
    for (const [mesh, wasVisible] of visibility) mesh.visible = wasVisible;
    scene.remove(bodyGroup);
    for (const mesh of bodyMeshes) mesh.geometry.dispose();
    maskMaterial.dispose();
    target.dispose();
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    scene.background = previousBackground;
    scene.overrideMaterial = previousOverrideMaterial;
  }
}

function failedEquipmentResult(
  definition: DuelAvatarEquipmentDefinition,
): EquipmentMotionResult {
  return {
    itemId: definition.itemId,
    asset: definition.asset,
    metadataValid: false,
    metadataReason: "audit_failed",
    attached: false,
    visible: false,
    weaponType: null,
    dynamicBowStringActive: false,
    stableHeldPoseActive: false,
    twoHandGripActive: false,
    stablePoseDeviationDegrees: null,
    stablePosePositionDeviationMetres: null,
    nockedArrowVisible: false,
    nockedArrowNockDistance: null,
    nockedArrowAimDeviationDegrees: null,
    nockedArrowDrawHandMeshContact: null,
    gripZoneContacts: [],
    bodyRegionContacts: [],
    projectedBodyOverlap: null,
    actionDirectionWorld: null,
    attachmentBone: null,
    orientation: null,
    bounds: {
      width: 0,
      height: 0,
      depth: 0,
      minimumY: 0,
      maximumY: 0,
    },
    rightHandNearestVertexDistance: 0,
    leftHandNearestVertexDistance: 0,
    headNearestVertexDistance: 0,
    torsoNearestVertexDistance: 0,
    rightHandNearestSurfaceDistance: 0,
    leftHandNearestSurfaceDistance: 0,
    headNearestSurfaceDistance: 0,
    torsoNearestSurfaceDistance: 0,
    rightHandMeshContact: {
      sourceMeshCount: 0,
      triangleCount: 0,
      intersects: null,
      minimumSurfaceDistance: null,
      avatarPoint: null,
      equipmentPoint: null,
      equipmentToAvatarVector: null,
    },
    leftHandMeshContact: {
      sourceMeshCount: 0,
      triangleCount: 0,
      intersects: null,
      minimumSurfaceDistance: null,
      avatarPoint: null,
      equipmentPoint: null,
      equipmentToAvatarVector: null,
    },
  };
}

function assertFiniteScene(root: THREE.Object3D, failures: string[]): void {
  root.traverse((object) => {
    if (
      !object.matrix.elements.every(finite) ||
      !object.matrixWorld.elements.every(finite)
    ) {
      failures.push(`non-finite transform on ${object.name || object.type}`);
    }
    const mesh = object as THREE.Mesh;
    const position = mesh.geometry?.getAttribute?.("position");
    if (
      position &&
      Array.from(position.array as ArrayLike<number>).some(
        (component) => !finite(component),
      )
    ) {
      failures.push(`non-finite vertex on ${object.name || object.type}`);
    }
  });
}

function disposeScene(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !textures.has(value)) {
          textures.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

function createCard(motion: DuelAvatarMotionDefinition): {
  card: HTMLElement;
  canvas: HTMLCanvasElement;
} {
  const card = document.createElement("article");
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 440;
  card.append(canvas);
  const metadata = document.createElement("div");
  metadata.className = "meta";
  metadata.innerHTML =
    '<div class="name"></div><div class="asset"></div><div class="stats"></div>';
  metadata.querySelector(".name")!.textContent = motion.name;
  metadata.querySelector(".asset")!.textContent = motion.asset;
  card.append(metadata);
  document.querySelector("main")!.append(card);
  return { card, canvas };
}

const PRODUCTION_VRM_OVERLAP_FRAME_SECONDS = 0.05;
const PRODUCTION_VRM_OVERLAP_MAX_FRAMES = 600;
const PRODUCTION_VRM_OVERLAP_MIN_VISIBLE_PIXELS = 1_000;
const PRODUCTION_VRM_POSITIVE_HIT_CONTROL_TRIGGER_COUNTS: Partial<
  Record<ProductionVrmOverlapSnapshotId, number>
> = {
  "idle-only": 2,
  "paused-authored": 3,
  "no-weight": 4,
};

function isStrictAuthoredMotionDiagnostics(
  diagnostics: AvatarAuthoredMotionDiagnostics,
): boolean {
  return (
    diagnostics.schemaVersion === 1 &&
    diagnostics.overflow === false &&
    diagnostics.invalidActionCount === 0 &&
    diagnostics.actions.length <= 8 &&
    diagnostics.actions.every(
      (action) =>
        typeof action.url === "string" &&
        action.url.length > 0 &&
        action.url.length <= 200 &&
        action.url === action.url.trim() &&
        !/[?#\u0000-\u001f\u007f]/.test(action.url) &&
        typeof action.running === "boolean" &&
        typeof action.paused === "boolean" &&
        Number.isFinite(action.effectiveWeight) &&
        action.effectiveWeight > 0 &&
        action.effectiveWeight <= 1,
    )
  );
}

function isNonIdleAuthoredMotionUrl(url: string): boolean {
  return !/(?:^|[-_/])(idle|death)(?:[-_.?/]|$)/i.test(url);
}

function hasActiveNonIdleAuthoredMotion(
  diagnostics: AvatarAuthoredMotionDiagnostics,
): boolean {
  return diagnostics.actions.some(
    (action) =>
      action.running &&
      !action.paused &&
      action.effectiveWeight > 0 &&
      isNonIdleAuthoredMotionUrl(action.url),
  );
}

function hasStrictProductionVrmOverlap(
  authoredMotion: AvatarAuthoredMotionDiagnostics,
  hitReaction: PlayerHitReactionDiagnostics,
): boolean {
  return (
    isStrictAuthoredMotionDiagnostics(authoredMotion) &&
    hasActiveNonIdleAuthoredMotion(authoredMotion) &&
    hasStrictContributingHitReaction(hitReaction)
  );
}

function hasStrictContributingHitReaction(
  hitReaction: PlayerHitReactionDiagnostics,
): boolean {
  return (
    hitReaction.schemaVersion === 1 &&
    hitReaction.availableBoneCount === PLAYER_HIT_REACTION_BONES.length &&
    Number.isSafeInteger(hitReaction.triggerCount) &&
    hitReaction.triggerCount > 0 &&
    hitReaction.active === true &&
    hitReaction.elapsedSeconds !== null &&
    Number.isFinite(hitReaction.elapsedSeconds) &&
    Number.isFinite(hitReaction.currentWeight) &&
    hitReaction.currentWeight > 0
  );
}

function snapshotProductionVrmOverlap(
  id: ProductionVrmOverlapSnapshotId,
  expectedOverlap: boolean,
  instance: {
    getAuthoredMotionDiagnostics: () => AvatarAuthoredMotionDiagnostics;
    getHitReactionDiagnostics: () => PlayerHitReactionDiagnostics;
  },
  authoredAssetUrl: string,
  idleAssetUrl: string,
): ProductionVrmOverlapSnapshot {
  const rawAuthoredMotion = instance.getAuthoredMotionDiagnostics();
  const authoredMotion: AvatarAuthoredMotionDiagnostics = {
    schemaVersion: rawAuthoredMotion.schemaVersion,
    overflow: rawAuthoredMotion.overflow,
    invalidActionCount: rawAuthoredMotion.invalidActionCount,
    actions: rawAuthoredMotion.actions.map((action) => ({ ...action })),
  };
  const hitReaction = { ...instance.getHitReactionDiagnostics() };
  const observedOverlap = hasStrictProductionVrmOverlap(
    authoredMotion,
    hitReaction,
  );
  const failures: string[] = [];
  const cleanAuthoredMotion = isStrictAuthoredMotionDiagnostics(authoredMotion);
  const exactRequiredBones =
    hitReaction.availableBoneCount === PLAYER_HIT_REACTION_BONES.length;
  const reactionQuiescent =
    hitReaction.active === false && hitReaction.currentWeight === 0;
  const onlyAuthoredAsset =
    authoredMotion.actions.length > 0 &&
    authoredMotion.actions.every((action) => action.url === authoredAssetUrl);
  const onlyIdleAsset =
    authoredMotion.actions.length > 0 &&
    authoredMotion.actions.every((action) => action.url === idleAssetUrl);
  const contributingHitReaction = hasStrictContributingHitReaction(hitReaction);
  const requiredPositiveHitTriggerCount =
    PRODUCTION_VRM_POSITIVE_HIT_CONTROL_TRIGGER_COUNTS[id];

  if (!cleanAuthoredMotion) {
    failures.push("authored-motion diagnostics are not clean and bounded");
  }
  if (!exactRequiredBones) {
    failures.push(
      `hit reaction exposes ${hitReaction.availableBoneCount}/${PLAYER_HIT_REACTION_BONES.length} required bones`,
    );
  }
  if (observedOverlap !== expectedOverlap) {
    failures.push(
      `expected overlap=${expectedOverlap} but observed overlap=${observedOverlap}`,
    );
  }
  if (
    requiredPositiveHitTriggerCount !== undefined &&
    (!contributingHitReaction ||
      hitReaction.triggerCount !== requiredPositiveHitTriggerCount)
  ) {
    failures.push(
      `negative control requires positive hit contribution at trigger ${requiredPositiveHitTriggerCount}`,
    );
  }

  if (id === "authored-baseline") {
    if (!onlyAuthoredAsset || !hasActiveNonIdleAuthoredMotion(authoredMotion)) {
      failures.push("baseline is not exclusively active authored motion");
    }
    if (
      !reactionQuiescent ||
      hitReaction.triggerCount !== 0 ||
      hitReaction.elapsedSeconds !== null
    ) {
      failures.push("baseline contains hit-reaction state");
    }
  } else if (id === "hit-overlap") {
    if (!onlyAuthoredAsset || !hasActiveNonIdleAuthoredMotion(authoredMotion)) {
      failures.push("overlap lost the active authored action");
    }
    if (hitReaction.triggerCount !== 1 || !contributingHitReaction) {
      failures.push("overlap lacks a contributing hit reaction");
    }
  } else if (id === "idle-only") {
    if (
      !onlyIdleAsset ||
      !authoredMotion.actions.some(
        (action) => action.running && !action.paused,
      ) ||
      hasActiveNonIdleAuthoredMotion(authoredMotion)
    ) {
      failures.push("idle control is not exclusively active idle motion");
    }
  } else if (id === "paused-authored") {
    if (
      !onlyAuthoredAsset ||
      !authoredMotion.actions.some(
        (action) => action.paused && !action.running,
      ) ||
      hasActiveNonIdleAuthoredMotion(authoredMotion)
    ) {
      failures.push("paused control is not a stopped authored action");
    }
  } else {
    if (authoredMotion.actions.length !== 0) {
      failures.push("zero-weight control still reports a contributing action");
    }
  }

  return {
    id,
    expectedOverlap,
    observedOverlap,
    authoredMotion,
    hitReaction,
    visiblePixelCount: 0,
    failures,
  };
}

async function advanceProductionVrmFrames(
  instance: { update: (deltaSeconds: number) => void },
  frameCount: number,
): Promise<void> {
  for (let frame = 0; frame < frameCount; frame += 1) {
    instance.update(PRODUCTION_VRM_OVERLAP_FRAME_SECONDS);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

async function advanceProductionVrmUntil(
  instance: {
    update: (deltaSeconds: number) => void;
    getAuthoredMotionDiagnostics: () => AvatarAuthoredMotionDiagnostics;
  },
  predicate: (diagnostics: AvatarAuthoredMotionDiagnostics) => boolean,
  label: string,
): Promise<void> {
  for (let frame = 0; frame < PRODUCTION_VRM_OVERLAP_MAX_FRAMES; frame += 1) {
    instance.update(PRODUCTION_VRM_OVERLAP_FRAME_SECONDS);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (predicate(instance.getAuthoredMotionDiagnostics())) return;
  }
  throw new Error(
    `${label} did not settle within ${PRODUCTION_VRM_OVERLAP_MAX_FRAMES} frames`,
  );
}

async function renderProductionVrmOverlapSnapshot(
  renderer: THREE.WebGPURenderer,
  renderCanvas: HTMLCanvasElement,
  scene: THREE.Scene,
  camera: THREE.Camera,
  snapshot: ProductionVrmOverlapSnapshot,
  asset: string,
): Promise<void> {
  const names: Record<ProductionVrmOverlapSnapshotId, string> = {
    "authored-baseline": "Factory: authored motion only",
    "hit-overlap": "Factory: authored + hit overlap",
    "idle-only": "Negative control: hit + idle only",
    "paused-authored": "Negative control: hit + paused authored action",
    "no-weight": "Negative control: hit + no mixer weight",
  };
  const { card, canvas } = createCard({
    id: snapshot.id,
    name: names[snapshot.id],
    asset,
    sampleRatio: 0,
  });
  card.dataset.productionVrmOverlap = "true";
  card.dataset.evidenceId = snapshot.id;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await renderer.renderAsync(scene, camera);
  const context = canvas.getContext("2d", { alpha: false })!;
  context.drawImage(renderCanvas, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let visiblePixelCount = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) >= 72) {
      visiblePixelCount += 1;
    }
  }
  snapshot.visiblePixelCount = visiblePixelCount;
  if (visiblePixelCount < PRODUCTION_VRM_OVERLAP_MIN_VISIBLE_PIXELS) {
    snapshot.failures.push(
      `rendered only ${visiblePixelCount} foreground pixels; minimum is ${PRODUCTION_VRM_OVERLAP_MIN_VISIBLE_PIXELS}`,
    );
  }
  card.dataset.status = snapshot.failures.length === 0 ? "pass" : "fail";
  const actionSummary = snapshot.authoredMotion.actions
    .map(
      (action) =>
        `${action.running ? "run" : "stop"}/${action.paused ? "paused" : "live"}@${action.effectiveWeight.toFixed(3)}`,
    )
    .join(", ");
  card.querySelector(".stats")!.textContent = snapshot.failures.length
    ? `FAIL · ${snapshot.failures.join(" · ")}`
    : `PASS · overlap ${snapshot.observedOverlap} · authored ${actionSummary || "none"} · hit ${snapshot.hitReaction.currentWeight.toFixed(3)} · ${visiblePixelCount}px`;
}

async function auditProductionVrmFactoryOverlap(
  config: DuelAvatarMotionAuditConfig,
  renderer: THREE.WebGPURenderer,
  renderCanvas: HTMLCanvasElement,
): Promise<ProductionVrmFactoryOverlapResult> {
  const production = config.productionVrmOverlap;
  if (!production) {
    throw new Error("production VRM overlap configuration is missing");
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172139);
  scene.add(new THREE.HemisphereLight(0xc9dcff, 0x202025, 2.3));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x73a6ff, 1.4);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 64),
    new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.94,
      metalness: 0.02,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(28, 480 / 440, 0.01, 20);
  camera.position.set(0, 0.86, 3.7);
  camera.lookAt(0, 0.82, 0);
  camera.layers.enable(1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const avatarLoader = new GLTFLoader();
  avatarLoader.register((parser) => new VRMLoaderPlugin(parser));
  const avatarGlb = await avatarLoader.loadAsync(
    `/asset/${config.avatarAsset}`,
  );
  const permittedEmotes = new Set([
    production.authoredMotion.asset,
    production.idleMotion.asset,
  ]);
  const emoteLoader = new GLTFLoader();
  const hooks = {
    scene,
    camera,
    loader: {
      async load(type: string, url: string) {
        if (type !== "emote") {
          throw new Error(
            `production VRM fixture rejected loader type ${type}`,
          );
        }
        const request = new URL(url, location.href);
        const asset = decodeURIComponent(
          request.pathname.slice("/asset/".length),
        );
        if (
          request.origin !== location.origin ||
          !request.pathname.startsWith("/asset/") ||
          !permittedEmotes.has(asset)
        ) {
          throw new Error(`production VRM fixture rejected emote ${url}`);
        }
        const emoteGlb = await emoteLoader.loadAsync(
          `${request.pathname}${request.search}`,
        );
        return createEmoteFactory(emoteGlb, asset);
      },
    },
  };
  const factory = createVRMFactory(avatarGlb);
  const instance = factory.create(new THREE.Matrix4(), hooks);
  if (!instance) {
    throw new Error("production VRM factory rejected the canonical avatar");
  }
  const avatarRoot = instance.raw?.scene;
  if (!avatarRoot) {
    throw new Error("production VRM factory did not return a rendered scene");
  }
  const authoredAssetUrl = new URL(
    `/asset/${production.authoredMotion.asset}`,
    location.href,
  ).href;
  const idleAssetUrl = new URL(
    `/asset/${production.idleMotion.asset}`,
    location.href,
  ).href;
  const snapshots: ProductionVrmOverlapSnapshot[] = [];

  const captureSnapshot = async (
    id: ProductionVrmOverlapSnapshotId,
    expectedOverlap: boolean,
    asset: string,
  ) => {
    const snapshot = snapshotProductionVrmOverlap(
      id,
      expectedOverlap,
      instance,
      authoredAssetUrl,
      idleAssetUrl,
    );
    snapshots.push(snapshot);
    await renderProductionVrmOverlapSnapshot(
      renderer,
      renderCanvas,
      scene,
      camera,
      snapshot,
      asset,
    );
  };

  try {
    if (
      instance.getHitReactionDiagnostics().availableBoneCount !==
      PLAYER_HIT_REACTION_BONES.length
    ) {
      throw new Error(
        `production VRM factory exposes ${instance.getHitReactionDiagnostics().availableBoneCount}/${PLAYER_HIT_REACTION_BONES.length} hit-reaction bones`,
      );
    }

    instance.setEmote(`${authoredAssetUrl}?l=1`);
    await advanceProductionVrmUntil(
      instance,
      (diagnostics) =>
        isStrictAuthoredMotionDiagnostics(diagnostics) &&
        diagnostics.actions.length > 0 &&
        diagnostics.actions.every(
          (action) => action.url === authoredAssetUrl,
        ) &&
        hasActiveNonIdleAuthoredMotion(diagnostics),
      "active authored-motion baseline",
    );
    await advanceProductionVrmFrames(instance, 4);
    await captureSnapshot(
      "authored-baseline",
      false,
      production.authoredMotion.asset,
    );

    instance.triggerHitReaction(1, 1);
    instance.update(0.0504);
    await captureSnapshot("hit-overlap", true, production.authoredMotion.asset);

    instance.clearHitReaction();
    instance.setEmote(`${idleAssetUrl}?l=1`);
    await advanceProductionVrmUntil(
      instance,
      (diagnostics) =>
        isStrictAuthoredMotionDiagnostics(diagnostics) &&
        diagnostics.actions.length > 0 &&
        diagnostics.actions.every((action) => action.url === idleAssetUrl) &&
        diagnostics.actions.some((action) => action.running && !action.paused),
      "idle-only negative control",
    );
    await advanceProductionVrmFrames(instance, 4);
    instance.triggerHitReaction(1, 1);
    instance.update(0.0504);
    await captureSnapshot("idle-only", false, production.idleMotion.asset);

    instance.clearHitReaction();
    instance.setEmote(`${authoredAssetUrl}?l=0`);
    await advanceProductionVrmUntil(
      instance,
      (diagnostics) =>
        isStrictAuthoredMotionDiagnostics(diagnostics) &&
        diagnostics.actions.length > 0 &&
        diagnostics.actions.every(
          (action) => action.url === authoredAssetUrl,
        ) &&
        diagnostics.actions.some(
          (action) => action.paused && !action.running,
        ) &&
        !hasActiveNonIdleAuthoredMotion(diagnostics),
      "paused authored-action negative control",
    );
    instance.triggerHitReaction(1, 1);
    instance.update(0.0504);
    await captureSnapshot(
      "paused-authored",
      false,
      production.authoredMotion.asset,
    );

    instance.clearHitReaction();
    instance.setEmote(null);
    await advanceProductionVrmUntil(
      instance,
      (diagnostics) =>
        isStrictAuthoredMotionDiagnostics(diagnostics) &&
        diagnostics.actions.length === 0,
      "zero-weight negative control",
    );
    instance.triggerHitReaction(1, 1);
    instance.update(0.0504);
    await captureSnapshot("no-weight", false, production.authoredMotion.asset);
  } finally {
    instance.destroy();
    disposeScene(avatarRoot);
    disposeScene(scene);
    scene.clear();
  }

  const failures = snapshots.flatMap((snapshot) =>
    snapshot.failures.map((failure) => `${snapshot.id}: ${failure}`),
  );
  return {
    schemaVersion: 1,
    implementation: "createVRMFactory",
    avatarAsset: config.avatarAsset,
    avatarSha256: config.avatarSha256,
    authoredMotionAsset: production.authoredMotion.asset,
    authoredMotionSha256: production.authoredMotion.sha256,
    idleMotionAsset: production.idleMotion.asset,
    idleMotionSha256: production.idleMotion.sha256,
    snapshots,
    failures,
  };
}

async function auditMotion(
  config: DuelAvatarMotionAuditConfig,
  motion: DuelAvatarMotionDefinition,
  renderer: THREE.WebGPURenderer,
  renderCanvas: HTMLCanvasElement,
): Promise<MotionResult> {
  const { card, canvas } = createCard(motion);
  const failures: string[] = [];
  const heldEquipmentEmote =
    motion.heldEquipmentEmote ?? (motion.id === "ranged" ? "range" : motion.id);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172139);
  scene.add(new THREE.HemisphereLight(0xc9dcff, 0x202025, 2.3));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x73a6ff, 1.4);
  rim.position.set(-4, 3, -3);
  scene.add(rim);

  const avatarLoader = new GLTFLoader();
  avatarLoader.register((parser) => new VRMLoaderPlugin(parser));
  const avatarGlb = await avatarLoader.loadAsync(
    `/asset/${config.avatarAsset}`,
  );
  const vrm = avatarGlb.userData.vrm;
  if (!vrm?.humanoid) {
    throw new Error(`${config.avatarAsset} did not load as a humanoid VRM`);
  }
  prepareVRMMaterialsForWebGPU(vrm.scene);
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
  vrm.humanoid.update(0);

  const missingRequiredBones = REQUIRED_BODY_BONES.filter(
    (bone) => !vrm.humanoid.getNormalizedBoneNode(bone),
  );
  if (missingRequiredBones.length > 0) {
    failures.push(
      `missing normalized bones: ${missingRequiredBones.join(", ")}`,
    );
  }

  const initialBounds = new THREE.Box3().setFromObject(vrm.scene, true);
  const initialSize = initialBounds.getSize(new THREE.Vector3());
  const scale = 1.6 / Math.max(initialSize.y, 0.001);
  vrm.scene.scale.setScalar(scale);
  vrm.scene.updateMatrixWorld(true);

  const equipmentDefinitions = getEquipmentDefinitions(config);
  const loadedEquipments: LoadedEquipment[] = [];
  const equipmentLoader = new GLTFLoader();
  for (const definition of equipmentDefinitions) {
    const equipmentGlb = await equipmentLoader.loadAsync(
      `/asset/${definition.asset}`,
    );
    const equipmentRoot = equipmentGlb.scene;
    const validation = validateStreamingEquipmentVisualModel(
      equipmentRoot,
      definition.slot,
      {
        itemId: definition.itemId,
        avatarId: definition.avatarId,
        vrm,
      },
    );
    if (!validation.valid) {
      failures.push(
        `${definition.itemId} equipment metadata: ${validation.reason}`,
      );
    }
    const attached = attachEquipmentVisualToVRM({
      slot: definition.slot,
      modelRoot: equipmentRoot,
      visuals: {},
      vrm,
    });
    if (!attached) {
      failures.push(`${definition.itemId} equipment attachment failed`);
    }
    loadedEquipments.push({
      definition,
      root: equipmentRoot,
      validation,
      attached,
      dynamicBowString: attached
        ? createDynamicBowStringController({
            modelRoot: equipmentRoot,
            vrm,
            getState: () => ({ emote: heldEquipmentEmote }),
          })
        : null,
      stableHeldPose: attached
        ? createStableHeldEquipmentPoseController({
            modelRoot: equipmentRoot,
            vrm,
          })
        : null,
      twoHandGrip: attached
        ? createTwoHandEquipmentGripController({
            modelRoot: equipmentRoot,
            vrm,
          })
        : null,
    });
  }

  const rawHips = vrm.humanoid.getRawBoneNode("hips");
  const rootToHips = rawHips?.getWorldPosition(new THREE.Vector3()).y ?? 1;
  const version = vrm.meta?.metaVersion ?? "1";
  const getBoneName = (boneName: string): string | undefined =>
    vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)?.name;

  const animationLoader = new GLTFLoader();
  const animationGlb = await animationLoader.loadAsync(
    `/asset/${motion.asset}`,
  );
  const emote = createEmoteFactory(animationGlb, motion.asset);
  const clip = emote.toClip({ rootToHips, version, getBoneName });
  if (!finite(clip.duration) || clip.duration <= 0) {
    failures.push(`invalid clip duration ${clip.duration}`);
  }
  if (clip.tracks.length < 8) {
    failures.push(`only ${clip.tracks.length} retargeted tracks`);
  }
  if (
    clip.tracks.some(
      (track) =>
        !Array.from(track.times).every(finite) ||
        !Array.from(track.values).every(finite),
    )
  ) {
    failures.push("retargeted clip contains a non-finite keyframe");
  }

  const targetNames = new Set(
    clip.tracks.map((track) =>
      track.name.slice(0, track.name.lastIndexOf(".")),
    ),
  );
  const targetNodes = [...targetNames]
    .map((name) => vrm.scene.getObjectByName(name))
    .filter((node): node is THREE.Object3D => Boolean(node));
  if (targetNodes.length !== targetNames.size) {
    failures.push(
      `${targetNames.size - targetNodes.length} animation targets are missing from the loaded avatar`,
    );
  }

  const mixer = new THREE.AnimationMixer(vrm.scene);
  const hitReaction = new PlayerHitReactionController(vrm.humanoid);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(0);
  vrm.humanoid.update(0);
  vrm.scene.updateMatrixWorld(true);
  const rootStart = vrm.scene.getWorldPosition(new THREE.Vector3());
  const startRotations = new Map(
    targetNodes.map((node) => [node, node.quaternion.clone()]),
  );

  const sampleSeconds = Math.min(
    Math.max(clip.duration * motion.sampleRatio, 0),
    Math.max(clip.duration - 0.001, 0),
  );
  hitReaction.beforeMixerUpdate();
  mixer.setTime(sampleSeconds);
  let hitReactionResult: MotionResult["hitReaction"];
  if (motion.hitReaction) {
    if (
      !hitReaction.trigger(
        motion.hitReaction.intensity,
        motion.hitReaction.side,
      )
    ) {
      failures.push("hit-reaction controller rejected the duel avatar");
    } else if (
      hitReaction.afterMixerUpdate(motion.hitReaction.elapsedSeconds) <= 0
    ) {
      failures.push("hit-reaction controller produced no visible pose weight");
    }
    const diagnostics = hitReaction.getDiagnostics();
    hitReactionResult = {
      ...motion.hitReaction,
      availableBoneCount: diagnostics.availableBoneCount,
      triggerCount: diagnostics.triggerCount,
      active: diagnostics.active,
      currentWeight: rounded(diagnostics.currentWeight),
    };
    if (
      diagnostics.availableBoneCount === 0 ||
      diagnostics.triggerCount !== 1 ||
      diagnostics.active !== true ||
      diagnostics.currentWeight <= 0
    ) {
      failures.push("hit-reaction diagnostics are incomplete");
    }
  }
  vrm.humanoid.update(0);
  vrm.scene.updateMatrixWorld(true);
  for (const equipment of loadedEquipments) {
    equipment.stableHeldPose?.update();
    equipment.twoHandGrip?.update();
    equipment.dynamicBowString?.update();
  }
  const rootEnd = vrm.scene.getWorldPosition(new THREE.Vector3());
  const deltas = targetNodes.map((node) =>
    THREE.MathUtils.radToDeg(
      startRotations.get(node)!.angleTo(node.quaternion),
    ),
  );
  const changedBoneCount = deltas.filter((delta) => delta > 0.5).length;
  const maximumBoneDeltaDegrees = Math.max(0, ...deltas);
  if (changedBoneCount < 2 || maximumBoneDeltaDegrees < 1) {
    failures.push(
      `pose is effectively static (${changedBoneCount} changed bones, ${maximumBoneDeltaDegrees.toFixed(3)}° maximum)`,
    );
  }

  const equipmentVisible = shouldRenderHeldEquipmentVisual({
    emote: heldEquipmentEmote,
  });
  const hiddenEquipments = loadedEquipments.flatMap((equipment) => {
    equipment.root.visible = equipmentVisible;
    const parent = !equipmentVisible ? equipment.root.parent : null;
    if (!parent) return [];
    parent.remove(equipment.root);
    return [{ root: equipment.root, parent }];
  });
  const bounds = new THREE.Box3().setFromObject(vrm.scene, true);
  for (const hidden of hiddenEquipments) {
    hidden.parent.add(hidden.root);
    hidden.root.updateMatrixWorld(true);
  }
  const size = bounds.getSize(new THREE.Vector3());
  if (
    ![size.x, size.y, size.z, bounds.min.y, bounds.max.y].every(finite) ||
    size.x <= 0.05 ||
    size.y <= 0.25 ||
    size.z <= 0.02 ||
    size.x > 3 ||
    size.y > 3 ||
    size.z > 3
  ) {
    failures.push(
      `implausible posed bounds ${size.x.toFixed(3)}×${size.y.toFixed(3)}×${size.z.toFixed(3)}`,
    );
  }
  const rootDrift = vectorDistance(rootStart, rootEnd);
  if (rootDrift > 0.000001) {
    failures.push(`scene root drifted ${rootDrift.toFixed(6)} metres`);
  }
  if (motion.id === "death" && bounds.min.y > 0.2) {
    failures.push(
      `death pose remains ${bounds.min.y.toFixed(3)} metres above ground`,
    );
  }
  if (motion.id === "death" && bounds.min.y < -0.25) {
    failures.push(
      `death pose penetrates ${Math.abs(bounds.min.y).toFixed(3)} metres below ground`,
    );
  }
  if (motion.id !== "death" && bounds.min.y > 0.35) {
    failures.push(
      `standing pose remains ${bounds.min.y.toFixed(3)} metres above ground`,
    );
  }
  let avatarGroundingResult: MotionResult["avatarGrounding"];
  if (motion.avatarGrounding) {
    const { minimumBoundsYMetres, maximumBoundsYMetres } =
      motion.avatarGrounding;
    const passed =
      bounds.min.y >= minimumBoundsYMetres &&
      bounds.min.y <= maximumBoundsYMetres;
    avatarGroundingResult = {
      minimumBoundsYMetres,
      maximumBoundsYMetres,
      passed,
    };
    if (bounds.min.y < minimumBoundsYMetres) {
      failures.push(
        `avatar penetrates to ${bounds.min.y.toFixed(3)}m; minimum is ${minimumBoundsYMetres.toFixed(3)}m`,
      );
    } else if (bounds.min.y > maximumBoundsYMetres) {
      failures.push(
        `avatar floats at ${bounds.min.y.toFixed(3)}m; maximum is ${maximumBoundsYMetres.toFixed(3)}m`,
      );
    }
  }
  const equipmentResults: EquipmentMotionResult[] = [];
  for (const loadedEquipment of loadedEquipments) {
    const {
      definition,
      root: equipmentRoot,
      validation: equipmentValidation,
      attached: equipmentAttached,
      dynamicBowString,
      stableHeldPose,
      twoHandGrip,
    } = loadedEquipment;
    if (!equipmentAttached) {
      equipmentResults.push(failedEquipmentResult(definition));
      continue;
    }
    const attachmentData = extractEquipmentAttachmentData(equipmentRoot);
    const equipmentBounds = new THREE.Box3().setFromObject(equipmentRoot, true);
    const equipmentSize = equipmentBounds.getSize(new THREE.Vector3());
    const rightHandNode = vrm.humanoid.getRawBoneNode("rightHand");
    const leftHandNode = vrm.humanoid.getRawBoneNode("leftHand");
    const rightHand = rightHandNode?.getWorldPosition(new THREE.Vector3());
    const leftHand = leftHandNode?.getWorldPosition(new THREE.Vector3());
    const head = vrm.humanoid
      .getRawBoneNode("head")
      ?.getWorldPosition(new THREE.Vector3());
    const torso = (
      vrm.humanoid.getRawBoneNode("chest") ??
      vrm.humanoid.getRawBoneNode("spine")
    )?.getWorldPosition(new THREE.Vector3());
    const rightDistance = rightHand
      ? nearestVertexDistance(equipmentRoot, rightHand)
      : Number.POSITIVE_INFINITY;
    const leftDistance = leftHand
      ? nearestVertexDistance(equipmentRoot, leftHand)
      : Number.POSITIVE_INFINITY;
    const headDistance = head
      ? nearestVertexDistance(equipmentRoot, head)
      : Number.POSITIVE_INFINITY;
    const torsoDistance = torso
      ? nearestVertexDistance(equipmentRoot, torso)
      : Number.POSITIVE_INFINITY;
    const rightSurfaceDistance = rightHand
      ? nearestMeshSurfaceDistance(equipmentRoot, rightHand)
      : Number.POSITIVE_INFINITY;
    const leftSurfaceDistance = leftHand
      ? nearestMeshSurfaceDistance(equipmentRoot, leftHand)
      : Number.POSITIVE_INFINITY;
    const headSurfaceDistance = head
      ? nearestMeshSurfaceDistance(equipmentRoot, head)
      : Number.POSITIVE_INFINITY;
    const torsoSurfaceDistance = torso
      ? nearestMeshSurfaceDistance(equipmentRoot, torso)
      : Number.POSITIVE_INFINITY;
    const rightHandMeshContact = measureSkinnedBoneMeshContact(
      vrm.scene,
      rightHandNode,
      equipmentRoot,
      true,
    );
    const leftHandMeshContact = measureSkinnedBoneMeshContact(
      vrm.scene,
      leftHandNode,
      equipmentRoot,
      true,
    );
    const gripZoneContacts: EquipmentMotionResult["gripZoneContacts"] = [];
    let actionDirectionWorld: [number, number, number] | null = null;
    const gripContact = attachmentData?.gripContact;
    if (gripContact) {
      const content = equipmentRoot.getObjectByName(
        gripContact.contentNodeName,
      );
      if (!content) {
        failures.push("grip-contact content node is missing");
      } else {
        const sourceAxis = new THREE.Vector3(
          ...(gripContact.sourceAxis as [number, number, number]),
        ).normalize();
        const sourceAxisWorld = sourceAxis
          .clone()
          .transformDirection(content.matrixWorld);
        if (gripContact.actionEnd === "minimum") {
          sourceAxisWorld.negate();
        }
        if (gripContact.actionEnd !== "dynamic-aim") {
          actionDirectionWorld = sourceAxisWorld.toArray().map(rounded) as [
            number,
            number,
            number,
          ];
        }
        for (const zone of gripContact.zones) {
          const region = createObjectAxisRegionGeometry(
            content,
            sourceAxis,
            zone.minimumSourceProjection,
            zone.maximumSourceProjection,
          );
          const regionMesh = new THREE.Mesh(region.geometry);
          const bone = vrm.humanoid.getRawBoneNode(zone.boneName);
          const contact = measureSkinnedBoneMeshContact(
            vrm.scene,
            bone,
            regionMesh,
            zone.boneName === "leftHand" || zone.boneName === "rightHand",
          );
          region.geometry.dispose();
          gripZoneContacts.push({
            id: zone.id,
            boneName: zone.boneName,
            equipmentTriangleCount: region.triangleCount,
            minimumSourceProjection: zone.minimumSourceProjection,
            maximumSourceProjection: zone.maximumSourceProjection,
            ...contact,
          });
          if (region.triangleCount < 4) {
            failures.push(`${zone.id} grip zone contains too little geometry`);
          }
          if (contact.intersects !== true) {
            failures.push(
              `${zone.boneName} does not intersect the authored ${zone.id} handle zone`,
            );
          }
        }
      }
    }
    const bodyRegionContacts = BODY_CLEARANCE_BONES.map((boneName) => ({
      boneName,
      ...measureSkinnedBoneMeshContact(
        vrm.scene,
        vrm.humanoid.getRawBoneNode(boneName),
        equipmentRoot,
      ),
    }));
    const equipmentMetrics = [
      equipmentSize.x,
      equipmentSize.y,
      equipmentSize.z,
      equipmentBounds.min.y,
      equipmentBounds.max.y,
      rightDistance,
      leftDistance,
      headDistance,
      torsoDistance,
      rightSurfaceDistance,
      leftSurfaceDistance,
      headSurfaceDistance,
      torsoSurfaceDistance,
    ];
    const attachmentBone = attachmentData?.vrmBoneName ?? null;
    const weaponType = attachmentData?.weaponType?.toLowerCase() ?? null;
    const orientationWrapperName =
      attachmentData?.twoHandGrip?.wrapperNodeName ?? "EquipmentWrapper";
    const orientationWrapper = equipmentRoot.getObjectByName(
      orientationWrapperName,
    );
    let orientation: EquipmentMotionResult["orientation"] = null;
    if (orientationWrapper) {
      vrm.scene.updateMatrixWorld(true);
      const wrapperWorldQuaternion = orientationWrapper.getWorldQuaternion(
        new THREE.Quaternion(),
      );
      const avatarWorldQuaternion = vrm.scene.getWorldQuaternion(
        new THREE.Quaternion(),
      );
      const wrapperAvatarLocalQuaternion = avatarWorldQuaternion
        .clone()
        .invert()
        .multiply(wrapperWorldQuaternion)
        .normalize();
      let primaryHand = attachmentBone === "leftHand" ? leftHand : rightHand;
      let secondaryHand = attachmentBone === "leftHand" ? rightHand : leftHand;
      if (attachmentData?.twoHandGrip) {
        primaryHand = orientationWrapper.getWorldPosition(new THREE.Vector3());
        const secondaryBone = vrm.humanoid.getRawBoneNode(
          attachmentData.twoHandGrip.secondaryBoneName,
        );
        if (secondaryBone) {
          secondaryHand = attachmentData.twoHandGrip.secondaryBoneLocalOffset
            ? new THREE.Vector3(
                ...attachmentData.twoHandGrip.secondaryBoneLocalOffset,
              ).applyMatrix4(secondaryBone.matrixWorld)
            : secondaryBone.getWorldPosition(new THREE.Vector3());
        }
      }
      const primaryToSecondaryDirection =
        primaryHand && secondaryHand
          ? secondaryHand.clone().sub(primaryHand)
          : null;
      if (
        primaryToSecondaryDirection &&
        primaryToSecondaryDirection.lengthSq() > 1e-8
      ) {
        primaryToSecondaryDirection.normalize();
      }
      const metadataHandleAxis = attachmentData?.twoHandGrip
        ? new THREE.Vector3(...attachmentData.twoHandGrip.sourceHandleAxis)
        : null;
      if (metadataHandleAxis && metadataHandleAxis.lengthSq() > 1e-8) {
        metadataHandleAxis.normalize().applyQuaternion(wrapperWorldQuaternion);
      }
      const metadataHandleToSecondaryDeviationDegrees =
        metadataHandleAxis &&
        primaryToSecondaryDirection &&
        primaryToSecondaryDirection.lengthSq() > 1e-8
          ? THREE.MathUtils.radToDeg(
              metadataHandleAxis.angleTo(primaryToSecondaryDirection),
            )
          : null;
      orientation = {
        wrapperNodeName: orientationWrapperName,
        wrapperWorldQuaternion: wrapperWorldQuaternion
          .toArray()
          .map(rounded) as [number, number, number, number],
        wrapperAvatarLocalQuaternion: wrapperAvatarLocalQuaternion
          .toArray()
          .map(rounded) as [number, number, number, number],
        primaryToSecondaryDirection:
          primaryToSecondaryDirection &&
          primaryToSecondaryDirection.lengthSq() > 1e-8
            ? (primaryToSecondaryDirection.toArray().map(rounded) as [
                number,
                number,
                number,
              ])
            : null,
        metadataHandleAxisWorld: metadataHandleAxis
          ? (metadataHandleAxis.toArray().map(rounded) as [
              number,
              number,
              number,
            ])
          : null,
        metadataHandleToSecondaryDeviationDegrees:
          metadataHandleToSecondaryDeviationDegrees === null
            ? null
            : rounded(metadataHandleToSecondaryDeviationDegrees),
      };
    }
    let stablePoseDeviationDegrees: number | null = null;
    let stablePosePositionDeviationMetres: number | null = null;
    if (stableHeldPose && attachmentData?.stableHeldPose) {
      const stablePoseData = attachmentData.stableHeldPose;
      const wrapper = equipmentRoot.getObjectByName(
        stablePoseData.wrapperNodeName,
      );
      if (wrapper) {
        const desiredAvatarQuaternion = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            ...(stablePoseData.avatarLocalEulerDegrees.map(
              THREE.MathUtils.degToRad,
            ) as [number, number, number]),
            "XYZ",
          ),
        );
        const desiredWorldQuaternion = vrm.scene
          .getWorldQuaternion(new THREE.Quaternion())
          .multiply(desiredAvatarQuaternion);
        stablePoseDeviationDegrees = THREE.MathUtils.radToDeg(
          wrapper
            .getWorldQuaternion(new THREE.Quaternion())
            .angleTo(desiredWorldQuaternion),
        );
        const primaryBoneLocalOffset = stablePoseData.primaryBoneLocalOffset;
        const primaryBone = primaryBoneLocalOffset
          ? vrm.humanoid.getRawBoneNode(
              attachmentData.vrmBoneName as VRMHumanBoneName,
            )
          : null;
        if (primaryBoneLocalOffset && primaryBone) {
          const desiredPosition = new THREE.Vector3(
            ...(primaryBoneLocalOffset as [number, number, number]),
          ).applyMatrix4(primaryBone.matrixWorld);
          if (stablePoseData.avatarLocalPositionOffset) {
            desiredPosition.add(
              new THREE.Vector3(
                ...(stablePoseData.avatarLocalPositionOffset as [
                  number,
                  number,
                  number,
                ]),
              ).applyQuaternion(
                vrm.scene.getWorldQuaternion(new THREE.Quaternion()),
              ),
            );
          }
          stablePosePositionDeviationMetres = wrapper
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(desiredPosition);
        }
      }
    }
    let nockedArrowVisible = false;
    let nockedArrowNockDistance: number | null = null;
    let nockedArrowAimDeviationDegrees: number | null = null;
    let nockedArrowDrawHandMeshContact: HandMeshContactResult | null = null;
    if (dynamicBowString) {
      vrm.scene.updateMatrixWorld(true);
      nockedArrowVisible = dynamicBowString.nockedArrow.visible;
      if (rightHand && nockedArrowVisible) {
        const bowString = attachmentData?.bowString;
        const drawHandAnchor =
          rightHandNode && bowString
            ? new THREE.Vector3(
                ...((bowString.drawHandLocalOffset ?? [0, 0, 0]) as [
                  number,
                  number,
                  number,
                ]),
              ).applyMatrix4(rightHandNode.matrixWorld)
            : rightHand;
        const arrowOrigin = dynamicBowString.nockedArrow.getWorldPosition(
          new THREE.Vector3(),
        );
        nockedArrowNockDistance = arrowOrigin.distanceTo(drawHandAnchor);
        nockedArrowDrawHandMeshContact = measureSkinnedBoneMeshContact(
          vrm.scene,
          rightHandNode,
          dynamicBowString.nockedArrow,
          true,
        );
        const content = bowString
          ? equipmentRoot.getObjectByName(bowString.contentNodeName)
          : null;
        if (bowString && content) {
          const restNock = new THREE.Vector3(
            ...(bowString.restNock as [number, number, number]),
          );
          content.localToWorld(restNock);
          const desiredDirection = restNock.sub(drawHandAnchor);
          const arrowForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
            dynamicBowString.nockedArrow.getWorldQuaternion(
              new THREE.Quaternion(),
            ),
          );
          if (
            desiredDirection.lengthSq() > 1e-8 &&
            arrowForward.lengthSq() > 1e-8
          ) {
            nockedArrowAimDeviationDegrees = THREE.MathUtils.radToDeg(
              desiredDirection.normalize().angleTo(arrowForward.normalize()),
            );
          }
        }
      }
    }
    if (!equipmentMetrics.every(finite)) {
      failures.push("equipment produced non-finite geometry metrics");
    }
    const longestAxis = Math.max(
      equipmentSize.x,
      equipmentSize.y,
      equipmentSize.z,
    );
    if (longestAxis < 0.35 || longestAxis > 2.4) {
      failures.push(
        `equipment length ${longestAxis.toFixed(3)}m is outside the duel-weapon envelope`,
      );
    }
    const primaryDistance =
      attachmentBone === "leftHand"
        ? leftSurfaceDistance
        : rightSurfaceDistance;
    if (primaryDistance > 0.22) {
      failures.push(
        `${attachmentBone ?? "attachment"} is ${primaryDistance.toFixed(3)}m from the equipment surface`,
      );
    }
    const minimumFloorClearance =
      motion.equipmentClearance?.minimumFloorClearanceMetres;
    if (
      minimumFloorClearance !== undefined &&
      equipmentBounds.min.y < minimumFloorClearance
    ) {
      failures.push(
        `${definition.itemId} floor clearance ${equipmentBounds.min.y.toFixed(3)}m is below ${minimumFloorClearance.toFixed(3)}m`,
      );
    }
    const minimumBodySurfaceDistance =
      motion.equipmentClearance?.minimumBodySurfaceDistanceMetres;
    if (minimumBodySurfaceDistance !== undefined) {
      const measurableContacts = bodyRegionContacts.filter(
        (contact) => contact.triangleCount > 0,
      );
      if (measurableContacts.length === 0) {
        failures.push("body-clearance regions contain no rendered geometry");
      }
      for (const contact of measurableContacts) {
        if (
          contact.intersects === true ||
          contact.minimumSurfaceDistance === null ||
          contact.minimumSurfaceDistance < minimumBodySurfaceDistance
        ) {
          failures.push(
            `${definition.itemId} is ${(contact.minimumSurfaceDistance ?? 0).toFixed(3)}m from ${contact.boneName}; requires ${minimumBodySurfaceDistance.toFixed(3)}m`,
          );
        }
      }
    }
    if (
      definition.grip === "two-hand" &&
      weaponType !== "bow" &&
      (motion.id === "two-hand-idle" ||
        motion.id === "two-hand-slash" ||
        (definition.slot === "gatheringtool" &&
          (motion.id === "woodcutting" ||
            motion.id === "mining" ||
            motion.id === "fishing"))) &&
      (attachmentBone === "leftHand"
        ? rightSurfaceDistance
        : leftSurfaceDistance) > 0.23
    ) {
      const secondaryDistance =
        attachmentBone === "leftHand"
          ? rightSurfaceDistance
          : leftSurfaceDistance;
      failures.push(
        `secondary hand is ${secondaryDistance.toFixed(3)}m from the two-handed weapon`,
      );
    }
    if (weaponType === "harpoon" && !twoHandGrip) {
      failures.push("harpoon two-hand grip controller is not active");
    }
    if (
      weaponType === "harpoon" &&
      (attachmentBone === "leftHand"
        ? rightSurfaceDistance
        : leftSurfaceDistance) > 0.06
    ) {
      const secondaryDistance =
        attachmentBone === "leftHand"
          ? rightSurfaceDistance
          : leftSurfaceDistance;
      failures.push(
        `harpoon secondary hand is ${secondaryDistance.toFixed(3)}m from the shaft`,
      );
    }
    if (weaponType === "bow" && heldEquipmentEmote === "range") {
      if (!nockedArrowVisible) {
        failures.push("nocked arrow is not visible during ranged draw");
      }
      if (
        nockedArrowNockDistance === null ||
        nockedArrowNockDistance > 0.0001
      ) {
        failures.push(
          `nocked arrow is ${(nockedArrowNockDistance ?? Number.POSITIVE_INFINITY).toFixed(6)}m from the draw hand`,
        );
      }
      if (
        nockedArrowAimDeviationDegrees === null ||
        nockedArrowAimDeviationDegrees > 0.1
      ) {
        failures.push(
          `nocked arrow aim deviates ${(nockedArrowAimDeviationDegrees ?? Number.POSITIVE_INFINITY).toFixed(3)}° from the bow rest`,
        );
      }
      if (nockedArrowDrawHandMeshContact?.intersects !== true) {
        failures.push("nocked arrow does not intersect the rendered draw hand");
      }
    } else if (nockedArrowVisible) {
      failures.push("nocked arrow remains visible outside ranged draw");
    }
    if (weaponType === "staff" && !stableHeldPose) {
      failures.push("staff stable held pose is not active");
    }
    if (
      weaponType === "staff" &&
      (stablePoseDeviationDegrees === null || stablePoseDeviationDegrees > 0.1)
    ) {
      failures.push(
        `staff pose deviates ${(stablePoseDeviationDegrees ?? Number.POSITIVE_INFINITY).toFixed(3)}° from its avatar-local authority`,
      );
    }
    if (
      stablePosePositionDeviationMetres !== null &&
      stablePosePositionDeviationMetres > 0.0001
    ) {
      failures.push(
        `stable held grip deviates ${stablePosePositionDeviationMetres.toFixed(6)}m from its rendered-hand anchor`,
      );
    }
    const staffClearanceMotion = new Set([
      "idle",
      "walk",
      "run",
      "unarmed",
      "magic",
      "hit-reaction",
    ]).has(motion.id);
    if (
      weaponType === "staff" &&
      staffClearanceMotion &&
      headSurfaceDistance < 0.25
    ) {
      failures.push(
        `staff is only ${headSurfaceDistance.toFixed(3)}m from the head anchor`,
      );
    }
    if (
      weaponType === "staff" &&
      staffClearanceMotion &&
      torsoSurfaceDistance < 0.2
    ) {
      failures.push(
        `staff is only ${torsoSurfaceDistance.toFixed(3)}m from the torso anchor`,
      );
    }
    equipmentResults.push({
      itemId: definition.itemId,
      asset: definition.asset,
      metadataValid: equipmentValidation.valid === true,
      metadataReason: equipmentValidation.reason ?? null,
      attached: equipmentAttached,
      visible: equipmentVisible,
      weaponType,
      dynamicBowStringActive: Boolean(dynamicBowString),
      stableHeldPoseActive: Boolean(stableHeldPose),
      twoHandGripActive: Boolean(twoHandGrip),
      stablePoseDeviationDegrees:
        stablePoseDeviationDegrees === null
          ? null
          : rounded(stablePoseDeviationDegrees),
      stablePosePositionDeviationMetres:
        stablePosePositionDeviationMetres === null
          ? null
          : rounded(stablePosePositionDeviationMetres),
      nockedArrowVisible,
      nockedArrowNockDistance:
        nockedArrowNockDistance === null
          ? null
          : rounded(nockedArrowNockDistance),
      nockedArrowAimDeviationDegrees:
        nockedArrowAimDeviationDegrees === null
          ? null
          : rounded(nockedArrowAimDeviationDegrees),
      nockedArrowDrawHandMeshContact,
      gripZoneContacts,
      bodyRegionContacts,
      projectedBodyOverlap: null,
      actionDirectionWorld,
      attachmentBone,
      orientation,
      bounds: {
        width: rounded(equipmentSize.x),
        height: rounded(equipmentSize.y),
        depth: rounded(equipmentSize.z),
        minimumY: rounded(equipmentBounds.min.y),
        maximumY: rounded(equipmentBounds.max.y),
      },
      rightHandNearestVertexDistance: rounded(rightDistance),
      leftHandNearestVertexDistance: rounded(leftDistance),
      headNearestVertexDistance: rounded(headDistance),
      torsoNearestVertexDistance: rounded(torsoDistance),
      rightHandNearestSurfaceDistance: rounded(rightSurfaceDistance),
      leftHandNearestSurfaceDistance: rounded(leftSurfaceDistance),
      headNearestSurfaceDistance: rounded(headSurfaceDistance),
      torsoNearestSurfaceDistance: rounded(torsoSurfaceDistance),
      rightHandMeshContact,
      leftHandMeshContact,
    });
  }
  const equipmentPairResults: EquipmentPairMotionResult[] = [];
  for (
    let firstIndex = 0;
    firstIndex < loadedEquipments.length;
    firstIndex += 1
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < loadedEquipments.length;
      secondIndex += 1
    ) {
      const pair = measureEquipmentPair(
        loadedEquipments[firstIndex],
        loadedEquipments[secondIndex],
        equipmentVisible &&
          loadedEquipments[firstIndex].attached &&
          loadedEquipments[secondIndex].attached,
      );
      equipmentPairResults.push(pair);
      if (pair.evaluated && pair.intersects) {
        failures.push(`${pair.itemIds.join(" and ")} geometry intersects`);
      }
      if (pair.evaluated && pair.minimumSurfaceDistance === null) {
        failures.push(
          `${pair.itemIds.join(" and ")} surface distance could not be measured`,
        );
      }
    }
  }
  assertFiniteScene(vrm.scene, failures);

  let waterContact: MotionResult["waterContact"];
  if (motion.waterContact) {
    const waterSurfaceBelowFeet = config.environment?.waterSurfaceBelowFeet;
    const harpoon = equipmentResults.find(
      (equipment) => equipment.weaponType === "harpoon",
    );
    if (
      typeof waterSurfaceBelowFeet !== "number" ||
      !Number.isFinite(waterSurfaceBelowFeet) ||
      !harpoon
    ) {
      failures.push(
        "water-contact expectation requires one harpoon and a finite water surface",
      );
    } else {
      const waterSurfaceY = -waterSurfaceBelowFeet;
      const intersects =
        harpoon.bounds.minimumY <= waterSurfaceY &&
        harpoon.bounds.maximumY >= waterSurfaceY;
      waterContact = {
        expectation: motion.waterContact,
        waterSurfaceY: rounded(waterSurfaceY),
        equipmentMinimumY: harpoon.bounds.minimumY,
        equipmentMaximumY: harpoon.bounds.maximumY,
        intersects,
      };
      if (motion.waterContact === "contact" && !intersects) {
        failures.push(
          `harpoon does not intersect the ${waterSurfaceY.toFixed(3)}m water surface`,
        );
      }
      if (motion.waterContact === "clear" && intersects) {
        failures.push(
          `harpoon intersects the ${waterSurfaceY.toFixed(3)}m water surface before or after contact`,
        );
      }
    }
  }

  if (config.environment) {
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 64),
      new THREE.MeshPhysicalMaterial({
        color: 0x3b9fd7,
        transparent: true,
        opacity: 0.68,
        roughness: 0.16,
        metalness: 0.02,
        transmission: 0.08,
        side: THREE.DoubleSide,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -config.environment.waterSurfaceBelowFeet;
    scene.add(water);
  }

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 64),
    new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.94,
      metalness: 0.02,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(28, 480 / 440, 0.01, 20);
  if (motion.cameraTarget === "primary-grip") {
    const primaryEquipment = loadedEquipments.find(
      (equipment) => equipment.attached,
    );
    const attachmentData = primaryEquipment
      ? extractEquipmentAttachmentData(primaryEquipment.root)
      : null;
    const primaryBone = attachmentData?.vrmBoneName
      ? vrm.humanoid.getRawBoneNode(
          attachmentData.vrmBoneName as VRMHumanBoneName,
        )
      : null;
    if (!primaryEquipment || !primaryBone) {
      failures.push("primary-grip camera requires attached rigid equipment");
      camera.position.set(0, 0.86, 3.7);
      camera.lookAt(0, 0.82, 0);
    } else {
      const cameraTarget = primaryBone.getWorldPosition(new THREE.Vector3());
      const cameraDistance = 0.72;
      const yaw = THREE.MathUtils.degToRad(motion.cameraYawDegrees ?? 0);
      const pitch = THREE.MathUtils.degToRad(motion.cameraPitchDegrees ?? 0);
      const horizontalDistance = Math.cos(pitch) * cameraDistance;
      camera.position.set(
        cameraTarget.x + Math.sin(yaw) * horizontalDistance,
        cameraTarget.y + Math.sin(pitch) * cameraDistance,
        cameraTarget.z + Math.cos(yaw) * horizontalDistance,
      );
      camera.lookAt(cameraTarget);
    }
  } else if (
    config.framing === "avatar-and-equipment" &&
    equipmentDefinitions.length > 0 &&
    equipmentVisible
  ) {
    const framingBounds = new THREE.Box3().setFromObject(vrm.scene, true);
    const framingSize = framingBounds.getSize(new THREE.Vector3());
    const framingCenter = framingBounds.getCenter(new THREE.Vector3());
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov =
      2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const distance =
      Math.max(
        framingSize.y / (2 * Math.tan(verticalFov / 2)),
        framingSize.x / (2 * Math.tan(horizontalFov / 2)),
      ) +
      framingSize.z / 2;
    camera.far = 50;
    const cameraDistance = Math.max(distance * 1.18, 2.2);
    const yaw = THREE.MathUtils.degToRad(motion.cameraYawDegrees ?? 0);
    const pitch = THREE.MathUtils.degToRad(motion.cameraPitchDegrees ?? 0);
    const horizontalDistance = Math.cos(pitch) * cameraDistance;
    camera.position.set(
      framingCenter.x + Math.sin(yaw) * horizontalDistance,
      framingCenter.y + Math.sin(pitch) * cameraDistance,
      framingCenter.z + Math.cos(yaw) * horizontalDistance,
    );
    camera.lookAt(framingCenter);
  } else {
    const yaw = THREE.MathUtils.degToRad(motion.cameraYawDegrees ?? 0);
    const pitch = THREE.MathUtils.degToRad(motion.cameraPitchDegrees ?? 0);
    const horizontalDistance = Math.cos(pitch) * 3.7;
    camera.position.set(
      Math.sin(yaw) * horizontalDistance,
      0.86 + Math.sin(pitch) * 3.7,
      Math.cos(yaw) * horizontalDistance,
    );
    camera.lookAt(0, 0.82, 0);
  }
  camera.updateProjectionMatrix();
  for (let index = 0; index < loadedEquipments.length; index += 1) {
    const loadedEquipment = loadedEquipments[index];
    const equipmentResult = equipmentResults[index];
    if (!loadedEquipment.attached || !equipmentResult) continue;
    const overlap = await measureProjectedBodyOverlap(
      renderer,
      scene,
      camera,
      vrm.scene,
      vrm,
      loadedEquipment.root,
    );
    equipmentResult.projectedBodyOverlap = overlap;
    const maximumOverlap =
      motion.equipmentClearance?.maximumProjectedBodyOverlapRatio;
    if (
      maximumOverlap !== undefined &&
      overlap.equipmentOverlapRatio > maximumOverlap
    ) {
      failures.push(
        `${loadedEquipment.definition.itemId} projected body overlap ${(overlap.equipmentOverlapRatio * 100).toFixed(2)}% exceeds ${(maximumOverlap * 100).toFixed(2)}%`,
      );
    }
  }
  await renderer.renderAsync(scene, camera);
  canvas.getContext("2d", { alpha: false })!.drawImage(renderCanvas, 0, 0);

  const result: MotionResult = {
    id: motion.id,
    name: motion.name,
    asset: motion.asset,
    durationSeconds: rounded(clip.duration),
    sampleSeconds: rounded(sampleSeconds),
    ...(motion.cameraYawDegrees !== undefined
      ? { cameraYawDegrees: motion.cameraYawDegrees }
      : {}),
    ...(motion.cameraPitchDegrees !== undefined
      ? { cameraPitchDegrees: motion.cameraPitchDegrees }
      : {}),
    ...(motion.cameraTarget !== undefined
      ? { cameraTarget: motion.cameraTarget }
      : {}),
    ...(motion.heldEquipmentEmote !== undefined
      ? { heldEquipmentEmote: motion.heldEquipmentEmote }
      : {}),
    ...(hitReactionResult ? { hitReaction: hitReactionResult } : {}),
    ...(avatarGroundingResult
      ? { avatarGrounding: avatarGroundingResult }
      : {}),
    trackCount: clip.tracks.length,
    targetBoneCount: targetNodes.length,
    changedBoneCount,
    maximumBoneDeltaDegrees: rounded(maximumBoneDeltaDegrees),
    bounds: {
      width: rounded(size.x),
      height: rounded(size.y),
      depth: rounded(size.z),
      minimumY: rounded(bounds.min.y),
      maximumY: rounded(bounds.max.y),
    },
    rootDrift: rounded(rootDrift),
    ...(equipmentResults.length === 1
      ? { equipment: equipmentResults[0] }
      : equipmentResults.length > 1
        ? {
            equipments: equipmentResults,
            equipmentPairs: equipmentPairResults,
          }
        : {}),
    ...(waterContact ? { waterContact } : {}),
    failures: [...new Set(failures)],
  };
  card.querySelector(".stats")!.textContent = result.failures.length
    ? `FAIL · ${result.failures.join(" · ")}`
    : `${result.trackCount} tracks · ${result.changedBoneCount} moving bones · ${result.maximumBoneDeltaDegrees.toFixed(1)}° max${result.waterContact ? ` · water ${result.waterContact.intersects ? "contact" : "clear"}` : ""}`;
  card.dataset.status = result.failures.length ? "fail" : "pass";

  mixer.stopAllAction();
  mixer.uncacheRoot(vrm.scene);
  for (const equipment of loadedEquipments) {
    equipment.dynamicBowString?.dispose();
  }
  disposeScene(scene);
  scene.clear();
  return result;
}

export async function runDuelAvatarMotionAudit(
  config: DuelAvatarMotionAuditConfig,
): Promise<DuelAvatarMotionBrowserReport> {
  const equipmentDefinitions = getEquipmentDefinitions(config);
  if (!navigator.gpu) {
    throw new Error("WebGPU is required for the duel-avatar motion audit");
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("Chrome did not expose a WebGPU adapter");
  }
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = 480;
  renderCanvas.height = 440;
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
    throw new Error("Motion audit did not initialize a WebGPU backend");
  }
  renderer.setPixelRatio(1);
  renderer.setSize(480, 440, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const adapterInfo = adapter.info;
  const rendererName = [
    "WebGPU",
    adapterInfo.vendor,
    adapterInfo.architecture,
    adapterInfo.device,
    adapterInfo.description,
  ]
    .filter(Boolean)
    .join(" · ");

  const results: MotionResult[] = [];
  for (const motion of config.motions) {
    try {
      results.push(await auditMotion(config, motion, renderer, renderCanvas));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { card } = createCard(motion);
      card.dataset.status = "fail";
      card.querySelector(".stats")!.textContent = `FAIL · ${message}`;
      results.push({
        id: motion.id,
        name: motion.name,
        asset: motion.asset,
        durationSeconds: 0,
        sampleSeconds: 0,
        ...(motion.cameraYawDegrees !== undefined
          ? { cameraYawDegrees: motion.cameraYawDegrees }
          : {}),
        ...(motion.cameraPitchDegrees !== undefined
          ? { cameraPitchDegrees: motion.cameraPitchDegrees }
          : {}),
        ...(motion.cameraTarget !== undefined
          ? { cameraTarget: motion.cameraTarget }
          : {}),
        ...(motion.hitReaction
          ? {
              hitReaction: {
                ...motion.hitReaction,
                availableBoneCount: 0,
                triggerCount: 0,
                active: false,
                currentWeight: 0,
              },
            }
          : {}),
        trackCount: 0,
        targetBoneCount: 0,
        changedBoneCount: 0,
        maximumBoneDeltaDegrees: 0,
        bounds: {
          width: 0,
          height: 0,
          depth: 0,
          minimumY: 0,
          maximumY: 0,
        },
        rootDrift: 0,
        ...(equipmentDefinitions.length === 1
          ? { equipment: failedEquipmentResult(equipmentDefinitions[0]) }
          : equipmentDefinitions.length > 1
            ? {
                equipments: equipmentDefinitions.map(failedEquipmentResult),
                equipmentPairs: equipmentDefinitions.flatMap(
                  (first, firstIndex) =>
                    equipmentDefinitions
                      .slice(firstIndex + 1)
                      .map((second): EquipmentPairMotionResult => ({
                        itemIds: [first.itemId, second.itemId],
                        evaluated: false,
                        intersects: null,
                        minimumSurfaceDistance: null,
                      })),
                ),
              }
            : {}),
        failures: [message],
      });
    }
  }
  let productionVrmOverlap: ProductionVrmFactoryOverlapResult | undefined;
  if (config.productionVrmOverlap) {
    try {
      productionVrmOverlap = await auditProductionVrmFactoryOverlap(
        config,
        renderer,
        renderCanvas,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { card } = createCard({
        id: "production-vrm-overlap-error",
        name: "Production VRM factory overlap proof",
        asset: config.productionVrmOverlap.authoredMotion.asset,
        sampleRatio: 0,
      });
      card.dataset.productionVrmOverlap = "true";
      card.dataset.evidenceId = "production-vrm-overlap-error";
      card.dataset.status = "fail";
      card.querySelector(".stats")!.textContent = `FAIL · ${message}`;
      productionVrmOverlap = {
        schemaVersion: 1,
        implementation: "createVRMFactory",
        avatarAsset: config.avatarAsset,
        avatarSha256: config.avatarSha256,
        authoredMotionAsset: config.productionVrmOverlap.authoredMotion.asset,
        authoredMotionSha256: config.productionVrmOverlap.authoredMotion.sha256,
        idleMotionAsset: config.productionVrmOverlap.idleMotion.asset,
        idleMotionSha256: config.productionVrmOverlap.idleMotion.sha256,
        snapshots: [],
        failures: [message],
      };
    }
  }
  renderer.dispose();
  const failures = [
    ...results.flatMap((result) =>
      result.failures.map((failure) => `${result.id}: ${failure}`),
    ),
    ...(productionVrmOverlap?.failures.map(
      (failure) => `production-vrm-overlap: ${failure}`,
    ) ?? []),
  ];
  return {
    avatarAsset: config.avatarAsset,
    avatarSha256: config.avatarSha256,
    ...(config.framing === "avatar-and-equipment"
      ? { framing: config.framing }
      : {}),
    userAgent: navigator.userAgent,
    renderer: rendererName,
    rendererBackend: "webgpu",
    rendererAdapter: {
      vendor: adapterInfo.vendor || null,
      architecture: adapterInfo.architecture || null,
      device: adapterInfo.device || null,
      description: adapterInfo.description || null,
    },
    ...(config.environment ? { environment: config.environment } : {}),
    motions: results,
    ...(productionVrmOverlap ? { productionVrmOverlap } : {}),
    failures,
  };
}
