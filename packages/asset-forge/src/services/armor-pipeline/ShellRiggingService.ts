import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { ShellMesh, RiggedArmorResult } from "./types";

export interface DuelFitExportOptions {
  itemId: string;
  compatibleAvatarIds: string[];
}

const COMPETITIVE_ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const DEFORMING_ARMOR_SLOTS = new Set([
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
]);

function canonicalRigNumber(value: number): number {
  const rounded = Number(value.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Stable digest of the ordered skeleton hierarchy and inverse bind pose. */
export async function createSkeletonRigFingerprint(
  skeleton: THREE.Skeleton,
): Promise<string> {
  if (
    skeleton.bones.length === 0 ||
    skeleton.boneInverses.length !== skeleton.bones.length
  ) {
    throw new Error("Skeleton is missing a complete inverse bind pose");
  }
  const boneIndices = new Map(
    skeleton.bones.map((bone, index) => [bone, index] as const),
  );
  const boneNames = skeleton.bones.map((bone) => bone.name);
  if (
    boneNames.some((name) => !name.trim()) ||
    new Set(boneNames).size !== boneNames.length
  ) {
    throw new Error("Skeleton bone names must be non-empty and unique");
  }
  if (
    skeleton.bones.some(
      (bone) =>
        bone.parent instanceof THREE.Bone && !boneIndices.has(bone.parent),
    )
  ) {
    throw new Error(
      "Skeleton hierarchy references an unregistered parent bone",
    );
  }
  if (
    skeleton.boneInverses.some((matrix) =>
      matrix.elements.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Skeleton inverse bind pose contains non-finite values");
  }
  const canonical = skeleton.bones.map((bone, index) => ({
    name: bone.name,
    parentIndex:
      bone.parent instanceof THREE.Bone
        ? (boneIndices.get(bone.parent) ?? -1)
        : -1,
    inverseBindMatrix:
      skeleton.boneInverses[index].elements.map(canonicalRigNumber),
  }));
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * ShellRiggingService — POC-3 implementation
 *
 * Re-rigs a textured shell (from Meshy retexture) by transferring bone weights
 * from the original shell geometry back onto the textured mesh.
 *
 * Two strategies:
 * - Fast path: vertex counts match → direct attribute copy
 * - Fallback: vertex counts differ → nearest-vertex weight transfer
 */
export class ShellRiggingService {
  private gltfLoader: GLTFLoader;

  constructor() {
    this.gltfLoader = new GLTFLoader();
  }

  /**
   * Rig a textured shell by transferring bone weights from the original shell.
   *
   * @param originalShell - The shell mesh with skeleton + skinIndex/skinWeight
   * @param texturedGlbUrl - URL to the textured GLB (from Meshy or file upload)
   * @returns RiggedArmorResult with a SkinnedMesh bound to the original skeleton
   */
  async rigTexturedShell(
    originalShell: ShellMesh,
    texturedGlbUrl: string,
    /** If provided, bind to this skeleton instead of the shell's skeleton.
     *  Required when the preview VRM is a different instance than the extraction VRM. */
    targetSkeleton?: THREE.Skeleton,
  ): Promise<RiggedArmorResult> {
    // Load textured GLB
    const gltf = await this.gltfLoader.loadAsync(texturedGlbUrl);

    // Track loaded GPU resources for cleanup on error
    const loadedTextures: THREE.Texture[] = [];
    const loadedGeometries: THREE.BufferGeometry[] = [];
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        loadedGeometries.push(child.geometry);
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            if (mat.map) loadedTextures.push(mat.map);
            if (mat.normalMap) loadedTextures.push(mat.normalMap);
            if (mat.roughnessMap) loadedTextures.push(mat.roughnessMap);
            if (mat.metalnessMap) loadedTextures.push(mat.metalnessMap);
          }
        }
      }
    });

    try {
      return this.processTexturedGLB(gltf, originalShell, targetSkeleton);
    } catch (err) {
      // Dispose GPU resources on failure
      for (const tex of loadedTextures) tex.dispose();
      for (const geo of loadedGeometries) geo.dispose();
      throw err;
    }
  }

  /** Internal processing after GLB is loaded — separated for error-path cleanup */
  private processTexturedGLB(
    gltf: { scene: THREE.Group },
    originalShell: ShellMesh,
    targetSkeleton?: THREE.Skeleton,
  ): RiggedArmorResult {
    // Find the first Mesh in the loaded scene
    let texturedMesh: THREE.Mesh | null = null;
    gltf.scene.traverse((child) => {
      if (!texturedMesh && child instanceof THREE.Mesh) {
        texturedMesh = child;
      }
    });

    if (!texturedMesh) {
      throw new Error("No Mesh found in textured GLB");
    }

    const mesh = texturedMesh as THREE.Mesh;
    const texturedGeo = mesh.geometry;
    const originalGeo = originalShell.geometry;

    // Bake GLTF scene hierarchy transforms into geometry (the mesh node may
    // be nested inside groups with translation/rotation/scale)
    gltf.scene.updateMatrixWorld(true);
    texturedGeo.applyMatrix4(mesh.matrixWorld);
    // Reset the mesh's own transform since it's now baked into geometry
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);

    // Align textured geometry to original shell — Meshy often centers/normalizes
    // the model, so positions end up at origin instead of at chest/leg height.
    this.alignGeometry(texturedGeo, originalGeo);

    const texturedVertCount = texturedGeo.attributes.position.count;
    const originalVertCount = originalGeo.attributes.position.count;

    const vertexMatch = texturedVertCount === originalVertCount;

    // Get skinning attributes from original shell
    const srcSkinIndex = originalGeo.attributes
      .skinIndex as THREE.BufferAttribute;
    const srcSkinWeight = originalGeo.attributes
      .skinWeight as THREE.BufferAttribute;

    if (!srcSkinIndex || !srcSkinWeight) {
      throw new Error(
        "Original shell geometry missing skinIndex/skinWeight attributes",
      );
    }

    let skinIndexArray: Float32Array;
    let skinWeightArray: Float32Array;

    if (vertexMatch) {
      // Fast path: direct copy — vertex counts match (expected with enable_original_uv)
      skinIndexArray = new Float32Array(srcSkinIndex.array);
      skinWeightArray = new Float32Array(srcSkinWeight.array);
    } else {
      // Fallback: nearest-vertex weight transfer by position distance
      console.warn(
        `[ShellRiggingService] Vertex count mismatch: original=${originalVertCount}, textured=${texturedVertCount}. Using nearest-vertex transfer.`,
      );

      const result = this.nearestVertexWeightTransfer(
        originalGeo,
        texturedGeo,
        srcSkinIndex,
        srcSkinWeight,
      );
      skinIndexArray = result.skinIndices;
      skinWeightArray = result.skinWeights;
    }

    // Set skinning attributes on textured geometry
    texturedGeo.setAttribute(
      "skinIndex",
      new THREE.BufferAttribute(new Uint16Array(skinIndexArray), 4),
    );
    texturedGeo.setAttribute(
      "skinWeight",
      new THREE.BufferAttribute(skinWeightArray, 4),
    );

    // Use the target skeleton (from the preview VRM) or fall back to the shell's skeleton
    const skeleton = targetSkeleton ?? originalShell.skeleton;

    // Preserve textured materials (Meshy PBR)
    let material = mesh.material;
    if (Array.isArray(material)) {
      material = material.map((m) => {
        m.side = THREE.DoubleSide;
        return m;
      });
    } else {
      material.side = THREE.DoubleSide;
    }

    const skinnedMesh = new THREE.SkinnedMesh(texturedGeo, material);
    skinnedMesh.name = `rigged_${originalShell.slotName}_${originalShell.bulkClass}`;

    // Bind to the skeleton that will be animated
    skinnedMesh.bind(skeleton);

    return {
      skinnedMesh,
      skeleton,
      slotName: originalShell.slotName,
      bulkClass: originalShell.bulkClass,
      vertexMatch,
      vertexCount: texturedVertCount,
    };
  }

  /**
   * Align textured geometry to match the original shell's bounding box.
   * Handles Meshy centering/normalization by matching scale and position.
   */
  private alignGeometry(
    texturedGeo: THREE.BufferGeometry,
    originalGeo: THREE.BufferGeometry,
  ): void {
    originalGeo.computeBoundingBox();
    texturedGeo.computeBoundingBox();

    if (!originalGeo.boundingBox || !texturedGeo.boundingBox) return;

    const origCenter = originalGeo.boundingBox.getCenter(new THREE.Vector3());
    const origSize = originalGeo.boundingBox.getSize(new THREE.Vector3());
    const texCenter = texturedGeo.boundingBox.getCenter(new THREE.Vector3());
    const texSize = texturedGeo.boundingBox.getSize(new THREE.Vector3());

    // Scale to match if sizes differ by more than 5%
    const maxOrigDim = Math.max(origSize.x, origSize.y, origSize.z);
    const maxTexDim = Math.max(texSize.x, texSize.y, texSize.z);

    if (maxTexDim > 0.001 && Math.abs(maxOrigDim / maxTexDim - 1) > 0.05) {
      const scale = maxOrigDim / maxTexDim;
      console.log(
        `[ShellRiggingService] Scaling textured mesh by ${scale.toFixed(3)} to match original`,
      );
      texturedGeo.scale(scale, scale, scale);
      // Recompute after scale
      texturedGeo.computeBoundingBox();
      texturedGeo.boundingBox!.getCenter(texCenter);
    }

    // Translate to match center position
    const offset = origCenter.clone().sub(texCenter);
    if (offset.length() > 0.001) {
      console.log(
        `[ShellRiggingService] Translating textured mesh by (${offset.x.toFixed(3)}, ${offset.y.toFixed(3)}, ${offset.z.toFixed(3)}) to align with original`,
      );
      texturedGeo.translate(offset.x, offset.y, offset.z);
    }
  }

  /**
   * Nearest-vertex weight transfer: for each vertex in the textured geometry,
   * find the closest vertex in the original geometry and copy its bone weights.
   */
  private nearestVertexWeightTransfer(
    originalGeo: THREE.BufferGeometry,
    texturedGeo: THREE.BufferGeometry,
    srcSkinIndex: THREE.BufferAttribute,
    srcSkinWeight: THREE.BufferAttribute,
  ): { skinIndices: Float32Array; skinWeights: Float32Array } {
    const srcPos = originalGeo.attributes.position as THREE.BufferAttribute;
    const dstPos = texturedGeo.attributes.position as THREE.BufferAttribute;
    const dstCount = dstPos.count;
    const srcCount = srcPos.count;

    const skinIndices = new Float32Array(dstCount * 4);
    const skinWeights = new Float32Array(dstCount * 4);

    // Pre-extract source positions into flat array for fast lookup
    const srcPositions = new Float32Array(srcCount * 3);
    for (let i = 0; i < srcCount; i++) {
      srcPositions[i * 3] = srcPos.getX(i);
      srcPositions[i * 3 + 1] = srcPos.getY(i);
      srcPositions[i * 3 + 2] = srcPos.getZ(i);
    }

    for (let di = 0; di < dstCount; di++) {
      const dx = dstPos.getX(di);
      const dy = dstPos.getY(di);
      const dz = dstPos.getZ(di);

      // Find nearest source vertex
      let bestDist = Infinity;
      let bestIdx = 0;

      for (let si = 0; si < srcCount; si++) {
        const ex = srcPositions[si * 3] - dx;
        const ey = srcPositions[si * 3 + 1] - dy;
        const ez = srcPositions[si * 3 + 2] - dz;
        const dist = ex * ex + ey * ey + ez * ez;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = si;
        }
      }

      // Copy skin data from nearest source vertex
      for (let j = 0; j < 4; j++) {
        skinIndices[di * 4 + j] = srcSkinIndex.getComponent(bestIdx, j);
        skinWeights[di * 4 + j] = srcSkinWeight.getComponent(bestIdx, j);
      }
    }

    return { skinIndices, skinWeights };
  }

  /**
   * Publish a rigged armor GLB to the game's model directory via the API server.
   * Updates the item manifest so the game can load and equip it.
   */
  async publishToGame(
    glbBlob: Blob,
    options: {
      itemId: string;
      slot: string;
      itemName?: string;
      tier?: string;
      bonuses?: Record<string, number>;
    },
  ): Promise<{ success: boolean; glbPath?: string; error?: string }> {
    const formData = new FormData();
    formData.append("file", glbBlob, `${options.itemId}.glb`);
    formData.append("itemId", options.itemId);
    formData.append("slot", options.slot);
    if (options.itemName) formData.append("itemName", options.itemName);
    if (options.tier) formData.append("tier", options.tier);
    if (options.bonuses)
      formData.append("bonuses", JSON.stringify(options.bonuses));

    const apiBase =
      import.meta.env.VITE_GENERATION_API_URL?.replace(/\/$/, "") || "/api";
    const resp = await fetch(`${apiBase}/armor-pipeline/publish-to-game`, {
      method: "POST",
      body: formData,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${text}` };
    }

    return resp.json();
  }

  /**
   * Export a rigged armor mesh as a game-ready GLB.
   *
   * IMPORTANT: Exports the FULL skeleton with original bone indices preserved.
   * The game's EquipmentVisualSystem does a simple skeleton swap:
   *   child.skeleton = playerSkeleton;
   *   child.bind(playerSkeleton, child.bindMatrix);
   * It does NOT remap bone indices by name — so skinIndex values must reference
   * the same bone positions as the player's VRM skeleton.
   */
  async exportRiggedGLB(
    result: RiggedArmorResult,
    options: DuelFitExportOptions,
  ): Promise<Blob> {
    const { GLTFExporter } =
      await import("three/addons/exporters/GLTFExporter.js");

    const exporter = new GLTFExporter();
    const { skinnedMesh, skeleton } = result;
    const geometry = skinnedMesh.geometry;
    const itemId = options.itemId.trim();
    if (
      options.itemId !== itemId ||
      !COMPETITIVE_ASSET_ID_PATTERN.test(itemId)
    ) {
      throw new Error("A canonical competitive item ID is required");
    }
    const compatibleAvatarIds = [...options.compatibleAvatarIds];
    if (
      compatibleAvatarIds.length === 0 ||
      compatibleAvatarIds.some(
        (id) => id !== id.trim() || !COMPETITIVE_ASSET_ID_PATTERN.test(id),
      ) ||
      new Set(compatibleAvatarIds).size !== compatibleAvatarIds.length
    ) {
      throw new Error("At least one fitted avatar ID is required");
    }
    if (!DEFORMING_ARMOR_SLOTS.has(result.slotName)) {
      throw new Error(`Unsupported deforming armor slot: ${result.slotName}`);
    }
    const rigFingerprint = await createSkeletonRigFingerprint(skeleton);

    // Update skeleton before export
    skeleton.update();

    // Clone ALL bones from the full skeleton — preserves original indices
    // so the game's simple skeleton swap works correctly.
    const oldToNewBone = new Map<THREE.Bone, THREE.Bone>();
    const newBones: THREE.Bone[] = [];

    for (let i = 0; i < skeleton.bones.length; i++) {
      const oldBone = skeleton.bones[i];
      oldBone.updateWorldMatrix(true, false);
      const newBone = new THREE.Bone();
      newBone.name = oldBone.name;
      newBone.position.copy(oldBone.position);
      newBone.quaternion.copy(oldBone.quaternion);
      newBone.scale.copy(oldBone.scale);
      newBones.push(newBone);
      oldToNewBone.set(oldBone, newBone);
    }

    // Rebuild parent-child hierarchy
    for (let i = 0; i < skeleton.bones.length; i++) {
      const oldBone = skeleton.bones[i];
      const newBone = newBones[i];
      if (oldBone.parent && oldBone.parent instanceof THREE.Bone) {
        const parentNew = oldToNewBone.get(oldBone.parent);
        if (parentNew) {
          parentNew.add(newBone);
        }
      }
    }

    const rootBones = newBones.filter(
      (bone) => !bone.parent || !(bone.parent instanceof THREE.Bone),
    );
    rootBones.forEach((root) => root.updateMatrixWorld(true));

    // Copy inverse bind matrices from original skeleton
    const boneInverses: THREE.Matrix4[] = [];
    for (let i = 0; i < skeleton.bones.length; i++) {
      const inv = new THREE.Matrix4();
      if (skeleton.boneInverses[i]) {
        inv.copy(skeleton.boneInverses[i]);
      } else {
        inv.copy(skeleton.bones[i].matrixWorld).invert();
      }
      boneInverses.push(inv);
    }

    const fullSkeleton = new THREE.Skeleton(newBones, boneInverses);

    // Clone geometry — skinIndex values stay as-is (no remapping needed)
    const exportGeometry = geometry.clone();

    // Build export scene
    const exportScene = new THREE.Scene();
    const rootNode = new THREE.Group();
    rootNode.name = "ArmatureRoot";
    exportScene.add(rootNode);
    rootBones.forEach((bone) => rootNode.add(bone));

    // Clone material for export
    let exportMaterial = skinnedMesh.material;
    if (Array.isArray(exportMaterial)) {
      exportMaterial = exportMaterial.map((m) => m.clone());
    } else {
      exportMaterial = exportMaterial.clone();
    }

    const exportMesh = new THREE.SkinnedMesh(exportGeometry, exportMaterial);
    exportMesh.name = result.slotName + "_armor";
    exportMesh.bind(fullSkeleton, new THREE.Matrix4().identity());
    exportScene.add(exportMesh);

    exportMesh.updateMatrixWorld(true);
    fullSkeleton.update();

    // Ensure geometry has normals
    if (!exportGeometry.attributes.normal) {
      exportGeometry.computeVertexNormals();
    }

    // Embed both armorMetadata (internal) and hyperia (game-compatible) data.
    // The game's EquipmentVisualHelpers.extractEquipmentAttachmentData() reads
    // userData.hyperia to determine bone attachment and skinning.
    const slotToBone: Record<string, string> = {
      helmet: "head",
      body: "spine",
      legs: "hips",
      boots: "leftFoot",
      gloves: "leftHand",
    };
    const duelFit = {
      schemaVersion: 1 as const,
      itemId,
      slot: result.slotName,
      compatibleAvatarIds,
      rigFingerprint,
    };
    const hyperiaMetadata = {
      version: 2,
      vrmBoneName: slotToBone[result.slotName] ?? "spine",
      originalSlot: result.slotName,
      exportedFrom: "asset-forge-armor-pipeline",
      exportedAt: new Date().toISOString(),
      duelFit,
    };
    exportScene.userData.hyperia = hyperiaMetadata;
    rootNode.userData.hyperia = hyperiaMetadata;
    exportMesh.userData = {
      armorMetadata: {
        slotName: result.slotName,
        bulkClass: result.bulkClass,
        vertexMatch: result.vertexMatch,
        vertexCount: result.vertexCount,
        boneCount: newBones.length,
        boneNames: newBones.map((b) => b.name),
        exportDate: new Date().toISOString(),
      },
      hyperia: hyperiaMetadata,
    };

    return new Promise((resolve, reject) => {
      exporter.parse(
        exportScene,
        (buffer) => {
          if (buffer instanceof ArrayBuffer) {
            resolve(new Blob([buffer], { type: "model/gltf-binary" }));
          } else {
            resolve(
              new Blob([JSON.stringify(buffer)], { type: "model/gltf+json" }),
            );
          }
        },
        reject,
        { binary: true },
      );
    });
  }
}
