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
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

import { parseGlbJson, summarizeVrmDocument } from "./audit-avatar-lods.mjs";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34963;

const INDEX_COMPONENTS = new Map([
  [5121, { bytes: 1, getter: "getUint8" }],
  [5123, { bytes: 2, getter: "getUint16" }],
  [5125, { bytes: 4, getter: "getUint32" }],
]);

function align4(value) {
  return (value + 3) & ~3;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function finitePositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function unpackGlb(buffer, source = "VRM") {
  // Reuse the strict JSON/header validation performed by the launch audit.
  const document = parseGlbJson(buffer, source);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const byteLength = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    chunks.push({
      type,
      data: Buffer.from(buffer.subarray(start, start + byteLength)),
    });
    offset = start + byteLength;
  }
  const binary = chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK);
  if (!binary) throw new Error(`${source} has no binary chunk`);
  const primaryBuffer = document.buffers?.[0];
  if (!primaryBuffer) throw new Error(`${source} has no primary glTF buffer`);
  let primaryData = binary.data;
  if (typeof primaryBuffer.uri === "string") {
    const prefix = "data:application/octet-stream;base64,";
    if (!primaryBuffer.uri.startsWith(prefix)) {
      throw new Error(`${source} primary buffer must be embedded base64 data`);
    }
    primaryData = Buffer.from(primaryBuffer.uri.slice(prefix.length), "base64");
    if (primaryData.length < primaryBuffer.byteLength) {
      throw new Error(`${source} primary buffer is truncated`);
    }
    primaryData = primaryData.subarray(0, primaryBuffer.byteLength);
    delete primaryBuffer.uri;
  }
  return { document, chunks, binary: primaryData };
}

function packGlb(document, chunks, binaryData) {
  const jsonData = Buffer.from(JSON.stringify(document), "utf8");
  const packedChunks = chunks.map((chunk) => {
    if (chunk.type === GLB_JSON_CHUNK)
      return { type: chunk.type, data: jsonData };
    if (chunk.type === GLB_BIN_CHUNK)
      return { type: chunk.type, data: binaryData };
    return chunk;
  });
  const totalLength =
    12 +
    packedChunks.reduce((sum, chunk) => sum + 8 + align4(chunk.data.length), 0);
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(totalLength, 8);

  let offset = 12;
  for (const chunk of packedChunks) {
    const paddedLength = align4(chunk.data.length);
    output.writeUInt32LE(paddedLength, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    if (chunk.type === GLB_JSON_CHUNK) {
      output.fill(
        0x20,
        offset + 8 + chunk.data.length,
        offset + 8 + paddedLength,
      );
    }
    offset += 8 + paddedLength;
  }
  return output;
}

function accessorByteStart(document, accessor) {
  if (accessor.sparse) throw new Error("Sparse accessors are not supported");
  const view = document.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) {
    throw new Error("Avatar accessors must reference embedded buffer 0");
  }
  return {
    view,
    start: (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
  };
}

function readIndices(document, binary, accessorIndex) {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== "SCALAR") {
    throw new Error("Primitive indices must use a SCALAR accessor");
  }
  const component = INDEX_COMPONENTS.get(accessor.componentType);
  if (!component)
    throw new Error("Primitive indices use an unsupported component type");
  const { view, start } = accessorByteStart(document, accessor);
  const stride = view.byteStride ?? component.bytes;
  const data = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const result = new Uint32Array(accessor.count);
  for (let index = 0; index < accessor.count; index += 1) {
    result[index] = data[component.getter](start + index * stride, true);
  }
  return result;
}

function readPositions(document, binary, accessorIndex) {
  const accessor = document.accessors?.[accessorIndex];
  if (
    !accessor ||
    accessor.type !== "VEC3" ||
    accessor.componentType !== 5126
  ) {
    throw new Error("Avatar positions must use a Float32 VEC3 accessor");
  }
  const { view, start } = accessorByteStart(document, accessor);
  const stride = view.byteStride ?? 12;
  const data = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const result = new Float32Array(accessor.count * 3);
  for (let index = 0; index < accessor.count; index += 1) {
    for (let component = 0; component < 3; component += 1) {
      result[index * 3 + component] = data.getFloat32(
        start + index * stride + component * 4,
        true,
      );
    }
  }
  return result;
}

function writeIndexBuffer(indices) {
  const minimum = indices.reduce(
    (value, index) => Math.min(value, index),
    Number.POSITIVE_INFINITY,
  );
  const maximum = indices.reduce((value, index) => Math.max(value, index), 0);
  const componentType = maximum <= 65_535 ? 5123 : 5125;
  const bytes = componentType === 5123 ? 2 : 4;
  const output = Buffer.alloc(indices.length * bytes);
  for (let index = 0; index < indices.length; index += 1) {
    if (componentType === 5123)
      output.writeUInt16LE(indices[index], index * bytes);
    else output.writeUInt32LE(indices[index], index * bytes);
  }
  return { output, componentType, minimum, maximum };
}

function appendBufferView(binary, addition) {
  const byteOffset = align4(binary.length);
  const result = Buffer.alloc(byteOffset + addition.length);
  binary.copy(result);
  addition.copy(result, byteOffset);
  return { binary: result, byteOffset };
}

function compactReferencedBinary(document, sourceBinary) {
  const usedAccessors = new Set();
  const retainAccessor = (value, label) => {
    if (!Number.isInteger(value) || !document.accessors?.[value]) {
      throw new Error(`${label} references an invalid accessor`);
    }
    usedAccessors.add(value);
  };
  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (
      mesh.primitives ?? []
    ).entries()) {
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        throw new Error("Draco-compressed avatar primitives are unsupported");
      }
      if (Number.isInteger(primitive.indices)) {
        retainAccessor(
          primitive.indices,
          `Mesh ${meshIndex} primitive ${primitiveIndex} indices`,
        );
      }
      for (const [semantic, accessor] of Object.entries(
        primitive.attributes ?? {},
      )) {
        retainAccessor(
          accessor,
          `Mesh ${meshIndex} primitive ${primitiveIndex} attribute ${semantic}`,
        );
      }
      for (const [targetIndex, target] of (primitive.targets ?? []).entries()) {
        for (const [semantic, accessor] of Object.entries(target)) {
          retainAccessor(
            accessor,
            `Mesh ${meshIndex} primitive ${primitiveIndex} target ${targetIndex} attribute ${semantic}`,
          );
        }
      }
      for (const [semantic, accessor] of Object.entries(
        primitive.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {},
      )) {
        retainAccessor(
          accessor,
          `Mesh ${meshIndex} primitive ${primitiveIndex} instancing attribute ${semantic}`,
        );
      }
    }
  }
  for (const [skinIndex, skin] of (document.skins ?? []).entries()) {
    if (Number.isInteger(skin.inverseBindMatrices)) {
      retainAccessor(
        skin.inverseBindMatrices,
        `Skin ${skinIndex} inverse bind matrices`,
      );
    }
  }
  for (const [animationIndex, animation] of (
    document.animations ?? []
  ).entries()) {
    for (const [samplerIndex, sampler] of (
      animation.samplers ?? []
    ).entries()) {
      retainAccessor(
        sampler.input,
        `Animation ${animationIndex} sampler ${samplerIndex} input`,
      );
      retainAccessor(
        sampler.output,
        `Animation ${animationIndex} sampler ${samplerIndex} output`,
      );
    }
  }

  const accessorIndices = [...usedAccessors].sort(
    (left, right) => left - right,
  );
  const accessorRemap = new Map(
    accessorIndices.map((sourceIndex, outputIndex) => [
      sourceIndex,
      outputIndex,
    ]),
  );
  const remapAccessor = (sourceIndex) => {
    const outputIndex = accessorRemap.get(sourceIndex);
    if (!Number.isInteger(outputIndex)) {
      throw new Error(`Accessor ${sourceIndex} was not retained`);
    }
    return outputIndex;
  };
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (Number.isInteger(primitive.indices)) {
        primitive.indices = remapAccessor(primitive.indices);
      }
      for (const attributes of [
        primitive.attributes,
        ...(primitive.targets ?? []),
        primitive.extensions?.EXT_mesh_gpu_instancing?.attributes,
      ]) {
        if (!attributes) continue;
        for (const [semantic, accessor] of Object.entries(attributes)) {
          attributes[semantic] = remapAccessor(accessor);
        }
      }
    }
  }
  for (const skin of document.skins ?? []) {
    if (Number.isInteger(skin.inverseBindMatrices)) {
      skin.inverseBindMatrices = remapAccessor(skin.inverseBindMatrices);
    }
  }
  for (const animation of document.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      sampler.input = remapAccessor(sampler.input);
      sampler.output = remapAccessor(sampler.output);
    }
  }
  document.accessors = accessorIndices.map((index) =>
    structuredClone(document.accessors[index]),
  );

  const usedViews = new Set();
  const retainView = (value, label) => {
    if (!Number.isInteger(value) || !document.bufferViews?.[value]) {
      throw new Error(`${label} references an invalid buffer view`);
    }
    usedViews.add(value);
  };
  for (const [accessorIndex, accessor] of document.accessors.entries()) {
    if (Number.isInteger(accessor.bufferView)) {
      retainView(accessor.bufferView, `Accessor ${accessorIndex}`);
    }
    if (accessor.sparse) {
      retainView(
        accessor.sparse.indices?.bufferView,
        `Accessor ${accessorIndex} sparse indices`,
      );
      retainView(
        accessor.sparse.values?.bufferView,
        `Accessor ${accessorIndex} sparse values`,
      );
    }
  }
  for (const [imageIndex, image] of (document.images ?? []).entries()) {
    if (Number.isInteger(image.bufferView)) {
      retainView(image.bufferView, `Image ${imageIndex}`);
    }
  }

  const viewIndices = [...usedViews].sort((left, right) => left - right);
  const viewRemap = new Map(
    viewIndices.map((sourceIndex, outputIndex) => [sourceIndex, outputIndex]),
  );
  let binary = Buffer.alloc(0);
  document.bufferViews = viewIndices.map((sourceIndex) => {
    const view = document.bufferViews[sourceIndex];
    if ((view.buffer ?? 0) !== 0 || view.extensions?.EXT_meshopt_compression) {
      throw new Error(
        `Buffer view ${sourceIndex} uses an unsupported buffer or compression extension`,
      );
    }
    const start = view.byteOffset ?? 0;
    const end = start + view.byteLength;
    if (start < 0 || end > sourceBinary.length) {
      throw new Error(`Buffer view ${sourceIndex} is truncated`);
    }
    const appended = appendBufferView(
      binary,
      sourceBinary.subarray(start, end),
    );
    binary = appended.binary;
    return {
      ...structuredClone(view),
      buffer: 0,
      byteOffset: appended.byteOffset,
    };
  });
  const remapView = (sourceIndex) => {
    const outputIndex = viewRemap.get(sourceIndex);
    if (!Number.isInteger(outputIndex)) {
      throw new Error(`Buffer view ${sourceIndex} was not retained`);
    }
    return outputIndex;
  };
  for (const accessor of document.accessors) {
    if (Number.isInteger(accessor.bufferView)) {
      accessor.bufferView = remapView(accessor.bufferView);
    }
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = remapView(
        accessor.sparse.indices.bufferView,
      );
      accessor.sparse.values.bufferView = remapView(
        accessor.sparse.values.bufferView,
      );
    }
  }
  for (const image of document.images ?? []) {
    if (Number.isInteger(image.bufferView)) {
      image.bufferView = remapView(image.bufferView);
    }
  }
  document.buffers = [{ byteLength: binary.length }];
  return binary;
}

function embedDataUriImages(document, sourceBinary) {
  let binary = sourceBinary;
  for (const [index, image] of (document.images ?? []).entries()) {
    if (typeof image.uri !== "string" || !image.uri.startsWith("data:")) {
      continue;
    }
    const match = image.uri.match(/^data:([^,;]+);base64,(.*)$/su);
    if (!match) throw new Error(`Image ${index} must use a base64 data URI`);
    const imageBuffer = Buffer.from(match[2], "base64");
    const appended = appendBufferView(binary, imageBuffer);
    binary = appended.binary;
    image.bufferView = document.bufferViews.length;
    image.mimeType = match[1];
    delete image.uri;
    document.bufferViews.push({
      buffer: 0,
      byteOffset: appended.byteOffset,
      byteLength: imageBuffer.length,
    });
  }
  return binary;
}

function declareUsedExtensions(document) {
  const declared = new Set(document.extensionsUsed ?? []);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value.extensions && typeof value.extensions === "object") {
      for (const name of Object.keys(value.extensions)) declared.add(name);
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(document);
  document.extensionsUsed = [...declared].sort();
}

function readOptimizableImage(image, index, document, sourceBinary) {
  if (typeof image.uri === "string") {
    if (!image.uri.startsWith("data:")) return null;
    const comma = image.uri.indexOf(",");
    if (comma < 0 || !image.uri.slice(0, comma).endsWith(";base64")) {
      throw new Error(`Image ${index} must use a base64 data URI`);
    }
    return Buffer.from(image.uri.slice(comma + 1), "base64");
  }
  if (!Number.isInteger(image.bufferView)) return null;
  const view = document.bufferViews?.[image.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) {
    throw new Error(`Image ${index} must reference embedded buffer 0`);
  }
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  if (start < 0 || end > sourceBinary.length) {
    throw new Error(`Image ${index} buffer view is truncated`);
  }
  return Buffer.from(sourceBinary.subarray(start, end));
}

async function optimizeEmbeddedImages(document, maxTextureSize, sourceBinary) {
  const sourceImages = document.images ?? [];
  const optimizedImages = [];
  const remap = new Map();
  const uniqueByHash = new Map();
  const details = [];

  for (let index = 0; index < sourceImages.length; index += 1) {
    const image = sourceImages[index];
    const source = readOptimizableImage(image, index, document, sourceBinary);
    if (!source) {
      const nextIndex = optimizedImages.length;
      optimizedImages.push(image);
      remap.set(index, nextIndex);
      details.push({
        sourceIndex: index,
        outputIndex: nextIndex,
        optimized: false,
      });
      continue;
    }
    const metadata = await sharp(source).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Image ${index} has no auditable dimensions`);
    }
    const optimized = await sharp(source)
      .resize({
        width: maxTextureSize,
        height: maxTextureSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const optimizedMetadata = await sharp(optimized).metadata();
    const hash = sha256(optimized);
    let outputIndex = uniqueByHash.get(hash);
    if (outputIndex === undefined) {
      outputIndex = optimizedImages.length;
      uniqueByHash.set(hash, outputIndex);
      optimizedImages.push({
        ...image,
        uri: `data:image/png;base64,${optimized.toString("base64")}`,
        mimeType: undefined,
        bufferView: undefined,
      });
    }
    remap.set(index, outputIndex);
    details.push({
      sourceIndex: index,
      outputIndex,
      optimized: true,
      sourceBytes: source.length,
      outputBytes: optimized.length,
      sourceDimensions: [metadata.width, metadata.height],
      outputDimensions: [optimizedMetadata.width, optimizedMetadata.height],
    });
  }

  for (const texture of document.textures ?? []) {
    if (Number.isInteger(texture.source))
      texture.source = remap.get(texture.source);
    for (const extensionName of ["EXT_texture_webp", "KHR_texture_basisu"]) {
      const extension = texture.extensions?.[extensionName];
      if (Number.isInteger(extension?.source)) {
        extension.source = remap.get(extension.source);
      }
    }
  }
  const thumbnail = document.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (Number.isInteger(thumbnail)) {
    document.extensions.VRMC_vrm.meta.thumbnailImage = remap.get(thumbnail);
  }
  document.images = optimizedImages;
  return details;
}

export function allocatePrimitiveTriangleBudgets(
  sourceCounts,
  minimumCounts,
  maxTriangles,
) {
  if (
    !Array.isArray(sourceCounts) ||
    !Array.isArray(minimumCounts) ||
    sourceCounts.length === 0 ||
    sourceCounts.length !== minimumCounts.length
  ) {
    throw new Error("Primitive source/minimum triangle counts must align");
  }
  const normalizedMax = finitePositiveInteger(maxTriangles, "maxTriangles");
  const capacities = sourceCounts.map((sourceCount, index) => {
    const source = finitePositiveInteger(sourceCount, `sourceCounts[${index}]`);
    const minimum = finitePositiveInteger(
      minimumCounts[index],
      `minimumCounts[${index}]`,
    );
    if (minimum > source) {
      throw new Error(`minimumCounts[${index}] exceeds sourceCounts[${index}]`);
    }
    return source - minimum;
  });
  const sourceTotal = sourceCounts.reduce((sum, count) => sum + count, 0);
  if (sourceTotal <= normalizedMax) return [...sourceCounts];
  const minimumTotal = minimumCounts.reduce((sum, count) => sum + count, 0);
  if (minimumTotal > normalizedMax) {
    throw new Error(
      `Mesh cannot reach ${normalizedMax} triangles within the error ceiling; minimum is ${minimumTotal}`,
    );
  }

  const capacityTotal = capacities.reduce((sum, count) => sum + count, 0);
  let remaining = normalizedMax - minimumTotal;
  const budgets = [...minimumCounts];
  const remainders = capacities.map((capacity, index) => {
    const exact =
      capacityTotal === 0 ? 0 : (capacity / capacityTotal) * remaining;
    const whole = Math.min(capacity, Math.floor(exact));
    budgets[index] += whole;
    return { index, remainder: exact - whole };
  });
  remaining = normalizedMax - budgets.reduce((sum, count) => sum + count, 0);
  remainders.sort(
    (left, right) =>
      right.remainder - left.remainder || left.index - right.index,
  );
  while (remaining > 0) {
    let allocated = false;
    for (const { index } of remainders) {
      if (remaining === 0) break;
      if (budgets[index] >= sourceCounts[index]) continue;
      budgets[index] += 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) {
      throw new Error("Unable to distribute the primitive triangle budget");
    }
  }
  return budgets;
}

async function simplifyGeometry(
  document,
  sourceBinary,
  maxTriangles,
  maxError,
) {
  await MeshoptSimplifier.ready;
  let binary = sourceBinary;
  const primitives = (document.meshes ?? []).flatMap(
    (mesh) => mesh.primitives ?? [],
  );
  const trianglePrimitives = primitives.filter(
    (primitive) => (primitive.mode ?? 4) === 4,
  );
  const sourceCounts = trianglePrimitives.map((primitive) => {
    const accessor = document.accessors?.[primitive.indices];
    if (!accessor || accessor.count % 3 !== 0) {
      throw new Error(
        "Every avatar triangle primitive must have indexed triangles",
      );
    }
    return accessor.count / 3;
  });
  const sourceTriangles = sourceCounts.reduce((sum, count) => sum + count, 0);
  if (sourceTriangles <= maxTriangles) {
    return {
      binary,
      sourceTriangles,
      outputTriangles: sourceTriangles,
      errors: [],
      primitiveDetails: sourceCounts.map((count, index) => ({
        index,
        sourceTriangles: count,
        minimumTriangles: count,
        targetTriangles: count,
        outputTriangles: count,
        error: 0,
      })),
    };
  }

  const primitiveData = trianglePrimitives.map((primitive, index) => {
    const indices = readIndices(document, sourceBinary, primitive.indices);
    const positions = readPositions(
      document,
      sourceBinary,
      primitive.attributes?.POSITION,
    );
    const [minimum, minimumError] = MeshoptSimplifier.simplify(
      indices,
      positions,
      3,
      Math.min(indices.length, 3),
      maxError,
    );
    if (minimum.length === 0 || minimum.length % 3 !== 0) {
      throw new Error(`Primitive ${index} has an invalid simplification floor`);
    }
    return {
      primitive,
      indices,
      positions,
      minimumTriangles: minimum.length / 3,
      minimumError,
    };
  });
  const targetCounts = allocatePrimitiveTriangleBudgets(
    sourceCounts,
    primitiveData.map(({ minimumTriangles }) => minimumTriangles),
    maxTriangles,
  );
  const errors = [];
  const primitiveDetails = [];
  let outputTriangles = 0;
  for (let index = 0; index < primitiveData.length; index += 1) {
    const { primitive, indices, positions, minimumTriangles } =
      primitiveData[index];
    const sourceCount = sourceCounts[index];
    const targetCount = targetCounts[index];
    const [simplified, error] = MeshoptSimplifier.simplify(
      indices,
      positions,
      3,
      Math.min(indices.length, targetCount * 3),
      maxError,
    );
    const positionCount =
      document.accessors[primitive.attributes.POSITION].count;
    for (const vertexIndex of simplified) {
      if (vertexIndex >= positionCount) {
        throw new Error(
          `Simplified index ${vertexIndex} exceeds ${positionCount} vertices`,
        );
      }
    }
    const encoded = writeIndexBuffer(simplified);
    const appended = appendBufferView(binary, encoded.output);
    binary = appended.binary;
    const bufferView = document.bufferViews.length;
    document.bufferViews.push({
      buffer: 0,
      byteOffset: appended.byteOffset,
      byteLength: encoded.output.length,
      target: ARRAY_BUFFER_TARGET,
    });
    const accessor = document.accessors.length;
    document.accessors.push({
      bufferView,
      byteOffset: 0,
      componentType: encoded.componentType,
      count: simplified.length,
      type: "SCALAR",
      min: [encoded.minimum],
      max: [encoded.maximum],
    });
    primitive.indices = accessor;
    const primitiveOutputTriangles = simplified.length / 3;
    outputTriangles += primitiveOutputTriangles;
    errors.push(error);
    primitiveDetails.push({
      index,
      sourceTriangles: sourceCount,
      minimumTriangles,
      targetTriangles: targetCount,
      outputTriangles: primitiveOutputTriangles,
      error,
    });
  }
  return {
    binary,
    sourceTriangles,
    outputTriangles,
    errors,
    primitiveDetails,
  };
}

export async function optimizeVrmLod(
  sourceBuffer,
  { maxTriangles, maxTextureSize, maxError = 0.02, source = "VRM" },
) {
  maxTriangles = finitePositiveInteger(maxTriangles, "maxTriangles");
  maxTextureSize = finitePositiveInteger(maxTextureSize, "maxTextureSize");
  if (maxTextureSize > 2_048 || (maxTextureSize & (maxTextureSize - 1)) !== 0) {
    throw new Error(
      "maxTextureSize must be a power of two no larger than 2048",
    );
  }
  if (!Number.isFinite(maxError) || maxError <= 0 || maxError > 0.1) {
    throw new Error("maxError must be greater than 0 and no larger than 0.1");
  }

  const { document, chunks, binary } = unpackGlb(sourceBuffer, source);
  const sourceSummary = summarizeVrmDocument(document, sourceBuffer);
  const sourceVrmSpec = document.extensions?.VRMC_vrm?.specVersion;
  if (!sourceVrmSpec) throw new Error(`${source} is missing VRMC_vrm metadata`);
  const imageDetails = await optimizeEmbeddedImages(
    document,
    maxTextureSize,
    binary,
  );
  const geometry = await simplifyGeometry(
    document,
    binary,
    maxTriangles,
    maxError,
  );
  const compactedBinary = compactReferencedBinary(document, geometry.binary);
  const outputBinary = embedDataUriImages(document, compactedBinary);
  declareUsedExtensions(document);
  if (document.buffers?.[0])
    document.buffers[0].byteLength = outputBinary.length;
  const output = packGlb(document, chunks, outputBinary);
  const verifiedDocument = parseGlbJson(output, `${source} optimized output`);
  const outputSummary = summarizeVrmDocument(verifiedDocument, output);
  if (outputSummary.triangles > maxTriangles) {
    throw new Error(
      `Optimized output has ${outputSummary.triangles} triangles; maximum is ${maxTriangles}`,
    );
  }
  if (outputSummary.vrmSpecVersion !== sourceSummary.vrmSpecVersion) {
    throw new Error("Optimization changed the VRM specification version");
  }
  if (
    outputSummary.humanBoneNames.join("\0") !==
      sourceSummary.humanBoneNames.join("\0") ||
    outputSummary.jointCounts.join("\0") !==
      sourceSummary.jointCounts.join("\0")
  ) {
    throw new Error(
      "Optimization changed the humanoid bone map or skin joints",
    );
  }
  if (outputSummary.rigFingerprint !== sourceSummary.rigFingerprint) {
    throw new Error(
      "Optimization changed the ordered skeleton hierarchy or inverse bind pose",
    );
  }
  return {
    output,
    report: {
      sourceSha256: sha256(sourceBuffer),
      outputSha256: sha256(output),
      sourceBytes: sourceBuffer.length,
      outputBytes: output.length,
      sourceTriangles: sourceSummary.triangles,
      outputTriangles: outputSummary.triangles,
      sourceVertices: sourceSummary.vertices,
      outputVertices: outputSummary.vertices,
      sourceRigFingerprint: sourceSummary.rigFingerprint,
      outputRigFingerprint: outputSummary.rigFingerprint,
      maxTriangles,
      maxTextureSize,
      maxError,
      simplificationErrors: geometry.errors,
      primitiveDetails: geometry.primitiveDetails,
      sourceImageCount: sourceSummary.textureDimensions.length,
      outputImageCount: outputSummary.textureDimensions.length,
      imageDetails,
    },
  };
}

function parseCliArgs(argv) {
  const options = { force: false, json: false, maxError: 0.02 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--max-triangles")
      options.maxTriangles = argv[++index];
    else if (argument === "--max-texture-size")
      options.maxTextureSize = argv[++index];
    else if (argument === "--max-error")
      options.maxError = Number(argv[++index]);
    else if (argument === "--force") options.force = true;
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.input || !options.output) {
    throw new Error("--input and --output are required");
  }
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  if (input === output)
    throw new Error("Output must not overwrite the source VRM");
  if (!options.force && existsSync(output)) {
    throw new Error(`Output already exists: ${output}`);
  }
  const sourceBuffer = readFileSync(input);
  const result = await optimizeVrmLod(sourceBuffer, {
    maxTriangles: options.maxTriangles,
    maxTextureSize: options.maxTextureSize,
    maxError: options.maxError,
    source: input,
  });
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, result.output, { flag: "wx" });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  const report = { input, output, ...result.report };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `${path.basename(input)} -> ${path.basename(output)}: ${report.sourceTriangles.toLocaleString()} -> ${report.outputTriangles.toLocaleString()} triangles, ${(report.sourceBytes / 1_048_576).toFixed(1)} -> ${(report.outputBytes / 1_048_576).toFixed(1)} MiB`,
    );
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
