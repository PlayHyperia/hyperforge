const DURATION_FIELDS = Object.freeze([
  "samples",
  "average",
  "p50",
  "p95",
  "p99",
  "max",
]);
const RESOURCE_CATEGORIES = new Set([
  "model",
  "audio",
  "image",
  "font",
  "video",
  "script",
  "style",
  "api",
  "other",
]);
const MAX_LONG_FRAME_SAMPLES = 128;
const MAX_LONG_FRAME_SYSTEMS = 8;
const LONG_FRAME_THRESHOLD_MS = 50;

export function classifySseSequence(previousSeq, nextSeq) {
  if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
    return {
      nextSeq: previousSeq,
      gapEvents: 0,
      duplicateEvents: 0,
      outOfOrderEvents: 0,
    };
  }
  if (!Number.isSafeInteger(previousSeq) || previousSeq <= 0) {
    return {
      nextSeq,
      gapEvents: 0,
      duplicateEvents: 0,
      outOfOrderEvents: 0,
    };
  }
  if (nextSeq === previousSeq) {
    return {
      nextSeq: previousSeq,
      gapEvents: 0,
      duplicateEvents: 1,
      outOfOrderEvents: 0,
    };
  }
  if (nextSeq < previousSeq) {
    return {
      nextSeq: previousSeq,
      gapEvents: 0,
      duplicateEvents: 0,
      outOfOrderEvents: 1,
    };
  }
  return {
    nextSeq,
    gapEvents: Math.max(0, nextSeq - previousSeq - 1),
    duplicateEvents: 0,
    outOfOrderEvents: 0,
  };
}

export function deriveSseDeliveryOverheadMs(
  observedLagMs,
  configuredPublicDelayMs,
) {
  if (!Number.isFinite(observedLagMs) || observedLagMs < 0) return null;
  const publicDelayMs =
    Number.isFinite(configuredPublicDelayMs) && configuredPublicDelayMs > 0
      ? configuredPublicDelayMs
      : 0;
  return Math.max(0, observedLagMs - publicDelayMs);
}

function finiteNonNegative(value) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : null;
}

function finiteNumber(value) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? numeric
    : null;
}

function finiteNonNegativeInteger(value) {
  const numeric = finiteNonNegative(value);
  return numeric != null && Number.isSafeInteger(numeric) ? numeric : null;
}

function rendererMetricSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const samples = finiteNonNegative(value.samples);
  const average = finiteNonNegative(value.average);
  const latest = finiteNonNegative(value.latest);
  const max = finiteNonNegative(value.max);
  return samples == null || average == null || latest == null || max == null
    ? null
    : { samples, average, latest, max };
}

function durationSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {};
  for (const field of DURATION_FIELDS) {
    const numeric = finiteNonNegative(value[field]);
    if (numeric == null) return null;
    normalized[field] = numeric;
  }
  return normalized;
}

function frameSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const frames = finiteNonNegative(value.frames);
  const frameIntervalMs = durationSnapshot(value.frameIntervalMs);
  const frameWorkMs = durationSnapshot(value.frameWorkMs);
  const cpuMs = durationSnapshot(value.cpuMs);
  const renderSubmitMs = durationSnapshot(value.renderSubmitMs);
  if (
    frames == null ||
    !frameIntervalMs ||
    !frameWorkMs ||
    !cpuMs ||
    !renderSubmitMs
  ) {
    return null;
  }
  const frameBudget = value.frameBudget;
  const renderer = value.renderer;
  const normalizedFrameBudget =
    frameBudget && typeof frameBudget === "object"
      ? {
          above16_67Ms: finiteNonNegative(frameBudget.above16_67Ms),
          above33_33Ms: finiteNonNegative(frameBudget.above33_33Ms),
          above50Ms: finiteNonNegative(frameBudget.above50Ms),
          above100Ms: finiteNonNegative(frameBudget.above100Ms),
        }
      : null;
  const normalizedRenderer =
    renderer && typeof renderer === "object"
      ? {
          drawCalls: rendererMetricSnapshot(renderer.drawCalls),
          triangles: rendererMetricSnapshot(renderer.triangles),
          textures: rendererMetricSnapshot(renderer.textures),
          geometries: rendererMetricSnapshot(renderer.geometries),
        }
      : null;
  if (
    !normalizedFrameBudget ||
    Object.values(normalizedFrameBudget).some((entry) => entry == null) ||
    !normalizedRenderer ||
    Object.values(normalizedRenderer).some((entry) => entry == null)
  ) {
    return null;
  }
  return {
    frames,
    frameIntervalMs,
    frameWorkMs,
    cpuMs,
    renderSubmitMs,
    frameBudget: normalizedFrameBudget,
    renderer: normalizedRenderer,
  };
}

function resourceMetricSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const entries = finiteNonNegativeInteger(value.entries);
  const cacheHits = finiteNonNegativeInteger(value.cacheHits);
  const transferBytes = finiteNonNegativeInteger(value.transferBytes);
  const encodedBodyBytes = finiteNonNegativeInteger(value.encodedBodyBytes);
  const decodedBodyBytes = finiteNonNegativeInteger(value.decodedBodyBytes);
  const durationMs = durationSnapshot(value.durationMs);
  const responseWaitMs = durationSnapshot(value.responseWaitMs);
  if (
    entries == null ||
    cacheHits == null ||
    cacheHits > entries ||
    transferBytes == null ||
    encodedBodyBytes == null ||
    decodedBodyBytes == null ||
    !durationMs ||
    !responseWaitMs ||
    durationMs.samples !== entries ||
    responseWaitMs.samples !== entries
  ) {
    return null;
  }
  return {
    entries,
    cacheHits,
    transferBytes,
    encodedBodyBytes,
    decodedBodyBytes,
    durationMs,
    responseWaitMs,
  };
}

function resourceSnapshot(value) {
  const overall = resourceMetricSnapshot(value);
  const rawByCategory = value?.byCategory;
  if (
    !overall ||
    !rawByCategory ||
    typeof rawByCategory !== "object" ||
    Array.isArray(rawByCategory)
  ) {
    return null;
  }

  const categoryEntries = Object.entries(rawByCategory);
  if (categoryEntries.length > RESOURCE_CATEGORIES.size) return null;
  const byCategory = {};
  const totals = {
    entries: 0,
    cacheHits: 0,
    transferBytes: 0,
    encodedBodyBytes: 0,
    decodedBodyBytes: 0,
  };
  for (const [category, rawMetric] of categoryEntries) {
    const metric = resourceMetricSnapshot(rawMetric);
    if (!RESOURCE_CATEGORIES.has(category) || !metric || metric.entries === 0) {
      return null;
    }
    byCategory[category] = metric;
    for (const key of Object.keys(totals)) totals[key] += metric[key];
  }
  if (
    Object.values(totals).some((total) => !Number.isSafeInteger(total)) ||
    Object.entries(totals).some(([key, total]) => total !== overall[key])
  ) {
    return null;
  }
  return { ...overall, byCategory };
}

function resourceEcologySnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = [
    "totalResources",
    "availableResources",
    "depletedResources",
    "manifestResources",
    "resourceVariants",
    "forestryTimers",
    "forestryActiveGatherers",
    "scheduledRespawns",
    "fishingMovementTimers",
    "pendingFishingAreas",
    "playerSkillSnapshots",
    "gatherRateLimits",
    "suspiciousPatternEntries",
  ];
  const normalized = {};
  for (const field of fields) {
    const count = finiteNonNegativeInteger(value[field]);
    if (count == null) return null;
    normalized[field] = count;
  }

  const custodyFields = [
    "activeSessions",
    "pendingRewards",
    "inFlightRewards",
    "retryWaitingRewards",
    "resourceReservations",
    "maxRetryCount",
  ];
  const custody = {};
  for (const field of custodyFields) {
    const count = finiteNonNegativeInteger(value.custody?.[field]);
    if (count == null) return null;
    custody[field] = count;
  }

  if (
    normalized.availableResources + normalized.depletedResources !==
      normalized.totalResources ||
    normalized.manifestResources > normalized.totalResources ||
    normalized.resourceVariants > normalized.totalResources ||
    normalized.forestryTimers > normalized.totalResources ||
    normalized.scheduledRespawns > normalized.totalResources ||
    normalized.fishingMovementTimers > normalized.totalResources ||
    normalized.forestryActiveGatherers > custody.activeSessions ||
    custody.inFlightRewards + custody.retryWaitingRewards >
      custody.pendingRewards ||
    custody.resourceReservations > custody.pendingRewards
  ) {
    return null;
  }

  return { ...normalized, custody };
}

function longFrameSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frameSequence = finiteNonNegativeInteger(value.frameSequence);
  const phase =
    typeof value.phase === "string" && /^[A-Z0-9_-]{1,32}$/.test(value.phase)
      ? value.phase
      : null;
  const phaseFrame = finiteNonNegativeInteger(value.phaseFrame);
  const uptimeMs = finiteNonNegativeInteger(value.uptimeMs);
  const frameIntervalMs =
    value.frameIntervalMs == null
      ? null
      : finiteNonNegative(value.frameIntervalMs);
  const frameWorkMs = finiteNonNegative(value.frameWorkMs);
  const cpuMs = finiteNonNegative(value.cpuMs);
  const renderSubmitMs = finiteNonNegative(value.renderSubmitMs);
  const drawCalls = finiteNonNegativeInteger(value.drawCalls);
  const triangles = finiteNonNegativeInteger(value.triangles);
  const textures = finiteNonNegativeInteger(value.textures);
  const geometries = finiteNonNegativeInteger(value.geometries);
  const jsHeapUsedBytes =
    value.jsHeapUsedBytes == null
      ? null
      : finiteNonNegativeInteger(value.jsHeapUsedBytes);
  const resourceEntries = finiteNonNegativeInteger(value.resourceEntries);
  const rawTopSystems = value.topSystems ?? [];
  if (
    !Array.isArray(rawTopSystems) ||
    rawTopSystems.length > MAX_LONG_FRAME_SYSTEMS
  ) {
    return null;
  }
  const topSystems = [];
  const systemNames = new Set();
  for (const rawTiming of rawTopSystems) {
    if (
      !rawTiming ||
      typeof rawTiming !== "object" ||
      Array.isArray(rawTiming)
    ) {
      return null;
    }
    const name =
      typeof rawTiming.name === "string" &&
      /^[A-Za-z0-9._:-]{1,64}$/.test(rawTiming.name)
        ? rawTiming.name
        : null;
    const fixedUpdateMs = finiteNonNegative(rawTiming.fixedUpdateMs);
    const updateMs = finiteNonNegative(rawTiming.updateMs);
    const lateUpdateMs = finiteNonNegative(rawTiming.lateUpdateMs);
    const totalMs = finiteNonNegative(rawTiming.totalMs);
    const previous = topSystems[topSystems.length - 1];
    if (
      !name ||
      systemNames.has(name) ||
      fixedUpdateMs == null ||
      updateMs == null ||
      lateUpdateMs == null ||
      totalMs == null ||
      Math.abs(fixedUpdateMs + updateMs + lateUpdateMs - totalMs) > 0.05 ||
      (previous && previous.totalMs < totalMs)
    ) {
      return null;
    }
    systemNames.add(name);
    topSystems.push({ name, fixedUpdateMs, updateMs, lateUpdateMs, totalMs });
  }
  if (
    frameSequence == null ||
    frameSequence < 1 ||
    !phase ||
    phaseFrame == null ||
    phaseFrame < 1 ||
    uptimeMs == null ||
    (value.frameIntervalMs != null && frameIntervalMs == null) ||
    frameWorkMs == null ||
    cpuMs == null ||
    renderSubmitMs == null ||
    drawCalls == null ||
    triangles == null ||
    textures == null ||
    geometries == null ||
    (value.jsHeapUsedBytes != null && jsHeapUsedBytes == null) ||
    resourceEntries == null ||
    ((frameIntervalMs == null || frameIntervalMs <= LONG_FRAME_THRESHOLD_MS) &&
      frameWorkMs <= LONG_FRAME_THRESHOLD_MS)
  ) {
    return null;
  }
  return {
    frameSequence,
    phase,
    phaseFrame,
    uptimeMs,
    frameIntervalMs,
    frameWorkMs,
    cpuMs,
    renderSubmitMs,
    drawCalls,
    triangles,
    textures,
    geometries,
    jsHeapUsedBytes,
    resourceEntries,
    topSystems,
  };
}

export function extractServerSoakTelemetry(payload, observedAt = Date.now()) {
  const world = payload?.diagnostics?.world;
  const tickTimings = world?.tickTimingPercentiles;
  if (!tickTimings || typeof tickTimings !== "object") return null;

  const normalizedTimings = {};
  for (const phase of [
    "total",
    "fixedUpdate",
    "update",
    "lateUpdate",
    "commit",
    "unmeasured",
  ]) {
    const normalized = durationSnapshot(tickTimings[phase]);
    if (!normalized) return null;
    normalizedTimings[phase] = normalized;
  }

  const currentMemory = payload.currentMemory;
  const memory =
    currentMemory && typeof currentMemory === "object"
      ? {
          rssMB: finiteNonNegative(currentMemory.rssMB),
          heapUsedMB: finiteNonNegative(currentMemory.heapUsedMB),
          heapTotalMB: finiteNonNegative(currentMemory.heapTotalMB),
          externalMB: finiteNonNegative(currentMemory.externalMB),
        }
      : null;

  const systemTimings = Array.isArray(world.systemTimingPercentiles)
    ? world.systemTimingPercentiles
        .slice(0, 20)
        .map((entry) => {
          const duration = durationSnapshot(entry);
          return duration && typeof entry?.name === "string"
            ? { name: entry.name.slice(0, 80), ...duration }
            : null;
        })
        .filter(Boolean)
    : [];
  const resourceEcology =
    payload?.diagnostics?.resourceEcology == null
      ? null
      : resourceEcologySnapshot(payload.diagnostics.resourceEcology);
  if (payload?.diagnostics?.resourceEcology != null && !resourceEcology) {
    return null;
  }

  return {
    observedAt,
    uptimeMs: finiteNonNegative(payload.uptime),
    memoryTrend:
      typeof payload.trend === "string" ? payload.trend.slice(0, 40) : null,
    growthRateMBPerMin: finiteNumber(payload.growthRateMBPerMin),
    memory,
    tickTimingPercentiles: normalizedTimings,
    systemTimingPercentiles: systemTimings,
    resourceEcology,
  };
}

export function extractRendererSoakTelemetry(payload, observedAt = Date.now()) {
  const performance = payload?.rendererPerformance;
  if (
    !performance ||
    typeof performance !== "object" ||
    performance.schemaVersion !== 1
  ) {
    return null;
  }
  const overall = frameSnapshot(performance.overall);
  if (!overall) return null;
  const resources =
    performance.resources == null
      ? null
      : resourceSnapshot(performance.resources);
  if (performance.resources != null && !resources) return null;
  const rawLongFrames = performance.longFrames ?? [];
  if (
    !Array.isArray(rawLongFrames) ||
    rawLongFrames.length > MAX_LONG_FRAME_SAMPLES
  ) {
    return null;
  }
  const longFrames = [];
  for (const rawLongFrame of rawLongFrames) {
    const longFrame = longFrameSnapshot(rawLongFrame);
    const previous = longFrames[longFrames.length - 1];
    if (
      !longFrame ||
      longFrame.frameSequence > overall.frames ||
      (previous && previous.frameSequence >= longFrame.frameSequence) ||
      (resources && longFrame.resourceEntries > resources.entries) ||
      (!resources && longFrame.resourceEntries !== 0)
    ) {
      return null;
    }
    longFrames.push(longFrame);
  }

  const byPhase = {};
  if (performance.byPhase && typeof performance.byPhase === "object") {
    for (const [phase, value] of Object.entries(performance.byPhase).slice(
      0,
      16,
    )) {
      const normalized = frameSnapshot(value);
      if (normalized) byPhase[phase.slice(0, 32)] = normalized;
    }
  }

  return {
    observedAt,
    sourceUpdatedAt: finiteNonNegative(performance.updatedAt),
    uptimeMs: finiteNonNegative(performance.uptimeMs),
    currentPhase:
      typeof performance.currentPhase === "string"
        ? performance.currentPhase.slice(0, 32)
        : null,
    overall,
    byPhase,
    jsHeap: performance.jsHeap ?? null,
    viewport: performance.viewport ?? null,
    resources,
    longFrames,
  };
}

class RetainedSeries {
  constructor(retentionIntervalMs, maxSamples) {
    this.retentionIntervalMs = retentionIntervalMs;
    this.maxSamples = maxSamples;
    this.polls = 0;
    this.failures = 0;
    this.latest = null;
    this.samples = [];
    this.lastRetainedAt = 0;
  }

  observe(sample, observedAt) {
    this.polls += 1;
    if (!sample) {
      this.failures += 1;
      return;
    }
    this.latest = sample;
    if (
      this.samples.length === 0 ||
      observedAt - this.lastRetainedAt >= this.retentionIntervalMs
    ) {
      if (this.samples.length >= this.maxSamples) this.samples.shift();
      this.samples.push(sample);
      this.lastRetainedAt = observedAt;
    }
  }

  fail() {
    this.polls += 1;
    this.failures += 1;
  }

  summary(configured) {
    return {
      configured,
      polls: this.polls,
      failures: this.failures,
      retainedSamples: this.samples.length,
      latest: this.latest,
      timeSeries: [...this.samples],
    };
  }
}

export class StreamingSoakTelemetryCollector {
  constructor({ retentionIntervalMs = 60_000, maxSamples = 10_000 } = {}) {
    const interval = Math.max(1_000, retentionIntervalMs);
    const limit = Math.max(1, maxSamples);
    this.server = new RetainedSeries(interval, limit);
    this.renderer = new RetainedSeries(interval, limit);
  }

  observeServer(payload, observedAt = Date.now()) {
    this.server.observe(
      extractServerSoakTelemetry(payload, observedAt),
      observedAt,
    );
  }

  observeRenderer(payload, observedAt = Date.now()) {
    this.renderer.observe(
      extractRendererSoakTelemetry(payload, observedAt),
      observedAt,
    );
  }

  recordServerFailure() {
    this.server.fail();
  }

  recordRendererFailure() {
    this.renderer.fail();
  }

  summary({ serverConfigured = false } = {}) {
    return {
      server: this.server.summary(serverConfigured),
      renderer: this.renderer.summary(true),
    };
  }
}

export function buildStreamingTelemetryChecks(
  summary,
  {
    requireServerTelemetry = false,
    requireRendererTelemetry = false,
    requireResourceTelemetry = false,
    requireResourceEcologyTelemetry = false,
  } = {},
) {
  const checks = [];
  if (requireServerTelemetry) {
    checks.push({
      label: "server tick/memory telemetry retained without poll failures",
      pass:
        summary.server.configured &&
        summary.server.retainedSamples > 0 &&
        summary.server.failures === 0,
      actual: `${summary.server.retainedSamples} samples, ${summary.server.failures} failures`,
    });
  }
  if (requireRendererTelemetry) {
    checks.push({
      label: "renderer frame telemetry retained without poll failures",
      pass:
        summary.renderer.retainedSamples > 0 && summary.renderer.failures === 0,
      actual: `${summary.renderer.retainedSamples} samples, ${summary.renderer.failures} failures`,
    });
  }
  if (requireResourceTelemetry) {
    const resources = summary.renderer.latest?.resources;
    checks.push({
      label: "renderer asset/network timing retained with at least one entry",
      pass:
        summary.renderer.failures === 0 &&
        resources != null &&
        resources.entries > 0,
      actual: `${resources?.entries ?? 0} entries, ${summary.renderer.failures} failures`,
    });
  }
  if (requireResourceEcologyTelemetry) {
    const resourceEcology = summary.server.latest?.resourceEcology;
    checks.push({
      label:
        "server resource ecology telemetry retained and internally consistent",
      pass:
        summary.server.configured &&
        summary.server.failures === 0 &&
        resourceEcology != null,
      actual: `${resourceEcology?.totalResources ?? 0} resources, ${summary.server.failures} failures`,
    });
  }
  return checks;
}
