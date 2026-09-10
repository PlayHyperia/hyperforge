/**
 * createVRMFactory.ts - VRM Character Avatar Factory
 *
 * Creates instances of VRM character models with animations, bone access, and performance optimization.
 * VRM is a standard format for 3D humanoid avatars used in VR/AR and games.
 *
 * **VRM Features:**
 * - Standardized humanoid skeleton (hips, spine, head, limbs)
 * - Expression/blend shapes (happy, sad, blink, etc.)
 * - First-person view setup (hide head in FP mode)
 * - Spring bone physics (hair, clothes)
 * - Metadata (author, usage rights, etc.)
 *
 * **Factory Pattern:**
 * - One factory per VRM model (shared across multiple instances)
 * - create() method spawns new instances
 * - Instances share skeleton structure but have independent poses
 * - Reduces memory and processing for multiple copies
 *
 * **Performance Optimizations:**
 * - Distance-based update rate (far avatars update less frequently)
 * - Detached bind mode for skinned meshes
 * - Manual matrix updates only when needed
 * - Shared geometry across instances via SkeletonUtils.clone
 * - BVH raycasting acceleration
 *
 * **Instance Features:**
 * - setEmote(url): Play animation
 * - move(matrix): Update position/rotation
 * - getBoneTransform(boneName): Get bone matrix
 * - setFirstPerson(bool): Toggle first-person visibility
 * - height, headToHeight: Avatar dimensions
 *
 * **CSM Shadow Integration:**
 * - Calls setupMaterial() on all materials for shadow support
 * - Sets shadowSide to BackSide to prevent shadow acne
 *
 * **Referenced by:** Avatar nodes, PlayerLocal, PlayerRemote
 */

import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

import type { GLBData } from "../../types";
import type { VRMHooks } from "../../types/systems/physics";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";

import { getTextureBytesFromMaterial } from "./getTextureBytesFromMaterial";
import { getTrianglesFromGeometry } from "./getTrianglesFromGeometry";
import { PlayerHitReactionController } from "./PlayerHitReactionController";
import {
  ARM38_ACCEPTED_ASSET_SHA256,
  Authored38ArmRetarget,
  type Arm38Humanoid,
} from "./Authored38ArmRetarget";
import {
  collectAvatarAuthoredMotionDiagnostics,
  EMPTY_AVATAR_AUTHORED_MOTION_DIAGNOSTICS,
} from "./AvatarAuthoredMotionDiagnostics";
import { applyAnimationActionStartTime } from "./AnimationActionStartTime";
import {
  avatarEmoteBlendSecondsFor,
  fadeInAvatarEmote,
  fadeOutAvatarEmote,
} from "./AvatarEmoteTransition";
import type { HitReactionSide } from "../../utils/rendering/HitReaction";
import THREE, {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "./three";

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();

// Pre-allocated matrices for VRM instance move() to avoid per-frame allocations
// These are used by the create() closure for each instance
const _rotationMatrix = new THREE.Matrix4();
const _scaleMatrix = new THREE.Matrix4();
const _tempMatrix1 = new THREE.Matrix4();
const _tempMatrix2 = new THREE.Matrix4();

/** How often to check avatar distance for LOD (seconds) */
const DIST_CHECK_RATE = 1;

/** Minimum update rate for close avatars (updates/second) */
const DIST_MIN_RATE = 1 / 5;

/** Maximum update rate for far avatars (updates/second) */
const DIST_MAX_RATE = 1 / 25;

/** Distance for minimum update rate (meters) */
const DIST_MIN = 30;

/** Distance for maximum update rate (meters) */
const DIST_MAX = 60;

const material = new MeshBasicNodeMaterial();
const loggedMissingSkinnedMeshSources = new Set<string>();

type MeshLike = THREE.Mesh & { isMesh?: boolean };
type SkinnedMeshLike = THREE.SkinnedMesh & {
  isSkinnedMesh?: boolean;
  skeleton?: THREE.Skeleton | null;
};
type BoneLike = THREE.Bone & {
  isBone?: boolean;
  type?: string;
};

/**
 * Prefer structural flags over `instanceof` so this remains stable even when
 * multiple three.js module instances are present after bundling/merges.
 */
function isMeshLike(value: unknown): value is MeshLike {
  return Boolean(value && (value as { isMesh?: boolean }).isMesh);
}

function isSkinnedMeshLike(value: unknown): value is SkinnedMeshLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { isSkinnedMesh?: boolean; skeleton?: unknown };
  return Boolean(candidate.isSkinnedMesh || candidate.skeleton);
}

function isBoneLike(value: unknown): value is BoneLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { isBone?: boolean; type?: string };
  return Boolean(candidate.isBone || candidate.type === "Bone");
}

/**
 * A Three.js bone matrixWorld already includes every ancestor transform,
 * including the moved avatar scene. Copy it directly: multiplying the avatar
 * scene matrix a second time rotates/translates world coordinates twice.
 */
export function copyAvatarBoneWorldTransform(
  target: THREE.Matrix4,
  boneWorld: THREE.Matrix4,
): THREE.Matrix4 {
  return target.copy(boneWorld);
}

/** Use the same node-material conversion in the game and avatar review. */
export function prepareVRMMaterialsForWebGPU(root: THREE.Object3D): void {
  const convertedMaterials = new Map<
    THREE.Material,
    MeshStandardNodeMaterial
  >();
  root.traverse((obj) => {
    if (isMeshLike(obj)) {
      obj.castShadow = true;
      obj.receiveShadow = false;

      // Convert materials to MeshStandardMaterial for proper sun/moon/environment lighting
      const convertMaterial = (
        mat: THREE.Material,
      ): MeshStandardNodeMaterial => {
        const cached = convertedMaterials.get(mat);
        if (cached) return cached;

        const materialFlags = mat as THREE.Material & {
          isMeshStandardMaterial?: boolean;
          isMeshPhysicalMaterial?: boolean;
          isMeshStandardNodeMaterial?: boolean;
        };
        if (materialFlags.isMeshStandardNodeMaterial) {
          return mat as MeshStandardNodeMaterial;
        }

        // glTF PBR assets already have authored surface parameters. Use Three's
        // complete material copy routines so maps, normal scale, transmission,
        // clearcoat and render state survive the conversion to node materials.
        // NodeMaterial.copy copies node inputs, not the classic PBR fields.
        if (materialFlags.isMeshStandardMaterial) {
          const converted = materialFlags.isMeshPhysicalMaterial
            ? new MeshPhysicalNodeMaterial()
            : new MeshStandardNodeMaterial();
          const copy = materialFlags.isMeshPhysicalMaterial
            ? THREE.MeshPhysicalMaterial.prototype.copy
            : THREE.MeshStandardMaterial.prototype.copy;
          Reflect.apply(copy, converted, [mat]);
          convertedMaterials.set(mat, converted);
          mat.dispose();
          return converted;
        }

        // Extract textures and colors from original material
        const originalMat = mat as THREE.Material & {
          map?: THREE.Texture | null;
          normalMap?: THREE.Texture | null;
          emissiveMap?: THREE.Texture | null;
          color?: THREE.Color;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
          opacity?: number;
          transparent?: boolean;
          alphaTest?: number;
          side?: THREE.Side;
          // MToon specific properties
          shadeMultiplyTexture?: THREE.Texture | null;
          matcapTexture?: THREE.Texture | null;
        };

        // Use base color for emissive so avatars pop at night (subtle self-illumination)
        // If original has emissive, use it; otherwise derive from diffuse color
        const baseColor =
          originalMat.color?.clone() || new THREE.Color(0xffffff);
        const emissiveColor =
          originalMat.emissive?.clone() ||
          baseColor.clone().multiplyScalar(0.15);

        // Build WebGPU-compatible MeshStandardNodeMaterial
        const newMat = new MeshStandardNodeMaterial();
        newMat.color = baseColor;
        newMat.emissive = emissiveColor;
        newMat.emissiveIntensity = 0.3; // Subtle glow - matches PlayerEntity placeholder
        newMat.opacity = originalMat.opacity ?? 1;
        newMat.transparent = originalMat.transparent ?? false;
        newMat.alphaTest = originalMat.alphaTest ?? 0;
        newMat.side = originalMat.side ?? THREE.FrontSide;
        newMat.roughness = 1.0;
        newMat.metalness = 0.0;
        newMat.envMapIntensity = 1.0; // Respond to environment map

        // Conditionally add texture maps only if they exist
        if (originalMat.map) {
          newMat.map = originalMat.map;
        }
        if (originalMat.normalMap) {
          newMat.normalMap = originalMat.normalMap;
        }
        if (originalMat.emissiveMap) {
          newMat.emissiveMap = originalMat.emissiveMap;
        }

        // Copy name for debugging
        newMat.name = originalMat.name || "VRM_Standard";

        // Dispose old material
        convertedMaterials.set(mat, newMat);
        originalMat.dispose();

        return newMat;
      };

      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map(convertMaterial);
      } else {
        obj.material = convertMaterial(obj.material);
      }
    }
  });
}

/**
 * Create VRM Avatar Factory
 *
 * Prepares a VRM model for instancing with animations and optimizations.
 *
 * @param glb - Loaded VRM GLB data
 * @param setupMaterial - Optional material setup function (for CSM shadows)
 * @returns Factory object with create() method and stats tracking
 */
export function createVRMFactory(
  glb: GLBData,
  setupMaterial?: (material: THREE.Material) => void,
  options: { sourceSHA256?: string } = {},
) {
  const restPoseProfile = glb.scene.userData.hyperiaRestPoseProfile;
  if (
    restPoseProfile !== undefined &&
    restPoseProfile !== "body38-arm-apose-v1"
  ) {
    throw new Error("Unsupported authored avatar rest-pose profile");
  }
  if (restPoseProfile && !options.sourceSHA256) {
    throw new Error(
      "Authored rest-pose calibration requires verified avatar bytes",
    );
  }
  if (
    restPoseProfile &&
    !ARM38_ACCEPTED_ASSET_SHA256.includes(options.sourceSHA256!)
  ) {
    throw new Error("Arm38 calibration requires exact verified package hash");
  }
  // we'll update matrix ourselves
  glb.scene.matrixAutoUpdate = false;
  glb.scene.matrixWorldAutoUpdate = false;
  // remove expressions from scene
  const expressions = glb.scene.children.filter(n => n.type === 'VRMExpression'); // prettier-ignore
  for (const node of expressions) node.removeFromParent();
  // Keep the normalized rig for animation-to-raw-bone propagation.
  // const vrmHumanoidRigs = glb.scene.children.filter(n => n.name === 'VRMHumanoidRig') // prettier-ignore
  // for (const node of vrmHumanoidRigs) node.removeFromParent()
  // remove secondary
  const secondaries = glb.scene.children.filter(n => n.name === 'secondary'); // prettier-ignore
  for (const node of secondaries) node.removeFromParent();
  prepareVRMMaterialsForWebGPU(glb.scene);
  // MMO APPROACH: Use cloning with raw bones for memory efficiency
  const humanoid = glb.userData?.vrm?.humanoid;
  const bones = humanoid?._rawHumanBones?.humanBones || {};
  const normBones = humanoid?._normalizedHumanBones?.humanBones || {};

  // Calculate root to hips offset (needed for animation retargeting)
  const hipsPosition = v1.setFromMatrixPosition(
    bones.hips?.node?.matrixWorld || new THREE.Matrix4(),
  );
  const rootPosition = v2.set(0, 0, 0);
  const rootToHips = hipsPosition.y - rootPosition.y;

  // Get VRM version
  const vrmData = glb.userData?.vrm;
  const version = vrmData?.meta?.metaVersion;
  // VRM 1.0+ check: version string starts with "1" or higher
  const isVRM1OrHigher =
    version !== "0" &&
    (!version || (typeof version === "string" && !version.startsWith("0.")));

  // Setup skinned meshes with NORMAL bind mode (for normalized bone compatibility)
  // DetachedBindMode is incompatible with normalized bones in scene graph
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  glb.scene.traverse((node) => {
    if (isSkinnedMeshLike(node)) {
      const skinnedMesh = node;
      // Use default bind mode (NormalBindMode) - compatible with normalized bones
      // DetachedBindMode requires bones to be detached, but we keep them in scene for vrm.humanoid.update()
      skinnedMeshes.push(skinnedMesh);
    }
    if (isMeshLike(node)) {
      const mesh = node;
      // Build BVH when available. In some bundle/resolution paths the geometry
      // prototype may not carry three-mesh-bvh extensions.
      const geometryWithBvh = mesh.geometry as THREE.BufferGeometry & {
        computeBoundsTree?: () => void;
      };
      if (typeof geometryWithBvh.computeBoundsTree === "function") {
        geometryWithBvh.computeBoundsTree();
      }
      // fix csm shadow banding
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat) => {
          (mat as THREE.Material & { shadowSide: THREE.Side }).shadowSide =
            THREE.BackSide;
        });
      } else {
        (
          mesh.material as THREE.Material & { shadowSide: THREE.Side }
        ).shadowSide = THREE.BackSide;
      }
      // csm material setup
      if (setupMaterial) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => setupMaterial!(mat));
        } else {
          setupMaterial(mesh.material);
        }
      }
    }
  });

  // Normalized bones compensate bone axes, not arbitrary anatomical A-rest.
  // Marked authored A-rest assets require the explicit calibrated clip adapter.

  // Get height from bounding box BEFORE normalization
  let originalHeight = 0.5; // minimum
  for (const mesh of skinnedMeshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    originalHeight = Math.max(originalHeight, mesh.geometry.boundingBox!.max.y);
  }

  // Normalize avatar height to 1.6m (standard human height)
  const targetHeight = 1.6;
  const scaleFactor = targetHeight / originalHeight;

  // Apply scale to entire scene
  glb.scene.scale.setScalar(scaleFactor);
  glb.scene.updateMatrixWorld(true);

  // Update bounding boxes after scaling
  for (const mesh of skinnedMeshes) {
    mesh.geometry.computeBoundingBox();
  }

  const height = targetHeight;

  // Calculate head to height for camera positioning
  const headPos = normBones.head?.node?.getWorldPosition(v1) || v1.set(0, 0, 0);
  const headToHeight = height - headPos.y;

  return {
    create,
    applyStats(stats: {
      geometries: Set<string>;
      materials: Set<string>;
      triangles: number;
      textureBytes: number;
    }) {
      glb.scene.traverse((obj) => {
        if (isMeshLike(obj)) {
          if (obj.geometry && !stats.geometries.has(obj.geometry.uuid)) {
            stats.geometries.add(obj.geometry.uuid);
            stats.triangles += getTrianglesFromGeometry(obj.geometry);
          }
          if (obj.material) {
            const materials = Array.isArray(obj.material)
              ? obj.material
              : [obj.material];
            materials.forEach((mat) => {
              if (!stats.materials.has(mat.uuid)) {
                stats.materials.add(mat.uuid);
                stats.textureBytes += getTextureBytesFromMaterial(mat);
              }
            });
          }
        }
      });
    },
  };

  function create(
    matrix: THREE.Matrix4,
    hooks: VRMHooks,
    node?: { ctx?: { entity?: unknown } },
  ) {
    const nodeWithCtx = node as unknown as {
      ctx?: { stage?: { scene?: THREE.Scene } };
    };
    const alternateScene = nodeWithCtx?.ctx?.stage?.scene;

    // MMO APPROACH: Clone the VRM for each player instance
    // This is memory efficient - shared geometry/textures, only skeleton is duplicated
    // VRM humanoid is shared (only used for bone lookup, not for animation updates)
    const vrm = cloneGLB(glb);
    type VrmHumanoid = {
      update?: (deltaTime: number) => void;
      getNormalizedBoneNode?: (boneName: string) => THREE.Object3D | null;
      getRawBoneNode?: (boneName: string) => THREE.Object3D | null;
    };
    type VrmSceneUserData = {
      vrm?: { humanoid?: VrmHumanoid };
    };
    const sceneUserData = vrm.scene.userData as VrmSceneUserData | undefined;
    const _tvrm = vrm.userData?.vrm ?? sceneUserData?.vrm;

    const skinnedMeshes = getSkinnedMeshes(vrm.scene as THREE.Scene);
    if (skinnedMeshes.length === 0) {
      const sourceHint = (
        (glb as unknown as { src?: string }).src ||
        (glb.scene.userData as { src?: string } | undefined)?.src ||
        glb.scene.name ||
        "unknown"
      ).toString();

      const meshCount = getMeshes(vrm.scene as THREE.Scene).length;
      if (!loggedMissingSkinnedMeshSources.has(sourceHint)) {
        loggedMissingSkinnedMeshSources.add(sourceHint);
        console.warn(
          `[createVRMFactory.create] No skinned meshes found in cloned VRM for ${sourceHint} (meshes=${meshCount}). Falling back to static avatar scene.`,
        );
      }

      if (meshCount === 0) {
        return null;
      }

      let fallbackMatrix = matrix;
      if (isVRM1OrHigher) {
        const rotationMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
        fallbackMatrix = new THREE.Matrix4().multiplyMatrices(
          matrix,
          rotationMatrix,
        );
      }
      const fallbackScaleMatrix = new THREE.Matrix4().makeScale(
        vrm.scene.scale.x,
        vrm.scene.scale.y,
        vrm.scene.scale.z,
      );
      fallbackMatrix = new THREE.Matrix4().multiplyMatrices(
        fallbackMatrix,
        fallbackScaleMatrix,
      );

      vrm.scene.matrix.copy(fallbackMatrix);
      vrm.scene.matrixWorld.copy(fallbackMatrix);
      vrm.scene.matrixAutoUpdate = false;
      vrm.scene.matrixWorldAutoUpdate = false;

      vrm.scene.layers.set(1);
      vrm.scene.traverse((child) => {
        child.layers.set(1);
      });

      if (hooks?.scene) {
        hooks.scene.add(vrm.scene);
      } else if (alternateScene) {
        alternateScene.add(vrm.scene);
      } else {
        console.error(
          "[VRMFactory] ERROR: No scene available, static VRM fallback will not be visible!",
        );
      }

      const getEntity = () => node?.ctx?.entity;
      vrm.scene.traverse((o) => {
        Object.defineProperty(o, "getEntity", {
          value: getEntity,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      });

      const fallbackCapsuleRadius = 0.3;
      const fallbackSpatialItem: {
        matrix: THREE.Matrix4;
        geometry: THREE.BufferGeometry;
        material: THREE.Material;
        getEntity: () => unknown;
      } = {
        matrix,
        geometry: createCapsule(
          fallbackCapsuleRadius,
          height - fallbackCapsuleRadius * 2,
        ),
        material,
        getEntity,
      };
      if (hooks?.octree) {
        hooks.octree.insert(fallbackSpatialItem);
      }

      return {
        raw: vrm,
        height,
        headToHeight,
        setEmote(_url?: string | null, _startTimeSeconds?: number) {
          // Static fallback: no animation system when skeleton binding is unavailable.
        },
        triggerHitReaction() {
          // Static fallback has no independently animatable humanoid bones.
        },
        clearHitReaction() {
          // Static fallback has no additive reaction state to restore.
        },
        getHitReactionDiagnostics() {
          return {
            schemaVersion: 1,
            availableBoneCount: 0,
            triggerCount: 0,
            active: false,
            elapsedSeconds: null,
            currentWeight: 0,
            lastIntensity: 0,
            lastSide: 1,
          } as const;
        },
        getAuthoredMotionDiagnostics() {
          return EMPTY_AVATAR_AUTHORED_MOTION_DIAGNOSTICS;
        },
        setFirstPerson() {
          // Static fallback: no reliable neck bone access.
        },
        update() {
          // Static fallback: no animation update work.
        },
        getBoneTransform() {
          return null;
        },
        move(_matrix: THREE.Matrix4) {
          matrix.copy(_matrix);
          let nextMatrix = _matrix;
          if (isVRM1OrHigher) {
            _rotationMatrix.makeRotationY(Math.PI);
            _tempMatrix1.multiplyMatrices(_matrix, _rotationMatrix);
            nextMatrix = _tempMatrix1;
          }
          _scaleMatrix.makeScale(
            vrm.scene.scale.x,
            vrm.scene.scale.y,
            vrm.scene.scale.z,
          );
          _tempMatrix2.multiplyMatrices(nextMatrix, _scaleMatrix);
          vrm.scene.matrix.copy(_tempMatrix2);
          vrm.scene.matrixWorld.copy(_tempMatrix2);
          vrm.scene.updateMatrixWorld(true);
          if (hooks?.octree && hooks.octree.move) {
            hooks.octree.move(fallbackSpatialItem);
          }
        },
        disableRateCheck() {
          // Static fallback: no animation LOD/rate checks to disable.
        },
        destroy() {
          if (hooks?.scene) {
            hooks.scene.remove(vrm.scene);
          }
          if (hooks?.octree && hooks.octree.remove) {
            hooks.octree.remove(fallbackSpatialItem);
          }
        },
      };
    }
    const skeleton = skinnedMeshes[0].skeleton;
    const rootBone = skeleton.bones[0];
    // CRITICAL: Keep rootBone in scene graph for normalized bone system to work
    // Detaching breaks normalized bones → raw bone propagation
    // rootBone.parent?.remove(rootBone)  // REMOVED - keep in scene
    rootBone.updateMatrixWorld(true);

    // HYBRID APPROACH: Use NORMALIZED bone names (Asset Forge method)
    // This allows VRM library's automatic bind pose handling to work
    // Normalized bones are cloned with the scene, so each instance has its own
    // CRITICAL: Use the CLONED humanoid (_tvrm?.humanoid) for bone lookups, not the original
    const clonedHumanoid = _tvrm?.humanoid;
    const getBoneName = (vrmBoneName: string): string | undefined => {
      // Guard against undefined/null bone names
      if (!vrmBoneName || !clonedHumanoid) return undefined;

      // Get the normalized animation target from this instance's cloned humanoid.
      const normalizedNode = clonedHumanoid.getNormalizedBoneNode?.(
        vrmBoneName as VRMHumanBoneName,
      );
      if (!normalizedNode) {
        // Don't warn for finger bones - many VRMs don't have them
        const isFingerBone =
          vrmBoneName.includes("Thumb") ||
          vrmBoneName.includes("Index") ||
          vrmBoneName.includes("Middle") ||
          vrmBoneName.includes("Ring") ||
          vrmBoneName.includes("Little");
        if (!isFingerBone) {
          console.warn(
            "[VRMFactory.getBoneName] Normalized bone not found:",
            vrmBoneName,
          );
        }
        return undefined;
      }

      // Return the normalized bone name directly - it's already in the cloned scene
      return normalizedNode.name;
    };

    // VRM 1.0+ models face +Z by default, but game expects -Z forward
    // Apply 180-degree Y-axis rotation only for VRM 1.0+
    // VRM 0.x models already face the correct direction
    let finalMatrix = matrix;
    if (isVRM1OrHigher) {
      const rotationMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
      finalMatrix = new THREE.Matrix4().multiplyMatrices(
        matrix,
        rotationMatrix,
      );
    }

    // CRITICAL: Compose scale into the matrix to preserve height normalization
    // The cloned scene has scale set, but direct matrix assignment would ignore it
    const scaleMatrix = new THREE.Matrix4().makeScale(
      vrm.scene.scale.x,
      vrm.scene.scale.y,
      vrm.scene.scale.z,
    );
    finalMatrix = new THREE.Matrix4().multiplyMatrices(
      finalMatrix,
      scaleMatrix,
    );

    vrm.scene.matrix.copy(finalMatrix);
    vrm.scene.matrixWorld.copy(finalMatrix);
    vrm.scene.matrixAutoUpdate = false;
    vrm.scene.matrixWorldAutoUpdate = false;

    // Cloned instances have their own normalized bones for independent animation.
    // Anatomical A-rest compensation is opt-in below, not supplied by three-vrm.

    // PERFORMANCE: Set VRM scene to layer 1 (main camera only, not minimap)
    // Minimap only renders terrain (layer 0) and uses 2D dots for entities
    vrm.scene.layers.set(1);
    vrm.scene.traverse((child) => {
      child.layers.set(1);
    });

    if (hooks?.scene) {
      hooks.scene.add(vrm.scene);
    } else if (alternateScene) {
      console.warn(
        "[VRMFactory] WARNING: No scene in hooks, using alternate scene from node.ctx.stage.scene",
      );
      alternateScene.add(vrm.scene);
    } else {
      console.error(
        "[VRMFactory] ERROR: No scene available, VRM will not be visible!",
      );
    }

    const getEntity = () => node?.ctx?.entity;

    // spatial capsule
    const cRadius = 0.3;
    const sItem: {
      matrix: THREE.Matrix4;
      geometry: THREE.BufferGeometry;
      material: THREE.Material;
      getEntity: () => unknown;
    } = {
      matrix,
      geometry: createCapsule(cRadius, height - cRadius * 2),
      material,
      getEntity,
    };
    if (hooks?.octree) {
      hooks.octree.insert(sItem);
    }

    // debug capsule
    // const foo = new THREE.Mesh(
    //   sItem.geometry,
    //   new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 })
    // )
    // vrm.scene.add(foo)

    // link back entity for raycasts

    vrm.scene.traverse((o) => {
      Object.defineProperty(o, "getEntity", {
        value: getEntity,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    });

    // HYBRID APPROACH: AnimationMixer on vrm.scene (Asset Forge method)
    // Animations target normalized bone names (Normalized_Hips, Normalized_Spine, etc.)
    // humanoid.update propagates normalized rotations; it does not infer a T-pose.
    // Each clone has its own vrm.scene with cloned normalized bones
    // CRITICAL: Mixer must be on vrm.scene where normalized bones live
    // Only the explicitly marked, byte-verified A-rest derivative is calibrated.
    // Ordinary VRMs keep their existing animation path. Original raw rests,
    // inverse binds and mesh weights remain unchanged on every instance.
    const armRetarget = restPoseProfile
      ? new Authored38ArmRetarget(
          clonedHumanoid as unknown as Arm38Humanoid,
          options.sourceSHA256!,
        )
      : null;
    armRetarget?.initializeNormalizedPose();
    if (armRetarget) clonedHumanoid?.update?.(0);
    const mixer = new THREE.AnimationMixer(vrm.scene);
    let destroyed = false;
    // Track death animation state for future debugging/logging
    let _deathAnimationActive = false;
    let _deathUpdateLogCount = 0;

    const hitReaction = new PlayerHitReactionController(clonedHumanoid);
    const triggerHitReaction = (intensity = 1, side: HitReactionSide = 1) => {
      if (!_deathAnimationActive) hitReaction.trigger(intensity, side);
    };
    const clearHitReaction = () => hitReaction.clear();

    // IDEA: we should use a global frame "budget" to distribute across avatars
    // https://chatgpt.com/c/4bbd469d-982e-4987-ad30-97e9c5ee6729

    let elapsed = 0;
    let rate = 0;
    let rateCheckedAt = 999;
    let rateCheck = true;
    let hasLoggedUpdatePipeline = false;
    const update = (delta) => {
      elapsed += delta;
      let should = true;
      if (rateCheck) {
        // periodically calculate update rate based on distance to camera
        rateCheckedAt += delta;
        if (rateCheckedAt >= DIST_CHECK_RATE) {
          const vrmPos = v1.setFromMatrixPosition(vrm.scene.matrix);
          const camPos = v2.setFromMatrixPosition((hooks.camera as THREE.Camera).matrixWorld); // prettier-ignore
          const distance = vrmPos.distanceTo(camPos);
          const clampedDistance = Math.max(distance - DIST_MIN, 0);
          const normalizedDistance = Math.min(clampedDistance / (DIST_MAX - DIST_MIN), 1); // prettier-ignore
          rate = DIST_MAX_RATE + normalizedDistance * (DIST_MIN_RATE - DIST_MAX_RATE) // prettier-ignore
          rateCheckedAt = 0;
        }
        should = elapsed >= rate;
      }

      if (should) {
        // HYBRID APPROACH - Asset Forge animation pipeline:

        // Remove the prior additive recoil before the authored mixer writes its
        // next base pose. This prevents accumulation when a clip omits a bone.
        hitReaction.beforeMixerUpdate();

        // Step 1: Update AnimationMixer (animates normalized bones)
        if (mixer) {
          mixer.update(elapsed);
        }

        // Step 1b: Apply a short additive upper-body recoil without replacing
        // locomotion, attacks, or the server-controlled scene transform.
        if (!_deathAnimationActive) {
          hitReaction.afterMixerUpdate(elapsed);
        }

        // Step 2: CRITICAL - Propagate normalized bone transforms to raw bones
        // Bone-axis propagation uses the preserved source rest transforms.
        // Without this, normalized bone changes never reach the visible skeleton
        if (_tvrm?.humanoid?.update) {
          _tvrm.humanoid.update(elapsed);
        } else if (!hasLoggedUpdatePipeline) {
          hasLoggedUpdatePipeline = true;
          console.warn(
            `[VRM] ⚠️ humanoid.update NOT available - animations may not propagate to visible skeleton!`,
          );
        }

        // Step 3: Update skeleton matrices for skinning
        // Use for-loop instead of forEach to avoid callback allocation
        const bones = skeleton.bones;
        for (let i = 0; i < bones.length; i++) {
          bones[i].updateMatrixWorld();
        }
        skeleton.update();

        elapsed = 0;
      }
    };
    // world.updater.add(update)
    interface EmoteData {
      url: string;
      loading: boolean;
      action: THREE.AnimationAction | null;
      startTimeSeconds: number | undefined;
      blendDurationSeconds: number;
    }

    const emotes: { [url: string]: EmoteData } = {
      // [url]: {
      //   url: String
      //   loading: Boolean
      //   action: AnimationAction
      // }
    };
    let currentEmote: EmoteData | null;
    const setEmote = (url: string | null, startTimeSeconds?: number) => {
      if (destroyed) return;
      if (currentEmote?.url === url) {
        currentEmote.startTimeSeconds = startTimeSeconds;
        if (currentEmote.action) {
          const opts = getQueryParams(url || "");
          currentEmote.action.enabled = true;
          currentEmote.action.paused = false;
          applyAnimationActionStartTime(
            currentEmote.action,
            mixer,
            startTimeSeconds,
            opts.l !== "0",
          );
        }
        return;
      }
      if (url?.includes("death") || !url) {
        hitReaction.clear();
      }
      const blendDurationSeconds = avatarEmoteBlendSecondsFor(
        currentEmote?.url,
        url,
      );
      if (currentEmote) {
        fadeOutAvatarEmote(currentEmote.action, blendDurationSeconds);
        // Reset death animation tracking when switching to a different emote
        if (currentEmote.url?.includes("death") && !url?.includes("death")) {
          _deathAnimationActive = false;
          _deathUpdateLogCount = 0;
        }
        currentEmote = null;
      }
      if (!url) {
        _deathAnimationActive = false; // Also reset if emote is cleared
        return;
      }
      const opts = getQueryParams(url);
      const loop = opts.l !== "0";
      const speed = parseFloat(opts.s || "1");

      if (emotes[url]) {
        currentEmote = emotes[url];
        currentEmote.startTimeSeconds = startTimeSeconds;
        currentEmote.blendDurationSeconds = blendDurationSeconds;
        if (currentEmote.action) {
          const action = currentEmote.action;
          // CRITICAL FIX: Fully reset action state before replaying
          // After clampWhenFinished animations complete, they enter a "finished" state
          // that requires explicit enabling and weight reset to play again
          action.stop(); // Stop any current playback
          action.enabled = true; // Ensure action is enabled (disabled after stop in some cases)
          action.setEffectiveWeight(1); // Reset weight in case it was faded out
          action.setEffectiveTimeScale(speed); // Use speed from URL param (e.g. ?s=2.0)
          action.clampWhenFinished = !loop;
          action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
          fadeInAvatarEmote(action, blendDurationSeconds);
          applyAnimationActionStartTime(action, mixer, startTimeSeconds, loop);
          // Track death animation state for update timing
          if (url?.includes("death")) {
            _deathAnimationActive = true;
            _deathUpdateLogCount = 0;
          }
        }
      } else {
        const newEmote: EmoteData = {
          url,
          loading: true,
          action: null,
          startTimeSeconds,
          blendDurationSeconds,
        };
        emotes[url] = newEmote;
        currentEmote = newEmote;
        type LoaderType = {
          load: (
            type: string,
            url: string,
          ) => Promise<{ toClip: (opts: unknown) => THREE.AnimationClip }>;
        };
        (hooks.loader as LoaderType)
          .load("emote", url)
          .then((emo) => {
            if (destroyed) return;
            const retargetedClip = emo.toClip({
              rootToHips,
              version,
              getBoneName,
            });
            const clip = armRetarget
              ? armRetarget.prepareClip(retargetedClip)
              : retargetedClip;
            const action = mixer.clipAction(clip);
            action.timeScale = speed;
            newEmote.action = action;
            newEmote.loading = false;
            // if its still this emote, play it!
            if (currentEmote === newEmote) {
              action.clampWhenFinished = !loop;
              action.setLoop(
                loop ? THREE.LoopRepeat : THREE.LoopOnce,
                Infinity,
              );
              // CRITICAL: Use same reset().fadeIn().play() sequence as cached animations
              // Without this, the animation won't blend properly with the previous one
              fadeInAvatarEmote(action, newEmote.blendDurationSeconds);
              applyAnimationActionStartTime(
                action,
                mixer,
                newEmote.startTimeSeconds,
                loop,
              );
              // Track death animation state for update timing
              if (url?.includes("death")) {
                _deathAnimationActive = true;
                _deathUpdateLogCount = 0;
              }
            }
          })
          .catch((err) => {
            console.error(`[VRM] Failed to load emote:`, url, err);
          });
      }
    };

    const bonesByName = {};
    const findBone = (name) => {
      // name is the official vrm bone name eg 'leftHand'
      // actualName is the actual bone name used in the skeleton which may different across vrms
      // CRITICAL: Use clonedHumanoid (not original humanoid) for bone lookups
      if (!bonesByName[name]) {
        let actualName = "";
        if (clonedHumanoid) {
          const node = clonedHumanoid.getRawBoneNode?.(name);
          actualName = node?.name || "";
        }
        bonesByName[name] = skeleton.getBoneByName(actualName);
      }
      return bonesByName[name];
    };

    let firstPersonActive = false;
    const setFirstPerson = (active) => {
      if (firstPersonActive === active) return;
      const head = findBone("neck");
      if (!head) return;
      head.scale.setScalar(active ? 0 : 1);
      firstPersonActive = active;
    };

    const m1 = new THREE.Matrix4();
    const getBoneTransform = (boneName: string): THREE.Matrix4 | null => {
      const bone = findBone(boneName);
      if (!bone) return null;
      return copyAvatarBoneWorldTransform(m1, bone.matrixWorld);
    };

    // Create a wrapped update function with logging
    const wrappedUpdate = (delta: number) => {
      update(delta);
    };

    return {
      raw: vrm,
      height,
      headToHeight,
      setEmote,
      triggerHitReaction,
      clearHitReaction,
      getHitReactionDiagnostics: () => hitReaction.getDiagnostics(),
      getAuthoredMotionDiagnostics: () =>
        collectAvatarAuthoredMotionDiagnostics(Object.values(emotes)),
      setFirstPerson,
      update: wrappedUpdate,
      getBoneTransform,
      move(_matrix: THREE.Matrix4) {
        matrix.copy(_matrix);
        // CRITICAL: Also update the VRM scene's transform to follow the player
        // Apply 180-degree Y-axis rotation only for VRM 1.0+ models
        // Using pre-allocated matrices to avoid per-frame allocations
        let finalMatrix = _matrix;
        if (isVRM1OrHigher) {
          _rotationMatrix.makeRotationY(Math.PI);
          _tempMatrix1.multiplyMatrices(_matrix, _rotationMatrix);
          finalMatrix = _tempMatrix1;
        }
        // CRITICAL: Compose scale into the matrix to preserve height normalization
        _scaleMatrix.makeScale(
          vrm.scene.scale.x,
          vrm.scene.scale.y,
          vrm.scene.scale.z,
        );
        _tempMatrix2.multiplyMatrices(finalMatrix, _scaleMatrix);

        vrm.scene.matrix.copy(_tempMatrix2);
        vrm.scene.matrixWorld.copy(_tempMatrix2);
        vrm.scene.updateMatrixWorld(true); // Force update all children
        if (hooks?.octree && hooks.octree.move) {
          hooks.octree.move(sItem);
        }
      },
      disableRateCheck() {
        rateCheck = false;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        mixer.stopAllAction();
        mixer.uncacheRoot(vrm.scene);
        armRetarget?.dispose();
        if (hooks?.scene) {
          hooks.scene.remove(vrm.scene);
        }
        // world.updater.remove(update)
        if (hooks?.octree && hooks.octree.remove) {
          hooks.octree.remove(sItem);
        }
      },
    };
  }
}

/**
 * Clone GLB data for multiple instances (HYBRID APPROACH)
 *
 * Uses SkeletonUtils.clone() for efficient cloning:
 * - Shares geometries and textures (memory efficient)
 * - Duplicates skeleton (independent animations)
 * - CLONES VRM humanoid and remaps bone references (for vrm.humanoid.update())
 *
 * This hybrid approach combines:
 * - Asset Forge: normalized bones + vrm.humanoid.update()
 * - Hyperia: efficient cloning for multiple instances
 */
function cloneGLB(glb: GLBData): GLBData {
  // Deep clone the scene (including skeleton and skinned meshes)
  const clonedScene = SkeletonUtils.clone(glb.scene) as THREE.Scene;

  // CRITICAL: Preserve scale from original scene (height normalization)
  clonedScene.scale.copy(glb.scene.scale);
  clonedScene.updateMatrixWorld(true);

  // CRITICAL: Create fresh material instances per clone.
  // SkeletonUtils.clone() shares material references across all clones,
  // which causes highlight bleed (hovering one mob highlights all of same type).
  // Keep authored PBR/physical properties in fresh node materials, without
  // copying runtime TSL graphs or their mutable highlight uniforms. Textures
  // remain shared; colors, vectors and material state belong to each instance.
  clonedScene.traverse((child) => {
    if (!isMeshLike(child)) return;
    const mesh = child as MeshLike;
    const makeFresh = (src: THREE.Material): MeshStandardNodeMaterial => {
      const s = src as MeshStandardNodeMaterial & {
        isMeshPhysicalMaterial?: boolean;
        isMeshPhysicalNodeMaterial?: boolean;
      };
      const physical = s.isMeshPhysicalMaterial || s.isMeshPhysicalNodeMaterial;
      const m = physical
        ? new MeshPhysicalNodeMaterial()
        : new MeshStandardNodeMaterial();
      // NodeMaterial.copy copies node inputs, not the complete authored PBR
      // fields. Use the same classic copy routines as initial normalization;
      // calling node .clone() would also share runtime graph references.
      const copy = physical
        ? THREE.MeshPhysicalMaterial.prototype.copy
        : THREE.MeshStandardMaterial.prototype.copy;
      Reflect.apply(copy, m, [s]);
      return m;
    };
    if (Array.isArray(mesh.material)) {
      mesh.material = (mesh.material as THREE.Material[]).map(makeFresh);
    } else {
      mesh.material = makeFresh(mesh.material);
    }
  });

  const originalVRM = glb.userData?.vrm;

  // If no VRM or no humanoid, just return cloned scene
  if (!originalVRM?.humanoid?.clone) {
    console.warn(
      `[cloneGLB] ⚠️ No humanoid.clone available - returning uncloned VRM reference`,
    );
    return { ...glb, scene: clonedScene };
  }

  // Clone the VRM humanoid
  const clonedHumanoid = originalVRM.humanoid.clone();

  // CRITICAL: Remap humanoid bone references to cloned scene
  remapHumanoidBonesToClonedScene(clonedHumanoid, clonedScene);

  // Create cloned VRM with remapped humanoid
  const clonedVRM = {
    ...originalVRM,
    scene: clonedScene,
    humanoid: clonedHumanoid,
  };

  return {
    ...glb,
    scene: clonedScene,
    userData: { vrm: clonedVRM },
  };
}

/**
 * Remap VRM humanoid bone references to cloned scene
 *
 * After SkeletonUtils.clone(), bones are cloned but VRM humanoid still references
 * original bones. VRMHumanoid.clone() does a SHALLOW clone - the humanBones object
 * is SHARED between all clones!
 *
 * This function:
 * 1. Creates NEW humanBones objects (not shared)
 * 2. Updates bone node references to point to cloned scene's bones
 *
 * CRITICAL: We replace the `humanBones` PROPERTY on the rigs, not the rigs themselves.
 * This preserves the VRMHumanoidRig class methods (getBoneNode, update, etc.)
 */
function remapHumanoidBonesToClonedScene(
  humanoid: {
    _rawHumanBones?: {
      humanBones?: Record<string, { node?: THREE.Object3D }>;
    };
    _normalizedHumanBones?: {
      humanBones?: Record<string, { node?: THREE.Object3D }>;
    };
  },
  clonedScene: THREE.Scene,
): void {
  // Build map of cloned bones by name
  const clonedBonesByName = new Map<string, THREE.Bone>();
  const clonedObjectsByName = new Map<string, THREE.Object3D>();

  clonedScene.traverse((obj) => {
    if (isBoneLike(obj)) {
      clonedBonesByName.set(obj.name, obj);
    }
    // Also track all objects for normalized bones
    if (obj.name) {
      clonedObjectsByName.set(obj.name, obj);
    }
  });

  // Replace only the humanBones property (preserves VRM rig prototype methods).
  // This matches the previously stable behavior used before recent regressions.
  const rawRig = humanoid._rawHumanBones;
  if (rawRig?.humanBones) {
    const newHumanBones: Record<string, { node?: THREE.Object3D }> = {};
    for (const [boneName, boneData] of Object.entries(rawRig.humanBones)) {
      const typedBoneData = boneData as { node?: THREE.Object3D };
      if (typedBoneData?.node) {
        const clonedBone = clonedBonesByName.get(typedBoneData.node.name);
        if (clonedBone) {
          newHumanBones[boneName] = { ...typedBoneData, node: clonedBone };
        } else {
          newHumanBones[boneName] = { ...typedBoneData };
        }
      }
    }
    rawRig.humanBones = newHumanBones;
  }

  // Replace only the humanBones property (preserves VRM rig prototype methods).
  const normRig = humanoid._normalizedHumanBones;
  if (normRig?.humanBones) {
    const newHumanBones: Record<string, { node?: THREE.Object3D }> = {};
    for (const [boneName, boneData] of Object.entries(normRig.humanBones)) {
      const typedBoneData = boneData as { node?: THREE.Object3D };
      if (typedBoneData?.node) {
        const clonedNode = clonedObjectsByName.get(typedBoneData.node.name);
        if (clonedNode) {
          newHumanBones[boneName] = { ...typedBoneData, node: clonedNode };
        } else {
          newHumanBones[boneName] = { ...typedBoneData };
        }
      }
    }
    normRig.humanBones = newHumanBones;
  }
}

function getSkinnedMeshes(scene: THREE.Scene): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    if (isSkinnedMeshLike(o)) {
      meshes.push(o);
    }
  });
  return meshes;
}

function getMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if (isMeshLike(o)) {
      meshes.push(o);
    }
  });
  return meshes;
}

function createCapsule(radius: number, height: number): THREE.BufferGeometry {
  const fullHeight = radius + height + radius;
  const geometry = new THREE.CapsuleGeometry(radius, height);
  geometry.translate(0, fullHeight / 2, 0);
  return geometry;
}

const queryParams = {};
function getQueryParams(url: string): Record<string, string> {
  if (!queryParams[url]) {
    const urlObj = new URL(url);
    const params = {};
    for (const [key, value] of urlObj.searchParams.entries()) {
      params[key] = value;
    }
    queryParams[url] = params;
  }
  return queryParams[url];
}
