interface SeekableAnimationAction {
  time: number;
  getClip(): { duration: number };
}

interface UpdateableAnimationMixer {
  update(deltaSeconds: number): unknown;
}

/**
 * Seek a Three animation action to an exact clip-local time and immediately
 * write that pose. Invalid caller input is ignored; invalid clip duration
 * fails closed to frame zero.
 */
export function applyAnimationActionStartTime(
  action: SeekableAnimationAction,
  mixer: UpdateableAnimationMixer,
  startTimeSeconds: number | undefined,
  loop: boolean,
): boolean {
  if (
    typeof startTimeSeconds !== "number" ||
    !Number.isFinite(startTimeSeconds)
  ) {
    return false;
  }
  const duration = action.getClip().duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    action.time = 0;
  } else {
    const nonNegativeTime = Math.max(0, startTimeSeconds);
    action.time = loop
      ? nonNegativeTime % duration
      : Math.min(nonNegativeTime, duration);
  }
  mixer.update(0);
  return true;
}
