import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFittedRigidEquipmentGlb,
  certifyExistingFittedBowGlb,
  detectStaticBowStringComponents,
  parseRigidEquipmentArguments,
  parseGlb,
  stripStaticBowStringGlb,
} from "./build-steve-rigid-duel-equipment.mjs";
import { parsePreservedSteveBowArguments } from "./build-preserved-steve-bow-candidates.mjs";

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

function createGlb(document, binary = Buffer.from([1, 2, 3, 4])) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const length = 12 + 8 + padded.length + 8 + binary.length;
  const output = Buffer.alloc(length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(length, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  padded.copy(output, 20);
  const binaryOffset = 20 + padded.length;
  output.writeUInt32LE(binary.length, binaryOffset);
  output.writeUInt32LE(BIN_CHUNK_TYPE, binaryOffset + 4);
  binary.copy(output, binaryOffset + 8);
  return output;
}

const definition = {
  itemId: "shortbow",
  slot: "weapon",
  grip: "two-hand",
  weaponType: "bow",
  attachmentBone: "leftHand",
  sourcePath: "models/bows/source.glb",
  sourceSha256: "a".repeat(64),
  outputPath: "models/bows/output.glb",
  targetLengthMetres: 0.9,
  desiredWorldEulerDegrees: [0, 90, 0],
  desiredWorldOffsetMetres: [0, 0, 0],
  referenceMotion: {
    path: "emotes/range.glb",
    sha256: "b".repeat(64),
    sampleRatio: 0.55,
  },
};

const avatar = {
  id: "steve",
  legacyAttachmentId: "/api/assets/steve/model",
  path: "avatars/duel-steve.vrm",
  sha256: "c".repeat(64),
  normalizedHeight: 1.6,
};

const browserFit = {
  itemId: "shortbow",
  attachmentBone: "leftHand",
  relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 1],
  contentScale: 2,
  sourceLongestDimension: 2,
  targetLengthMetres: 0.9,
};

test("parses isolated rigid-fit manifests without weakening write-mode safety", () => {
  assert.deepEqual(parseRigidEquipmentArguments(["--check"]), {
    check: true,
    write: false,
    manifestPath: "scripts/steve-rigid-duel-equipment-fits.json",
    assetsRoot: "packages/server/world/assets",
    reportPath:
      "artifacts/duel-avatar-candidates/steve-rigid-equipment-fit-report.json",
  });
  assert.deepEqual(
    parseRigidEquipmentArguments([
      "--write",
      "--manifest=scripts/steve-harpoon-equipment-fits.json",
      "--assets-root=.",
      "--report=artifacts/duel-avatar-candidates/steve-harpoon-fit-report.json",
    ]),
    {
      check: false,
      write: true,
      manifestPath: "scripts/steve-harpoon-equipment-fits.json",
      assetsRoot: ".",
      reportPath:
        "artifacts/duel-avatar-candidates/steve-harpoon-fit-report.json",
    },
  );
  assert.throws(
    () => parseRigidEquipmentArguments(["--write", "--check"]),
    /exactly one/u,
  );
  assert.throws(
    () => parseRigidEquipmentArguments(["--write", "--manifest="]),
    /manifest path must be non-empty/u,
  );
  assert.throws(
    () => parseRigidEquipmentArguments(["--write", "--unknown=value"]),
    /Unknown argument/u,
  );
});

test("requires an explicit install flag before replacing active bow assets", () => {
  assert.deepEqual(parsePreservedSteveBowArguments([]), {
    assetsRoot: "packages/server/world/assets",
    install: false,
  });
  assert.deepEqual(
    parsePreservedSteveBowArguments([
      "--assets-root=fixtures/assets",
      "--install",
    ]),
    { assetsRoot: "fixtures/assets", install: true },
  );
  assert.throws(
    () => parsePreservedSteveBowArguments(["--assets-root="]),
    /Assets root must be non-empty/u,
  );
  assert.throws(
    () => parsePreservedSteveBowArguments(["--replace-anything"]),
    /Unknown argument/u,
  );
});

test("builds deterministic item- and avatar-specific rigid equipment", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 1, componentType: 5126, type: "VEC3" }],
    buffers: [{ byteLength: 4 }],
  });
  const first = buildFittedRigidEquipmentGlb({
    source,
    definition,
    avatar,
    exportedAt: "2026-08-11T12:00:00.000Z",
    browserFit,
  });
  const second = buildFittedRigidEquipmentGlb({
    source,
    definition,
    avatar,
    exportedAt: "2026-08-11T12:00:00.000Z",
    browserFit,
  });
  assert.ok(first.output.equals(second.output));
  const parsed = parseGlb(first.output);
  const scene = parsed.document.scenes[0];
  const wrapper = parsed.document.nodes[scene.nodes[0]];
  const content = parsed.document.nodes[wrapper.children[0]];
  assert.equal(wrapper.name, "EquipmentWrapper");
  assert.deepEqual(wrapper.matrix, browserFit.relativeMatrix);
  assert.deepEqual(content.scale, [2, 2, 2]);
  assert.deepEqual(wrapper.extras.hyperia.duelFit, {
    schemaVersion: 1,
    itemId: "shortbow",
    slot: "weapon",
    compatibleAvatarIds: ["steve"],
  });
  assert.deepEqual(scene.extras.hyperia, wrapper.extras.hyperia);
  assert.deepEqual(
    parsed.chunks.filter((chunk) => chunk.type !== JSON_CHUNK_TYPE)[0].data,
    Buffer.from([1, 2, 3, 4]),
  );
});

test("embeds the measured rendered-hand anchor in fitted bow authority", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const bowString = {
    schemaVersion: 1,
    contentNodeName: "EquipmentContent",
    upperTip: [0, 1, 0],
    lowerTip: [0, -1, 0],
    restNock: [0, 0, 0],
  };
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition,
    avatar,
    exportedAt: "2026-08-19T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      secondaryHandMeshCenterBoneLocal: [0.1, 0.2, 0.3],
    },
    bowString,
  });
  const metadata = parseGlb(output.output).document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.bowString, {
    ...bowString,
    drawHandLocalOffset: [0.1, 0.2, 0.3],
  });
});

test("can reproduce the certified legacy bow metadata without activating a new hand anchor", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const bowString = {
    schemaVersion: 1,
    contentNodeName: "EquipmentContent",
    upperTip: [0, 1, 0],
    lowerTip: [0, -1, 0],
    restNock: [0, 0, 0],
  };
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      preserveLegacyBowMetadata: true,
      certifiedRelativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
    avatar,
    exportedAt: "2026-08-19T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      secondaryHandMeshCenterBoneLocal: [0.1, 0.2, 0.3],
    },
    bowString,
  });
  const metadata = parseGlb(output.output).document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.bowString, bowString);
  assert.equal(metadata.bowString.drawHandLocalOffset, undefined);
  assert.deepEqual(
    metadata.relativeMatrix,
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
});

test("rejects non-finite browser transforms", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  assert.throws(
    () =>
      buildFittedRigidEquipmentGlb({
        source,
        definition,
        avatar,
        exportedAt: "2026-08-11T12:00:00.000Z",
        browserFit: {
          ...browserFit,
          relativeMatrix: [
            ...browserFit.relativeMatrix.slice(0, 15),
            Number.NaN,
          ],
        },
      }),
    /relativeMatrix/u,
  );
});

test("embeds an immutable avatar-local stabilizer contract for long staff fits", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      itemId: "staff_of_air",
      grip: "one-hand",
      weaponType: "staff",
      attachmentBone: "rightHand",
      stableHeldPose: {
        avatarLocalEulerDegrees: [0, 0, 32],
        anchorToPrimaryHandMeshCenter: true,
        avatarLocalPositionOffset: [0.05, 0, 0.005],
      },
    },
    avatar,
    exportedAt: "2026-08-11T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      itemId: "staff_of_air",
      attachmentBone: "rightHand",
      primaryHandMeshCenterBoneLocal: [0.04, 0.15, -0.02],
    },
  });
  const parsed = parseGlb(output.output);
  const metadata = parsed.document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.stableHeldPose, {
    schemaVersion: 1,
    wrapperNodeName: "EquipmentWrapper",
    avatarLocalEulerDegrees: [0, 0, 32],
    primaryBoneLocalOffset: [0.04, 0.15, -0.02],
    avatarLocalPositionOffset: [0.05, 0, 0.005],
  });
});

test("builds a left-hand shield with exact avatar and slot authority", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      itemId: "round_shield",
      slot: "shield",
      grip: "one-hand",
      weaponType: undefined,
      attachmentBone: "leftHand",
    },
    avatar,
    exportedAt: "2026-08-12T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      itemId: "round_shield",
      attachmentBone: "leftHand",
    },
  });
  const metadata = parseGlb(output.output).document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.duelFit, {
    schemaVersion: 1,
    itemId: "round_shield",
    slot: "shield",
    compatibleAvatarIds: ["steve"],
  });
  assert.equal(metadata.vrmBoneName, "leftHand");
  assert.equal(metadata.originalSlot, "shield");
  assert.equal("weaponType" in metadata, false);
});

test("builds a right-hand preparation tool with isolated transient authority", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      itemId: "kaykit_pickaxe_candidate",
      slot: "gatheringtool",
      grip: "two-hand",
      weaponType: "pickaxe",
      attachmentBone: "rightHand",
    },
    avatar,
    exportedAt: "2026-08-12T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      itemId: "kaykit_pickaxe_candidate",
      attachmentBone: "rightHand",
    },
  });
  const metadata = parseGlb(output.output).document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.duelFit, {
    schemaVersion: 1,
    itemId: "kaykit_pickaxe_candidate",
    slot: "gatheringtool",
    compatibleAvatarIds: ["steve"],
  });
  assert.equal(metadata.vrmBoneName, "rightHand");
  assert.equal(metadata.originalSlot, "gatheringtool");
  assert.equal(metadata.weaponType, "pickaxe");

  assert.throws(
    () =>
      buildFittedRigidEquipmentGlb({
        source,
        definition: {
          ...definition,
          itemId: "invalid_left_hand_tool",
          slot: "gatheringtool",
          grip: "two-hand",
          weaponType: "pickaxe",
          attachmentBone: "leftHand",
        },
        avatar,
        exportedAt: "2026-08-12T12:00:00.000Z",
        browserFit,
      }),
    /invalid rigid fit identity/u,
  );
});

test("embeds a render-synchronized two-hand contract for the harpoon", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      itemId: "harpoon",
      slot: "gatheringtool",
      grip: "two-hand",
      weaponType: "harpoon",
      attachmentBone: "rightHand",
      alignHandleToSecondaryHand: { sourceHandleAxis: [0, 1, 0] },
    },
    avatar,
    exportedAt: "2026-08-18T20:00:00.000Z",
    browserFit: {
      ...browserFit,
      itemId: "harpoon",
      attachmentBone: "rightHand",
    },
  });
  const metadata = parseGlb(output.output).document.scenes[0].extras.hyperia;
  assert.deepEqual(metadata.twoHandGrip, {
    schemaVersion: 1,
    wrapperNodeName: "EquipmentWrapper",
    sourceHandleAxis: [0, 1, 0],
    secondaryBoneName: "leftHand",
  });
});

test("anchors a two-hand weapon grip inside both rendered hands", () => {
  const source = createGlb({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
  });
  const output = buildFittedRigidEquipmentGlb({
    source,
    definition: {
      ...definition,
      itemId: "bronze_2h_sword",
      grip: "two-hand",
      weaponType: "sword",
      attachmentBone: "rightHand",
      sourceGripPoint: [0, -0.75, 0],
      primaryGripAnchor: "hand-mesh-center",
      alignHandleToSecondaryHand: {
        sourceHandleAxis: [0, 1, 0],
        secondaryGripAnchor: "hand-mesh-center",
      },
    },
    avatar,
    exportedAt: "2026-08-19T12:00:00.000Z",
    browserFit: {
      ...browserFit,
      itemId: "bronze_2h_sword",
      attachmentBone: "rightHand",
      secondaryHandMeshCenterBoneLocal: [0.1, 0.2, 0.3],
    },
  });
  const parsed = parseGlb(output.output).document;
  const metadata = parsed.scenes[0].extras.hyperia;
  const content = parsed.nodes.find((node) => node.name === "EquipmentContent");
  assert.deepEqual(content.translation, [0, 1.5, 0]);
  assert.deepEqual(metadata.twoHandGrip, {
    schemaVersion: 1,
    wrapperNodeName: "EquipmentWrapper",
    sourceHandleAxis: [0, 1, 0],
    secondaryBoneName: "leftHand",
    secondaryBoneLocalOffset: [0.1, 0.2, 0.3],
  });
  assert.deepEqual(metadata.fitReference.sourceGripPoint, [0, -0.75, 0]);
  assert.equal(metadata.fitReference.primaryGripAnchor, "hand-mesh-center");
  assert.equal(
    metadata.fitReference.alignHandleToSecondaryHand.secondaryGripAnchor,
    "hand-mesh-center",
  );
});

test("removes only the frozen source bowstring components deterministically", () => {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const source = readFileSync(
    path.join(
      workspaceRoot,
      "packages/server/world/assets/models/bows/bow-wood/bow-wood.glb",
    ),
  );
  const first = stripStaticBowStringGlb(source);
  const second = stripStaticBowStringGlb(source);
  assert.ok(first.output.equals(second.output));
  assert.equal(first.report.sourceVertexCount, 3343);
  assert.equal(first.report.sourceTriangleCount, 4890);
  assert.equal(first.report.stringComponentCount, 3);
  assert.equal(first.report.stringVertexCount, 860);
  assert.equal(first.report.removedTriangleCount, 1078);
  assert.equal(first.report.outputTriangleCount, 3812);
  for (const point of [
    first.bowString.upperTip,
    first.bowString.lowerTip,
    first.bowString.restNock,
  ]) {
    assert.equal(point.length, 3);
    assert.ok(point.every(Number.isFinite));
  }
  assert.ok(!first.output.equals(source));
});

test("certifies an existing fitted bow without changing its authored attachment", () => {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const source = readFileSync(
    path.join(
      workspaceRoot,
      "packages/server/world/assets/models/bows/bow-wood/bow-wood-aligned.glb",
    ),
  );
  const original = parseGlb(source).document;
  const originalWrapper = original.nodes.find(
    (node) => node.name === "EquipmentWrapper",
  );
  const options = {
    source,
    itemId: "magic_shortbow",
    compatibleAvatarId: "steve",
    legacyAvatarId: "/api/assets/steve/model",
    drawHandLocalOffset: [-0.001610018312, 0.322080308384, -0.032384146338],
    stableHeldPose: {
      avatarLocalEulerDegrees: [12.5, -5.8, 10.4],
    },
    gripContact: {
      schemaVersion: 1,
      contentNodeName: "EquipmentContent",
      sourceAxis: [0, 1, 0],
      actionEnd: "dynamic-aim",
      zones: [
        {
          id: "primary",
          boneName: "leftHand",
          minimumSourceProjection: -0.16,
          maximumSourceProjection: 0.16,
        },
      ],
    },
    exportedAt: "2026-08-19T18:00:00.000Z",
  };
  const first = certifyExistingFittedBowGlb(options);
  const second = certifyExistingFittedBowGlb(options);
  const parsed = parseGlb(first.output).document;
  const wrapper = parsed.nodes.find((node) => node.name === "EquipmentWrapper");
  const content = parsed.nodes.find((node) => node.name === "EquipmentContent");

  assert.ok(first.output.equals(second.output));
  assert.deepEqual(wrapper.matrix, originalWrapper.matrix);
  assert.deepEqual(
    wrapper.extras.hyperia.relativeMatrix,
    originalWrapper.extras.hyperia.relativeMatrix,
  );
  assert.deepEqual(content.matrix, original.nodes[1].matrix);
  assert.deepEqual(wrapper.extras.hyperia.duelFit, {
    schemaVersion: 1,
    itemId: "magic_shortbow",
    slot: "weapon",
    compatibleAvatarIds: ["steve"],
  });
  assert.equal(
    wrapper.extras.hyperia.bowString.contentNodeName,
    "EquipmentContent",
  );
  assert.deepEqual(
    wrapper.extras.hyperia.bowString.drawHandLocalOffset,
    [-0.001610018312, 0.322080308384, -0.032384146338],
  );
  assert.deepEqual(wrapper.extras.hyperia.stableHeldPose, {
    schemaVersion: 1,
    wrapperNodeName: "EquipmentWrapper",
    avatarLocalEulerDegrees: [12.5, -5.8, 10.4],
  });
  assert.deepEqual(wrapper.extras.hyperia.gripContact, options.gripContact);
  assert.ok(first.report.staticString.removedTriangleCount > 0);
});

test("detects a thread-thin bowstring along a rotated longitudinal axis", () => {
  const string = {
    vertexIndices: [0, 1, 2],
    minimum: [-0.33, -0.01, -0.8],
    maximum: [-0.31, 0.01, 0.8],
  };
  const bowLimb = {
    vertexIndices: [3, 4, 5],
    minimum: [-0.37, -0.08, -0.99],
    maximum: [0.13, 0.08, 0.99],
  };
  const result = detectStaticBowStringComponents([string, bowLimb], {
    minimum: [-0.37, -0.08, -0.99],
    maximum: [0.13, 0.08, 0.99],
  });
  assert.equal(result.longitudinalAxis, 2);
  assert.deepEqual(result.stringComponents, [string]);
});
