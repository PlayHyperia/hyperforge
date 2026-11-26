import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";

import { validateStreamingEquipmentVisualModel } from "../../../shared/src/systems/client/EquipmentVisualHelpers";
import { validatePublishedArmorGlb } from "../../server/services/armor-pipeline/DuelFitMetadata";
import {
  createSkeletonRigFingerprint,
  ShellRiggingService,
} from "../../src/services/armor-pipeline/ShellRiggingService";
import type { RiggedArmorResult } from "../../src/services/armor-pipeline/types";

beforeAll(() => {
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  }

  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: NodeFileReader,
  });
});

function createSkeleton(
  options: {
    childIsRoot?: boolean;
    inverseOffset?: number;
  } = {},
): THREE.Skeleton {
  const hips = new THREE.Bone();
  hips.name = "hips";
  const spine = new THREE.Bone();
  spine.name = "spine";
  if (!options.childIsRoot) hips.add(spine);
  const inverses = [
    new THREE.Matrix4(),
    new THREE.Matrix4().makeTranslation(options.inverseOffset ?? 0, 0, 0),
  ];
  return new THREE.Skeleton([hips, spine], inverses);
}

describe("createSkeletonRigFingerprint", () => {
  it("is stable for an equivalent ordered hierarchy and rest pose", async () => {
    const first = await createSkeletonRigFingerprint(createSkeleton());
    const second = await createSkeletonRigFingerprint(createSkeleton());
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
  });

  it("changes when hierarchy or inverse bind pose changes", async () => {
    const baseline = await createSkeletonRigFingerprint(createSkeleton());
    await expect(
      createSkeletonRigFingerprint(createSkeleton({ inverseOffset: 0.25 })),
    ).resolves.not.toBe(baseline);
    await expect(
      createSkeletonRigFingerprint(createSkeleton({ childIsRoot: true })),
    ).resolves.not.toBe(baseline);
  });

  it("rejects incomplete, ambiguous, or non-finite rig authority", async () => {
    const incomplete = createSkeleton();
    incomplete.boneInverses = [];
    await expect(createSkeletonRigFingerprint(incomplete)).rejects.toThrow(
      "complete inverse bind pose",
    );

    const duplicateNames = createSkeleton();
    duplicateNames.bones[1].name = "hips";
    await expect(createSkeletonRigFingerprint(duplicateNames)).rejects.toThrow(
      "non-empty and unique",
    );

    const nonFinite = createSkeleton();
    nonFinite.boneInverses[1].elements[0] = Number.NaN;
    await expect(createSkeletonRigFingerprint(nonFinite)).rejects.toThrow(
      "non-finite",
    );
  });
});

describe("ShellRiggingService competitive export", () => {
  it("exports loader-visible metadata accepted by the publish gate", async () => {
    const skeleton = createSkeleton();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    const skinnedMesh = new THREE.SkinnedMesh(
      geometry,
      new THREE.MeshBasicMaterial(),
    );
    skinnedMesh.bind(skeleton, new THREE.Matrix4());
    const result: RiggedArmorResult = {
      skinnedMesh,
      skeleton,
      slotName: "body",
      bulkClass: "plate",
      vertexMatch: true,
      vertexCount: 3,
    };

    const blob = await new ShellRiggingService().exportRiggedGLB(result, {
      itemId: "bronze_platebody",
      compatibleAvatarIds: ["steve"],
    });
    const duelFit = validatePublishedArmorGlb(
      new Uint8Array(await blob.arrayBuffer()),
      { itemId: "bronze_platebody", slot: "body" },
    );

    expect(duelFit.compatibleAvatarIds).toEqual(["steve"]);
    expect(duelFit.rigFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const parsed = await new GLTFLoader().parseAsync(
      await blob.arrayBuffer(),
      "",
    );
    const targetSkeleton = createSkeleton();
    const targetMesh = new THREE.SkinnedMesh(
      geometry.clone(),
      new THREE.MeshBasicMaterial(),
    );
    targetMesh.bind(targetSkeleton, new THREE.Matrix4());
    const targetScene = new THREE.Group();
    targetScene.add(targetMesh);
    expect(
      validateStreamingEquipmentVisualModel(parsed.scene, "body", {
        itemId: "bronze_platebody",
        avatarId: "steve",
        vrm: { scene: targetScene } as unknown as VRM,
      }),
    ).toEqual({ valid: true, reason: null });
  });
});
