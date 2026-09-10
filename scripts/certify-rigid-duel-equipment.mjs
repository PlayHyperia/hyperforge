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

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    throw new Error("Input is not a complete GLB");
  }
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("Input has an invalid GLB magic value");
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    throw new Error("Only GLB version 2 can be certified");
  }
  if (view.getUint32(8, true) !== buffer.length) {
    throw new Error("GLB declared length does not match its bytes");
  }

  const chunks = [];
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error("GLB contains a truncated chunk header");
    }
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > buffer.length || length % 4 !== 0) {
      throw new Error("GLB contains a malformed chunk");
    }
    chunks.push({ type, data: Buffer.from(buffer.subarray(offset + 8, end)) });
    offset = end;
  }
  const jsonChunks = chunks.filter(({ type }) => type === JSON_CHUNK_TYPE);
  if (jsonChunks.length !== 1 || chunks[0]?.type !== JSON_CHUNK_TYPE) {
    throw new Error("GLB must contain one leading JSON chunk");
  }
  const jsonText = new TextDecoder()
    .decode(jsonChunks[0].data)
    .replace(/[\u0000\u0020]+$/u, "");
  let document;
  try {
    document = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `GLB JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(document)) throw new Error("GLB JSON root must be an object");
  return { document, chunks };
}

function encodeGlb(document, chunks) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const outputChunks = [
    { type: JSON_CHUNK_TYPE, data: paddedJson },
    ...chunks.filter(({ type }) => type !== JSON_CHUNK_TYPE),
  ];
  const totalLength =
    12 + outputChunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(totalLength, 8);
  let offset = 12;
  for (const chunk of outputChunks) {
    output.writeUInt32LE(chunk.data.length, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    offset += 8 + chunk.data.length;
  }
  return output;
}

function attachmentAuthority(document) {
  const scenes = document.scenes;
  const nodes = document.nodes;
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0;
  if (!Array.isArray(scenes) || !Array.isArray(nodes)) {
    throw new Error("GLB is missing scene or node definitions");
  }
  const scene = scenes[sceneIndex];
  if (
    !isRecord(scene) ||
    !Array.isArray(scene.nodes) ||
    scene.nodes.length < 1
  ) {
    throw new Error("GLB scene has no export root");
  }
  const rootIndex = scene.nodes[0];
  const root = Number.isInteger(rootIndex) ? nodes[rootIndex] : null;
  if (!isRecord(root)) throw new Error("GLB export root is invalid");
  const metadata = isRecord(root.extras) ? root.extras.hyperia : null;
  if (!isRecord(metadata)) {
    throw new Error("GLB export root has no legacy attachment metadata");
  }
  return { scene, root, metadata };
}

function assertExactExistingFit(metadata, fit) {
  if (metadata.duelFit === undefined) return;
  if (JSON.stringify(metadata.duelFit) !== JSON.stringify(fit)) {
    throw new Error("Existing duel-fit authority contradicts the request");
  }
}

function validateSemanticGripContact(document, gripContact, attachmentBone) {
  if (!isRecord(gripContact) || gripContact.schemaVersion !== 1) {
    throw new Error("Semantic grip authority must use schemaVersion 1");
  }
  if (
    typeof gripContact.contentNodeName !== "string" ||
    gripContact.contentNodeName.trim() !== gripContact.contentNodeName ||
    gripContact.contentNodeName.length < 1 ||
    !Array.isArray(document.nodes) ||
    !document.nodes.some((node) => node?.name === gripContact.contentNodeName)
  ) {
    throw new Error(
      "Semantic grip authority must name an existing content node",
    );
  }
  if (
    !Array.isArray(gripContact.sourceAxis) ||
    gripContact.sourceAxis.length !== 3 ||
    gripContact.sourceAxis.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    ) ||
    Math.hypot(...gripContact.sourceAxis) <= 0.000001
  ) {
    throw new Error("Semantic grip authority must define a finite source axis");
  }
  if (!["minimum", "maximum", "dynamic-aim"].includes(gripContact.actionEnd)) {
    throw new Error("Semantic grip authority has an invalid action end");
  }
  if (
    !Array.isArray(gripContact.zones) ||
    gripContact.zones.length < 1 ||
    gripContact.zones.length > 2
  ) {
    throw new Error(
      "Semantic grip authority must define one or two handle zones",
    );
  }
  const zoneIds = new Set();
  for (const zone of gripContact.zones) {
    if (
      !isRecord(zone) ||
      (zone.id !== "primary" && zone.id !== "secondary") ||
      zoneIds.has(zone.id) ||
      (zone.boneName !== "leftHand" && zone.boneName !== "rightHand") ||
      typeof zone.minimumSourceProjection !== "number" ||
      !Number.isFinite(zone.minimumSourceProjection) ||
      typeof zone.maximumSourceProjection !== "number" ||
      !Number.isFinite(zone.maximumSourceProjection) ||
      zone.minimumSourceProjection >= zone.maximumSourceProjection
    ) {
      throw new Error(
        "Semantic grip authority contains an invalid handle zone",
      );
    }
    zoneIds.add(zone.id);
  }
  const primary = gripContact.zones.find((zone) => zone.id === "primary");
  if (!primary || primary.boneName !== attachmentBone) {
    throw new Error(
      "Semantic grip primary zone must use the fitted attachment hand",
    );
  }
  const secondary = gripContact.zones.find((zone) => zone.id === "secondary");
  if (secondary?.boneName === attachmentBone) {
    throw new Error("Semantic grip secondary zone must use the other hand");
  }
  return cloneJson(gripContact);
}

function structuralDocumentFingerprint(document) {
  const copy = cloneJson(document);
  if (Array.isArray(copy.scenes)) {
    for (const scene of copy.scenes) {
      if (isRecord(scene)) delete scene.extras;
    }
  }
  if (Array.isArray(copy.nodes)) {
    for (const node of copy.nodes) {
      if (isRecord(node)) delete node.extras;
    }
  }
  return sha256(Buffer.from(JSON.stringify(copy)));
}

export function certifyRigidDuelEquipmentGlb(
  input,
  { itemId, avatarId, legacyAvatarId, slot, gripContact },
) {
  if (!SAFE_ID_PATTERN.test(itemId) || !SAFE_ID_PATTERN.test(avatarId)) {
    throw new Error("Item and avatar IDs must be safe competitive IDs");
  }
  if (slot !== "weapon" && slot !== "shield") {
    throw new Error("Rigid duel slot must be weapon or shield");
  }
  if (typeof legacyAvatarId !== "string" || legacyAvatarId.length < 1) {
    throw new Error("An exact legacy avatar identity is required");
  }
  const parsed = parseGlb(input);
  const beforeStructure = structuralDocumentFingerprint(parsed.document);
  const { scene, root, metadata } = attachmentAuthority(parsed.document);
  if (
    metadata.version !== 2 ||
    !Array.isArray(metadata.relativeMatrix) ||
    metadata.relativeMatrix.length !== 16 ||
    metadata.relativeMatrix.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    ) ||
    (metadata.vrmBoneName !== "leftHand" &&
      metadata.vrmBoneName !== "rightHand")
  ) {
    throw new Error("Legacy attachment is not a complete finite v2 fit");
  }
  if (slot === "shield" && metadata.vrmBoneName !== "leftHand") {
    throw new Error("A shield can only be certified on leftHand");
  }
  if (metadata.avatarId !== legacyAvatarId) {
    throw new Error("Legacy attachment avatar identity does not match");
  }

  const certifiedGripContact = validateSemanticGripContact(
    parsed.document,
    gripContact,
    metadata.vrmBoneName,
  );

  const duelFit = {
    schemaVersion: 1,
    itemId,
    slot,
    compatibleAvatarIds: [avatarId],
  };
  assertExactExistingFit(metadata, duelFit);
  const existingSceneMetadata = isRecord(scene.extras)
    ? scene.extras.hyperia
    : undefined;
  if (isRecord(existingSceneMetadata)) {
    assertExactExistingFit(existingSceneMetadata, duelFit);
  }
  for (const existingMetadata of [metadata, existingSceneMetadata]) {
    if (
      isRecord(existingMetadata) &&
      existingMetadata.gripContact !== undefined &&
      JSON.stringify(existingMetadata.gripContact) !==
        JSON.stringify(certifiedGripContact)
    ) {
      throw new Error(
        "Existing semantic grip authority contradicts the request",
      );
    }
  }
  const certifiedMetadata = {
    ...metadata,
    duelFit,
    gripContact: certifiedGripContact,
  };
  scene.extras = {
    ...(isRecord(scene.extras) ? scene.extras : {}),
    hyperia: cloneJson(certifiedMetadata),
  };
  root.extras = {
    ...(isRecord(root.extras) ? root.extras : {}),
    hyperia: cloneJson(certifiedMetadata),
  };
  const afterStructure = structuralDocumentFingerprint(parsed.document);
  if (afterStructure !== beforeStructure) {
    throw new Error("Certification changed structural GLB data");
  }
  const output = encodeGlb(parsed.document, parsed.chunks);
  const outputParsed = parseGlb(output);
  const inputBinaryChunks = parsed.chunks.filter(
    ({ type }) => type !== JSON_CHUNK_TYPE,
  );
  const outputBinaryChunks = outputParsed.chunks.filter(
    ({ type }) => type !== JSON_CHUNK_TYPE,
  );
  if (
    inputBinaryChunks.length !== outputBinaryChunks.length ||
    inputBinaryChunks.some(
      (chunk, index) =>
        chunk.type !== outputBinaryChunks[index].type ||
        !chunk.data.equals(outputBinaryChunks[index].data),
    )
  ) {
    throw new Error("Certification changed a non-JSON GLB chunk");
  }
  return {
    output,
    report: {
      schemaVersion: 1,
      itemId,
      avatarId,
      legacyAvatarId,
      slot,
      vrmBoneName: metadata.vrmBoneName,
      structuralDocumentSha256: beforeStructure,
      nonJsonChunksSha256: inputBinaryChunks.map(({ type, data }) => ({
        type,
        sha256: sha256(data),
      })),
      inputSha256: sha256(input),
      outputSha256: sha256(output),
      inputBytes: input.length,
      outputBytes: output.length,
      changed: !input.equals(output),
      duelFit,
      gripContact: certifiedGripContact,
    },
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

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--check") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (
      [
        "--input",
        "--item-id",
        "--avatar-id",
        "--legacy-avatar-id",
        "--slot",
      ].includes(argument)
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (Boolean(options.write) === Boolean(options.check)) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return options;
}

function resolveWorkspaceFile(workspaceRoot, relativePath) {
  if (!relativePath) throw new Error("--input is required");
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Input must remain inside the workspace");
  }
  if (!existsSync(resolved)) throw new Error(`Input is missing: ${resolved}`);
  return resolved;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const inputPath = resolveWorkspaceFile(workspaceRoot, options.input);
  const input = readFileSync(inputPath);
  const result = certifyRigidDuelEquipmentGlb(input, {
    itemId: options["item-id"],
    avatarId: options["avatar-id"],
    legacyAvatarId: options["legacy-avatar-id"],
    slot: options.slot,
  });
  if (options.check) {
    if (result.report.changed) {
      throw new Error(`Certified equipment is stale: ${inputPath}`);
    }
  } else {
    writeAtomic(inputPath, result.output);
  }
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
