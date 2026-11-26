import { describe, expect, it } from "vitest";

import {
  CAPTURE_BROWSER_FRAME_REQUEST_MAX_AGE_MS,
  isCaptureBrowserFrameReadinessQualified,
  parseCaptureBrowserFrameRequest,
  resolveCaptureBrowserFrameIpcConfig,
} from "../capture-browser-frame-request";

const OUTPUT_DIRECTORY = "/private/tmp/hyperia-frame-output";
const NOW_MS = 1_800_000_000_000;

function request(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    requestId: "prep-agent1-0123456789abcdef",
    outputFilename: ".e2e-hyperia-preparation-agent1-frame.png",
    requestedAtMs: NOW_MS,
    expectedCameraTargetSlot: "agent1",
    expectedPairShot: false,
    ...overrides,
  });
}

describe("capture-browser frame request policy", () => {
  const readiness = (overrides: Record<string, unknown> = {}) => ({
    ready: true,
    phase: "IDLE",
    expectedAgentCount: 2,
    loadedExpectedAgentCount: 2,
    renderedAgentCount: 2,
    visibleAgentFramingCount: 1,
    fullyFramedAgentSlots: ["agent1"],
    croppedVisibleAgentBodyCount: 0,
    unobstructedVisibleAgentSlots: ["agent1", "agent2"],
    occludedVisibleAgentBodyCount: 0,
    missingVisibleAgentLineOfSightCount: 0,
    minimumVisibleAgentHorizontalNdcSeparation: null,
    minimumVisibleAgentBodyNdcSpan: 0.62,
    maximumVisibleAgentBodyNdcSpan: 0.62,
    cameraTargetSlot: "agent1",
    cameraTargetMatchesExpected: true,
    preparationActive: true,
    preparationShotActive: true,
    preparationPairShotActive: false,
    ...overrides,
  });

  it("leaves frame IPC disabled only when all three values are absent", () => {
    expect(resolveCaptureBrowserFrameIpcConfig({})).toBeNull();
  });

  it("requires a complete, canonical, separated IPC configuration", () => {
    expect(() =>
      resolveCaptureBrowserFrameIpcConfig({
        STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE: "/tmp/request.json",
      }),
    ).toThrow(/requires request, status, and output-directory paths together/);
    expect(() =>
      resolveCaptureBrowserFrameIpcConfig({
        STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE: "relative/request.json",
        STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE: "/tmp/status.json",
        STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY: "/tmp",
      }),
    ).toThrow(/canonical absolute path/);
    expect(() =>
      resolveCaptureBrowserFrameIpcConfig({
        STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE: "/tmp/same.json",
        STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE: "/tmp/same.json",
        STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY: "/tmp",
      }),
    ).toThrow(/request and status paths must differ/);

    expect(
      resolveCaptureBrowserFrameIpcConfig({
        STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE: "/tmp/request.json",
        STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE: "/tmp/status.json",
        STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY: OUTPUT_DIRECTORY,
      }),
    ).toEqual({
      requestFile: "/tmp/request.json",
      statusFile: "/tmp/status.json",
      outputDirectory: OUTPUT_DIRECTORY,
    });
  });

  it("accepts only one fresh exact-schema request inside the output directory", () => {
    expect(
      parseCaptureBrowserFrameRequest(request(), {
        nowMs: NOW_MS,
        outputDirectory: OUTPUT_DIRECTORY,
      }),
    ).toEqual({
      schemaVersion: 2,
      requestId: "prep-agent1-0123456789abcdef",
      outputFilename: ".e2e-hyperia-preparation-agent1-frame.png",
      requestedAtMs: NOW_MS,
      expectedCameraTargetSlot: "agent1",
      expectedPairShot: false,
      outputPath:
        "/private/tmp/hyperia-frame-output/.e2e-hyperia-preparation-agent1-frame.png",
    });
  });

  it("rejects unknown fields, traversal, invalid identifiers, and invalid clocks", () => {
    const parse = (raw: string, nowMs = NOW_MS) =>
      parseCaptureBrowserFrameRequest(raw, {
        nowMs,
        outputDirectory: OUTPUT_DIRECTORY,
      });
    expect(() => parse(request({ extra: true }))).toThrow(/unexpected fields/);
    expect(() => parse(request({ outputFilename: "../escaped.png" }))).toThrow(
      /output filename is invalid/,
    );
    expect(() =>
      parse(request({ outputFilename: "/tmp/escaped.png" })),
    ).toThrow(/output filename is invalid/);
    expect(() => parse(request({ requestId: "PREP_AGENT_1" }))).toThrow(
      /requestId is invalid/,
    );
    expect(() =>
      parse(request({ expectedCameraTargetSlot: "agent3" })),
    ).toThrow(/expected camera target slot is invalid/);
    expect(() => parse(request({ expectedPairShot: "false" }))).toThrow(
      /expected pair-shot flag is invalid/,
    );
    expect(() =>
      parse(
        request({ requestedAtMs: NOW_MS - 1 }),
        NOW_MS + CAPTURE_BROWSER_FRAME_REQUEST_MAX_AGE_MS,
      ),
    ).toThrow(/request is stale/);
    expect(() => parse(request({ requestedAtMs: NOW_MS + 1_001 }))).toThrow(
      /request is from the future/,
    );
  });

  it("rejects malformed, oversized, and non-object JSON", () => {
    const parse = (raw: string) =>
      parseCaptureBrowserFrameRequest(raw, {
        nowMs: NOW_MS,
        outputDirectory: OUTPUT_DIRECTORY,
      });
    expect(() => parse("{")).toThrow(/valid JSON/);
    expect(() => parse("[]")).toThrow(/JSON object/);
    expect(() => parse("x".repeat(4_097))).toThrow(/invalid byte length/);
  });

  it("qualifies only a pixel-capture-time preparation composition", () => {
    expect(
      isCaptureBrowserFrameReadinessQualified(readiness(), "agent1", false),
    ).toBe(true);
    expect(
      isCaptureBrowserFrameReadinessQualified(
        readiness({ cameraTargetSlot: "agent2" }),
        "agent1",
        false,
      ),
    ).toBe(false);
    expect(
      isCaptureBrowserFrameReadinessQualified(
        readiness({ minimumVisibleAgentBodyNdcSpan: 0.1 }),
        "agent1",
        false,
      ),
    ).toBe(false);
    expect(
      isCaptureBrowserFrameReadinessQualified(
        readiness({ croppedVisibleAgentBodyCount: 1 }),
        "agent1",
        false,
      ),
    ).toBe(false);

    const pairReadiness = readiness({
      visibleAgentFramingCount: 2,
      fullyFramedAgentSlots: ["agent1", "agent2"],
      minimumVisibleAgentHorizontalNdcSeparation: 0.3,
      preparationPairShotActive: true,
    });
    expect(
      isCaptureBrowserFrameReadinessQualified(pairReadiness, "agent1", true),
    ).toBe(true);
    expect(
      isCaptureBrowserFrameReadinessQualified(
        { ...pairReadiness, unobstructedVisibleAgentSlots: ["agent1"] },
        "agent1",
        true,
      ),
    ).toBe(false);
  });
});
