/**
 * playerEmotes.ts - Player Animation Asset URLs
 *
 * Centralized list of animation asset URLs for player characters.
 * These Mixamo-compatible animations are applied to VRM avatars.
 *
 * Animation Files:
 * - All animations are GLB files containing skeletal animations
 * - Located in /assets/emotes/ directory
 * - Query parameter `?s=1.5` sets playback speed (1.5x faster)
 *
 * Usage:
 * - PlayerLocal and PlayerRemote use these for character animation
 * - Avatar system retargets animations to VRM skeleton
 * - Emotes are applied via avatar.setEmote(Emotes.WALK)
 *
 * Referenced by: PlayerLocal, PlayerRemote, Avatar node
 */

/**
 * Player Animation URLs
 *
 * Standard animations for player characters.
 * URLs are resolved via world.resolveURL() to CDN or local paths.
 */
export const Emotes = {
  /** Standing idle animation */
  IDLE: "asset://emotes/emote-idle.glb",

  /** Walking animation (1.5x speed for responsiveness) */
  WALK: "asset://emotes/emote-walk.glb?s=1.3",

  /** Running animation (1.65x speed - 10% faster to match movement) */
  RUN: "asset://emotes/emote-run.glb?s=1.4",

  /** Natural asymmetric carry used by fitted bows during streamed duels */
  BOW_DUEL_IDLE: "asset://emotes/emote-bow-duel-idle-steve.glb",

  /** Natural bow-arm walk with the free arm left under locomotion control */
  BOW_DUEL_WALK: "asset://emotes/emote-bow-duel-walk-steve.glb?s=1.3",

  /** Natural bow-arm run with the free arm left under locomotion control */
  BOW_DUEL_RUN: "asset://emotes/emote-bow-duel-run-steve.glb?s=1.4",

  /** Combat-ready idle for a one-handed melee duel weapon */
  ONE_HAND_DUEL_IDLE: "asset://emotes/emote-one-hand-idle-steve.glb",

  /** Combat-ready walk for a one-handed melee duel weapon */
  ONE_HAND_DUEL_WALK: "asset://emotes/emote-one-hand-walk-steve.glb?s=1.3",

  /** Combat-ready run for a one-handed melee duel weapon */
  ONE_HAND_DUEL_RUN: "asset://emotes/emote-one-hand-run-steve.glb?s=1.4",

  /** Certified two-hand guard used only by streamed bronze two-hand duels */
  TWO_HAND_DUEL_IDLE: "asset://emotes/emote-2h-duel-idle-steve.glb",

  /** Certified two-hand guarded walk at the production movement cadence */
  TWO_HAND_DUEL_WALK: "asset://emotes/emote-2h-duel-walk-steve.glb?s=1.3",

  /** Certified two-hand guarded run at the production movement cadence */
  TWO_HAND_DUEL_RUN: "asset://emotes/emote-2h-duel-run-steve.glb?s=1.4",

  /** Certified planted two-hand duel cut; one shot with exact guard recovery */
  TWO_HAND_DUEL_SLASH: "asset://emotes/emote-2h-duel-slash-steve.glb?l=0",

  /** Floating/swimming animation */
  FLOAT: "asset://emotes/emote-float.glb",

  /** Falling animation */
  FALL: "asset://emotes/emote-fall.glb",

  /** Flip/jump animation (1.5x speed) */
  FLIP: "asset://emotes/emote-flip.glb?s=1.5",

  /** Talking/gesturing animation */
  TALK: "asset://emotes/emote-talk.glb",

  /** Combat/attack animation (punching) - plays once per attack, no loop */
  COMBAT: "asset://emotes/emote-punching.glb?l=0",

  /** Sword swing attack animation (used when sword is equipped) - plays once per attack, no loop */
  SWORD_SWING: "asset://emotes/emote_sword_swing.glb?l=0",

  /** Two-handed sword idle stance (used when 2h sword is equipped) */
  TWO_HAND_IDLE: "asset://emotes/emote-2h-idle.glb",

  /** Two-handed sword slash animation - plays once per attack, no loop */
  TWO_HAND_SLASH: "asset://emotes/emote-2h-slash.glb?l=0",

  /** Ranged attack animation (used when bow is equipped) - plays once per attack, no loop */
  RANGE: "asset://emotes/emote-range.glb?l=0",

  /** Spell cast animation (used for magic attacks) - plays once per attack, no loop */
  SPELL_CAST: "asset://emotes/emote-spell-cast.glb?l=0",

  /** Chopping/woodcutting animation (used when cutting trees) */
  CHOPPING: "asset://emotes/emote-steve-woodcutting.glb",

  /** Mining animation (used when extracting ore) */
  MINING: "asset://emotes/emote-steve-mining.glb",

  /** Fishing animation (used when fishing) */
  FISHING: "asset://emotes/emote-steve-fishing-cast.glb",

  /** Two-handed water strike used by the canonical fitted harpoon */
  HARPOON: "asset://emotes/emote-harpoon-water-strike.glb?l=0",

  /** One-shot cast used by the fitted small fishing net */
  SMALL_FISHING_NET_RELEASE:
    "asset://emotes/emote-steve-small-fishing-net-release.glb?l=0",

  /** One-shot water pickup shared by fitted net and pot retrieval */
  FISHING_RETRIEVE: "asset://emotes/emote-steve-fishing-retrieve.glb?l=0",

  /** One-shot lowering motion used by the fitted lobster pot */
  LOBSTER_POT_DEPLOY: "asset://emotes/emote-steve-lobster-pot-deploy.glb?l=0",

  /** Death animation - no loop, stays at end pose */
  DEATH: "asset://emotes/emote-death.glb?l=0",

  /** Squat/crouch animation (used for firemaking and cooking) */
  SQUAT: "asset://emotes/emote-squat.glb",

  /** Victory celebration - waving both hands (used after winning duels) */
  VICTORY: "asset://emotes/emote-waving-both-hands.glb",

  /** Victory dance - happy dance celebration */
  VICTORY_DANCE: "asset://emotes/emote-dance-happy.glb",
};

/**
 * Gathering emote keys that currently have certified runtime body motion.
 *
 * Exact fishing item IDs use only their certified item-specific clips. Phase
 * authority selects the shared retrieval key separately from deployment.
 */
export const GATHERING_PRESENTATION_EMOTE_URLS: Readonly<
  Record<string, string>
> = Object.freeze({
  chopping: Emotes.CHOPPING,
  mining: Emotes.MINING,
  fishing: Emotes.FISHING,
  fishing_rod: Emotes.FISHING,
  fly_fishing_rod: Emotes.FISHING,
  small_fishing_net: Emotes.SMALL_FISHING_NET_RELEASE,
  fishing_retrieve: Emotes.FISHING_RETRIEVE,
  harpoon: Emotes.HARPOON,
  lobster_pot: Emotes.LOBSTER_POT_DEPLOY,
});

/** Array of all emote URLs (for preloading) */
export const emoteUrls = [
  Emotes.IDLE,
  Emotes.WALK,
  Emotes.RUN,
  Emotes.BOW_DUEL_IDLE,
  Emotes.BOW_DUEL_WALK,
  Emotes.BOW_DUEL_RUN,
  Emotes.ONE_HAND_DUEL_IDLE,
  Emotes.ONE_HAND_DUEL_WALK,
  Emotes.ONE_HAND_DUEL_RUN,
  Emotes.TWO_HAND_DUEL_IDLE,
  Emotes.TWO_HAND_DUEL_WALK,
  Emotes.TWO_HAND_DUEL_RUN,
  Emotes.TWO_HAND_DUEL_SLASH,
  Emotes.FLOAT,
  Emotes.FALL,
  Emotes.FLIP,
  Emotes.TALK,
  Emotes.COMBAT,
  Emotes.SWORD_SWING,
  Emotes.TWO_HAND_IDLE,
  Emotes.TWO_HAND_SLASH,
  Emotes.RANGE,
  Emotes.SPELL_CAST,
  Emotes.CHOPPING,
  Emotes.MINING,
  Emotes.FISHING,
  Emotes.HARPOON,
  Emotes.SMALL_FISHING_NET_RELEASE,
  Emotes.FISHING_RETRIEVE,
  Emotes.LOBSTER_POT_DEPLOY,
  Emotes.DEATH,
  Emotes.SQUAT,
  Emotes.VICTORY,
  Emotes.VICTORY_DANCE,
];

/**
 * Essential emotes that MUST be pre-loaded immediately after avatar loads.
 * These are the most commonly used emotes that would cause visible T-pose flash
 * if loaded on-demand during gameplay.
 */
export const essentialEmotes = [
  Emotes.IDLE, // Default pose - MUST be loaded first
  Emotes.WALK, // Most common movement
  Emotes.RUN, // Fast movement
  Emotes.BOW_DUEL_IDLE, // Streamed-duel fitted bow carry
  Emotes.BOW_DUEL_WALK, // Streamed-duel fitted bow walk
  Emotes.BOW_DUEL_RUN, // Streamed-duel fitted bow run
  Emotes.ONE_HAND_DUEL_IDLE, // Melee duel guard without body/blade overlap
  Emotes.ONE_HAND_DUEL_WALK, // Melee duel locomotion guard
  Emotes.ONE_HAND_DUEL_RUN, // Melee duel running guard
  Emotes.TWO_HAND_DUEL_IDLE, // Certified two-hand streamed-duel guard
  Emotes.TWO_HAND_DUEL_WALK, // Certified two-hand streamed-duel walk
  Emotes.TWO_HAND_DUEL_RUN, // Certified two-hand streamed-duel run
  Emotes.TWO_HAND_DUEL_SLASH, // Certified two-hand streamed-duel cut
  Emotes.COMBAT, // Unarmed attack
  Emotes.SWORD_SWING, // One-handed duel attack
  Emotes.TWO_HAND_IDLE, // Two-handed combat stance
  Emotes.TWO_HAND_SLASH, // Two-handed duel attack
  Emotes.RANGE, // Ranged duel attack
  Emotes.SPELL_CAST, // Magic duel attack
  Emotes.CHOPPING, // Canonical preparation-loop woodcutting motion
  Emotes.MINING, // Canonical preparation-loop mining motion
  Emotes.FISHING, // Canonical preparation-loop fishing-rod motion
  Emotes.HARPOON, // Canonical preparation-loop water strike
  Emotes.SMALL_FISHING_NET_RELEASE, // Canonical small-net release
  Emotes.FISHING_RETRIEVE, // Canonical net/pot retrieval
  Emotes.LOBSTER_POT_DEPLOY, // Canonical lobster-pot deployment
  Emotes.DEATH, // Death animation
  Emotes.VICTORY, // Victory celebration (waving)
];
