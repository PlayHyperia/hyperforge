import fs from "node:fs/promises";
import {
  normalizeStreamingPerformanceSnapshot,
  type StreamingPerformanceSnapshot,
} from "@hyperforge/shared";

/** A single RTMP destination entry from the external status file. */
export interface ExternalRtmpDestination {
  url?: string;
  status?: string;
  connected?: boolean;
  /** External encoders may include additional fields. */
  [key: string]: unknown;
}

/** Aggregate stream statistics from the external RTMP encoder. */
export interface ExternalRtmpStreamStats {
  bitrate?: number;
  fps?: number;
  uptime?: number;
  bytesReceived?: number;
  droppedFrames?: number;
  healthy?: boolean;
  ffmpegRunning?: boolean;
  clientConnected?: boolean;
  audioSource?: "uninitialized" | "browser" | "pulse" | "silent";
  audioHealthy?: boolean;
  audioLastChunkAt?: number | null;
  audioChunks?: number;
  audioDroppedChunks?: number;
  audioTrimmedChunks?: number;
  /** External encoders may include additional fields. */
  [key: string]: unknown;
}

/** Renderer health blob written by the capture pipeline. */
export interface ExternalRendererHealthBlob {
  ready?: boolean;
  degradedReason?: string | null;
  updatedAt?: number | null;
  phase?: string | null;
  diagnostics?: {
    sceneReadiness?: {
      ready: boolean;
      cycleId: string | null;
      phase: string | null;
      equipmentVisualsReady: boolean;
      equipmentConfigured: boolean;
      equipmentCycleId: string | null;
      equipmentRequiredCount: number;
      equipmentRequiredPlayerCount: number;
      equipmentReadyCount: number;
      equipmentExpectedPlayerCount: number;
      equipmentActiveVisualCount: number;
      equipmentActiveVisibleCount: number;
      equipmentActivePlayerCount: number;
      equipmentActiveVisiblePlayerCount: number;
      equipmentUnresolvedCount: number;
      equipmentAttachmentMismatchCount: number;
      expectedAgentCount: number;
    };
  };
}

export interface ExternalCaptureHealthBlob {
  mode: "cdp" | "mediarecorder" | "webcodecs";
  targetFps: number;
  measuredFps: number | null;
  receivedFrames: number | null;
  droppedFrames: number | null;
  acknowledgementPacing: boolean;
}

type ExternalBrowserAudioTrackState = "live" | "ended";

/** Scalar-only health evidence for the browser-owned game master mix. */
export interface ExternalBrowserAudioCaptureHealthBlob {
  contextState: AudioContextState | null;
  sourceContextState: AudioContextState | null;
  trackState: ExternalBrowserAudioTrackState | null;
  sampleRate: number | null;
  channels: number | null;
  chunks: number;
  bytes: number;
  contentChunks: number;
  contentThreshold: number | null;
  lastSamplePeak: number | null;
  maxSamplePeak: number | null;
  lastContentChunkAt: number | null;
  droppedChunks: number;
  pendingWrites: number;
  lastChunkAt: number | null;
  observedAt: number | null;
}

/**
 * Typed snapshot from the external RTMP status file. Only allowlisted fields
 * are preserved after parsing — unknown keys in the source JSON are stripped
 * to prevent arbitrary data from being forwarded to API consumers.
 */
export interface ExternalRtmpStatusSnapshot {
  destinations: ExternalRtmpDestination[];
  stats: ExternalRtmpStreamStats;
  updatedAt: number;
  captureHealth?: ExternalCaptureHealthBlob;
  browserAudioCaptureHealth?: ExternalBrowserAudioCaptureHealthBlob;
  rendererHealth?: ExternalRendererHealthBlob;
  rendererPerformance?: StreamingPerformanceSnapshot;
}

type ExternalStatusPoller = {
  snapshot: ExternalRtmpStatusSnapshot | null;
  refreshPromise: Promise<void> | null;
  interval: ReturnType<typeof setInterval>;
  refCount: number;
};

const externalStatusPollers = new Map<string, ExternalStatusPoller>();

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedDiagnosticCounter(value: unknown, maximum: number): number {
  const normalized = asFiniteNumber(value);
  if (normalized === null || normalized <= 0) return 0;
  return Math.min(maximum, Math.floor(normalized));
}

function boundedDiagnosticText(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function normalizeExternalRendererDiagnostics(
  value: unknown,
): NonNullable<ExternalRendererHealthBlob["diagnostics"]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const diagnostics = value as Record<string, unknown>;
  const rawSceneReadiness = diagnostics.sceneReadiness;
  if (
    !rawSceneReadiness ||
    typeof rawSceneReadiness !== "object" ||
    Array.isArray(rawSceneReadiness)
  ) {
    return null;
  }
  const scene = rawSceneReadiness as Record<string, unknown>;
  return {
    sceneReadiness: {
      ready: scene.ready === true,
      cycleId: boundedDiagnosticText(scene.cycleId, 128),
      phase: boundedDiagnosticText(scene.phase, 32),
      equipmentVisualsReady: scene.equipmentVisualsReady === true,
      equipmentConfigured: scene.equipmentConfigured === true,
      equipmentCycleId: boundedDiagnosticText(scene.equipmentCycleId, 128),
      equipmentRequiredCount: boundedDiagnosticCounter(
        scene.equipmentRequiredCount,
        10_000,
      ),
      equipmentRequiredPlayerCount: boundedDiagnosticCounter(
        scene.equipmentRequiredPlayerCount,
        64,
      ),
      equipmentReadyCount: boundedDiagnosticCounter(
        scene.equipmentReadyCount,
        10_000,
      ),
      equipmentExpectedPlayerCount: boundedDiagnosticCounter(
        scene.equipmentExpectedPlayerCount,
        64,
      ),
      equipmentActiveVisualCount: boundedDiagnosticCounter(
        scene.equipmentActiveVisualCount,
        10_000,
      ),
      equipmentActiveVisibleCount: boundedDiagnosticCounter(
        scene.equipmentActiveVisibleCount,
        10_000,
      ),
      equipmentActivePlayerCount: boundedDiagnosticCounter(
        scene.equipmentActivePlayerCount,
        64,
      ),
      equipmentActiveVisiblePlayerCount: boundedDiagnosticCounter(
        scene.equipmentActiveVisiblePlayerCount,
        64,
      ),
      equipmentUnresolvedCount: boundedDiagnosticCounter(
        scene.equipmentUnresolvedCount,
        10_000,
      ),
      equipmentAttachmentMismatchCount: boundedDiagnosticCounter(
        scene.equipmentAttachmentMismatchCount,
        10_000,
      ),
      expectedAgentCount: boundedDiagnosticCounter(
        scene.expectedAgentCount,
        64,
      ),
    },
  };
}

function normalizeExternalRendererHealth(
  value: unknown,
): ExternalRendererHealthBlob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const normalized: ExternalRendererHealthBlob = {
    ready: candidate.ready === true,
    degradedReason:
      typeof candidate.degradedReason === "string"
        ? candidate.degradedReason.slice(0, 180)
        : null,
    updatedAt: asFiniteNumber(candidate.updatedAt),
    phase:
      typeof candidate.phase === "string" ? candidate.phase.slice(0, 32) : null,
  };
  const diagnostics = normalizeExternalRendererDiagnostics(
    candidate.diagnostics,
  );
  if (diagnostics) normalized.diagnostics = diagnostics;
  return normalized;
}

function normalizeCounter(value: unknown): number | null {
  const normalized = asFiniteNumber(value);
  if (normalized === null || normalized < 0) return null;
  return Math.floor(normalized);
}

function normalizeExternalCaptureHealth(
  value: unknown,
): ExternalCaptureHealthBlob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode;
  if (mode !== "cdp" && mode !== "mediarecorder" && mode !== "webcodecs") {
    return null;
  }
  const targetFps = asFiniteNumber(candidate.targetFps);
  if (targetFps === null || targetFps < 1 || targetFps > 60) return null;
  const measuredFps = asFiniteNumber(candidate.measuredFps);
  if (measuredFps !== null && (measuredFps < 0 || measuredFps > 240)) {
    return null;
  }

  return {
    mode,
    targetFps,
    measuredFps,
    receivedFrames: normalizeCounter(candidate.receivedFrames),
    droppedFrames: normalizeCounter(candidate.droppedFrames),
    acknowledgementPacing: candidate.acknowledgementPacing === true,
  };
}

function normalizeExternalBrowserAudioCaptureHealth(
  value: unknown,
): ExternalBrowserAudioCaptureHealthBlob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const audioContextState = (input: unknown): AudioContextState | null =>
    input === "suspended" ||
    input === "running" ||
    input === "closed" ||
    input === "interrupted"
      ? input
      : null;
  const trackState = (input: unknown): ExternalBrowserAudioTrackState | null =>
    input === "live" || input === "ended" ? input : null;
  const sampleRate = asFiniteNumber(candidate.sampleRate);
  const channels = normalizeCounter(candidate.channels);
  const boundedAmplitude = (input: unknown): number | null => {
    const amplitude = asFiniteNumber(input);
    return amplitude !== null && amplitude >= 0 && amplitude <= 64
      ? amplitude
      : null;
  };

  return {
    contextState: audioContextState(candidate.contextState),
    sourceContextState: audioContextState(candidate.sourceContextState),
    trackState: trackState(candidate.trackState),
    sampleRate:
      sampleRate !== null && sampleRate > 0 && sampleRate <= 384_000
        ? sampleRate
        : null,
    channels:
      channels !== null && channels >= 1 && channels <= 32 ? channels : null,
    chunks: normalizeCounter(candidate.chunks) ?? 0,
    bytes: normalizeCounter(candidate.bytes) ?? 0,
    contentChunks: normalizeCounter(candidate.contentChunks) ?? 0,
    contentThreshold: boundedAmplitude(candidate.contentThreshold),
    lastSamplePeak: boundedAmplitude(candidate.lastSamplePeak),
    maxSamplePeak: boundedAmplitude(candidate.maxSamplePeak),
    lastContentChunkAt: asFiniteNumber(candidate.lastContentChunkAt),
    droppedChunks: normalizeCounter(candidate.droppedChunks) ?? 0,
    pendingWrites: normalizeCounter(candidate.pendingWrites) ?? 0,
    lastChunkAt: asFiniteNumber(candidate.lastChunkAt),
    observedAt: asFiniteNumber(candidate.observedAt),
  };
}

/**
 * Parse and validate the external RTMP status JSON, stripping unknown keys.
 *
 * Only `destinations`, `stats`, `updatedAt`, bounded capture/renderer health,
 * and a validated `rendererPerformance` snapshot are forwarded. Any extra
 * keys in the source file are silently dropped so tampered files cannot inject
 * arbitrary data into API responses.
 */
export function parseExternalRtmpStatusSnapshot(
  raw: string,
  externalStatusMaxAgeMs: number,
  options?: { allowStale?: boolean },
): ExternalRtmpStatusSnapshot | null {
  try {
    const normalized = raw.trim();
    if (!normalized) return null;
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    if (!Array.isArray(parsed.destinations)) return null;
    if (typeof parsed.stats !== "object" || parsed.stats == null) return null;

    const updatedAt = asFiniteNumber(Number(parsed.updatedAt || 0)) ?? 0;
    if (
      !options?.allowStale &&
      updatedAt > 0 &&
      Date.now() - updatedAt > externalStatusMaxAgeMs
    ) {
      return null;
    }

    // Allowlist: only forward known fields.
    const snapshot: ExternalRtmpStatusSnapshot = {
      destinations: parsed.destinations as ExternalRtmpDestination[],
      stats: parsed.stats as ExternalRtmpStreamStats,
      updatedAt,
    };

    const rendererHealth = normalizeExternalRendererHealth(
      parsed.rendererHealth,
    );
    if (rendererHealth) snapshot.rendererHealth = rendererHealth;

    const captureHealth = normalizeExternalCaptureHealth(parsed.captureHealth);
    if (captureHealth) snapshot.captureHealth = captureHealth;

    const browserAudioCaptureHealth =
      normalizeExternalBrowserAudioCaptureHealth(
        parsed.browserAudioCaptureHealth,
      );
    if (browserAudioCaptureHealth) {
      snapshot.browserAudioCaptureHealth = browserAudioCaptureHealth;
    }

    const rendererPerformance = normalizeStreamingPerformanceSnapshot(
      parsed.rendererPerformance,
    );
    if (rendererPerformance) {
      snapshot.rendererPerformance = rendererPerformance;
    }

    return snapshot;
  } catch {
    return null;
  }
}

export async function loadExternalRtmpStatusSnapshot(
  externalStatusFile: string | null,
  externalStatusMaxAgeMs: number,
  options?: { allowStale?: boolean },
): Promise<ExternalRtmpStatusSnapshot | null> {
  if (!externalStatusFile) return null;
  try {
    const raw = await fs.readFile(externalStatusFile, "utf8");
    return parseExternalRtmpStatusSnapshot(
      raw,
      externalStatusMaxAgeMs,
      options,
    );
  } catch (error) {
    // The bridge creates this file only after the renderer and encoder are
    // ready. Absence is therefore an expected startup/unavailable state, not
    // an operational warning. Preserve warnings for permission, I/O, and
    // other unexpected failures that an operator can act on.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    console.warn(
      `[ExternalRtmpStatus] Failed to read status file "${externalStatusFile}":`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function getExternalStatusPollerKey(
  externalStatusFile: string,
  externalStatusMaxAgeMs: number,
): string {
  return `${externalStatusFile}::${externalStatusMaxAgeMs}`;
}

/** Keep health observations comfortably inside the stale-status boundary. */
export function resolveExternalStatusRefreshIntervalMs(
  externalStatusMaxAgeMs: number,
): number {
  if (!Number.isFinite(externalStatusMaxAgeMs)) return 500;
  return Math.max(250, Math.min(500, Math.floor(externalStatusMaxAgeMs / 4)));
}

async function refreshExternalStatusPoller(
  poller: ExternalStatusPoller,
  externalStatusFile: string,
  externalStatusMaxAgeMs: number,
): Promise<void> {
  if (poller.refreshPromise) {
    return poller.refreshPromise;
  }
  poller.refreshPromise = (async () => {
    const nextSnapshot = await loadExternalRtmpStatusSnapshot(
      externalStatusFile,
      externalStatusMaxAgeMs,
      { allowStale: true },
    );
    if (nextSnapshot) {
      poller.snapshot = nextSnapshot;
    }
  })().finally(() => {
    poller.refreshPromise = null;
  });
  return poller.refreshPromise;
}

export function acquireExternalStatusPoller(
  externalStatusFile: string | null,
  externalStatusMaxAgeMs: number,
): {
  getSnapshot(): ExternalRtmpStatusSnapshot | null;
  refresh(): Promise<void>;
  release(): void;
} | null {
  if (!externalStatusFile) {
    return null;
  }

  const key = getExternalStatusPollerKey(
    externalStatusFile,
    externalStatusMaxAgeMs,
  );
  let poller = externalStatusPollers.get(key);
  if (!poller) {
    const refreshIntervalMs = resolveExternalStatusRefreshIntervalMs(
      externalStatusMaxAgeMs,
    );
    poller = {
      snapshot: null,
      refreshPromise: null,
      interval: setInterval(() => {
        void refreshExternalStatusPoller(
          poller!,
          externalStatusFile,
          externalStatusMaxAgeMs,
        );
      }, refreshIntervalMs),
      refCount: 0,
    };
    externalStatusPollers.set(key, poller);
    void refreshExternalStatusPoller(
      poller,
      externalStatusFile,
      externalStatusMaxAgeMs,
    );
  }

  poller.refCount += 1;
  return {
    getSnapshot: () => poller?.snapshot ?? null,
    refresh: () =>
      refreshExternalStatusPoller(
        poller!,
        externalStatusFile,
        externalStatusMaxAgeMs,
      ),
    release: () => {
      if (!poller) {
        return;
      }
      poller.refCount = Math.max(0, poller.refCount - 1);
      if (poller.refCount > 0) {
        return;
      }
      clearInterval(poller.interval);
      externalStatusPollers.delete(key);
    },
  };
}
