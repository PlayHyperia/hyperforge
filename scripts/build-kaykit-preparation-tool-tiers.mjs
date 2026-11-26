#!/usr/bin/env node

import { createHash } from "node:crypto";
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

import validator from "gltf-validator";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BINARY_CHUNK_TYPE = 0x004e4942;
const SAFE_ID = /^[a-z0-9_-]+$/u;
const SAFE_PACK_ID = /^[a-z0-9._-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function parseGlb(input) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 28 ||
    input.readUInt32LE(0) !== GLB_MAGIC ||
    input.readUInt32LE(4) !== GLB_VERSION ||
    input.readUInt32LE(8) !== input.length
  ) {
    throw new Error("Input is not a complete GLB v2 file");
  }
  const jsonLength = input.readUInt32LE(12);
  if (
    jsonLength % 4 !== 0 ||
    input.readUInt32LE(16) !== JSON_CHUNK_TYPE ||
    20 + jsonLength + 8 > input.length
  ) {
    throw new Error("GLB has invalid JSON framing");
  }
  const binaryHeader = 20 + jsonLength;
  const binaryLength = input.readUInt32LE(binaryHeader);
  if (
    binaryLength % 4 !== 0 ||
    input.readUInt32LE(binaryHeader + 4) !== BINARY_CHUNK_TYPE ||
    binaryHeader + 8 + binaryLength !== input.length
  ) {
    throw new Error("GLB must contain exactly one binary chunk");
  }
  const document = JSON.parse(
    input
      .subarray(20, 20 + jsonLength)
      .toString("utf8")
      .replace(/[\0\x20]+$/u, ""),
  );
  if (!isRecord(document)) throw new Error("GLB JSON root must be an object");
  return {
    document,
    binary: Buffer.from(
      input.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength),
    ),
  };
}

function encodeGlb(document, binary) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const paddedBinary = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  binary.copy(paddedBinary);
  const output = Buffer.alloc(28 + paddedJson.length + paddedBinary.length);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson.length, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  paddedJson.copy(output, 20);
  const binaryHeader = 20 + paddedJson.length;
  output.writeUInt32LE(paddedBinary.length, binaryHeader);
  output.writeUInt32LE(BINARY_CHUNK_TYPE, binaryHeader + 4);
  paddedBinary.copy(output, binaryHeader + 8);
  return output;
}

function assertFiniteTuple(value, length, label) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain ${length} finite numbers`);
  }
}

function validateHeadSelector(selector, label) {
  if (!isRecord(selector)) {
    throw new Error(`${label} is invalid`);
  }
  const hasTextureCoordinateSelector =
    selector.centroidUvVLessThan !== undefined ||
    selector.centroidUvVGreaterThan !== undefined;
  if (hasTextureCoordinateSelector) {
    const less = selector.centroidUvVLessThan;
    const greater = selector.centroidUvVGreaterThan;
    if (
      (Number.isFinite(less) ? 1 : 0) + (Number.isFinite(greater) ? 1 : 0) !==
        1 ||
      (Number.isFinite(less) && (less <= 0 || less >= 1)) ||
      (Number.isFinite(greater) && (greater <= 0 || greater >= 1)) ||
      selector.centroidAxis !== undefined ||
      selector.centroidLessThan !== undefined ||
      selector.centroidGreaterThan !== undefined ||
      selector.anyVertexAbsoluteAxis !== undefined ||
      selector.anyVertexAbsoluteGreaterThan !== undefined
    ) {
      throw new Error(`${label} has an invalid texture-coordinate selector`);
    }
    return;
  }
  if (!(selector.centroidAxis in AXIS_INDEX)) {
    throw new Error(`${label} has an invalid centroid axis`);
  }
  const less = selector.centroidLessThan;
  const greater = selector.centroidGreaterThan;
  if (
    (Number.isFinite(less) ? 1 : 0) + (Number.isFinite(greater) ? 1 : 0) !==
    1
  ) {
    throw new Error(`${label} must declare exactly one centroid threshold`);
  }
  const hasAbsoluteAxis = selector.anyVertexAbsoluteAxis !== undefined;
  const hasAbsoluteThreshold =
    selector.anyVertexAbsoluteGreaterThan !== undefined;
  if (hasAbsoluteAxis !== hasAbsoluteThreshold) {
    throw new Error(`${label} absolute selector must be complete`);
  }
  if (
    hasAbsoluteAxis &&
    (!(selector.anyVertexAbsoluteAxis in AXIS_INDEX) ||
      !Number.isFinite(selector.anyVertexAbsoluteGreaterThan) ||
      selector.anyVertexAbsoluteGreaterThan < 0)
  ) {
    throw new Error(`${label} has an invalid absolute selector`);
  }
}

export function triangleMatchesHeadSelector(
  points,
  selector,
  textureCoordinates = null,
) {
  if (
    !Array.isArray(points) ||
    points.length !== 3 ||
    points.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 3 ||
        point.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Triangle points must contain three finite VEC3 values");
  }
  validateHeadSelector(selector, "headSelector");
  if (
    selector.centroidUvVLessThan !== undefined ||
    selector.centroidUvVGreaterThan !== undefined
  ) {
    if (
      !Array.isArray(textureCoordinates) ||
      textureCoordinates.length !== 3 ||
      textureCoordinates.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          point.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error(
        "Texture selector requires three finite VEC2 coordinates",
      );
    }
    const centroidV =
      textureCoordinates.reduce((sum, point) => sum + point[1], 0) / 3;
    return Number.isFinite(selector.centroidUvVLessThan)
      ? centroidV < selector.centroidUvVLessThan
      : centroidV > selector.centroidUvVGreaterThan;
  }
  const centroidAxis = AXIS_INDEX[selector.centroidAxis];
  const centroid =
    points.reduce((sum, point) => sum + point[centroidAxis], 0) / 3;
  const centroidMatches = Number.isFinite(selector.centroidLessThan)
    ? centroid < selector.centroidLessThan
    : centroid > selector.centroidGreaterThan;
  if (!centroidMatches) return false;
  if (selector.anyVertexAbsoluteAxis === undefined) return true;
  const absoluteAxis = AXIS_INDEX[selector.anyVertexAbsoluteAxis];
  return points.some(
    (point) =>
      Math.abs(point[absoluteAxis]) > selector.anyVertexAbsoluteGreaterThan,
  );
}

function readAccessor(document, binary, accessorIndex, label) {
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
  return { accessor, bufferView, byteOffset };
}

function readPositions(document, binary, accessorIndex) {
  const source = readAccessor(document, binary, accessorIndex, "POSITION");
  if (
    source.accessor.componentType !== 5126 ||
    source.accessor.type !== "VEC3" ||
    !Number.isInteger(source.accessor.count) ||
    source.accessor.count < 3
  ) {
    throw new Error("POSITION must be a non-empty float VEC3 accessor");
  }
  const stride = source.bufferView.byteStride ?? 12;
  if (
    stride < 12 ||
    source.byteOffset + source.accessor.count * stride > binary.length
  ) {
    throw new Error("POSITION accessor exceeds the binary chunk");
  }
  return Array.from({ length: source.accessor.count }, (_, index) => {
    const offset = source.byteOffset + index * stride;
    return [
      binary.readFloatLE(offset),
      binary.readFloatLE(offset + 4),
      binary.readFloatLE(offset + 8),
    ];
  });
}

function readTextureCoordinates(document, binary, accessorIndex) {
  const source = readAccessor(document, binary, accessorIndex, "TEXCOORD_0");
  if (
    source.accessor.componentType !== 5126 ||
    source.accessor.type !== "VEC2" ||
    !Number.isInteger(source.accessor.count) ||
    source.accessor.count < 3
  ) {
    throw new Error("TEXCOORD_0 must be a non-empty float VEC2 accessor");
  }
  const stride = source.bufferView.byteStride ?? 8;
  if (
    stride < 8 ||
    source.byteOffset + source.accessor.count * stride > binary.length
  ) {
    throw new Error("TEXCOORD_0 accessor exceeds the binary chunk");
  }
  return Array.from({ length: source.accessor.count }, (_, index) => {
    const offset = source.byteOffset + index * stride;
    return [binary.readFloatLE(offset), binary.readFloatLE(offset + 4)];
  });
}

function readUint16Indices(document, binary, accessorIndex) {
  const source = readAccessor(document, binary, accessorIndex, "indices");
  if (
    source.accessor.componentType !== 5123 ||
    source.accessor.type !== "SCALAR" ||
    !Number.isInteger(source.accessor.count) ||
    source.accessor.count < 6 ||
    source.accessor.count % 3 !== 0 ||
    (source.bufferView.byteStride !== undefined &&
      source.bufferView.byteStride !== 2) ||
    source.byteOffset + source.accessor.count * 2 > binary.length
  ) {
    throw new Error("indices must be packed unsigned-short triangles");
  }
  return {
    ...source,
    values: Array.from({ length: source.accessor.count }, (_, index) =>
      binary.readUInt16LE(source.byteOffset + index * 2),
    ),
  };
}

function indexBounds(indices) {
  return { min: [Math.min(...indices)], max: [Math.max(...indices)] };
}

function readAuthority(document) {
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0;
  const scene = document.scenes?.[sceneIndex];
  const sceneAuthority = scene?.extras?.hyperia;
  const rootIndex = Array.isArray(scene?.nodes) ? scene.nodes[0] : null;
  const rootAuthority = Number.isInteger(rootIndex)
    ? document.nodes?.[rootIndex]?.extras?.hyperia
    : null;
  if (!isRecord(sceneAuthority) || !isRecord(rootAuthority)) {
    throw new Error("Source candidate is missing duplicated Hyperia authority");
  }
  if (JSON.stringify(sceneAuthority) !== JSON.stringify(rootAuthority)) {
    throw new Error("Source candidate authority copies disagree");
  }
  return { scene, root: document.nodes[rootIndex], authority: sceneAuthority };
}

function replaceAuthority(authorityRoot, definition) {
  const authority = clone(authorityRoot.authority);
  if (
    authority.version !== 2 ||
    authority.vrmBoneName !== "rightHand" ||
    !isRecord(authority.duelFit) ||
    authority.duelFit.schemaVersion !== 1 ||
    authority.duelFit.itemId !== definition.sourceCandidateItemId ||
    authority.duelFit.slot !== "gatheringtool" ||
    !Array.isArray(authority.duelFit.compatibleAvatarIds) ||
    !authority.duelFit.compatibleAvatarIds.includes(definition.avatarId)
  ) {
    throw new Error("Source candidate fit authority is not the expected input");
  }
  authority.duelFit.itemId = definition.itemId;
  authority.usage =
    "Inactive technical candidate for exact preparation-tool tier review.";
  authority.preparationToolTierCandidate = {
    schemaVersion: 1,
    itemId: definition.itemId,
    family: definition.familyId,
    tier: definition.tierId,
    priority: definition.priority,
    sourceCandidateItemId: definition.sourceCandidateItemId,
    sourceCandidateSha256: definition.sourceSha256,
    activeRuntimePath: false,
  };
  authorityRoot.scene.extras.hyperia = clone(authority);
  authorityRoot.root.extras.hyperia = clone(authority);
  return authority;
}

export function buildPreparationToolTierCandidate({
  source,
  avatarId,
  familyId,
  tierId,
  priority,
  itemId,
  sourceCandidateItemId,
  sourceSha256,
  headSelector,
  headMaterial,
}) {
  if (
    !Buffer.isBuffer(source) ||
    !SAFE_ID.test(avatarId) ||
    !SAFE_ID.test(familyId) ||
    !SAFE_ID.test(tierId) ||
    !SAFE_ID.test(itemId) ||
    !SAFE_ID.test(sourceCandidateItemId) ||
    !Number.isInteger(priority) ||
    priority < 1 ||
    !SHA256.test(sourceSha256) ||
    sha256(source) !== sourceSha256 ||
    !isRecord(headMaterial)
  ) {
    throw new Error("Tier candidate definition is invalid");
  }
  validateHeadSelector(headSelector, `${itemId}.headSelector`);
  assertFiniteTuple(
    headMaterial.baseColorFactor,
    4,
    `${itemId}.baseColorFactor`,
  );
  if (
    headMaterial.baseColorFactor.some((value) => value < 0 || value > 1) ||
    !Number.isFinite(headMaterial.metallicFactor) ||
    headMaterial.metallicFactor < 0 ||
    headMaterial.metallicFactor > 1 ||
    !Number.isFinite(headMaterial.roughnessFactor) ||
    headMaterial.roughnessFactor < 0 ||
    headMaterial.roughnessFactor > 1
  ) {
    throw new Error(`${itemId} material factors must remain inside [0, 1]`);
  }

  const parsed = parseGlb(source);
  const document = clone(parsed.document);
  const binary = Buffer.from(parsed.binary);
  if (
    !Array.isArray(document.meshes) ||
    document.meshes.length !== 1 ||
    !Array.isArray(document.meshes[0].primitives) ||
    document.meshes[0].primitives.length !== 1 ||
    !Array.isArray(document.materials) ||
    document.materials.length !== 1
  ) {
    throw new Error(
      "Tier source must contain one mesh, primitive, and material",
    );
  }
  const primitive = document.meshes[0].primitives[0];
  if (
    !isRecord(primitive) ||
    (primitive.mode !== undefined && primitive.mode !== 4) ||
    !isRecord(primitive.attributes) ||
    !Number.isInteger(primitive.attributes.POSITION) ||
    !Number.isInteger(primitive.indices) ||
    primitive.material !== 0
  ) {
    throw new Error("Tier source primitive is unsupported");
  }
  const positions = readPositions(
    document,
    binary,
    primitive.attributes.POSITION,
  );
  const textureCoordinates =
    headSelector.centroidUvVLessThan !== undefined ||
    headSelector.centroidUvVGreaterThan !== undefined
      ? readTextureCoordinates(
          document,
          binary,
          primitive.attributes.TEXCOORD_0,
        )
      : null;
  const indices = readUint16Indices(document, binary, primitive.indices);
  if (indices.values.some((index) => index >= positions.length)) {
    throw new Error("Tier source references an invalid vertex");
  }
  const handleIndices = [];
  const headIndices = [];
  for (let index = 0; index < indices.values.length; index += 3) {
    const triangle = indices.values.slice(index, index + 3);
    const output = triangleMatchesHeadSelector(
      triangle.map((vertexIndex) => positions[vertexIndex]),
      headSelector,
      textureCoordinates
        ? triangle.map((vertexIndex) => textureCoordinates[vertexIndex])
        : null,
    )
      ? headIndices
      : handleIndices;
    output.push(...triangle);
  }
  if (
    handleIndices.length < 3 ||
    headIndices.length < 3 ||
    handleIndices.length + headIndices.length !== indices.values.length
  ) {
    throw new Error(
      "Head selector did not create two complete triangle groups",
    );
  }
  const reordered = [...handleIndices, ...headIndices];
  for (const [index, value] of reordered.entries()) {
    binary.writeUInt16LE(value, indices.byteOffset + index * 2);
  }

  indices.bufferView.byteLength = handleIndices.length * 2;
  indices.accessor.count = handleIndices.length;
  Object.assign(indices.accessor, indexBounds(handleIndices));
  const headBufferViewIndex = document.bufferViews.length;
  document.bufferViews.push({
    buffer: 0,
    byteOffset: indices.byteOffset + handleIndices.length * 2,
    byteLength: headIndices.length * 2,
    target: 34963,
  });
  const headAccessorIndex = document.accessors.length;
  document.accessors.push({
    bufferView: headBufferViewIndex,
    componentType: 5123,
    count: headIndices.length,
    type: "SCALAR",
    ...indexBounds(headIndices),
  });
  const headMaterialIndex = document.materials.length;
  document.materials.push({
    name: `${tierId}_${familyId}_head`,
    pbrMetallicRoughness: {
      baseColorFactor: [...headMaterial.baseColorFactor],
      metallicFactor: headMaterial.metallicFactor,
      roughnessFactor: headMaterial.roughnessFactor,
    },
  });
  const headPrimitive = {
    ...clone(primitive),
    attributes: clone(primitive.attributes),
    indices: headAccessorIndex,
    material: headMaterialIndex,
  };
  delete headPrimitive.attributes.TEXCOORD_0;
  document.meshes[0].primitives = [
    { ...clone(primitive), indices: primitive.indices, material: 0 },
    headPrimitive,
  ];
  document.meshes[0].name = itemId;
  const authority = replaceAuthority(readAuthority(document), {
    avatarId,
    familyId,
    tierId,
    priority,
    itemId,
    sourceCandidateItemId,
    sourceSha256,
  });
  const output = encodeGlb(document, binary);
  return {
    output,
    report: {
      itemId,
      family: familyId,
      tier: tierId,
      priority,
      sourceCandidateItemId,
      sourceSha256,
      outputSha256: sha256(output),
      outputBytes: output.length,
      triangleCount: indices.values.length / 3,
      handleTriangleCount: handleIndices.length / 3,
      headTriangleCount: headIndices.length / 3,
      primitiveCount: 2,
      materialCount: 2,
      headMaterial: clone(headMaterial),
      fitAuthority: clone(authority.duelFit),
      activeRuntimePath: false,
    },
  };
}

function validateConfig(config, workspaceRoot) {
  if (
    !isRecord(config) ||
    config.schemaVersion !== 1 ||
    typeof config.exportedAt !== "string" ||
    !SAFE_ID.test(config.avatarId) ||
    !isRecord(config.runtimeItemManifest) ||
    !SHA256.test(config.runtimeItemManifest.sha256) ||
    !isRecord(config.assetSourceLock) ||
    !SHA256.test(config.assetSourceLock.sha256) ||
    !SAFE_PACK_ID.test(config.assetSourceLock.packId) ||
    !Array.isArray(config.families) ||
    config.families.length !== 2 ||
    !Array.isArray(config.tiers) ||
    config.tiers.length !== 6
  ) {
    throw new Error("Preparation-tool tier config is invalid");
  }
  safeWorkspacePath(workspaceRoot, config.outputDirectory, "outputDirectory");
  safeWorkspacePath(workspaceRoot, config.reportPath, "reportPath");
  const familyIds = new Set();
  for (const family of config.families) {
    if (
      !isRecord(family) ||
      !SAFE_ID.test(family.id) ||
      !SAFE_ID.test(family.skill) ||
      !SHA256.test(family.sourceSha256) ||
      !SAFE_ID.test(family.sourceCandidateItemId) ||
      !["one-hand", "two-hand"].includes(family.grip)
    ) {
      throw new Error("Preparation-tool family config is invalid");
    }
    validateHeadSelector(family.headSelector, `${family.id}.headSelector`);
    if (familyIds.has(family.id)) throw new Error("Duplicate tool family");
    familyIds.add(family.id);
    const sourcePath = safeWorkspacePath(
      workspaceRoot,
      family.sourcePath,
      `${family.id}.sourcePath`,
    );
    if (sha256(readFileSync(sourcePath)) !== family.sourceSha256) {
      throw new Error(`${family.id} fitted source hash drifted`);
    }
  }
  const tierIds = new Set();
  const priorities = new Set();
  for (const tier of config.tiers) {
    if (
      !isRecord(tier) ||
      !SAFE_ID.test(tier.id) ||
      !Number.isInteger(tier.priority) ||
      tier.priority < 1 ||
      !isRecord(tier.headMaterial)
    ) {
      throw new Error("Preparation-tool tier config is invalid");
    }
    assertFiniteTuple(
      tier.headMaterial.baseColorFactor,
      4,
      `${tier.id}.baseColorFactor`,
    );
    if (tierIds.has(tier.id) || priorities.has(tier.priority)) {
      throw new Error("Duplicate tool tier identity or priority");
    }
    tierIds.add(tier.id);
    priorities.add(tier.priority);
  }
  if ([...priorities].sort((a, b) => a - b).join(",") !== "1,2,3,4,5,6") {
    throw new Error("Tool tier priorities must be exactly 1 through 6");
  }
}

function readLockedJson(workspaceRoot, definition, label) {
  const filePath = safeWorkspacePath(workspaceRoot, definition.path, label);
  const bytes = readFileSync(filePath);
  if (sha256(bytes) !== definition.sha256) {
    throw new Error(`${label} hash drifted`);
  }
  return { filePath, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function validateRuntimeItems(config, runtimeManifest) {
  if (!Array.isArray(runtimeManifest)) {
    throw new Error("Runtime tool manifest must be an array");
  }
  const itemById = new Map(runtimeManifest.map((item) => [item?.id, item]));
  const mappings = [];
  for (const family of config.families) {
    for (const tier of config.tiers) {
      const itemId = `${tier.id}_${family.id}`;
      const item = itemById.get(itemId);
      if (
        !isRecord(item) ||
        item.tier !== tier.id ||
        !isRecord(item.tool) ||
        item.tool.skill !== family.skill ||
        item.tool.priority !== tier.priority
      ) {
        throw new Error(`${itemId} runtime identity or priority drifted`);
      }
      mappings.push({
        itemId,
        family: family.id,
        tier: tier.id,
        skill: family.skill,
        priority: tier.priority,
        currentEquippedModelPath:
          typeof item.equippedModelPath === "string"
            ? item.equippedModelPath
            : null,
      });
    }
  }
  return mappings;
}

function validateSourcePack(config, sourceLock) {
  const pack = sourceLock?.packs?.find(
    (candidate) => candidate?.id === config.assetSourceLock.packId,
  );
  if (
    !isRecord(pack) ||
    pack.kind !== "preparation-tool-kit" ||
    pack.license?.spdx !== "CC0-1.0" ||
    pack.license?.commercialUse !== true ||
    pack.license?.modification !== true ||
    pack.license?.redistribution !== true ||
    pack.license?.attributionRequired !== false ||
    pack.nonAiEvidence?.statement !== "No generative AI was used" ||
    !SHA256.test(pack.archive?.sha256)
  ) {
    throw new Error("Preparation-tool source pack policy drifted");
  }
  return {
    id: pack.id,
    provider: pack.provider,
    sourcePage: pack.sourcePage,
    license: clone(pack.license),
    nonAiEvidence: clone(pack.nonAiEvidence),
    archive: clone(pack.archive),
  };
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

export async function buildKayKitPreparationToolTiers({
  workspaceRoot,
  config,
  check,
}) {
  validateConfig(config, workspaceRoot);
  const runtime = readLockedJson(
    workspaceRoot,
    config.runtimeItemManifest,
    "runtimeItemManifest",
  );
  const sourceLock = readLockedJson(
    workspaceRoot,
    config.assetSourceLock,
    "assetSourceLock",
  );
  const runtimeMappings = validateRuntimeItems(config, runtime.value);
  const sourcePack = validateSourcePack(config, sourceLock.value);
  const outputDirectory = safeWorkspacePath(
    workspaceRoot,
    config.outputDirectory,
    "outputDirectory",
  );
  const outputs = [];
  for (const family of config.families) {
    const source = readFileSync(
      safeWorkspacePath(
        workspaceRoot,
        family.sourcePath,
        `${family.id}.sourcePath`,
      ),
    );
    for (const tier of config.tiers) {
      const itemId = `${tier.id}_${family.id}`;
      const built = buildPreparationToolTierCandidate({
        source,
        avatarId: config.avatarId,
        familyId: family.id,
        tierId: tier.id,
        priority: tier.priority,
        itemId,
        sourceCandidateItemId: family.sourceCandidateItemId,
        sourceSha256: family.sourceSha256,
        headSelector: family.headSelector,
        headMaterial: tier.headMaterial,
      });
      const validation = await validator.validateBytes(
        new Uint8Array(built.output),
        {
          uri: `${itemId}.glb`,
          format: "glb",
          writeTimestamp: false,
          maxIssues: 1_000,
        },
      );
      if (
        validation.issues.numErrors > 0 ||
        validation.issues.numWarnings > 0 ||
        validation.issues.numInfos > 0 ||
        validation.issues.numHints > 0
      ) {
        throw new Error(
          `${itemId} failed glTF validation: ${validation.issues.messages
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      const outputPath = path.join(outputDirectory, `${itemId}.glb`);
      if (check) {
        if (!existsSync(outputPath)) {
          throw new Error(`${itemId} tier candidate is missing`);
        }
        if (!readFileSync(outputPath).equals(built.output)) {
          throw new Error(`${itemId} tier candidate is stale`);
        }
      } else {
        writeAtomic(outputPath, built.output);
      }
      outputs.push({
        ...built.report,
        grip: family.grip,
        outputPath: path
          .relative(workspaceRoot, outputPath)
          .split(path.sep)
          .join("/"),
        validator: { errors: 0, warnings: 0, infos: 0, hints: 0 },
      });
    }
  }
  const report = {
    schemaVersion: 1,
    exportedAt: config.exportedAt,
    status: "technical_candidates_unapproved",
    activeRuntimePathsChanged: false,
    avatarId: config.avatarId,
    sourcePack,
    sources: config.families.map((family) => ({
      family: family.id,
      sourceCandidateItemId: family.sourceCandidateItemId,
      path: family.sourcePath,
      sha256: family.sourceSha256,
      headSelector: clone(family.headSelector),
    })),
    runtimeManifest: {
      path: config.runtimeItemManifest.path,
      sha256: config.runtimeItemManifest.sha256,
    },
    summary: {
      requiredRuntimeItemCount: runtimeMappings.length,
      generatedCandidateCount: outputs.length,
      certifiedCandidateCount: outputs.length,
      familyCount: config.families.length,
      tierCount: config.tiers.length,
      gltfFindingCount: 0,
      activeRuntimePathChangeCount: 0,
      readyForProductReview:
        outputs.length === runtimeMappings.length && outputs.length === 12,
      approvedForRuntimeActivation: false,
    },
    runtimeMappings: runtimeMappings.map((mapping) => ({
      ...mapping,
      candidateOutputPath: path
        .join(config.outputDirectory, `${mapping.itemId}.glb`)
        .split(path.sep)
        .join("/"),
    })),
    outputs,
  };
  const reportPath = safeWorkspacePath(
    workspaceRoot,
    config.reportPath,
    "reportPath",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Preparation-tool tier report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  return report;
}

function parseArguments(argv) {
  const options = { check: false, write: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--write") options.write = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check === options.write) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const config = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "scripts/kaykit-preparation-tool-tiers.json"),
      "utf8",
    ),
  );
  const report = await buildKayKitPreparationToolTiers({
    workspaceRoot,
    config,
    check: options.check,
  });
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.summary.certifiedCandidateCount} exact KayKit preparation-tool tier candidates; active manifests unchanged\n`,
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
