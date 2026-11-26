type ReplayFrameLike = {
  payloadBytes: number;
};

export function shouldDeliverSseFrame(
  lastDeliveredSeq: number,
  nextSeq: number,
): boolean {
  return (
    Number.isSafeInteger(nextSeq) &&
    nextSeq > 0 &&
    nextSeq > Math.max(0, Math.floor(lastDeliveredSeq))
  );
}

export function trimReplayFrames<T extends ReplayFrameLike>(
  frames: T[],
  totalBytes: number,
  limits: {
    maxFrames: number;
    maxBytes: number;
  },
): number {
  // Bounded front-splice is acceptable at the current replay caps. If replay
  // depth or eviction cadence grows materially, replace this with a ring buffer
  // rather than layering more complexity into this PR.
  let removeCount = 0;
  let removedBytes = 0;

  while (
    frames.length - removeCount > limits.maxFrames ||
    totalBytes - removedBytes > limits.maxBytes
  ) {
    const frame = frames[removeCount];
    if (!frame) break;
    removedBytes += frame.payloadBytes;
    removeCount += 1;
  }

  if (removeCount > 0) {
    frames.splice(0, removeCount);
  }

  return Math.max(0, totalBytes - removedBytes);
}
