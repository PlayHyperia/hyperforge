#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { certifyRigidDuelEquipmentGlb } from "./certify-rigid-duel-equipment.mjs";
import {
  resolveDuelEquipmentCertificationBinding,
  validateDuelEquipmentPresentationAuthority,
  verifyDuelEquipmentItemBindings,
} from "./verify-duel-rigid-equipment-certifications.mjs";

const DEFAULT_CERTIFICATION_MANIFEST =
  "scripts/duel-rigid-equipment-certifications.json";
const DEFAULT_ITEM_MANIFEST =
  "packages/server/world/assets/manifests/items/weapons.json";
const DEFAULT_EVIDENCE =
  "artifacts/duel-launch-avatar-bakeoff/semantic-grip-certification/activation-evidence.json";
const CANDIDATE_ASSET_ROOT = "models/candidates/semantic-grip-certification";
const AVATAR_ASSET = "avatars/duel-candidates/duel-steve.vrm";
const EXPECTED_ITEM_IDS = [
  "bronze_shortsword",
  "bronze_longsword",
  "bronze_scimitar",
  "shortbow",
  "magic_shortbow",
  "staff_of_air",
];
const REVIEW_PLAN = Object.freeze({
  bronze_shortsword: Object.freeze([
    ["close", "bronze-shortsword-close", 8],
    ["locomotion", "bronze-shortsword-locomotion", 12],
  ]),
  bronze_longsword: Object.freeze([
    ["close", "bronze-longsword-close", 8],
    ["locomotion", "bronze-longsword-locomotion", 12],
  ]),
  bronze_scimitar: Object.freeze([
    ["close", "bronze-scimitar-close", 8],
    ["locomotion", "bronze-scimitar-locomotion", 12],
  ]),
  shortbow: Object.freeze([
    ["close", "shortbow-close", 8],
    ["motion", "shortbow-motion", 14],
  ]),
  magic_shortbow: Object.freeze([
    ["close", "magic-shortbow-close", 8],
    ["motion", "magic-shortbow-motion", 14],
  ]),
  staff_of_air: Object.freeze([
    ["close", "staff-of-air-close", 8],
    ["motion", "staff-of-air-motion", 14],
  ]),
});
const EVIDENCE_ROOT =
  "artifacts/duel-launch-avatar-bakeoff/semantic-grip-certification";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeVector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain three finite numbers`);
  }
  const length = Math.hypot(...value);
  if (length <= 0.000001) throw new Error(`${label} must be non-zero`);
  return value.map((entry) => entry / length);
}

function rotateVectorByQuaternion(vector, quaternion, label) {
  const [vx, vy, vz] = normalizeVector(vector, `${label} source axis`);
  if (
    !Array.isArray(quaternion) ||
    quaternion.length !== 4 ||
    quaternion.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain a finite orientation quaternion`);
  }
  const length = Math.hypot(...quaternion);
  if (Math.abs(length - 1) > 0.00001) {
    throw new Error(`${label} orientation quaternion is not normalized`);
  }
  const [qx, qy, qz, qw] = quaternion.map((entry) => entry / length);
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return normalizeVector(
    [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ],
    `${label} rotated action axis`,
  );
}

function angularDeviationDegrees(left, right) {
  const a = normalizeVector(left, "expected action direction");
  const b = normalizeVector(right, "observed action direction");
  const dot = Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, entry, index) => sum + entry * b[index], 0),
    ),
  );
  return (Math.acos(dot) * 180) / Math.PI;
}

function resolveWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let ownedTemporary = false;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    ownedTemporary = true;
    renameSync(temporary, filePath);
  } finally {
    if (ownedTemporary) rmSync(temporary, { force: true });
  }
}

function installImmutable(filePath, contents) {
  if (existsSync(filePath)) {
    if (!readFileSync(filePath).equals(contents)) {
      throw new Error(
        "Avatar override immutable destination drifted before activation",
      );
    }
    return;
  }
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let ownedTemporary = false;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    ownedTemporary = true;
    // A link creates a complete destination atomically and never replaces a
    // concurrently created file; abandoned staging files are not active URLs.
    linkSync(temporary, filePath);
  } finally {
    if (ownedTemporary) rmSync(temporary, { force: true });
  }
}

function validateLockedInputFiles(workspaceRoot, report) {
  const assetsRoot = path.resolve(
    workspaceRoot,
    "packages/server/world/assets",
  );
  if (!isRecord(report.inputs) || Object.keys(report.inputs).length < 3) {
    throw new Error("WebGPU review does not lock every input");
  }
  for (const [asset, expectedSha256] of Object.entries(report.inputs)) {
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new Error(`WebGPU review input ${asset} has an invalid SHA-256`);
    }
    const resolved = path.resolve(assetsRoot, asset);
    if (!resolved.startsWith(`${assetsRoot}${path.sep}`)) {
      throw new Error(`WebGPU review input ${asset} escapes the asset root`);
    }
    if (sha256(readFileSync(resolved)) !== expectedSha256) {
      throw new Error(`WebGPU review input ${asset} drifted`);
    }
  }
}

export function validateSemanticGripMotionReview({
  workspaceRoot,
  report,
  reviewKind,
  reportPath,
  reportBytes,
  contactSheetPath,
  contactSheetBytes,
  itemId,
  candidateAsset,
  candidateSha256,
  gripContact,
  expectedMotionCount,
  avatarAsset = AVATAR_ASSET,
}) {
  const expectedAvatarSha256 = sha256(
    readFileSync(
      resolveWorkspacePath(
        workspaceRoot,
        `packages/server/world/assets/${avatarAsset}`,
        "Canonical avatar",
      ),
    ),
  );
  if (
    !isRecord(report) ||
    report.rendererBackend !== "webgpu" ||
    report.rendererAdapter?.vendor !== "apple" ||
    report.rendererAdapter?.architecture !== "metal-3" ||
    report.avatarAsset !== avatarAsset ||
    report.avatarSha256 !== expectedAvatarSha256 ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0 ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length !== 0 ||
    !Array.isArray(report.motions) ||
    report.motions.length !== expectedMotionCount ||
    report.inputs?.[candidateAsset] !== candidateSha256 ||
    report.contactSheet?.path !== contactSheetPath ||
    report.contactSheet?.sha256 !== sha256(contactSheetBytes) ||
    report.contactSheet?.byteLength !== contactSheetBytes.length ||
    contactSheetBytes.length < 100_000
  ) {
    throw new Error(
      `${itemId} ${reportPath} is not clean locked WebGPU evidence`,
    );
  }
  validateLockedInputFiles(workspaceRoot, report);
  const motionManifest = report.manifests?.motions;
  let exactMotionManifest;
  if (
    !isRecord(motionManifest) ||
    !SHA256_PATTERN.test(motionManifest.sha256) ||
    !["close", "locomotion", "motion"].includes(reviewKind)
  ) {
    throw new Error(`${itemId} motion manifest evidence drifted`);
  }
  const motionManifestBytes = readFileSync(
    resolveWorkspacePath(
      workspaceRoot,
      motionManifest.path,
      `${itemId} motion manifest`,
    ),
  );
  if (sha256(motionManifestBytes) !== motionManifest.sha256) {
    throw new Error(`${itemId} motion manifest evidence drifted`);
  }
  try {
    exactMotionManifest = JSON.parse(motionManifestBytes.toString("utf8"));
  } catch {
    throw new Error(`${itemId} motion manifest is not valid JSON`);
  }
  if (
    !Array.isArray(exactMotionManifest.motions) ||
    exactMotionManifest.motions.length !== expectedMotionCount
  ) {
    throw new Error(`${itemId} motion manifest coverage drifted`);
  }

  let gripContactCount = 0;
  let maximumActionDirectionDeviationDegrees = 0;
  let maximumStablePoseDeviationDegrees = 0;
  let maximumStablePosePositionDeviationMetres = 0;
  let bowDrawAlignmentCount = 0;
  let maximumNockedArrowNockDistanceMetres = 0;
  let maximumNockedArrowAimDeviationDegrees = 0;
  const reviewYaws = new Set();
  for (const [motionIndex, motion] of report.motions.entries()) {
    const expectedMotion = exactMotionManifest.motions[motionIndex];
    const equipment = motion?.equipment;
    const sampleRatio = motion?.sampleSeconds / motion?.durationSeconds;
    if (
      !isRecord(motion) ||
      !isRecord(expectedMotion) ||
      motion.id !== expectedMotion.id ||
      motion.name !== expectedMotion.name ||
      motion.asset !== expectedMotion.asset ||
      !Number.isFinite(sampleRatio) ||
      Math.abs(sampleRatio - expectedMotion.sampleRatio) > 0.000001 ||
      (motion.cameraYawDegrees ?? null) !==
        (expectedMotion.cameraYawDegrees ?? null) ||
      (motion.cameraPitchDegrees ?? null) !==
        (expectedMotion.cameraPitchDegrees ?? null) ||
      (motion.cameraTarget ?? null) !== (expectedMotion.cameraTarget ?? null) ||
      !Array.isArray(motion.failures) ||
      motion.failures.length !== 0 ||
      !isRecord(equipment) ||
      equipment.itemId !== itemId ||
      equipment.asset !== candidateAsset ||
      equipment.metadataValid !== true ||
      equipment.attached !== true ||
      equipment.visible !== true ||
      !Array.isArray(equipment.gripZoneContacts) ||
      equipment.gripZoneContacts.length !== gripContact.zones.length
    ) {
      throw new Error(
        `${itemId} ${motion?.id ?? "unknown"} is not a clean equipment sample`,
      );
    }
    reviewYaws.add(motion.cameraYawDegrees);
    if (
      reviewKind === "close" &&
      (motion.cameraTarget !== "primary-grip" ||
        motion.cameraPitchDegrees !== 4)
    ) {
      throw new Error(
        `${itemId} ${motion.id} lost close-grip camera authority`,
      );
    }
    for (const [zoneIndex, zone] of gripContact.zones.entries()) {
      const contact = equipment.gripZoneContacts[zoneIndex];
      if (
        contact?.id !== zone.id ||
        contact?.boneName !== zone.boneName ||
        contact?.minimumSourceProjection !== zone.minimumSourceProjection ||
        contact?.maximumSourceProjection !== zone.maximumSourceProjection ||
        !Number.isInteger(contact?.equipmentTriangleCount) ||
        contact.equipmentTriangleCount < 4 ||
        contact?.intersects !== true ||
        contact?.minimumSurfaceDistance !== 0
      ) {
        throw new Error(
          `${itemId} ${motion.id} misses the authored ${zone.id} handle zone`,
        );
      }
      gripContactCount += 1;
    }
    if (gripContact.actionEnd === "dynamic-aim") {
      if (
        equipment.actionDirectionWorld !== null ||
        equipment.dynamicBowStringActive !== true ||
        equipment.stableHeldPoseActive !== true ||
        !Number.isFinite(equipment.stablePoseDeviationDegrees) ||
        equipment.stablePoseDeviationDegrees > 0.001 ||
        !Number.isFinite(equipment.stablePosePositionDeviationMetres) ||
        equipment.stablePosePositionDeviationMetres > 0.000001
      ) {
        throw new Error(`${itemId} ${motion.id} lost dynamic-aim authority`);
      }
      maximumStablePoseDeviationDegrees = Math.max(
        maximumStablePoseDeviationDegrees,
        equipment.stablePoseDeviationDegrees,
      );
      maximumStablePosePositionDeviationMetres = Math.max(
        maximumStablePosePositionDeviationMetres,
        equipment.stablePosePositionDeviationMetres,
      );
      const isDrawSample = motion.asset === "emotes/emote-range.glb";
      if (isDrawSample) {
        if (
          equipment.nockedArrowVisible !== true ||
          !Number.isFinite(equipment.nockedArrowNockDistance) ||
          equipment.nockedArrowNockDistance > 0.000001 ||
          !Number.isFinite(equipment.nockedArrowAimDeviationDegrees) ||
          equipment.nockedArrowAimDeviationDegrees > 0.001 ||
          equipment.nockedArrowDrawHandMeshContact?.intersects !== true ||
          equipment.nockedArrowDrawHandMeshContact?.minimumSurfaceDistance !== 0
        ) {
          throw new Error(`${itemId} ${motion.id} lost nock or aim alignment`);
        }
        bowDrawAlignmentCount += 1;
        maximumNockedArrowNockDistanceMetres = Math.max(
          maximumNockedArrowNockDistanceMetres,
          equipment.nockedArrowNockDistance,
        );
        maximumNockedArrowAimDeviationDegrees = Math.max(
          maximumNockedArrowAimDeviationDegrees,
          equipment.nockedArrowAimDeviationDegrees,
        );
      } else if (
        equipment.nockedArrowVisible !== false ||
        equipment.nockedArrowNockDistance !== null ||
        equipment.nockedArrowAimDeviationDegrees !== null ||
        equipment.nockedArrowDrawHandMeshContact !== null
      ) {
        throw new Error(`${itemId} ${motion.id} has a ghost nocked arrow`);
      }
    } else {
      const direction = equipment.actionDirectionWorld;
      if (
        !Array.isArray(direction) ||
        direction.length !== 3 ||
        direction.some((value) => !Number.isFinite(value)) ||
        Math.abs(Math.hypot(...direction) - 1) > 0.00001 ||
        (itemId === "staff_of_air" && equipment.stableHeldPoseActive !== true)
      ) {
        throw new Error(
          `${itemId} ${motion.id} lost directed action-end authority`,
        );
      }
      const rotatedSourceAxis = rotateVectorByQuaternion(
        gripContact.sourceAxis,
        equipment.orientation?.wrapperWorldQuaternion,
        `${itemId} ${motion.id}`,
      );
      const expectedDirection =
        gripContact.actionEnd === "minimum"
          ? rotatedSourceAxis.map((entry) => -entry)
          : rotatedSourceAxis;
      const deviation = angularDeviationDegrees(expectedDirection, direction);
      if (deviation > 0.001) {
        throw new Error(
          `${itemId} ${motion.id} directed action end is reversed or drifted`,
        );
      }
      maximumActionDirectionDeviationDegrees = Math.max(
        maximumActionDirectionDeviationDegrees,
        deviation,
      );
      if (itemId === "staff_of_air") {
        if (
          !Number.isFinite(equipment.stablePoseDeviationDegrees) ||
          equipment.stablePoseDeviationDegrees > 0.001
        ) {
          throw new Error(`${itemId} ${motion.id} lost stable focus-end pose`);
        }
        maximumStablePoseDeviationDegrees = Math.max(
          maximumStablePoseDeviationDegrees,
          equipment.stablePoseDeviationDegrees,
        );
      }
    }
  }
  if (
    reviewYaws.size !== 4 ||
    ![0, -90, 180, 90].every((yaw) => reviewYaws.has(yaw))
  ) {
    throw new Error(
      `${itemId} ${reviewKind} review is not four-angle evidence`,
    );
  }
  if (gripContact.actionEnd === "dynamic-aim" && bowDrawAlignmentCount !== 4) {
    throw new Error(`${itemId} review must contain four exact draw alignments`);
  }
  return {
    itemId,
    reportPath,
    reportSha256: sha256(reportBytes),
    contactSheetPath,
    contactSheetSha256: sha256(contactSheetBytes),
    rendererBackend: report.rendererBackend,
    rendererAdapter: report.rendererAdapter,
    motionCount: report.motions.length,
    gripContactCount,
    fourAngleReview: true,
    maximumActionDirectionDeviationDegrees: Number(
      maximumActionDirectionDeviationDegrees.toFixed(6),
    ),
    maximumStablePoseDeviationDegrees: Number(
      maximumStablePoseDeviationDegrees.toFixed(6),
    ),
    maximumStablePosePositionDeviationMetres: Number(
      maximumStablePosePositionDeviationMetres.toFixed(6),
    ),
    bowDrawAlignmentCount,
    maximumNockedArrowNockDistanceMetres: Number(
      maximumNockedArrowNockDistanceMetres.toFixed(6),
    ),
    maximumNockedArrowAimDeviationDegrees: Number(
      maximumNockedArrowAimDeviationDegrees.toFixed(6),
    ),
  };
}

function readReviewEvidence(
  workspaceRoot,
  certification,
  candidateAsset,
  candidateSha256,
  { avatarAsset = AVATAR_ASSET, evidenceRoot = EVIDENCE_ROOT } = {},
) {
  const reviews = [];
  for (const [kind, baseName, expectedMotionCount] of REVIEW_PLAN[
    certification.itemId
  ] ?? []) {
    const reportPath = `${evidenceRoot}/${baseName}-report.json`;
    const contactSheetPath = `${evidenceRoot}/${baseName}.png`;
    const reportBytes = readFileSync(
      resolveWorkspacePath(workspaceRoot, reportPath, `${baseName} report`),
    );
    const contactSheetBytes = readFileSync(
      resolveWorkspacePath(
        workspaceRoot,
        contactSheetPath,
        `${baseName} contact sheet`,
      ),
    );
    reviews.push({
      kind,
      ...validateSemanticGripMotionReview({
        workspaceRoot,
        report: JSON.parse(reportBytes.toString("utf8")),
        reviewKind: kind,
        reportPath,
        reportBytes,
        contactSheetPath,
        contactSheetBytes,
        itemId: certification.itemId,
        candidateAsset,
        candidateSha256,
        gripContact: certification.presentationAuthority.gripContact,
        expectedMotionCount,
        avatarAsset,
      }),
    });
  }
  if (reviews.length !== 2) {
    throw new Error(
      `${certification.itemId} requires close and motion reviews`,
    );
  }
  return reviews;
}

export function promoteDuelRigidEquipmentCertificationCandidates({
  workspaceRoot,
  certificationManifest,
  itemManifest,
  write,
  evidencePath = DEFAULT_EVIDENCE,
  certificationManifestPath = DEFAULT_CERTIFICATION_MANIFEST,
}) {
  const binding = resolveDuelEquipmentCertificationBinding({
    workspaceRoot,
    certificationManifest,
  });
  const isOverride = binding.mode === "avatar-override";
  if (
    !isRecord(certificationManifest) ||
    certificationManifest.schemaVersion !== 2 ||
    (!isOverride && certificationManifest.avatarId !== "steve") ||
    !Array.isArray(certificationManifest.certifications) ||
    certificationManifest.certifications.length === 0 ||
    (!isOverride &&
      JSON.stringify(
        certificationManifest.certifications.map((entry) => entry?.itemId),
      ) !== JSON.stringify(EXPECTED_ITEM_IDS)) ||
    !Array.isArray(itemManifest)
  ) {
    throw new Error("Semantic-grip promotion manifest is incomplete");
  }
  const assetsRoot = path.resolve(
    workspaceRoot,
    "packages/server/world/assets",
  );
  const nextCertificationManifest = structuredClone(certificationManifest);
  const nextItemManifest = structuredClone(itemManifest);
  const installations = [];
  const reviews = [];
  let candidateAssetRoot = CANDIDATE_ASSET_ROOT;
  let evidenceRoot = EVIDENCE_ROOT;
  const avatarAsset = isOverride ? binding.asset : AVATAR_ASSET;
  if (isOverride) {
    const promotion = certificationManifest.promotion;
    if (
      !isRecord(promotion) ||
      typeof promotion.candidateAssetRoot !== "string" ||
      !promotion.candidateAssetRoot.startsWith("models/candidates/") ||
      typeof promotion.evidenceRoot !== "string" ||
      !promotion.evidenceRoot.startsWith("artifacts/") ||
      certificationManifestPath === DEFAULT_CERTIFICATION_MANIFEST ||
      evidencePath === DEFAULT_EVIDENCE
    ) {
      throw new Error(
        "Avatar override promotion requires isolated candidate, review, certification, and evidence paths",
      );
    }
    resolveWorkspacePath(
      assetsRoot,
      promotion.candidateAssetRoot,
      "Candidate asset root",
    );
    resolveWorkspacePath(
      workspaceRoot,
      promotion.evidenceRoot,
      "Review evidence root",
    );
    candidateAssetRoot = promotion.candidateAssetRoot;
    evidenceRoot = promotion.evidenceRoot;
    const ids = new Set();
    const paths = new Set();
    for (const certification of certificationManifest.certifications) {
      if (
        !Object.hasOwn(REVIEW_PLAN, certification?.itemId) ||
        ids.has(certification.itemId) ||
        paths.has(certification.path) ||
        typeof certification.path !== "string" ||
        !certification.path.startsWith(
          "packages/server/world/assets/models/",
        ) ||
        !certification.path.endsWith(".glb") ||
        certification.path.split("/").includes("candidates")
      ) {
        throw new Error(
          "Avatar override promotion contains invalid or duplicate certified mappings",
        );
      }
      resolveWorkspacePath(
        workspaceRoot,
        certification.path,
        "Certified avatar override",
      );
      ids.add(certification.itemId);
      paths.add(certification.path);
      if (
        (certification.slot !== "weapon" && certification.slot !== "shield") ||
        (certification.grip !== "one-hand" &&
          certification.grip !== "two-hand") ||
        (certification.slot === "shield" && certification.grip !== "one-hand")
      ) {
        throw new Error(
          "Avatar override promotion has an invalid equipment slot or grip",
        );
      }
    }
    verifyDuelEquipmentItemBindings({
      certificationManifest,
      itemManifest,
      binding,
    });
    const certificationFile = resolveWorkspacePath(
      workspaceRoot,
      certificationManifestPath,
      "Certification manifest",
    );
    const evidenceFile = resolveWorkspacePath(
      workspaceRoot,
      evidencePath,
      "Activation evidence",
    );
    const itemFile = resolveWorkspacePath(
      workspaceRoot,
      DEFAULT_ITEM_MANIFEST,
      "Weapon item manifest",
    );
    if (
      certificationFile === itemFile ||
      evidenceFile === itemFile ||
      evidenceFile === certificationFile ||
      !certificationManifestPath.startsWith("scripts/") ||
      !certificationManifestPath.endsWith(".json") ||
      !evidencePath.startsWith("artifacts/") ||
      !evidencePath.endsWith(".json")
    ) {
      throw new Error(
        "Avatar override activation files must be distinct isolated JSON paths",
      );
    }
    for (const [file, expected] of [
      [certificationFile, certificationManifest],
      [itemFile, itemManifest],
    ]) {
      if (
        JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !==
        JSON.stringify(expected)
      ) {
        throw new Error(
          "Avatar override promotion input differs from its on-disk manifest",
        );
      }
    }
  }

  for (const [
    index,
    certification,
  ] of certificationManifest.certifications.entries()) {
    const label = `certifications[${index}]`;
    const authority = validateDuelEquipmentPresentationAuthority(
      certification,
      label,
    );
    const candidateAsset = `${candidateAssetRoot}/${certification.itemId}.glb`;
    const candidatePath = path.resolve(assetsRoot, candidateAsset);
    const candidateBytes = readFileSync(candidatePath);
    const candidateSha256 = sha256(candidateBytes);
    const certified = certifyRigidDuelEquipmentGlb(candidateBytes, {
      itemId: certification.itemId,
      avatarId: certificationManifest.avatarId,
      legacyAvatarId: certificationManifest.legacyAvatarId,
      slot: certification.slot,
      gripContact: authority.gripContact,
    });
    if (
      certified.report.changed ||
      certified.report.outputSha256 !== candidateSha256 ||
      certified.report.structuralDocumentSha256 !==
        certification.structuralDocumentSha256 ||
      JSON.stringify(certified.report.nonJsonChunksSha256) !==
        JSON.stringify(certification.nonJsonChunksSha256)
    ) {
      throw new Error(
        `${certification.itemId} candidate is not exact and immutable`,
      );
    }
    reviews.push(
      ...readReviewEvidence(
        workspaceRoot,
        certification,
        candidateAsset,
        candidateSha256,
        { avatarAsset, evidenceRoot },
      ),
    );

    const currentDestinationPath = resolveWorkspacePath(
      workspaceRoot,
      certification.path,
      `${certification.itemId} active asset`,
    );
    const currentDestinationSha256 = sha256(
      readFileSync(currentDestinationPath),
    );
    if (
      currentDestinationSha256 !== certification.sha256 &&
      currentDestinationSha256 !== candidateSha256
    ) {
      throw new Error(
        `${certification.itemId} active asset drifted before promotion`,
      );
    }
    const itemIndex = nextItemManifest.findIndex(
      (item) => item?.id === certification.itemId,
    );
    const item = nextItemManifest[itemIndex];
    const expectedAssetUrl = `asset://${certification.path.slice(
      "packages/server/world/assets/".length,
    )}`;
    if (
      itemIndex < 0 ||
      (!isOverride &&
        (item?.equippedModelPath !== expectedAssetUrl ||
          (item.equippedModelSha256 !== certification.sha256 &&
            item.equippedModelSha256 !== candidateSha256)))
    ) {
      throw new Error(`${certification.itemId} item manifest binding drifted`);
    }
    nextCertificationManifest.certifications[index].sha256 = candidateSha256;
    const destinationRelativePath = isOverride
      ? certification.path.replace(
          /(?:\.[a-f0-9]{64})?\.glb$/u,
          `.${candidateSha256}.glb`,
        )
      : certification.path;
    const destinationPath = resolveWorkspacePath(
      workspaceRoot,
      destinationRelativePath,
      "Promoted asset",
    );
    if (isOverride) {
      if (
        existsSync(destinationPath) &&
        sha256(readFileSync(destinationPath)) !== candidateSha256
      ) {
        throw new Error(
          `${certification.itemId} content-addressed destination already contains different bytes`,
        );
      }
      nextCertificationManifest.certifications[index].path =
        destinationRelativePath;
      item.equippedModelPathsByAvatar[certificationManifest.avatarId] =
        `asset://${destinationRelativePath.slice("packages/server/world/assets/".length)}`;
      item.equippedModelSha256ByAvatar[certificationManifest.avatarId] =
        candidateSha256;
    } else {
      nextItemManifest[itemIndex].equippedModelSha256 = candidateSha256;
    }
    installations.push({
      itemId: certification.itemId,
      candidateAsset,
      candidateSha256,
      destinationPath: destinationRelativePath,
      metadataOnly: true,
      bytes: candidateBytes,
      resolvedDestinationPath: destinationPath,
    });
  }

  if (isOverride) {
    verifyDuelEquipmentItemBindings({
      certificationManifest: nextCertificationManifest,
      itemManifest: nextItemManifest,
      binding,
    });
  }

  const nextCertificationBytes = Buffer.from(
    `${JSON.stringify(nextCertificationManifest, null, 2)}\n`,
  );
  const nextItemBytes = Buffer.from(
    `${JSON.stringify(nextItemManifest, null, 2)}\n`,
  );
  const evidence = {
    schemaVersion: 1,
    activationId: isOverride
      ? `${binding.avatarId}-semantic-grip-avatar-override-v1`
      : "steve-semantic-grip-launch-six-v1",
    status: "technical-certification-pass",
    productApprovalRequired: true,
    productApproved: false,
    ...(isOverride ? { binding } : {}),
    knownAvatarLimitation: isOverride
      ? "Avatar-specific technical certification is not product approval or proof of anatomical finger closure; full moving-combat and visual review remain required."
      : "The current Steve VRM has no articulated VRM finger bones; final product must approve the stylized open hand or select a finger-rigged canonical avatar.",
    excludedLaunchItems: isOverride
      ? []
      : [
          {
            itemId: "bronze_2h_sword",
            reason:
              "The active two-hand presentation failed direct visual review and is not launch eligible.",
          },
        ],
    avatar: {
      asset: avatarAsset,
      sha256: sha256(
        readFileSync(
          path.join(workspaceRoot, "packages/server/world/assets", avatarAsset),
        ),
      ),
    },
    certificationManifest: {
      path: certificationManifestPath,
      sha256: sha256(nextCertificationBytes),
    },
    itemManifest: {
      path: DEFAULT_ITEM_MANIFEST,
      sha256: sha256(nextItemBytes),
    },
    installations: installations.map(
      ({ bytes: _bytes, resolvedDestinationPath: _path, ...entry }) => entry,
    ),
    reviews,
    totals: {
      itemCount: installations.length,
      reviewCount: reviews.length,
      motionCount: reviews.reduce((sum, review) => sum + review.motionCount, 0),
      gripContactCount: reviews.reduce(
        (sum, review) => sum + review.gripContactCount,
        0,
      ),
      browserErrorCount: 0,
      auditFailureCount: 0,
    },
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);

  if (write && isOverride) {
    const itemFile = resolveWorkspacePath(
      workspaceRoot,
      DEFAULT_ITEM_MANIFEST,
      "Weapon item manifest",
    );
    const certificationFile = resolveWorkspacePath(
      workspaceRoot,
      certificationManifestPath,
      "Certification manifest",
    );
    const evidenceFile = resolveWorkspacePath(
      workspaceRoot,
      evidencePath,
      "Activation evidence",
    );
    const lockFile = `${itemFile}.avatar-promotion-lock`;
    const lock = openSync(lockFile, "wx");
    try {
      for (const [file, expected] of [
        [itemFile, itemManifest],
        [certificationFile, certificationManifest],
      ]) {
        if (
          JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !==
          JSON.stringify(expected)
        ) {
          throw new Error(
            "Avatar override activation manifest changed during preflight",
          );
        }
      }
      // Copy-on-write keeps every currently active URL intact. A failure here
      // may leave unreferenced immutable files, never a partly replaced model.
      for (const installation of installations) {
        installImmutable(
          installation.resolvedDestinationPath,
          installation.bytes,
        );
        if (
          sha256(readFileSync(installation.resolvedDestinationPath)) !==
          installation.candidateSha256
        ) {
          throw new Error(
            "Avatar override immutable destination drifted before activation",
          );
        }
      }
      resolveDuelEquipmentCertificationBinding({
        workspaceRoot,
        certificationManifest,
      });
      writeAtomic(
        evidenceFile,
        Buffer.from(
          `${JSON.stringify({ ...evidence, status: "prepared-not-activated" }, null, 2)}\n`,
        ),
      );
      if (
        JSON.stringify(JSON.parse(readFileSync(itemFile, "utf8"))) !==
        JSON.stringify(itemManifest)
      ) {
        throw new Error(
          "Avatar override activation manifest changed before activation",
        );
      }
      // This single rename switches all selected URL/digest pairs together;
      // defaults and all other avatar overrides are retained byte-for-byte as values.
      writeAtomic(itemFile, nextItemBytes);
      writeAtomic(certificationFile, nextCertificationBytes);
      writeAtomic(evidenceFile, evidenceBytes);
    } finally {
      closeSync(lock);
      rmSync(lockFile);
    }
  } else if (write) {
    for (const installation of installations) {
      if (
        sha256(readFileSync(installation.resolvedDestinationPath)) !==
        installation.candidateSha256
      ) {
        writeAtomic(installation.resolvedDestinationPath, installation.bytes);
      }
    }
    writeAtomic(
      resolveWorkspacePath(
        workspaceRoot,
        DEFAULT_ITEM_MANIFEST,
        "Weapon item manifest",
      ),
      nextItemBytes,
    );
    writeAtomic(
      resolveWorkspacePath(
        workspaceRoot,
        certificationManifestPath,
        "Certification manifest",
      ),
      nextCertificationBytes,
    );
    writeAtomic(
      resolveWorkspacePath(workspaceRoot, evidencePath, "Activation evidence"),
      evidenceBytes,
    );
  } else {
    if (
      installations.some(
        (installation) =>
          sha256(readFileSync(installation.resolvedDestinationPath)) !==
          installation.candidateSha256,
      ) ||
      sha256(
        readFileSync(
          resolveWorkspacePath(
            workspaceRoot,
            certificationManifestPath,
            "Certification manifest",
          ),
        ),
      ) !== sha256(nextCertificationBytes) ||
      sha256(
        readFileSync(
          resolveWorkspacePath(
            workspaceRoot,
            DEFAULT_ITEM_MANIFEST,
            "Weapon item manifest",
          ),
        ),
      ) !== sha256(nextItemBytes) ||
      !existsSync(
        resolveWorkspacePath(
          workspaceRoot,
          evidencePath,
          "Activation evidence",
        ),
      ) ||
      !readFileSync(
        resolveWorkspacePath(
          workspaceRoot,
          evidencePath,
          "Activation evidence",
        ),
      ).equals(evidenceBytes)
    ) {
      throw new Error("Semantic-grip activation or its evidence is stale");
    }
  }
  return evidence;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--check") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument === "--evidence" || argument === "--manifest") {
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

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const certificationManifest = JSON.parse(
    readFileSync(
      resolveWorkspacePath(
        workspaceRoot,
        options.manifest ?? DEFAULT_CERTIFICATION_MANIFEST,
        "Certification manifest",
      ),
      "utf8",
    ),
  );
  const itemManifest = JSON.parse(
    readFileSync(
      resolveWorkspacePath(
        workspaceRoot,
        DEFAULT_ITEM_MANIFEST,
        "Weapon item manifest",
      ),
      "utf8",
    ),
  );
  const report = promoteDuelRigidEquipmentCertificationCandidates({
    workspaceRoot,
    certificationManifest,
    itemManifest,
    write: Boolean(options.write),
    evidencePath: options.evidence ?? DEFAULT_EVIDENCE,
    certificationManifestPath:
      options.manifest ?? DEFAULT_CERTIFICATION_MANIFEST,
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
