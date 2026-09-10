import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  promoteDuelRigidEquipmentCertificationCandidates,
  validateSemanticGripMotionReview,
} from "./promote-duel-rigid-equipment-certification-candidates.mjs";
import { verifyActiveDuelEquipmentBindings } from "./verify-duel-rigid-equipment-certifications.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EVIDENCE_ROOT =
  "artifacts/duel-launch-avatar-bakeoff/semantic-grip-certification";
const CANDIDATE_ASSET =
  "models/candidates/semantic-grip-certification/bronze_shortsword.glb";
const REPORT_PATH = `${EVIDENCE_ROOT}/bronze-shortsword-close-report.json`;
const CONTACT_SHEET_PATH = `${EVIDENCE_ROOT}/bronze-shortsword-close.png`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const certificationManifest = JSON.parse(
    readFileSync(
      path.join(
        WORKSPACE_ROOT,
        "scripts/duel-rigid-equipment-certifications.json",
      ),
      "utf8",
    ),
  );
  const certification = certificationManifest.certifications.find(
    (entry) => entry.itemId === "bronze_shortsword",
  );
  const reportBytes = readFileSync(path.join(WORKSPACE_ROOT, REPORT_PATH));
  const contactSheetBytes = readFileSync(
    path.join(WORKSPACE_ROOT, CONTACT_SHEET_PATH),
  );
  return {
    certificationManifest,
    certification,
    report: JSON.parse(reportBytes.toString("utf8")),
    reportBytes,
    contactSheetBytes,
  };
}

function validate(report, values = fixture()) {
  return validateSemanticGripMotionReview({
    workspaceRoot: WORKSPACE_ROOT,
    report,
    reviewKind: "close",
    reportPath: REPORT_PATH,
    reportBytes: values.reportBytes,
    contactSheetPath: CONTACT_SHEET_PATH,
    contactSheetBytes: values.contactSheetBytes,
    itemId: values.certification.itemId,
    candidateAsset: CANDIDATE_ASSET,
    candidateSha256: sha256(
      readFileSync(
        path.join(
          WORKSPACE_ROOT,
          "packages/server/world/assets",
          CANDIDATE_ASSET,
        ),
      ),
    ),
    gripContact: values.certification.presentationAuthority.gripContact,
    expectedMotionCount: 8,
  });
}

test("accepts the exact locked Metal/WebGPU handle review", () => {
  const values = fixture();
  const result = validate(values.report, values);
  assert.equal(result.itemId, "bronze_shortsword");
  assert.equal(result.motionCount, 8);
  assert.equal(result.gripContactCount, 8);
  assert.equal(result.fourAngleReview, true);
  assert.ok(result.maximumActionDirectionDeviationDegrees <= 0.001);
  assert.equal(result.bowDrawAlignmentCount, 0);
  assert.equal(result.contactSheetSha256, sha256(values.contactSheetBytes));
});

test("rejects fallback rendering and false handle contact", () => {
  const values = fixture();
  const fallback = structuredClone(values.report);
  fallback.rendererBackend = "webgl";
  assert.throws(
    () => validate(fallback, values),
    /not clean locked WebGPU evidence/u,
  );

  const missedHandle = structuredClone(values.report);
  missedHandle.motions[0].equipment.gripZoneContacts[0].intersects = false;
  assert.throws(
    () => validate(missedHandle, values),
    /misses the authored primary handle zone/u,
  );
});

test("rejects action-end and evidence hash drift", () => {
  const values = fixture();
  const missingDirection = structuredClone(values.report);
  missingDirection.motions[0].equipment.actionDirectionWorld = null;
  assert.throws(
    () => validate(missingDirection, values),
    /lost directed action-end authority/u,
  );

  const reversedDirection = structuredClone(values.report);
  reversedDirection.motions[0].equipment.actionDirectionWorld =
    reversedDirection.motions[0].equipment.actionDirectionWorld.map(
      (value) => -value,
    );
  assert.throws(
    () => validate(reversedDirection, values),
    /directed action end is reversed or drifted/u,
  );

  const wrongCamera = structuredClone(values.report);
  wrongCamera.motions[0].cameraYawDegrees = 90;
  assert.throws(
    () => validate(wrongCamera, values),
    /not a clean equipment sample/u,
  );

  const driftedSheet = Buffer.from(values.contactSheetBytes);
  driftedSheet[0] ^= 0xff;
  assert.throws(
    () =>
      validateSemanticGripMotionReview({
        workspaceRoot: WORKSPACE_ROOT,
        report: values.report,
        reviewKind: "close",
        reportPath: REPORT_PATH,
        reportBytes: values.reportBytes,
        contactSheetPath: CONTACT_SHEET_PATH,
        contactSheetBytes: driftedSheet,
        itemId: values.certification.itemId,
        candidateAsset: CANDIDATE_ASSET,
        candidateSha256: values.report.inputs[CANDIDATE_ASSET],
        gripContact: values.certification.presentationAuthority.gripContact,
        expectedMotionCount: 8,
      }),
    /not clean locked WebGPU evidence/u,
  );
});

test("requires exact four-angle bow nock and aim alignment", () => {
  const values = fixture();
  values.certification = values.certificationManifest.certifications.find(
    (entry) => entry.itemId === "shortbow",
  );
  const reportPath = `${EVIDENCE_ROOT}/shortbow-motion-report.json`;
  const contactSheetPath = `${EVIDENCE_ROOT}/shortbow-motion.png`;
  const reportBytes = readFileSync(path.join(WORKSPACE_ROOT, reportPath));
  const contactSheetBytes = readFileSync(
    path.join(WORKSPACE_ROOT, contactSheetPath),
  );
  const report = JSON.parse(reportBytes.toString("utf8"));
  const args = {
    workspaceRoot: WORKSPACE_ROOT,
    reviewKind: "motion",
    reportPath,
    reportBytes,
    contactSheetPath,
    contactSheetBytes,
    itemId: "shortbow",
    candidateAsset:
      "models/candidates/semantic-grip-certification/shortbow.glb",
    candidateSha256:
      report.inputs[
        "models/candidates/semantic-grip-certification/shortbow.glb"
      ],
    gripContact: values.certification.presentationAuthority.gripContact,
    expectedMotionCount: 14,
  };
  const result = validateSemanticGripMotionReview({ ...args, report });
  assert.equal(result.bowDrawAlignmentCount, 4);
  assert.equal(result.maximumNockedArrowNockDistanceMetres, 0);
  assert.equal(result.maximumNockedArrowAimDeviationDegrees, 0);

  const driftedAim = structuredClone(report);
  driftedAim.motions[8].equipment.nockedArrowAimDeviationDegrees = 0.01;
  assert.throws(
    () => validateSemanticGripMotionReview({ ...args, report: driftedAim }),
    /lost nock or aim alignment/u,
  );

  const ghostArrow = structuredClone(report);
  ghostArrow.motions[0].equipment.nockedArrowVisible = true;
  assert.throws(
    () => validateSemanticGripMotionReview({ ...args, report: ghostArrow }),
    /ghost nocked arrow/u,
  );
});

test("revalidates the complete six-item activation without mutation", () => {
  const values = fixture();
  const itemManifest = JSON.parse(
    readFileSync(
      path.join(
        WORKSPACE_ROOT,
        "packages/server/world/assets/manifests/items/weapons.json",
      ),
      "utf8",
    ),
  );
  const evidence = promoteDuelRigidEquipmentCertificationCandidates({
    workspaceRoot: WORKSPACE_ROOT,
    certificationManifest: values.certificationManifest,
    itemManifest,
    write: false,
  });
  assert.deepEqual(evidence.totals, {
    itemCount: 6,
    reviewCount: 12,
    motionCount: 126,
    gripContactCount: 126,
    browserErrorCount: 0,
    auditFailureCount: 0,
  });
  assert.equal(evidence.productApproved, false);
});

// Replay real retained WebGPU evidence in an isolated filesystem. This validates
// promotion and binding mechanics, not a new avatar's hand geometry or visuals.
function overridePromotionFixture(itemIds = ["bronze_shortsword"]) {
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-override-promotion-"),
  );
  const copy = (file) => {
    const destination = path.join(workspaceRoot, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(WORKSPACE_ROOT, file)));
  };
  const certificationManifest = fixture().certificationManifest;
  certificationManifest.certifications =
    certificationManifest.certifications.filter((entry) =>
      itemIds.includes(entry.itemId),
    );
  const avatarAsset = "avatars/duel-candidates/duel-steve.vrm";
  copy("packages/shared/src/data/avatars.ts");
  copy(`packages/server/world/assets/${avatarAsset}`);
  for (const certification of certificationManifest.certifications) {
    copy(certification.path);
    const baseName = certification.itemId.replaceAll("_", "-");
    const motionKind = certification.itemId.startsWith("bronze_")
      ? "locomotion"
      : "motion";
    for (const name of [`${baseName}-close`, `${baseName}-${motionKind}`]) {
      const reportFile = `${EVIDENCE_ROOT}/${name}-report.json`;
      copy(reportFile);
      const report = JSON.parse(
        readFileSync(path.join(workspaceRoot, reportFile), "utf8"),
      );
      copy(report.contactSheet.path);
      copy(report.manifests.motions.path);
      for (const asset of Object.keys(report.inputs))
        copy(`packages/server/world/assets/${asset}`);
    }
  }
  certificationManifest.binding = {
    mode: "avatar-override",
    avatar: {
      url: `asset://${avatarAsset}`,
      sha256: sha256(
        readFileSync(
          path.join(workspaceRoot, "packages/server/world/assets", avatarAsset),
        ),
      ),
    },
  };
  certificationManifest.promotion = {
    candidateAssetRoot: "models/candidates/semantic-grip-certification",
    evidenceRoot: EVIDENCE_ROOT,
  };
  const certificationManifestPath =
    "scripts/fixture-avatar-certifications.json";
  const evidencePath = "artifacts/fixture-avatar-activation.json";
  const itemManifestPath =
    "packages/server/world/assets/manifests/items/weapons.json";
  const itemManifest = certificationManifest.certifications.map(
    (certification) => ({
      id: certification.itemId,
      equippedModelPath: "asset://models/unrelated-default.glb",
      equippedModelSha256: "a".repeat(64),
      equippedModelPathsByAvatar: {
        steve: `asset://${certification.path.slice("packages/server/world/assets/".length)}`,
        "kaykit-knight": "asset://models/unrelated-knight.glb",
      },
      equippedModelSha256ByAvatar: {
        steve: certification.sha256,
        "kaykit-knight": "b".repeat(64),
      },
      unchangedGameplayField: { attack: 7 },
    }),
  );
  const saveInputs = () => {
    for (const [file, value] of [
      [certificationManifestPath, certificationManifest],
      [itemManifestPath, itemManifest],
    ]) {
      const target = path.join(workspaceRoot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  saveInputs();
  return {
    workspaceRoot,
    certificationManifest,
    certificationManifestPath,
    evidencePath,
    itemManifestPath,
    itemManifest,
    saveInputs,
    promote(write = true, values = {}) {
      return promoteDuelRigidEquipmentCertificationCandidates({
        workspaceRoot,
        certificationManifest,
        certificationManifestPath,
        evidencePath,
        itemManifest,
        write,
        ...values,
      });
    },
  };
}

test("copy-on-write override promotion retains defaults, originals, other avatars and exact evidence", () => {
  const values = overridePromotionFixture();
  try {
    const beforeItem = structuredClone(values.itemManifest);
    const beforeCertification = structuredClone(values.certificationManifest);
    const originalPath = beforeCertification.certifications[0].path;
    const originalBytes = readFileSync(
      path.join(values.workspaceRoot, originalPath),
    );
    const report = values.promote();
    assert.equal(report.productApproved, false);
    assert.equal(report.installations.length, 1);
    assert.equal(report.reviews.length, 2);
    const installation = report.installations[0];
    assert.ok(
      installation.destinationPath.endsWith(
        `.${installation.candidateSha256}.glb`,
      ),
    );
    assert.notEqual(installation.destinationPath, originalPath);
    assert.deepEqual(
      readFileSync(path.join(values.workspaceRoot, originalPath)),
      originalBytes,
    );
    const nextItems = JSON.parse(
      readFileSync(
        path.join(values.workspaceRoot, values.itemManifestPath),
        "utf8",
      ),
    );
    const nextCertification = JSON.parse(
      readFileSync(
        path.join(values.workspaceRoot, values.certificationManifestPath),
        "utf8",
      ),
    );
    assert.equal(
      nextItems[0].equippedModelPath,
      beforeItem[0].equippedModelPath,
    );
    assert.equal(
      nextItems[0].equippedModelSha256,
      beforeItem[0].equippedModelSha256,
    );
    assert.equal(
      nextItems[0].equippedModelPathsByAvatar["kaykit-knight"],
      beforeItem[0].equippedModelPathsByAvatar["kaykit-knight"],
    );
    assert.equal(
      nextItems[0].equippedModelSha256ByAvatar["kaykit-knight"],
      beforeItem[0].equippedModelSha256ByAvatar["kaykit-knight"],
    );
    assert.deepEqual(
      nextItems[0].unchangedGameplayField,
      beforeItem[0].unchangedGameplayField,
    );
    assert.equal(
      nextItems[0].equippedModelSha256ByAvatar.steve,
      sha256(
        readFileSync(
          path.join(values.workspaceRoot, installation.destinationPath),
        ),
      ),
    );
    assert.equal(
      verifyActiveDuelEquipmentBindings({
        workspaceRoot: values.workspaceRoot,
        certificationManifest: nextCertification,
        itemManifest: nextItems,
      }).ok,
      true,
    );
    assert.deepEqual(
      values.promote(false, {
        certificationManifest: nextCertification,
        itemManifest: nextItems,
      }),
      report,
    );
    assert.deepEqual(values.itemManifest, beforeItem);
    assert.deepEqual(values.certificationManifest, beforeCertification);
    assert.equal(
      existsSync(
        path.join(
          values.workspaceRoot,
          `${values.itemManifestPath}.avatar-promotion-lock`,
        ),
      ),
      false,
    );
  } finally {
    rmSync(values.workspaceRoot, { recursive: true, force: true });
  }
});

test("override promotion rejects invalid identities and mappings before writing anything active", () => {
  for (const [mutate, pattern] of [
    [
      (values) => {
        values.certificationManifest.certifications[0].grip = "invalid";
      },
      /invalid equipment slot or grip/u,
    ],
    [
      (values) => {
        values.certificationManifest.binding.avatar.sha256 = "0".repeat(64);
      },
      /avatar SHA-256 drifted/u,
    ],
    [
      (values) => {
        values.certificationManifest.certifications.push(
          structuredClone(values.certificationManifest.certifications[0]),
        );
      },
      /duplicate certified mappings/u,
    ],
    [
      (values) => {
        values.itemManifest.push(structuredClone(values.itemManifest[0]));
      },
      /Duplicate weapon itemId/u,
    ],
    [
      (values) => {
        delete values.itemManifest[0].equippedModelPathsByAvatar.steve;
      },
      /override binding drifted/u,
    ],
    [
      (values) => {
        values.itemManifest[0].equippedModelSha256ByAvatar.steve = "0".repeat(
          64,
        );
      },
      /override binding drifted/u,
    ],
    [
      (values) => {
        values.itemManifest[0].equippedModelPath =
          values.itemManifest[0].equippedModelPathsByAvatar.steve;
      },
      /leaks into a default/u,
    ],
    [
      (values) => {
        values.certificationManifest.promotion.candidateAssetRoot =
          "models/candidates/../escape";
      },
      /normalized workspace-relative path/u,
    ],
    [
      (values) => {
        values.certificationManifest.certifications[0].presentationAuthority.gripContact.zones =
          [];
      },
      /semantic grip authority contradicts/u,
    ],
  ]) {
    const values = overridePromotionFixture();
    try {
      mutate(values);
      values.saveInputs();
      const itemBefore = readFileSync(
        path.join(values.workspaceRoot, values.itemManifestPath),
      );
      const certificationBefore = readFileSync(
        path.join(values.workspaceRoot, values.certificationManifestPath),
      );
      assert.throws(() => values.promote(), pattern);
      assert.deepEqual(
        readFileSync(path.join(values.workspaceRoot, values.itemManifestPath)),
        itemBefore,
      );
      assert.deepEqual(
        readFileSync(
          path.join(values.workspaceRoot, values.certificationManifestPath),
        ),
        certificationBefore,
      );
      assert.equal(
        existsSync(path.join(values.workspaceRoot, values.evidencePath)),
        false,
      );
    } finally {
      rmSync(values.workspaceRoot, { recursive: true, force: true });
    }
  }
});

test("promotion switches a changed model digest while preserving the original non-JSON data", () => {
  const values = overridePromotionFixture();
  try {
    const certification = values.certificationManifest.certifications[0];
    const assetFile = path.join(values.workspaceRoot, certification.path);
    const exactBytes = readFileSync(assetFile);
    const jsonLength = exactBytes.readUInt32LE(12);
    // Valid extra JSON padding gives the active file a different whole-file
    // identity without changing any geometry, transforms, or binary chunk.
    const priorBytes = Buffer.concat([
      exactBytes.subarray(0, 20 + jsonLength),
      Buffer.alloc(4, 0x20),
      exactBytes.subarray(20 + jsonLength),
    ]);
    priorBytes.writeUInt32LE(priorBytes.length, 8);
    priorBytes.writeUInt32LE(jsonLength + 4, 12);
    writeFileSync(assetFile, priorBytes);
    const previousSha256 = sha256(priorBytes);
    certification.sha256 = previousSha256;
    values.itemManifest[0].equippedModelSha256ByAvatar.steve = previousSha256;
    values.saveInputs();
    const evidence = values.promote();
    assert.notEqual(evidence.installations[0].candidateSha256, previousSha256);
    const nextItems = JSON.parse(
      readFileSync(
        path.join(values.workspaceRoot, values.itemManifestPath),
        "utf8",
      ),
    );
    assert.equal(
      nextItems[0].equippedModelSha256ByAvatar.steve,
      sha256(exactBytes),
    );
    const destination = readFileSync(
      path.join(
        values.workspaceRoot,
        evidence.installations[0].destinationPath,
      ),
    );
    assert.deepEqual(destination, exactBytes);
    assert.deepEqual(
      destination.subarray(20 + jsonLength),
      priorBytes.subarray(24 + jsonLength),
    );
    assert.deepEqual(readFileSync(assetFile), priorBytes);
  } finally {
    rmSync(values.workspaceRoot, { recursive: true, force: true });
  }
});

test("wrong-avatar review cannot approve an override even when every asset hash is present", () => {
  const values = overridePromotionFixture();
  try {
    const reportFile = path.join(values.workspaceRoot, REPORT_PATH);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    report.avatarAsset = "avatars/duel-candidates/duel-kaykit-knight.vrm";
    writeFileSync(reportFile, JSON.stringify(report));
    const before = readFileSync(
      path.join(values.workspaceRoot, values.itemManifestPath),
    );
    assert.throws(() => values.promote(), /not clean locked WebGPU evidence/u);
    assert.deepEqual(
      readFileSync(path.join(values.workspaceRoot, values.itemManifestPath)),
      before,
    );
  } finally {
    rmSync(values.workspaceRoot, { recursive: true, force: true });
  }
});

test("three-role override activation is all-or-nothing when the final review fails", () => {
  const values = overridePromotionFixture([
    "bronze_shortsword",
    "shortbow",
    "staff_of_air",
  ]);
  try {
    const itemPath = path.join(values.workspaceRoot, values.itemManifestPath);
    const before = readFileSync(itemPath);
    const reportFile = path.join(
      values.workspaceRoot,
      `${EVIDENCE_ROOT}/staff-of-air-motion-report.json`,
    );
    const reportBytes = readFileSync(reportFile);
    const report = JSON.parse(reportBytes.toString("utf8"));
    report.motions[0].equipment.gripZoneContacts[0].intersects = false;
    writeFileSync(reportFile, JSON.stringify(report));
    assert.throws(
      () => values.promote(),
      /misses the authored primary handle zone/u,
    );
    assert.deepEqual(readFileSync(itemPath), before);
    for (const certification of values.certificationManifest.certifications) {
      const contentAddressed = certification.path.replace(
        /\.glb$/u,
        `.${certification.sha256}.glb`,
      );
      assert.equal(
        existsSync(path.join(values.workspaceRoot, contentAddressed)),
        false,
      );
    }
    writeFileSync(reportFile, reportBytes);
    const result = values.promote();
    assert.equal(result.installations.length, 3);
    assert.equal(result.reviews.length, 6);
    const nextItems = JSON.parse(readFileSync(itemPath, "utf8"));
    for (const [index, item] of nextItems.entries()) {
      assert.equal(
        item.equippedModelPath,
        values.itemManifest[index].equippedModelPath,
      );
      assert.equal(
        item.equippedModelSha256,
        values.itemManifest[index].equippedModelSha256,
      );
      assert.equal(
        item.equippedModelSha256ByAvatar.steve,
        result.installations[index].candidateSha256,
      );
      assert.ok(
        item.equippedModelPathsByAvatar.steve.endsWith(
          `.${result.installations[index].candidateSha256}.glb`,
        ),
      );
    }
  } finally {
    rmSync(values.workspaceRoot, { recursive: true, force: true });
  }
});

test("immutable destination collision and pending activation lock fail closed", () => {
  for (const kind of ["collision", "lock", "evidence-write-failure"]) {
    const values = overridePromotionFixture();
    try {
      const certification = values.certificationManifest.certifications[0];
      const destination = path.join(
        values.workspaceRoot,
        certification.path.replace(/\.glb$/u, `.${certification.sha256}.glb`),
      );
      const itemPath = path.join(values.workspaceRoot, values.itemManifestPath);
      if (kind === "collision")
        writeFileSync(destination, "occupied immutable path");
      if (kind === "lock")
        writeFileSync(
          `${itemPath}.avatar-promotion-lock`,
          "another operation owns this lock",
        );
      if (kind === "evidence-write-failure")
        mkdirSync(path.join(values.workspaceRoot, values.evidencePath));
      const before = readFileSync(itemPath);
      assert.throws(
        () => values.promote(),
        kind === "collision"
          ? /already contains different bytes/u
          : kind === "lock"
            ? /EEXIST/u
            : /EISDIR/u,
      );
      assert.deepEqual(readFileSync(itemPath), before);
      if (kind === "collision")
        assert.equal(
          readFileSync(destination, "utf8"),
          "occupied immutable path",
        );
      if (kind === "lock")
        assert.equal(
          readFileSync(`${itemPath}.avatar-promotion-lock`, "utf8"),
          "another operation owns this lock",
        );
      if (kind === "evidence-write-failure") {
        assert.equal(existsSync(`${itemPath}.avatar-promotion-lock`), false);
        assert.equal(sha256(readFileSync(destination)), certification.sha256);
      }
    } finally {
      rmSync(values.workspaceRoot, { recursive: true, force: true });
    }
  }
});
