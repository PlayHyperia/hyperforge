#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ASSET_URL_PREFIX = "asset://";
const VISIBLE_ARMOR_SLOTS = new Set([
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "shield",
]);
const VISIBLE_COMBAT_SLOTS = new Set(["weapon", ...VISIBLE_ARMOR_SLOTS]);
const DEFORMING_SLOTS = new Set(["body", "legs", "boots", "gloves", "cape"]);
const LAUNCH_MINIMUM_IDS = Object.freeze([
  "bronze_shortsword",
  "bronze_longsword",
  "bronze_scimitar",
  "shortbow",
  "magic_shortbow",
  "staff_of_air",
]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function launchMinimumCertificationsFromManifest(
  manifest,
  { avatarId = "steve", legacyAvatarId = "/api/assets/steve/model" } = {},
) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 2 ||
    manifest.avatarId !== avatarId ||
    manifest.legacyAvatarId !== legacyAvatarId ||
    !Array.isArray(manifest.certifications) ||
    manifest.certifications.length === 0
  ) {
    throw new Error("invalid_launch_certification_manifest");
  }

  const itemIds = new Set();
  return manifest.certifications.map((certification) => {
    if (
      !isRecord(certification) ||
      typeof certification.itemId !== "string" ||
      !SAFE_ID_PATTERN.test(certification.itemId) ||
      typeof certification.slot !== "string" ||
      !VISIBLE_COMBAT_SLOTS.has(certification.slot) ||
      typeof certification.path !== "string" ||
      !certification.path.startsWith("packages/server/world/assets/") ||
      path.posix.normalize(certification.path) !== certification.path ||
      typeof certification.sha256 !== "string" ||
      !SHA256_PATTERN.test(certification.sha256) ||
      itemIds.has(certification.itemId)
    ) {
      throw new Error("invalid_launch_certification_entry");
    }
    itemIds.add(certification.itemId);
    return {
      itemId: certification.itemId,
      slot: certification.slot,
      path: certification.path,
      sha256: certification.sha256,
    };
  });
}

function parseGlbDocument(bytes) {
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== GLB_MAGIC ||
    bytes.readUInt32LE(4) !== GLB_VERSION ||
    bytes.readUInt32LE(8) !== bytes.length
  ) {
    throw new Error("invalid_glb_framing");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (length % 4 !== 0 || end > bytes.length) {
      throw new Error("invalid_glb_chunk");
    }
    if (type === JSON_CHUNK_TYPE) {
      const text = bytes
        .subarray(start, end)
        .toString("utf8")
        .replace(/[\0\x20]+$/u, "");
      const document = JSON.parse(text);
      if (!isRecord(document)) throw new Error("invalid_glb_json_root");
      return document;
    }
    offset = end;
  }
  throw new Error("missing_glb_json_chunk");
}

function readLoaderAuthorities(document) {
  const sceneIndex = Number.isInteger(document.scene) ? document.scene : 0;
  const scene = Array.isArray(document.scenes)
    ? document.scenes[sceneIndex]
    : null;
  const rootIndex =
    isRecord(scene) && Array.isArray(scene.nodes) ? scene.nodes[0] : null;
  const root =
    Number.isInteger(rootIndex) && Array.isArray(document.nodes)
      ? document.nodes[rootIndex]
      : null;
  const sceneMetadata =
    isRecord(scene) && isRecord(scene.extras) && isRecord(scene.extras.hyperia)
      ? scene.extras.hyperia
      : null;
  const rootMetadata =
    isRecord(root) && isRecord(root.extras) && isRecord(root.extras.hyperia)
      ? root.extras.hyperia
      : null;
  return { sceneMetadata, rootMetadata };
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validAttachment(metadata, slot) {
  const allowedBones =
    slot === "shield"
      ? new Set(["leftHand"])
      : slot === "helmet"
        ? new Set(["head"])
        : new Set(["leftHand", "rightHand"]);
  return Boolean(
    metadata?.version === 2 &&
    allowedBones.has(metadata.vrmBoneName) &&
    Array.isArray(metadata.relativeMatrix) &&
    metadata.relativeMatrix.length === 16 &&
    metadata.relativeMatrix.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
  );
}

function validFit(fit) {
  return Boolean(
    isRecord(fit) &&
    fit.schemaVersion === 1 &&
    typeof fit.itemId === "string" &&
    SAFE_ID_PATTERN.test(fit.itemId) &&
    typeof fit.slot === "string" &&
    SAFE_ID_PATTERN.test(fit.slot) &&
    Array.isArray(fit.compatibleAvatarIds) &&
    fit.compatibleAvatarIds.length > 0 &&
    fit.compatibleAvatarIds.every(
      (avatarId) =>
        typeof avatarId === "string" && SAFE_ID_PATTERN.test(avatarId),
    ) &&
    new Set(fit.compatibleAvatarIds).size === fit.compatibleAvatarIds.length,
  );
}

function resolveAssetUrl(assetsRoot, assetUrl) {
  if (typeof assetUrl !== "string" || !assetUrl.startsWith(ASSET_URL_PREFIX)) {
    throw new Error("invalid_asset_url");
  }
  const relativePath = assetUrl.slice(ASSET_URL_PREFIX.length);
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath ||
    normalized.startsWith("../") ||
    path.isAbsolute(normalized)
  ) {
    throw new Error("asset_url_escapes_root");
  }
  const resolved = path.resolve(assetsRoot, normalized);
  if (!resolved.startsWith(`${assetsRoot}${path.sep}`)) {
    throw new Error("asset_url_escapes_root");
  }
  return { relativePath: normalized, resolved };
}

function visibleItems(weapons, armor) {
  const visibleWeapons = weapons
    .filter((item) => isRecord(item) && item.type === "weapon")
    .map((item) => ({
      ...item,
      sourceManifest: "items/weapons.json",
      competitiveSlot: "weapon",
      combatStyle:
        typeof item.attackType === "string"
          ? item.attackType.toLowerCase()
          : null,
    }));
  const visibleArmor = armor
    .filter(
      (item) =>
        isRecord(item) &&
        typeof item.equipSlot === "string" &&
        VISIBLE_ARMOR_SLOTS.has(item.equipSlot),
    )
    .map((item) => ({
      ...item,
      sourceManifest: "items/armor.json",
      competitiveSlot: item.equipSlot,
      combatStyle: null,
    }));
  return [...visibleWeapons, ...visibleArmor];
}

function summarizeBlockers(items) {
  const result = {};
  for (const item of items) {
    for (const blocker of item.blockers) {
      result[blocker] = (result[blocker] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function auditDuelEquipmentFit({
  assetsRoot,
  avatarId = "steve",
  legacyAvatarId = "/api/assets/steve/model",
  launchMinimumCertifications = null,
}) {
  const manifestsRoot = path.join(assetsRoot, "manifests");
  const weaponManifestPath = path.join(manifestsRoot, "items", "weapons.json");
  const armorManifestPath = path.join(manifestsRoot, "items", "armor.json");
  const weaponBytes = readFileSync(weaponManifestPath);
  const armorBytes = readFileSync(armorManifestPath);
  const weapons = JSON.parse(weaponBytes.toString("utf8"));
  const armor = JSON.parse(armorBytes.toString("utf8"));
  if (!Array.isArray(weapons) || !Array.isArray(armor)) {
    throw new Error("Equipment manifests must contain arrays");
  }

  const sourceItems = visibleItems(weapons, armor);
  const pathUsers = new Map();
  for (const item of sourceItems) {
    if (typeof item.equippedModelPath !== "string") continue;
    const users = pathUsers.get(item.equippedModelPath) ?? [];
    users.push(item.id);
    pathUsers.set(item.equippedModelPath, users);
  }

  const items = sourceItems.map((item) => {
    if (typeof item.id !== "string" || !SAFE_ID_PATTERN.test(item.id)) {
      throw new Error(
        `${item.sourceManifest} contains an invalid competitive item ID`,
      );
    }
    const blockers = [];
    let assetRelativePath = null;
    let assetSha256 = null;
    const declaredContentSha256 =
      typeof item.equippedModelSha256 === "string"
        ? item.equippedModelSha256
        : null;
    let fit = null;
    let attachment = null;
    let certifiableWithoutRefit = false;
    const avatarSpecificContent = [];
    const sharedByItemIds =
      typeof item.equippedModelPath === "string"
        ? [...(pathUsers.get(item.equippedModelPath) ?? [])]
        : [];

    if (typeof item.equippedModelPath !== "string") {
      blockers.push("missing_equipped_model");
    } else {
      let resolved;
      try {
        resolved = resolveAssetUrl(assetsRoot, item.equippedModelPath);
        assetRelativePath = resolved.relativePath;
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : "invalid_asset_url",
        );
      }
      if (resolved) {
        let bytes;
        try {
          bytes = readFileSync(resolved.resolved);
          assetSha256 = sha256(bytes);
        } catch {
          blockers.push("missing_asset");
        }
        if (bytes) {
          try {
            const document = parseGlbDocument(bytes);
            const { sceneMetadata, rootMetadata } =
              readLoaderAuthorities(document);
            const sceneFit = sceneMetadata?.duelFit;
            const rootFit = rootMetadata?.duelFit;
            const authority = rootMetadata ?? sceneMetadata;
            attachment = authority
              ? {
                  version: authority.version ?? null,
                  vrmBoneName: authority.vrmBoneName ?? null,
                  avatarId: authority.avatarId ?? null,
                  hasFiniteRelativeMatrix: Boolean(
                    Array.isArray(authority.relativeMatrix) &&
                    authority.relativeMatrix.length === 16 &&
                    authority.relativeMatrix.every(
                      (value) =>
                        typeof value === "number" && Number.isFinite(value),
                    ),
                  ),
                }
              : null;

            if (!sceneFit || !rootFit) {
              blockers.push("missing_fit_metadata");
            } else if (!exactJson(sceneFit, rootFit)) {
              blockers.push("inconsistent_fit_authority");
            } else if (!validFit(sceneFit)) {
              blockers.push("invalid_fit_metadata");
            } else {
              fit = sceneFit;
              if (fit.itemId !== item.id) blockers.push("fit_item_mismatch");
              if (fit.slot !== item.competitiveSlot) {
                blockers.push("fit_slot_mismatch");
              }
              if (!fit.compatibleAvatarIds.includes(avatarId)) {
                blockers.push("incompatible_avatar");
              }
              if (!declaredContentSha256) {
                blockers.push("missing_content_hash");
              } else if (!SHA256_PATTERN.test(declaredContentSha256)) {
                blockers.push("invalid_content_hash");
              } else if (declaredContentSha256 !== assetSha256) {
                blockers.push("content_hash_mismatch");
              }
            }

            if (DEFORMING_SLOTS.has(item.competitiveSlot)) {
              if (
                !fit ||
                typeof fit.rigFingerprint !== "string" ||
                !SHA256_PATTERN.test(fit.rigFingerprint)
              ) {
                blockers.push("missing_rig_fingerprint");
              }
            } else if (!validAttachment(authority, item.competitiveSlot)) {
              blockers.push("invalid_rigid_attachment");
            } else if (authority.avatarId !== legacyAvatarId) {
              blockers.push("requires_avatar_refit");
            }

            certifiableWithoutRefit = Boolean(
              blockers.length === 1 &&
              blockers[0] === "missing_fit_metadata" &&
              sharedByItemIds.length === 1,
            );
          } catch (error) {
            blockers.push(
              error instanceof Error ? error.message : "invalid_glb",
            );
          }
        }
      }
    }
    if (sharedByItemIds.length > 1) {
      blockers.push("shared_asset_requires_unique_outputs");
      certifiableWithoutRefit = false;
    }

    if (isRecord(item.equippedModelPathsByAvatar)) {
      const declaredHashes = isRecord(item.equippedModelSha256ByAvatar)
        ? item.equippedModelSha256ByAvatar
        : {};
      for (const [specificAvatarId, assetUrl] of Object.entries(
        item.equippedModelPathsByAvatar,
      ).sort(([left], [right]) => left.localeCompare(right))) {
        const declaredSha256 =
          typeof declaredHashes[specificAvatarId] === "string"
            ? declaredHashes[specificAvatarId]
            : null;
        let actualSha256 = null;
        try {
          const resolved = resolveAssetUrl(assetsRoot, assetUrl);
          actualSha256 = sha256(readFileSync(resolved.resolved));
        } catch {
          blockers.push("missing_avatar_specific_asset");
        }
        if (!declaredSha256) {
          blockers.push("missing_avatar_content_hash");
        } else if (!SHA256_PATTERN.test(declaredSha256)) {
          blockers.push("invalid_avatar_content_hash");
        } else if (actualSha256 && declaredSha256 !== actualSha256) {
          blockers.push("avatar_content_hash_mismatch");
        }
        avatarSpecificContent.push({
          avatarId: specificAvatarId,
          assetUrl,
          declaredSha256,
          actualSha256,
          matches: Boolean(
            declaredSha256 && actualSha256 && declaredSha256 === actualSha256,
          ),
        });
      }
    }

    return {
      itemId: item.id,
      name: item.name ?? item.id,
      sourceManifest: item.sourceManifest,
      slot: item.competitiveSlot,
      combatStyle: item.combatStyle,
      equippedModelPath: item.equippedModelPath ?? null,
      assetRelativePath,
      assetSha256,
      declaredContentSha256,
      sharedByItemIds,
      fit,
      attachment,
      avatarSpecificContent,
      certifiableWithoutRefit,
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
    };
  });

  const launchMinimumSpecs =
    launchMinimumCertifications ??
    LAUNCH_MINIMUM_IDS.map((itemId) => ({ itemId }));
  const launchMinimum = launchMinimumSpecs.map((certification) => {
    const { itemId } = certification;
    const item = items.find((candidate) => candidate.itemId === itemId);
    if (!item) {
      return { itemId, ready: false, blockers: ["missing_manifest_item"] };
    }
    const blockers = [...item.blockers];
    if (
      typeof certification.slot === "string" &&
      certification.slot !== item.slot
    ) {
      blockers.push("certification_slot_mismatch");
    }
    if (typeof certification.path === "string") {
      const itemPath = item.assetRelativePath
        ? `packages/server/world/assets/${item.assetRelativePath}`
        : null;
      if (certification.path !== itemPath) {
        blockers.push("certification_path_mismatch");
      }
    }
    if (
      typeof certification.sha256 === "string" &&
      certification.sha256 !== item.assetSha256
    ) {
      blockers.push("certification_hash_mismatch");
    }
    return {
      itemId,
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
    };
  });
  const jewelry = armor.filter(
    (item) =>
      isRecord(item) &&
      (item.equipSlot === "amulet" || item.equipSlot === "ring"),
  );
  const readyCount = items.filter((item) => item.ready).length;
  const launchMinimumReadyCount = launchMinimum.filter(
    (item) => item.ready,
  ).length;

  return {
    schemaVersion: 1,
    avatarId,
    legacyAvatarId,
    inputs: {
      "manifests/items/weapons.json": sha256(weaponBytes),
      "manifests/items/armor.json": sha256(armorBytes),
    },
    summary: {
      weaponCount: sourceItems.filter(
        (item) => item.sourceManifest === "items/weapons.json",
      ).length,
      visibleArmorCount: sourceItems.filter(
        (item) => item.sourceManifest === "items/armor.json",
      ).length,
      nonvisualJewelryCount: jewelry.length,
      visibleItemCount: items.length,
      readyCount,
      blockedCount: items.length - readyCount,
      certifiableWithoutRefitCount: items.filter(
        (item) => item.certifiableWithoutRefit,
      ).length,
      launchMinimumCount: launchMinimum.length,
      launchMinimumReadyCount,
      launchMinimumBlockedCount: launchMinimum.length - launchMinimumReadyCount,
      blockerCounts: summarizeBlockers(items),
    },
    launchMinimum,
    excludedNonvisualJewelry: jewelry.map((item) => item.id),
    items,
    ready:
      readyCount === items.length &&
      launchMinimumReadyCount === launchMinimum.length,
  };
}

function parseArguments(argv) {
  const options = {
    requireLaunchMinimum: false,
    requireAllVisible: false,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-launch-minimum") {
      options.requireLaunchMinimum = true;
      continue;
    }
    if (argument === "--require-all-visible") {
      options.requireAllVisible = true;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a value");
      options.output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function resolveWorkspaceOutput(workspaceRoot, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Output path must be workspace-relative");
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Output path must remain inside the workspace");
  }
  return resolved;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const certificationManifestRelativePath =
    "scripts/duel-rigid-equipment-certifications.json";
  const certificationManifestBytes = readFileSync(
    path.join(workspaceRoot, certificationManifestRelativePath),
  );
  const certificationManifest = JSON.parse(
    certificationManifestBytes.toString("utf8"),
  );
  const launchMinimumCertifications = launchMinimumCertificationsFromManifest(
    certificationManifest,
  );
  const report = auditDuelEquipmentFit({
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    launchMinimumCertifications,
  });
  report.inputs[certificationManifestRelativePath] = sha256(
    certificationManifestBytes,
  );
  report.launchMinimumAuthority = {
    path: certificationManifestRelativePath,
    sha256: report.inputs[certificationManifestRelativePath],
    schemaVersion: certificationManifest.schemaVersion,
    avatarId: certificationManifest.avatarId,
    legacyAvatarId: certificationManifest.legacyAvatarId,
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    writeAtomic(resolveWorkspaceOutput(workspaceRoot, options.output), encoded);
  }
  process.stdout.write(
    `${JSON.stringify({ ...report.summary, ready: report.ready })}\n`,
  );
  if (
    options.requireLaunchMinimum &&
    report.summary.launchMinimumBlockedCount > 0
  ) {
    throw new Error("Launch-minimum duel equipment is not ready");
  }
  if (options.requireAllVisible && report.summary.blockedCount > 0) {
    throw new Error("Visible duel equipment inventory is not ready");
  }
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
