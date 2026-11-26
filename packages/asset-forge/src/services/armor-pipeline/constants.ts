import type { EquipmentSlotName, BulkClass, AttachmentSlotDef } from "./types";
import { AVATAR_OPTIONS as GAME_AVATAR_OPTIONS } from "@hyperforge/shared";

/**
 * Use the game's exact active avatar registry. A private legacy list allowed
 * Asset Forge to certify equipment against avatars that the duel client no
 * longer used.
 */
export const AVATAR_OPTIONS: { id: string; label: string; url: string }[] =
  GAME_AVATAR_OPTIONS.map((avatar) => ({
    id: avatar.id,
    label: avatar.name,
    url: avatar.url.replace("asset://", "/game-assets/"),
  }));

export const ALL_SLOTS: EquipmentSlotName[] = [
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
];
export const ALL_BULKS: BulkClass[] = ["skin", "cloth", "leather", "plate"];

export const SLOT_LABELS: Record<EquipmentSlotName, string> = {
  helmet: "Helmet",
  body: "Body",
  legs: "Legs",
  boots: "Boots",
  gloves: "Gloves",
};

/** Mixamo animation URLs for armor preview */
export const ANIMATION_URLS = {
  walking: "/rigs/animations/walking.glb",
  running: "/rigs/animations/running.glb",
} as const;

/** Predefined 3D attachment points on the avatar skeleton.
 *  Each maps to a VRM humanoid bone with default positioning. */
export const ATTACHMENT_SLOTS: AttachmentSlotDef[] = [
  {
    id: "left_pauldron",
    label: "Left Pauldron",
    boneName: "leftUpperArm",
    defaultOffset: { x: 0, y: 0.05, z: 0 },
    defaultScale: 0.15,
    promptSuggestion:
      "ornate metal shoulder pauldron armor piece, single piece, fantasy RPG style, game asset",
  },
  {
    id: "right_pauldron",
    label: "Right Pauldron",
    boneName: "rightUpperArm",
    defaultOffset: { x: 0, y: 0.05, z: 0 },
    defaultScale: 0.15,
    promptSuggestion:
      "ornate metal shoulder pauldron armor piece, single piece, fantasy RPG style, game asset",
  },
  {
    id: "chest_emblem",
    label: "Chest Emblem",
    boneName: "upperChest",
    defaultOffset: { x: 0, y: 0, z: 0.08 },
    defaultScale: 0.1,
    promptSuggestion:
      "medieval chest emblem crest, ornate metal medallion, fantasy RPG, game asset",
  },
  {
    id: "back_piece",
    label: "Back Piece",
    boneName: "upperChest",
    defaultOffset: { x: 0, y: 0.05, z: -0.1 },
    defaultScale: 0.2,
    promptSuggestion:
      "back cape attachment plate, ornamental wings or shield mount, fantasy RPG, game asset",
  },
  {
    id: "belt_buckle",
    label: "Belt Buckle",
    boneName: "hips",
    defaultOffset: { x: 0, y: 0.02, z: 0.08 },
    defaultScale: 0.08,
    promptSuggestion:
      "ornate belt buckle with pouches, medieval fantasy, game asset",
  },
  {
    id: "left_knee",
    label: "Left Knee Guard",
    boneName: "leftLowerLeg",
    defaultOffset: { x: 0, y: 0.08, z: 0.04 },
    defaultScale: 0.08,
    promptSuggestion:
      "metal knee guard armor piece, single piece, fantasy RPG style, game asset",
  },
  {
    id: "right_knee",
    label: "Right Knee Guard",
    boneName: "rightLowerLeg",
    defaultOffset: { x: 0, y: 0.08, z: 0.04 },
    defaultScale: 0.08,
    promptSuggestion:
      "metal knee guard armor piece, single piece, fantasy RPG style, game asset",
  },
  {
    id: "helmet_crest",
    label: "Helmet Crest",
    boneName: "head",
    defaultOffset: { x: 0, y: 0.15, z: 0 },
    defaultScale: 0.15,
    promptSuggestion:
      "helmet crest plume or horns, ornamental headpiece, fantasy RPG, game asset",
  },
  {
    id: "left_gauntlet",
    label: "Left Gauntlet",
    boneName: "leftHand",
    defaultOffset: { x: 0, y: 0, z: 0 },
    defaultScale: 0.08,
    promptSuggestion:
      "armored gauntlet, metal hand armor with knuckle plates, fantasy RPG, game asset",
  },
  {
    id: "right_gauntlet",
    label: "Right Gauntlet",
    boneName: "rightHand",
    defaultOffset: { x: 0, y: 0, z: 0 },
    defaultScale: 0.08,
    promptSuggestion:
      "armored gauntlet, metal hand armor with knuckle plates, fantasy RPG, game asset",
  },
];

/** classic fantasy MMORPG-style material tier definitions */
export interface MaterialTier {
  id: string;
  label: string;
  color: string; // hex for UI badge
  prompt: string;
  style: string;
}

/** Shape-override prefix for tier prompts — must come FIRST to override body-shape recognition */
export const TIER_SHAPE_PREFIX =
  "medieval plate armor, hard metallic surface, not skin, not clothing, not a body";

/** Style suffix for tier prompts — clean armor look */
export const TIER_STYLE_SUFFIX =
  "solid uniform color, smooth polished metal, game-ready PBR texture";

export const MATERIAL_TIERS: MaterialTier[] = [
  {
    id: "bronze",
    label: "Bronze",
    color: "#cd7f32",
    prompt:
      "bronze metal armor plate, warm copper-gold #cd7f32 color, polished bronze surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "iron",
    label: "Iron",
    color: "#6b6b6b",
    prompt:
      "iron metal armor plate, dark grey #6b6b6b color, matte forged iron surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "steel",
    label: "Steel",
    color: "#b8b8b8",
    prompt:
      "steel metal armor plate, bright silver #b8b8b8 color, polished reflective steel surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "black",
    label: "Black",
    color: "#2a2a2a",
    prompt:
      "black metal armor plate, very dark #2a2a2a color, polished obsidian black surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "mithril",
    label: "Mithril",
    color: "#4a7ab5",
    prompt:
      "mithril metal armor plate, blue-steel #4a7ab5 color, gleaming blue-purple surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "adamant",
    label: "Adamant",
    color: "#2d6b3f",
    prompt:
      "adamantite metal armor plate, dark green #2d6b3f color, polished green surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "rune",
    label: "Rune",
    color: "#3db8c4",
    prompt:
      "runite metal armor plate, bright teal-cyan #3db8c4 color, polished cyan surface",
    style: TIER_STYLE_SUFFIX,
  },
  {
    id: "dragon",
    label: "Dragon",
    color: "#8b1a1a",
    prompt:
      "dragon metal armor plate, deep crimson #8b1a1a color, polished dark red surface",
    style: TIER_STYLE_SUFFIX,
  },
];

/**
 * Generate a placehold.co swatch URL for a given hex color.
 * These are public HTTP URLs that Meshy can fetch as style references.
 * Using 256x256 for better style influence.
 */
export function getTierSwatchUrl(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  return `https://placehold.co/256x256/${hex}/${hex}.png`;
}

/** Detail level controls how much ornamentation/design the AI adds to armor textures */
export interface DetailLevel {
  id: string;
  label: string;
  /** Appended to prompt to control detail amount */
  suffix: string;
  /** Short UI description */
  desc: string;
}

export const DETAIL_LEVELS: DetailLevel[] = [
  {
    id: "plain",
    label: "Plain",
    suffix:
      "completely smooth clean surface, no engravings, no ornaments, no patterns, no trim, flat uniform",
    desc: "Smooth solid metal, no ornamentation",
  },
  {
    id: "minimal",
    label: "Minimal",
    suffix:
      "mostly smooth surface, subtle edge bevels, very minimal trim lines",
    desc: "Subtle edge highlights only",
  },
  {
    id: "moderate",
    label: "Moderate",
    suffix:
      "some decorative trim along edges, light engravings, subtle raised border detail",
    desc: "Light engravings and trim",
  },
  {
    id: "ornate",
    label: "Ornate",
    suffix:
      "ornate engravings, decorative filigree trim, embossed patterns, raised border detail",
    desc: "Detailed engravings and patterns",
  },
  {
    id: "intricate",
    label: "Intricate",
    suffix:
      "highly detailed intricate filigree, elaborate ornamental engravings, jeweled accents, complex embossed relief patterns, gilded trim",
    desc: "Maximum detail — filigree, jewels, relief",
  },
];
