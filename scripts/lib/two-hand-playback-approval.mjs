const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$/u;
const REVIEWED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validEvidenceEntry(entry, kind) {
  return (
    hasExactKeys(entry, ["kind", "path", "sha256"]) &&
    entry.kind === kind &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    SHA256.test(entry.sha256)
  );
}

/**
 * A runtime selection is not a product approval. Approval must be a separate,
 * hash-locked decision covering the exact inputs and previously rendered
 * evidence. This keeps a successful technical capture from certifying itself.
 */
export function resolveTwoHandPlaybackActivation({
  canonical,
  approvalRecord = null,
  approvalRecordPath = null,
  approvalRecordSha256 = null,
  expectedInputs,
  evidenceSha256 = {},
  now = new Date(),
}) {
  if (typeof canonical !== "boolean") {
    throw new Error("canonical must be boolean");
  }
  if (!isRecord(expectedInputs) || Object.keys(expectedInputs).length < 3) {
    throw new Error("expectedInputs must contain the exact playback inputs");
  }
  if (
    Object.entries(expectedInputs).some(
      ([asset, hash]) =>
        typeof asset !== "string" || asset.length === 0 || !SHA256.test(hash),
    )
  ) {
    throw new Error("expectedInputs contains an invalid asset or SHA-256");
  }
  if (!canonical) {
    if (approvalRecord !== null) {
      throw new Error(
        "candidate playback cannot consume a production approval",
      );
    }
    return {
      activationStatus: "isolated-candidate",
      approvedForRuntimeActivation: false,
      productApproval: null,
    };
  }
  if (approvalRecord === null) {
    return {
      activationStatus: "runtime-under-review",
      approvedForRuntimeActivation: false,
      productApproval: null,
    };
  }
  if (
    !hasExactKeys(approvalRecord, [
      "schemaVersion",
      "decision",
      "reviewerId",
      "reviewedAt",
      "inputSha256",
      "evidence",
    ]) ||
    approvalRecord.schemaVersion !== 1 ||
    approvalRecord.decision !== "approved" ||
    !REVIEWER_ID.test(approvalRecord.reviewerId) ||
    !REVIEWED_AT.test(approvalRecord.reviewedAt) ||
    !hasExactKeys(approvalRecord.inputSha256, Object.keys(expectedInputs)) ||
    !Array.isArray(approvalRecord.evidence) ||
    approvalRecord.evidence.length !== 2 ||
    !validEvidenceEntry(approvalRecord.evidence[0], "report") ||
    !validEvidenceEntry(approvalRecord.evidence[1], "contact-sheet") ||
    typeof approvalRecordPath !== "string" ||
    approvalRecordPath.length === 0 ||
    !SHA256.test(approvalRecordSha256 ?? "")
  ) {
    throw new Error("two-hand product approval record is malformed");
  }
  const reviewedAt = Date.parse(approvalRecord.reviewedAt);
  if (
    !Number.isFinite(reviewedAt) ||
    reviewedAt > now.getTime() + 5 * 60 * 1_000
  ) {
    throw new Error("two-hand product approval timestamp is invalid");
  }
  for (const [asset, expectedHash] of Object.entries(expectedInputs)) {
    if (approvalRecord.inputSha256[asset] !== expectedHash) {
      throw new Error(`two-hand product approval input drifted: ${asset}`);
    }
  }
  for (const evidence of approvalRecord.evidence) {
    if (evidenceSha256[evidence.path] !== evidence.sha256) {
      throw new Error(
        `two-hand product approval evidence drifted: ${evidence.path}`,
      );
    }
  }
  return {
    activationStatus: "reviewed-production",
    approvedForRuntimeActivation: true,
    productApproval: {
      reviewerId: approvalRecord.reviewerId,
      reviewedAt: approvalRecord.reviewedAt,
      record: {
        path: approvalRecordPath,
        sha256: approvalRecordSha256,
      },
      evidence: approvalRecord.evidence,
    },
  };
}
