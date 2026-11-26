export const AVATAR_EMOTE_BLEND_SECONDS = 0.15;
export const AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS = 0.4;

const CONTROLLED_GUARD_LOCOMOTION_PATTERN =
  /(?:^|\/)(?:emote-2h-(?:idle|walk|run)-steve-controlled-guard-candidate|emote-2h-duel-(?:idle|walk|run)-steve)\.glb$/;

interface AvatarEmoteFadeAction {
  fadeOut(durationSeconds: number): unknown;
  reset(): AvatarEmoteFadeAction;
  fadeIn(durationSeconds: number): AvatarEmoteFadeAction;
  play(): AvatarEmoteFadeAction;
}

export function fadeOutAvatarEmote(
  action: AvatarEmoteFadeAction | null | undefined,
  durationSeconds = AVATAR_EMOTE_BLEND_SECONDS,
): void {
  action?.fadeOut(durationSeconds);
}

export function fadeInAvatarEmote<T extends AvatarEmoteFadeAction>(
  action: T,
  durationSeconds = AVATAR_EMOTE_BLEND_SECONDS,
): T {
  return action.reset().fadeIn(durationSeconds).play() as T;
}

export function avatarEmoteBlendSecondsFor(
  outgoingUrl: string | null | undefined,
  incomingUrl: string | null | undefined,
): number {
  const outgoingPath = outgoingUrl?.split("?", 1)[0] ?? "";
  const incomingPath = incomingUrl?.split("?", 1)[0] ?? "";
  return CONTROLLED_GUARD_LOCOMOTION_PATTERN.test(outgoingPath) &&
    CONTROLLED_GUARD_LOCOMOTION_PATTERN.test(incomingPath)
    ? AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS
    : AVATAR_EMOTE_BLEND_SECONDS;
}
