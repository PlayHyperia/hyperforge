import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditPreparationToolVisuals } from "./audit-preparation-tool-visuals.mjs";

function createGlb(document) {
  const json = Buffer.from(JSON.stringify(document));
  const padding = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.alloc(json.length + padding, 0x20);
  json.copy(chunk);
  const result = Buffer.alloc(20 + chunk.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(chunk.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(result, 20);
  return result;
}

function authority(itemId) {
  return {
    version: 2,
    vrmBoneName: "rightHand",
    relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    duelFit: {
      schemaVersion: 1,
      itemId,
      slot: "gatheringtool",
      compatibleAvatarIds: ["kaykit-knight"],
    },
  };
}

test("reports exact modeled, certified, and missing preparation-tool coverage", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const assetsRoot = path.join(root, "assets");
    const itemsPath = path.join(root, "tools.json");
    const modelPath = path.join(assetsRoot, "models", "pickaxe.glb");
    mkdirSync(path.dirname(modelPath), { recursive: true });
    const fit = authority("bronze_pickaxe");
    writeFileSync(
      modelPath,
      createGlb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0], extras: { hyperia: fit } }],
        nodes: [{ extras: { hyperia: fit } }],
      }),
    );
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          id: "bronze_pickaxe",
          tool: { skill: "mining", priority: 1 },
          equippedModelPath: "asset://models/pickaxe.glb",
        },
        {
          id: "iron_pickaxe",
          tool: { skill: "mining", priority: 2 },
          equippedModelPath: null,
        },
        { id: "hammer", type: "tool" },
      ]),
    );

    const report = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot,
      avatarId: "kaykit-knight",
    });
    assert.deepEqual(report.summary, {
      runtimeToolCount: 2,
      resourceRequiredItemCount: 0,
      declaredModelCount: 1,
      existingModelCount: 1,
      candidateCertifiedCount: 1,
      missingModelCount: 1,
      uncertifiedModelCount: 0,
      blockedCount: 1,
      technicalCandidateDeclaredCount: 0,
      technicalCandidateExistingCount: 0,
      technicalCandidateCertifiedCount: 0,
      technicalCandidateMissingCount: 2,
      technicalCandidateBlockedCount: 2,
    });
    assert.equal(report.ready, false);
    assert.deepEqual(report.tools[1].blockers, ["missing_equipped_model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selects an exact avatar-specific active tool and fails closed for other bodies", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const assetsRoot = path.join(root, "assets");
    const itemsPath = path.join(root, "tools.json");
    const modelPath = path.join(assetsRoot, "models", "harpoon.glb");
    mkdirSync(path.dirname(modelPath), { recursive: true });
    const fit = {
      ...authority("harpoon"),
      duelFit: {
        ...authority("harpoon").duelFit,
        compatibleAvatarIds: ["steve"],
      },
    };
    writeFileSync(
      modelPath,
      createGlb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0], extras: { hyperia: fit } }],
        nodes: [{ extras: { hyperia: fit } }],
      }),
    );
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          id: "harpoon",
          tool: { skill: "fishing", priority: 3 },
          equippedModelPath: null,
          equippedModelPathsByAvatar: {
            steve: "asset://models/harpoon.glb",
          },
        },
      ]),
    );

    const steve = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot,
      avatarId: "steve",
    });
    assert.equal(steve.tools[0].ready, true);
    assert.equal(
      steve.tools[0].equippedModelPath,
      "asset://models/harpoon.glb",
    );

    const otherAvatar = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot,
      avatarId: "kaykit-knight",
    });
    assert.equal(otherAvatar.tools[0].ready, false);
    assert.deepEqual(otherAvatar.tools[0].blockers, ["missing_equipped_model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers a gathering-only fit over a dual-role combat model", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const assetsRoot = path.join(root, "assets");
    const itemsPath = path.join(root, "tools.json");
    const modelPath = path.join(assetsRoot, "models", "hatchet-gathering.glb");
    mkdirSync(path.dirname(modelPath), { recursive: true });
    const fit = {
      ...authority("bronze_hatchet"),
      duelFit: {
        ...authority("bronze_hatchet").duelFit,
        compatibleAvatarIds: ["steve"],
      },
    };
    writeFileSync(
      modelPath,
      createGlb({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0], extras: { hyperia: fit } }],
        nodes: [{ extras: { hyperia: fit } }],
      }),
    );
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          id: "bronze_hatchet",
          tool: { skill: "woodcutting", priority: 6 },
          equippedModelPath: "asset://models/combat-hatchet.glb",
          gatheringModelPathsByAvatar: {
            steve: "asset://models/hatchet-gathering.glb",
          },
        },
      ]),
    );

    const report = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot,
      avatarId: "steve",
    });
    assert.equal(report.tools[0].ready, true);
    assert.equal(
      report.tools[0].equippedModelPath,
      "asset://models/hatchet-gathering.glb",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("includes exact resource-required fishing items without generic tool metadata", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const itemsPath = path.join(root, "tools.json");
    const fishingPath = path.join(root, "fishing.json");
    writeFileSync(
      itemsPath,
      JSON.stringify([
        { id: "small_fishing_net", type: "tool" },
        {
          id: "fishing_rod",
          type: "tool",
          tool: { skill: "fishing", priority: 2 },
        },
      ]),
    );
    writeFileSync(
      fishingPath,
      JSON.stringify({
        spots: [
          {
            id: "fishing_spot_net",
            harvestSkill: "fishing",
            toolRequired: "small_fishing_net",
          },
          {
            id: "fishing_spot_bait",
            harvestSkill: "fishing",
            toolRequired: "fishing_rod",
          },
          {
            id: "fishing_spot_monkfish",
            harvestSkill: "fishing",
            toolRequired: "small_fishing_net",
          },
        ],
      }),
    );

    const report = auditPreparationToolVisuals({
      itemsPath,
      gatheringManifestPaths: [fishingPath],
      assetsRoot: root,
      avatarId: "kaykit-knight",
    });
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.summary.runtimeToolCount, 2);
    assert.equal(report.summary.resourceRequiredItemCount, 2);
    assert.deepEqual(report.tools[0], {
      itemId: "small_fishing_net",
      skill: "fishing",
      priority: null,
      requiredByResources: ["fishing_spot_monkfish", "fishing_spot_net"],
      equippedModelPath: null,
      assetRelativePath: null,
      assetSha256: null,
      legacyAttachmentAvatarId: null,
      ready: false,
      blockers: ["missing_equipped_model"],
      technicalCandidatePath: null,
      technicalCandidateSha256: null,
      technicalCandidateReady: false,
      technicalCandidateBlockers: ["missing_technical_candidate"],
    });
    assert.equal(report.requirementSources.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("separately reports exact inactive technical candidates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const itemsPath = path.join(root, "tools.json");
    const candidatePath = path.join(root, "candidates", "bronze_pickaxe.glb");
    const candidateReportPath = path.join(root, "candidate-report.json");
    mkdirSync(path.dirname(candidatePath), { recursive: true });
    const fit = authority("bronze_pickaxe");
    const candidateBytes = createGlb({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0], extras: { hyperia: fit } }],
      nodes: [{ extras: { hyperia: fit } }],
    });
    writeFileSync(candidatePath, candidateBytes);
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          id: "bronze_pickaxe",
          tool: { skill: "mining", priority: 1 },
          equippedModelPath: null,
        },
        {
          id: "iron_pickaxe",
          tool: { skill: "mining", priority: 2 },
          equippedModelPath: null,
        },
      ]),
    );
    const candidateSha256 = createHash("sha256")
      .update(candidateBytes)
      .digest("hex");
    writeFileSync(
      candidateReportPath,
      JSON.stringify({
        schemaVersion: 1,
        activeRuntimePathsChanged: false,
        summary: { approvedForRuntimeActivation: false },
        outputs: [
          {
            itemId: "bronze_pickaxe",
            outputPath: "candidates/bronze_pickaxe.glb",
            outputSha256: candidateSha256,
            activeRuntimePath: false,
            validator: { errors: 0, warnings: 0, infos: 0, hints: 0 },
          },
        ],
      }),
    );

    const report = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot: root,
      avatarId: "kaykit-knight",
      technicalCandidateReportPaths: [candidateReportPath],
      technicalCandidateAssetsRoot: root,
    });
    assert.equal(report.ready, false);
    assert.equal(report.technicalCandidateCoverageComplete, false);
    assert.equal(report.summary.technicalCandidateCertifiedCount, 1);
    assert.equal(report.summary.technicalCandidateMissingCount, 1);
    assert.equal(report.tools[0].technicalCandidateReady, true);
    assert.equal(report.tools[0].ready, false);
    assert.deepEqual(report.tools[1].technicalCandidateBlockers, [
      "missing_technical_candidate",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate runtime tool IDs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const itemsPath = path.join(root, "tools.json");
    writeFileSync(
      itemsPath,
      JSON.stringify([
        { id: "pickaxe", tool: { skill: "mining", priority: 1 } },
        { id: "pickaxe", tool: { skill: "mining", priority: 2 } },
      ]),
    );
    assert.throws(
      () =>
        auditPreparationToolVisuals({
          itemsPath,
          assetsRoot: root,
          avatarId: "kaykit-knight",
        }),
      /Duplicate runtime tool ID/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on an unsafe equipped-model path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-tool-audit-"));
  try {
    const itemsPath = path.join(root, "tools.json");
    writeFileSync(
      itemsPath,
      JSON.stringify([
        {
          id: "pickaxe",
          tool: { skill: "mining", priority: 1 },
          equippedModelPath: "asset://../outside.glb",
        },
      ]),
    );
    const report = auditPreparationToolVisuals({
      itemsPath,
      assetsRoot: root,
      avatarId: "kaykit-knight",
    });
    assert.deepEqual(report.tools[0].blockers, ["unsafe_equipped_model_path"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
