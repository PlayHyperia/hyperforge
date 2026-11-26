const MOTION_ID = /^[a-z0-9-]+$/u;
const HIT_REACTION_DURATION_SECONDS = 0.28;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validHitReaction(hitReaction) {
  if (hitReaction === undefined) return true;
  return (
    isRecord(hitReaction) &&
    Number.isFinite(hitReaction.intensity) &&
    hitReaction.intensity > 0 &&
    hitReaction.intensity <= 1.25 &&
    (hitReaction.side === -1 || hitReaction.side === 1) &&
    Number.isFinite(hitReaction.elapsedSeconds) &&
    hitReaction.elapsedSeconds > 0 &&
    hitReaction.elapsedSeconds < HIT_REACTION_DURATION_SECONDS
  );
}

function validEquipmentClearance(equipmentClearance) {
  if (equipmentClearance === undefined) return true;
  if (!isRecord(equipmentClearance)) return false;
  const keys = Object.keys(equipmentClearance);
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        key !== "minimumFloorClearanceMetres" &&
        key !== "minimumBodySurfaceDistanceMetres" &&
        key !== "maximumProjectedBodyOverlapRatio",
    )
  ) {
    return false;
  }
  const {
    minimumFloorClearanceMetres,
    minimumBodySurfaceDistanceMetres,
    maximumProjectedBodyOverlapRatio,
  } = equipmentClearance;
  return (
    (minimumFloorClearanceMetres === undefined ||
      (Number.isFinite(minimumFloorClearanceMetres) &&
        minimumFloorClearanceMetres >= 0 &&
        minimumFloorClearanceMetres <= 1)) &&
    (minimumBodySurfaceDistanceMetres === undefined ||
      (Number.isFinite(minimumBodySurfaceDistanceMetres) &&
        minimumBodySurfaceDistanceMetres >= 0 &&
        minimumBodySurfaceDistanceMetres <= 0.5)) &&
    (maximumProjectedBodyOverlapRatio === undefined ||
      (Number.isFinite(maximumProjectedBodyOverlapRatio) &&
        maximumProjectedBodyOverlapRatio >= 0 &&
        maximumProjectedBodyOverlapRatio <= 1))
  );
}

function validAvatarGrounding(avatarGrounding) {
  if (avatarGrounding === undefined) return true;
  if (!isRecord(avatarGrounding)) return false;
  const keys = Object.keys(avatarGrounding);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) => key !== "minimumBoundsYMetres" && key !== "maximumBoundsYMetres",
    )
  ) {
    return false;
  }
  const { minimumBoundsYMetres, maximumBoundsYMetres } = avatarGrounding;
  return (
    Number.isFinite(minimumBoundsYMetres) &&
    Number.isFinite(maximumBoundsYMetres) &&
    minimumBoundsYMetres >= -1 &&
    maximumBoundsYMetres <= 1 &&
    minimumBoundsYMetres <= maximumBoundsYMetres
  );
}

export function validateDuelAvatarMotionDefinition(motion) {
  return (
    isRecord(motion) &&
    typeof motion.id === "string" &&
    MOTION_ID.test(motion.id) &&
    typeof motion.name === "string" &&
    motion.name.length > 0 &&
    typeof motion.asset === "string" &&
    motion.asset.length > 0 &&
    Number.isFinite(motion.sampleRatio) &&
    motion.sampleRatio >= 0 &&
    motion.sampleRatio <= 1 &&
    (motion.cameraYawDegrees === undefined ||
      (Number.isFinite(motion.cameraYawDegrees) &&
        Math.abs(motion.cameraYawDegrees) <= 180)) &&
    (motion.cameraPitchDegrees === undefined ||
      (Number.isFinite(motion.cameraPitchDegrees) &&
        Math.abs(motion.cameraPitchDegrees) <= 60)) &&
    (motion.cameraTarget === undefined ||
      motion.cameraTarget === "primary-grip") &&
    (motion.heldEquipmentEmote === undefined ||
      (typeof motion.heldEquipmentEmote === "string" &&
        MOTION_ID.test(motion.heldEquipmentEmote))) &&
    (motion.waterContact === undefined ||
      motion.waterContact === "clear" ||
      motion.waterContact === "contact") &&
    validAvatarGrounding(motion.avatarGrounding) &&
    validEquipmentClearance(motion.equipmentClearance) &&
    validHitReaction(motion.hitReaction)
  );
}
