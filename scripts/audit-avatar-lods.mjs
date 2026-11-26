#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const REQUIRED_HUMANOID_BONES = [
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

export const AVATAR_LOD_BUDGETS = Object.freeze({
  lod0: 20_000,
  lod1: 8_000,
  lod2: 2_000,
});

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function literalString(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

export function readAvatarRegistry(sourcePath) {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let array = null;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "AVATAR_OPTIONS" &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        array = declaration.initializer;
      }
    }
  }

  if (!array) {
    throw new Error(`AVATAR_OPTIONS array not found in ${sourcePath}`);
  }

  return array.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`AVATAR_OPTIONS[${index}] must be an object literal`);
    }
    const option = {};
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      const value = literalString(property.initializer);
      if (name && value !== null) option[name] = value;
    }
    if (!option.id || !option.url) {
      throw new Error(
        `AVATAR_OPTIONS[${index}] must have literal id and url fields`,
      );
    }
    return option;
  });
}

export function parseGlbJson(buffer, source = "VRM") {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`${source} is not a GLB/VRM file`);
  }
  if (buffer.readUInt32LE(4) !== 2) {
    throw new Error(`${source} must use glTF/GLB version 2`);
  }
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.length) {
    throw new Error(
      `${source} GLB length mismatch: header=${declaredLength}, file=${buffer.length}`,
    );
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.length) {
      throw new Error(`${source} contains a truncated GLB chunk`);
    }
    if (chunkType === GLB_JSON_CHUNK) {
      const json = buffer
        .subarray(chunkStart, chunkEnd)
        .toString("utf8")
        .replace(/[\0\x20]+$/u, "");
      return JSON.parse(json);
    }
    offset = chunkEnd;
  }

  throw new Error(`${source} has no JSON chunk`);
}

function primitiveTriangleCount(primitive, accessors) {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = accessors?.[accessorIndex]?.count;
  if (!Number.isInteger(count) || count < 0) return null;
  switch (primitive.mode ?? 4) {
    case 4:
      return Math.floor(count / 3);
    case 5:
    case 6:
      return Math.max(0, count - 2);
    default:
      return null;
  }
}

function pngDimensions(buffer) {
  if (
    !buffer ||
    buffer.length < 24 ||
    buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a"
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function glbBinaryChunk(buffer) {
  if (!buffer) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.length) return null;
    if (chunkType === GLB_BIN_CHUNK) {
      return buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd;
  }
  return null;
}

function documentBufferData(document, bufferIndex, glbBuffer) {
  const declaredBuffer = document.buffers?.[bufferIndex];
  if (!declaredBuffer) return null;
  if (typeof declaredBuffer.uri === "string") {
    const match = declaredBuffer.uri.match(/^data:[^,]*;base64,(.*)$/su);
    return match ? Buffer.from(match[1], "base64") : null;
  }
  return bufferIndex === 0 ? glbBinaryChunk(glbBuffer) : null;
}

function imageBytes(image, document, glbBuffer) {
  if (typeof image.uri === "string") {
    const match = image.uri.match(/^data:image\/png;base64,(.*)$/su);
    return match ? Buffer.from(match[1], "base64") : null;
  }
  if (!Number.isInteger(image.bufferView)) return null;
  const view = document.bufferViews?.[image.bufferView];
  if (!view) return null;
  const buffer = documentBufferData(document, view.buffer ?? 0, glbBuffer);
  if (!buffer) return null;
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  if (start < 0 || end > buffer.length) return null;
  return buffer.subarray(start, end);
}

function canonicalRigNumber(value) {
  const rounded = Number(value.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function readInverseBindMatrices(document, skin, glbBuffer, skinIndex) {
  const accessor = document.accessors?.[skin.inverseBindMatrices];
  if (
    !accessor ||
    accessor.type !== "MAT4" ||
    accessor.componentType !== 5126 ||
    accessor.count !== skin.joints.length ||
    accessor.sparse
  ) {
    throw new Error(
      `Skin ${skinIndex} must provide one non-sparse Float32 MAT4 inverse bind matrix per joint`,
    );
  }
  const view = document.bufferViews?.[accessor.bufferView];
  if (!view) {
    throw new Error(
      `Skin ${skinIndex} inverse bind accessor has no buffer view`,
    );
  }
  const buffer = documentBufferData(document, view.buffer ?? 0, glbBuffer);
  if (!buffer) {
    throw new Error(`Skin ${skinIndex} inverse bind buffer is unavailable`);
  }
  const stride = view.byteStride ?? 64;
  if (stride < 64) {
    throw new Error(`Skin ${skinIndex} inverse bind matrix stride is invalid`);
  }
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const requiredEnd = start + Math.max(0, accessor.count - 1) * stride + 64;
  if (start < 0 || requiredEnd > buffer.length) {
    throw new Error(`Skin ${skinIndex} inverse bind buffer is truncated`);
  }

  return Array.from({ length: accessor.count }, (_, matrixIndex) =>
    Array.from({ length: 16 }, (_, componentIndex) => {
      const value = buffer.readFloatLE(
        start + matrixIndex * stride + componentIndex * 4,
      );
      if (!Number.isFinite(value)) {
        throw new Error(
          `Skin ${skinIndex} inverse bind matrix contains a non-finite value`,
        );
      }
      return canonicalRigNumber(value);
    }),
  );
}

/** Stable authority for the exact ordered skeleton hierarchy and rest pose. */
export function createVrmRigFingerprint(document, glbBuffer) {
  const skins = document.skins ?? [];
  if (skins.length === 0) throw new Error("VRM has no skin to fingerprint");
  const parentByNode = new Map();
  for (const [parentIndex, node] of (document.nodes ?? []).entries()) {
    for (const childIndex of node.children ?? []) {
      if (parentByNode.has(childIndex)) {
        throw new Error(`Node ${childIndex} has multiple parents`);
      }
      parentByNode.set(childIndex, parentIndex);
    }
  }

  const canonicalSkins = skins.map((skin, skinIndex) => {
    if (
      !Array.isArray(skin.joints) ||
      skin.joints.length === 0 ||
      new Set(skin.joints).size !== skin.joints.length ||
      skin.joints.some(
        (nodeIndex) =>
          !Number.isInteger(nodeIndex) || !document.nodes?.[nodeIndex],
      )
    ) {
      throw new Error(`Skin ${skinIndex} has an invalid ordered joint list`);
    }
    const jointIndexByNode = new Map(
      skin.joints.map((nodeIndex, jointIndex) => [nodeIndex, jointIndex]),
    );
    const names = skin.joints.map(
      (nodeIndex) => document.nodes[nodeIndex].name ?? "",
    );
    if (
      names.some((name) => typeof name !== "string" || !name.trim()) ||
      new Set(names).size !== names.length
    ) {
      throw new Error(
        `Skin ${skinIndex} joint names must be non-empty and unique`,
      );
    }
    const inverseBindMatrices = readInverseBindMatrices(
      document,
      skin,
      glbBuffer,
      skinIndex,
    );
    return skin.joints.map((nodeIndex, jointIndex) => {
      const parentNodeIndex = parentByNode.get(nodeIndex);
      return {
        name: names[jointIndex],
        parentIndex: jointIndexByNode.get(parentNodeIndex) ?? -1,
        inverseBindMatrix: inverseBindMatrices[jointIndex],
      };
    });
  });

  return createHash("sha256")
    .update(JSON.stringify(canonicalSkins))
    .digest("hex");
}

export function summarizeVrmDocument(document, glbBuffer = null) {
  const primitives = (document.meshes ?? []).flatMap(
    (mesh) => mesh.primitives ?? [],
  );
  const positionAccessors = new Set(
    primitives
      .map((primitive) => primitive.attributes?.POSITION)
      .filter(Number.isInteger),
  );
  const triangles = primitives.reduce((sum, primitive) => {
    const count = primitiveTriangleCount(primitive, document.accessors);
    return count === null ? sum : sum + count;
  }, 0);
  const unsupportedPrimitiveCount = primitives.filter(
    (primitive) =>
      primitiveTriangleCount(primitive, document.accessors) === null,
  ).length;
  const vertices = [...positionAccessors].reduce(
    (sum, accessorIndex) =>
      sum + (document.accessors?.[accessorIndex]?.count ?? 0),
    0,
  );
  const skinnedPrimitiveCount = primitives.filter(
    (primitive) =>
      Number.isInteger(primitive.attributes?.JOINTS_0) &&
      Number.isInteger(primitive.attributes?.WEIGHTS_0),
  ).length;
  const vrm = document.extensions?.VRMC_vrm;
  const humanBones = vrm?.humanoid?.humanBones ?? {};
  const textureDimensions = (document.images ?? [])
    .map((image) => pngDimensions(imageBytes(image, document, glbBuffer)))
    .filter(Boolean);

  return {
    triangles,
    vertices,
    primitiveCount: primitives.length,
    unsupportedPrimitiveCount,
    skinnedPrimitiveCount,
    skinCount: document.skins?.length ?? 0,
    jointCounts: (document.skins ?? []).map((skin) => skin.joints?.length ?? 0),
    rigFingerprint: createVrmRigFingerprint(document, glbBuffer),
    nodeCount: document.nodes?.length ?? 0,
    vrmSpecVersion: vrm?.specVersion ?? null,
    humanBoneNames: Object.keys(humanBones).sort(),
    missingRequiredBones: REQUIRED_HUMANOID_BONES.filter(
      (bone) => !Number.isInteger(humanBones?.[bone]?.node),
    ),
    textureDimensions,
    unknownTextureDimensionCount:
      (document.images?.length ?? 0) - textureDimensions.length,
    license: {
      authors: vrm?.meta?.authors ?? [],
      copyrightInformation: vrm?.meta?.copyrightInformation ?? null,
      commercialUsage: vrm?.meta?.commercialUsage ?? null,
      modification: vrm?.meta?.modification ?? null,
      allowRedistribution: vrm?.meta?.allowRedistribution ?? null,
      creditNotation: vrm?.meta?.creditNotation ?? null,
      licenseUrl: vrm?.meta?.licenseUrl ?? null,
      otherLicenseUrl: vrm?.meta?.otherLicenseUrl ?? null,
    },
  };
}

function assetPathForUrl(assetsRoot, url) {
  if (typeof url !== "string" || !url.startsWith("asset://")) return null;
  const resolved = path.resolve(assetsRoot, url.slice("asset://".length));
  if (
    resolved === assetsRoot ||
    !resolved.startsWith(`${assetsRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

function formatInteger(value) {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : String(value);
}

export function auditAvatarLods({
  avatarSourcePath,
  assetsRoot,
  budgets = AVATAR_LOD_BUDGETS,
}) {
  const failures = [];
  const models = [];
  let registry;
  try {
    registry = readAvatarRegistry(avatarSourcePath);
  } catch (error) {
    return {
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      models,
    };
  }

  for (const avatar of registry) {
    const lods = [
      ["lod0", "url"],
      ["lod1", "lod1Url"],
      ["lod2", "lod2Url"],
    ];
    const summaries = new Map();

    for (const [lod, field] of lods) {
      const label = `${avatar.id}.${field}`;
      const url = avatar[field];
      if (!url) {
        failures.push(`${label} is required for a launch avatar`);
        continue;
      }
      const filePath = assetPathForUrl(assetsRoot, url);
      if (!filePath) {
        failures.push(`${label} must be a non-escaping asset:// URL`);
        continue;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        failures.push(`${label} references a missing asset: ${url}`);
        continue;
      }

      try {
        const fileBuffer = readFileSync(filePath);
        const document = parseGlbJson(fileBuffer, url);
        const summary = summarizeVrmDocument(document, fileBuffer);
        const model = {
          avatarId: avatar.id,
          lod,
          url,
          bytes: statSync(filePath).size,
          ...summary,
        };
        models.push(model);
        summaries.set(lod, summary);

        if (
          summary.unsupportedPrimitiveCount > 0 ||
          summary.primitiveCount === 0
        ) {
          failures.push(
            `${label} must contain only auditable triangle primitives`,
          );
        }
        if (summary.triangles > budgets[lod]) {
          failures.push(
            `${label} has ${formatInteger(summary.triangles)} triangles; ${lod} budget is ${formatInteger(budgets[lod])}`,
          );
        }
        if (!summary.vrmSpecVersion) {
          failures.push(`${label} is missing the VRMC_vrm extension`);
        }
        if (summary.skinCount === 0 || summary.skinnedPrimitiveCount === 0) {
          failures.push(`${label} is missing a usable skinned avatar mesh`);
        }
        if (summary.missingRequiredBones.length > 0) {
          failures.push(
            `${label} is missing required humanoid bones: ${summary.missingRequiredBones.join(", ")}`,
          );
        }
        for (const texture of summary.textureDimensions) {
          if (texture.width > 2048 || texture.height > 2048) {
            failures.push(
              `${label} contains a ${texture.width}x${texture.height} texture; launch maximum is 2048x2048`,
            );
          }
        }
        if (summary.unknownTextureDimensionCount > 0) {
          failures.push(
            `${label} has ${summary.unknownTextureDimensionCount} texture(s) whose dimensions cannot be audited`,
          );
        }

        const license = summary.license;
        if (license.commercialUsage !== "corporation") {
          failures.push(
            `${label} embedded commercialUsage is ${String(license.commercialUsage)}; launch assets must permit corporate use`,
          );
        }
        if (
          license.modification !== "allowModification" &&
          license.modification !== "allowModificationRedistribution"
        ) {
          failures.push(
            `${label} embedded modification policy is ${String(license.modification)}; LOD derivation must be permitted`,
          );
        }
        if (license.allowRedistribution !== true) {
          failures.push(
            `${label} embedded allowRedistribution is not true; CDN/client distribution must be cleared`,
          );
        }
      } catch (error) {
        failures.push(
          `${label} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const base = summaries.get("lod0");
    for (const lod of ["lod1", "lod2"]) {
      const candidate = summaries.get(lod);
      if (!base || !candidate) continue;
      if (candidate.vrmSpecVersion !== base.vrmSpecVersion) {
        failures.push(`${avatar.id}.${lod} VRM spec version differs from lod0`);
      }
      if (
        candidate.humanBoneNames.join("\0") !== base.humanBoneNames.join("\0")
      ) {
        failures.push(
          `${avatar.id}.${lod} humanoid bone map differs from lod0`,
        );
      }
      if (candidate.jointCounts.join("\0") !== base.jointCounts.join("\0")) {
        failures.push(`${avatar.id}.${lod} skin joint counts differ from lod0`);
      }
      if (candidate.rigFingerprint !== base.rigFingerprint) {
        failures.push(
          `${avatar.id}.${lod} ordered skeleton/rest rig differs from lod0`,
        );
      }
    }
  }

  return { passed: failures.length === 0, failures, models };
}

function parseCliArgs(argv) {
  const result = { json: false, assetsRoot: null, avatarSourcePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--assets-dir") result.assetsRoot = argv[++index];
    else if (argument === "--avatar-source")
      result.avatarSourcePath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(scriptDir, "..");
  const options = parseCliArgs(process.argv.slice(2));
  const result = auditAvatarLods({
    avatarSourcePath: path.resolve(
      options.avatarSourcePath ??
        path.join(workspaceRoot, "packages/shared/src/data/avatars.ts"),
    ),
    assetsRoot: path.resolve(
      options.assetsRoot ??
        process.env.ASSETS_DIR ??
        path.join(workspaceRoot, "packages/server/world/assets"),
    ),
  });

  if (options.json) {
    console.log(
      JSON.stringify({ budgets: AVATAR_LOD_BUDGETS, ...result }, null, 2),
    );
  } else {
    for (const model of result.models) {
      console.log(
        `${model.avatarId} ${model.lod}: ${formatInteger(model.triangles)} tris, ${formatInteger(model.vertices)} vertices, ${(model.bytes / 1024 / 1024).toFixed(1)} MiB`,
      );
    }
    if (result.passed) {
      console.log(
        `Avatar LOD launch audit passed (${result.models.length} models).`,
      );
    } else {
      console.error(
        `Avatar LOD launch audit failed (${result.failures.length} issues):`,
      );
      for (const failure of result.failures) console.error(`  - ${failure}`);
    }
  }
  process.exitCode = result.passed ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
