import { describe, expect, it } from "vitest";

import {
  parseExternalRtmpStatusSnapshot,
  resolveExternalStatusRefreshIntervalMs,
} from "../streaming-external-status.js";

describe("resolveExternalStatusRefreshIntervalMs", () => {
  it("keeps renderer health sampling inside the fail-closed observation window", () => {
    expect(resolveExternalStatusRefreshIntervalMs(15_000)).toBe(500);
    expect(resolveExternalStatusRefreshIntervalMs(5_000)).toBe(500);
    expect(resolveExternalStatusRefreshIntervalMs(1_000)).toBe(250);
    expect(resolveExternalStatusRefreshIntervalMs(100)).toBe(250);
    expect(resolveExternalStatusRefreshIntervalMs(Number.NaN)).toBe(500);
  });
});

describe("external RTMP renderer diagnostics", () => {
  it("allowlists the scalar equipment contract needed by launch verification", () => {
    const snapshot = parseExternalRtmpStatusSnapshot(
      JSON.stringify({
        destinations: [],
        stats: { healthy: true },
        updatedAt: 1,
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: 2,
          phase: "FIGHTING",
          diagnostics: {
            arbitraryPrivateValue: "must-not-cross",
            sceneReadiness: {
              ready: true,
              cycleId: "cycle-42",
              phase: "FIGHTING",
              equipmentVisualsReady: true,
              equipmentConfigured: true,
              equipmentCycleId: "cycle-42",
              equipmentRequiredCount: 6,
              equipmentRequiredPlayerCount: 2,
              equipmentReadyCount: 6,
              equipmentExpectedPlayerCount: 2,
              equipmentActiveVisualCount: 2,
              equipmentActiveVisibleCount: 2,
              equipmentActivePlayerCount: 2,
              equipmentActiveVisiblePlayerCount: 2,
              equipmentUnresolvedCount: 0,
              equipmentAttachmentMismatchCount: 0,
              expectedAgentCount: 2,
              unresolved: [{ itemId: "private-item-detail" }],
            },
          },
          arbitraryRendererValue: "must-not-cross",
        },
        browserAudioCaptureHealth: {
          contextState: "running",
          sourceContextState: "running",
          trackState: "live",
          sampleRate: 48_000,
          channels: 2,
          chunks: 42,
          bytes: 344_064,
          contentChunks: 40,
          contentThreshold: 0.0001,
          lastSamplePeak: 0.25,
          maxSamplePeak: 0.8,
          lastContentChunkAt: 9,
          droppedChunks: 0,
          pendingWrites: 1,
          lastChunkAt: 10,
          observedAt: 11,
          privateDeviceLabel: "must-not-cross",
        },
      }),
      15_000,
      { allowStale: true },
    );

    expect(snapshot?.rendererHealth).toEqual({
      ready: true,
      degradedReason: null,
      updatedAt: 2,
      phase: "FIGHTING",
      diagnostics: {
        sceneReadiness: {
          ready: true,
          cycleId: "cycle-42",
          phase: "FIGHTING",
          equipmentVisualsReady: true,
          equipmentConfigured: true,
          equipmentCycleId: "cycle-42",
          equipmentRequiredCount: 6,
          equipmentRequiredPlayerCount: 2,
          equipmentReadyCount: 6,
          equipmentExpectedPlayerCount: 2,
          equipmentActiveVisualCount: 2,
          equipmentActiveVisibleCount: 2,
          equipmentActivePlayerCount: 2,
          equipmentActiveVisiblePlayerCount: 2,
          equipmentUnresolvedCount: 0,
          equipmentAttachmentMismatchCount: 0,
          expectedAgentCount: 2,
        },
      },
    });
    expect(snapshot?.rendererHealth).not.toHaveProperty(
      "arbitraryRendererValue",
    );
    expect(snapshot?.rendererHealth?.diagnostics).not.toHaveProperty(
      "arbitraryPrivateValue",
    );
    expect(
      snapshot?.rendererHealth?.diagnostics?.sceneReadiness,
    ).not.toHaveProperty("unresolved");
    expect(snapshot?.browserAudioCaptureHealth).toEqual({
      contextState: "running",
      sourceContextState: "running",
      trackState: "live",
      sampleRate: 48_000,
      channels: 2,
      chunks: 42,
      bytes: 344_064,
      contentChunks: 40,
      contentThreshold: 0.0001,
      lastSamplePeak: 0.25,
      maxSamplePeak: 0.8,
      lastContentChunkAt: 9,
      droppedChunks: 0,
      pendingWrites: 1,
      lastChunkAt: 10,
      observedAt: 11,
    });
    expect(snapshot?.browserAudioCaptureHealth).not.toHaveProperty(
      "privateDeviceLabel",
    );
  });

  it("normalizes malformed and oversized equipment counters", () => {
    const snapshot = parseExternalRtmpStatusSnapshot(
      JSON.stringify({
        destinations: [],
        stats: {},
        updatedAt: 1,
        rendererHealth: {
          diagnostics: {
            sceneReadiness: {
              equipmentRequiredCount: -4,
              equipmentReadyCount: 1_000_000,
              equipmentRequiredPlayerCount: Number.NaN,
              equipmentExpectedPlayerCount: 1_000,
              equipmentActiveVisualCount: 1_000_000,
              equipmentActiveVisibleCount: -1,
              equipmentActivePlayerCount: 1_000,
              equipmentActiveVisiblePlayerCount: Number.NaN,
            },
          },
        },
      }),
      15_000,
      { allowStale: true },
    );

    expect(snapshot?.rendererHealth?.diagnostics?.sceneReadiness).toMatchObject(
      {
        equipmentRequiredCount: 0,
        equipmentReadyCount: 10_000,
        equipmentRequiredPlayerCount: 0,
        equipmentExpectedPlayerCount: 64,
        equipmentActiveVisualCount: 10_000,
        equipmentActiveVisibleCount: 0,
        equipmentActivePlayerCount: 64,
        equipmentActiveVisiblePlayerCount: 0,
      },
    );
  });

  it("fails closed for malformed browser audio scalar evidence", () => {
    const snapshot = parseExternalRtmpStatusSnapshot(
      JSON.stringify({
        destinations: [],
        stats: {},
        updatedAt: 1,
        browserAudioCaptureHealth: {
          contextState: "unknown",
          sourceContextState: {},
          trackState: "stale",
          sampleRate: 1_000_000,
          channels: 0,
          chunks: -1,
          bytes: "100",
          contentChunks: -1,
          contentThreshold: -1,
          lastSamplePeak: 100,
          maxSamplePeak: Number.NaN,
          lastContentChunkAt: "now",
          droppedChunks: -1,
          pendingWrites: -1,
          lastChunkAt: "now",
          observedAt: Number.POSITIVE_INFINITY,
        },
      }),
      15_000,
      { allowStale: true },
    );

    expect(snapshot?.browserAudioCaptureHealth).toEqual({
      contextState: null,
      sourceContextState: null,
      trackState: null,
      sampleRate: null,
      channels: null,
      chunks: 0,
      bytes: 0,
      contentChunks: 0,
      contentThreshold: null,
      lastSamplePeak: null,
      maxSamplePeak: null,
      lastContentChunkAt: null,
      droppedChunks: 0,
      pendingWrites: 0,
      lastChunkAt: null,
      observedAt: null,
    });
  });
});
