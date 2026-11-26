const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9_]+$/u;
const EXPECTED_ITEMS = Object.freeze([
  Object.freeze({
    itemId: "small_fishing_net",
    releaseDelaySeconds: 0.18,
    releaseArcHeightMetres: 0.35,
  }),
  Object.freeze({
    itemId: "lobster_pot",
    releaseDelaySeconds: 0.48,
    releaseArcHeightMetres: 0.06,
  }),
]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSafeWorkspacePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("../") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function isFiniteVector3(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => Number.isFinite(entry) && Math.abs(entry) <= 10)
  );
}

export function validateFishingWorldPresentationAuditManifest(manifest) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.exportedAt)) ||
    typeof manifest.title !== "string" ||
    manifest.title.trim().length < 10 ||
    !isRecord(manifest.avatar) ||
    manifest.avatar.id !== "steve" ||
    !isSafeWorkspacePath(manifest.avatar.asset) ||
    !SHA256.test(manifest.avatar.sha256) ||
    !isRecord(manifest.idleMotion) ||
    !isSafeWorkspacePath(manifest.idleMotion.asset) ||
    !SHA256.test(manifest.idleMotion.sha256) ||
    !isRecord(manifest.retrievalMotion) ||
    !isSafeWorkspacePath(manifest.retrievalMotion.asset) ||
    !SHA256.test(manifest.retrievalMotion.sha256) ||
    manifest.retrievalMotion.asset === manifest.idleMotion.asset ||
    !Array.isArray(manifest.items) ||
    manifest.items.length !== EXPECTED_ITEMS.length ||
    manifest.retrievalPickupDelaySeconds !== 0.42 ||
    !isRecord(manifest.pose) ||
    manifest.pose.minimumHeldArmDeviationDegrees !== 5 ||
    manifest.pose.minimumActionArmDeviationDegrees !== 12 ||
    !isRecord(manifest.performance) ||
    !Number.isSafeInteger(manifest.performance.iterations) ||
    manifest.performance.iterations < 120 ||
    manifest.performance.iterations > 2_000 ||
    !Number.isFinite(manifest.performance.maximumP95FrameWorkMs) ||
    manifest.performance.maximumP95FrameWorkMs <= 0 ||
    manifest.performance.maximumP95FrameWorkMs > 20 ||
    !Number.isFinite(manifest.performance.maximumSingleFrameWorkMs) ||
    manifest.performance.maximumSingleFrameWorkMs <
      manifest.performance.maximumP95FrameWorkMs ||
    manifest.performance.maximumSingleFrameWorkMs > 100
  ) {
    throw new Error("Fishing world-presentation audit manifest is invalid");
  }

  const paths = new Set([
    manifest.avatar.asset,
    manifest.idleMotion.asset,
    manifest.retrievalMotion.asset,
  ]);
  for (const [index, expected] of EXPECTED_ITEMS.entries()) {
    const item = manifest.items[index];
    if (
      !isRecord(item) ||
      !SAFE_ID.test(item.itemId) ||
      item.itemId !== expected.itemId ||
      !isSafeWorkspacePath(item.heldAsset) ||
      !SHA256.test(item.heldSha256) ||
      !isSafeWorkspacePath(item.worldAsset) ||
      !SHA256.test(item.worldSha256) ||
      !isSafeWorkspacePath(item.deployMotionAsset) ||
      !SHA256.test(item.deployMotionSha256) ||
      item.heldAsset === item.worldAsset ||
      paths.has(item.heldAsset) ||
      paths.has(item.worldAsset) ||
      paths.has(item.deployMotionAsset) ||
      !isFiniteVector3(item.avatarPosition) ||
      !isFiniteVector3(item.targetPosition) ||
      item.releaseDelaySeconds !== expected.releaseDelaySeconds ||
      item.releaseArcHeightMetres !== expected.releaseArcHeightMetres
    ) {
      throw new Error(
        `Fishing world-presentation item ${expected.itemId} is invalid`,
      );
    }
    paths.add(item.heldAsset);
    paths.add(item.worldAsset);
    paths.add(item.deployMotionAsset);
  }

  return manifest;
}
