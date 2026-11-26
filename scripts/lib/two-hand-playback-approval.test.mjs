import assert from "node:assert/strict";
import test from "node:test";

import { resolveTwoHandPlaybackActivation } from "./two-hand-playback-approval.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const INPUTS = {
  "avatars/steve.vrm": A,
  "models/sword.glb": B,
  "emotes/idle.glb": C,
};
const APPROVAL = {
  schemaVersion: 1,
  decision: "approved",
  reviewerId: "launch-owner",
  reviewedAt: "2026-08-25T12:00:00.000Z",
  inputSha256: INPUTS,
  evidence: [
    { kind: "report", path: "artifacts/review.json", sha256: D },
    {
      kind: "contact-sheet",
      path: "artifacts/review.png",
      sha256: E,
    },
  ],
};
const COMMON = {
  approvalRecordPath: "reviews/two-hand.json",
  approvalRecordSha256: "f".repeat(64),
  expectedInputs: INPUTS,
  evidenceSha256: {
    "artifacts/review.json": D,
    "artifacts/review.png": E,
  },
  now: new Date("2026-08-25T12:05:00.000Z"),
};

test("keeps candidate and unapproved runtime captures inactive", () => {
  assert.deepEqual(
    resolveTwoHandPlaybackActivation({
      ...COMMON,
      canonical: false,
      approvalRecord: null,
    }),
    {
      activationStatus: "isolated-candidate",
      approvedForRuntimeActivation: false,
      productApproval: null,
    },
  );
  assert.deepEqual(
    resolveTwoHandPlaybackActivation({
      ...COMMON,
      canonical: true,
      approvalRecord: null,
    }),
    {
      activationStatus: "runtime-under-review",
      approvedForRuntimeActivation: false,
      productApproval: null,
    },
  );
});

test("accepts a separate exact-input and exact-evidence product approval", () => {
  const result = resolveTwoHandPlaybackActivation({
    ...COMMON,
    canonical: true,
    approvalRecord: APPROVAL,
  });
  assert.equal(result.activationStatus, "reviewed-production");
  assert.equal(result.approvedForRuntimeActivation, true);
  assert.equal(result.productApproval.reviewerId, "launch-owner");
  assert.deepEqual(result.productApproval.evidence, APPROVAL.evidence);
});

test("rejects approvals on noncanonical candidates", () => {
  assert.throws(
    () =>
      resolveTwoHandPlaybackActivation({
        ...COMMON,
        canonical: false,
        approvalRecord: APPROVAL,
      }),
    /candidate playback cannot consume/u,
  );
});

test("rejects input, evidence, schema, and timestamp drift", () => {
  const cases = [
    {
      approvalRecord: {
        ...APPROVAL,
        inputSha256: { ...INPUTS, "models/sword.glb": C },
      },
      error: /input drifted/u,
    },
    {
      approvalRecord: APPROVAL,
      evidenceSha256: { ...COMMON.evidenceSha256, "artifacts/review.png": D },
      error: /evidence drifted/u,
    },
    {
      approvalRecord: { ...APPROVAL, unexpected: true },
      error: /record is malformed/u,
    },
    {
      approvalRecord: {
        ...APPROVAL,
        reviewedAt: "2026-08-25T12:11:00.000Z",
      },
      error: /timestamp is invalid/u,
    },
  ];
  for (const scenario of cases) {
    assert.throws(
      () =>
        resolveTwoHandPlaybackActivation({
          ...COMMON,
          canonical: true,
          ...scenario,
        }),
      scenario.error,
    );
  }
});
