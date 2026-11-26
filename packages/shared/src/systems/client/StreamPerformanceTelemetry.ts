import {
  DurationHistogram,
  type DurationPercentiles,
} from "../../utils/DurationHistogram";

export type StreamRendererMetricSnapshot = {
  samples: number;
  average: number;
  latest: number;
  max: number;
};

export type StreamFramePerformanceSnapshot = {
  frames: number;
  frameIntervalMs: DurationPercentiles;
  frameWorkMs: DurationPercentiles;
  cpuMs: DurationPercentiles;
  renderSubmitMs: DurationPercentiles;
  frameBudget: {
    above16_67Ms: number;
    above33_33Ms: number;
    above50Ms: number;
    above100Ms: number;
  };
  renderer: {
    drawCalls: StreamRendererMetricSnapshot;
    triangles: StreamRendererMetricSnapshot;
    textures: StreamRendererMetricSnapshot;
    geometries: StreamRendererMetricSnapshot;
  };
};

export const STREAM_RESOURCE_CATEGORIES = [
  "model",
  "audio",
  "image",
  "font",
  "video",
  "script",
  "style",
  "api",
  "other",
] as const;

export type StreamResourceCategory =
  (typeof STREAM_RESOURCE_CATEGORIES)[number];

export type StreamResourceMetricSnapshot = {
  entries: number;
  cacheHits: number;
  transferBytes: number;
  encodedBodyBytes: number;
  decodedBodyBytes: number;
  durationMs: DurationPercentiles;
  responseWaitMs: DurationPercentiles;
};

export type StreamResourcePerformanceSnapshot = StreamResourceMetricSnapshot & {
  byCategory: Partial<
    Record<StreamResourceCategory, StreamResourceMetricSnapshot>
  >;
};

export type StreamLongFrameSample = {
  frameSequence: number;
  phase: string;
  phaseFrame: number;
  uptimeMs: number;
  frameIntervalMs: number | null;
  frameWorkMs: number;
  cpuMs: number;
  renderSubmitMs: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  jsHeapUsedBytes: number | null;
  resourceEntries: number;
  topSystems: StreamSystemFrameTiming[];
};

export type StreamSystemFrameTiming = {
  name: string;
  fixedUpdateMs: number;
  updateMs: number;
  lateUpdateMs: number;
  totalMs: number;
};

export type StreamingPerformanceSnapshot = {
  schemaVersion: 1;
  sessionStartedAt: number;
  updatedAt: number;
  uptimeMs: number;
  currentPhase: string;
  overall: StreamFramePerformanceSnapshot;
  byPhase: Record<string, StreamFramePerformanceSnapshot>;
  jsHeap: {
    usedBytes: number;
    totalBytes: number;
    limitBytes: number;
  } | null;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  } | null;
  resources: StreamResourcePerformanceSnapshot | null;
  longFrames: StreamLongFrameSample[];
};

export type StreamPerformanceFrameSample = {
  phase?: string | null;
  frameIntervalMs?: number | null;
  frameWorkMs: number;
  cpuMs: number;
  renderSubmitMs: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  systemTimings?: ReadonlyArray<{
    name: string;
    fixedUpdate: number;
    update: number;
    lateUpdate: number;
    total: number;
  }>;
  observedAt?: number | null;
  jsHeap?: {
    usedBytes: number;
    totalBytes: number;
    limitBytes: number;
  } | null;
  viewport?: {
    width: number;
    height: number;
    devicePixelRatio: number;
  } | null;
};

export type StreamPerformanceResourceSample = {
  category: StreamResourceCategory;
  durationMs: number;
  responseWaitMs: number;
  transferBytes: number;
  encodedBodyBytes: number;
  decodedBodyBytes: number;
  cacheHit: boolean;
};

const MAX_PHASE_BUCKETS = 16;
const MAX_DURATION_BUCKET_MS = 10_000;
export const STREAM_LONG_FRAME_THRESHOLD_MS = 50;
export const MAX_STREAM_LONG_FRAME_SAMPLES = 128;
export const MAX_STREAM_LONG_FRAME_SYSTEMS = 8;
const STREAM_RESOURCE_CATEGORY_SET = new Set<string>(
  STREAM_RESOURCE_CATEGORIES,
);

const RESOURCE_EXTENSION_CATEGORIES: ReadonlyArray<
  readonly [StreamResourceCategory, ReadonlySet<string>]
> = [
  ["model", new Set(["glb", "gltf", "vrm", "fbx", "obj"])],
  ["audio", new Set(["mp3", "ogg", "wav", "m4a", "aac", "flac"])],
  [
    "image",
    new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "svg", "ktx2"]),
  ],
  ["font", new Set(["woff", "woff2", "ttf", "otf"])],
  ["video", new Set(["mp4", "webm", "mov", "m3u8", "ts"])],
  ["script", new Set(["js", "mjs", "cjs", "wasm"])],
  ["style", new Set(["css"])],
];

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const finite = finiteNonNegative(value);
  return finite != null && Number.isSafeInteger(finite) ? finite : null;
}

function normalizePhase(value: unknown): string {
  if (typeof value !== "string") return "UNSPECIFIED";
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(normalized) ? normalized : "UNSPECIFIED";
}

function normalizeSystemName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
}

function normalizeSystemFrameTiming(
  value: unknown,
): StreamSystemFrameTiming | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const name = normalizeSystemName(candidate.name);
  const fixedUpdateMs = finiteNonNegative(candidate.fixedUpdateMs);
  const updateMs = finiteNonNegative(candidate.updateMs);
  const lateUpdateMs = finiteNonNegative(candidate.lateUpdateMs);
  const totalMs = finiteNonNegative(candidate.totalMs);
  if (
    !name ||
    fixedUpdateMs == null ||
    updateMs == null ||
    lateUpdateMs == null ||
    totalMs == null ||
    Math.abs(fixedUpdateMs + updateMs + lateUpdateMs - totalMs) > 0.05
  ) {
    return null;
  }
  return { name, fixedUpdateMs, updateMs, lateUpdateMs, totalMs };
}

function selectSystemFrameTimings(
  timings: StreamPerformanceFrameSample["systemTimings"],
): StreamSystemFrameTiming[] {
  if (!timings) return [];
  const normalized: StreamSystemFrameTiming[] = [];
  const names = new Set<string>();
  for (const timing of timings) {
    const name = normalizeSystemName(timing.name);
    const fixedUpdateMs = finiteNonNegative(timing.fixedUpdate);
    const updateMs = finiteNonNegative(timing.update);
    const lateUpdateMs = finiteNonNegative(timing.lateUpdate);
    const totalMs = finiteNonNegative(timing.total);
    if (
      !name ||
      names.has(name) ||
      fixedUpdateMs == null ||
      updateMs == null ||
      lateUpdateMs == null ||
      totalMs == null
    ) {
      continue;
    }
    names.add(name);
    normalized.push({
      name,
      fixedUpdateMs: round(fixedUpdateMs),
      updateMs: round(updateMs),
      lateUpdateMs: round(lateUpdateMs),
      totalMs: round(totalMs),
    });
  }
  return normalized
    .sort((left, right) => {
      if (right.totalMs !== left.totalMs) return right.totalMs - left.totalMs;
      return left.name.localeCompare(right.name);
    })
    .slice(0, MAX_STREAM_LONG_FRAME_SYSTEMS);
}

function normalizeResourceCategory(value: unknown): StreamResourceCategory {
  return typeof value === "string" && STREAM_RESOURCE_CATEGORY_SET.has(value)
    ? (value as StreamResourceCategory)
    : "other";
}

/**
 * Reduce a resource URL and browser initiator into a fixed, non-identifying
 * category. The URL itself never enters a telemetry snapshot.
 */
export function classifyStreamResourceCategory(
  resourceName: string,
  initiatorType: string,
): StreamResourceCategory {
  let extension = "";
  try {
    const pathname = new URL(resourceName, "https://telemetry.invalid")
      .pathname;
    const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
    const extensionSeparator = finalSegment.lastIndexOf(".");
    if (extensionSeparator >= 0) {
      extension = finalSegment.slice(extensionSeparator + 1).toLowerCase();
    }
  } catch {
    extension = "";
  }

  for (const [category, extensions] of RESOURCE_EXTENSION_CATEGORIES) {
    if (extensions.has(extension)) return category;
  }

  const normalizedInitiator = initiatorType.trim().toLowerCase();
  if (normalizedInitiator === "audio") return "audio";
  if (normalizedInitiator === "img" || normalizedInitiator === "image") {
    return "image";
  }
  if (normalizedInitiator === "video") return "video";
  if (normalizedInitiator === "script") return "script";
  if (normalizedInitiator === "css" || normalizedInitiator === "link") {
    return "style";
  }
  if (
    normalizedInitiator === "fetch" ||
    normalizedInitiator === "xmlhttprequest" ||
    normalizedInitiator === "beacon"
  ) {
    return "api";
  }
  return "other";
}

function saturatedIntegerSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

class NumericAccumulator {
  private samples = 0;
  private total = 0;
  private latest = 0;
  private maximum = 0;

  record(rawValue: number): void {
    const value = finiteNonNegative(rawValue);
    if (value == null) return;
    this.samples++;
    this.total += value;
    this.latest = value;
    this.maximum = Math.max(this.maximum, value);
  }

  snapshot(): StreamRendererMetricSnapshot {
    return {
      samples: this.samples,
      average: this.samples > 0 ? round(this.total / this.samples) : 0,
      latest: this.latest,
      max: this.maximum,
    };
  }
}

class FrameAccumulator {
  private frames = 0;
  private readonly frameIntervalMs = new DurationHistogram(
    MAX_DURATION_BUCKET_MS,
  );
  private readonly frameWorkMs = new DurationHistogram(MAX_DURATION_BUCKET_MS);
  private readonly cpuMs = new DurationHistogram(MAX_DURATION_BUCKET_MS);
  private readonly renderSubmitMs = new DurationHistogram(
    MAX_DURATION_BUCKET_MS,
  );
  private above16_67Ms = 0;
  private above33_33Ms = 0;
  private above50Ms = 0;
  private above100Ms = 0;
  private readonly drawCalls = new NumericAccumulator();
  private readonly triangles = new NumericAccumulator();
  private readonly textures = new NumericAccumulator();
  private readonly geometries = new NumericAccumulator();

  record(sample: StreamPerformanceFrameSample): void {
    this.frames++;

    const interval = finiteNonNegative(sample.frameIntervalMs);
    if (interval != null) {
      this.frameIntervalMs.record(interval);
      if (interval > 16.67) this.above16_67Ms++;
      if (interval > 33.33) this.above33_33Ms++;
      if (interval > 50) this.above50Ms++;
      if (interval > 100) this.above100Ms++;
    }

    const frameWork = finiteNonNegative(sample.frameWorkMs);
    if (frameWork != null) this.frameWorkMs.record(frameWork);
    const cpu = finiteNonNegative(sample.cpuMs);
    if (cpu != null) this.cpuMs.record(cpu);
    const renderSubmit = finiteNonNegative(sample.renderSubmitMs);
    if (renderSubmit != null) this.renderSubmitMs.record(renderSubmit);

    this.drawCalls.record(sample.drawCalls);
    this.triangles.record(sample.triangles);
    this.textures.record(sample.textures);
    this.geometries.record(sample.geometries);
  }

  snapshot(): StreamFramePerformanceSnapshot {
    return {
      frames: this.frames,
      frameIntervalMs: this.frameIntervalMs.snapshot(),
      frameWorkMs: this.frameWorkMs.snapshot(),
      cpuMs: this.cpuMs.snapshot(),
      renderSubmitMs: this.renderSubmitMs.snapshot(),
      frameBudget: {
        above16_67Ms: this.above16_67Ms,
        above33_33Ms: this.above33_33Ms,
        above50Ms: this.above50Ms,
        above100Ms: this.above100Ms,
      },
      renderer: {
        drawCalls: this.drawCalls.snapshot(),
        triangles: this.triangles.snapshot(),
        textures: this.textures.snapshot(),
        geometries: this.geometries.snapshot(),
      },
    };
  }
}

class ResourceAccumulator {
  private entries = 0;
  private cacheHits = 0;
  private transferBytes = 0;
  private encodedBodyBytes = 0;
  private decodedBodyBytes = 0;
  private readonly durationMs = new DurationHistogram(MAX_DURATION_BUCKET_MS);
  private readonly responseWaitMs = new DurationHistogram(
    MAX_DURATION_BUCKET_MS,
  );

  record(sample: StreamPerformanceResourceSample): boolean {
    const durationMs = finiteNonNegative(sample.durationMs);
    const responseWaitMs = finiteNonNegative(sample.responseWaitMs);
    const transferBytes = finiteNonNegativeInteger(sample.transferBytes);
    const encodedBodyBytes = finiteNonNegativeInteger(sample.encodedBodyBytes);
    const decodedBodyBytes = finiteNonNegativeInteger(sample.decodedBodyBytes);
    if (
      durationMs == null ||
      responseWaitMs == null ||
      transferBytes == null ||
      encodedBodyBytes == null ||
      decodedBodyBytes == null
    ) {
      return false;
    }

    this.entries = saturatedIntegerSum(this.entries, 1);
    if (sample.cacheHit) {
      this.cacheHits = saturatedIntegerSum(this.cacheHits, 1);
    }
    this.transferBytes = saturatedIntegerSum(this.transferBytes, transferBytes);
    this.encodedBodyBytes = saturatedIntegerSum(
      this.encodedBodyBytes,
      encodedBodyBytes,
    );
    this.decodedBodyBytes = saturatedIntegerSum(
      this.decodedBodyBytes,
      decodedBodyBytes,
    );
    this.durationMs.record(durationMs);
    this.responseWaitMs.record(responseWaitMs);
    return true;
  }

  snapshot(): StreamResourceMetricSnapshot {
    return {
      entries: this.entries,
      cacheHits: this.cacheHits,
      transferBytes: this.transferBytes,
      encodedBodyBytes: this.encodedBodyBytes,
      decodedBodyBytes: this.decodedBodyBytes,
      durationMs: this.durationMs.snapshot(),
      responseWaitMs: this.responseWaitMs.snapshot(),
    };
  }

  get entryCount(): number {
    return this.entries;
  }
}

/**
 * Bounded, allocation-light stream renderer telemetry. Histograms retain the
 * complete browser session at one-millisecond resolution while phase maps and
 * renderer aggregates have fixed upper bounds.
 */
export class StreamPerformanceTelemetry {
  private readonly overall = new FrameAccumulator();
  private readonly byPhase = new Map<string, FrameAccumulator>();
  private currentPhase = "UNSPECIFIED";
  private frameSequence = 0;
  private phaseFrame = 0;
  private jsHeap: StreamingPerformanceSnapshot["jsHeap"] = null;
  private viewport: StreamingPerformanceSnapshot["viewport"] = null;
  private resources: ResourceAccumulator | null = null;
  private readonly resourcesByCategory = new Map<
    StreamResourceCategory,
    ResourceAccumulator
  >();
  private readonly longFrames: StreamLongFrameSample[] = [];

  constructor(private readonly sessionStartedAt: number = Date.now()) {}

  record(sample: StreamPerformanceFrameSample): void {
    const phase = normalizePhase(sample.phase);
    if (phase !== this.currentPhase) {
      this.currentPhase = phase;
      this.phaseFrame = 0;
    }
    this.frameSequence++;
    this.phaseFrame++;
    this.overall.record(sample);

    let phaseAccumulator = this.byPhase.get(this.currentPhase);
    if (!phaseAccumulator) {
      const phaseKey =
        this.byPhase.size < MAX_PHASE_BUCKETS ? this.currentPhase : "OTHER";
      phaseAccumulator = this.byPhase.get(phaseKey);
      if (!phaseAccumulator) {
        phaseAccumulator = new FrameAccumulator();
        this.byPhase.set(phaseKey, phaseAccumulator);
      }
    }
    phaseAccumulator.record(sample);

    if (sample.jsHeap) {
      const usedBytes = finiteNonNegativeInteger(sample.jsHeap.usedBytes);
      const totalBytes = finiteNonNegativeInteger(sample.jsHeap.totalBytes);
      const limitBytes = finiteNonNegativeInteger(sample.jsHeap.limitBytes);
      if (usedBytes != null && totalBytes != null && limitBytes != null) {
        this.jsHeap = { usedBytes, totalBytes, limitBytes };
      }
    }

    if (sample.viewport) {
      const width = finiteNonNegativeInteger(sample.viewport.width);
      const height = finiteNonNegativeInteger(sample.viewport.height);
      const devicePixelRatio = finiteNonNegative(
        sample.viewport.devicePixelRatio,
      );
      if (width != null && height != null && devicePixelRatio != null) {
        this.viewport = { width, height, devicePixelRatio };
      }
    }

    this.recordLongFrame(sample);
  }

  private recordLongFrame(sample: StreamPerformanceFrameSample): void {
    const frameIntervalMs = finiteNonNegative(sample.frameIntervalMs);
    const frameWorkMs = finiteNonNegative(sample.frameWorkMs);
    if (
      (frameIntervalMs == null ||
        frameIntervalMs <= STREAM_LONG_FRAME_THRESHOLD_MS) &&
      (frameWorkMs == null || frameWorkMs <= STREAM_LONG_FRAME_THRESHOLD_MS)
    ) {
      return;
    }

    const cpuMs = finiteNonNegative(sample.cpuMs);
    const renderSubmitMs = finiteNonNegative(sample.renderSubmitMs);
    const drawCalls = finiteNonNegativeInteger(sample.drawCalls);
    const triangles = finiteNonNegativeInteger(sample.triangles);
    const textures = finiteNonNegativeInteger(sample.textures);
    const geometries = finiteNonNegativeInteger(sample.geometries);
    if (
      frameWorkMs == null ||
      cpuMs == null ||
      renderSubmitMs == null ||
      drawCalls == null ||
      triangles == null ||
      textures == null ||
      geometries == null
    ) {
      return;
    }

    const observedAt = finiteNonNegativeInteger(sample.observedAt);
    const uptimeMs =
      observedAt == null ? 0 : Math.max(0, observedAt - this.sessionStartedAt);
    const longFrame: StreamLongFrameSample = {
      frameSequence: this.frameSequence,
      phase: this.currentPhase,
      phaseFrame: this.phaseFrame,
      uptimeMs,
      frameIntervalMs: frameIntervalMs == null ? null : round(frameIntervalMs),
      frameWorkMs: round(frameWorkMs),
      cpuMs: round(cpuMs),
      renderSubmitMs: round(renderSubmitMs),
      drawCalls,
      triangles,
      textures,
      geometries,
      jsHeapUsedBytes: this.jsHeap?.usedBytes ?? null,
      resourceEntries: this.resources?.entryCount ?? 0,
      topSystems: selectSystemFrameTimings(sample.systemTimings),
    };
    if (this.longFrames.length >= MAX_STREAM_LONG_FRAME_SAMPLES) {
      this.longFrames.shift();
    }
    this.longFrames.push(longFrame);
  }

  enableResourceTimingCollection(): void {
    this.resources ??= new ResourceAccumulator();
  }

  recordResource(sample: StreamPerformanceResourceSample): void {
    this.enableResourceTimingCollection();
    const category = normalizeResourceCategory(sample.category);
    if (!this.resources?.record({ ...sample, category })) return;

    let accumulator = this.resourcesByCategory.get(category);
    if (!accumulator) {
      accumulator = new ResourceAccumulator();
      this.resourcesByCategory.set(category, accumulator);
    }
    accumulator.record({ ...sample, category });
  }

  snapshot(updatedAt: number = Date.now()): StreamingPerformanceSnapshot {
    const safeUpdatedAt = finiteNonNegativeInteger(updatedAt) ?? Date.now();
    return {
      schemaVersion: 1,
      sessionStartedAt: this.sessionStartedAt,
      updatedAt: safeUpdatedAt,
      uptimeMs: Math.max(0, safeUpdatedAt - this.sessionStartedAt),
      currentPhase: this.currentPhase,
      overall: this.overall.snapshot(),
      byPhase: Object.fromEntries(
        [...this.byPhase.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([phase, accumulator]) => [phase, accumulator.snapshot()]),
      ),
      jsHeap: this.jsHeap ? { ...this.jsHeap } : null,
      viewport: this.viewport ? { ...this.viewport } : null,
      resources: this.resources
        ? {
            ...this.resources.snapshot(),
            byCategory: Object.fromEntries(
              [...this.resourcesByCategory.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([category, accumulator]) => [
                  category,
                  accumulator.snapshot(),
                ]),
            ),
          }
        : null,
      longFrames: this.longFrames.map((sample) => ({
        ...sample,
        topSystems: sample.topSystems.map((timing) => ({ ...timing })),
      })),
    };
  }
}

function normalizeDurationPercentiles(
  value: unknown,
): DurationPercentiles | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const samples = finiteNonNegativeInteger(candidate.samples);
  const average = finiteNonNegative(candidate.average);
  const p50 = finiteNonNegative(candidate.p50);
  const p95 = finiteNonNegative(candidate.p95);
  const p99 = finiteNonNegative(candidate.p99);
  const max = finiteNonNegative(candidate.max);
  if (
    samples == null ||
    average == null ||
    p50 == null ||
    p95 == null ||
    p99 == null ||
    max == null ||
    p50 > p95 ||
    p95 > p99 ||
    p99 > max ||
    average > max ||
    (samples === 0 && (average !== 0 || max !== 0))
  ) {
    return null;
  }
  return { samples, average, p50, p95, p99, max };
}

function normalizeRendererMetric(
  value: unknown,
): StreamRendererMetricSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const samples = finiteNonNegativeInteger(candidate.samples);
  const average = finiteNonNegative(candidate.average);
  const latest = finiteNonNegative(candidate.latest);
  const max = finiteNonNegative(candidate.max);
  if (
    samples == null ||
    average == null ||
    latest == null ||
    max == null ||
    average > max ||
    latest > max ||
    (samples === 0 && (average !== 0 || latest !== 0 || max !== 0))
  ) {
    return null;
  }
  return { samples, average, latest, max };
}

function normalizeResourceMetric(
  value: unknown,
): StreamResourceMetricSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const entries = finiteNonNegativeInteger(candidate.entries);
  const cacheHits = finiteNonNegativeInteger(candidate.cacheHits);
  const transferBytes = finiteNonNegativeInteger(candidate.transferBytes);
  const encodedBodyBytes = finiteNonNegativeInteger(candidate.encodedBodyBytes);
  const decodedBodyBytes = finiteNonNegativeInteger(candidate.decodedBodyBytes);
  const durationMs = normalizeDurationPercentiles(candidate.durationMs);
  const responseWaitMs = normalizeDurationPercentiles(candidate.responseWaitMs);
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

function normalizeResourceSnapshot(
  value: unknown,
): StreamResourcePerformanceSnapshot | null {
  const overall = normalizeResourceMetric(value);
  if (!overall || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rawByCategory = (value as Record<string, unknown>).byCategory;
  if (
    !rawByCategory ||
    typeof rawByCategory !== "object" ||
    Array.isArray(rawByCategory)
  ) {
    return null;
  }

  const byCategory: StreamResourcePerformanceSnapshot["byCategory"] = {};
  let entries = 0;
  let cacheHits = 0;
  let transferBytes = 0;
  let encodedBodyBytes = 0;
  let decodedBodyBytes = 0;
  const categoryEntries = Object.entries(
    rawByCategory as Record<string, unknown>,
  );
  if (categoryEntries.length > STREAM_RESOURCE_CATEGORIES.length) return null;
  for (const [rawCategory, rawMetric] of categoryEntries) {
    const category = normalizeResourceCategory(rawCategory);
    const metric = normalizeResourceMetric(rawMetric);
    if (category !== rawCategory || !metric || metric.entries === 0)
      return null;
    byCategory[category] = metric;
    entries += metric.entries;
    cacheHits += metric.cacheHits;
    transferBytes += metric.transferBytes;
    encodedBodyBytes += metric.encodedBodyBytes;
    decodedBodyBytes += metric.decodedBodyBytes;
  }
  if (
    !Number.isSafeInteger(entries) ||
    !Number.isSafeInteger(cacheHits) ||
    !Number.isSafeInteger(transferBytes) ||
    !Number.isSafeInteger(encodedBodyBytes) ||
    !Number.isSafeInteger(decodedBodyBytes) ||
    entries !== overall.entries ||
    cacheHits !== overall.cacheHits ||
    transferBytes !== overall.transferBytes ||
    encodedBodyBytes !== overall.encodedBodyBytes ||
    decodedBodyBytes !== overall.decodedBodyBytes
  ) {
    return null;
  }
  return { ...overall, byCategory };
}

function normalizeFrameSnapshot(
  value: unknown,
): StreamFramePerformanceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const frames = finiteNonNegativeInteger(candidate.frames);
  const frameIntervalMs = normalizeDurationPercentiles(
    candidate.frameIntervalMs,
  );
  const frameWorkMs = normalizeDurationPercentiles(candidate.frameWorkMs);
  const cpuMs = normalizeDurationPercentiles(candidate.cpuMs);
  const renderSubmitMs = normalizeDurationPercentiles(candidate.renderSubmitMs);
  const budget = candidate.frameBudget as Record<string, unknown> | undefined;
  const renderer = candidate.renderer as Record<string, unknown> | undefined;
  const above16_67Ms = finiteNonNegativeInteger(budget?.above16_67Ms);
  const above33_33Ms = finiteNonNegativeInteger(budget?.above33_33Ms);
  const above50Ms = finiteNonNegativeInteger(budget?.above50Ms);
  const above100Ms = finiteNonNegativeInteger(budget?.above100Ms);
  const drawCalls = normalizeRendererMetric(renderer?.drawCalls);
  const triangles = normalizeRendererMetric(renderer?.triangles);
  const textures = normalizeRendererMetric(renderer?.textures);
  const geometries = normalizeRendererMetric(renderer?.geometries);
  if (
    frames == null ||
    !frameIntervalMs ||
    !frameWorkMs ||
    !cpuMs ||
    !renderSubmitMs ||
    above16_67Ms == null ||
    above33_33Ms == null ||
    above50Ms == null ||
    above100Ms == null ||
    above16_67Ms < above33_33Ms ||
    above33_33Ms < above50Ms ||
    above50Ms < above100Ms ||
    above16_67Ms > frameIntervalMs.samples ||
    frameIntervalMs.samples > frames ||
    frameWorkMs.samples > frames ||
    cpuMs.samples > frames ||
    renderSubmitMs.samples > frames ||
    !drawCalls ||
    !triangles ||
    !textures ||
    !geometries ||
    drawCalls.samples > frames ||
    triangles.samples > frames ||
    textures.samples > frames ||
    geometries.samples > frames
  ) {
    return null;
  }
  return {
    frames,
    frameIntervalMs,
    frameWorkMs,
    cpuMs,
    renderSubmitMs,
    frameBudget: {
      above16_67Ms,
      above33_33Ms,
      above50Ms,
      above100Ms,
    },
    renderer: { drawCalls, triangles, textures, geometries },
  };
}

function normalizeLongFrameSample(
  value: unknown,
): StreamLongFrameSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const frameSequence = finiteNonNegativeInteger(candidate.frameSequence);
  const phase = normalizePhase(candidate.phase);
  const phaseFrame = finiteNonNegativeInteger(candidate.phaseFrame);
  const uptimeMs = finiteNonNegativeInteger(candidate.uptimeMs);
  const frameIntervalMs =
    candidate.frameIntervalMs == null
      ? null
      : finiteNonNegative(candidate.frameIntervalMs);
  const frameWorkMs = finiteNonNegative(candidate.frameWorkMs);
  const cpuMs = finiteNonNegative(candidate.cpuMs);
  const renderSubmitMs = finiteNonNegative(candidate.renderSubmitMs);
  const drawCalls = finiteNonNegativeInteger(candidate.drawCalls);
  const triangles = finiteNonNegativeInteger(candidate.triangles);
  const textures = finiteNonNegativeInteger(candidate.textures);
  const geometries = finiteNonNegativeInteger(candidate.geometries);
  const jsHeapUsedBytes =
    candidate.jsHeapUsedBytes == null
      ? null
      : finiteNonNegativeInteger(candidate.jsHeapUsedBytes);
  const resourceEntries = finiteNonNegativeInteger(candidate.resourceEntries);
  const rawTopSystems = candidate.topSystems ?? [];
  if (
    !Array.isArray(rawTopSystems) ||
    rawTopSystems.length > MAX_STREAM_LONG_FRAME_SYSTEMS
  ) {
    return null;
  }
  const topSystems: StreamSystemFrameTiming[] = [];
  const systemNames = new Set<string>();
  for (const rawTiming of rawTopSystems) {
    const timing = normalizeSystemFrameTiming(rawTiming);
    const previous = topSystems[topSystems.length - 1];
    if (
      !timing ||
      systemNames.has(timing.name) ||
      (previous && previous.totalMs < timing.totalMs)
    ) {
      return null;
    }
    systemNames.add(timing.name);
    topSystems.push(timing);
  }
  if (
    frameSequence == null ||
    frameSequence < 1 ||
    phase !== candidate.phase ||
    phaseFrame == null ||
    phaseFrame < 1 ||
    uptimeMs == null ||
    (candidate.frameIntervalMs != null && frameIntervalMs == null) ||
    frameWorkMs == null ||
    cpuMs == null ||
    renderSubmitMs == null ||
    drawCalls == null ||
    triangles == null ||
    textures == null ||
    geometries == null ||
    (candidate.jsHeapUsedBytes != null && jsHeapUsedBytes == null) ||
    resourceEntries == null ||
    ((frameIntervalMs == null ||
      frameIntervalMs <= STREAM_LONG_FRAME_THRESHOLD_MS) &&
      frameWorkMs <= STREAM_LONG_FRAME_THRESHOLD_MS)
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

/** Validate and allowlist a renderer snapshot crossing a process boundary. */
export function normalizeStreamingPerformanceSnapshot(
  value: unknown,
): StreamingPerformanceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return null;

  const sessionStartedAt = finiteNonNegativeInteger(candidate.sessionStartedAt);
  const updatedAt = finiteNonNegativeInteger(candidate.updatedAt);
  const uptimeMs = finiteNonNegativeInteger(candidate.uptimeMs);
  const overall = normalizeFrameSnapshot(candidate.overall);
  const rawByPhase = candidate.byPhase;
  if (
    sessionStartedAt == null ||
    updatedAt == null ||
    uptimeMs == null ||
    updatedAt < sessionStartedAt ||
    uptimeMs !== updatedAt - sessionStartedAt ||
    !overall ||
    !rawByPhase ||
    typeof rawByPhase !== "object" ||
    Array.isArray(rawByPhase)
  ) {
    return null;
  }

  const byPhase: Record<string, StreamFramePerformanceSnapshot> = {};
  const phaseEntries = Object.entries(rawByPhase as Record<string, unknown>);
  if (phaseEntries.length > MAX_PHASE_BUCKETS + 1) return null;
  for (const [rawPhase, rawSnapshot] of phaseEntries) {
    const phase = normalizePhase(rawPhase);
    const snapshot = normalizeFrameSnapshot(rawSnapshot);
    if (phase !== rawPhase || !snapshot) return null;
    byPhase[phase] = snapshot;
  }

  let jsHeap: StreamingPerformanceSnapshot["jsHeap"] = null;
  if (candidate.jsHeap != null) {
    if (
      typeof candidate.jsHeap !== "object" ||
      Array.isArray(candidate.jsHeap)
    ) {
      return null;
    }
    const heap = candidate.jsHeap as Record<string, unknown>;
    const usedBytes = finiteNonNegativeInteger(heap.usedBytes);
    const totalBytes = finiteNonNegativeInteger(heap.totalBytes);
    const limitBytes = finiteNonNegativeInteger(heap.limitBytes);
    if (usedBytes == null || totalBytes == null || limitBytes == null)
      return null;
    jsHeap = { usedBytes, totalBytes, limitBytes };
  }

  let viewport: StreamingPerformanceSnapshot["viewport"] = null;
  if (candidate.viewport != null) {
    if (
      typeof candidate.viewport !== "object" ||
      Array.isArray(candidate.viewport)
    ) {
      return null;
    }
    const dimensions = candidate.viewport as Record<string, unknown>;
    const width = finiteNonNegativeInteger(dimensions.width);
    const height = finiteNonNegativeInteger(dimensions.height);
    const devicePixelRatio = finiteNonNegative(dimensions.devicePixelRatio);
    if (width == null || height == null || devicePixelRatio == null)
      return null;
    viewport = { width, height, devicePixelRatio };
  }

  let resources: StreamingPerformanceSnapshot["resources"] = null;
  if (candidate.resources != null) {
    resources = normalizeResourceSnapshot(candidate.resources);
    if (!resources) return null;
  }

  const rawLongFrames = candidate.longFrames ?? [];
  if (
    !Array.isArray(rawLongFrames) ||
    rawLongFrames.length > MAX_STREAM_LONG_FRAME_SAMPLES
  ) {
    return null;
  }
  const longFrames: StreamLongFrameSample[] = [];
  for (const rawLongFrame of rawLongFrames) {
    const longFrame = normalizeLongFrameSample(rawLongFrame);
    const previous = longFrames[longFrames.length - 1];
    if (
      !longFrame ||
      longFrame.frameSequence > overall.frames ||
      longFrame.uptimeMs > uptimeMs ||
      (previous && previous.frameSequence >= longFrame.frameSequence) ||
      (resources && longFrame.resourceEntries > resources.entries) ||
      (!resources && longFrame.resourceEntries !== 0)
    ) {
      return null;
    }
    longFrames.push(longFrame);
  }

  return {
    schemaVersion: 1,
    sessionStartedAt,
    updatedAt,
    uptimeMs,
    currentPhase: normalizePhase(candidate.currentPhase),
    overall,
    byPhase,
    jsHeap,
    viewport,
    resources,
    longFrames,
  };
}
