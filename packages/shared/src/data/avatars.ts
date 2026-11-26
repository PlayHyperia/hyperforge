/**
 * Avatar Definitions
 *
 * Defines available VRM avatar models for character creation.
 * These models are loaded from the asset server at runtime.
 *
 * ## LOD System
 * Avatars use a 3-tier LOD system for performance:
 * - LOD0 (url): 20K triangles maximum - close range gameplay
 * - LOD1 (lod1Url): 8K triangles maximum - medium distance
 * - LOD2 (lod2Url): 2K triangles - far distance / impostor base
 *
 * ## Texture Optimization
 * All avatar textures are optimized:
 * - Color/Diffuse: 2048px max
 * - Normal maps: 1024px max
 * - No metallic/roughness/AO textures (simplified PBR)
 */

export interface AvatarOption {
  id: string;
  name: string;
  /** LOD0 URL - Full detail (20K triangles maximum) */
  url: string;
  /** LOD1 URL - Medium detail (8K triangles maximum) */
  lod1Url?: string;
  /** LOD2 URL - Low detail (2K triangles) */
  lod2Url?: string;
  /** Path portion for character preview (prepend CDN URL) */
  previewPath: string;
  /** Exact humanoid bones available to the additive hit-reaction controller. */
  hitReactionBoneCount?: number;
  description?: string;
}

/** LOD level enum for avatar selection */
export enum AvatarLOD {
  /** Full detail - 20K triangles maximum (close range) */
  LOD0 = 0,
  /** Medium detail - 8K triangles maximum (medium distance) */
  LOD1 = 1,
  /** Low detail - 2K triangles (far distance) */
  LOD2 = 2,
}

/** Distance thresholds for LOD switching (in meters) */
export const AVATAR_LOD_DISTANCES = {
  /** Distance at which to switch from LOD0 to LOD1 */
  LOD0_TO_LOD1: 30,
  /** Distance at which to switch from LOD1 to LOD2 */
  LOD1_TO_LOD2: 60,
} as const;

/**
 * Fraction of an outward LOD threshold that must be crossed when returning to
 * a higher-detail avatar. This prevents camera jitter around 30 m or 60 m from
 * repeatedly replacing the active VRM.
 */
export const AVATAR_LOD_RETURN_THRESHOLD_RATIO = 0.9;

/**
 * Available avatar models
 *
 * - `url`: LOD0 (20K triangles maximum) - Uses asset:// protocol resolved by ClientLoader
 * - `lod1Url`: LOD1 (8K triangles maximum) - Medium distance
 * - `lod2Url`: LOD2 (2K triangles) - Far distance
 * - `previewPath`: Path portion for CharacterPreview component (CDN URL prepended at runtime)
 *
 * Triangle counts (optimized):
 * - LOD0: at most 20K triangles (main gameplay)
 * - LOD1: at most 8K triangles (medium distance)
 * - LOD2: ~2K triangles (far distance / impostor)
 */
export const AVATAR_OPTIONS: AvatarOption[] = [
  {
    id: "bandit",
    name: "Bandit",
    url: "asset://avatars/duel-candidates/duel-bandit.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-bandit_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-bandit_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-bandit.vrm",
    description: "Agile skirmisher",
  },
  {
    id: "barbarian",
    name: "Barbarian",
    url: "asset://avatars/duel-candidates/duel-barbarian.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-barbarian_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-barbarian_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-barbarian.vrm",
    description: "Armored power fighter",
  },
  {
    id: "dark-ranger",
    name: "Dark Ranger",
    url: "asset://avatars/duel-candidates/duel-dark-ranger.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-dark-ranger_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-dark-ranger_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-dark-ranger.vrm",
    description: "Ranged specialist",
  },
  {
    id: "dark-wizard",
    name: "Dark Wizard",
    url: "asset://avatars/duel-candidates/duel-dark-wizard.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-dark-wizard_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-dark-wizard_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-dark-wizard.vrm",
    description: "Magic specialist",
  },
  {
    id: "steve",
    name: "Steve",
    url: "asset://avatars/duel-candidates/duel-steve.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-steve_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-steve_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-steve.vrm",
    description: "Canonical launch duel rig",
  },
  {
    id: "kaykit-knight",
    name: "KayKit Knight",
    url: "asset://avatars/duel-candidates/duel-kaykit-knight.vrm",
    lod1Url: "asset://avatars/duel-candidates/duel-kaykit-knight_lod1.vrm",
    lod2Url: "asset://avatars/duel-candidates/duel-kaykit-knight_lod2.vrm",
    previewPath: "/avatars/duel-candidates/duel-kaykit-knight.vrm",
    hitReactionBoneCount: 3,
    description: "Vetted CC0 diagnostic duel candidate",
  },
];

export const DEFAULT_AVATAR_URL = AVATAR_OPTIONS[0].url;
/** Local no-money asset tests only; never offer these in character selection. */
export const DIAGNOSTIC_AVATAR_OPTIONS: readonly AvatarOption[] = [
  {
    id: "authored-body38-light01-test",
    name: "Light-skin authored avatar — calibrated arm rest test",
    url: "asset://avatars/asset-studio-test/authored-body38-light01-test.vrm",
    previewPath: "/avatars/asset-studio-test/authored-body38-light01-test.vrm",
    description:
      "Original body38 rig/shape with light-skin reference and opt-in arm retargeting; full fit/LOD approval pending",
  },
  {
    id: "authored-body15-test",
    name: "Authored avatar — provisional asset test",
    url: "asset://avatars/asset-studio-test/authored-body15-test.vrm",
    previewPath: "/avatars/asset-studio-test/authored-body15-test.vrm",
    description: "Body15 integration checkpoint; grip and LODs unapproved",
  },
  {
    id: "authored-body38-test",
    name: "Authored avatar with eyes and clothing — provisional asset test",
    url: "asset://avatars/asset-studio-test/authored-body38-test.vrm",
    previewPath: "/avatars/asset-studio-test/authored-body38-test.vrm",
    description:
      "Preserved body38 with eye04 and shorts02; grip and LODs unapproved",
  },
];

export const CANONICAL_DUEL_AVATAR_ID = "steve";
export const CANONICAL_DUEL_AVATAR_URL =
  AVATAR_OPTIONS.find((avatar) => avatar.id === CANONICAL_DUEL_AVATAR_ID)
    ?.url ?? DEFAULT_AVATAR_URL;

export type DuelAvatarStyle = "auto" | "melee" | "ranged" | "mage" | "prayer";

const DUEL_AVATAR_IDS_BY_STYLE: Record<DuelAvatarStyle, readonly string[]> = {
  auto: ["bandit", "barbarian", "dark-ranger", "dark-wizard"],
  melee: ["barbarian", "bandit"],
  ranged: ["dark-ranger", "bandit"],
  mage: ["dark-wizard", "bandit"],
  prayer: ["dark-wizard", "barbarian"],
};

/** Return a stable fighter avatar for a scripted combat style. */
export function getDuelAvatarUrlForStyle(
  style: DuelAvatarStyle,
  rosterIndex = 0,
): string {
  const ids = DUEL_AVATAR_IDS_BY_STYLE[style];
  const index =
    ((Math.trunc(rosterIndex) % ids.length) + ids.length) % ids.length;
  return getAvatarById(ids[index])?.url ?? DEFAULT_AVATAR_URL;
}

/**
 * Get avatar by ID
 */
export function getAvatarById(id: string): AvatarOption | undefined {
  return AVATAR_OPTIONS.find((avatar) => avatar.id === id);
}

/**
 * Get avatar by URL (checks url, lod1Url, lod2Url, and previewPath)
 */
export function getAvatarByUrl(url: string): AvatarOption | undefined {
  return [...AVATAR_OPTIONS, ...DIAGNOSTIC_AVATAR_OPTIONS].find(
    (avatar) =>
      avatar.url === url ||
      avatar.lod1Url === url ||
      avatar.lod2Url === url ||
      url.endsWith(avatar.previewPath),
  );
}

/**
 * Get the appropriate LOD level based on distance
 * @param distance Distance from camera in meters
 * @returns LOD level (0, 1, or 2)
 */
export function getAvatarLODForDistance(distance: number): AvatarLOD {
  if (distance >= AVATAR_LOD_DISTANCES.LOD1_TO_LOD2) {
    return AvatarLOD.LOD2;
  }
  if (distance >= AVATAR_LOD_DISTANCES.LOD0_TO_LOD1) {
    return AvatarLOD.LOD1;
  }
  return AvatarLOD.LOD0;
}

/**
 * Resolve avatar LOD with asymmetric return thresholds.
 *
 * Moving away uses the declared 30 m / 60 m thresholds. Moving closer keeps
 * the current lower-detail LOD until the camera crosses 90% of the boundary,
 * eliminating rapid swaps when a spectator camera rests on the threshold.
 */
export function getAvatarLODForDistanceWithHysteresis(
  distance: number,
  currentLOD: AvatarLOD,
): AvatarLOD {
  if (Number.isNaN(distance)) return currentLOD;
  const safeDistance = Math.max(0, distance);
  const lod1ReturnDistance =
    AVATAR_LOD_DISTANCES.LOD0_TO_LOD1 * AVATAR_LOD_RETURN_THRESHOLD_RATIO;
  const lod2ReturnDistance =
    AVATAR_LOD_DISTANCES.LOD1_TO_LOD2 * AVATAR_LOD_RETURN_THRESHOLD_RATIO;

  if (currentLOD === AvatarLOD.LOD2) {
    if (safeDistance >= lod2ReturnDistance) return AvatarLOD.LOD2;
    return safeDistance >= AVATAR_LOD_DISTANCES.LOD0_TO_LOD1
      ? AvatarLOD.LOD1
      : AvatarLOD.LOD0;
  }

  if (currentLOD === AvatarLOD.LOD1) {
    if (safeDistance >= AVATAR_LOD_DISTANCES.LOD1_TO_LOD2) {
      return AvatarLOD.LOD2;
    }
    return safeDistance >= lod1ReturnDistance ? AvatarLOD.LOD1 : AvatarLOD.LOD0;
  }

  return getAvatarLODForDistance(safeDistance);
}

/**
 * Get the URL for a specific LOD level of an avatar
 * Falls back to higher detail LOD if requested LOD is not available
 *
 * @param avatar The avatar option
 * @param lod The desired LOD level
 * @returns The URL for the requested LOD (or fallback)
 */
export function getAvatarUrlForLOD(
  avatar: AvatarOption,
  lod: AvatarLOD,
): string {
  switch (lod) {
    case AvatarLOD.LOD2:
      return avatar.lod2Url ?? avatar.lod1Url ?? avatar.url;
    case AvatarLOD.LOD1:
      return avatar.lod1Url ?? avatar.url;
    case AvatarLOD.LOD0:
    default:
      return avatar.url;
  }
}

/** Return the declared LOD represented by an exact avatar URL. */
export function getAvatarLODForUrl(
  avatar: AvatarOption,
  url: string,
): AvatarLOD {
  if (avatar.lod2Url === url) return AvatarLOD.LOD2;
  if (avatar.lod1Url === url) return AvatarLOD.LOD1;
  return AvatarLOD.LOD0;
}

/**
 * Get all LOD URLs for an avatar (for preloading)
 * @param avatar The avatar option
 * @returns Array of all available LOD URLs
 */
export function getAllAvatarLODUrls(avatar: AvatarOption): string[] {
  const urls = [avatar.url];
  if (avatar.lod1Url) urls.push(avatar.lod1Url);
  if (avatar.lod2Url) urls.push(avatar.lod2Url);
  return urls;
}
