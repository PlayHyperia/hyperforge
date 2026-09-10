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

import { parseGlbJson, summarizeVrmDocument } from "./audit-avatar-lods.mjs";
import { auditDuelLaunchAssetSources } from "./audit-duel-launch-asset-sources.mjs";
import { readZipArchive } from "./lib/read-zip-archive.mjs";
import { optimizeVrmLod } from "./optimize-vrm-lod.mjs";

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const KAYKIT_PACK_ID = "kaykit-adventurers-2.0-free";
const KAYKIT_ANIMATION_PACK_ID = "kaykit-character-animations-1.1-free";
const KAYKIT_PREPARATION_PACK_ID = "kaykit-rpg-tools-bits-1.0-free";
const KAYKIT_BODY_ENTRY =
  "KayKit_Adventurers_2.0_FREE/Characters/gltf/Knight.glb";
const QUATERNIUS_PACK_ID = "quaternius-universal-base-characters-standard";
const QUATERNIUS_ANIMATION_PACK_ID =
  "quaternius-universal-animation-library-2-standard";
const QUATERNIUS_BODY_ENTRY =
  "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf";
const QUATERNIUS_ANIMATION_ENTRY =
  "Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb";
const OUTPUT_FILE = "kaykit-knight.vrm";
const REPORT_FILE = "kaykit-knight-report.json";
const QUATERNIUS_OUTPUT_FILE = "quaternius-superhero-male.vrm";
const QUATERNIUS_REPORT_FILE = "quaternius-superhero-male-report.json";
const MANIFEST_FILE = "manifest.json";
const COMPARISON_MANIFEST_FILE = "source-comparison-manifest.json";
const COMPARISON_REPORT_FILE = "source-comparison-report.json";
const ROLE_KIT_MANIFEST_FILE = "role-kit-manifest.json";
const PREPARATION_KIT_MANIFEST_FILE = "preparation-kit-manifest.json";
const MOTION_MANIFEST_FILE = "motion-audit.json";
const QUATERNIUS_MOTION_MANIFEST_FILE = "quaternius-motion-audit.json";

export const KAYKIT_LOD_PROFILES = Object.freeze([
  {
    id: "lod1",
    file: "kaykit-knight_lod1.vrm",
    maxTriangles: 3_000,
    maxTextureSize: 512,
    maxError: 0.02,
  },
  {
    id: "lod2",
    file: "kaykit-knight_lod2.vrm",
    maxTriangles: 2_000,
    maxTextureSize: 256,
    maxError: 0.035,
  },
]);

const KAYKIT_MOTIONS = Object.freeze([
  {
    id: "idle",
    name: "Idle",
    group: "General",
    clip: "Idle_A",
    sampleRatio: 0.35,
  },
  {
    id: "walk",
    name: "Walk",
    group: "MovementBasic",
    clip: "Walking_A",
    sampleRatio: 0.45,
  },
  {
    id: "run",
    name: "Run",
    group: "MovementBasic",
    clip: "Running_A",
    sampleRatio: 0.45,
  },
  {
    id: "unarmed",
    name: "Unarmed attack",
    group: "CombatMelee",
    clip: "Melee_Unarmed_Attack_Punch_A",
    sampleRatio: 0.5,
  },
  {
    id: "sword",
    name: "One-handed melee",
    group: "CombatMelee",
    clip: "Melee_1H_Attack_Chop",
    sampleRatio: 0.45,
  },
  {
    id: "block",
    name: "Melee block",
    group: "CombatMelee",
    clip: "Melee_Blocking",
    sampleRatio: 0.5,
  },
  {
    id: "two-hand-idle",
    name: "Two-handed idle",
    group: "CombatMelee",
    clip: "Melee_2H_Idle",
    sampleRatio: 0.4,
  },
  {
    id: "two-hand-slash",
    name: "Two-handed melee",
    group: "CombatMelee",
    clip: "Melee_2H_Attack_Chop",
    sampleRatio: 0.45,
  },
  {
    id: "ranged-idle",
    name: "Ranged aiming idle",
    group: "CombatRanged",
    clip: "Ranged_Bow_Aiming_Idle",
    sampleRatio: 0.35,
  },
  {
    id: "ranged",
    name: "Ranged draw",
    group: "CombatRanged",
    clip: "Ranged_Bow_Draw",
    sampleRatio: 0.55,
  },
  {
    id: "ranged-release",
    name: "Ranged release",
    group: "CombatRanged",
    clip: "Ranged_Bow_Release",
    sampleRatio: 0.55,
  },
  {
    id: "magic",
    name: "Magic attack",
    group: "CombatRanged",
    clip: "Ranged_Magic_Shoot",
    sampleRatio: 0.55,
  },
  {
    id: "death",
    name: "Death",
    group: "General",
    clip: "Death_A",
    sampleRatio: 0.9,
  },
  {
    id: "victory",
    name: "Victory",
    group: "Simulation",
    clip: "Cheering",
    sampleRatio: 0.55,
  },
  {
    id: "woodcutting",
    name: "Woodcutting",
    group: "Tools",
    clip: "Chop",
    sampleRatio: 0.55,
  },
  {
    id: "mining",
    name: "Mining",
    group: "Tools",
    clip: "Pickaxe",
    sampleRatio: 0.55,
  },
  {
    id: "smithing",
    name: "Smithing",
    group: "Tools",
    clip: "Hammering",
    sampleRatio: 0.55,
  },
  {
    id: "fishing",
    name: "Fishing cast",
    group: "Tools",
    clip: "Fishing_Cast",
    sampleRatio: 0.55,
  },
  {
    id: "fishing-idle",
    name: "Fishing idle",
    group: "Tools",
    clip: "Fishing_Idle",
    sampleRatio: 0.5,
  },
  {
    id: "fishing-bite",
    name: "Fishing bite",
    group: "Tools",
    clip: "Fishing_Bite",
    sampleRatio: 0.55,
  },
  {
    id: "fishing-tug",
    name: "Fishing tug",
    group: "Tools",
    clip: "Fishing_Tug",
    sampleRatio: 0.55,
  },
  {
    id: "fishing-reeling",
    name: "Fishing reeling",
    group: "Tools",
    clip: "Fishing_Reeling",
    sampleRatio: 0.55,
  },
  {
    id: "fishing-struggling",
    name: "Fishing struggling",
    group: "Tools",
    clip: "Fishing_Struggling",
    sampleRatio: 0.55,
  },
  {
    id: "fishing-catch",
    name: "Fishing catch",
    group: "Tools",
    clip: "Fishing_Catch",
    sampleRatio: 0.72,
  },
  {
    id: "net-throw-candidate",
    name: "Net throw candidate",
    group: "General",
    clip: "Throw",
    sampleRatio: 0.62,
  },
  {
    id: "object-pickup-candidate",
    name: "Object pickup candidate",
    group: "General",
    clip: "PickUp",
    sampleRatio: 0.62,
  },
  {
    id: "object-interact-candidate",
    name: "Object interaction candidate",
    group: "General",
    clip: "Interact",
    sampleRatio: 0.55,
  },
  {
    id: "harpoon-thrust-candidate",
    name: "Harpoon thrust candidate",
    group: "CombatMelee",
    clip: "Melee_2H_Attack_Stab",
    sampleRatio: 0.55,
  },
  {
    id: "use-item",
    name: "Use item",
    group: "General",
    clip: "Use_Item",
    sampleRatio: 0.55,
  },
]);

const QUATERNIUS_MOTIONS = Object.freeze([
  {
    id: "idle",
    name: "Idle",
    clip: "Idle_No_Loop",
    sampleRatio: 0.5,
  },
  {
    id: "sword",
    name: "Sword attack",
    clip: "Sword_Regular_A",
    sampleRatio: 0.55,
  },
  {
    id: "block",
    name: "Sword block",
    clip: "Sword_Block",
    sampleRatio: 0.55,
  },
  {
    id: "hit",
    name: "Hit knockback",
    clip: "Hit_Knockback",
    sampleRatio: 0.55,
  },
  {
    id: "consume",
    name: "Consume item",
    clip: "Consume",
    sampleRatio: 0.55,
  },
  {
    id: "woodcutting",
    name: "Woodcutting",
    clip: "TreeChopping_Loop",
    sampleRatio: 0.55,
  },
]);

const KAYKIT_ROLE_KIT = Object.freeze([
  { id: "sword-1h", entry: "sword_1handed.gltf" },
  { id: "sword-2h", entry: "sword_2handed.gltf" },
  { id: "axe-2h", entry: "axe_2handed.gltf" },
  { id: "bow", entry: "bow_withString.gltf" },
  { id: "arrow", entry: "arrow_bow.gltf" },
  { id: "staff", entry: "staff.gltf" },
  { id: "shield", entry: "shield_round.gltf" },
]);

const KAYKIT_PREPARATION_KIT = Object.freeze([
  { id: "axe", entry: "axe.gltf" },
  { id: "pickaxe", entry: "pickaxe.gltf" },
]);

const KAYKIT_HUMAN_BONE_NODES = Object.freeze({
  hips: "hips",
  spine: "spine",
  chest: "chest",
  head: "head",
  leftUpperArm: "upperarm.l",
  leftLowerArm: "lowerarm.l",
  leftHand: "wrist.l",
  rightUpperArm: "upperarm.r",
  rightLowerArm: "lowerarm.r",
  rightHand: "wrist.r",
  leftUpperLeg: "upperleg.l",
  leftLowerLeg: "lowerleg.l",
  leftFoot: "foot.l",
  leftToes: "toes.l",
  rightUpperLeg: "upperleg.r",
  rightLowerLeg: "lowerleg.r",
  rightFoot: "foot.r",
  rightToes: "toes.r",
});

const QUATERNIUS_HUMAN_BONE_NODES = Object.freeze({
  hips: "pelvis",
  spine: "spine_01",
  chest: "spine_02",
  upperChest: "spine_03",
  neck: "neck_01",
  head: "Head",
  leftShoulder: "clavicle_l",
  leftUpperArm: "upperarm_l",
  leftLowerArm: "lowerarm_l",
  leftHand: "hand_l",
  leftThumbMetacarpal: "thumb_01_l",
  leftThumbProximal: "thumb_02_l",
  leftThumbDistal: "thumb_03_l",
  leftIndexProximal: "index_01_l",
  leftIndexIntermediate: "index_02_l",
  leftIndexDistal: "index_03_l",
  leftMiddleProximal: "middle_01_l",
  leftMiddleIntermediate: "middle_02_l",
  leftMiddleDistal: "middle_03_l",
  leftRingProximal: "ring_01_l",
  leftRingIntermediate: "ring_02_l",
  leftRingDistal: "ring_03_l",
  leftLittleProximal: "pinky_01_l",
  leftLittleIntermediate: "pinky_02_l",
  leftLittleDistal: "pinky_03_l",
  rightShoulder: "clavicle_r",
  rightUpperArm: "upperarm_r",
  rightLowerArm: "lowerarm_r",
  rightHand: "hand_r",
  rightThumbMetacarpal: "thumb_01_r",
  rightThumbProximal: "thumb_02_r",
  rightThumbDistal: "thumb_03_r",
  rightIndexProximal: "index_01_r",
  rightIndexIntermediate: "index_02_r",
  rightIndexDistal: "index_03_r",
  rightMiddleProximal: "middle_01_r",
  rightMiddleIntermediate: "middle_02_r",
  rightMiddleDistal: "middle_03_r",
  rightRingProximal: "ring_01_r",
  rightRingIntermediate: "ring_02_r",
  rightRingDistal: "ring_03_r",
  rightLittleProximal: "pinky_01_r",
  rightLittleIntermediate: "pinky_02_r",
  rightLittleDistal: "pinky_03_r",
  leftUpperLeg: "thigh_l",
  leftLowerLeg: "calf_l",
  leftFoot: "foot_l",
  leftToes: "ball_l",
  rightUpperLeg: "thigh_r",
  rightLowerLeg: "calf_r",
  rightFoot: "foot_r",
  rightToes: "ball_r",
});

function align4(value) {
  return (value + 3) & ~3;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packNewGlb(document, binary) {
  const chunks = [
    {
      type: GLB_JSON_CHUNK,
      data: Buffer.from(JSON.stringify(document), "utf8"),
    },
    { type: 0x004e4942, data: binary },
  ];
  const totalLength =
    12 +
    chunks.reduce((total, chunk) => total + 8 + align4(chunk.data.length), 0);
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  let offset = 12;
  for (const chunk of chunks) {
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

function safeArchiveResourceEntry(sourceEntry, uri) {
  if (
    typeof uri !== "string" ||
    !uri ||
    /^(?:data|https?):/iu.test(uri) ||
    uri.startsWith("/") ||
    uri.includes("\\")
  ) {
    throw new Error(`Unsupported external GLTF resource: ${String(uri)}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`Malformed external GLTF resource: ${uri}`);
  }
  const entry = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourceEntry), decoded),
  );
  if (entry === ".." || entry.startsWith("../")) {
    throw new Error(`External GLTF resource escapes its archive root: ${uri}`);
  }
  return entry;
}

export function bundleGltfArchiveEntryToGlb({
  modelBytes,
  sourceEntry,
  readResource,
}) {
  const document = structuredClone(JSON.parse(modelBytes.toString("utf8")));
  const binaryParts = [];
  let binaryLength = 0;
  const append = (bytes) => {
    const byteOffset = align4(binaryLength);
    if (byteOffset > binaryLength) {
      binaryParts.push(Buffer.alloc(byteOffset - binaryLength));
    }
    const data = Buffer.from(bytes);
    binaryParts.push(data);
    binaryLength = byteOffset + data.length;
    return byteOffset;
  };

  const bufferOffsets = [];
  for (const [index, buffer] of (document.buffers ?? []).entries()) {
    if (typeof buffer.uri !== "string") {
      throw new Error(`GLTF buffer ${index} is not an external resource`);
    }
    const resourceEntry = safeArchiveResourceEntry(sourceEntry, buffer.uri);
    const resource = readResource(resourceEntry);
    if (!resource || resource.length !== buffer.byteLength) {
      throw new Error(`Missing or truncated GLTF buffer ${resourceEntry}`);
    }
    bufferOffsets[index] = append(resource);
  }
  for (const view of document.bufferViews ?? []) {
    const base = bufferOffsets[view.buffer ?? 0];
    if (!Number.isInteger(base)) {
      throw new Error("GLTF buffer view has no source buffer");
    }
    view.byteOffset = base + (view.byteOffset ?? 0);
    view.buffer = 0;
  }
  for (const image of document.images ?? []) {
    if (typeof image.uri !== "string") continue;
    const resourceEntry = safeArchiveResourceEntry(sourceEntry, image.uri);
    const resource = readResource(resourceEntry);
    if (!resource) throw new Error(`Missing GLTF image ${resourceEntry}`);
    const byteOffset = append(resource);
    document.bufferViews ??= [];
    image.bufferView = document.bufferViews.length;
    const extension = path.posix.extname(resourceEntry).toLowerCase();
    if (extension !== ".png" && extension !== ".jpg" && extension !== ".jpeg") {
      throw new Error(`Unsupported GLTF image type ${resourceEntry}`);
    }
    image.mimeType = extension === ".png" ? "image/png" : "image/jpeg";
    delete image.uri;
    document.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: resource.length,
    });
  }
  const binary = Buffer.concat(binaryParts);
  document.buffers = [{ byteLength: binary.length }];
  return packNewGlb(document, binary);
}

export function repairLockedGltfImageUris({
  modelBytes,
  repairs,
  readResource,
}) {
  const document = structuredClone(JSON.parse(modelBytes.toString("utf8")));
  const evidence = [];
  for (const repair of repairs ?? []) {
    const matches = (document.images ?? []).filter(
      (image) =>
        image.name === repair.imageName && image.uri === repair.missingUri,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${repair.imageName} image using ${repair.missingUri}; found ${matches.length}`,
      );
    }
    const replacement = readResource(repair.replacementEntry);
    const replacementSha256 = replacement ? sha256(replacement) : null;
    if (
      !replacement ||
      replacement.length !== repair.replacementBytes ||
      replacementSha256 !== repair.replacementSha256
    ) {
      throw new Error(
        `Locked replacement does not match ${repair.replacementEntry}`,
      );
    }
    matches[0].uri = repair.replacementUri;
    evidence.push({
      imageName: repair.imageName,
      missingUri: repair.missingUri,
      replacementUri: repair.replacementUri,
      replacementEntry: repair.replacementEntry,
      replacementBytes: replacement.length,
      replacementSha256,
    });
  }
  return {
    modelBytes: Buffer.from(JSON.stringify(document), "utf8"),
    evidence,
  };
}

function packGlbWithJson(source, document) {
  const chunks = [];
  let offset = 12;
  let jsonChunks = 0;
  while (offset + 8 <= source.length) {
    const length = source.readUInt32LE(offset);
    const type = source.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > source.length)
      throw new Error("Source GLB contains a truncated chunk");
    if (type === GLB_JSON_CHUNK) jsonChunks += 1;
    chunks.push({ type, data: Buffer.from(source.subarray(start, end)) });
    offset = end;
  }
  if (offset !== source.length || jsonChunks !== 1) {
    throw new Error("Source GLB must contain exactly one complete JSON chunk");
  }

  const encodedJson = Buffer.from(JSON.stringify(document), "utf8");
  const packedChunks = chunks.map((chunk) =>
    chunk.type === GLB_JSON_CHUNK ? { ...chunk, data: encodedJson } : chunk,
  );
  const totalLength =
    12 +
    packedChunks.reduce(
      (total, chunk) => total + 8 + align4(chunk.data.length),
      0,
    );
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);

  offset = 12;
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

function resolveHumanBones(document, humanBoneNodes, bodyLabel) {
  const indexByName = new Map();
  for (const [index, node] of (document.nodes ?? []).entries()) {
    if (typeof node.name !== "string" || !node.name) continue;
    if (indexByName.has(node.name)) {
      throw new Error(`${bodyLabel} has duplicate node name ${node.name}`);
    }
    indexByName.set(node.name, index);
  }
  return Object.fromEntries(
    Object.entries(humanBoneNodes).map(([humanBone, nodeName]) => {
      const node = indexByName.get(nodeName);
      if (!Number.isInteger(node)) {
        throw new Error(
          `${bodyLabel} is missing ${humanBone} node ${nodeName}`,
        );
      }
      return [humanBone, { node }];
    }),
  );
}

function convertBodyToVrm({
  source,
  sourceLabel,
  bodyLabel,
  humanBoneNodes,
  identity,
}) {
  const document = structuredClone(parseGlbJson(source, sourceLabel));
  if (document.extensions?.VRMC_vrm) {
    throw new Error(`${bodyLabel} unexpectedly already contains VRMC_vrm`);
  }
  const humanBones = resolveHumanBones(document, humanBoneNodes, bodyLabel);
  document.extensions = {
    ...(document.extensions ?? {}),
    VRMC_vrm: {
      specVersion: "1.0",
      humanoid: { humanBones },
      meta: {
        name: identity.name,
        version: identity.version,
        authors: identity.authors,
        copyrightInformation: identity.copyrightInformation,
        contactInformation: "",
        references: identity.references,
        thirdPartyLicenses:
          "CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/",
        licenseUrl: "https://vrm.dev/licenses/1.0/",
        avatarPermission: "everyone",
        allowExcessivelyViolentUsage: true,
        allowExcessivelySexualUsage: true,
        commercialUsage: "corporation",
        allowPoliticalOrReligiousUsage: true,
        allowAntisocialOrHateUsage: true,
        creditNotation: "unnecessary",
        allowRedistribution: true,
        modification: "allowModificationRedistribution",
        otherLicenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
    },
  };
  document.extensionsUsed = [
    ...new Set([...(document.extensionsUsed ?? []), "VRMC_vrm"]),
  ].sort();
  return packGlbWithJson(source, document);
}

export function convertKayKitBodyToVrm(source) {
  return convertBodyToVrm({
    source,
    sourceLabel: KAYKIT_BODY_ENTRY,
    bodyLabel: "KayKit body",
    humanBoneNodes: KAYKIT_HUMAN_BONE_NODES,
    identity: {
      name: "KayKit Knight",
      version: "2.0-hyperia-candidate.1",
      authors: ["Kay Lousberg", "Hyperia conversion pipeline"],
      copyrightInformation: "KayKit Adventurers, released under CC0 1.0",
      references: ["https://kaylousberg.itch.io/kaykit-adventurers"],
    },
  });
}

export function convertQuaterniusBodyToVrm(source) {
  return convertBodyToVrm({
    source,
    sourceLabel: QUATERNIUS_BODY_ENTRY,
    bodyLabel: "Quaternius body",
    humanBoneNodes: QUATERNIUS_HUMAN_BONE_NODES,
    identity: {
      name: "Quaternius Superhero Male",
      version: "standard-2025-12-16-hyperia-candidate.1",
      authors: ["Quaternius", "Hyperia conversion pipeline"],
      copyrightInformation: "Universal Base Characters, released under CC0 1.0",
      references: ["https://quaternius.itch.io/universal-base-characters"],
    },
  });
}

function animationEntryForGroup(group) {
  return `KayKit_Character_Animations_1.1/Animations/gltf/Rig_Medium/Rig_Medium_${group}.glb`;
}

export function selectGlbAnimation(
  source,
  clipName,
  sourceLabel = "animation GLB",
) {
  const document = structuredClone(parseGlbJson(source, sourceLabel));
  const matches = (document.animations ?? []).filter(
    (animation) => animation.name === clipName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${sourceLabel} must contain exactly one ${JSON.stringify(clipName)} clip; found ${matches.length}`,
    );
  }
  document.animations = matches;
  return packGlbWithJson(source, document);
}

function writeAtomic(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function buildKayKitLaunchCandidate({
  lock,
  downloadsDir,
  outputDir,
  check = false,
}) {
  const sourceAudit = await auditDuelLaunchAssetSources({ lock, downloadsDir });
  if (!sourceAudit.passed) {
    throw new Error(`Source audit failed:\n${sourceAudit.failures.join("\n")}`);
  }
  const pack = lock.packs.find((candidate) => candidate.id === KAYKIT_PACK_ID);
  if (!pack) throw new Error(`Source lock is missing ${KAYKIT_PACK_ID}`);
  const archiveBytes = readFileSync(path.join(downloadsDir, pack.archive.file));
  const archive = readZipArchive(archiveBytes, KAYKIT_PACK_ID);
  const body = archive.entries.get(KAYKIT_BODY_ENTRY)?.data;
  if (!body) throw new Error(`Source archive is missing ${KAYKIT_BODY_ENTRY}`);
  const inspection = pack.inspections.find(
    (candidate) => candidate.entry === KAYKIT_BODY_ENTRY,
  );
  if (!inspection || sha256(body) !== inspection.sha256) {
    throw new Error("KayKit body does not match its immutable inspection lock");
  }

  const roleOutputs = [];
  for (const role of KAYKIT_ROLE_KIT) {
    const sourceEntry = `KayKit_Adventurers_2.0_FREE/Assets/gltf/${role.entry}`;
    const sourceModel = archive.entries.get(sourceEntry)?.data;
    const sourceInspection = pack.inspections.find(
      (candidate) => candidate.entry === sourceEntry,
    );
    if (
      !sourceModel ||
      !sourceInspection ||
      sha256(sourceModel) !== sourceInspection.sha256
    ) {
      throw new Error(
        `Role-kit source does not match its lock: ${sourceEntry}`,
      );
    }
    const bytes = bundleGltfArchiveEntryToGlb({
      modelBytes: sourceModel,
      sourceEntry,
      readResource: (entry) => archive.entries.get(entry)?.data ?? null,
    });
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: `${role.id}.glb`,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    if (validation.issues.numErrors > 0) {
      throw new Error(
        `${role.id} has ${validation.issues.numErrors} Khronos validation errors`,
      );
    }
    roleOutputs.push({
      id: role.id,
      sourceEntry,
      sourceSha256: sourceInspection.sha256,
      asset: `role-kit/kaykit-${role.id}.glb`,
      content: bytes,
      bytes: bytes.length,
      sha256: sha256(bytes),
      triangles: sourceInspection.expected.triangles,
      vertices: sourceInspection.expected.vertices,
      textureCount: sourceInspection.expected.textureCount,
      validatorErrors: validation.issues.numErrors,
      validatorWarnings: validation.issues.numWarnings,
    });
  }

  const preparationPack = lock.packs.find(
    (candidate) => candidate.id === KAYKIT_PREPARATION_PACK_ID,
  );
  if (!preparationPack) {
    throw new Error(`Source lock is missing ${KAYKIT_PREPARATION_PACK_ID}`);
  }
  const preparationArchiveBytes = readFileSync(
    path.join(downloadsDir, preparationPack.archive.file),
  );
  const preparationArchive = readZipArchive(
    preparationArchiveBytes,
    KAYKIT_PREPARATION_PACK_ID,
  );
  const preparationOutputs = [];
  for (const tool of KAYKIT_PREPARATION_KIT) {
    const sourceEntry = `KayKit_RPGToolsBits_1.0_FREE/Assets/gltf/${tool.entry}`;
    const sourceModel = preparationArchive.entries.get(sourceEntry)?.data;
    const sourceInspection = preparationPack.inspections.find(
      (candidate) => candidate.entry === sourceEntry,
    );
    if (
      !sourceModel ||
      !sourceInspection ||
      sha256(sourceModel) !== sourceInspection.sha256
    ) {
      throw new Error(
        `Preparation-tool source does not match its lock: ${sourceEntry}`,
      );
    }
    const bytes = bundleGltfArchiveEntryToGlb({
      modelBytes: sourceModel,
      sourceEntry,
      readResource: (entry) =>
        preparationArchive.entries.get(entry)?.data ?? null,
    });
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: `${tool.id}.glb`,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    if (validation.issues.numErrors > 0 || validation.issues.numWarnings > 0) {
      throw new Error(
        `${tool.id} has ${validation.issues.numErrors} Khronos errors and ${validation.issues.numWarnings} warnings`,
      );
    }
    preparationOutputs.push({
      id: tool.id,
      sourcePackId: preparationPack.id,
      sourceArchiveSha256: preparationPack.archive.sha256,
      sourceEntry,
      sourceSha256: sourceInspection.sha256,
      asset: `preparation-kit/kaykit-rpg-${tool.id}.glb`,
      content: bytes,
      bytes: bytes.length,
      sha256: sha256(bytes),
      triangles: sourceInspection.expected.triangles,
      vertices: sourceInspection.expected.vertices,
      textureCount: sourceInspection.expected.textureCount,
      validatorErrors: validation.issues.numErrors,
      validatorWarnings: validation.issues.numWarnings,
    });
  }

  const animationPack = lock.packs.find(
    (candidate) => candidate.id === KAYKIT_ANIMATION_PACK_ID,
  );
  if (!animationPack) {
    throw new Error(`Source lock is missing ${KAYKIT_ANIMATION_PACK_ID}`);
  }
  const animationArchiveBytes = readFileSync(
    path.join(downloadsDir, animationPack.archive.file),
  );
  const animationArchive = readZipArchive(
    animationArchiveBytes,
    KAYKIT_ANIMATION_PACK_ID,
  );
  const motionOutputs = [];
  for (const motion of KAYKIT_MOTIONS) {
    const sourceEntry = animationEntryForGroup(motion.group);
    const sourceMotion = animationArchive.entries.get(sourceEntry)?.data;
    const sourceInspection = animationPack.inspections.find(
      (candidate) => candidate.entry === sourceEntry,
    );
    if (
      !sourceMotion ||
      !sourceInspection ||
      sha256(sourceMotion) !== sourceInspection.sha256
    ) {
      throw new Error(`Motion source does not match its lock: ${sourceEntry}`);
    }
    const bytes = selectGlbAnimation(sourceMotion, motion.clip, sourceEntry);
    const document = parseGlbJson(bytes, motion.clip);
    const animation = document.animations?.[0];
    const durationSeconds = Math.max(
      0,
      ...(animation?.samplers ?? []).map(
        (sampler) => document.accessors?.[sampler.input]?.max?.[0] ?? 0,
      ),
    );
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`${motion.clip} has no finite positive duration`);
    }
    const validation = await validator.validateBytes(new Uint8Array(bytes), {
      uri: `${motion.id}.glb`,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    });
    if (validation.issues.numErrors > 0) {
      throw new Error(
        `${motion.clip} has ${validation.issues.numErrors} Khronos validation errors`,
      );
    }
    motionOutputs.push({
      id: motion.id,
      name: motion.name,
      sourceEntry,
      sourceSha256: sourceInspection.sha256,
      clip: motion.clip,
      sampleRatio: motion.sampleRatio,
      durationSeconds,
      asset: `motions/kaykit-${motion.id}.glb`,
      content: bytes,
      bytes: bytes.length,
      sha256: sha256(bytes),
      validatorErrors: validation.issues.numErrors,
      validatorWarnings: validation.issues.numWarnings,
    });
  }

  const output = convertKayKitBodyToVrm(body);
  const document = parseGlbJson(output, OUTPUT_FILE);
  const summary = summarizeVrmDocument(document, output);
  const validation = await validator.validateBytes(new Uint8Array(output), {
    uri: OUTPUT_FILE,
    format: "glb",
    writeTimestamp: false,
    maxIssues: 1_000,
  });
  if (summary.missingRequiredBones.length > 0) {
    throw new Error(
      `Candidate is missing required bones: ${summary.missingRequiredBones.join(", ")}`,
    );
  }
  if (validation.issues.numErrors > 0) {
    throw new Error(
      `Candidate has ${validation.issues.numErrors} Khronos validation errors`,
    );
  }

  const lodOutputs = [];
  for (const profile of KAYKIT_LOD_PROFILES) {
    const optimized = await optimizeVrmLod(output, {
      maxTriangles: profile.maxTriangles,
      maxTextureSize: profile.maxTextureSize,
      maxError: profile.maxError,
      source: `${OUTPUT_FILE} ${profile.id}`,
    });
    const lodDocument = parseGlbJson(optimized.output, profile.file);
    const lodSummary = summarizeVrmDocument(lodDocument, optimized.output);
    const lodValidation = await validator.validateBytes(
      new Uint8Array(optimized.output),
      {
        uri: profile.file,
        format: "glb",
        writeTimestamp: false,
        maxIssues: 1_000,
      },
    );
    if (lodValidation.issues.numErrors > 0) {
      throw new Error(
        `${profile.id} has ${lodValidation.issues.numErrors} Khronos validation errors`,
      );
    }
    lodOutputs.push({
      ...profile,
      content: optimized.output,
      bytes: optimized.output.length,
      sha256: sha256(optimized.output),
      triangles: lodSummary.triangles,
      vertices: lodSummary.vertices,
      maxTextureDimension: Math.max(
        0,
        ...lodSummary.textureDimensions.flatMap(({ width, height }) => [
          width,
          height,
        ]),
      ),
      rigFingerprint: lodSummary.rigFingerprint,
      validatorErrors: lodValidation.issues.numErrors,
      validatorWarnings: lodValidation.issues.numWarnings,
      simplificationErrors: optimized.report.simplificationErrors,
      primitiveDetails: optimized.report.primitiveDetails,
    });
  }

  const quaterniusPack = lock.packs.find(
    (candidate) => candidate.id === QUATERNIUS_PACK_ID,
  );
  if (!quaterniusPack) {
    throw new Error(`Source lock is missing ${QUATERNIUS_PACK_ID}`);
  }
  const quaterniusArchive = readZipArchive(
    readFileSync(path.join(downloadsDir, quaterniusPack.archive.file)),
    QUATERNIUS_PACK_ID,
  );
  const quaterniusBody = quaterniusArchive.entries.get(
    QUATERNIUS_BODY_ENTRY,
  )?.data;
  const quaterniusInspection = quaterniusPack.inspections.find(
    (candidate) => candidate.entry === QUATERNIUS_BODY_ENTRY,
  );
  if (
    !quaterniusBody ||
    !quaterniusInspection ||
    sha256(quaterniusBody) !== quaterniusInspection.sha256
  ) {
    throw new Error(
      "Quaternius body does not match its immutable inspection lock",
    );
  }
  const repairedQuaternius = repairLockedGltfImageUris({
    modelBytes: quaterniusBody,
    repairs: quaterniusInspection.repairs,
    readResource: (entry) => quaterniusArchive.entries.get(entry)?.data ?? null,
  });
  const bundledQuaternius = bundleGltfArchiveEntryToGlb({
    modelBytes: repairedQuaternius.modelBytes,
    sourceEntry: QUATERNIUS_BODY_ENTRY,
    readResource: (entry) => quaterniusArchive.entries.get(entry)?.data ?? null,
  });
  const quaterniusOutput = convertQuaterniusBodyToVrm(bundledQuaternius);
  const quaterniusDocument = parseGlbJson(
    quaterniusOutput,
    QUATERNIUS_OUTPUT_FILE,
  );
  const quaterniusSummary = summarizeVrmDocument(
    quaterniusDocument,
    quaterniusOutput,
  );
  const quaterniusValidation = await validator.validateBytes(
    new Uint8Array(quaterniusOutput),
    {
      uri: QUATERNIUS_OUTPUT_FILE,
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    },
  );
  if (quaterniusSummary.missingRequiredBones.length > 0) {
    throw new Error(
      `Quaternius candidate is missing required bones: ${quaterniusSummary.missingRequiredBones.join(", ")}`,
    );
  }
  if (quaterniusValidation.issues.numErrors > 0) {
    throw new Error(
      `Quaternius candidate has ${quaterniusValidation.issues.numErrors} Khronos validation errors`,
    );
  }
  const quaterniusAnimationPack = lock.packs.find(
    (candidate) => candidate.id === QUATERNIUS_ANIMATION_PACK_ID,
  );
  if (!quaterniusAnimationPack) {
    throw new Error(`Source lock is missing ${QUATERNIUS_ANIMATION_PACK_ID}`);
  }
  const quaterniusAnimationArchive = readZipArchive(
    readFileSync(path.join(downloadsDir, quaterniusAnimationPack.archive.file)),
    QUATERNIUS_ANIMATION_PACK_ID,
  );
  const quaterniusAnimationSource = quaterniusAnimationArchive.entries.get(
    QUATERNIUS_ANIMATION_ENTRY,
  )?.data;
  const quaterniusAnimationInspection =
    quaterniusAnimationPack.inspections.find(
      (candidate) => candidate.entry === QUATERNIUS_ANIMATION_ENTRY,
    );
  if (
    !quaterniusAnimationSource ||
    !quaterniusAnimationInspection ||
    sha256(quaterniusAnimationSource) !== quaterniusAnimationInspection.sha256
  ) {
    throw new Error(
      "Quaternius motion source does not match its immutable inspection lock",
    );
  }
  const quaterniusMotionOutputs = [];
  for (const motion of QUATERNIUS_MOTIONS) {
    const bytes = selectGlbAnimation(
      quaterniusAnimationSource,
      motion.clip,
      QUATERNIUS_ANIMATION_ENTRY,
    );
    const motionDocument = parseGlbJson(bytes, motion.clip);
    const animation = motionDocument.animations?.[0];
    const durationSeconds = Math.max(
      0,
      ...(animation?.samplers ?? []).map(
        (sampler) => motionDocument.accessors?.[sampler.input]?.max?.[0] ?? 0,
      ),
    );
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`${motion.clip} has no finite positive duration`);
    }
    const motionValidation = await validator.validateBytes(
      new Uint8Array(bytes),
      {
        uri: `quaternius-${motion.id}.glb`,
        format: "glb",
        writeTimestamp: false,
        maxIssues: 1_000,
      },
    );
    if (motionValidation.issues.numErrors > 0) {
      throw new Error(
        `${motion.clip} has ${motionValidation.issues.numErrors} Khronos validation errors`,
      );
    }
    quaterniusMotionOutputs.push({
      ...motion,
      sourceEntry: QUATERNIUS_ANIMATION_ENTRY,
      sourceSha256: quaterniusAnimationInspection.sha256,
      asset: `motions/quaternius-${motion.id}.glb`,
      content: bytes,
      bytes: bytes.length,
      sha256: sha256(bytes),
      durationSeconds,
      validatorErrors: motionValidation.issues.numErrors,
      validatorWarnings: motionValidation.issues.numWarnings,
    });
  }
  const quaterniusReport = {
    schemaVersion: 1,
    candidateId: "quaternius-superhero-male",
    activated: false,
    disposition: "secondary-repaired-technical-candidate",
    source: {
      packId: quaterniusPack.id,
      archive: quaterniusPack.archive.file,
      archiveSha256: quaterniusPack.archive.sha256,
      entry: QUATERNIUS_BODY_ENTRY,
      entrySha256: sha256(quaterniusBody),
      repairs: repairedQuaternius.evidence,
    },
    output: {
      file: QUATERNIUS_OUTPUT_FILE,
      bytes: quaterniusOutput.length,
      sha256: sha256(quaterniusOutput),
    },
    humanBoneNodes: QUATERNIUS_HUMAN_BONE_NODES,
    metrics: {
      triangles: quaterniusSummary.triangles,
      vertices: quaterniusSummary.vertices,
      primitiveCount: quaterniusSummary.primitiveCount,
      skinCount: quaterniusSummary.skinCount,
      jointCount: Math.max(0, ...quaterniusSummary.jointCounts),
      textureCount: quaterniusDocument.images?.length ?? 0,
      maxTextureDimension: Math.max(
        0,
        ...quaterniusSummary.textureDimensions.flatMap(({ width, height }) => [
          width,
          height,
        ]),
      ),
      rigFingerprint: quaterniusSummary.rigFingerprint,
    },
    validator: {
      errors: quaterniusValidation.issues.numErrors,
      warnings: quaterniusValidation.issues.numWarnings,
      warningCodes: [
        ...new Set(
          quaterniusValidation.issues.messages
            .filter((issue) => issue.severity === 1)
            .map((issue) => issue.code),
        ),
      ].sort(),
    },
    motions: quaterniusMotionOutputs.map(({ content, ...motion }) => motion),
  };
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const stevePath = path.join(
    workspaceRoot,
    "packages/server/world/assets/avatars/duel-candidates/duel-steve.vrm",
  );
  const steveOutput = readFileSync(stevePath);
  const steveDocument = parseGlbJson(steveOutput, stevePath);
  const steveSummary = summarizeVrmDocument(steveDocument, steveOutput);
  const steveValidation = await validator.validateBytes(
    new Uint8Array(steveOutput),
    {
      uri: "duel-steve.vrm",
      format: "glb",
      writeTimestamp: false,
      maxIssues: 1_000,
    },
  );
  if (
    steveSummary.missingRequiredBones.length > 0 ||
    steveValidation.issues.numErrors > 0
  ) {
    throw new Error("Existing Steve baseline is not validator/VRM clean");
  }
  const steveComparison = {
    candidateId: "steve",
    disposition: "existing-canonical-technical-baseline",
    asset: path.relative(workspaceRoot, stevePath).split(path.sep).join("/"),
    bytes: steveOutput.length,
    sha256: sha256(steveOutput),
    triangles: steveSummary.triangles,
    vertices: steveSummary.vertices,
    jointCount: Math.max(0, ...steveSummary.jointCounts),
    textureCount: steveDocument.images?.length ?? 0,
    maxTextureDimension: Math.max(
      0,
      ...steveSummary.textureDimensions.flatMap(({ width, height }) => [
        width,
        height,
      ]),
    ),
    rigFingerprint: steveSummary.rigFingerprint,
    validatorErrors: steveValidation.issues.numErrors,
    validatorWarnings: steveValidation.issues.numWarnings,
  };

  const report = {
    schemaVersion: 2,
    candidateId: "kaykit-knight",
    activated: false,
    source: {
      packId: pack.id,
      archive: pack.archive.file,
      archiveSha256: pack.archive.sha256,
      entry: KAYKIT_BODY_ENTRY,
      entrySha256: sha256(body),
    },
    output: {
      file: OUTPUT_FILE,
      bytes: output.length,
      sha256: sha256(output),
    },
    humanBoneNodes: KAYKIT_HUMAN_BONE_NODES,
    metrics: {
      triangles: summary.triangles,
      vertices: summary.vertices,
      primitiveCount: summary.primitiveCount,
      skinCount: summary.skinCount,
      jointCount: Math.max(0, ...summary.jointCounts),
      textureCount: document.images?.length ?? 0,
      maxTextureDimension: Math.max(
        0,
        ...summary.textureDimensions.flatMap(({ width, height }) => [
          width,
          height,
        ]),
      ),
      rigFingerprint: summary.rigFingerprint,
    },
    validator: {
      errors: validation.issues.numErrors,
      warnings: validation.issues.numWarnings,
      warningCodes: [
        ...new Set(
          validation.issues.messages
            .filter((issue) => issue.severity === 1)
            .map((issue) => issue.code),
        ),
      ].sort(),
    },
    lods: [
      {
        id: "lod0",
        file: OUTPUT_FILE,
        bytes: output.length,
        sha256: sha256(output),
        triangles: summary.triangles,
        vertices: summary.vertices,
        maxTextureDimension: Math.max(
          0,
          ...summary.textureDimensions.flatMap(({ width, height }) => [
            width,
            height,
          ]),
        ),
        rigFingerprint: summary.rigFingerprint,
        validatorErrors: validation.issues.numErrors,
        validatorWarnings: validation.issues.numWarnings,
      },
      ...lodOutputs.map(({ content, ...lod }) => lod),
    ],
    roleKit: roleOutputs.map(({ content, ...role }) => role),
    preparationKit: preparationOutputs.map(({ content, ...tool }) => tool),
    motions: motionOutputs.map(({ content, ...motion }) => motion),
    secondaryCandidates: [quaterniusReport],
  };
  const outputPath = path.join(outputDir, OUTPUT_FILE);
  const quaterniusOutputPath = path.join(outputDir, QUATERNIUS_OUTPUT_FILE);
  const reportPath = path.join(outputDir, REPORT_FILE);
  const quaterniusReportPath = path.join(outputDir, QUATERNIUS_REPORT_FILE);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const quaterniusReportBytes = Buffer.from(
    `${JSON.stringify(quaterniusReport, null, 2)}\n`,
  );
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        title: "Hyperia non-AI launch-avatar bake-off",
        subtitle:
          "Isolated source candidate · not registered in the active avatar manifest",
        candidates: [
          {
            id: report.candidateId,
            name: "KayKit Knight",
            archetype: "CC0 primary technical candidate",
            lods: report.lods.map((lod) => ({
              lod: lod.id,
              asset: lod.file,
              triangles: lod.triangles,
              bytes: lod.bytes,
            })),
          },
          {
            id: quaterniusReport.candidateId,
            name: "Quaternius Superhero Male",
            archetype: "CC0 secondary repaired technical candidate",
            lods: [
              {
                lod: "source-vrm",
                asset: QUATERNIUS_OUTPUT_FILE,
                triangles: quaterniusReport.metrics.triangles,
                bytes: quaterniusReport.output.bytes,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const comparisonCandidates = [
    {
      id: "kaykit-knight",
      name: "KayKit Knight",
      archetype: "CC0 primary technical candidate",
      asset: path
        .relative(workspaceRoot, path.join(outputDir, OUTPUT_FILE))
        .split(path.sep)
        .join("/"),
      triangles: summary.triangles,
      bytes: output.length,
    },
    {
      id: quaterniusReport.candidateId,
      name: "Quaternius Superhero Male",
      archetype: "CC0 secondary repaired technical candidate",
      asset: path
        .relative(workspaceRoot, path.join(outputDir, QUATERNIUS_OUTPUT_FILE))
        .split(path.sep)
        .join("/"),
      triangles: quaterniusSummary.triangles,
      bytes: quaterniusOutput.length,
    },
    {
      id: steveComparison.candidateId,
      name: "Steve",
      archetype: "Existing canonical technical baseline",
      asset: steveComparison.asset,
      triangles: steveComparison.triangles,
      bytes: steveComparison.bytes,
    },
  ];
  const comparisonManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        title: "Hyperia launch-avatar source comparison",
        subtitle:
          "Source-body technical comparison · no canonical selection or active registry change",
        candidates: comparisonCandidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          archetype: candidate.archetype,
          lods: [
            {
              lod: "source-vrm",
              asset: candidate.asset,
              triangles: candidate.triangles,
              bytes: candidate.bytes,
            },
          ],
        })),
      },
      null,
      2,
    )}\n`,
  );
  const comparisonManifestPath = path.join(outputDir, COMPARISON_MANIFEST_FILE);
  const comparisonReportBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        activated: false,
        canonicalSelection: "unresolved",
        candidates: [
          {
            candidateId: report.candidateId,
            disposition: "primary-fit-and-live-gates-pending",
            output: report.output,
            metrics: report.metrics,
            lods: report.lods,
            validator: report.validator,
            standaloneRoleKitCount: report.roleKit.length,
            standalonePreparationToolCount: report.preparationKit.length,
            selectedMotionCount: report.motions.length + 1,
          },
          {
            candidateId: quaterniusReport.candidateId,
            disposition: quaterniusReport.disposition,
            output: quaterniusReport.output,
            metrics: quaterniusReport.metrics,
            validator: quaterniusReport.validator,
            repairedSourceReferenceCount:
              quaterniusReport.source.repairs.length,
            selectedMotionCount: quaterniusReport.motions.length,
          },
          steveComparison,
        ],
      },
      null,
      2,
    )}\n`,
  );
  const comparisonReportPath = path.join(outputDir, COMPARISON_REPORT_FILE);
  const roleKitManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        title: "Hyperia non-AI launch role-kit bake-off",
        subtitle:
          "Isolated CC0 equipment candidates · no active item path or fit authority changed",
        candidates: report.roleKit.map((role) => ({
          id: role.id,
          name: `KayKit ${role.id}`,
          archetype: "CC0 coherent role-kit candidate",
          lods: [
            {
              kind: "model",
              lod: "source-glb",
              asset: role.asset,
              rotationDegrees:
                role.id === "bow" || role.id === "arrow"
                  ? [90, 0, 0]
                  : [0, 0, 0],
              triangles: role.triangles,
              bytes: role.bytes,
            },
          ],
        })),
      },
      null,
      2,
    )}\n`,
  );
  const roleKitManifestPath = path.join(outputDir, ROLE_KIT_MANIFEST_FILE);
  const preparationKitManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        title: "Hyperia non-AI preparation-tool bake-off",
        subtitle:
          "Isolated CC0 candidates · no active item path or fit authority changed",
        candidates: report.preparationKit.map((tool) => ({
          id: tool.id,
          name: `KayKit ${tool.id}`,
          archetype: "CC0 coherent preparation-tool candidate",
          sourcePackId: tool.sourcePackId,
          sourceArchiveSha256: tool.sourceArchiveSha256,
          sourceEntry: tool.sourceEntry,
          sourceSha256: tool.sourceSha256,
          asset: tool.asset,
          triangles: tool.triangles,
          vertices: tool.vertices,
          bytes: tool.bytes,
          sha256: tool.sha256,
        })),
      },
      null,
      2,
    )}\n`,
  );
  const preparationKitManifestPath = path.join(
    outputDir,
    PREPARATION_KIT_MANIFEST_FILE,
  );
  const motionManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        title: "KayKit Knight combat and preparation motion audit",
        motions: [
          ...report.motions.map(({ id, name, asset, sampleRatio }) => ({
            id,
            name,
            asset,
            sampleRatio,
          })),
          {
            id: "hit-reaction",
            name: "Hit reaction overlay",
            asset: "motions/kaykit-idle.glb",
            sampleRatio: 0,
            hitReaction: {
              intensity: 1,
              side: 1,
              elapsedSeconds: 0.0504,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const motionManifestPath = path.join(outputDir, MOTION_MANIFEST_FILE);
  const quaterniusMotionManifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        title: "Quaternius repaired secondary-candidate motion audit",
        motions: quaterniusReport.motions.map(
          ({ id, name, asset, sampleRatio }) => ({
            id,
            name,
            asset,
            sampleRatio,
          }),
        ),
      },
      null,
      2,
    )}\n`,
  );
  const quaterniusMotionManifestPath = path.join(
    outputDir,
    QUATERNIUS_MOTION_MANIFEST_FILE,
  );
  const generatedFiles = [
    [outputPath, output],
    [quaterniusOutputPath, quaterniusOutput],
    [reportPath, reportBytes],
    [quaterniusReportPath, quaterniusReportBytes],
    [manifestPath, manifestBytes],
    [comparisonManifestPath, comparisonManifestBytes],
    [comparisonReportPath, comparisonReportBytes],
    [roleKitManifestPath, roleKitManifestBytes],
    [preparationKitManifestPath, preparationKitManifestBytes],
    [motionManifestPath, motionManifestBytes],
    [quaterniusMotionManifestPath, quaterniusMotionManifestBytes],
    ...lodOutputs.map((lod) => [path.join(outputDir, lod.file), lod.content]),
    ...motionOutputs.map((motion) => [
      path.join(outputDir, motion.asset),
      motion.content,
    ]),
    ...quaterniusMotionOutputs.map((motion) => [
      path.join(outputDir, motion.asset),
      motion.content,
    ]),
    ...roleOutputs.map((role) => [
      path.join(outputDir, role.asset),
      role.content,
    ]),
    ...preparationOutputs.map((tool) => [
      path.join(outputDir, tool.asset),
      tool.content,
    ]),
  ];

  if (check) {
    for (const [file, expected] of generatedFiles) {
      if (!existsSync(file) || !readFileSync(file).equals(expected)) {
        throw new Error(`Generated candidate is missing or stale: ${file}`);
      }
    }
  } else {
    for (const [file, expected] of generatedFiles) writeAtomic(file, expected);
  }
  return report;
}

function parseCliArgs(argv) {
  const options = {
    downloadsDir: null,
    outputDir: null,
    lockPath: null,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--downloads-dir")
      options.downloadsDir = argv[++index];
    else if (argument === "--output-dir") options.outputDir = argv[++index];
    else if (argument === "--lock") options.lockPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const lockPath = path.resolve(
    options.lockPath ??
      path.join(workspaceRoot, "scripts/duel-launch-asset-sources.json"),
  );
  const downloadsDir = path.resolve(
    options.downloadsDir ??
      process.env.HYPERIA_DUEL_ASSET_DOWNLOADS_DIR ??
      path.join(workspaceRoot, "artifacts/duel-launch-assets/downloads"),
  );
  const outputDir = path.resolve(
    options.outputDir ??
      path.join(workspaceRoot, "artifacts/duel-launch-avatar-bakeoff"),
  );
  const report = await buildKayKitLaunchCandidate({
    lock: JSON.parse(readFileSync(lockPath, "utf8")),
    downloadsDir,
    outputDir,
    check: options.check,
  });
  console.log(
    `KayKit launch candidate ${options.check ? "verified" : "built"}: ${report.output.bytes} bytes, SHA-256 ${report.output.sha256}, ${report.validator.errors} validator errors.`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
