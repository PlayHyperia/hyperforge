import { getItem } from "../../data/items";
import { getArrowVisual } from "../../data/spell-visuals";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { NeutralShortsReplacementData } from "./NeutralShortsWearState";
import {
  createArrowVisualInstance,
  disposeArrowVisualInstance,
  updateArrowVisualColors,
} from "./ArrowVisualHelpers";

export interface EquipmentAttachmentData {
  vrmBoneName: string;
  originalSlot?: string;
  weaponType?: string;
  usage?: string;
  note?: string;
  version?: number;
  relativeMatrix?: number[];
  avatarId?: string;
  avatarHeight?: number;
  duelFit?: DuelEquipmentFitData;
  bowString?: DynamicBowStringData;
  stableHeldPose?: StableHeldPoseData;
  twoHandGrip?: TwoHandGripData;
  gripContact?: EquipmentGripContactData;
  fishingWorld?: FishingWorldVisualData;
  /** Complete qualified leg clothing only; never inferred for partial armor. */
  clothingReplacement?: NeutralShortsReplacementData;
}

export interface EquipmentGripContactZoneData {
  id: "primary" | "secondary";
  boneName: "leftHand" | "rightHand";
  minimumSourceProjection: number;
  maximumSourceProjection: number;
}

export interface EquipmentGripContactData {
  schemaVersion: 1;
  contentNodeName: string;
  sourceAxis: number[];
  /** Which authored end performs the action; bows use their live arrow aim. */
  actionEnd: "minimum" | "maximum" | "dynamic-aim";
  zones: EquipmentGripContactZoneData[];
}

export interface FishingWorldVisualPlacement {
  positionOffset: [number, number, number];
  rotationEulerDegrees: [number, number, number];
  scale: number;
}

export interface FishingWorldVisualData {
  schemaVersion: 1;
  itemId: string;
  placement: FishingWorldVisualPlacement | null;
}

export interface DynamicBowStringData {
  schemaVersion: 1;
  contentNodeName: string;
  upperTip: number[];
  lowerTip: number[];
  restNock: number[];
  /**
   * Exact draw-hand mesh anchor expressed in the raw right-hand bone space.
   * Certified v1 bows authored before this optional refinement use the raw
   * hand-bone origin, which is represented by an omitted/zero offset.
   */
  drawHandLocalOffset?: number[];
}

export interface StableHeldPoseData {
  schemaVersion: 1;
  wrapperNodeName: string;
  /** Fixed orientation relative to the avatar root, independent of wrist roll. */
  avatarLocalEulerDegrees: number[];
  /** Optional exact rendered-grip anchor in the raw attachment-bone space. */
  primaryBoneLocalOffset?: number[];
  /** Fine alignment relative to avatar facing after resolving the grip anchor. */
  avatarLocalPositionOffset?: number[];
}

export interface TwoHandGripData {
  schemaVersion: 1;
  wrapperNodeName: string;
  sourceHandleAxis: number[];
  secondaryBoneName: "leftHand" | "rightHand";
  secondaryBoneLocalOffset?: number[];
}

/**
 * Immutable approval metadata written by the offline fitting pipeline.
 * Runtime loading alone cannot prove that a generated mesh fits a particular
 * avatar, so competitive equipment must name the exact approved avatar set.
 */
export interface DuelEquipmentFitData {
  schemaVersion: 1;
  itemId: string;
  slot: string;
  compatibleAvatarIds: string[];
  /** Required for deforming equipment; derived from the canonical rest rig. */
  rigFingerprint?: string;
}

export interface EquipmentVisualModelData {
  equippedModelPath?: string | null;
  equippedModelSha256?: string;
  equippedModelPathsByAvatar?: Record<string, string>;
  equippedModelSha256ByAvatar?: Record<string, string>;
  gatheringModelPathsByAvatar?: Record<string, string>;
  gatheringModelSha256ByAvatar?: Record<string, string>;
  modelPath?: string | null;
}

export interface EquipmentVisualUrlResolution {
  primaryUrl: string;
  fallbackUrl: string | null;
  contentSha256: string | null;
}

const EQUIPMENT_CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function withEquipmentContentIdentity(
  url: string,
  contentSha256: string | undefined,
): { url: string; contentSha256: string | null } {
  if (
    typeof contentSha256 !== "string" ||
    !EQUIPMENT_CONTENT_SHA256_PATTERN.test(contentSha256)
  ) {
    return { url, contentSha256: null };
  }
  const separator = url.includes("?") ? "&" : "?";
  return {
    url: `${url}${separator}sha256=${contentSha256}`,
    contentSha256,
  };
}

export interface EquipmentVisualStore {
  [slot: string]: THREE.Object3D | undefined;
}

export interface HeldEquipmentVisualState {
  emote?: unknown;
  abbreviatedEmote?: unknown;
  deathState?: unknown;
}

/**
 * Held rigid equipment is intentionally hidden while the death and two-hand
 * victory poses play. Those clips put the wrist in the ground or above the
 * face, so keeping long weapons attached produces obvious penetration. Armor
 * remains visible; only hand-held visuals use this policy.
 */
export function shouldRenderHeldEquipmentVisual(
  state: HeldEquipmentVisualState,
): boolean {
  return !(
    state.deathState === "dying" ||
    state.deathState === "dead" ||
    state.emote === "death" ||
    state.abbreviatedEmote === "death" ||
    state.emote === "victory" ||
    state.abbreviatedEmote === "victory"
  );
}

export type StreamingEquipmentVisualValidationReason =
  | "missing_skinned_mesh"
  | "invalid_skinned_mesh"
  | "incompatible_skeleton"
  | "missing_fitted_attachment"
  | "invalid_fitted_attachment"
  | "invalid_attachment_bone"
  | "missing_fit_metadata"
  | "invalid_fit_metadata"
  | "fit_item_mismatch"
  | "fit_slot_mismatch"
  | "incompatible_avatar"
  | "invalid_dynamic_bow_string"
  | "invalid_stable_held_pose"
  | "invalid_two_hand_grip"
  | "invalid_grip_contact"
  | "unsupported_visible_slot";

export type StreamingEquipmentVisualValidation =
  | { valid: true; reason: null }
  | { valid: false; reason: StreamingEquipmentVisualValidationReason };

const COMPETITIVE_ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const RIG_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

function finiteVector3(value: unknown): value is [number, number, number] {
  return Boolean(
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (component) =>
        typeof component === "number" && Number.isFinite(component),
    ),
  );
}

export function hasValidDynamicBowString(
  root: THREE.Object3D,
  attachmentData: EquipmentAttachmentData | undefined,
): boolean {
  const bowString = attachmentData?.bowString;
  return Boolean(
    bowString?.schemaVersion === 1 &&
    typeof bowString.contentNodeName === "string" &&
    bowString.contentNodeName.length > 0 &&
    finiteVector3(bowString.upperTip) &&
    finiteVector3(bowString.lowerTip) &&
    finiteVector3(bowString.restNock) &&
    (bowString.drawHandLocalOffset === undefined ||
      finiteVector3(bowString.drawHandLocalOffset)) &&
    root.getObjectByName(bowString.contentNodeName),
  );
}

export function hasValidStableHeldPose(
  root: THREE.Object3D,
  attachmentData: EquipmentAttachmentData | undefined,
): boolean {
  const stablePose = attachmentData?.stableHeldPose;
  return Boolean(
    stablePose?.schemaVersion === 1 &&
    typeof stablePose.wrapperNodeName === "string" &&
    stablePose.wrapperNodeName.length > 0 &&
    finiteVector3(stablePose.avatarLocalEulerDegrees) &&
    stablePose.avatarLocalEulerDegrees.every(
      (degrees) => Math.abs(degrees) <= 180,
    ) &&
    (stablePose.primaryBoneLocalOffset === undefined ||
      finiteVector3(stablePose.primaryBoneLocalOffset)) &&
    (stablePose.avatarLocalPositionOffset === undefined ||
      (finiteVector3(stablePose.avatarLocalPositionOffset) &&
        Math.hypot(...stablePose.avatarLocalPositionOffset) <= 0.5)) &&
    root.getObjectByName(stablePose.wrapperNodeName),
  );
}

export function hasValidTwoHandGrip(
  root: THREE.Object3D,
  attachmentData: EquipmentAttachmentData | undefined,
): boolean {
  const grip = attachmentData?.twoHandGrip;
  return Boolean(
    grip?.schemaVersion === 1 &&
    typeof grip.wrapperNodeName === "string" &&
    grip.wrapperNodeName.length > 0 &&
    finiteVector3(grip.sourceHandleAxis) &&
    new THREE.Vector3(...grip.sourceHandleAxis).lengthSq() > 1e-8 &&
    (grip.secondaryBoneName === "leftHand" ||
      grip.secondaryBoneName === "rightHand") &&
    (grip.secondaryBoneLocalOffset === undefined ||
      finiteVector3(grip.secondaryBoneLocalOffset)) &&
    grip.secondaryBoneName !== attachmentData?.vrmBoneName &&
    root.getObjectByName(grip.wrapperNodeName),
  );
}

export function hasValidEquipmentGripContact(
  root: THREE.Object3D,
  attachmentData: EquipmentAttachmentData | undefined,
): boolean {
  const contact = attachmentData?.gripContact;
  if (
    contact?.schemaVersion !== 1 ||
    typeof contact.contentNodeName !== "string" ||
    contact.contentNodeName.length === 0 ||
    !finiteVector3(contact.sourceAxis) ||
    new THREE.Vector3(...contact.sourceAxis).lengthSq() <= 1e-8 ||
    !["minimum", "maximum", "dynamic-aim"].includes(contact.actionEnd) ||
    !Array.isArray(contact.zones) ||
    contact.zones.length < 1 ||
    contact.zones.length > 2 ||
    !root.getObjectByName(contact.contentNodeName)
  ) {
    return false;
  }
  const ids = new Set<string>();
  const bones = new Set<string>();
  for (const zone of contact.zones) {
    if (
      (zone.id !== "primary" && zone.id !== "secondary") ||
      ids.has(zone.id) ||
      (zone.boneName !== "leftHand" && zone.boneName !== "rightHand") ||
      bones.has(zone.boneName) ||
      !Number.isFinite(zone.minimumSourceProjection) ||
      !Number.isFinite(zone.maximumSourceProjection) ||
      zone.minimumSourceProjection >= zone.maximumSourceProjection
    ) {
      return false;
    }
    ids.add(zone.id);
    bones.add(zone.boneName);
  }
  return ids.has("primary");
}

// Ownership is deliberately outside userData: Object3D.clone must not inherit
// another instance's disposal rights. Geometry, textures and skeletons remain
// owned by their asset cache/avatar, not by these per-instance material sets.
const equipmentMaterialOwners = new WeakMap<
  THREE.Object3D,
  Set<THREE.Material>
>();

/** Borrowed, renderer-owned lighting. Omission retains the legacy policy. */
export type EquipmentVisualLighting = {
  mode: "authored-pbr";
  environmentMap: THREE.Texture;
  intensity: number;
};

// Keep the authored values even after legacy attachment zeroes metalness.
// A clone of held gear inherits this baseline, but not its disposal rights.
const equipmentAuthoredLighting = new WeakMap<
  THREE.Material,
  { metalness: number; envMap: THREE.Texture | null; envMapIntensity: number }
>();
const equipmentLightingCacheKeys = new WeakMap<
  THREE.Material,
  { original: PropertyDescriptor | undefined; installed: () => string }
>();

export function isolateEquipmentVisualMaterials(root: THREE.Object3D): void {
  if (equipmentMaterialOwners.has(root)) return;
  const copies = new Map<THREE.Material, THREE.Material>();
  const assignments: Array<{
    object: THREE.Object3D & {
      material: THREE.Material | THREE.Material[];
    };
    material: THREE.Material | THREE.Material[];
  }> = [];
  const copy = (source: THREE.Material): THREE.Material => {
    let material = copies.get(source);
    if (!material) {
      material = source.clone();
      copies.set(source, material);
      if ("metalness" in source) {
        const standard = source as THREE.MeshStandardMaterial;
        equipmentAuthoredLighting.set(material, {
          ...(equipmentAuthoredLighting.get(source) ?? {
            metalness: standard.metalness,
            envMap: standard.envMap,
            envMapIntensity: standard.envMapIntensity,
          }),
        });
      }
    }
    return material;
  };
  try {
    root.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Line ||
        object instanceof THREE.Points ||
        object instanceof THREE.Sprite
      ) {
        assignments.push({
          object,
          material: Array.isArray(object.material)
            ? object.material.map(copy)
            : copy(object.material),
        });
      }
    });
  } catch (error) {
    // Do not leave half-replaced materials if a custom material cannot clone.
    for (const material of copies.values()) material.dispose();
    throw error;
  }
  for (const { object, material } of assignments) object.material = material;
  equipmentMaterialOwners.set(root, new Set(copies.values()));
}

export function cloneEquipmentVisualModel(
  template: THREE.Object3D,
): THREE.Object3D {
  const clone = template.clone(true);
  isolateEquipmentVisualMaterials(clone);
  return clone;
}

export function disposeEquipmentVisualMaterials(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  // A fitted attachment can add a wrapper above the owning model root.
  root.traverse((object) => {
    const owned = equipmentMaterialOwners.get(object);
    if (!owned) return;
    equipmentMaterialOwners.delete(object);
    for (const material of owned) materials.add(material);
  });
  const errors: unknown[] = [];
  for (const material of materials) {
    try {
      material.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Equipment material disposal failed");
  }
}

export function removeEquipmentVisual(
  store: EquipmentVisualStore,
  slot: string,
): void {
  const slotKey = slot.toLowerCase();
  const existingVisual = store[slotKey];
  store[slotKey] = undefined;

  if (existingVisual?.parent) {
    existingVisual.parent.remove(existingVisual);
  }
  if (existingVisual) disposeEquipmentVisualMaterials(existingVisual);
}

function removeReplacedEquipmentVisual(
  store: EquipmentVisualStore,
  slot: string,
  incoming: THREE.Object3D,
): void {
  const previous = store[slot.toLowerCase()];
  // Reattaching an already owned model must not dispose its live materials.
  if (previous === incoming) {
    incoming.removeFromParent();
    store[slot.toLowerCase()] = undefined;
    return;
  }
  for (let parent = incoming.parent; parent; parent = parent.parent) {
    if (parent === previous) {
      incoming.removeFromParent();
      break;
    }
  }
  removeEquipmentVisual(store, slot);
}

export function extractEquipmentAttachmentData(
  root: THREE.Object3D,
): EquipmentAttachmentData | undefined {
  const rootAttachment = root.userData.hyperia as
    EquipmentAttachmentData | undefined;

  if (rootAttachment) {
    return rootAttachment;
  }

  return root.children[0]?.userData?.hyperia as
    EquipmentAttachmentData | undefined;
}

export function extractFishingWorldVisualPlacement(
  root: THREE.Object3D,
  itemId: string,
): FishingWorldVisualPlacement | null {
  const metadata = extractEquipmentAttachmentData(root)?.fishingWorld;
  const placement = metadata?.placement;
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.itemId !== itemId ||
    !placement ||
    !finiteVector3(placement.positionOffset) ||
    !finiteVector3(placement.rotationEulerDegrees) ||
    placement.rotationEulerDegrees.some((degrees) => Math.abs(degrees) > 360) ||
    typeof placement.scale !== "number" ||
    !Number.isFinite(placement.scale) ||
    placement.scale <= 0 ||
    placement.scale > 10
  ) {
    return null;
  }
  return {
    positionOffset: [...placement.positionOffset],
    rotationEulerDegrees: [...placement.rotationEulerDegrees],
    scale: placement.scale,
  };
}

export function resolveEquipmentVisualUrls(options: {
  assetsUrl: string;
  itemId: string;
  slot: string;
  avatarId?: string | null;
  requireAvatarSpecificFit?: boolean;
  itemData?: EquipmentVisualModelData | null;
  fallbackItemData?: EquipmentVisualModelData | null;
}): EquipmentVisualUrlResolution | null {
  const {
    assetsUrl,
    itemId,
    slot,
    avatarId,
    requireAvatarSpecificFit = false,
    itemData,
    fallbackItemData,
  } = options;

  const isGatheringTool = slot.toLowerCase() === "gatheringtool";
  const gatheringModelPaths = isGatheringTool
    ? itemData?.gatheringModelPathsByAvatar
    : undefined;
  const gatheringModelHashes = isGatheringTool
    ? itemData?.gatheringModelSha256ByAvatar
    : undefined;
  let equippedModelPath: string | null | undefined = avatarId
    ? gatheringModelPaths?.[avatarId]
    : undefined;
  let equippedModelSha256: string | undefined = avatarId
    ? gatheringModelHashes?.[avatarId]
    : undefined;
  if (
    gatheringModelPaths !== undefined &&
    avatarId &&
    requireAvatarSpecificFit &&
    equippedModelPath === undefined
  ) {
    return null;
  }
  if (equippedModelPath === undefined && avatarId) {
    equippedModelPath = itemData?.equippedModelPathsByAvatar?.[avatarId];
    equippedModelSha256 = itemData?.equippedModelSha256ByAvatar?.[avatarId];
  }
  if (equippedModelPath === undefined) {
    equippedModelPath = itemData?.equippedModelPath;
    equippedModelSha256 = itemData?.equippedModelSha256;
  }
  let modelPath = itemData?.modelPath;

  if (equippedModelPath === null) {
    return null;
  }

  if (!equippedModelPath) {
    const gatheringSpecificFallback =
      isGatheringTool && avatarId
        ? fallbackItemData?.gatheringModelPathsByAvatar?.[avatarId]
        : undefined;
    const avatarSpecificFallback =
      gatheringSpecificFallback ??
      (avatarId
        ? fallbackItemData?.equippedModelPathsByAvatar?.[avatarId]
        : undefined);
    if (avatarSpecificFallback) {
      equippedModelPath = avatarSpecificFallback;
      equippedModelSha256 =
        (isGatheringTool && avatarId
          ? fallbackItemData?.gatheringModelSha256ByAvatar?.[avatarId]
          : undefined) ??
        (avatarId
          ? fallbackItemData?.equippedModelSha256ByAvatar?.[avatarId]
          : undefined);
    } else if (fallbackItemData?.equippedModelPath) {
      equippedModelPath = fallbackItemData.equippedModelPath;
      equippedModelSha256 = fallbackItemData.equippedModelSha256;
    }
    if (!modelPath && fallbackItemData?.modelPath) {
      modelPath = fallbackItemData.modelPath;
    }
  }

  if (equippedModelPath) {
    const resolved = withEquipmentContentIdentity(
      equippedModelPath.replace("asset://", `${assetsUrl}/`),
      equippedModelSha256,
    );
    return {
      primaryUrl: resolved.url,
      fallbackUrl: null,
      contentSha256: resolved.contentSha256,
    };
  }

  if (modelPath && typeof modelPath === "string") {
    return {
      primaryUrl: modelPath.replace("asset://", `${assetsUrl}/`),
      fallbackUrl: null,
      contentSha256: null,
    };
  }

  const parts = itemId.split("_");
  let assetId = itemId.replace(/_/g, "-");
  let category = "";

  const materials = [
    "bronze",
    "steel",
    "mithril",
    "iron",
    "rune",
    "dragon",
    "wood",
    "oak",
    "willow",
    "yew",
  ];

  const categoryMap: Record<string, string> = {
    sword: "swords-old",
    longsword: "swords/long-swords",
    scimitar: "swords/scimitars",
    "2h_sword": "swords/2h-swords",
    "2h": "swords/2h-swords",
    shortsword: "swords/shortswords",
    dagger: "swords/daggers",
    hatchet: "hatchets",
    pickaxe: "pickaxes",
    arrow: "arrows",
    bow: "bows",
    staff: "magic-staffs",
    shield: "shields",
  };

  if (parts.length >= 2 && materials.includes(parts[0])) {
    const material = parts[0];
    const itemParts = parts.slice(1);
    const itemKey = itemParts.join("_");
    assetId = `${itemParts.join("-")}-${material}`;
    category = categoryMap[itemKey] || categoryMap[itemParts[0]] || "";
  }

  if (!category) {
    return null;
  }

  const prefix = `${category}/`;
  return {
    primaryUrl: `${assetsUrl}/models/${prefix}${assetId}-aligned.glb`,
    fallbackUrl: `${assetsUrl}/models/${prefix}${assetId}/${assetId}-aligned.glb`,
    contentSha256: null,
  };
}

export function resolveEquipmentVisualData(options: {
  itemId: string;
  fallbackItemData?: EquipmentVisualModelData | null;
}): EquipmentVisualModelData | null {
  const itemData = getItem(options.itemId);

  if (itemData) {
    return {
      equippedModelPath: itemData.equippedModelPath,
      equippedModelSha256: itemData.equippedModelSha256,
      equippedModelPathsByAvatar: itemData.equippedModelPathsByAvatar,
      equippedModelSha256ByAvatar: itemData.equippedModelSha256ByAvatar,
      gatheringModelPathsByAvatar: itemData.gatheringModelPathsByAvatar,
      gatheringModelSha256ByAvatar: itemData.gatheringModelSha256ByAvatar,
      modelPath: itemData.modelPath,
    };
  }

  return options.fallbackItemData ?? null;
}

/**
 * Legacy worlds have no global IBL. Authored PBR is opt-in with a borrowed
 * per-material environment; never change the global sky/water environment.
 */
function applyEquipmentLighting(
  mesh: THREE.Mesh,
  lighting: EquipmentVisualLighting | undefined,
): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    const authored = equipmentAuthoredLighting.get(mat);
    if (!authored) continue;
    const standard = mat as THREE.MeshStandardMaterial;
    const cacheKey = equipmentLightingCacheKeys.get(mat);
    let policyChanged = false;
    if (lighting && !cacheKey) {
      const originalKey = mat.customProgramCacheKey;
      const original = Object.getOwnPropertyDescriptor(
        mat,
        "customProgramCacheKey",
      );
      const installed = function (this: THREE.Material) {
        const environment = (this as THREE.MeshStandardMaterial).envMap;
        return `${originalKey.call(this)}:equipment-env:${environment?.uuid ?? "none"}`;
      };
      Object.defineProperty(mat, "customProgramCacheKey", {
        value: installed,
        configurable: true,
        writable: true,
        enumerable: original?.enumerable ?? true,
      });
      equipmentLightingCacheKeys.set(mat, { original, installed });
      policyChanged = true;
    } else if (!lighting && cacheKey) {
      // WebGPU also includes enumerable own properties in its cache key.
      // Restore the descriptor/property set, not just the callback's result.
      if (cacheKey.original) {
        Object.defineProperty(mat, "customProgramCacheKey", cacheKey.original);
      } else {
        Reflect.deleteProperty(mat, "customProgramCacheKey");
      }
      equipmentLightingCacheKeys.delete(mat);
      policyChanged = true;
    }
    const envMap = lighting?.environmentMap ?? authored.envMap;
    const changed = standard.envMap !== envMap;
    standard.metalness = lighting ? authored.metalness : 0;
    standard.envMap = envMap;
    standard.envMapIntensity = lighting?.intensity ?? authored.envMapIntensity;
    // WebGPU caches the environment node at shader setup, including its map.
    if (changed || policyChanged) standard.needsUpdate = true;
  }
}

function hasUsableEquipmentLighting(
  root: THREE.Object3D,
  lighting: EquipmentVisualLighting | undefined,
): boolean {
  if (
    lighting &&
    (lighting.mode !== "authored-pbr" ||
      !lighting.environmentMap?.isTexture ||
      !Number.isFinite(lighting.intensity) ||
      lighting.intensity < 0)
  )
    return false;
  let usable = true;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    for (const material of [child.material].flat()) {
      const cacheKey = equipmentLightingCacheKeys.get(material);
      const descriptor = Object.getOwnPropertyDescriptor(
        material,
        "customProgramCacheKey",
      );
      if (cacheKey) {
        // Do not clobber a callback independently replaced by another owner.
        if (
          descriptor?.value !== cacheKey.installed ||
          !descriptor.configurable
        )
          usable = false;
      } else if (
        lighting &&
        (typeof material.customProgramCacheKey !== "function" ||
          (descriptor
            ? !descriptor.configurable
            : !Object.isExtensible(material)))
      )
        usable = false;
      if (!lighting) continue;
      const standard =
        ("isMeshStandardMaterial" in material &&
          material.isMeshStandardMaterial === true) ||
        ("isMeshStandardNodeMaterial" in material &&
          material.isMeshStandardNodeMaterial === true);
      if (!standard) usable = false;
      // A custom environment node wins over envMap. Reject instead of silently
      // claiming that a caller-supplied environment is being used.
      if ("envNode" in material && material.envNode != null) usable = false;
    }
  });
  return usable;
}

function hasSkinnedMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) {
      found = true;
    }
  });
  return found;
}

function getSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) meshes.push(child);
  });
  return meshes;
}

function hasUsableSkinningData(mesh: THREE.SkinnedMesh): boolean {
  const position = mesh.geometry.getAttribute("position");
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  return Boolean(
    position?.count &&
    skinIndex?.count === position.count &&
    skinWeight?.count === position.count &&
    mesh.skeleton.bones.length > 0 &&
    mesh.skeleton.boneInverses.length === mesh.skeleton.bones.length,
  );
}

function boneParentName(bone: THREE.Bone): string | null {
  return bone.parent instanceof THREE.Bone ? bone.parent.name : null;
}

function matricesApproximatelyEqual(
  left: THREE.Matrix4,
  right: THREE.Matrix4,
  tolerance = 0.001,
): boolean {
  return left.elements.every(
    (value, index) => Math.abs(value - right.elements[index]) <= tolerance,
  );
}

/**
 * A skinned armor export is reusable only when it was bound to the same
 * ordered skeleton and inverse bind pose as the live avatar. Replacing its
 * skeleton without this check can load successfully while deforming or
 * exploding as soon as an animation begins.
 */
export function isSkinnedEquipmentSkeletonCompatible(
  root: THREE.Object3D,
  vrm: VRM,
): boolean {
  const playerSkeleton = getPlayerSkeleton(vrm);
  if (!playerSkeleton) return false;

  return getSkinnedMeshes(root).every((mesh) => {
    const sourceSkeleton = mesh.skeleton;
    if (
      sourceSkeleton.bones.length !== playerSkeleton.bones.length ||
      sourceSkeleton.boneInverses.length !== playerSkeleton.boneInverses.length
    ) {
      return false;
    }

    return sourceSkeleton.bones.every((bone, index) => {
      const targetBone = playerSkeleton.bones[index];
      return (
        bone.name === targetBone.name &&
        boneParentName(bone) === boneParentName(targetBone) &&
        matricesApproximatelyEqual(
          sourceSkeleton.boneInverses[index],
          playerSkeleton.boneInverses[index],
        )
      );
    });
  });
}

function hasValidAttachmentMatrix(
  attachmentData: EquipmentAttachmentData | undefined,
): attachmentData is EquipmentAttachmentData & {
  version: 2;
  relativeMatrix: number[];
} {
  return Boolean(
    attachmentData?.version === 2 &&
    Array.isArray(attachmentData.relativeMatrix) &&
    attachmentData.relativeMatrix.length === 16 &&
    attachmentData.relativeMatrix.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
  );
}

/**
 * Validate the structural contract needed for a truthful competitive avatar.
 * Loading an arbitrary GLB is insufficient: deforming equipment needs skin
 * weights, while rigid equipment needs an authored v2 bone attachment.
 */
export function validateStreamingEquipmentVisualModel(
  root: THREE.Object3D,
  slot: string,
  options: {
    itemId?: string;
    avatarId?: string;
    vrm?: VRM;
  } = {},
): StreamingEquipmentVisualValidation {
  const slotKey = slot.toLowerCase();
  const attachmentData = extractEquipmentAttachmentData(root);
  const fit = attachmentData?.duelFit;
  if (!fit) {
    return { valid: false, reason: "missing_fit_metadata" };
  }
  if (
    fit.schemaVersion !== 1 ||
    typeof fit.itemId !== "string" ||
    fit.itemId !== fit.itemId.trim() ||
    !COMPETITIVE_ASSET_ID_PATTERN.test(fit.itemId) ||
    typeof fit.slot !== "string" ||
    fit.slot !== slotKey ||
    !COMPETITIVE_ASSET_ID_PATTERN.test(fit.slot) ||
    !Array.isArray(fit.compatibleAvatarIds) ||
    fit.compatibleAvatarIds.length === 0 ||
    fit.compatibleAvatarIds.some(
      (avatarId) =>
        typeof avatarId !== "string" ||
        avatarId !== avatarId.trim() ||
        !COMPETITIVE_ASSET_ID_PATTERN.test(avatarId),
    ) ||
    new Set(fit.compatibleAvatarIds).size !== fit.compatibleAvatarIds.length
  ) {
    return { valid: false, reason: "invalid_fit_metadata" };
  }
  if (options.itemId && fit.itemId !== options.itemId) {
    return { valid: false, reason: "fit_item_mismatch" };
  }
  if (fit.slot.toLowerCase() !== slotKey) {
    return { valid: false, reason: "fit_slot_mismatch" };
  }
  if (options.avatarId && !fit.compatibleAvatarIds.includes(options.avatarId)) {
    return { valid: false, reason: "incompatible_avatar" };
  }

  const usesDeformingSkin =
    ["body", "legs", "boots", "gloves", "cape"].includes(slotKey) ||
    (slotKey === "helmet" && hasSkinnedMesh(root));
  if (usesDeformingSkin) {
    if (!hasSkinnedMesh(root)) {
      return { valid: false, reason: "missing_skinned_mesh" };
    }
    if (
      typeof fit.rigFingerprint !== "string" ||
      !RIG_FINGERPRINT_PATTERN.test(fit.rigFingerprint) ||
      !getSkinnedMeshes(root).every(hasUsableSkinningData)
    ) {
      return { valid: false, reason: "invalid_skinned_mesh" };
    }
    if (
      options.vrm &&
      !isSkinnedEquipmentSkeletonCompatible(root, options.vrm)
    ) {
      return { valid: false, reason: "incompatible_skeleton" };
    }
    return { valid: true, reason: null };
  }

  const allowedBones =
    slotKey === "weapon" || slotKey === "gatheringtool"
      ? new Set(["leftHand", "rightHand"])
      : slotKey === "shield"
        ? new Set(["leftHand"])
        : slotKey === "helmet"
          ? new Set(["head"])
          : null;
  if (!allowedBones) {
    return { valid: false, reason: "unsupported_visible_slot" };
  }

  if (!attachmentData) {
    return { valid: false, reason: "missing_fitted_attachment" };
  }
  if (!hasValidAttachmentMatrix(attachmentData)) {
    return { valid: false, reason: "invalid_fitted_attachment" };
  }
  if (!allowedBones.has(attachmentData.vrmBoneName)) {
    return { valid: false, reason: "invalid_attachment_bone" };
  }
  if (
    attachmentData.weaponType?.toLowerCase() === "bow" &&
    !hasValidDynamicBowString(root, attachmentData)
  ) {
    return { valid: false, reason: "invalid_dynamic_bow_string" };
  }
  if (
    (attachmentData.stableHeldPose !== undefined ||
      attachmentData.weaponType?.toLowerCase() === "staff") &&
    !hasValidStableHeldPose(root, attachmentData)
  ) {
    return { valid: false, reason: "invalid_stable_held_pose" };
  }
  if (
    (attachmentData.twoHandGrip !== undefined ||
      attachmentData.weaponType?.toLowerCase() === "harpoon") &&
    !hasValidTwoHandGrip(root, attachmentData)
  ) {
    return { valid: false, reason: "invalid_two_hand_grip" };
  }
  if (
    attachmentData.gripContact !== undefined &&
    !hasValidEquipmentGripContact(root, attachmentData)
  ) {
    return { valid: false, reason: "invalid_grip_contact" };
  }
  return { valid: true, reason: null };
}

export interface StableHeldEquipmentPoseController {
  wrapper: THREE.Object3D;
  update(): void;
  dispose(): void;
}

export interface TwoHandEquipmentGripController {
  wrapper: THREE.Object3D;
  update(): void;
  dispose(): void;
}

/**
 * Keep a rigid handle aligned between the primary attachment and the animated
 * off hand. The primary grip position remains fixed; only the fitted wrapper's
 * orientation is corrected, using its authored orientation as the roll basis.
 */
export function createTwoHandEquipmentGripController(options: {
  modelRoot: THREE.Object3D;
  vrm: VRM;
  avatarRoot?: THREE.Object3D;
}): TwoHandEquipmentGripController | null {
  const attachmentData = extractEquipmentAttachmentData(options.modelRoot);
  const grip = attachmentData?.twoHandGrip;
  if (!grip || !hasValidTwoHandGrip(options.modelRoot, attachmentData)) {
    return null;
  }
  const wrapper = options.modelRoot.getObjectByName(grip.wrapperNodeName)!;
  const secondaryHand = options.vrm.humanoid.getRawBoneNode(
    grip.secondaryBoneName,
  );
  if (!secondaryHand) return null;
  const avatarRoot = options.avatarRoot ?? options.vrm.scene;
  const originalQuaternion = wrapper.quaternion.clone();
  const sourceAxis = new THREE.Vector3(...grip.sourceHandleAxis).normalize();
  const wrapperPosition = new THREE.Vector3();
  const secondaryPosition = new THREE.Vector3();
  const secondaryLocalOffset = grip.secondaryBoneLocalOffset
    ? new THREE.Vector3(...grip.secondaryBoneLocalOffset)
    : null;
  const desiredAxis = new THREE.Vector3();
  const currentAxis = new THREE.Vector3();
  const parentWorldQuaternion = new THREE.Quaternion();
  const baseWorldQuaternion = new THREE.Quaternion();
  const correction = new THREE.Quaternion();
  const desiredWorldQuaternion = new THREE.Quaternion();

  const update = () => {
    const parent = wrapper.parent;
    if (!parent) return;
    avatarRoot.updateWorldMatrix(true, true);
    parent.getWorldQuaternion(parentWorldQuaternion);
    wrapper.getWorldPosition(wrapperPosition);
    if (secondaryLocalOffset) {
      secondaryPosition.copy(secondaryLocalOffset);
      secondaryHand.localToWorld(secondaryPosition);
    } else {
      secondaryHand.getWorldPosition(secondaryPosition);
    }
    desiredAxis.copy(secondaryPosition).sub(wrapperPosition);
    if (desiredAxis.lengthSq() <= 1e-8) return;
    desiredAxis.normalize();
    baseWorldQuaternion
      .copy(parentWorldQuaternion)
      .multiply(originalQuaternion)
      .normalize();
    currentAxis
      .copy(sourceAxis)
      .applyQuaternion(baseWorldQuaternion)
      .normalize();
    correction.setFromUnitVectors(currentAxis, desiredAxis);
    desiredWorldQuaternion
      .copy(correction)
      .multiply(baseWorldQuaternion)
      .normalize();
    wrapper.quaternion
      .copy(parentWorldQuaternion)
      .invert()
      .multiply(desiredWorldQuaternion)
      .normalize();
    wrapper.updateWorldMatrix(false, true);
  };

  const renderHookTargets: THREE.Mesh[] = [];
  options.modelRoot.traverse((object) => {
    if (renderHookTargets.length === 0 && object instanceof THREE.Mesh) {
      renderHookTargets.push(object);
    }
  });
  const renderHookTarget = renderHookTargets[0];
  const originalOnBeforeRender = renderHookTarget?.onBeforeRender;
  const renderHook: THREE.Object3D["onBeforeRender"] = function (
    this: THREE.Object3D,
    ...args
  ) {
    update();
    originalOnBeforeRender?.apply(this, args);
  };
  if (renderHookTarget) renderHookTarget.onBeforeRender = renderHook;
  update();

  return {
    wrapper,
    update,
    dispose: () => {
      if (renderHookTarget?.onBeforeRender === renderHook) {
        renderHookTarget.onBeforeRender = originalOnBeforeRender ?? (() => {});
      }
      wrapper.quaternion.copy(originalQuaternion);
      wrapper.updateWorldMatrix(false, true);
    },
  };
}

/**
 * Keep a long rigid weapon at an authored avatar-local orientation while its
 * fitted grip continues to follow the animated hand. This cancels wrist roll
 * without changing the certified attachment position or the avatar animation.
 */
export function createStableHeldEquipmentPoseController(options: {
  modelRoot: THREE.Object3D;
  vrm: VRM;
  avatarRoot?: THREE.Object3D;
}): StableHeldEquipmentPoseController | null {
  const attachmentData = extractEquipmentAttachmentData(options.modelRoot);
  const stablePose = attachmentData?.stableHeldPose;
  if (
    !stablePose ||
    !hasValidStableHeldPose(options.modelRoot, attachmentData)
  ) {
    return null;
  }
  const wrapper = options.modelRoot.getObjectByName(
    stablePose.wrapperNodeName,
  )!;
  const avatarRoot = options.avatarRoot ?? options.vrm.scene;
  const originalQuaternion = wrapper.quaternion.clone();
  const originalPosition = wrapper.position.clone();
  const primaryBoneLocalOffset = stablePose.primaryBoneLocalOffset
    ? new THREE.Vector3(...stablePose.primaryBoneLocalOffset)
    : null;
  const attachmentBoneName = attachmentData?.vrmBoneName;
  const primaryBone = primaryBoneLocalOffset
    ? attachmentBoneName === "leftHand" || attachmentBoneName === "rightHand"
      ? options.vrm.humanoid.getRawBoneNode(
          attachmentBoneName as VRMHumanBoneName,
        )
      : null
    : null;
  if (primaryBoneLocalOffset && !primaryBone) return null;
  const desiredAvatarQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      ...(stablePose.avatarLocalEulerDegrees.map(THREE.MathUtils.degToRad) as [
        number,
        number,
        number,
      ]),
      "XYZ",
    ),
  );
  const avatarWorldQuaternion = new THREE.Quaternion();
  const parentWorldQuaternion = new THREE.Quaternion();
  const desiredWorldQuaternion = new THREE.Quaternion();
  const desiredWorldPosition = new THREE.Vector3();
  const avatarLocalPositionOffset = stablePose.avatarLocalPositionOffset
    ? new THREE.Vector3(...stablePose.avatarLocalPositionOffset)
    : null;
  const worldPositionOffset = new THREE.Vector3();

  const update = () => {
    const parent = wrapper.parent;
    if (!parent) return;
    avatarRoot.updateWorldMatrix(true, false);
    parent.updateWorldMatrix(true, false);
    avatarRoot.getWorldQuaternion(avatarWorldQuaternion);
    parent.getWorldQuaternion(parentWorldQuaternion);
    if (primaryBoneLocalOffset && primaryBone) {
      desiredWorldPosition.copy(primaryBoneLocalOffset);
      primaryBone.localToWorld(desiredWorldPosition);
      if (avatarLocalPositionOffset) {
        worldPositionOffset
          .copy(avatarLocalPositionOffset)
          .applyQuaternion(avatarWorldQuaternion);
        desiredWorldPosition.add(worldPositionOffset);
      }
      parent.worldToLocal(desiredWorldPosition);
      wrapper.position.copy(desiredWorldPosition);
    }
    desiredWorldQuaternion
      .copy(avatarWorldQuaternion)
      .multiply(desiredAvatarQuaternion);
    wrapper.quaternion
      .copy(parentWorldQuaternion)
      .invert()
      .multiply(desiredWorldQuaternion)
      .normalize();
    wrapper.updateWorldMatrix(false, true);
  };

  const renderHookTargets: THREE.Mesh[] = [];
  options.modelRoot.traverse((object) => {
    if (renderHookTargets.length === 0 && object instanceof THREE.Mesh) {
      renderHookTargets.push(object);
    }
  });
  const renderHookTarget = renderHookTargets[0];
  const originalOnBeforeRender = renderHookTarget?.onBeforeRender;
  const renderHook: THREE.Object3D["onBeforeRender"] = function (
    this: THREE.Object3D,
    ...args
  ) {
    update();
    originalOnBeforeRender?.apply(this, args);
  };
  if (renderHookTarget) renderHookTarget.onBeforeRender = renderHook;
  update();

  return {
    wrapper,
    update,
    dispose: () => {
      if (renderHookTarget?.onBeforeRender === renderHook) {
        renderHookTarget.onBeforeRender = originalOnBeforeRender ?? (() => {});
      }
      wrapper.quaternion.copy(originalQuaternion);
      wrapper.position.copy(originalPosition);
      wrapper.updateWorldMatrix(false, true);
    },
  };
}

export interface DynamicBowStringController {
  line: THREE.Line;
  nockedArrow: THREE.Group;
  scheduleRelease(
    delayMs: number,
    arrowId?: string,
    networkEventId?: string,
  ): boolean;
  /** Release only the exact committed launch, even if its local timer is early. */
  releaseNow(networkEventId: string): boolean;
  /** Cancel only the matching committed launch when an identity is supplied. */
  cancelRelease(networkEventId?: string): boolean;
  update(): void;
  dispose(): void;
}

export type DynamicBowStringTransition =
  | {
      kind: "scheduled";
      performanceTimeMs: number;
      releaseAtPerformanceTimeMs: number;
      networkEventId: string | null;
    }
  | {
      kind: "released";
      performanceTimeMs: number;
      lastVisibleNockWorldPosition: [number, number, number] | null;
      drawHandWorldPosition: [number, number, number];
      networkEventId: string | null;
    }
  | {
      kind: "cancelled";
      performanceTimeMs: number;
      networkEventId: string | null;
    };

/**
 * Rebuild a bowstring from the frozen fitted tip points and move only its nock
 * to the fitted anchor inside the rendered draw hand. `onBeforeRender` keeps
 * it synchronized after the avatar mixer updates, without adding a frame of
 * visible lag.
 */
export function createDynamicBowStringController(options: {
  modelRoot: THREE.Object3D;
  vrm: VRM;
  getState: () => HeldEquipmentVisualState;
  now?: () => number;
  onTransition?: (transition: DynamicBowStringTransition) => void;
}): DynamicBowStringController | null {
  const attachmentData = extractEquipmentAttachmentData(options.modelRoot);
  const bowString = attachmentData?.bowString;
  if (
    !bowString ||
    !hasValidDynamicBowString(options.modelRoot, attachmentData)
  ) {
    return null;
  }
  const content = options.modelRoot.getObjectByName(bowString.contentNodeName)!;
  const drawHand = options.vrm.humanoid?.getRawBoneNode("rightHand");
  if (!drawHand) return null;

  const positions = new Float32Array(9);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0x3a271d,
    toneMapped: true,
  });
  const line = new THREE.Line(geometry, material);
  line.name = "DynamicBowString";
  line.frustumCulled = false;
  line.renderOrder = 102;

  const arrowVisual = createArrowVisualInstance(getArrowVisual("default"));
  const nockedArrow = arrowVisual.group;
  nockedArrow.name = "NockedArrow";
  nockedArrow.visible = false;
  const arrowParent = options.vrm.scene ?? options.modelRoot;
  arrowParent.add(nockedArrow);

  const upper = new THREE.Vector3(
    ...(bowString.upperTip as [number, number, number]),
  );
  const lower = new THREE.Vector3(
    ...(bowString.lowerTip as [number, number, number]),
  );
  const rest = new THREE.Vector3(
    ...(bowString.restNock as [number, number, number]),
  );
  const drawHandLocalOffset = bowString.drawHandLocalOffset
    ? new THREE.Vector3(
        ...(bowString.drawHandLocalOffset as [number, number, number]),
      )
    : new THREE.Vector3();
  const drawWorld = new THREE.Vector3();
  const nock = new THREE.Vector3();
  const restWorld = new THREE.Vector3();
  const drawInAvatar = new THREE.Vector3();
  const restInAvatar = new THREE.Vector3();
  const arrowDirection = new THREE.Vector3();
  const arrowForward = new THREE.Vector3(0, 0, 1);
  const lastVisibleNockWorld = new THREE.Vector3();
  const releaseHandWorld = new THREE.Vector3();
  const now = options.now ?? (() => performance.now());
  let scheduledReleaseAt: number | null = null;
  let scheduledNetworkEventId: string | null = null;
  let scheduledReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let forceReleased = false;
  let wasDrawing = false;
  let hasVisibleNockSample = false;
  let releaseReported = false;

  const readDrawHandWorldPosition = (target: THREE.Vector3): THREE.Vector3 => {
    drawHand.updateWorldMatrix(true, false);
    return target.copy(drawHandLocalOffset).applyMatrix4(drawHand.matrixWorld);
  };

  const emitTransition = (transition: DynamicBowStringTransition): void => {
    try {
      options.onTransition?.(transition);
    } catch {
      // Diagnostics must never interrupt the render-synchronized bow path.
    }
  };

  const isWeaponVisible = (): boolean => {
    let current: THREE.Object3D | null = options.modelRoot;
    while (current && current !== arrowParent) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  };

  const cancelScheduledRelease = (performanceTimeMs: number): void => {
    if (scheduledReleaseTimer) {
      clearTimeout(scheduledReleaseTimer);
      scheduledReleaseTimer = null;
    }
    if (scheduledReleaseAt !== null && !releaseReported) {
      emitTransition({
        kind: "cancelled",
        performanceTimeMs,
        networkEventId: scheduledNetworkEventId,
      });
    }
    scheduledReleaseAt = null;
    scheduledNetworkEventId = null;
  };

  const update = () => {
    const state = options.getState();
    const rawDrawing =
      state.emote === "range" || state.abbreviatedEmote === "range";
    const nowMs = now();
    const releasePending =
      scheduledReleaseAt !== null && releaseReported === false;
    if (!rawDrawing && wasDrawing && !releasePending) {
      scheduledReleaseAt = null;
      scheduledNetworkEventId = null;
      forceReleased = false;
      releaseReported = false;
    } else if (rawDrawing && !wasDrawing && releaseReported) {
      scheduledReleaseAt = null;
      scheduledNetworkEventId = null;
      forceReleased = false;
      releaseReported = false;
    }
    const released =
      forceReleased ||
      (scheduledReleaseAt !== null && nowMs >= scheduledReleaseAt);
    if (released && scheduledReleaseAt !== null && !releaseReported) {
      readDrawHandWorldPosition(releaseHandWorld);
      // The visible nock is constrained to the draw hand by construction.
      // Refresh the retained sample at the authoritative deadline so a timer
      // firing between render hooks cannot report the preceding frame's hand
      // position as the final visible nock.
      lastVisibleNockWorld.copy(releaseHandWorld);
      hasVisibleNockSample = true;
      emitTransition({
        kind: "released",
        performanceTimeMs: nowMs,
        lastVisibleNockWorldPosition: hasVisibleNockSample
          ? [
              lastVisibleNockWorld.x,
              lastVisibleNockWorld.y,
              lastVisibleNockWorld.z,
            ]
          : null,
        drawHandWorldPosition: [
          releaseHandWorld.x,
          releaseHandWorld.y,
          releaseHandWorld.z,
        ],
        networkEventId: scheduledNetworkEventId,
      });
      releaseReported = true;
      forceReleased = true;
      if (scheduledReleaseTimer) {
        clearTimeout(scheduledReleaseTimer);
        scheduledReleaseTimer = null;
      }
    }
    const drawing =
      (rawDrawing || releasePending) &&
      !released &&
      shouldRenderHeldEquipmentVisual(state) &&
      isWeaponVisible();

    if (drawing) {
      readDrawHandWorldPosition(drawWorld);
      content.updateWorldMatrix(true, false);
      nock.copy(drawWorld);
      content.worldToLocal(nock);
    } else {
      nock.copy(rest);
    }
    positions.set(upper.toArray(), 0);
    positions.set(nock.toArray(), 3);
    positions.set(lower.toArray(), 6);
    geometry.getAttribute("position").needsUpdate = true;
    geometry.computeBoundingSphere();

    nockedArrow.visible = false;
    if (drawing) {
      arrowParent.updateWorldMatrix(true, false);
      content.updateWorldMatrix(true, false);
      drawInAvatar.copy(drawWorld);
      arrowParent.worldToLocal(drawInAvatar);
      restWorld.copy(rest);
      content.localToWorld(restWorld);
      restInAvatar.copy(restWorld);
      arrowParent.worldToLocal(restInAvatar);
      arrowDirection.copy(restInAvatar).sub(drawInAvatar);
      if (arrowDirection.lengthSq() > 1e-8) {
        arrowDirection.normalize();
        nockedArrow.position.copy(drawInAvatar);
        nockedArrow.quaternion.setFromUnitVectors(arrowForward, arrowDirection);
        nockedArrow.visible = true;
        nockedArrow.getWorldPosition(lastVisibleNockWorld);
        hasVisibleNockSample = true;
      }
    }
    wasDrawing = rawDrawing;
  };
  const scheduleRelease = (
    delayMs: number,
    arrowId?: string,
    networkEventId?: string,
  ): boolean => {
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      delayMs > 5_000 ||
      (arrowId !== undefined &&
        (typeof arrowId !== "string" || arrowId.length > 128)) ||
      (networkEventId !== undefined &&
        (typeof networkEventId !== "string" ||
          networkEventId.length === 0 ||
          networkEventId.length > 256))
    ) {
      return false;
    }
    if (arrowId) {
      updateArrowVisualColors(arrowVisual, getArrowVisual(arrowId));
    }
    const scheduledAt = now();
    cancelScheduledRelease(scheduledAt);
    scheduledReleaseAt = scheduledAt + delayMs;
    scheduledNetworkEventId = networkEventId ?? null;
    forceReleased = false;
    releaseReported = false;
    emitTransition({
      kind: "scheduled",
      performanceTimeMs: scheduledAt,
      releaseAtPerformanceTimeMs: scheduledReleaseAt,
      networkEventId: scheduledNetworkEventId,
    });
    scheduledReleaseTimer = setTimeout(() => {
      scheduledReleaseTimer = null;
      update();
    }, delayMs);
    update();
    return true;
  };
  const releaseNow = (networkEventId: string): boolean => {
    if (
      typeof networkEventId !== "string" ||
      networkEventId.length === 0 ||
      networkEventId.length > 256 ||
      scheduledReleaseAt === null ||
      releaseReported ||
      scheduledNetworkEventId !== networkEventId
    ) {
      return false;
    }
    if (scheduledReleaseTimer) {
      clearTimeout(scheduledReleaseTimer);
      scheduledReleaseTimer = null;
    }
    // The stable network event identity makes this safe when an authoritative
    // impact overtakes the local animation deadline during main-thread
    // catch-up. `update` samples the rendered hand and emits the normal release
    // transition in this call stack; it does not manufacture a second path.
    forceReleased = true;
    update();
    return releaseReported;
  };
  const cancelRelease = (networkEventId?: string): boolean => {
    if (
      networkEventId !== undefined &&
      (scheduledReleaseAt === null ||
        scheduledNetworkEventId !== networkEventId)
    ) {
      return false;
    }
    const hadPendingRelease =
      scheduledReleaseAt !== null && releaseReported === false;
    cancelScheduledRelease(now());
    forceReleased = true;
    releaseReported = false;
    update();
    return hadPendingRelease;
  };
  const dispose = () => {
    cancelScheduledRelease(now());
    line.removeFromParent();
    line.onBeforeRender = () => undefined;
    nockedArrow.onBeforeRender = () => undefined;
    geometry.dispose();
    material.dispose();
    disposeArrowVisualInstance(arrowVisual);
  };
  line.onBeforeRender = () => update();
  content.add(line);
  update();
  return {
    line,
    nockedArrow,
    scheduleRelease,
    releaseNow,
    cancelRelease,
    update,
    dispose,
  };
}

function getPlayerSkeleton(vrm: VRM): THREE.Skeleton | undefined {
  let playerSkeleton: THREE.Skeleton | undefined;

  vrm.scene.traverse((child) => {
    if (
      !playerSkeleton &&
      child instanceof THREE.SkinnedMesh &&
      child.skeleton
    ) {
      playerSkeleton = child.skeleton;
    }
  });

  return playerSkeleton;
}

function findTargetBone(
  vrm: VRM,
  avatarRoot: THREE.Object3D,
  boneName: string,
): THREE.Object3D | null {
  const prefabBone = vrm.humanoid?.getRawBoneNode(boneName as VRMHumanBoneName);
  if (!prefabBone) {
    return null;
  }

  const targetBoneName = prefabBone.name;
  let targetBone: THREE.Object3D | null = null;

  avatarRoot.traverse((child) => {
    if (!targetBone && child.name === targetBoneName) {
      targetBone = child;
    }
  });

  return targetBone;
}

export function attachEquipmentVisualToVRM(options: {
  slot: string;
  modelRoot: THREE.Object3D;
  visuals: EquipmentVisualStore;
  vrm: VRM;
  avatarRoot?: THREE.Object3D;
  lighting?: EquipmentVisualLighting;
}): boolean {
  const { slot, modelRoot, visuals, vrm } = options;
  if (!hasUsableEquipmentLighting(modelRoot, options.lighting)) return false;
  const slotKey = slot.toLowerCase();
  const avatarRoot = options.avatarRoot ?? vrm.scene;
  const attachmentData = extractEquipmentAttachmentData(modelRoot);
  const boneName = attachmentData?.vrmBoneName || "rightHand";

  const skinnedSlots = ["helmet", "body", "legs", "boots", "gloves", "cape"];
  const isSkinnedSlot = skinnedSlots.includes(slotKey);

  if (isSkinnedSlot && hasSkinnedMesh(modelRoot)) {
    const playerSkeleton = getPlayerSkeleton(vrm);
    if (
      !playerSkeleton ||
      !isSkinnedEquipmentSkeletonCompatible(modelRoot, vrm)
    ) {
      return false;
    }

    isolateEquipmentVisualMaterials(modelRoot);
    modelRoot.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) {
        child.skeleton = playerSkeleton;
        child.bind(playerSkeleton, child.bindMatrix);
        // Must match player body renderOrder (100) so equipment renders
        // on top of the silhouette (renderOrder 50), not underneath it.
        child.renderOrder = 100;
        applyEquipmentLighting(child, options.lighting);
      }
    });

    removeReplacedEquipmentVisual(visuals, slot, modelRoot);
    visuals[slotKey] = modelRoot;
    vrm.scene.add(modelRoot);
    return true;
  }

  const targetBone = findTargetBone(vrm, avatarRoot, boneName);
  if (!targetBone) {
    return false;
  }

  isolateEquipmentVisualMaterials(modelRoot);
  removeReplacedEquipmentVisual(visuals, slot, modelRoot);

  // Set renderOrder on all meshes so equipment renders on top of the
  // player silhouette (renderOrder 50), matching player body (100).
  modelRoot.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.renderOrder = 100;
      applyEquipmentLighting(child, options.lighting);
    }
  });

  const hasValidMatrix = hasValidAttachmentMatrix(attachmentData);

  if (hasValidMatrix) {
    const equipmentWrapper = modelRoot.children.find(
      (child) => child.name === "EquipmentWrapper",
    );

    if (equipmentWrapper) {
      visuals[slotKey] = modelRoot;
      targetBone.add(modelRoot);
      return true;
    }

    const relativeMatrix = new THREE.Matrix4();
    // attachmentData and relativeMatrix are guaranteed non-null by hasValidMatrix guard above
    relativeMatrix.fromArray(attachmentData.relativeMatrix as number[]);

    const wrapperGroup = new THREE.Group();
    wrapperGroup.name = "EquipmentWrapper";

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    relativeMatrix.decompose(position, quaternion, scale);

    wrapperGroup.position.copy(position);
    wrapperGroup.quaternion.copy(quaternion);
    wrapperGroup.scale.copy(scale);
    wrapperGroup.add(modelRoot);

    visuals[slotKey] = wrapperGroup;
    targetBone.add(wrapperGroup);
    return true;
  }

  const equipmentWrapper = modelRoot.children.find(
    (child) => child.name === "EquipmentWrapper",
  );

  if (equipmentWrapper) {
    const weaponScaleMultiplier = 1.75;
    modelRoot.scale.multiplyScalar(weaponScaleMultiplier);
  } else if (!attachmentData) {
    modelRoot.scale.set(0.01, 0.01, 0.01);
  }

  visuals[slotKey] = modelRoot;
  targetBone.add(modelRoot);
  return true;
}
