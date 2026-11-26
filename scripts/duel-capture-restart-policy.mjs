const FORBIDDEN_GROUP_COMMANDS = Object.freeze([
  "duel-stack.mjs",
  "smoke-duel-launch.mjs",
  "verify-duel-stream-recovery.mjs",
]);

export const MAX_CAPTURE_FAIL_CLOSED_LATENCY_MS = 5_000;

export function buildCaptureSupervisorUnavailableStatus(updatedAt) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error("capture supervisor status timestamp is invalid");
  }
  return {
    destinations: [],
    stats: {
      bytesReceived: 0,
      healthy: false,
      droppedFrames: 0,
      backpressured: false,
      ffmpegRunning: false,
      audioSource: "uninitialized",
      audioHealthy: false,
      audioLastChunkAt: null,
      audioChunks: 0,
      audioDroppedChunks: 0,
      audioTrimmedChunks: 0,
      clientConnected: false,
      spectators: 0,
    },
    rendererHealth: {
      ready: false,
      degradedReason: "capture_process_exited",
      updatedAt,
      phase: null,
      diagnostics: null,
    },
    updatedAt,
    source: "external-rtmp-bridge",
  };
}

export function validateCaptureFailClosedLatency({
  killedAt,
  apiObservedAt,
  browserObservedAt,
  maximumMs = MAX_CAPTURE_FAIL_CLOSED_LATENCY_MS,
}) {
  if (
    !Number.isFinite(killedAt) ||
    !Number.isFinite(apiObservedAt) ||
    !Number.isFinite(browserObservedAt) ||
    !Number.isFinite(maximumMs) ||
    maximumMs <= 0
  ) {
    throw new Error("capture fail-closed timestamps are invalid");
  }
  const apiLatencyMs = apiObservedAt - killedAt;
  const browserLatencyMs = browserObservedAt - killedAt;
  if (
    apiLatencyMs < 0 ||
    browserLatencyMs < 0 ||
    apiLatencyMs > maximumMs ||
    browserLatencyMs > maximumMs
  ) {
    throw new Error(
      `capture did not fail closed within ${maximumMs}ms (api=${apiLatencyMs}ms browser=${browserLatencyMs}ms)`,
    );
  }
  return { maximumMs, apiLatencyMs, browserLatencyMs };
}

export function validateMarketAuthorityRetention(before, unavailable, after) {
  const authority = (state, label) => {
    const value = state?.authority;
    if (!value || typeof value !== "object") {
      throw new Error(`${label} market authority is missing`);
    }
    return value;
  };
  const initial = authority(before, "pre-restart");
  const failed = authority(unavailable, "fail-closed");
  const recovered = authority(after, "post-restart");
  const duelId = initial.marketDuelId;
  const duelKey = initial.marketDuelKey;
  if (
    typeof duelId !== "string" ||
    duelId.length === 0 ||
    typeof duelKey !== "string" ||
    duelKey.length === 0 ||
    initial.streamDuelId !== duelId ||
    initial.streamDuelKey !== duelKey
  ) {
    throw new Error("pre-restart stream and market authority do not match");
  }
  if (
    failed.marketDuelId !== duelId ||
    failed.marketDuelKey !== duelKey ||
    failed.streamDuelId !== null ||
    failed.streamDuelKey !== null ||
    failed.marketCanPlaceBet !== false
  ) {
    throw new Error("fail-closed market authority changed or stayed tradeable");
  }
  if (
    recovered.marketDuelId !== duelId ||
    recovered.marketDuelKey !== duelKey ||
    recovered.streamDuelId !== duelId ||
    recovered.streamDuelKey !== duelKey
  ) {
    throw new Error("post-restart stream or market authority changed");
  }
  return { duelId, duelKey, retained: true };
}

function hasCaptureWorkerEntrypoint(command) {
  const snapshot = String(command ?? "");
  const packageScript = /(?:^|\s)stream:rtmp(?:\s|$)/m.test(snapshot);
  const directTypeScriptEntrypoint =
    /(?:^|\s)(?:\S*\/)?(?:node|bun)\s+--import\s+tsx\s+packages\/server\/scripts\/stream-to-rtmp\.ts(?:\s|$)/m.test(
      snapshot,
    );
  return (
    snapshot.includes("packages/server") &&
    (packageScript || directTypeScriptEntrypoint)
  );
}

export function parseProcessSnapshot(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        groupId: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter(
      (entry) =>
        entry &&
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 1 &&
        Number.isSafeInteger(entry.groupId) &&
        entry.groupId > 1,
    );
}

export function parseListenerPids(raw) {
  return Array.from(
    new Set(
      String(raw ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    ),
  );
}

export function hasHlsManifestAdvanced(previous, current) {
  const safeManifest = (value) =>
    value &&
    Number.isSafeInteger(value.mediaSequence) &&
    Number.isSafeInteger(value.segmentCount) &&
    value.segmentCount > 0 &&
    typeof value.lastSegment === "string" &&
    value.lastSegment.length > 0
      ? value
      : null;
  const before = safeManifest(previous);
  const after = safeManifest(current);
  if (!before || !after || after.lastSegment === before.lastSegment) {
    return false;
  }

  const beforeExclusiveEnd = before.mediaSequence + before.segmentCount;
  const afterExclusiveEnd = after.mediaSequence + after.segmentCount;
  if (afterExclusiveEnd <= beforeExclusiveEnd) return false;

  if (
    Number.isFinite(before.lastProgramDateTimeMs) &&
    Number.isFinite(after.lastProgramDateTimeMs) &&
    after.lastProgramDateTimeMs <= before.lastProgramDateTimeMs
  ) {
    return false;
  }
  return true;
}

export function redactWarmRendererUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:token|secret|key|auth|signature|credential)/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.toString();
}

export function hasVerifiedBrowserMatchPresentation(
  state,
  expectedAgentNames = [],
) {
  if (state?.fighterCardCount === 2) return true;
  if (
    state?.marketPanelPresent !== true ||
    typeof state?.marketPanelText !== "string" ||
    !Array.isArray(expectedAgentNames) ||
    expectedAgentNames.length !== 2
  ) {
    return false;
  }

  const normalizedNames = expectedAgentNames.map((name) =>
    String(name ?? "")
      .trim()
      .toLowerCase(),
  );
  const marketText = state.marketPanelText.toLowerCase();
  const authority = state.authority;
  return Boolean(
    normalizedNames.every(
      (name) => name.length > 0 && marketText.includes(name),
    ) &&
    typeof authority?.streamDuelId === "string" &&
    authority.streamDuelId.length > 0 &&
    authority.streamDuelId === authority.marketDuelId &&
    typeof authority?.streamDuelKey === "string" &&
    authority.streamDuelKey.length > 0 &&
    authority.streamDuelKey === authority.marketDuelKey,
  );
}

export function validateWarmRendererRetention(before, after) {
  const requiredString = (value, label) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`warm renderer ${label} is missing`);
    }
    return value;
  };
  const requiredFinite = (value, label) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`warm renderer ${label} is invalid`);
    }
    return value;
  };
  const normalizedBefore = {
    targetId: requiredString(before?.targetId, "target id before restart"),
    marker: requiredString(before?.marker, "marker before restart"),
    pageUrlSha256: requiredString(
      before?.pageUrlSha256,
      "URL identity before restart",
    ),
    pageUrlRedacted: requiredString(
      before?.pageUrlRedacted,
      "redacted URL before restart",
    ),
    timeOrigin: requiredFinite(
      before?.timeOrigin,
      "navigation time origin before restart",
    ),
    navigationEntries: before?.navigationEntries,
  };
  const normalizedAfter = {
    targetId: requiredString(after?.targetId, "target id after restart"),
    marker: requiredString(after?.marker, "marker after restart"),
    pageUrlSha256: requiredString(
      after?.pageUrlSha256,
      "URL identity after restart",
    ),
    pageUrlRedacted: requiredString(
      after?.pageUrlRedacted,
      "redacted URL after restart",
    ),
    timeOrigin: requiredFinite(
      after?.timeOrigin,
      "navigation time origin after restart",
    ),
    navigationEntries: after?.navigationEntries,
  };
  if (
    !Number.isSafeInteger(normalizedBefore.navigationEntries) ||
    normalizedBefore.navigationEntries < 1 ||
    !Number.isSafeInteger(normalizedAfter.navigationEntries) ||
    normalizedAfter.navigationEntries < 1
  ) {
    throw new Error("warm renderer navigation entry count is invalid");
  }
  for (const key of [
    "targetId",
    "marker",
    "pageUrlSha256",
    "pageUrlRedacted",
    "timeOrigin",
    "navigationEntries",
  ]) {
    if (normalizedBefore[key] !== normalizedAfter[key]) {
      throw new Error(`warm renderer ${key} changed during encoder recovery`);
    }
  }
  if (after?.hasCanvas !== true || after?.rendererReady !== true) {
    throw new Error("warm renderer was not healthy after encoder recovery");
  }
  return { before: normalizedBefore, after: normalizedAfter, retained: true };
}

export function validateCaptureRestartTarget({
  capturePort,
  listenerPids,
  processSnapshot,
  verifierPid,
}) {
  if (
    !Number.isSafeInteger(capturePort) ||
    capturePort < 1 ||
    capturePort > 65_535
  ) {
    throw new Error("capture restart port must be an integer from 1 to 65535");
  }
  if (!Array.isArray(listenerPids) || listenerPids.length > 1) {
    throw new Error(
      `capture restart allows at most one listener on port ${capturePort}`,
    );
  }
  if (!Array.isArray(processSnapshot)) {
    throw new Error("capture restart process snapshot is required");
  }

  const verifier = processSnapshot.find((entry) => entry.pid === verifierPid);
  if (!verifier) {
    throw new Error("capture verifier is absent from the process snapshot");
  }

  const listenerPid = listenerPids[0] ?? null;
  const listener =
    listenerPid === null
      ? null
      : processSnapshot.find((entry) => entry.pid === listenerPid);
  if (listenerPid !== null && !listener) {
    throw new Error("capture listener is absent from the process snapshot");
  }

  const processGroups = Array.from(
    new Set(processSnapshot.map((entry) => entry.groupId)),
  ).map((groupId) => ({
    groupId,
    members: processSnapshot.filter((entry) => entry.groupId === groupId),
  }));
  const streamGroups = processGroups.filter(({ members }) => {
    const command = members.map((entry) => entry.command).join("\n");
    return hasCaptureWorkerEntrypoint(command);
  });
  const candidateGroups = listener
    ? streamGroups.filter(({ groupId }) => groupId === listener.groupId)
    : streamGroups;
  if (candidateGroups.length !== 1) {
    throw new Error(
      `capture restart requires exactly one server stream worker process group; found ${candidateGroups.length}`,
    );
  }

  const [{ groupId, members }] = candidateGroups;
  if (groupId === verifier.groupId) {
    throw new Error("capture worker shares the verifier process group");
  }

  const leader = members.find((entry) => entry.pid === groupId);
  if (!leader) {
    throw new Error("capture process group has no visible group leader");
  }
  const combinedCommand = members.map((entry) => entry.command).join("\n");
  const forbidden = FORBIDDEN_GROUP_COMMANDS.find((needle) =>
    combinedCommand.includes(needle),
  );
  if (forbidden) {
    throw new Error(
      `capture process group contains forbidden owner ${forbidden}`,
    );
  }

  return Object.freeze({
    capturePort,
    listenerPid,
    groupId,
    leaderPid: leader.pid,
    memberPids: Object.freeze(members.map((entry) => entry.pid)),
  });
}
