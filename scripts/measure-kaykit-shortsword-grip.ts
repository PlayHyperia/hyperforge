import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeIO,
  type Document,
  type Node as GltfNode,
  type Primitive,
} from "@gltf-transform/core";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

import { createSkinnedBoneRegionGeometry } from "./lib/skinned-bone-region";
import { createObjectAxisRegionGeometry } from "./lib/object-axis-region";
import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";
import { resolveStreamingDuelLocomotionEmote } from "../packages/shared/src/data/streamingDuelPresentationEmotes";
import { Emotes } from "../packages/shared/src/data/playerEmotes";

type RegionName = "handle" | "pommel" | "guard" | "blade";
type Tuple3 = [number, number, number];
type EquipmentDocument = {
  scene?: number;
  nodes: Array<{
    name?: string;
    matrix?: number[];
    extras?: { hyperia?: Record<string, unknown> };
  }>;
  scenes: Array<{
    nodes: number[];
    extras?: { hyperia?: Record<string, unknown> };
  }>;
};

export type KnightShortswordGripDefinition = {
  schemaVersion: 1;
  itemId: "bronze_shortsword";
  avatar: {
    id: "kaykit-knight";
    path: string;
    sha256: string;
    normalizedHeightMetres: number;
    vrmHandBone: "rightHand";
    rawHandNode: string;
  };
  equipment: {
    path: string;
    sha256: string;
    sourcePath: string;
    sourceSha256: string;
    contentNodeName: string;
    meshNodeName: string;
    sourceAxis: Tuple3;
    actionEnd: "maximum";
  };
  sourceTriangleRegions: Record<RegionName, Array<[number, number]>>;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactInput(
  workspaceRoot: string,
  relativePath: string,
  digest: string,
): Buffer {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../") ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error(
      "Measurement input must be a normalized relative path and exact SHA-256",
    );
  const bytes = readFileSync(path.join(workspaceRoot, relativePath));
  if (sha256(bytes) !== digest)
    throw new Error(`Measurement source SHA-256 drifted: ${relativePath}`);
  return bytes;
}

function jsonDocument(bytes: Buffer): {
  nodes: Array<{ name?: string }>;
  extensions?: {
    VRMC_vrm?: { humanoid?: { humanBones?: Record<string, { node: number }> } };
  };
} {
  const length = bytes.readUInt32LE(12);
  return JSON.parse(
    bytes
      .subarray(20, 20 + length)
      .toString("utf8")
      .trim(),
  );
}

function geometryFromPrimitive(primitive: Primitive): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [attributeName, sourceName] of [
    ["position", "POSITION"],
    ["skinIndex", "JOINTS_0"],
    ["skinWeight", "WEIGHTS_0"],
  ]) {
    const accessor = primitive.getAttribute(sourceName);
    const array = accessor?.getArray();
    if (!accessor || !array) {
      if (sourceName === "POSITION")
        throw new Error("Source primitive is missing positions");
      continue;
    }
    geometry.setAttribute(
      attributeName,
      new THREE.BufferAttribute(
        array,
        accessor.getElementSize(),
        accessor.getNormalized(),
      ),
    );
  }
  const indices = primitive.getIndices()?.getArray();
  if (!indices) throw new Error("Source primitive is missing indices");
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/** Geometry-only reconstruction: actual node matrices, skin accessors and bind inverses. */
function reconstruct(document: Document) {
  const source = document.getRoot();
  const nodes = source.listNodes();
  const skins = source.listSkins();
  if (source.listScenes().length !== 1 || skins.length > 1)
    throw new Error("Unexpected source scene or skin count");
  const skin = skins[0];
  const joints = skin?.listJoints() ?? [];
  const objects = new Map<GltfNode, THREE.Object3D>();
  for (const node of nodes) {
    const object = joints.includes(node) ? new THREE.Bone() : new THREE.Group();
    object.name = node.getName();
    object.applyMatrix4(new THREE.Matrix4().fromArray(node.getMatrix()));
    objects.set(node, object);
  }
  const objectFor = (node: GltfNode): THREE.Object3D => {
    const object = objects.get(node);
    if (!object) throw new Error("Missing source node");
    return object;
  };
  for (const node of nodes)
    for (const child of node.listChildren())
      objectFor(node).add(objectFor(child));
  const root = new THREE.Group();
  for (const node of source.listScenes()[0].listChildren())
    root.add(objectFor(node));
  root.updateMatrixWorld(true);
  const inverseBindMatrices = skin?.getInverseBindMatrices();
  if (skin && !inverseBindMatrices)
    throw new Error("Missing inverse bind matrices");
  const skeleton =
    skin && inverseBindMatrices
      ? new THREE.Skeleton(
          joints.map((node) => {
            const object = objectFor(node);
            if (!(object instanceof THREE.Bone))
              throw new Error("Joint is not a bone");
            return object;
          }),
          joints.map((_, index) =>
            new THREE.Matrix4().fromArray(
              inverseBindMatrices.getElement(index, []),
            ),
          ),
        )
      : null;
  for (const node of nodes) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const geometry = geometryFromPrimitive(primitive);
      if (node.getSkin()) {
        if (
          node.getSkin() !== skin ||
          !skeleton ||
          !geometry.getAttribute("skinIndex") ||
          !geometry.getAttribute("skinWeight")
        )
          throw new Error("Unexpected or incomplete source skin");
        const mesh = new THREE.SkinnedMesh(geometry);
        objectFor(node).add(mesh);
        mesh.bind(skeleton, new THREE.Matrix4());
      } else objectFor(node).add(new THREE.Mesh(geometry));
    }
  }
  root.updateMatrixWorld(true);
  return {
    root,
    skeleton,
    dispose() {
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          material.dispose();
      });
      skeleton?.dispose();
    },
  };
}

function measureSurfaceContact(
  first: THREE.BufferGeometry,
  second: THREE.BufferGeometry,
) {
  const firstBvh = new MeshBVH(first, { indirect: true, verbose: false });
  const intersects = firstBvh.intersectsGeometry(second, new THREE.Matrix4());
  const a = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const b = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const closest = intersects
    ? null
    : firstBvh.closestPointToGeometry(second, new THREE.Matrix4(), a, b);
  return {
    intersects,
    minimumSurfaceDistanceMetres: intersects
      ? 0
      : closest
        ? a.point.distanceTo(b.point)
        : null,
    closestHandPoint: intersects || !closest ? null : a.point.toArray(),
    closestEquipmentPoint: intersects || !closest ? null : b.point.toArray(),
  };
}

export async function measureKaykitShortswordGrip({
  workspaceRoot,
  definition,
  alignHandleToAuthoredSocket = false,
  useAuthoredSocketOrientation = false,
  seatHandleAgainstSurface = false,
}: {
  workspaceRoot: string;
  definition: KnightShortswordGripDefinition;
  alignHandleToAuthoredSocket?: boolean;
  useAuthoredSocketOrientation?: boolean;
  seatHandleAgainstSurface?: boolean;
}) {
  if (seatHandleAgainstSurface && !useAuthoredSocketOrientation)
    throw new Error("Surface seating requires the exact authored socket frame");
  if (alignHandleToAuthoredSocket && useAuthoredSocketOrientation)
    throw new Error("Candidate placement modes are mutually exclusive");
  if (
    definition.schemaVersion !== 1 ||
    definition.itemId !== "bronze_shortsword" ||
    definition.avatar.id !== "kaykit-knight" ||
    definition.avatar.vrmHandBone !== "rightHand" ||
    definition.equipment.actionEnd !== "maximum" ||
    !Number.isFinite(definition.avatar.normalizedHeightMetres) ||
    definition.avatar.normalizedHeightMetres <= 0
  )
    throw new Error("Unexpected Knight shortsword identity");
  const avatarBytes = exactInput(
    workspaceRoot,
    definition.avatar.path,
    definition.avatar.sha256,
  );
  const equipmentBytes = exactInput(
    workspaceRoot,
    definition.equipment.path,
    definition.equipment.sha256,
  );
  const sourceBytes = exactInput(
    workspaceRoot,
    definition.equipment.sourcePath,
    definition.equipment.sourceSha256,
  );
  const avatarJson = jsonDocument(avatarBytes);
  const rawHandIndex =
    avatarJson.extensions?.VRMC_vrm?.humanoid?.humanBones?.[
      definition.avatar.vrmHandBone
    ]?.node;
  if (
    rawHandIndex === undefined ||
    avatarJson.nodes[rawHandIndex]?.name !== definition.avatar.rawHandNode
  )
    throw new Error("VRM hand mapping disagrees with the actual raw node");
  const io = new NodeIO();
  const avatar = reconstruct(await io.readBinary(avatarBytes));
  const equipmentDocument = await io.readBinary(equipmentBytes);
  const sourceDocument = await io.readBinary(sourceBytes);
  const equipment = reconstruct(equipmentDocument);
  try {
    const node = equipmentDocument
      .getRoot()
      .listNodes()
      .find((entry) => entry.getName() === definition.equipment.meshNodeName);
    const primitive = node?.getMesh()?.listPrimitives()[0];
    const sourcePrimitive = sourceDocument
      .getRoot()
      .listMeshes()[0]
      ?.listPrimitives()[0];
    if (!primitive || !sourcePrimitive)
      throw new Error("Missing exact source primitive");
    if (
      JSON.stringify(node?.getMatrix()) !==
      JSON.stringify(new THREE.Matrix4().toArray())
    )
      throw new Error("Source mesh node must remain in the content frame");
    for (const semantic of ["POSITION", "TEXCOORD_0"]) {
      if (
        JSON.stringify(
          Array.from(primitive.getAttribute(semantic)?.getArray() ?? []),
        ) !==
        JSON.stringify(
          Array.from(sourcePrimitive.getAttribute(semantic)?.getArray() ?? []),
        )
      )
        throw new Error("Installed sword source geometry or UVs changed");
    }
    const positions = primitive.getAttribute("POSITION");
    const uvs = primitive.getAttribute("TEXCOORD_0");
    const indices = primitive.getIndices();
    if (!positions || !uvs || !indices || indices.getCount() % 3 !== 0)
      throw new Error("Incomplete indexed source geometry");
    if (
      JSON.stringify(Array.from(indices.getArray() ?? [])) !==
      JSON.stringify(Array.from(sourcePrimitive.getIndices()?.getArray() ?? []))
    )
      throw new Error("Installed sword source indices changed");
    const sourceAxis = new THREE.Vector3(...definition.equipment.sourceAxis);
    if (Math.abs(sourceAxis.length() - 1) > 1e-12)
      throw new Error("Source action axis is not normalized");
    const assigned = new Set<number>();
    const regions = Object.fromEntries(
      Object.entries(definition.sourceTriangleRegions).map(([name, ranges]) => {
        const triangleIds: number[] = [];
        const projections: number[] = [];
        const centroidProjections: number[] = [];
        const u: number[] = [];
        for (const [start, end] of ranges) {
          if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 0 ||
            end < start ||
            end >= indices.getCount() / 3
          )
            throw new Error("Invalid source triangle range");
          for (let triangle = start; triangle <= end; triangle += 1) {
            if (assigned.has(triangle))
              throw new Error("Source triangle regions overlap");
            assigned.add(triangle);
            triangleIds.push(triangle);
            const projected = [0, 1, 2].map((corner) => {
              const vertex = indices.getScalar(triangle * 3 + corner);
              u.push(uvs.getElement(vertex, [])[0]);
              return new THREE.Vector3()
                .fromArray(positions.getElement(vertex, []))
                .dot(sourceAxis);
            });
            projections.push(...projected);
            centroidProjections.push(
              projected.reduce((sum, value) => sum + value, 0) / 3,
            );
          }
        }
        return [
          name,
          {
            triangleIds,
            triangleCount: triangleIds.length,
            minimumProjection: Math.min(...projections),
            maximumProjection: Math.max(...projections),
            minimumCentroidProjection: Math.min(...centroidProjections),
            maximumCentroidProjection: Math.max(...centroidProjections),
            minimumU: Math.min(...u),
            maximumU: Math.max(...u),
          },
        ];
      }),
    ) as Record<
      RegionName,
      {
        triangleIds: number[];
        triangleCount: number;
        minimumProjection: number;
        maximumProjection: number;
        minimumCentroidProjection: number;
        maximumCentroidProjection: number;
        minimumU: number;
        maximumU: number;
      }
    >;
    if (assigned.size !== indices.getCount() / 3)
      throw new Error(
        "Source triangle regions do not cover the complete sword",
      );
    if (
      regions.pommel.maximumCentroidProjection >=
        regions.handle.minimumCentroidProjection ||
      regions.handle.maximumCentroidProjection >=
        regions.guard.minimumCentroidProjection ||
      regions.guard.maximumCentroidProjection >=
        regions.blade.minimumCentroidProjection
    )
      throw new Error(
        "Handle is not independently separated from pommel, guard and blade centroids",
      );
    const lower =
      (regions.pommel.maximumCentroidProjection +
        regions.handle.minimumCentroidProjection) /
      2;
    const upper =
      (regions.handle.maximumCentroidProjection +
        regions.guard.minimumCentroidProjection) /
      2;
    const gripContact = {
      schemaVersion: 1,
      contentNodeName: definition.equipment.contentNodeName,
      sourceAxis: definition.equipment.sourceAxis,
      actionEnd: definition.equipment.actionEnd,
      zones: [
        {
          id: "primary",
          boneName: definition.avatar.vrmHandBone,
          minimumSourceProjection: lower,
          maximumSourceProjection: upper,
        },
      ],
    };
    const content = equipment.root.getObjectByName(
      definition.equipment.contentNodeName,
    );
    const hand = avatar.root.getObjectByName(definition.avatar.rawHandNode);
    const wrapper = equipment.root.getObjectByName("EquipmentWrapper");
    const handSlot = avatar.root.getObjectByName("handslot.r");
    if (
      !content ||
      !hand ||
      !avatar.skeleton ||
      !wrapper ||
      !handSlot ||
      handSlot.parent?.parent !== hand
    )
      throw new Error("Missing content or actual skinned hand/socket node");
    const unscaledHeight = new THREE.Box3()
      .setFromObject(avatar.root, true)
      .getSize(new THREE.Vector3()).y;
    if (!Number.isFinite(unscaledHeight) || unscaledHeight <= 0)
      throw new Error("Invalid source avatar height");
    avatar.root.scale.setScalar(
      definition.avatar.normalizedHeightMetres / unscaledHeight,
    );
    hand.add(equipment.root);
    avatar.root.updateMatrixWorld(true);
    const handleSourceBox = new THREE.Box3();
    for (const triangle of regions.handle.triangleIds) {
      for (const corner of [0, 1, 2]) {
        handleSourceBox.expandByPoint(
          new THREE.Vector3().fromArray(
            positions.getElement(indices.getScalar(triangle * 3 + corner), []),
          ),
        );
      }
    }
    const sourceHandleCenter = handleSourceBox.getCenter(new THREE.Vector3());
    const originalActionDirection = sourceAxis
      .clone()
      .transformDirection(content.matrixWorld);
    const currentHandleCenterWorld = sourceHandleCenter
      .clone()
      .applyMatrix4(content.matrixWorld);
    const authoredSocketWorld = handSlot.getWorldPosition(new THREE.Vector3());
    const boneLocalTranslation = hand
      .worldToLocal(authoredSocketWorld.clone())
      .sub(hand.worldToLocal(currentHandleCenterWorld.clone()));
    const preservedAttachmentMatrix = wrapper.matrix.toArray();
    if (useAuthoredSocketOrientation) {
      const relativeSocket = hand.matrixWorld
        .clone()
        .invert()
        .multiply(handSlot.matrixWorld);
      const centerOffset = sourceHandleCenter
        .clone()
        .multiply(content.scale)
        .applyMatrix4(relativeSocket);
      const relativeSocketOrigin = new THREE.Vector3().setFromMatrixPosition(
        relativeSocket,
      );
      relativeSocket.setPosition(
        relativeSocketOrigin.sub(centerOffset.sub(relativeSocketOrigin)),
      );
      relativeSocket.decompose(
        wrapper.position,
        wrapper.quaternion,
        wrapper.scale,
      );
      avatar.root.updateMatrixWorld(true);
    } else if (alignHandleToAuthoredSocket) {
      wrapper.position.add(boneLocalTranslation);
      avatar.root.updateMatrixWorld(true);
    }
    const actualActionDirection = sourceAxis
      .clone()
      .transformDirection(content.matrixWorld);
    const actionDirectionDeviationDegrees = THREE.MathUtils.radToDeg(
      originalActionDirection.angleTo(actualActionDirection),
    );
    const wristOnly = createSkinnedBoneRegionGeometry(avatar.root, hand);
    const handRegion = createSkinnedBoneRegionGeometry(avatar.root, hand, 0.5, {
      includeDescendantSkinBones: true,
    });
    let handleRegion = createObjectAxisRegionGeometry(
      content,
      sourceAxis,
      lower,
      upper,
    );
    let entireSword = createObjectAxisRegionGeometry(
      content,
      sourceAxis,
      -Number.MAX_VALUE,
      Number.MAX_VALUE,
    );
    try {
      if (
        handleRegion.triangleCount !== regions.handle.triangleCount ||
        handRegion.triangleCount === 0
      )
        throw new Error(
          "Semantic handle or actual hand-region geometry is empty or mismatched",
        );
      let handContact = measureSurfaceContact(
        handRegion.geometry,
        handleRegion.geometry,
      );
      const unseatedHandContact = handContact;
      let seating: {
        worldTranslation: number[];
        boneLocalTranslation: number[];
        numericalInsetMetres: number;
      } | null = null;
      if (seatHandleAgainstSurface && !handContact.intersects) {
        if (
          !handContact.closestHandPoint ||
          !handContact.closestEquipmentPoint ||
          handContact.minimumSurfaceDistanceMetres === null
        )
          throw new Error(
            "Cannot derive a finite closest-surface seating displacement",
          );
        const towardHand = new THREE.Vector3()
          .fromArray(handContact.closestHandPoint)
          .sub(
            new THREE.Vector3().fromArray(handContact.closestEquipmentPoint),
          );
        // Four Float32 coordinate ULPs resolve the tangent-contact ambiguity of
        // the triangle soups. This changes placement, never a contact threshold.
        const maximumCoordinate = Math.max(
          ...handContact.closestHandPoint.map(Math.abs),
          ...handContact.closestEquipmentPoint.map(Math.abs),
        );
        const numericalInsetMetres =
          4 * 2 ** (Math.floor(Math.log2(maximumCoordinate)) - 23);
        towardHand.setLength(towardHand.length() + numericalInsetMetres);
        const boneLocalDelta = hand
          .worldToLocal(towardHand.clone())
          .sub(hand.worldToLocal(new THREE.Vector3()));
        wrapper.position.add(boneLocalDelta);
        avatar.root.updateMatrixWorld(true);
        handleRegion.geometry.dispose();
        entireSword.geometry.dispose();
        handleRegion = createObjectAxisRegionGeometry(
          content,
          sourceAxis,
          lower,
          upper,
        );
        entireSword = createObjectAxisRegionGeometry(
          content,
          sourceAxis,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
        );
        handContact = measureSurfaceContact(
          handRegion.geometry,
          handleRegion.geometry,
        );
        seating = {
          worldTranslation: towardHand.toArray(),
          boneLocalTranslation: boneLocalDelta.toArray(),
          numericalInsetMetres,
        };
      }
      const wholeSwordContact = measureSurfaceContact(
        handRegion.geometry,
        entireSword.geometry,
      );
      const excludedRegionContacts = Object.fromEntries(
        (["pommel", "guard", "blade"] as const).map((name) => {
          const region = regions[name];
          const vertices: number[] = [];
          for (const triangle of region.triangleIds) {
            for (const corner of [0, 1, 2]) {
              vertices.push(
                ...new THREE.Vector3()
                  .fromArray(
                    positions.getElement(
                      indices.getScalar(triangle * 3 + corner),
                      [],
                    ),
                  )
                  .applyMatrix4(content.matrixWorld)
                  .toArray(),
              );
            }
          }
          const geometry = new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(vertices, 3),
          );
          try {
            return [
              name,
              {
                triangleCount: region.triangleCount,
                ...measureSurfaceContact(handRegion.geometry, geometry),
              },
            ];
          } finally {
            geometry.dispose();
          }
        }),
      );
      return {
        schemaVersion: 1,
        status: handContact.intersects
          ? "bind-pose-handle-contact-observed-not-visual-approval"
          : "bind-pose-handle-contact-failed",
        inputs: {
          avatar: {
            path: definition.avatar.path,
            sha256: definition.avatar.sha256,
          },
          installedEquipment: {
            path: definition.equipment.path,
            sha256: definition.equipment.sha256,
          },
          sourceEquipment: {
            path: definition.equipment.sourcePath,
            sha256: definition.equipment.sourceSha256,
          },
        },
        scope:
          "Geometry-only source bind pose; no VRM loader, authored emote retargeting, renderer, streaming or finger-closure approval.",
        sourceRegions: regions,
        gripContact,
        avatarGeometry: {
          unscaledHeightMetres: unscaledHeight,
          normalizationScale: avatar.root.scale.x,
          skinJointCount: avatar.skeleton.bones.length,
          mappedWristTriangleCount: wristOnly.triangleCount,
          descendantHandTriangleCount: handRegion.triangleCount,
          sourceSkinnedMeshCount: handRegion.sourceMeshCount,
          selectedSkinBones: avatar.skeleton.bones
            .filter((bone) => {
              let parent: THREE.Object3D | null = bone;
              while (parent) {
                if (parent === hand) return true;
                parent = parent.parent;
              }
              return false;
            })
            .map((bone) => bone.name),
        },
        handleTriangleCount: handleRegion.triangleCount,
        handContact,
        wholeSwordContact,
        excludedRegionContacts,
        placement: {
          variant: seatHandleAgainstSurface
            ? "authored-socket-surface-seated-candidate"
            : useAuthoredSocketOrientation
              ? "authored-socket-frame-candidate"
              : alignHandleToAuthoredSocket
                ? "translation-only-authored-socket-candidate"
                : "preserved-installed-fit",
          sourceHandleCenter: sourceHandleCenter.toArray(),
          authoredSocketNode: handSlot.name,
          proposedBoneLocalTranslation: boneLocalTranslation.toArray(),
          appliedTranslation:
            alignHandleToAuthoredSocket || useAuthoredSocketOrientation,
          originalActionDirectionWorld: originalActionDirection.toArray(),
          candidateActionDirectionWorld: actualActionDirection.toArray(),
          actionDirectionDeviationDegrees,
          unseatedHandContact,
          seating,
          handleCenterToAuthoredSocketDistanceMetres: sourceHandleCenter
            .clone()
            .applyMatrix4(content.matrixWorld)
            .distanceTo(authoredSocketWorld),
          preservedAttachmentMatrix,
          measuredAttachmentMatrix: wrapper.matrix.toArray(),
        },
        unchangedContentScale: content.scale.toArray(),
      };
    } finally {
      wristOnly.geometry.dispose();
      handRegion.geometry.dispose();
      handleRegion.geometry.dispose();
      entireSword.geometry.dispose();
    }
  } finally {
    equipment.root.removeFromParent();
    equipment.dispose();
    avatar.dispose();
  }
}

/** Produces isolated bytes only; callers choose a candidate-only destination. */
export function buildKnightShortswordGripCandidate({
  workspaceRoot,
  definition,
  measurement,
}: {
  workspaceRoot: string;
  definition: KnightShortswordGripDefinition;
  measurement: Awaited<ReturnType<typeof measureKaykitShortswordGrip>>;
}) {
  const source = exactInput(
    workspaceRoot,
    definition.equipment.path,
    definition.equipment.sha256,
  );
  if (
    measurement.inputs.installedEquipment.sha256 !==
      definition.equipment.sha256 ||
    measurement.inputs.avatar.sha256 !== definition.avatar.sha256
  )
    throw new Error("Candidate measurement source identity drifted");
  const sourceJsonLength = source.readUInt32LE(12);
  const original = JSON.parse(
    source
      .subarray(20, 20 + sourceJsonLength)
      .toString("utf8")
      .trim(),
  ) as EquipmentDocument;
  const document = structuredClone(original);
  const scene = document.scenes[document.scene ?? 0];
  const wrapper = document.nodes.find(
    (node) => node.name === "EquipmentWrapper",
  );
  if (!wrapper?.matrix || !wrapper.extras?.hyperia || !scene)
    throw new Error("Candidate requires exact existing fitted wrapper");
  const preserved = measurement.placement.variant === "preserved-installed-fit";
  if (!preserved)
    wrapper.matrix = [...measurement.placement.measuredAttachmentMatrix];
  const metadata = {
    ...wrapper.extras.hyperia,
    relativeMatrix: [...wrapper.matrix],
    gripContact: structuredClone(measurement.gripContact),
    usage:
      "Isolated unapproved Knight shortsword contact diagnostic; not an active launch asset or visual fit certification.",
    ...(preserved
      ? {}
      : {
          fitReference: {
            schemaVersion: 2,
            method: measurement.placement.variant,
            sourceEquipmentPath: definition.equipment.path,
            sourceEquipmentSha256: definition.equipment.sha256,
            avatarPath: definition.avatar.path,
            avatarSha256: definition.avatar.sha256,
            authoredSocketNode: measurement.placement.authoredSocketNode,
            sourceHandleCenter: measurement.placement.sourceHandleCenter,
            seating: measurement.placement.seating,
            productApproved: false,
          },
        }),
  };
  wrapper.extras.hyperia = metadata;
  scene.extras = { ...scene.extras, hyperia: structuredClone(metadata) };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const header = Buffer.from(source.subarray(0, 20));
  const nonJsonChunks = source.subarray(20 + sourceJsonLength);
  header.writeUInt32LE(20 + paddedJson.length + nonJsonChunks.length, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  const candidate = Buffer.concat([header, paddedJson, nonJsonChunks]);
  const certified = certifyRigidDuelEquipmentGlb(candidate, {
    itemId: definition.itemId,
    avatarId: definition.avatar.id,
    legacyAvatarId: definition.avatar.id,
    slot: "weapon",
    gripContact: measurement.gripContact,
  }) as {
    output: Buffer;
    report: {
      structuralDocumentSha256: string;
      nonJsonChunksSha256: Array<{ type: number; sha256: string }>;
    };
  };
  const outputJsonLength = certified.output.readUInt32LE(12);
  if (!certified.output.subarray(20 + outputJsonLength).equals(nonJsonChunks))
    throw new Error("Candidate changed non-JSON chunks");
  const clean = (value: EquipmentDocument) => {
    const copy = structuredClone(value);
    for (const node of copy.nodes)
      if (node.name === "EquipmentWrapper") delete node.extras;
    for (const entry of copy.scenes) delete entry.extras;
    return copy;
  };
  const expected = clean(original);
  const expectedWrapper = expected.nodes.find(
    (node) => node.name === "EquipmentWrapper",
  );
  if (!expectedWrapper) throw new Error("Missing expected wrapper");
  expectedWrapper.matrix = wrapper.matrix;
  const actual = clean(
    JSON.parse(
      certified.output
        .subarray(20, 20 + outputJsonLength)
        .toString("utf8")
        .trim(),
    ) as EquipmentDocument,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "Candidate changed geometry or an unapproved node transform",
    );
  return {
    output: certified.output,
    report: {
      schemaVersion: 1,
      variant: measurement.placement.variant,
      productApproved: false,
      sourcePath: definition.equipment.path,
      sourceSha256: definition.equipment.sha256,
      candidateSha256: sha256(certified.output),
      candidateBytes: certified.output.length,
      preservedNonJsonChunks: true,
      preservedNonWrapperTransforms: true,
      preservedAllTransforms: preserved,
      relativeMatrix: wrapper.matrix,
      structuralDocumentSha256: certified.report.structuralDocumentSha256,
      nonJsonChunksSha256: certified.report.nonJsonChunksSha256,
      gripContact: measurement.gripContact,
    },
  };
}

/** Reproducible, fixed candidate-only destinations. Existing different bytes are never overwritten. */
export async function generateKnightShortswordGripEvidence(
  workspaceRoot: string,
  definition: KnightShortswordGripDefinition,
) {
  const artifactRoot =
    "artifacts/duel-launch-avatar-bakeoff/kaykit-shortsword-contact-20260905";
  const candidateRoot =
    "packages/server/world/assets/models/candidates/kaykit-shortsword-contact-20260905";
  const assetsRoot = "packages/server/world/assets";
  const measurements = await Promise.all([
    measureKaykitShortswordGrip({ workspaceRoot, definition }),
    measureKaykitShortswordGrip({
      workspaceRoot,
      definition,
      alignHandleToAuthoredSocket: true,
    }),
    measureKaykitShortswordGrip({
      workspaceRoot,
      definition,
      useAuthoredSocketOrientation: true,
    }),
    measureKaykitShortswordGrip({
      workspaceRoot,
      definition,
      useAuthoredSocketOrientation: true,
      seatHandleAgainstSurface: true,
    }),
  ]);
  const data = {
    inStreamingDuel: true,
    streamingDuelCombatRole: "melee",
    streamingDuelWeaponId: definition.itemId,
  };
  const runtimeUrls = {
    idle: resolveStreamingDuelLocomotionEmote("idle", data),
    walk: resolveStreamingDuelLocomotionEmote("walk", data),
    run: resolveStreamingDuelLocomotionEmote("run", data),
    sword: Emotes.SWORD_SWING,
  };
  const runtimeAssets = Object.fromEntries(
    Object.entries(runtimeUrls).map(([role, url]) => {
      if (!url?.startsWith("asset://"))
        throw new Error("Missing current runtime one-hand emote");
      const asset = url.slice("asset://".length).split("?")[0];
      const bytes = readFileSync(path.join(workspaceRoot, assetsRoot, asset));
      return [role, { url, asset, sha256: sha256(bytes) }];
    }),
  ) as Record<
    keyof typeof runtimeUrls,
    { url: string; asset: string; sha256: string }
  >;
  const planned = new Map<string, Buffer>();
  const json = (destination: string, value: unknown) =>
    planned.set(
      destination,
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    );
  for (const measurement of measurements)
    json(
      `${artifactRoot}/${measurement.placement.variant}.measurement.json`,
      measurement,
    );
  const candidates = [measurements[0], measurements[3]].map((measurement) => {
    const result = buildKnightShortswordGripCandidate({
      workspaceRoot,
      definition,
      measurement,
    });
    const candidatePath = `${candidateRoot}/${measurement.placement.variant}.glb`;
    planned.set(candidatePath, result.output);
    json(`${artifactRoot}/${measurement.placement.variant}.candidate.json`, {
      ...result.report,
      candidatePath,
    });
    const equipmentSetPath = `${artifactRoot}/${measurement.placement.variant}.equipment-set.json`;
    json(equipmentSetPath, {
      schemaVersion: 1,
      title: `Knight shortsword UNAPPROVED diagnostic: ${measurement.placement.variant}`,
      equipments: [
        {
          asset: path.posix.relative(assetsRoot, candidatePath),
          itemId: definition.itemId,
          avatarId: definition.avatar.id,
          slot: "weapon",
          grip: "one-hand",
        },
      ],
    });
    return {
      candidatePath,
      sha256: result.report.candidateSha256,
      equipmentSetPath,
    };
  });
  const views = [
    ["front", 0],
    ["right", 90],
    ["rear", 180],
    ["left", -90],
  ] as const;
  const closeMotions = (["idle", "impact"] as const).flatMap((role) =>
    views.map(([view, yaw]) => ({
      id: `${role}-grip-${view}`,
      name: `${role} grip ${view}`,
      asset: runtimeAssets[role === "idle" ? "idle" : "sword"].asset,
      sampleRatio: role === "idle" ? 0.35 : 0.45,
      cameraYawDegrees: yaw,
      cameraPitchDegrees: 4,
      cameraTarget: "primary-grip",
    })),
  );
  const phaseRoles = [
    ["idle", "idle", 0.35],
    ["walk", "walk", 0.15],
    ["run", "run", 0.75],
    ["swing-windup", "sword", 0.15],
    ["swing-impact", "sword", 0.45],
    ["swing-recovery", "sword", 0.85],
  ] as const;
  const phaseMotions = phaseRoles.flatMap(([name, role, ratio]) =>
    [
      ["front", 0],
      ["side", 90],
    ].map(([view, yaw]) => ({
      id: `${name}-${view}`,
      name: `${name} ${view}`,
      asset: runtimeAssets[role].asset,
      sampleRatio: ratio,
      cameraYawDegrees: yaw,
    })),
  );
  json(`${artifactRoot}/knight-shortsword-close-audit.json`, {
    schemaVersion: 1,
    title:
      "Knight shortsword current-runtime close grip: unapproved diagnostic",
    framing: "avatar-and-equipment",
    motions: closeMotions,
  });
  json(`${artifactRoot}/knight-shortsword-motion-audit.json`, {
    schemaVersion: 1,
    title:
      "Knight shortsword current-runtime locomotion and swing phases: unapproved diagnostic",
    framing: "avatar-and-equipment",
    motions: phaseMotions,
  });
  const inputs = {
    schemaVersion: 1,
    productApproved: false,
    avatar: definition.avatar,
    candidates,
    runtimeAssets,
    runtimeMapping:
      "Current streamingDuelPresentationEmotes resolver and playerEmotes.SWORD_SWING; no avatar-specific emote override exists in the Knight registry entry. Query speed/loop settings retained above; still-frame phase audits use exact clip bytes, not elapsed-time or transition acceptance.",
    requiredVisualJudgment: [
      "Hand must visibly enclose wrapped handle, never blade",
      "Guard and pommel intersections must be inspected, not counted as handle success",
      "Blade must point away from palm and body throughout real retargeted motion",
      "Current duel idle, locomotion, windup, representative impact and recovery must be evaluated; fixed samples are not continuous transition or full-game proof",
    ],
    generatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    definitionSha256: sha256(
      readFileSync(
        path.join(
          workspaceRoot,
          "scripts/kaykit-shortsword-semantic-grip-definition.json",
        ),
      ),
    ),
    files: Array.from(planned, ([destination, bytes]) => ({
      path: destination,
      sha256: sha256(bytes),
      bytes: bytes.length,
    })),
  };
  json(`${artifactRoot}/inputs.json`, inputs);
  // Check every existing destination before creating any new evidence bytes.
  for (const [destination, bytes] of planned) {
    const target = path.join(workspaceRoot, destination);
    if (existsSync(target) && !readFileSync(target).equals(bytes))
      throw new Error(
        `Refusing to overwrite different sealed candidate evidence: ${destination}`,
      );
  }
  for (const [destination, bytes] of planned) {
    const target = path.join(workspaceRoot, destination);
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, bytes, { flag: "wx" });
  }
  return inputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const definition = JSON.parse(
    readFileSync(
      path.join(
        workspaceRoot,
        "scripts/kaykit-shortsword-semantic-grip-definition.json",
      ),
      "utf8",
    ),
  ) as KnightShortswordGripDefinition;
  if (
    process.argv
      .slice(2)
      .some(
        (argument) =>
          ![
            "--candidate-translation",
            "--candidate-authored-socket",
            "--seat-handle",
            "--generate-evidence",
          ].includes(argument),
      )
  )
    throw new Error("Unknown measurement argument");
  if (process.argv.includes("--generate-evidence")) {
    if (process.argv.length !== 3)
      throw new Error(
        "Evidence generation cannot be combined with placement flags",
      );
    process.stdout.write(
      `${JSON.stringify(await generateKnightShortswordGripEvidence(workspaceRoot, definition), null, 2)}\n`,
    );
  } else
    process.stdout.write(
      `${JSON.stringify(await measureKaykitShortswordGrip({ workspaceRoot, definition, alignHandleToAuthoredSocket: process.argv.includes("--candidate-translation"), useAuthoredSocketOrientation: process.argv.includes("--candidate-authored-socket"), seatHandleAgainstSurface: process.argv.includes("--seat-handle") }), null, 2)}\n`,
    );
}
