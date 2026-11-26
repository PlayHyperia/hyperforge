const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const COMPETITIVE_ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const RIG_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export const DEFORMING_ARMOR_SLOTS = new Set([
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
]);

export interface PublishedArmorDuelFit {
  schemaVersion: 1;
  itemId: string;
  slot: string;
  compatibleAvatarIds: string[];
  rigFingerprint: string;
}

export interface PublishedRigidEquipmentDuelFit {
  schemaVersion: 1;
  itemId: string;
  slot: "weapon" | "shield";
  compatibleAvatarIds: string[];
}

export class ArmorPublishValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArmorPublishValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseGlbJson(glb: Uint8Array): Record<string, unknown> {
  if (glb.byteLength < 20) {
    throw new ArmorPublishValidationError(
      "Published file is not a complete GLB",
    );
  }
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new ArmorPublishValidationError(
      "Published file has an invalid GLB header",
    );
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    throw new ArmorPublishValidationError("Only GLB version 2 is supported");
  }
  if (view.getUint32(8, true) !== glb.byteLength) {
    throw new ArmorPublishValidationError(
      "GLB declared length does not match its bytes",
    );
  }

  let offset = 12;
  while (offset + 8 <= glb.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > glb.byteLength) {
      throw new ArmorPublishValidationError("GLB contains a truncated chunk");
    }
    if (chunkType === JSON_CHUNK_TYPE) {
      try {
        const text = new TextDecoder()
          .decode(glb.subarray(chunkStart, chunkEnd))
          .replace(/[\u0000\u0020]+$/u, "");
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed)) throw new Error("JSON root is not an object");
        return parsed;
      } catch (error) {
        throw new ArmorPublishValidationError(
          `GLB JSON metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    offset = chunkEnd;
  }
  throw new ArmorPublishValidationError(
    "GLB is missing its JSON metadata chunk",
  );
}

function readHyperiaMetadata(
  container: unknown,
  location: string,
): Record<string, unknown> {
  if (!isRecord(container) || !isRecord(container.extras)) {
    throw new ArmorPublishValidationError(
      `GLB is missing Hyperia metadata on its ${location}`,
    );
  }
  const metadata = container.extras.hyperia;
  if (!isRecord(metadata)) {
    throw new ArmorPublishValidationError(
      `GLB is missing Hyperia metadata on its ${location}`,
    );
  }
  return metadata;
}

function readDuelFit(
  metadata: Record<string, unknown>,
  allowedSlots: ReadonlySet<string>,
  requireRigFingerprint: boolean,
): PublishedArmorDuelFit | PublishedRigidEquipmentDuelFit {
  const fit = metadata.duelFit;
  if (!isRecord(fit)) {
    throw new ArmorPublishValidationError(
      "GLB is missing competitive duel-fit metadata",
    );
  }
  const compatibleAvatarIds = fit.compatibleAvatarIds;
  if (
    fit.schemaVersion !== 1 ||
    typeof fit.itemId !== "string" ||
    fit.itemId !== fit.itemId.trim() ||
    !COMPETITIVE_ASSET_ID_PATTERN.test(fit.itemId) ||
    typeof fit.slot !== "string" ||
    !allowedSlots.has(fit.slot) ||
    !Array.isArray(compatibleAvatarIds) ||
    compatibleAvatarIds.length === 0 ||
    compatibleAvatarIds.some(
      (id) =>
        typeof id !== "string" ||
        id !== id.trim() ||
        !COMPETITIVE_ASSET_ID_PATTERN.test(id),
    ) ||
    new Set(compatibleAvatarIds).size !== compatibleAvatarIds.length ||
    (requireRigFingerprint &&
      (typeof fit.rigFingerprint !== "string" ||
        !RIG_FINGERPRINT_PATTERN.test(fit.rigFingerprint))) ||
    (!requireRigFingerprint && fit.rigFingerprint !== undefined)
  ) {
    throw new ArmorPublishValidationError(
      "GLB has invalid competitive duel-fit metadata",
    );
  }
  return fit as unknown as
    PublishedArmorDuelFit | PublishedRigidEquipmentDuelFit;
}

function readLoaderVisibleMetadata(glb: Uint8Array): {
  sceneMetadata: Record<string, unknown>;
  rootMetadata: Record<string, unknown>;
} {
  const json = parseGlbJson(glb);
  const scenes = json.scenes;
  const nodes = json.nodes;
  const sceneIndex = typeof json.scene === "number" ? json.scene : 0;
  if (!Array.isArray(scenes) || !Array.isArray(nodes)) {
    throw new ArmorPublishValidationError(
      "GLB is missing scene or node metadata",
    );
  }
  const scene = scenes[sceneIndex];
  if (
    !isRecord(scene) ||
    !Array.isArray(scene.nodes) ||
    scene.nodes.length === 0
  ) {
    throw new ArmorPublishValidationError("GLB has no export root node");
  }
  const rootNodeIndex = scene.nodes[0];
  const rootNode =
    typeof rootNodeIndex === "number" ? nodes[rootNodeIndex] : undefined;
  return {
    sceneMetadata: readHyperiaMetadata(scene, "scene"),
    rootMetadata: readHyperiaMetadata(rootNode, "first root node"),
  };
}

function assertFitAuthorityMatches(
  sceneFit: PublishedArmorDuelFit | PublishedRigidEquipmentDuelFit,
  rootFit: PublishedArmorDuelFit | PublishedRigidEquipmentDuelFit,
): void {
  if (JSON.stringify(sceneFit) !== JSON.stringify(rootFit)) {
    throw new ArmorPublishValidationError(
      "Scene and root-node competitive metadata do not agree",
    );
  }
}

/**
 * Verify the exact embedded metadata the game will use before any publish write.
 * The scene and its first root node must agree so loader behavior cannot select
 * two different competitive identities from the same file.
 */
export function validatePublishedArmorGlb(
  glb: Uint8Array,
  expected: { itemId: string; slot: string },
): PublishedArmorDuelFit {
  const { sceneMetadata, rootMetadata } = readLoaderVisibleMetadata(glb);
  const sceneFit = readDuelFit(
    sceneMetadata,
    DEFORMING_ARMOR_SLOTS,
    true,
  ) as PublishedArmorDuelFit;
  const rootFit = readDuelFit(
    rootMetadata,
    DEFORMING_ARMOR_SLOTS,
    true,
  ) as PublishedArmorDuelFit;
  assertFitAuthorityMatches(sceneFit, rootFit);
  if (sceneFit.itemId !== expected.itemId || sceneFit.slot !== expected.slot) {
    throw new ArmorPublishValidationError(
      "Embedded item identity does not match the publish request",
    );
  }
  if (
    sceneMetadata.version !== 2 ||
    sceneMetadata.originalSlot !== expected.slot ||
    rootMetadata.version !== 2 ||
    rootMetadata.originalSlot !== expected.slot
  ) {
    throw new ArmorPublishValidationError(
      "GLB has invalid fitted armor metadata",
    );
  }
  return sceneFit;
}

const RIGID_EQUIPMENT_SLOTS = new Set(["weapon", "shield"]);

export function validatePublishedRigidEquipmentGlb(
  glb: Uint8Array,
  expected: { itemId: string },
): PublishedRigidEquipmentDuelFit {
  const { sceneMetadata, rootMetadata } = readLoaderVisibleMetadata(glb);
  const sceneFit = readDuelFit(
    sceneMetadata,
    RIGID_EQUIPMENT_SLOTS,
    false,
  ) as PublishedRigidEquipmentDuelFit;
  const rootFit = readDuelFit(
    rootMetadata,
    RIGID_EQUIPMENT_SLOTS,
    false,
  ) as PublishedRigidEquipmentDuelFit;
  assertFitAuthorityMatches(sceneFit, rootFit);
  if (sceneFit.itemId !== expected.itemId) {
    throw new ArmorPublishValidationError(
      "Embedded item identity does not match the publish request",
    );
  }

  const allowedBones =
    sceneFit.slot === "shield"
      ? new Set(["leftHand"])
      : new Set(["leftHand", "rightHand"]);
  for (const metadata of [sceneMetadata, rootMetadata]) {
    const matrix = metadata.relativeMatrix;
    if (
      metadata.version !== 2 ||
      !allowedBones.has(String(metadata.vrmBoneName)) ||
      !Array.isArray(matrix) ||
      matrix.length !== 16 ||
      matrix.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw new ArmorPublishValidationError(
        "GLB has invalid rigid equipment attachment metadata",
      );
    }
  }
  return sceneFit;
}
