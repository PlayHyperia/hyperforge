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
const SAFE_ID = /^[a-zA-Z0-9_-]+$/u;
const ASSET_PREFIX = "asset://";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
      const parsed = JSON.parse(
        bytes
          .subarray(start, end)
          .toString("utf8")
          .replace(/[\0\x20]+$/u, ""),
      );
      if (!isRecord(parsed)) throw new Error("invalid_glb_json_root");
      return parsed;
    }
    offset = end;
  }
  throw new Error("missing_glb_json_chunk");
}

function readHyperiaAuthorities(document) {
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
  const sceneAuthority =
    isRecord(scene) && isRecord(scene.extras) && isRecord(scene.extras.hyperia)
      ? scene.extras.hyperia
      : null;
  const rootAuthority =
    isRecord(root) && isRecord(root.extras) && isRecord(root.extras.hyperia)
      ? root.extras.hyperia
      : null;
  return { sceneAuthority, rootAuthority };
}

function resolveAssetPath(assetsRoot, assetUrl) {
  if (typeof assetUrl !== "string" || !assetUrl.startsWith(ASSET_PREFIX)) {
    throw new Error("invalid_equipped_model_path");
  }
  const relativePath = assetUrl.slice(ASSET_PREFIX.length);
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("unsafe_equipped_model_path");
  }
  const resolvedRoot = path.resolve(assetsRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("unsafe_equipped_model_path");
  }
  return { relativePath, resolved };
}

function resolveWorkspaceRelativePath(workspaceRoot, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error("unsafe_candidate_model_path");
  }
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("unsafe_candidate_model_path");
  }
  return { relativePath, resolved };
}

function validateAuthority(authority, itemId, avatarId, blockers) {
  if (!isRecord(authority?.duelFit)) {
    blockers.push("missing_fit_metadata");
    return;
  }
  const fit = authority.duelFit;
  if (
    fit.schemaVersion !== 1 ||
    typeof fit.itemId !== "string" ||
    typeof fit.slot !== "string" ||
    !Array.isArray(fit.compatibleAvatarIds) ||
    fit.compatibleAvatarIds.some((id) => typeof id !== "string")
  ) {
    blockers.push("invalid_fit_metadata");
  } else {
    if (fit.itemId !== itemId) blockers.push("fit_item_mismatch");
    if (fit.slot !== "gatheringtool") blockers.push("fit_slot_mismatch");
    if (!fit.compatibleAvatarIds.includes(avatarId)) {
      blockers.push("incompatible_avatar");
    }
  }
  if (
    authority.version !== 2 ||
    !["leftHand", "rightHand"].includes(authority.vrmBoneName) ||
    !Array.isArray(authority.relativeMatrix) ||
    authority.relativeMatrix.length !== 16 ||
    authority.relativeMatrix.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    blockers.push("invalid_fitted_attachment");
  }
}

export function auditPreparationToolVisuals({
  itemsPath,
  gatheringManifestPaths = [],
  assetsRoot,
  avatarId,
  technicalCandidateReportPaths = [],
  technicalCandidateAssetsRoot = null,
}) {
  if (typeof avatarId !== "string" || !SAFE_ID.test(avatarId)) {
    throw new Error("avatarId must be a safe non-empty ID");
  }
  const sourceBytes = readFileSync(itemsPath);
  const source = JSON.parse(sourceBytes.toString("utf8"));
  if (!Array.isArray(source))
    throw new Error("Tool item manifest must be an array");
  const itemById = new Map();
  for (const item of source) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (itemById.has(item.id))
      throw new Error(`Duplicate runtime tool ID: ${item.id}`);
    itemById.set(item.id, item);
  }
  if (
    !Array.isArray(technicalCandidateReportPaths) ||
    technicalCandidateReportPaths.some((entry) => typeof entry !== "string") ||
    (technicalCandidateReportPaths.length > 0 &&
      typeof technicalCandidateAssetsRoot !== "string")
  ) {
    throw new Error("Technical candidate report configuration is invalid");
  }
  const technicalCandidateByItemId = new Map();
  const technicalCandidateSources = technicalCandidateReportPaths.map(
    (reportPath) => {
      const reportBytes = readFileSync(reportPath);
      const report = JSON.parse(reportBytes.toString("utf8"));
      if (
        !isRecord(report) ||
        report.schemaVersion !== 1 ||
        !Array.isArray(report.outputs) ||
        report.outputs.length < 1 ||
        report.activeRuntimePathsChanged === true ||
        report.summary?.approvedForRuntimeActivation === true
      ) {
        throw new Error("Technical candidate report is invalid");
      }
      for (const output of report.outputs) {
        if (
          !isRecord(output) ||
          typeof output.itemId !== "string" ||
          !SAFE_ID.test(output.itemId) ||
          typeof output.outputPath !== "string" ||
          typeof output.outputSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(output.outputSha256) ||
          output.activeRuntimePath === true ||
          !isRecord(output.validator) ||
          ["errors", "warnings", "infos", "hints"].some(
            (key) => output.validator[key] !== 0,
          )
        ) {
          throw new Error("Technical candidate output is invalid");
        }
        if (!itemById.has(output.itemId)) {
          throw new Error(
            `Technical candidate targets unknown runtime item: ${output.itemId}`,
          );
        }
        if (technicalCandidateByItemId.has(output.itemId)) {
          throw new Error(
            `Duplicate technical candidate item ID: ${output.itemId}`,
          );
        }
        const blockers = [];
        let candidatePath;
        try {
          candidatePath = resolveWorkspaceRelativePath(
            technicalCandidateAssetsRoot,
            output.outputPath,
          );
        } catch (error) {
          blockers.push(
            error instanceof Error ? error.message : "invalid_candidate_path",
          );
        }
        let assetBytes;
        let assetSha256 = null;
        if (candidatePath) {
          try {
            assetBytes = readFileSync(candidatePath.resolved);
            assetSha256 = sha256(assetBytes);
            if (assetSha256 !== output.outputSha256) {
              blockers.push("candidate_hash_mismatch");
            }
          } catch {
            blockers.push("missing_candidate_asset");
          }
        }
        if (assetBytes) {
          try {
            const { sceneAuthority, rootAuthority } = readHyperiaAuthorities(
              parseGlbDocument(assetBytes),
            );
            if (
              sceneAuthority &&
              rootAuthority &&
              JSON.stringify(sceneAuthority.duelFit) !==
                JSON.stringify(rootAuthority.duelFit)
            ) {
              blockers.push("inconsistent_candidate_fit_authority");
            }
            validateAuthority(
              rootAuthority ?? sceneAuthority,
              output.itemId,
              avatarId,
              blockers,
            );
          } catch (error) {
            blockers.push(
              error instanceof Error ? error.message : "invalid_candidate_glb",
            );
          }
        }
        technicalCandidateByItemId.set(output.itemId, {
          path: candidatePath?.relativePath ?? output.outputPath,
          sha256: assetSha256,
          reportSha256: output.outputSha256,
          ready: blockers.length === 0,
          blockers: [...new Set(blockers)],
        });
      }
      return {
        path:
          path.relative(technicalCandidateAssetsRoot, reportPath) ||
          path.basename(reportPath),
        sha256: sha256(reportBytes),
        outputCount: report.outputs.length,
      };
    },
  );
  const requiredByItemId = new Map();
  const requirementSources = gatheringManifestPaths.map((manifestPath) => {
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!isRecord(manifest)) {
      throw new Error("Gathering manifest must be an object");
    }
    for (const entries of Object.values(manifest)) {
      if (!Array.isArray(entries)) continue;
      for (const resource of entries) {
        if (
          !isRecord(resource) ||
          typeof resource.id !== "string" ||
          typeof resource.toolRequired !== "string" ||
          !resource.toolRequired ||
          typeof resource.harvestSkill !== "string"
        ) {
          continue;
        }
        const requirement = requiredByItemId.get(resource.toolRequired) ?? {
          skill: resource.harvestSkill,
          resourceIds: new Set(),
        };
        if (requirement.skill !== resource.harvestSkill) {
          throw new Error(
            `Conflicting gathering skills require ${resource.toolRequired}`,
          );
        }
        requirement.resourceIds.add(resource.id);
        requiredByItemId.set(resource.toolRequired, requirement);
      }
    }
    return {
      path:
        path.relative(path.dirname(itemsPath), manifestPath) ||
        path.basename(manifestPath),
      sha256: sha256(manifestBytes),
    };
  });
  const runtimeTools = source.filter(
    (item) =>
      isRecord(item) &&
      (isRecord(item.tool) ||
        (typeof item.id === "string" && requiredByItemId.has(item.id))),
  );
  const seenIds = new Set();
  const tools = runtimeTools.map((item) => {
    if (typeof item.id !== "string" || !SAFE_ID.test(item.id)) {
      throw new Error("Tool item manifest contains an invalid runtime tool ID");
    }
    if (seenIds.has(item.id))
      throw new Error(`Duplicate runtime tool ID: ${item.id}`);
    seenIds.add(item.id);
    const resourceRequirement = requiredByItemId.get(item.id);
    const technicalCandidate = technicalCandidateByItemId.get(item.id);
    const blockers = [];
    const gatheringSpecificPaths = isRecord(item.gatheringModelPathsByAvatar)
      ? item.gatheringModelPathsByAvatar
      : null;
    const avatarSpecificPaths = isRecord(item.equippedModelPathsByAvatar)
      ? item.equippedModelPathsByAvatar
      : null;
    const hasGatheringSpecificPath = Boolean(
      gatheringSpecificPaths &&
      Object.prototype.hasOwnProperty.call(gatheringSpecificPaths, avatarId),
    );
    const hasAvatarSpecificPath = Boolean(
      avatarSpecificPaths &&
      Object.prototype.hasOwnProperty.call(avatarSpecificPaths, avatarId),
    );
    const equippedModelPath = hasGatheringSpecificPath
      ? gatheringSpecificPaths[avatarId]
      : hasAvatarSpecificPath
        ? avatarSpecificPaths[avatarId]
        : item.equippedModelPath;
    let assetRelativePath = null;
    let assetSha256 = null;
    let legacyAttachmentAvatarId = null;
    if (typeof equippedModelPath !== "string") {
      blockers.push("missing_equipped_model");
    } else {
      let asset;
      try {
        asset = resolveAssetPath(assetsRoot, equippedModelPath);
        assetRelativePath = asset.relativePath;
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : "invalid_asset_path",
        );
      }
      if (asset) {
        let assetBytes;
        try {
          assetBytes = readFileSync(asset.resolved);
          assetSha256 = sha256(assetBytes);
        } catch {
          blockers.push("missing_asset");
        }
        if (assetBytes) {
          try {
            const { sceneAuthority, rootAuthority } = readHyperiaAuthorities(
              parseGlbDocument(assetBytes),
            );
            if (
              sceneAuthority &&
              rootAuthority &&
              JSON.stringify(sceneAuthority.duelFit) !==
                JSON.stringify(rootAuthority.duelFit)
            ) {
              blockers.push("inconsistent_fit_authority");
            }
            const authority = rootAuthority ?? sceneAuthority;
            legacyAttachmentAvatarId =
              typeof authority?.avatarId === "string"
                ? authority.avatarId
                : null;
            validateAuthority(authority, item.id, avatarId, blockers);
          } catch (error) {
            blockers.push(
              error instanceof Error ? error.message : "invalid_glb",
            );
          }
        }
      }
    }
    return {
      itemId: item.id,
      skill:
        isRecord(item.tool) && typeof item.tool.skill === "string"
          ? item.tool.skill
          : (resourceRequirement?.skill ?? null),
      priority:
        isRecord(item.tool) && Number.isFinite(item.tool.priority)
          ? item.tool.priority
          : null,
      requiredByResources: resourceRequirement
        ? [...resourceRequirement.resourceIds].sort()
        : [],
      equippedModelPath:
        typeof equippedModelPath === "string" ? equippedModelPath : null,
      assetRelativePath,
      assetSha256,
      legacyAttachmentAvatarId,
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
      technicalCandidatePath: technicalCandidate?.path ?? null,
      technicalCandidateSha256: technicalCandidate?.sha256 ?? null,
      technicalCandidateReady: technicalCandidate?.ready ?? false,
      technicalCandidateBlockers: technicalCandidate
        ? technicalCandidate.blockers
        : ["missing_technical_candidate"],
    };
  });
  const summary = {
    runtimeToolCount: tools.length,
    resourceRequiredItemCount: tools.filter(
      (tool) => tool.requiredByResources.length > 0,
    ).length,
    declaredModelCount: tools.filter((tool) => tool.equippedModelPath).length,
    existingModelCount: tools.filter((tool) => tool.assetSha256).length,
    candidateCertifiedCount: tools.filter((tool) => tool.ready).length,
    missingModelCount: tools.filter((tool) =>
      tool.blockers.some((blocker) =>
        ["missing_equipped_model", "missing_asset"].includes(blocker),
      ),
    ).length,
    uncertifiedModelCount: tools.filter(
      (tool) => tool.assetSha256 && !tool.ready,
    ).length,
    blockedCount: tools.filter((tool) => !tool.ready).length,
    technicalCandidateDeclaredCount: technicalCandidateByItemId.size,
    technicalCandidateExistingCount: tools.filter(
      (tool) => tool.technicalCandidateSha256,
    ).length,
    technicalCandidateCertifiedCount: tools.filter(
      (tool) => tool.technicalCandidateReady,
    ).length,
    technicalCandidateMissingCount: tools.filter((tool) =>
      tool.technicalCandidateBlockers.includes("missing_technical_candidate"),
    ).length,
    technicalCandidateBlockedCount: tools.filter(
      (tool) => !tool.technicalCandidateReady,
    ).length,
  };
  return {
    schemaVersion: 3,
    avatarId,
    source: {
      path:
        path.relative(path.dirname(itemsPath), itemsPath) ||
        path.basename(itemsPath),
      sha256: sha256(sourceBytes),
    },
    requirementSources,
    technicalCandidateSources,
    summary,
    ready: summary.blockedCount === 0,
    technicalCandidateCoverageComplete:
      summary.technicalCandidateBlockedCount === 0,
    tools,
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
  const options = { avatarId: "kaykit-knight", requireReady: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-ready") {
      options.requireReady = true;
      continue;
    }
    if (argument === "--avatar-id" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument === "--avatar-id" ? "avatarId" : "output"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = auditPreparationToolVisuals({
    itemsPath: path.join(
      workspaceRoot,
      "packages/server/world/assets/manifests/items/tools.json",
    ),
    gatheringManifestPaths: ["woodcutting", "mining", "fishing"].map((name) =>
      path.join(
        workspaceRoot,
        `packages/server/world/assets/manifests/gathering/${name}.json`,
      ),
    ),
    assetsRoot: path.join(workspaceRoot, "packages/server/world/assets"),
    avatarId: options.avatarId,
    technicalCandidateReportPaths: [
      "artifacts/duel-launch-avatar-bakeoff/kaykit-preparation-tool-tier-report.json",
      "artifacts/duel-launch-avatar-bakeoff/quaternius-fishing-rod-fit-report.json",
      "artifacts/duel-launch-avatar-bakeoff/hyperia-fishing-tool-fit-report.json",
    ].map((relativePath) => path.join(workspaceRoot, relativePath)),
    technicalCandidateAssetsRoot: workspaceRoot,
  });
  if (options.output) {
    if (path.isAbsolute(options.output))
      throw new Error("Output must be workspace-relative");
    const outputPath = path.resolve(workspaceRoot, options.output);
    if (!outputPath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("Output must remain inside the workspace");
    }
    writeAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({ ...report.summary, ready: report.ready })}\n`,
  );
  if (options.requireReady && !report.ready) {
    throw new Error("Preparation-tool visual inventory is not launch ready");
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
