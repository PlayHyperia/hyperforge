#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";
import { readAvatarRegistry } from "./audit-avatar-lods.mjs";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ASSET_ROOT_PREFIX = "packages/server/world/assets/";
const ASSET_PATH_PREFIX = "packages/server/world/assets/models/";
const DEFAULT_ITEM_MANIFEST_PATH =
  "packages/server/world/assets/manifests/items/weapons.json";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function assertExactObject(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the frozen certification`);
  }
}

export function validateDuelEquipmentPresentationAuthority(
  certification,
  label,
) {
  const authority = certification.presentationAuthority;
  if (
    !isRecord(authority) ||
    authority.schemaVersion !== 1 ||
    typeof authority.actionSemantic !== "string" ||
    !SAFE_ID_PATTERN.test(authority.actionSemantic) ||
    (authority.actionAxisSymmetry !== "directed" &&
      authority.actionAxisSymmetry !== "bidirectional") ||
    !isRecord(authority.gripContact)
  ) {
    throw new Error(`${label} requires exact semantic grip authority`);
  }
  const contact = authority.gripContact;
  if (
    !Array.isArray(contact.zones) ||
    (certification.grip === "one-hand" && contact.zones.length !== 1) ||
    (certification.grip === "two-hand" &&
      contact.actionEnd !== "dynamic-aim" &&
      contact.zones.length !== 2) ||
    (contact.actionEnd === "dynamic-aim" &&
      (authority.actionAxisSymmetry !== "directed" ||
        contact.zones.length !== 1))
  ) {
    throw new Error(
      `${label} semantic grip authority contradicts its grip or action mode`,
    );
  }
  return authority;
}

function resolveCertifiedAsset(workspaceRoot, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.startsWith(ASSET_PATH_PREFIX) ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(
      `Certified asset path must remain under ${ASSET_PATH_PREFIX}`,
    );
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  const assetRoot = path.resolve(workspaceRoot, ASSET_PATH_PREFIX);
  if (!resolved.startsWith(`${assetRoot}${path.sep}`)) {
    throw new Error("Certified asset path escapes the duel asset root");
  }
  return resolved;
}

export function verifyDuelRigidEquipmentCertifications({
  workspaceRoot,
  manifest,
}) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 2) {
    throw new Error("Certification manifest must use schemaVersion 2");
  }
  if (
    typeof manifest.avatarId !== "string" ||
    !SAFE_ID_PATTERN.test(manifest.avatarId)
  ) {
    throw new Error("Certification manifest has an invalid avatarId");
  }
  if (
    typeof manifest.legacyAvatarId !== "string" ||
    manifest.legacyAvatarId.length === 0
  ) {
    throw new Error("Certification manifest requires a legacyAvatarId");
  }
  if (
    !Array.isArray(manifest.certifications) ||
    manifest.certifications.length === 0
  ) {
    throw new Error("Certification manifest must contain equipment");
  }
  const binding = resolveDuelEquipmentCertificationBinding({
    workspaceRoot,
    certificationManifest: manifest,
  });

  const itemIds = new Set();
  const assetPaths = new Set();
  const reports = [];
  for (const [index, certification] of manifest.certifications.entries()) {
    const label = `certifications[${index}]`;
    if (!isRecord(certification)) {
      throw new Error(`${label} must be an object`);
    }
    if (
      typeof certification.itemId !== "string" ||
      !SAFE_ID_PATTERN.test(certification.itemId)
    ) {
      throw new Error(`${label}.itemId is invalid`);
    }
    if (itemIds.has(certification.itemId)) {
      throw new Error(`Duplicate certified itemId: ${certification.itemId}`);
    }
    itemIds.add(certification.itemId);
    if (certification.slot !== "weapon" && certification.slot !== "shield") {
      throw new Error(`${label}.slot must be weapon or shield`);
    }
    if (
      certification.grip !== "one-hand" &&
      certification.grip !== "two-hand"
    ) {
      throw new Error(`${label}.grip must be one-hand or two-hand`);
    }
    if (certification.slot === "shield" && certification.grip !== "one-hand") {
      throw new Error(`${label} cannot define a two-hand shield`);
    }
    const presentationAuthority = validateDuelEquipmentPresentationAuthority(
      certification,
      label,
    );
    const assetPath = resolveCertifiedAsset(workspaceRoot, certification.path);
    if (assetPaths.has(assetPath)) {
      throw new Error(`Duplicate certified asset path: ${certification.path}`);
    }
    assetPaths.add(assetPath);
    assertSha256(certification.sha256, `${label}.sha256`);
    assertSha256(
      certification.structuralDocumentSha256,
      `${label}.structuralDocumentSha256`,
    );
    if (
      !Array.isArray(certification.nonJsonChunksSha256) ||
      certification.nonJsonChunksSha256.length === 0
    ) {
      throw new Error(`${label} must freeze at least one non-JSON chunk`);
    }
    for (const [
      chunkIndex,
      chunk,
    ] of certification.nonJsonChunksSha256.entries()) {
      if (!isRecord(chunk) || !Number.isInteger(chunk.type)) {
        throw new Error(
          `${label}.nonJsonChunksSha256[${chunkIndex}] is invalid`,
        );
      }
      assertSha256(
        chunk.sha256,
        `${label}.nonJsonChunksSha256[${chunkIndex}].sha256`,
      );
    }

    const bytes = readFileSync(assetPath);
    if (sha256(bytes) !== certification.sha256) {
      throw new Error(`${certification.itemId} asset SHA-256 drifted`);
    }
    const { report } = certifyRigidDuelEquipmentGlb(bytes, {
      itemId: certification.itemId,
      avatarId: manifest.avatarId,
      legacyAvatarId: manifest.legacyAvatarId,
      slot: certification.slot,
      gripContact: presentationAuthority.gripContact,
    });
    if (report.changed) {
      throw new Error(`${certification.itemId} certification is stale`);
    }
    if (report.inputSha256 !== certification.sha256) {
      throw new Error(`${certification.itemId} certification digest disagrees`);
    }
    if (
      report.structuralDocumentSha256 !== certification.structuralDocumentSha256
    ) {
      throw new Error(`${certification.itemId} structural GLB data drifted`);
    }
    assertExactObject(
      report.nonJsonChunksSha256,
      certification.nonJsonChunksSha256,
      `${certification.itemId} non-JSON GLB chunks`,
    );
    assertExactObject(
      report.gripContact,
      presentationAuthority.gripContact,
      `${certification.itemId} semantic grip authority`,
    );
    reports.push({
      itemId: certification.itemId,
      path: certification.path,
      slot: certification.slot,
      grip: certification.grip,
      vrmBoneName: report.vrmBoneName,
      sha256: certification.sha256,
      structuralDocumentSha256: certification.structuralDocumentSha256,
      nonJsonChunkCount: report.nonJsonChunksSha256.length,
      actionSemantic: presentationAuthority.actionSemantic,
      actionAxisSymmetry: presentationAuthority.actionAxisSymmetry,
      gripContact: presentationAuthority.gripContact,
    });
  }

  return {
    ok: true,
    schemaVersion: manifest.schemaVersion,
    avatarId: manifest.avatarId,
    legacyAvatarId: manifest.legacyAvatarId,
    ...(binding.mode === "avatar-override" ? { binding } : {}),
    certificationCount: reports.length,
    reports,
  };
}

function assertNoCandidateAssetReferences(value, label) {
  if (typeof value === "string") {
    if (
      value.startsWith("asset://") &&
      value.slice("asset://".length).split("/").includes("candidates")
    ) {
      throw new Error(`${label} activates a candidate-only asset: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoCandidateAssetReferences(entry, `${label}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    assertNoCandidateAssetReferences(entry, `${label}.${key}`);
  }
}

function certificationAssetUrl(certificationPath) {
  if (!certificationPath.startsWith(ASSET_ROOT_PREFIX)) {
    throw new Error("Certified equipment path is outside the asset root");
  }
  return `asset://${certificationPath.slice(ASSET_ROOT_PREFIX.length)}`;
}

function readLiteralAvatarRegistry(sourcePath) {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "AVATAR_OPTIONS",
    );
  const array = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    !array ||
    !ts.isArrayLiteralExpression(array)
  ) {
    throw new Error(
      "Avatar certification requires one literal registry declaration",
    );
  }
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error("Avatar certification requires literal registry entries");
    }
    const names = new Set();
    for (const property of element.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) &&
          !ts.isStringLiteral(property.name)) ||
        names.has(property.name.text)
      ) {
        throw new Error(
          "Avatar certification rejects dynamic or duplicate registry properties",
        );
      }
      names.add(property.name.text);
      if (
        ["id", "url", "lod1Url", "lod2Url"].includes(property.name.text) &&
        !ts.isStringLiteral(property.initializer) &&
        !ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ) {
        throw new Error(
          "Avatar certification requires literal identity and URL properties",
        );
      }
    }
  }
  return readAvatarRegistry(sourcePath);
}

/** Avatar-specific certification is opt-in; legacy manifests retain default binding. */
export function resolveDuelEquipmentCertificationBinding({
  workspaceRoot,
  certificationManifest,
}) {
  if (!isRecord(certificationManifest)) {
    throw new Error("Certification manifest must be an object");
  }
  const binding = certificationManifest.binding;
  if (binding === undefined) return { mode: "default" };
  if (
    !isRecord(binding) ||
    binding.mode !== "avatar-override" ||
    !isRecord(binding.avatar) ||
    typeof binding.avatar.url !== "string"
  ) {
    throw new Error(
      "Certification binding must declare an exact avatar-override",
    );
  }
  assertSha256(binding.avatar.sha256, "Certification binding avatar.sha256");
  const registry = readLiteralAvatarRegistry(
    path.join(workspaceRoot, "packages/shared/src/data/avatars.ts"),
  );
  const ids = new Set();
  const urls = new Set();
  for (const avatar of registry) {
    if (ids.has(avatar.id) || urls.has(avatar.url)) {
      throw new Error("Avatar registry contains duplicate identity mappings");
    }
    ids.add(avatar.id);
    urls.add(avatar.url);
  }
  if (
    typeof certificationManifest.avatarId !== "string" ||
    !SAFE_ID_PATTERN.test(certificationManifest.avatarId)
  ) {
    throw new Error("Certification binding has an invalid avatarId");
  }
  const avatar = registry.find(
    (entry) => entry.id === certificationManifest.avatarId,
  );
  if (!avatar || avatar.url !== binding.avatar.url) {
    throw new Error(
      "Certification binding does not match the registered avatar",
    );
  }
  const asset = binding.avatar.url.slice("asset://".length);
  if (
    !binding.avatar.url.startsWith("asset://avatars/") ||
    asset.includes("\\") ||
    path.posix.normalize(asset) !== asset ||
    !asset.endsWith(".vrm")
  ) {
    throw new Error("Certification binding avatar must name a local VRM asset");
  }
  if (
    sha256(readFileSync(path.join(workspaceRoot, ASSET_ROOT_PREFIX, asset))) !==
    binding.avatar.sha256
  ) {
    throw new Error("Certification binding avatar SHA-256 drifted");
  }
  return {
    mode: "avatar-override",
    avatarId: avatar.id,
    assetUrl: avatar.url,
    asset,
    sha256: binding.avatar.sha256,
  };
}

export function verifyDuelEquipmentItemBindings({
  certificationManifest,
  itemManifest,
  binding,
}) {
  if (!Array.isArray(itemManifest)) {
    throw new Error("Weapon item manifest must be an array");
  }
  assertNoCandidateAssetReferences(itemManifest, "weapon item manifest");
  const itemsById = new Map();
  for (const [index, item] of itemManifest.entries()) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (itemsById.has(item.id)) {
      throw new Error(`Duplicate weapon itemId: ${item.id}`);
    }
    itemsById.set(item.id, { item, index });
  }
  const bindings = [];
  for (const certification of certificationManifest.certifications) {
    const manifestEntry = itemsById.get(certification.itemId);
    if (!manifestEntry) {
      throw new Error(
        `${certification.itemId} is certified but missing from the weapon item manifest`,
      );
    }
    const { item, index } = manifestEntry;
    const expectedAssetUrl = certificationAssetUrl(certification.path);
    const avatarId = certificationManifest.avatarId;
    const avatarOverride = item.equippedModelPathsByAvatar?.[avatarId];
    if (binding.mode === "avatar-override") {
      if (
        !isRecord(item.equippedModelPathsByAvatar) ||
        !Object.hasOwn(item.equippedModelPathsByAvatar, avatarId) ||
        avatarOverride !== expectedAssetUrl ||
        !isRecord(item.equippedModelSha256ByAvatar) ||
        !Object.hasOwn(item.equippedModelSha256ByAvatar, avatarId) ||
        item.equippedModelSha256ByAvatar[avatarId] !== certification.sha256
      ) {
        throw new Error(
          `${certification.itemId} exact avatar override binding drifted`,
        );
      }
      for (const { item: otherItem } of itemsById.values()) {
        if (otherItem.equippedModelPath === expectedAssetUrl) {
          throw new Error(
            `${certification.itemId} avatar-only asset leaks into a default binding`,
          );
        }
        for (const [otherAvatarId, otherUrl] of Object.entries(
          otherItem.equippedModelPathsByAvatar ?? {},
        )) {
          if (
            otherUrl === expectedAssetUrl &&
            (otherItem.id !== item.id || otherAvatarId !== avatarId)
          ) {
            throw new Error(
              `${certification.itemId} avatar-only asset has duplicate override mappings`,
            );
          }
        }
      }
    } else {
      if (item.equippedModelPath !== expectedAssetUrl) {
        throw new Error(
          `${certification.itemId} active equippedModelPath does not match its frozen certification`,
        );
      }
      if (avatarOverride !== undefined && avatarOverride !== expectedAssetUrl) {
        throw new Error(
          `${certification.itemId} ${avatarId} override bypasses its frozen certification`,
        );
      }
    }
    bindings.push({
      itemId: certification.itemId,
      manifestIndex: index,
      assetUrl: expectedAssetUrl,
      sha256: certification.sha256,
      avatarOverride: avatarOverride ?? null,
    });
  }
  return bindings;
}

export function verifyActiveDuelEquipmentBindings({
  workspaceRoot,
  certificationManifest,
  itemManifest,
}) {
  const certificationReport = verifyDuelRigidEquipmentCertifications({
    workspaceRoot,
    manifest: certificationManifest,
  });
  const binding = certificationReport.binding ?? { mode: "default" };
  const bindings = verifyDuelEquipmentItemBindings({
    certificationManifest,
    itemManifest,
    binding,
  });

  return {
    ...certificationReport,
    ...(binding.mode === "avatar-override" ? { binding } : {}),
    activeBindingCount: bindings.length,
    bindings,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--manifest" && argument !== "--item-manifest") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--manifest") options.manifest = value;
    else options.itemManifest = value;
    index += 1;
  }
  return options;
}

function resolveWorkspaceFile(workspaceRoot, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Manifest path must be workspace-relative");
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Manifest path must remain inside the workspace");
  }
  return resolved;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifestPath = resolveWorkspaceFile(
    workspaceRoot,
    options.manifest ?? "scripts/duel-rigid-equipment-certifications.json",
  );
  const itemManifestPath = resolveWorkspaceFile(
    workspaceRoot,
    options.itemManifest ?? DEFAULT_ITEM_MANIFEST_PATH,
  );
  const certificationManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const itemManifest = JSON.parse(readFileSync(itemManifestPath, "utf8"));
  const report = verifyActiveDuelEquipmentBindings({
    workspaceRoot,
    certificationManifest,
    itemManifest,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
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
