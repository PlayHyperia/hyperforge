#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import validator from "gltf-validator";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RIGID_EQUIPMENT_SLOTS = new Set(["weapon", "shield", "gatheringtool"]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseGlb(input) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 20 ||
    input.readUInt32LE(0) !== GLB_MAGIC ||
    input.readUInt32LE(4) !== GLB_VERSION ||
    input.readUInt32LE(8) !== input.length
  ) {
    throw new Error("Input is not a complete GLB v2 file");
  }
  const chunks = [];
  let offset = 12;
  while (offset < input.length) {
    if (offset + 8 > input.length)
      throw new Error("Truncated GLB chunk header");
    const length = input.readUInt32LE(offset);
    const type = input.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (length % 4 !== 0 || end > input.length) {
      throw new Error("Malformed GLB chunk");
    }
    chunks.push({ type, data: Buffer.from(input.subarray(offset + 8, end)) });
    offset = end;
  }
  const jsonChunks = chunks.filter((chunk) => chunk.type === JSON_CHUNK_TYPE);
  if (jsonChunks.length !== 1 || chunks[0]?.type !== JSON_CHUNK_TYPE) {
    throw new Error("GLB must have one leading JSON chunk");
  }
  const document = JSON.parse(
    jsonChunks[0].data.toString("utf8").replace(/[\0\x20]+$/u, ""),
  );
  if (!isRecord(document)) throw new Error("GLB JSON root must be an object");
  return { document, chunks };
}

function encodeGlb(document, chunks) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const outputChunks = [
    { type: JSON_CHUNK_TYPE, data: paddedJson },
    ...chunks.filter((chunk) => chunk.type !== JSON_CHUNK_TYPE),
  ];
  const length =
    12 + outputChunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(length);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(length, 8);
  let offset = 12;
  for (const chunk of outputChunks) {
    output.writeUInt32LE(chunk.data.length, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    offset += 8 + chunk.data.length;
  }
  return output;
}

function accessorDataView(document, binary, accessorIndex, label) {
  const accessor = document.accessors?.[accessorIndex];
  const bufferView = document.bufferViews?.[accessor?.bufferView];
  if (
    !isRecord(accessor) ||
    !isRecord(bufferView) ||
    bufferView.buffer !== 0 ||
    accessor.sparse !== undefined
  ) {
    throw new Error(`${label} accessor is unsupported`);
  }
  const byteOffset =
    (Number.isInteger(bufferView.byteOffset) ? bufferView.byteOffset : 0) +
    (Number.isInteger(accessor.byteOffset) ? accessor.byteOffset : 0);
  return {
    accessor,
    bufferView,
    view: new DataView(
      binary.buffer,
      binary.byteOffset + byteOffset,
      binary.byteLength - byteOffset,
    ),
    byteStride: Number.isInteger(bufferView.byteStride)
      ? bufferView.byteStride
      : null,
  };
}

function averagePoints(points) {
  if (points.length < 1) throw new Error("Cannot average an empty point set");
  const result = [0, 0, 0];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) result[axis] += point[axis];
  }
  return result.map((value) => value / points.length);
}

export function detectStaticBowStringComponents(components, globalBounds) {
  if (
    !Array.isArray(components) ||
    components.length < 1 ||
    !isRecord(globalBounds) ||
    !Array.isArray(globalBounds.minimum) ||
    !Array.isArray(globalBounds.maximum)
  ) {
    throw new Error("Bow component bounds are invalid");
  }
  const globalSize = globalBounds.maximum.map(
    (value, axis) => value - globalBounds.minimum[axis],
  );
  if (
    globalSize.length !== 3 ||
    globalSize.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("Bow global bounds must have three positive dimensions");
  }
  const longitudinalAxis = globalSize.indexOf(Math.max(...globalSize));
  const crossAxes = [0, 1, 2].filter((axis) => axis !== longitudinalAxis);
  const minimumStringLength = globalSize[longitudinalAxis] * 0.75;
  const maximumStringThickness = globalSize[longitudinalAxis] * 0.02;
  const stringComponents = components.filter((component) => {
    if (
      !isRecord(component) ||
      !Array.isArray(component.minimum) ||
      !Array.isArray(component.maximum)
    ) {
      return false;
    }
    const size = component.maximum.map(
      (value, axis) => value - component.minimum[axis],
    );
    return (
      size.length === 3 &&
      size.every((value) => Number.isFinite(value) && value >= 0) &&
      size[longitudinalAxis] >= minimumStringLength &&
      crossAxes.every((axis) => size[axis] <= maximumStringThickness)
    );
  });
  return {
    longitudinalAxis,
    minimumStringLength,
    maximumStringThickness,
    stringComponents,
  };
}

/**
 * Remove only the disconnected, thread-thin components that form the source
 * bowstring. The bow body, materials, texture data, and every vertex attribute
 * remain byte-identical; only the primitive's index stream is replaced.
 */
export function stripStaticBowStringGlb(input) {
  const parsed = parseGlb(input);
  const document = cloneJson(parsed.document);
  const binaryChunks = parsed.chunks.filter(
    (chunk) => chunk.type !== JSON_CHUNK_TYPE,
  );
  if (binaryChunks.length !== 1 || !Array.isArray(document.buffers)) {
    throw new Error("Bow source must contain one embedded binary buffer");
  }
  const primitives = (document.meshes ?? []).flatMap((mesh) =>
    Array.isArray(mesh?.primitives) ? mesh.primitives : [],
  );
  if (primitives.length !== 1) {
    throw new Error("Bow source must contain exactly one primitive");
  }
  const primitive = primitives[0];
  if (
    !isRecord(primitive) ||
    (primitive.mode !== undefined && primitive.mode !== 4) ||
    !isRecord(primitive.attributes) ||
    !Number.isInteger(primitive.attributes.POSITION) ||
    !Number.isInteger(primitive.indices)
  ) {
    throw new Error("Bow source primitive must be indexed triangles");
  }
  const binary = binaryChunks[0].data;
  const positions = accessorDataView(
    document,
    binary,
    primitive.attributes.POSITION,
    "POSITION",
  );
  if (
    positions.accessor.componentType !== 5126 ||
    positions.accessor.type !== "VEC3" ||
    !Number.isInteger(positions.accessor.count)
  ) {
    throw new Error("Bow POSITION accessor must be finite VEC3 float data");
  }
  const vertexCount = positions.accessor.count;
  const positionStride = positions.byteStride ?? 12;
  const pointAt = (index) => [
    positions.view.getFloat32(index * positionStride, true),
    positions.view.getFloat32(index * positionStride + 4, true),
    positions.view.getFloat32(index * positionStride + 8, true),
  ];
  const points = Array.from({ length: vertexCount }, (_, index) =>
    pointAt(index),
  );
  if (points.some((point) => point.some((value) => !Number.isFinite(value)))) {
    throw new Error("Bow POSITION accessor contains non-finite data");
  }

  const indices = accessorDataView(
    document,
    binary,
    primitive.indices,
    "indices",
  );
  if (
    indices.accessor.type !== "SCALAR" ||
    !Number.isInteger(indices.accessor.count) ||
    indices.accessor.count % 3 !== 0 ||
    ![5121, 5123, 5125].includes(indices.accessor.componentType)
  ) {
    throw new Error("Bow index accessor must contain triangle indices");
  }
  const indexBytes = { 5121: 1, 5123: 2, 5125: 4 }[
    indices.accessor.componentType
  ];
  const indexStride = indices.byteStride ?? indexBytes;
  const readIndex = (index) => {
    const offset = index * indexStride;
    if (indexBytes === 1) return indices.view.getUint8(offset);
    if (indexBytes === 2) return indices.view.getUint16(offset, true);
    return indices.view.getUint32(offset, true);
  };
  const sourceIndices = Array.from(
    { length: indices.accessor.count },
    (_, index) => readIndex(index),
  );
  if (sourceIndices.some((index) => index >= vertexCount)) {
    throw new Error("Bow index accessor references an invalid vertex");
  }

  const parents = Int32Array.from({ length: vertexCount }, (_, index) => index);
  const find = (inputIndex) => {
    let index = inputIndex;
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (leftInput, rightInput) => {
    const left = find(leftInput);
    const right = find(rightInput);
    if (left !== right) parents[right] = left;
  };
  for (let index = 0; index < sourceIndices.length; index += 3) {
    union(sourceIndices[index], sourceIndices[index + 1]);
    union(sourceIndices[index + 1], sourceIndices[index + 2]);
  }
  const components = new Map();
  const globalBounds = {
    minimum: [Infinity, Infinity, Infinity],
    maximum: [-Infinity, -Infinity, -Infinity],
  };
  for (let index = 0; index < vertexCount; index += 1) {
    const root = find(index);
    const component = components.get(root) ?? {
      vertexIndices: [],
      minimum: [Infinity, Infinity, Infinity],
      maximum: [-Infinity, -Infinity, -Infinity],
    };
    component.vertexIndices.push(index);
    for (let axis = 0; axis < 3; axis += 1) {
      component.minimum[axis] = Math.min(
        component.minimum[axis],
        points[index][axis],
      );
      component.maximum[axis] = Math.max(
        component.maximum[axis],
        points[index][axis],
      );
      globalBounds.minimum[axis] = Math.min(
        globalBounds.minimum[axis],
        points[index][axis],
      );
      globalBounds.maximum[axis] = Math.max(
        globalBounds.maximum[axis],
        points[index][axis],
      );
    }
    components.set(root, component);
  }
  const stringDetection = detectStaticBowStringComponents(
    [...components.values()],
    globalBounds,
  );
  const { longitudinalAxis, stringComponents } = stringDetection;
  if (stringComponents.length < 1) {
    throw new Error("No deterministic static bowstring components were found");
  }
  const removedVertices = new Set(
    stringComponents.flatMap((component) => component.vertexIndices),
  );
  const keptIndices = [];
  let removedTriangleCount = 0;
  for (let index = 0; index < sourceIndices.length; index += 3) {
    const triangle = sourceIndices.slice(index, index + 3);
    if (triangle.every((vertex) => removedVertices.has(vertex))) {
      removedTriangleCount += 1;
    } else {
      keptIndices.push(...triangle);
    }
  }
  if (removedTriangleCount < 1 || keptIndices.length < 3) {
    throw new Error("Static bowstring filtering produced an invalid primitive");
  }
  const stringPoints = [...removedVertices].map((index) => points[index]);
  const minimumLongitudinal = Math.min(
    ...stringPoints.map((point) => point[longitudinalAxis]),
  );
  const maximumLongitudinal = Math.max(
    ...stringPoints.map((point) => point[longitudinalAxis]),
  );
  const near = (target, tolerance) =>
    stringPoints.filter(
      (point) => Math.abs(point[longitudinalAxis] - target) <= tolerance,
    );
  const longitudinalMiddle = (minimumLongitudinal + maximumLongitudinal) / 2;
  const middle = [...stringPoints]
    .sort(
      (left, right) =>
        Math.abs(left[longitudinalAxis] - longitudinalMiddle) -
        Math.abs(right[longitudinalAxis] - longitudinalMiddle),
    )
    .slice(0, Math.min(32, stringPoints.length));
  const endpointTolerance =
    longitudinalAxis === 1
      ? 0.02
      : (maximumLongitudinal - minimumLongitudinal) * 0.0125;
  const upperTip = averagePoints(near(maximumLongitudinal, endpointTolerance));
  const lowerTip = averagePoints(near(minimumLongitudinal, endpointTolerance));
  const bowString = {
    schemaVersion: 1,
    contentNodeName: "EquipmentContent",
    upperTip,
    lowerTip,
    // Preserve the locked Steve output while using the exact straight-string
    // midpoint for sources whose authoring axis is not Y. This avoids bias
    // from asymmetric endpoint tessellation in low-poly source meshes.
    restNock:
      longitudinalAxis === 1
        ? averagePoints(middle)
        : upperTip.map((value, axis) => (value + lowerTip[axis]) / 2),
  };

  const outputIndexBytes = Buffer.alloc(keptIndices.length * indexBytes);
  for (const [index, value] of keptIndices.entries()) {
    const offset = index * indexBytes;
    if (indexBytes === 1) outputIndexBytes.writeUInt8(value, offset);
    else if (indexBytes === 2) outputIndexBytes.writeUInt16LE(value, offset);
    else outputIndexBytes.writeUInt32LE(value, offset);
  }
  const paddedIndexBytes = Buffer.alloc(
    Math.ceil(outputIndexBytes.length / 4) * 4,
  );
  outputIndexBytes.copy(paddedIndexBytes);
  const outputBinary = Buffer.concat([binary, paddedIndexBytes]);
  indices.bufferView.byteOffset = binary.length;
  indices.bufferView.byteLength = outputIndexBytes.length;
  delete indices.bufferView.byteStride;
  indices.accessor.byteOffset = 0;
  indices.accessor.count = keptIndices.length;
  indices.accessor.min = [Math.min(...keptIndices)];
  indices.accessor.max = [Math.max(...keptIndices)];
  document.buffers[0].byteLength = outputBinary.length;
  const chunks = parsed.chunks.map((chunk) =>
    chunk.type === JSON_CHUNK_TYPE
      ? chunk
      : { type: chunk.type, data: outputBinary },
  );
  const output = encodeGlb(document, chunks);
  return {
    output,
    bowString,
    report: {
      sourceVertexCount: vertexCount,
      sourceTriangleCount: sourceIndices.length / 3,
      longitudinalAxis,
      minimumStringLength: stringDetection.minimumStringLength,
      maximumStringThickness: stringDetection.maximumStringThickness,
      stringComponentCount: stringComponents.length,
      stringVertexCount: removedVertices.size,
      removedTriangleCount,
      outputTriangleCount: keptIndices.length / 3,
      bowString,
    },
  };
}

/**
 * Upgrade an already-authored fitted bow without recalculating its attachment
 * transform. This is intentionally separate from the semantic fitter: a
 * visually proven legacy alignment must not drift merely to gain the current
 * stream validation and dynamic-bowstring contracts.
 */
export function certifyExistingFittedBowGlb({
  source,
  itemId,
  compatibleAvatarId,
  legacyAvatarId,
  drawHandLocalOffset,
  stableHeldPose,
  gripContact,
  exportedAt,
}) {
  if (
    !Buffer.isBuffer(source) ||
    !SAFE_ID_PATTERN.test(itemId) ||
    !SAFE_ID_PATTERN.test(compatibleAvatarId) ||
    typeof legacyAvatarId !== "string" ||
    legacyAvatarId.trim().length === 0 ||
    !Array.isArray(drawHandLocalOffset) ||
    drawHandLocalOffset.length !== 3 ||
    drawHandLocalOffset.some((value) => !Number.isFinite(value)) ||
    typeof exportedAt !== "string" ||
    exportedAt.trim().length === 0 ||
    (stableHeldPose !== undefined &&
      (!isRecord(stableHeldPose) ||
        !Array.isArray(stableHeldPose.avatarLocalEulerDegrees) ||
        stableHeldPose.avatarLocalEulerDegrees.length !== 3 ||
        stableHeldPose.avatarLocalEulerDegrees.some(
          (value) => !Number.isFinite(value) || Math.abs(value) > 180,
        ))) ||
    (gripContact !== undefined &&
      (!isRecord(gripContact) ||
        gripContact.schemaVersion !== 1 ||
        gripContact.contentNodeName !== "EquipmentContent" ||
        !Array.isArray(gripContact.sourceAxis) ||
        gripContact.sourceAxis.length !== 3 ||
        gripContact.sourceAxis.some((value) => !Number.isFinite(value)) ||
        Math.hypot(...gripContact.sourceAxis) <= 0.000001 ||
        gripContact.actionEnd !== "dynamic-aim" ||
        !Array.isArray(gripContact.zones) ||
        gripContact.zones.length !== 1 ||
        gripContact.zones[0]?.id !== "primary" ||
        !["leftHand", "rightHand"].includes(gripContact.zones[0]?.boneName) ||
        !Number.isFinite(gripContact.zones[0]?.minimumSourceProjection) ||
        !Number.isFinite(gripContact.zones[0]?.maximumSourceProjection) ||
        gripContact.zones[0].minimumSourceProjection >=
          gripContact.zones[0].maximumSourceProjection))
  ) {
    throw new Error("Existing fitted bow certification input is invalid");
  }

  const stripped = stripStaticBowStringGlb(source);
  const parsed = parseGlb(stripped.output);
  const document = cloneJson(parsed.document);
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0;
  const scene = document.scenes?.[sceneIndex];
  if (!isRecord(scene) || !Array.isArray(scene.nodes)) {
    throw new Error("Existing fitted bow has no active scene");
  }

  const wrapperIndex = scene.nodes.find((nodeIndex) => {
    const node = document.nodes?.[nodeIndex];
    return node?.name === "EquipmentWrapper" && isRecord(node.extras?.hyperia);
  });
  const wrapper = document.nodes?.[wrapperIndex];
  const existingMetadata = wrapper?.extras?.hyperia;
  const contentIndex = wrapper?.children?.[0];
  const content = document.nodes?.[contentIndex];
  if (
    !Number.isInteger(wrapperIndex) ||
    !isRecord(wrapper) ||
    !isRecord(existingMetadata) ||
    existingMetadata.version !== 2 ||
    existingMetadata.weaponType !== "bow" ||
    (existingMetadata.vrmBoneName !== "leftHand" &&
      existingMetadata.vrmBoneName !== "rightHand") ||
    !Array.isArray(existingMetadata.relativeMatrix) ||
    existingMetadata.relativeMatrix.length !== 16 ||
    existingMetadata.relativeMatrix.some((value) => !Number.isFinite(value)) ||
    !Number.isInteger(contentIndex) ||
    !isRecord(content)
  ) {
    throw new Error("Existing fitted bow attachment contract is invalid");
  }
  if (
    gripContact &&
    gripContact.zones[0].boneName !== existingMetadata.vrmBoneName
  ) {
    throw new Error("Existing fitted bow grip-contact bone is invalid");
  }

  content.name = "EquipmentContent";
  const metadata = {
    ...existingMetadata,
    originalSlot: "weapon",
    avatarId: legacyAvatarId,
    exportedFrom: "existing-fitted-bow-certification-v1",
    exportedAt,
    usage:
      "Visually proven fitted transform preserved exactly; dynamic string and competitive metadata added without refitting.",
    fitReference: {
      schemaVersion: 1,
      sourceSha256: sha256(source),
      preservedExistingAttachment: true,
    },
    bowString: {
      ...cloneJson(stripped.bowString),
      contentNodeName: "EquipmentContent",
      drawHandLocalOffset: [...drawHandLocalOffset],
    },
    ...(stableHeldPose
      ? {
          stableHeldPose: {
            schemaVersion: 1,
            wrapperNodeName: "EquipmentWrapper",
            avatarLocalEulerDegrees: [
              ...stableHeldPose.avatarLocalEulerDegrees,
            ],
          },
        }
      : {}),
    ...(gripContact ? { gripContact: cloneJson(gripContact) } : {}),
    duelFit: {
      schemaVersion: 1,
      itemId,
      slot: "weapon",
      compatibleAvatarIds: [compatibleAvatarId],
    },
  };
  wrapper.extras = {
    ...(isRecord(wrapper.extras) ? wrapper.extras : {}),
    hyperia: cloneJson(metadata),
  };
  scene.extras = {
    ...(isRecord(scene.extras) ? scene.extras : {}),
    hyperia: cloneJson(metadata),
  };

  return {
    output: encodeGlb(document, parsed.chunks),
    metadata,
    report: {
      sourceSha256: sha256(source),
      preservedRelativeMatrix: [...existingMetadata.relativeMatrix],
      bowString: cloneJson(stripped.bowString),
      staticString: stripped.report,
    },
  };
}

function assertFiniteTuple(value, length, label) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new Error(`${label} must contain ${length} finite numbers`);
  }
}

function removeDefaultNodeMatrices(nodes) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const node of nodes) {
    if (
      isRecord(node) &&
      Array.isArray(node.matrix) &&
      node.matrix.length === identity.length &&
      node.matrix.every((value, index) => value === identity[index])
    ) {
      delete node.matrix;
    }
  }
}

export function buildFittedRigidEquipmentGlb({
  source,
  definition,
  avatar,
  exportedAt,
  browserFit,
  bowString = null,
}) {
  const parsed = parseGlb(source);
  const document = cloneJson(parsed.document);
  if (!Array.isArray(document.nodes) || !Array.isArray(document.scenes)) {
    throw new Error(`${definition.itemId} source has no scene graph`);
  }
  // Several source GLBs redundantly encode an identity transform. Removing it
  // is semantics-preserving and keeps every generated competitive asset free
  // of Khronos validator findings.
  removeDefaultNodeMatrices(document.nodes);
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0;
  const scene = document.scenes[sceneIndex];
  if (
    !isRecord(scene) ||
    !Array.isArray(scene.nodes) ||
    scene.nodes.length < 1
  ) {
    throw new Error(`${definition.itemId} source scene has no roots`);
  }
  if (
    !SAFE_ID_PATTERN.test(definition.itemId) ||
    !RIGID_EQUIPMENT_SLOTS.has(definition.slot) ||
    (definition.attachmentBone !== "leftHand" &&
      definition.attachmentBone !== "rightHand") ||
    (definition.slot === "shield" &&
      definition.attachmentBone !== "leftHand") ||
    (definition.slot === "gatheringtool" &&
      definition.attachmentBone !== "rightHand")
  ) {
    throw new Error(`${definition.itemId} has an invalid rigid fit identity`);
  }
  assertFiniteTuple(browserFit.relativeMatrix, 16, "relativeMatrix");
  const outputRelativeMatrix = definition.certifiedRelativeMatrix
    ? [...definition.certifiedRelativeMatrix]
    : [...browserFit.relativeMatrix];
  if (
    !Number.isFinite(browserFit.contentScale) ||
    browserFit.contentScale <= 0
  ) {
    throw new Error("contentScale must be positive and finite");
  }
  const fit = {
    schemaVersion: 1,
    itemId: definition.itemId,
    slot: definition.slot,
    compatibleAvatarIds: [avatar.id],
  };
  const metadata = {
    version: 2,
    vrmBoneName: definition.attachmentBone,
    relativeMatrix: outputRelativeMatrix,
    originalSlot: definition.slot,
    avatarId: avatar.legacyAttachmentId,
    avatarHeight: avatar.normalizedHeight,
    weaponType: definition.weaponType,
    exportedFrom: "asset-forge-equipment-fitting-v2",
    exportedAt,
    usage:
      "Canonical contestant fit derived from the production retargeted reference pose.",
    fitReference: {
      schemaVersion: 1,
      avatarAsset: avatar.path,
      avatarSha256: avatar.sha256,
      motionAsset: definition.referenceMotion.path,
      motionSha256: definition.referenceMotion.sha256,
      motionSampleRatio: definition.referenceMotion.sampleRatio,
      sourceAsset: definition.sourcePath,
      sourceSha256: definition.sourceSha256,
      targetLengthMetres: definition.targetLengthMetres,
      desiredWorldEulerDegrees: [...definition.desiredWorldEulerDegrees],
      desiredWorldOffsetMetres: [...definition.desiredWorldOffsetMetres],
      ...(definition.sourceGripPoint
        ? { sourceGripPoint: [...definition.sourceGripPoint] }
        : {}),
      ...(definition.primaryGripAnchor
        ? { primaryGripAnchor: definition.primaryGripAnchor }
        : {}),
      ...(definition.alignHandleToSecondaryHand
        ? {
            alignHandleToSecondaryHand: {
              sourceHandleAxis: [
                ...definition.alignHandleToSecondaryHand.sourceHandleAxis,
              ],
              ...(definition.alignHandleToSecondaryHand.secondaryGripAnchor
                ? {
                    secondaryGripAnchor:
                      definition.alignHandleToSecondaryHand.secondaryGripAnchor,
                  }
                : {}),
            },
          }
        : {}),
    },
    ...(bowString
      ? {
          bowString:
            definition.preserveLegacyBowMetadata === true
              ? cloneJson(bowString)
              : {
                  ...cloneJson(bowString),
                  drawHandLocalOffset: [
                    ...browserFit.secondaryHandMeshCenterBoneLocal,
                  ],
                },
        }
      : {}),
    ...(definition.gripContact
      ? { gripContact: cloneJson(definition.gripContact) }
      : {}),
    ...(definition.stableHeldPose
      ? {
          stableHeldPose: {
            schemaVersion: 1,
            wrapperNodeName: "EquipmentWrapper",
            avatarLocalEulerDegrees: [
              ...definition.stableHeldPose.avatarLocalEulerDegrees,
            ],
            ...(definition.stableHeldPose.anchorToPrimaryHandMeshCenter === true
              ? {
                  primaryBoneLocalOffset: [
                    ...browserFit.primaryHandMeshCenterBoneLocal,
                  ],
                }
              : {}),
            ...(definition.stableHeldPose.avatarLocalPositionOffset
              ? {
                  avatarLocalPositionOffset: [
                    ...definition.stableHeldPose.avatarLocalPositionOffset,
                  ],
                }
              : {}),
          },
        }
      : {}),
    ...(definition.grip === "two-hand" && definition.alignHandleToSecondaryHand
      ? {
          twoHandGrip: {
            schemaVersion: 1,
            wrapperNodeName: "EquipmentWrapper",
            sourceHandleAxis: [
              ...definition.alignHandleToSecondaryHand.sourceHandleAxis,
            ],
            secondaryBoneName:
              definition.attachmentBone === "rightHand"
                ? "leftHand"
                : "rightHand",
            ...(definition.alignHandleToSecondaryHand.secondaryGripAnchor ===
            "hand-mesh-center"
              ? {
                  secondaryBoneLocalOffset: [
                    ...browserFit.secondaryHandMeshCenterBoneLocal,
                  ],
                }
              : {}),
          },
        }
      : {}),
    duelFit: fit,
  };
  const sourceRoots = [...scene.nodes];
  const contentIndex = document.nodes.length;
  document.nodes.push({
    name: "EquipmentContent",
    children: sourceRoots,
    ...(definition.sourceGripPoint
      ? {
          translation: definition.sourceGripPoint.map(
            (component) => -component * browserFit.contentScale,
          ),
        }
      : {}),
    scale: [
      browserFit.contentScale,
      browserFit.contentScale,
      browserFit.contentScale,
    ],
    extras: {
      isNormalized: false,
      isEquipment: true,
      targetScale:
        browserFit.targetLengthMetres / browserFit.sourceLongestDimension,
    },
  });
  const wrapperIndex = document.nodes.length;
  document.nodes.push({
    name: "EquipmentWrapper",
    children: [contentIndex],
    matrix: outputRelativeMatrix,
    extras: { hyperia: cloneJson(metadata) },
  });
  scene.name = "AuxScene";
  scene.nodes = [wrapperIndex];
  scene.extras = {
    ...(isRecord(scene.extras) ? scene.extras : {}),
    hyperia: cloneJson(metadata),
  };
  const output = encodeGlb(document, parsed.chunks);
  const outputParsed = parseGlb(output);
  const inputBinary = parsed.chunks.filter(
    (chunk) => chunk.type !== JSON_CHUNK_TYPE,
  );
  const outputBinary = outputParsed.chunks.filter(
    (chunk) => chunk.type !== JSON_CHUNK_TYPE,
  );
  if (
    inputBinary.length !== outputBinary.length ||
    inputBinary.some(
      (chunk, index) =>
        chunk.type !== outputBinary[index].type ||
        !chunk.data.equals(outputBinary[index].data),
    )
  ) {
    throw new Error(`${definition.itemId} fitting changed source binary data`);
  }
  return { output, metadata };
}

function safeAssetPath(assetsRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized asset-relative path`);
  }
  const resolved = path.resolve(assetsRoot, relativePath);
  if (!resolved.startsWith(`${path.resolve(assetsRoot)}${path.sep}`)) {
    throw new Error(`${label} escapes the asset root`);
  }
  return resolved;
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validateManifest(manifest, assetsRoot) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.exportedAt !== "string" ||
    !isRecord(manifest.avatar) ||
    !SAFE_ID_PATTERN.test(manifest.avatar.id) ||
    !SHA256_PATTERN.test(manifest.avatar.sha256) ||
    !Number.isFinite(manifest.avatar.normalizedHeight) ||
    manifest.avatar.normalizedHeight <= 0 ||
    !Array.isArray(manifest.fits) ||
    manifest.fits.length < 1
  ) {
    throw new Error("Rigid equipment fit manifest is invalid");
  }
  const avatarPath = safeAssetPath(
    assetsRoot,
    manifest.avatar.path,
    "avatar.path",
  );
  if (sha256(readFileSync(avatarPath)) !== manifest.avatar.sha256) {
    throw new Error("Canonical avatar hash drifted");
  }
  const itemIds = new Set();
  const outputPaths = new Set();
  for (const definition of manifest.fits) {
    if (
      !isRecord(definition) ||
      !SAFE_ID_PATTERN.test(definition.itemId) ||
      !RIGID_EQUIPMENT_SLOTS.has(definition.slot) ||
      (definition.grip !== "one-hand" && definition.grip !== "two-hand") ||
      (definition.attachmentBone !== "leftHand" &&
        definition.attachmentBone !== "rightHand") ||
      !SHA256_PATTERN.test(definition.sourceSha256) ||
      !isRecord(definition.referenceMotion) ||
      !SHA256_PATTERN.test(definition.referenceMotion.sha256) ||
      !Number.isFinite(definition.referenceMotion.sampleRatio) ||
      definition.referenceMotion.sampleRatio < 0 ||
      definition.referenceMotion.sampleRatio > 1 ||
      !Number.isFinite(definition.targetLengthMetres) ||
      definition.targetLengthMetres <= 0 ||
      (definition.alignHandleToSecondaryHand !== undefined &&
        !isRecord(definition.alignHandleToSecondaryHand)) ||
      (definition.sourceGripPoint !== undefined &&
        !Array.isArray(definition.sourceGripPoint)) ||
      (definition.primaryGripAnchor !== undefined &&
        definition.primaryGripAnchor !== "hand-mesh-center") ||
      (definition.dynamicBowString !== undefined &&
        typeof definition.dynamicBowString !== "boolean") ||
      (definition.preserveLegacyBowMetadata !== undefined &&
        typeof definition.preserveLegacyBowMetadata !== "boolean") ||
      (definition.preserveLegacyBowMetadata === true &&
        definition.dynamicBowString !== true) ||
      (definition.certifiedRelativeMatrix !== undefined &&
        (!Array.isArray(definition.certifiedRelativeMatrix) ||
          definition.preserveLegacyBowMetadata !== true)) ||
      (definition.dynamicBowString === true &&
        (definition.slot !== "weapon" ||
          definition.weaponType !== "bow" ||
          definition.attachmentBone !== "leftHand")) ||
      (definition.weaponType === "staff" &&
        (definition.slot !== "weapon" ||
          !isRecord(definition.stableHeldPose))) ||
      (definition.weaponType === "harpoon" &&
        (definition.slot !== "gatheringtool" ||
          !isRecord(definition.alignHandleToSecondaryHand))) ||
      (definition.slot === "shield" &&
        (definition.attachmentBone !== "leftHand" ||
          definition.grip !== "one-hand" ||
          definition.dynamicBowString !== undefined ||
          definition.stableHeldPose !== undefined ||
          definition.alignHandleToSecondaryHand !== undefined)) ||
      (definition.slot === "gatheringtool" &&
        (definition.attachmentBone !== "rightHand" ||
          typeof definition.weaponType !== "string" ||
          !definition.weaponType ||
          definition.dynamicBowString !== undefined ||
          definition.stableHeldPose !== undefined)) ||
      (definition.stableHeldPose !== undefined &&
        !isRecord(definition.stableHeldPose)) ||
      (definition.gripContact !== undefined &&
        !isRecord(definition.gripContact))
    ) {
      throw new Error("Rigid equipment fit definition is invalid");
    }
    assertFiniteTuple(
      definition.desiredWorldEulerDegrees,
      3,
      `${definition.itemId}.desiredWorldEulerDegrees`,
    );
    assertFiniteTuple(
      definition.desiredWorldOffsetMetres,
      3,
      `${definition.itemId}.desiredWorldOffsetMetres`,
    );
    if (definition.certifiedRelativeMatrix !== undefined) {
      assertFiniteTuple(
        definition.certifiedRelativeMatrix,
        16,
        `${definition.itemId}.certifiedRelativeMatrix`,
      );
    }
    if (definition.sourceGripPoint !== undefined) {
      assertFiniteTuple(
        definition.sourceGripPoint,
        3,
        `${definition.itemId}.sourceGripPoint`,
      );
    }
    if (definition.alignHandleToSecondaryHand) {
      assertFiniteTuple(
        definition.alignHandleToSecondaryHand.sourceHandleAxis,
        3,
        `${definition.itemId}.alignHandleToSecondaryHand.sourceHandleAxis`,
      );
      if (
        Math.hypot(...definition.alignHandleToSecondaryHand.sourceHandleAxis) <=
        0.000001
      ) {
        throw new Error(
          `${definition.itemId}.alignHandleToSecondaryHand.sourceHandleAxis must be non-zero`,
        );
      }
      if (
        definition.alignHandleToSecondaryHand.secondaryGripAnchor !==
          undefined &&
        definition.alignHandleToSecondaryHand.secondaryGripAnchor !==
          "hand-mesh-center"
      ) {
        throw new Error(
          `${definition.itemId}.alignHandleToSecondaryHand.secondaryGripAnchor is invalid`,
        );
      }
    }
    if (definition.gripContact) {
      const gripContact = definition.gripContact;
      if (
        gripContact.schemaVersion !== 1 ||
        gripContact.contentNodeName !== "EquipmentContent" ||
        !Array.isArray(gripContact.sourceAxis) ||
        !["minimum", "maximum", "dynamic-aim"].includes(
          gripContact.actionEnd,
        ) ||
        !Array.isArray(gripContact.zones) ||
        gripContact.zones.length < 1 ||
        gripContact.zones.length > 2
      ) {
        throw new Error(`${definition.itemId}.gripContact is invalid`);
      }
      assertFiniteTuple(
        gripContact.sourceAxis,
        3,
        `${definition.itemId}.gripContact.sourceAxis`,
      );
      if (Math.hypot(...gripContact.sourceAxis) <= 0.000001) {
        throw new Error(`${definition.itemId}.gripContact.sourceAxis is zero`);
      }
      const zoneIds = new Set();
      const boneNames = new Set();
      for (const zone of gripContact.zones) {
        if (
          !isRecord(zone) ||
          !["primary", "secondary"].includes(zone.id) ||
          zoneIds.has(zone.id) ||
          !["leftHand", "rightHand"].includes(zone.boneName) ||
          boneNames.has(zone.boneName) ||
          !Number.isFinite(zone.minimumSourceProjection) ||
          !Number.isFinite(zone.maximumSourceProjection) ||
          zone.minimumSourceProjection >= zone.maximumSourceProjection
        ) {
          throw new Error(`${definition.itemId}.gripContact zone is invalid`);
        }
        zoneIds.add(zone.id);
        boneNames.add(zone.boneName);
      }
      if (!zoneIds.has("primary")) {
        throw new Error(`${definition.itemId}.gripContact needs primary`);
      }
    }
    if (definition.stableHeldPose) {
      assertFiniteTuple(
        definition.stableHeldPose.avatarLocalEulerDegrees,
        3,
        `${definition.itemId}.stableHeldPose.avatarLocalEulerDegrees`,
      );
      if (
        definition.stableHeldPose.avatarLocalEulerDegrees.some(
          (degrees) => Math.abs(degrees) > 180,
        )
      ) {
        throw new Error(
          `${definition.itemId}.stableHeldPose angles must be within [-180, 180]`,
        );
      }
      if (
        definition.stableHeldPose.anchorToPrimaryHandMeshCenter !== undefined &&
        definition.stableHeldPose.anchorToPrimaryHandMeshCenter !== true
      ) {
        throw new Error(
          `${definition.itemId}.stableHeldPose anchor must be true when provided`,
        );
      }
      if (definition.stableHeldPose.avatarLocalPositionOffset !== undefined) {
        assertFiniteTuple(
          definition.stableHeldPose.avatarLocalPositionOffset,
          3,
          `${definition.itemId}.stableHeldPose.avatarLocalPositionOffset`,
        );
        if (
          Math.hypot(...definition.stableHeldPose.avatarLocalPositionOffset) >
          0.5
        ) {
          throw new Error(
            `${definition.itemId}.stableHeldPose position offset is too large`,
          );
        }
      }
    }
    if (itemIds.has(definition.itemId)) {
      throw new Error(`Duplicate fitted item: ${definition.itemId}`);
    }
    itemIds.add(definition.itemId);
    if (outputPaths.has(definition.outputPath)) {
      throw new Error(`Duplicate fit output: ${definition.outputPath}`);
    }
    outputPaths.add(definition.outputPath);
    const sourcePath = safeAssetPath(
      assetsRoot,
      definition.sourcePath,
      `${definition.itemId}.sourcePath`,
    );
    const outputPath = safeAssetPath(
      assetsRoot,
      definition.outputPath,
      `${definition.itemId}.outputPath`,
    );
    const motionPath = safeAssetPath(
      assetsRoot,
      definition.referenceMotion.path,
      `${definition.itemId}.referenceMotion.path`,
    );
    if (sourcePath === outputPath) {
      throw new Error(`${definition.itemId} output would overwrite its source`);
    }
    if (sha256(readFileSync(sourcePath)) !== definition.sourceSha256) {
      throw new Error(`${definition.itemId} source hash drifted`);
    }
    if (
      sha256(readFileSync(motionPath)) !== definition.referenceMotion.sha256
    ) {
      throw new Error(`${definition.itemId} reference motion hash drifted`);
    }
  }
}

function html(config) {
  const serialized = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Hyperia canonical rigid fit</title></head>
  <body>
    <main><h1>Hyperia canonical rigid-equipment fitting</h1><p id="status">Deriving fits…</p></main>
    <script type="module">
      import { deriveSteveRigidEquipmentFits } from "/fit.js";
      try {
        window.__fitReport = await deriveSteveRigidEquipmentFits(${serialized});
        document.querySelector("#status").textContent =
          "Derived " + window.__fitReport.length + " canonical fits";
        document.body.dataset.ready = "true";
      } catch (error) {
        document.querySelector("#status").textContent = error?.stack ?? String(error);
        document.body.dataset.error = error?.stack ?? String(error);
      }
    </script>
  </body>
</html>`;
}

async function deriveBrowserFits(workspaceRoot, assetsRoot, manifest) {
  const { default: puppeteer } = await import("puppeteer");
  const bundleResult = await build({
    entryPoints: [
      path.join(
        workspaceRoot,
        "scripts/fit-steve-rigid-duel-equipment-browser.ts",
      ),
    ],
    absWorkingDir: workspaceRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    sourcemap: false,
    logLevel: "silent",
  });
  const bundle = bundleResult.outputFiles[0].contents;
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(manifest));
        return;
      }
      if (url.pathname === "/fit.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(bundle);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (!url.pathname.startsWith("/asset/")) {
        response.writeHead(404).end();
        return;
      }
      const filePath = safeAssetPath(
        assetsRoot,
        decodeURIComponent(url.pathname.slice("/asset/".length)),
        "browser asset request",
      );
      response.writeHead(200, {
        "content-type": "model/gltf-binary",
        "cache-control": "no-store",
      });
      response.end(readFileSync(filePath));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Canonical fitting server did not expose a port");
  }
  let browser;
  try {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await puppeteer.launch({
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ??
        (existsSync(systemChrome) ? systemChrome : undefined),
    });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle0",
      timeout: 120_000,
    });
    await page.waitForFunction(
      () =>
        document.body.dataset.ready === "true" || document.body.dataset.error,
      { timeout: 120_000 },
    );
    const pageEvidence = await page.evaluate(() => ({
      error: document.body.dataset.error ?? null,
      hasContent: document.body.innerText.trim().length > 0,
      heading: document.querySelector("h1")?.textContent ?? null,
      status: document.querySelector("#status")?.textContent ?? null,
      hasErrorOverlay: Boolean(
        document.querySelector(
          "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
        ),
      ),
      fits: window.__fitReport ?? null,
    }));
    if (pageEvidence.error) throw new Error(pageEvidence.error);
    if (
      !pageEvidence.hasContent ||
      pageEvidence.heading !== "Hyperia canonical rigid-equipment fitting" ||
      pageEvidence.hasErrorOverlay ||
      !Array.isArray(pageEvidence.fits)
    ) {
      throw new Error("Canonical fitting browser page failed verification");
    }
    if (browserErrors.length > 0) {
      throw new Error(
        `Canonical fitting browser errors: ${browserErrors.join("; ")}`,
      );
    }
    return {
      fits: pageEvidence.fits,
      page: {
        loaded: true,
        hasContent: pageEvidence.hasContent,
        hasErrorOverlay: pageEvidence.hasErrorOverlay,
        heading: pageEvidence.heading,
        status: pageEvidence.status,
        consoleErrors: [],
      },
    };
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function buildRigidDuelEquipment({
  workspaceRoot,
  assetsRoot,
  manifest,
  check,
}) {
  validateManifest(manifest, assetsRoot);
  const browser = await deriveBrowserFits(workspaceRoot, assetsRoot, manifest);
  if (browser.fits.length !== manifest.fits.length) {
    throw new Error("Browser fitting result count does not match manifest");
  }
  const outputs = [];
  for (const [index, definition] of manifest.fits.entries()) {
    const browserFit = browser.fits[index];
    if (browserFit.itemId !== definition.itemId) {
      throw new Error("Browser fitting order or identity drifted");
    }
    const sourcePath = safeAssetPath(
      assetsRoot,
      definition.sourcePath,
      `${definition.itemId}.sourcePath`,
    );
    const outputPath = safeAssetPath(
      assetsRoot,
      definition.outputPath,
      `${definition.itemId}.outputPath`,
    );
    const source = readFileSync(sourcePath);
    const preparedSource = definition.dynamicBowString
      ? stripStaticBowStringGlb(source)
      : { output: source, bowString: null, report: null };
    const built = buildFittedRigidEquipmentGlb({
      source: preparedSource.output,
      definition,
      avatar: manifest.avatar,
      exportedAt: manifest.exportedAt,
      browserFit,
      bowString: preparedSource.bowString,
    });
    const validation = await validator.validateBytes(
      new Uint8Array(built.output),
      {
        uri: path.basename(outputPath),
        format: "glb",
        writeTimestamp: false,
        maxIssues: 0,
      },
    );
    if (
      validation.issues.numErrors > 0 ||
      validation.issues.numWarnings > 0 ||
      validation.issues.numInfos > 0 ||
      validation.issues.numHints > 0
    ) {
      throw new Error(
        `${definition.itemId} failed glTF validation: ${validation.issues.messages
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (check) {
      if (!existsSync(outputPath)) {
        throw new Error(`${definition.itemId} fitted output is missing`);
      }
      if (!readFileSync(outputPath).equals(built.output)) {
        throw new Error(`${definition.itemId} fitted output is stale`);
      }
    } else {
      writeAtomic(outputPath, built.output);
    }
    const parsed = parseGlb(built.output);
    const binaryChunks = parsed.chunks.filter(
      (chunk) => chunk.type !== JSON_CHUNK_TYPE,
    );
    outputs.push({
      itemId: definition.itemId,
      grip: definition.grip,
      sourcePath: definition.sourcePath,
      sourceSha256: definition.sourceSha256,
      sourcePreprocessing: preparedSource.report,
      outputPath: definition.outputPath,
      outputSha256: sha256(built.output),
      outputBytes: built.output.length,
      attachmentBone: browserFit.attachmentBone,
      relativeMatrix: built.metadata.relativeMatrix,
      contentScale: browserFit.contentScale,
      targetLengthMetres: browserFit.targetLengthMetres,
      sourceLongestDimension: browserFit.sourceLongestDimension,
      referenceMotionDurationSeconds: browserFit.referenceMotionDurationSeconds,
      referenceMotionSampleSeconds: browserFit.referenceMotionSampleSeconds,
      referenceHandSeparationMetres: browserFit.referenceHandSeparationMetres,
      referenceMotionHandSeparationRangeMetres:
        browserFit.referenceMotionHandSeparationRangeMetres,
      primaryHandMeshCenterBoneLocal: browserFit.primaryHandMeshCenterBoneLocal,
      secondaryHandMeshCenterBoneLocal:
        browserFit.secondaryHandMeshCenterBoneLocal,
      fittedWorldPositionErrorMetres: browserFit.fittedWorldPositionErrorMetres,
      fittedWorldRotationErrorDegrees:
        browserFit.fittedWorldRotationErrorDegrees,
      nonJsonChunksSha256: binaryChunks.map((chunk) => ({
        type: chunk.type,
        sha256: sha256(chunk.data),
      })),
      validator: {
        errors: validation.issues.numErrors,
        warnings: validation.issues.numWarnings,
        infos: validation.issues.numInfos,
        hints: validation.issues.numHints,
      },
    });
  }
  return {
    schemaVersion: 1,
    avatar: cloneJson(manifest.avatar),
    browserVerification: browser.page,
    outputs,
  };
}

export async function buildSteveRigidDuelEquipment({
  workspaceRoot,
  manifest,
  check,
}) {
  return buildRigidDuelEquipment({
    workspaceRoot,
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    manifest,
    check,
  });
}

const DEFAULT_MANIFEST_PATH = "scripts/steve-rigid-duel-equipment-fits.json";
const DEFAULT_ASSETS_ROOT = "packages/server/world/assets";
const DEFAULT_REPORT_PATH =
  "artifacts/duel-avatar-candidates/steve-rigid-equipment-fit-report.json";

export function parseRigidEquipmentArguments(argv) {
  const options = {
    check: false,
    write: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    assetsRoot: DEFAULT_ASSETS_ROOT,
    reportPath: DEFAULT_REPORT_PATH,
  };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--write") options.write = true;
    else if (argument.startsWith("--manifest=")) {
      options.manifestPath = argument.slice("--manifest=".length);
    } else if (argument.startsWith("--assets-root=")) {
      options.assetsRoot = argument.slice("--assets-root=".length);
    } else if (argument.startsWith("--report=")) {
      options.reportPath = argument.slice("--report=".length);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check === options.write) {
    throw new Error("Specify exactly one of --write or --check");
  }
  for (const [label, value] of [
    ["manifest", options.manifestPath],
    ["assets root", options.assetsRoot],
    ["report", options.reportPath],
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label} path must be non-empty`);
    }
  }
  return options;
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} path must be workspace-relative`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} path escapes the workspace`);
  }
  return resolved;
}

async function main() {
  const options = parseRigidEquipmentArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifestPath = safeWorkspacePath(
    workspaceRoot,
    options.manifestPath,
    "Manifest",
  );
  const assetsRoot = safeWorkspacePath(
    workspaceRoot,
    options.assetsRoot,
    "Assets root",
  );
  const reportPath = safeWorkspacePath(
    workspaceRoot,
    options.reportPath,
    "Report",
  );
  if (reportPath === workspaceRoot) {
    throw new Error("Report path must resolve to a file inside the workspace");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const report = await buildRigidDuelEquipment({
    workspaceRoot,
    assetsRoot,
    manifest,
    check: options.check,
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Canonical rigid-equipment fit report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.outputs.length} canonical Steve rigid-equipment fits\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
