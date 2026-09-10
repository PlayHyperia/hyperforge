const DEFAULT_MAX_CONSECUTIVE_STALLS = 3;
const DEFAULT_MAX_HEAP_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_DOM_NODES = 50_000;
const DEFAULT_MAX_DOCUMENTS = 20;
const DEFAULT_MIN_PLAYBACK_RATIO = 0.75;
// The UI schedules expiry renders every second. Allow one additional tick of
// scheduling delay, but never certify cached readiness for an unbounded time.
const MAX_EVALUATION_CLOCK_AGE_MS = 2_000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function boundedRatio(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be greater than zero and at most one`);
  }
  return parsed;
}

function boundedText(value, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function retainRendererDerivation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    ["externalSnapshotPresent", "rendererPresent", "scenePresent"].some(
      (key) => typeof value[key] !== "boolean",
    )
  )
    return null;
  const result = { schemaVersion: 1 };
  for (const key of [
    "evaluatedAtMs",
    "externalSnapshotUpdatedAt",
    "rendererUpdatedAt",
  ]) {
    result[key] =
      Number.isSafeInteger(value[key]) && value[key] > 0 ? value[key] : null;
  }
  for (const [key, limit] of [
    ["canonicalCycleId", 128],
    ["canonicalPhase", 32],
    ["rendererPhase", 32],
    ["rendererDegradedReason", 128],
    ["sceneCycleId", 128],
    ["scenePhase", 32],
  ]) {
    const token = value[key];
    result[key] =
      typeof token === "string" &&
      token.length <= limit &&
      /^[A-Za-z0-9_.:-]+$/.test(token)
        ? token
        : null;
  }
  for (const key of [
    "externalSnapshotPresent",
    "rendererPresent",
    "rendererReady",
    "scenePresent",
    "sceneReady",
    "captureClientConnected",
    "captureFfmpegRunning",
  ]) {
    result[key] = typeof value[key] === "boolean" ? value[key] : null;
  }
  return result;
}

function retainPublicStreamState(value) {
  if (!value || typeof value !== "object") return null;
  const health = value.rendererHealth;
  return {
    seq: finiteNumber(value.seq) ? value.seq : null,
    emittedAt: finiteNumber(value.emittedAt) ? value.emittedAt : null,
    cycleId: boundedText(value.cycleId),
    duelId: boundedText(value.duelId),
    duelKeyHex: boundedText(value.duelKeyHex, 64),
    phase: boundedText(value.phase, 32),
    rendererHealth: health
      ? {
          ready: typeof health.ready === "boolean" ? health.ready : null,
          degradedReason: boundedText(health.degradedReason),
          updatedAt: finiteNumber(health.updatedAt) ? health.updatedAt : null,
          ...(health.derivation !== undefined
            ? { derivation: retainRendererDerivation(health.derivation) }
            : {}),
        }
      : null,
  };
}

function rendererHealthTransitionKey(health) {
  return {
    ...health,
    updatedAt: undefined,
    ...(health?.derivation
      ? {
          derivation: {
            ...health.derivation,
            evaluatedAtMs: undefined,
            externalSnapshotUpdatedAt: undefined,
            rendererUpdatedAt: undefined,
          },
        }
      : {}),
  };
}

export function retainDuelFullTopologyViewerReadiness(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of [
    "schemaVersion",
    "evaluatedNowMs",
    "playbackDateMs",
    "maxAgeMs",
    "uiSyncDelayMs",
  ]) {
    result[key] = finiteNumber(value[key]) ? value[key] : null;
  }
  for (const key of [
    "hookRendererReady",
    "currentPresentationRendererReady",
    "currentConnected",
    "presentationConnected",
    "playbackReady",
  ]) {
    result[key] = typeof value[key] === "boolean" ? value[key] : null;
  }
  result.recoveryMode = boundedText(value.recoveryMode, 32);
  result.current = retainPublicStreamState(value.current);
  result.presentation = retainPublicStreamState(value.presentation);
  return result;
}

export function buildDuelFullTopologyViewerCoverageCheck(
  continuitySummary,
  viewerFinishedAtMs,
) {
  const lastObservationAt = continuitySummary?.lastObservedAt;
  return {
    label: "full-topology backend observation covers actual viewer completion",
    pass:
      finiteNumber(viewerFinishedAtMs) &&
      viewerFinishedAtMs > 0 &&
      finiteNumber(lastObservationAt) &&
      lastObservationAt >= viewerFinishedAtMs,
    actual: {
      lastObservationAt: lastObservationAt ?? null,
      viewerFinishedAtMs: viewerFinishedAtMs ?? null,
    },
  };
}

function viewerExperienceIssues(state) {
  const readiness = state?.readiness;
  const recovery = state?.recovery;
  const issues = [];
  if (
    readiness?.schemaVersion !== 1 ||
    !finiteNumber(readiness.evaluatedNowMs) ||
    readiness.evaluatedNowMs <= 0 ||
    !["hidden", "advisory", "blocking"].includes(readiness.recoveryMode) ||
    [
      "hookRendererReady",
      "currentPresentationRendererReady",
      "currentConnected",
      "presentationConnected",
      "playbackReady",
    ].some((key) => typeof readiness[key] !== "boolean") ||
    typeof recovery?.visible !== "boolean" ||
    !["hidden", "advisory", "blocking"].includes(recovery?.mode)
  ) {
    issues.push("viewer_readiness_diagnostics_invalid");
    return issues;
  }
  if (
    recovery.visible ||
    recovery.mode !== "hidden" ||
    readiness.recoveryMode !== "hidden"
  ) {
    issues.push("viewer_recovery_visible");
  }
  if (
    !readiness.hookRendererReady ||
    !readiness.currentPresentationRendererReady
  ) {
    issues.push("viewer_renderer_unready");
  }
  if (!readiness.currentConnected || !readiness.presentationConnected) {
    issues.push("viewer_telemetry_unavailable");
  }
  if (!readiness.playbackReady) issues.push("viewer_playback_unready");
  const observedAt = state.browserObservedAtMs;
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0 ||
    !Number.isSafeInteger(readiness.evaluatedNowMs) ||
    readiness.evaluatedNowMs > observedAt ||
    observedAt - readiness.evaluatedNowMs > MAX_EVALUATION_CLOCK_AGE_MS
  ) {
    issues.push("viewer_evaluation_clock_invalid_or_stale");
  }
  const allowedAuthorityAgeMs = readiness.maxAgeMs + readiness.uiSyncDelayMs;
  const current = readiness.current;
  const health = current?.rendererHealth;
  // A fresh explicit negative is still a hard failure, but is not a stale
  // clock. Keep health and time failures independent for causal diagnostics.
  if (health?.ready !== true || health?.degradedReason != null) {
    issues.push("viewer_current_authority_renderer_unready");
  }
  if (
    !finiteNumber(readiness.maxAgeMs) ||
    readiness.maxAgeMs < 0 ||
    !finiteNumber(readiness.uiSyncDelayMs) ||
    readiness.uiSyncDelayMs < 0 ||
    !Number.isSafeInteger(current?.emittedAt) ||
    current.emittedAt <= 0 ||
    current.emittedAt > observedAt ||
    observedAt - current.emittedAt > allowedAuthorityAgeMs ||
    !Number.isSafeInteger(health?.updatedAt) ||
    health.updatedAt <= 0 ||
    health.updatedAt > observedAt ||
    observedAt - health.updatedAt > allowedAuthorityAgeMs
  ) {
    issues.push("viewer_current_authority_clock_invalid_or_stale");
  }
  return issues;
}

export function hasExactDuelFullTopologyViewerBaseline(
  state,
  { cycleId, duelId, duelKey, expectedStreamSource },
) {
  return (
    Boolean(
      nonEmptyString(cycleId) &&
      nonEmptyString(duelId) &&
      /^[0-9a-f]{64}$/.test(duelKey ?? "") &&
      nonEmptyString(expectedStreamSource) &&
      state?.rootPresent === true &&
      state?.navigationEntries === 1 &&
      state?.authority?.streamCycleId === cycleId &&
      state.authority.streamDuelId === duelId &&
      state.authority.streamDuelKey === duelKey &&
      state.authority.marketDuelId === duelId &&
      state.authority.marketDuelKey === duelKey &&
      state.authority.marketCanPlaceBet === true &&
      Number(state?.wagerControlCount) > 0 &&
      state?.submitEnabled === true &&
      state?.video?.declaredSource === expectedStreamSource &&
      Number(state.video.readyState) >= 2 &&
      state.video.paused === false,
      // A tradeable DOM and advancing video underneath a recovery overlay are
      // not an admissible spectator baseline.
    ) && viewerExperienceIssues(state).length === 0
  );
}

export class DuelFullTopologyViewerTracker {
  constructor({
    marker,
    timeOrigin,
    expectedStreamSource,
    maxConsecutiveStalls = DEFAULT_MAX_CONSECUTIVE_STALLS,
    maxHeapBytes = DEFAULT_MAX_HEAP_BYTES,
    maxHeapGrowthBytes = DEFAULT_MAX_HEAP_GROWTH_BYTES,
    maxDomNodes = DEFAULT_MAX_DOM_NODES,
    maxDocuments = DEFAULT_MAX_DOCUMENTS,
    minPlaybackRatio = DEFAULT_MIN_PLAYBACK_RATIO,
    maxIssueSamples = 50,
    maxStateTransitions = 100,
  }) {
    if (!nonEmptyString(marker)) {
      throw new Error("Full-topology viewer marker is required");
    }
    if (!finiteNumber(timeOrigin) || timeOrigin <= 0) {
      throw new Error("Full-topology viewer time origin is required");
    }
    if (!nonEmptyString(expectedStreamSource)) {
      throw new Error("Full-topology viewer stream source is required");
    }
    this.marker = marker;
    this.timeOrigin = timeOrigin;
    this.expectedStreamSource = expectedStreamSource;
    this.maxConsecutiveStalls = positiveInteger(
      maxConsecutiveStalls,
      "Full-topology viewer maximum consecutive stalls",
    );
    this.maxHeapBytes = positiveInteger(
      maxHeapBytes,
      "Full-topology viewer maximum heap bytes",
    );
    this.maxHeapGrowthBytes = positiveInteger(
      maxHeapGrowthBytes,
      "Full-topology viewer maximum heap growth bytes",
    );
    this.maxDomNodes = positiveInteger(
      maxDomNodes,
      "Full-topology viewer maximum DOM nodes",
    );
    this.maxDocuments = positiveInteger(
      maxDocuments,
      "Full-topology viewer maximum documents",
    );
    this.minPlaybackRatio = boundedRatio(
      minPlaybackRatio,
      "Full-topology viewer minimum playback ratio",
    );
    this.maxIssueSamples = positiveInteger(
      maxIssueSamples,
      "Full-topology viewer issue sample limit",
    );
    this.maxStateTransitions = positiveInteger(
      maxStateTransitions,
      "Full-topology viewer state transition limit",
    );
    this.stateTransitions = [];
    this.stateTransitionCount = 0;
    this.lastTransitionKey = null;
    this.experienceIssueOccurrences = 0;
    this.wagerSafetyIssueOccurrences = 0;
    this.playbackMeasurements = 0;
    this.observations = 0;
    this.validObservations = 0;
    this.violationObservations = 0;
    this.issueOccurrences = 0;
    this.issueCounts = new Map();
    this.issueSamples = [];
    this.cycleIds = new Set();
    this.firstObservedAt = null;
    this.lastObservedAt = null;
    this.firstState = null;
    this.lastState = null;
    this.lastVideoTime = null;
    this.videoAdvanceSeconds = 0;
    this.videoAdvanceSamples = 0;
    this.consecutiveStalls = 0;
    this.maxObservedConsecutiveStalls = 0;
    this.firstHeapBytes = null;
    this.lastHeapBytes = null;
    this.maxHeapBytesObserved = 0;
    this.maxDomNodesObserved = 0;
    this.maxDocumentsObserved = 0;
  }

  recordIssue(code, detail = null, observedAt = Date.now()) {
    this.issueOccurrences += 1;
    this.issueCounts.set(code, (this.issueCounts.get(code) ?? 0) + 1);
    if (this.issueSamples.length < this.maxIssueSamples) {
      this.issueSamples.push({ code, detail, observedAt });
    }
  }

  recordFailure(code, detail = null, observedAt = Date.now()) {
    this.observations += 1;
    this.violationObservations += 1;
    this.recordIssue(code, detail, observedAt);
  }

  observe({
    state,
    metrics,
    observedAt = Date.now(),
    completedAt = observedAt,
    source = "poll",
    measurePlayback = true,
  }) {
    this.observations += 1;
    this.firstObservedAt ??= observedAt;
    this.lastObservedAt = observedAt;
    const issues = [];
    const addIssue = (code, detail = null) => issues.push({ code, detail });
    const addWagerIssue = (code, detail = null) => {
      this.wagerSafetyIssueOccurrences += 1;
      addIssue(code, detail);
    };
    const experienceIssues = viewerExperienceIssues(state);
    this.experienceIssueOccurrences += experienceIssues.length;
    for (const code of experienceIssues) addIssue(code);

    if (!state || typeof state !== "object") {
      addIssue("viewer_state_invalid");
    }
    if (state?.marker !== this.marker) {
      addIssue("viewer_marker_changed", state?.marker ?? null);
    }
    if (state?.timeOrigin !== this.timeOrigin) {
      addIssue("viewer_time_origin_changed", state?.timeOrigin ?? null);
    }
    if (state?.navigationEntries !== 1) {
      addIssue("viewer_navigation_count_changed", state?.navigationEntries);
    }
    if (state?.rootPresent !== true) {
      addIssue("viewer_root_missing");
    }

    const video = state?.video;
    if (!video || typeof video !== "object") {
      addIssue("viewer_video_missing");
    } else {
      if (video.declaredSource !== this.expectedStreamSource) {
        addIssue("viewer_stream_source_changed", video.declaredSource ?? null);
      }
      if (!finiteNumber(video.currentTime) || video.currentTime < 0) {
        addIssue("viewer_video_time_invalid", video.currentTime ?? null);
      }
      if (!Number.isSafeInteger(video.readyState) || video.readyState < 2) {
        addIssue("viewer_video_not_decoded", video.readyState ?? null);
      }
      if (video.paused !== false) {
        addIssue("viewer_video_paused", video.paused ?? null);
      }
      // Screenshot brackets are additional authority/visual observations, not
      // extra two-second playback polls. Counting them as stalled polls would
      // turn multiple observations within one video frame into a false stall.
      if (finiteNumber(video.currentTime) && measurePlayback) {
        this.playbackMeasurements += 1;
        if (this.lastVideoTime != null) {
          const delta = video.currentTime - this.lastVideoTime;
          if (delta > 0.05) {
            this.videoAdvanceSeconds += delta;
            this.videoAdvanceSamples += 1;
            this.consecutiveStalls = 0;
          } else {
            this.consecutiveStalls += 1;
            this.maxObservedConsecutiveStalls = Math.max(
              this.maxObservedConsecutiveStalls,
              this.consecutiveStalls,
            );
            if (delta < -0.05) {
              addIssue("viewer_video_time_regressed", delta);
            } else if (this.consecutiveStalls > this.maxConsecutiveStalls) {
              addIssue("viewer_video_stalled", this.consecutiveStalls);
            }
          }
        }
        this.lastVideoTime = video.currentTime;
      }
    }

    const authority = state?.authority;
    if (!authority || typeof authority !== "object") {
      addWagerIssue("viewer_authority_missing");
    } else {
      const hasStreamIdentity =
        nonEmptyString(authority.streamCycleId) &&
        nonEmptyString(authority.streamDuelId) &&
        /^[0-9a-f]{64}$/.test(authority.streamDuelKey ?? "");
      if (hasStreamIdentity) this.cycleIds.add(authority.streamCycleId);
      if (authority.marketCanPlaceBet === true) {
        if (
          !hasStreamIdentity ||
          authority.marketDuelId !== authority.streamDuelId ||
          authority.marketDuelKey !== authority.streamDuelKey ||
          state.wagerControlCount < 1
        ) {
          addWagerIssue("viewer_tradeable_authority_mismatch", authority);
        }
        if (experienceIssues.length > 0) {
          addWagerIssue("viewer_tradeable_during_recovery");
        }
      } else if (
        state?.wagerControlCount !== 0 ||
        state?.submitEnabled !== false
      ) {
        addWagerIssue(
          "viewer_disabled_state_has_actionable_controls",
          state?.wagerControlCount,
        );
      }
      if (!hasStreamIdentity && authority.marketCanPlaceBet === true) {
        addWagerIssue("viewer_tradeable_without_stream_authority");
      }
    }

    const heapBytes = Number(metrics?.JSHeapUsedSize);
    const domNodes = Number(metrics?.Nodes);
    const documents = Number(metrics?.Documents);
    if (!finiteNumber(heapBytes) || heapBytes < 0) {
      addIssue("viewer_heap_metric_invalid", metrics?.JSHeapUsedSize ?? null);
    } else {
      this.firstHeapBytes ??= heapBytes;
      this.lastHeapBytes = heapBytes;
      this.maxHeapBytesObserved = Math.max(
        this.maxHeapBytesObserved,
        heapBytes,
      );
      if (heapBytes > this.maxHeapBytes) {
        addIssue("viewer_heap_ceiling_exceeded", heapBytes);
      }
    }
    if (!finiteNumber(domNodes) || domNodes < 0) {
      addIssue("viewer_dom_nodes_metric_invalid", metrics?.Nodes ?? null);
    } else {
      this.maxDomNodesObserved = Math.max(this.maxDomNodesObserved, domNodes);
      if (domNodes > this.maxDomNodes) {
        addIssue("viewer_dom_nodes_ceiling_exceeded", domNodes);
      }
    }
    if (!finiteNumber(documents) || documents < 1) {
      addIssue("viewer_documents_metric_invalid", metrics?.Documents ?? null);
    } else {
      this.maxDocumentsObserved = Math.max(
        this.maxDocumentsObserved,
        documents,
      );
      if (documents > this.maxDocuments) {
        addIssue("viewer_documents_ceiling_exceeded", documents);
      }
    }

    const retainedState = {
      observedAt,
      completedAt,
      source: boundedText(source, 40),
      measurePlayback,
      browserObservedAtMs: finiteNumber(state?.browserObservedAtMs)
        ? state.browserObservedAtMs
        : null,
      browserPerformanceNowMs: finiteNumber(state?.browserPerformanceNowMs)
        ? state.browserPerformanceNowMs
        : null,
      cycleId: authority?.streamCycleId ?? null,
      duelId: authority?.streamDuelId ?? null,
      marketMode: authority?.marketMode ?? null,
      marketReason: authority?.marketReason ?? null,
      marketCanPlaceBet: authority?.marketCanPlaceBet === true,
      wagerControlCount: state?.wagerControlCount ?? null,
      submitEnabled: state?.submitEnabled === true,
      videoTime: video?.currentTime ?? null,
      videoReadyState: video?.readyState ?? null,
      videoPaused: video?.paused ?? null,
      heapBytes: finiteNumber(heapBytes) ? heapBytes : null,
      domNodes: finiteNumber(domNodes) ? domNodes : null,
      documents: finiteNumber(documents) ? documents : null,
      recovery: {
        visible: state?.recovery?.visible === true,
        mode: boundedText(state?.recovery?.mode, 32),
        heading: boundedText(state?.recovery?.heading),
      },
      readiness: retainDuelFullTopologyViewerReadiness(state?.readiness),
    };
    this.firstState ??= retainedState;
    this.lastState = retainedState;
    // Keep semantic transitions, not one entry for every changing clock/seq.
    const transitionKey = JSON.stringify({
      cycleId: retainedState.cycleId,
      marketMode: retainedState.marketMode,
      marketReason: retainedState.marketReason,
      marketCanPlaceBet: retainedState.marketCanPlaceBet,
      wagerControlCount: retainedState.wagerControlCount,
      recovery: retainedState.recovery,
      readiness: {
        ...retainedState.readiness,
        evaluatedNowMs: undefined,
        playbackDateMs: undefined,
        current: retainedState.readiness?.current
          ? {
              ...retainedState.readiness.current,
              seq: undefined,
              emittedAt: undefined,
              rendererHealth: rendererHealthTransitionKey(
                retainedState.readiness.current.rendererHealth,
              ),
            }
          : null,
        presentation: retainedState.readiness?.presentation
          ? {
              ...retainedState.readiness.presentation,
              seq: undefined,
              emittedAt: undefined,
              rendererHealth: rendererHealthTransitionKey(
                retainedState.readiness.presentation.rendererHealth,
              ),
            }
          : null,
      },
    });
    if (transitionKey !== this.lastTransitionKey) {
      this.stateTransitionCount += 1;
      if (this.stateTransitions.length < this.maxStateTransitions) {
        this.stateTransitions.push(retainedState);
      }
      this.lastTransitionKey = transitionKey;
    }

    if (issues.length === 0) {
      this.validObservations += 1;
    } else {
      this.violationObservations += 1;
      for (const issue of issues) {
        this.recordIssue(issue.code, issue.detail, observedAt);
      }
    }
  }

  summary() {
    const elapsedMs =
      this.firstObservedAt != null && this.lastObservedAt != null
        ? this.lastObservedAt - this.firstObservedAt
        : 0;
    const expectedPlaybackSeconds = elapsedMs / 1_000;
    const playbackRatio =
      expectedPlaybackSeconds > 0
        ? this.videoAdvanceSeconds / expectedPlaybackSeconds
        : 0;
    const heapGrowthBytes =
      this.firstHeapBytes != null && this.lastHeapBytes != null
        ? this.lastHeapBytes - this.firstHeapBytes
        : null;
    return {
      observations: this.observations,
      validObservations: this.validObservations,
      violationObservations: this.violationObservations,
      issueOccurrences: this.issueOccurrences,
      issueCounts: Object.fromEntries(this.issueCounts),
      issueSamples: [...this.issueSamples],
      experienceIssueOccurrences: this.experienceIssueOccurrences,
      wagerSafetyIssueOccurrences: this.wagerSafetyIssueOccurrences,
      stateTransitionCount: this.stateTransitionCount,
      stateTransitionsOmitted:
        this.stateTransitionCount - this.stateTransitions.length,
      stateTransitions: [...this.stateTransitions],
      firstObservedAt: this.firstObservedAt,
      lastObservedAt: this.lastObservedAt,
      elapsedMs,
      cycleIds: [...this.cycleIds],
      videoAdvanceSeconds: this.videoAdvanceSeconds,
      videoAdvanceSamples: this.videoAdvanceSamples,
      playbackMeasurements: this.playbackMeasurements,
      playbackRatio,
      maxObservedConsecutiveStalls: this.maxObservedConsecutiveStalls,
      resourceMetrics: {
        firstHeapBytes: this.firstHeapBytes,
        lastHeapBytes: this.lastHeapBytes,
        heapGrowthBytes,
        maxHeapBytes: this.maxHeapBytesObserved,
        maxDomNodes: this.maxDomNodesObserved,
        maxDocuments: this.maxDocumentsObserved,
      },
      configuredCeilings: {
        maxConsecutiveStalls: this.maxConsecutiveStalls,
        maxHeapBytes: this.maxHeapBytes,
        maxHeapGrowthBytes: this.maxHeapGrowthBytes,
        maxDomNodes: this.maxDomNodes,
        maxDocuments: this.maxDocuments,
        minPlaybackRatio: this.minPlaybackRatio,
        maxEvaluationClockAgeMs: MAX_EVALUATION_CLOCK_AGE_MS,
      },
      firstState: this.firstState,
      lastState: this.lastState,
    };
  }
}

export function buildDuelFullTopologyViewerChecks(summary) {
  const ceilings = summary?.configuredCeilings ?? {};
  const resources = summary?.resourceMetrics ?? {};
  return [
    {
      label: "full-topology Hyperbet viewer observations retained",
      pass: Number(summary?.observations) >= 2,
      actual: Number(summary?.observations ?? 0),
    },
    {
      label: "full-topology Hyperbet viewer violations == 0",
      pass:
        Number(summary?.violationObservations) === 0 &&
        Number(summary?.issueOccurrences) === 0,
      actual: `${summary?.violationObservations ?? 0} observations, ${summary?.issueOccurrences ?? 0} issues`,
    },
    {
      label: "full-topology Hyperbet viewer experience continuity held",
      pass: Number(summary?.experienceIssueOccurrences) === 0,
      actual: summary?.experienceIssueOccurrences ?? null,
    },
    {
      label: "full-topology Hyperbet viewer wagering authority violations == 0",
      pass: Number(summary?.wagerSafetyIssueOccurrences) === 0,
      actual: summary?.wagerSafetyIssueOccurrences ?? null,
    },
    {
      label: "full-topology Hyperbet viewer decoded video advanced",
      pass:
        Number(summary?.videoAdvanceSamples) > 0 &&
        Number(summary?.playbackRatio) >= Number(ceilings.minPlaybackRatio),
      actual: {
        seconds: summary?.videoAdvanceSeconds ?? null,
        ratio: summary?.playbackRatio ?? null,
      },
    },
    {
      label: "full-topology Hyperbet viewer stall ceiling held",
      pass:
        Number(summary?.maxObservedConsecutiveStalls) <=
        Number(ceilings.maxConsecutiveStalls),
      actual: summary?.maxObservedConsecutiveStalls ?? null,
    },
    {
      label: "full-topology Hyperbet viewer observed canonical duel authority",
      pass: Array.isArray(summary?.cycleIds) && summary.cycleIds.length > 0,
      actual: summary?.cycleIds?.length ?? 0,
    },
    {
      label: "full-topology Hyperbet viewer retained bounded JS heap",
      pass:
        finiteNumber(resources.maxHeapBytes) &&
        resources.maxHeapBytes <= ceilings.maxHeapBytes &&
        finiteNumber(resources.heapGrowthBytes) &&
        resources.heapGrowthBytes <= ceilings.maxHeapGrowthBytes,
      actual: {
        maxHeapBytes: resources.maxHeapBytes ?? null,
        heapGrowthBytes: resources.heapGrowthBytes ?? null,
      },
    },
    {
      label: "full-topology Hyperbet viewer retained bounded DOM resources",
      pass:
        finiteNumber(resources.maxDomNodes) &&
        resources.maxDomNodes <= ceilings.maxDomNodes &&
        finiteNumber(resources.maxDocuments) &&
        resources.maxDocuments <= ceilings.maxDocuments,
      actual: {
        maxDomNodes: resources.maxDomNodes ?? null,
        maxDocuments: resources.maxDocuments ?? null,
      },
    },
  ];
}
