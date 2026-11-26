import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import {
  extractEquipmentAttachmentData,
  validateStreamingEquipmentVisualModel,
} from "./EquipmentVisualHelpers";

/** Authored opt-in, not inferred from an item name, slot, or silhouette. */
export type NeutralShortsReplacementData = {
  schemaVersion: 1;
  coverage: "waist-to-ankles";
  replaces: "neutral-shorts";
};

/**
 * Avatar scene extras: userData.hyperiaNeutralClothing. The named leaf meshes
 * must separately declare userData.hyperiaAvatarSurface = "body" or
 * "neutral-shorts". Export qualification must establish that shorts really are
 * a separate garment; this metadata does not certify an unfinished asset.
 * Scene/node extras survive the existing VRM SkeletonUtils clone path.
 */
export type AvatarNeutralClothingData = {
  schemaVersion: 1;
  shortsMeshName: string;
  bodyMeshNames: string[];
};

type Attachment = {
  playerId: string;
  modelRoot: THREE.Object3D;
  slot: string;
  itemId: string;
  avatarId: string | null;
  vrm: VRM;
};

function isDescendant(
  object: THREE.Object3D,
  ancestor: THREE.Object3D,
): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}

function isVisible(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

function hasVisibleCoverage(modelRoot: THREE.Object3D): boolean {
  let hasSkin = false;
  let visible = isVisible(modelRoot);
  modelRoot.traverse((node) => {
    if (!(node instanceof THREE.SkinnedMesh)) return;
    hasSkin = true;
    visible &&= isVisible(node);
  });
  return hasSkin && visible;
}

export function requestsNeutralShortsReplacement(
  modelRoot: THREE.Object3D,
): boolean {
  const replacement =
    extractEquipmentAttachmentData(modelRoot)?.clothingReplacement;
  return (
    replacement?.schemaVersion === 1 &&
    replacement.coverage === "waist-to-ankles" &&
    replacement.replaces === "neutral-shorts"
  );
}

function exactLeafMesh(
  root: THREE.Object3D,
  name: unknown,
  role: "body" | "neutral-shorts",
): THREE.Mesh | null {
  if (typeof name !== "string" || !name || name !== name.trim()) return null;
  const matches: THREE.Object3D[] = [];
  root.traverse((node) => {
    if (node.name === name) matches.push(node);
  });
  const mesh = matches[0];
  return matches.length === 1 &&
    mesh instanceof THREE.Mesh &&
    mesh.children.length === 0 &&
    (mesh.geometry.getAttribute("position")?.count ?? 0) > 0 &&
    mesh.userData.hyperiaAvatarSurface === role
    ? mesh
    : null;
}

function replacementTarget(options: Attachment): THREE.Mesh | null {
  const { modelRoot, slot, itemId, avatarId, vrm } = options;
  if (
    slot.toLowerCase() !== "legs" ||
    !requestsNeutralShortsReplacement(modelRoot) ||
    !avatarId ||
    !isDescendant(modelRoot, vrm.scene) ||
    !hasVisibleCoverage(modelRoot) ||
    !validateStreamingEquipmentVisualModel(modelRoot, "legs", {
      itemId,
      avatarId,
      vrm,
    }).valid
  )
    return null;

  const data: unknown = vrm.scene.userData.hyperiaNeutralClothing;
  if (!data || typeof data !== "object") return null;
  const contract = data as Partial<AvatarNeutralClothingData>;
  if (
    contract.schemaVersion !== 1 ||
    !Array.isArray(contract.bodyMeshNames) ||
    contract.bodyMeshNames.length === 0 ||
    new Set(contract.bodyMeshNames).size !== contract.bodyMeshNames.length ||
    contract.bodyMeshNames.includes(contract.shortsMeshName ?? "")
  )
    return null;

  const bodies = contract.bodyMeshNames.map((name) =>
    exactLeafMesh(vrm.scene, name, "body"),
  );
  const shorts = exactLeafMesh(
    vrm.scene,
    contract.shortsMeshName,
    "neutral-shorts",
  );
  if (
    !shorts ||
    isDescendant(shorts, modelRoot) ||
    bodies.some((body) => !body || isDescendant(body, modelRoot))
  )
    return null;
  // The exact leaf-only target cannot hide the body, bones, or another garment
  // through ancestor visibility. Never mutate materials, geometry, or rig state.
  return shorts;
}

/** Visibility is owned by the successfully attached visual, not load intent. */
export class NeutralShortsWearState {
  private readonly leases = new Map<
    string,
    {
      modelRoot: THREE.Object3D;
      vrm: VRM;
      shorts: THREE.Mesh;
      originalVisibility: boolean;
    }
  >();

  retains(
    playerId: string,
    modelRoot: THREE.Object3D | undefined,
    vrm: VRM,
  ): boolean {
    const lease = this.leases.get(playerId);
    return Boolean(
      lease &&
      lease.modelRoot === modelRoot &&
      lease.vrm === vrm &&
      isDescendant(lease.modelRoot, vrm.scene) &&
      hasVisibleCoverage(lease.modelRoot),
    );
  }

  /** Call only after the current request successfully attached its model. */
  commit(options: Attachment): void {
    this.clear(options.playerId);
    const shorts = replacementTarget(options);
    if (!shorts) return;
    this.leases.set(options.playerId, {
      modelRoot: options.modelRoot,
      vrm: options.vrm,
      shorts,
      originalVisibility: shorts.visible,
    });
    shorts.visible = false;
  }

  /**
   * Avatar readiness may reveal an already attached garment. Requalify without
   * releasing an existing visibility baseline while its avatar is hidden.
   * Hidden garment meshes still cannot acquire a replacement lease.
   */
  refresh(options: Attachment): void {
    if (replacementTarget(options)) this.commit(options);
  }

  clear(playerId: string): void {
    const lease = this.leases.get(playerId);
    if (!lease) return;
    lease.shorts.visible = lease.originalVisibility;
    this.leases.delete(playerId);
  }

  dispose(): void {
    for (const playerId of this.leases.keys()) this.clear(playerId);
  }
}
