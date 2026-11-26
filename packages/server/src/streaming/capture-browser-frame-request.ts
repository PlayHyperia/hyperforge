import path from "node:path";

export const CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION = 2 as const;
export const CAPTURE_BROWSER_FRAME_REQUEST_MAX_AGE_MS = 10_000;
export const CAPTURE_BROWSER_FRAME_REQUEST_MAX_FUTURE_MS = 1_000;
export const CAPTURE_BROWSER_FRAME_REQUEST_MAX_BYTES = 4_096;

const REQUEST_KEYS = [
  "expectedCameraTargetSlot",
  "expectedPairShot",
  "outputFilename",
  "requestId",
  "requestedAtMs",
  "schemaVersion",
] as const;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const OUTPUT_FILENAME_PATTERN = /^[a-z0-9.][a-z0-9._-]{0,126}\.png$/;

export type CaptureBrowserFrameIpcConfig = {
  requestFile: string;
  statusFile: string;
  outputDirectory: string;
};

export type CaptureBrowserFrameRequest = {
  schemaVersion: typeof CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION;
  requestId: string;
  outputFilename: string;
  requestedAtMs: number;
  expectedCameraTargetSlot: "agent1" | "agent2";
  expectedPairShot: boolean;
  outputPath: string;
};

function requireCanonicalAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

export function resolveCaptureBrowserFrameIpcConfig(
  environment: Readonly<Record<string, string | undefined>>,
): CaptureBrowserFrameIpcConfig | null {
  const requestFile = (
    environment.STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE || ""
  ).trim();
  const statusFile = (
    environment.STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE || ""
  ).trim();
  const outputDirectory = (
    environment.STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY || ""
  ).trim();
  const configuredCount = [requestFile, statusFile, outputDirectory].filter(
    Boolean,
  ).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 3) {
    throw new Error(
      "Capture-browser frame IPC requires request, status, and output-directory paths together",
    );
  }

  const config = {
    requestFile: requireCanonicalAbsolutePath(
      requestFile,
      "STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE",
    ),
    statusFile: requireCanonicalAbsolutePath(
      statusFile,
      "STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE",
    ),
    outputDirectory: requireCanonicalAbsolutePath(
      outputDirectory,
      "STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY",
    ),
  };
  if (config.requestFile === config.statusFile) {
    throw new Error(
      "Capture-browser frame request and status paths must differ",
    );
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsSlot(value: unknown, slot: "agent1" | "agent2"): boolean {
  return Array.isArray(value) && value.includes(slot);
}

export function isCaptureBrowserFrameReadinessQualified(
  value: unknown,
  expectedCameraTargetSlot: "agent1" | "agent2",
  expectedPairShot: boolean,
): boolean {
  if (!isRecord(value)) return false;
  const minimumBodySpan = value.minimumVisibleAgentBodyNdcSpan;
  const maximumBodySpan = value.maximumVisibleAgentBodyNdcSpan;
  if (
    value.ready !== true ||
    value.phase !== "IDLE" ||
    value.expectedAgentCount !== 2 ||
    value.loadedExpectedAgentCount !== 2 ||
    value.renderedAgentCount !== 2 ||
    value.cameraTargetMatchesExpected !== true ||
    value.cameraTargetSlot !== expectedCameraTargetSlot ||
    value.preparationActive !== true ||
    value.preparationShotActive !== true ||
    value.preparationPairShotActive !== expectedPairShot ||
    !containsSlot(value.fullyFramedAgentSlots, expectedCameraTargetSlot) ||
    !containsSlot(
      value.unobstructedVisibleAgentSlots,
      expectedCameraTargetSlot,
    ) ||
    value.croppedVisibleAgentBodyCount !== 0 ||
    value.occludedVisibleAgentBodyCount !== 0 ||
    value.missingVisibleAgentLineOfSightCount !== 0 ||
    typeof minimumBodySpan !== "number" ||
    !Number.isFinite(minimumBodySpan) ||
    minimumBodySpan < 0.55 ||
    typeof maximumBodySpan !== "number" ||
    !Number.isFinite(maximumBodySpan) ||
    maximumBodySpan > 0.75
  ) {
    return false;
  }

  if (!expectedPairShot) {
    return (
      value.visibleAgentFramingCount === 1 &&
      value.minimumVisibleAgentHorizontalNdcSeparation === null
    );
  }

  return (
    value.visibleAgentFramingCount === 2 &&
    containsSlot(value.fullyFramedAgentSlots, "agent1") &&
    containsSlot(value.fullyFramedAgentSlots, "agent2") &&
    containsSlot(value.unobstructedVisibleAgentSlots, "agent1") &&
    containsSlot(value.unobstructedVisibleAgentSlots, "agent2") &&
    typeof value.minimumVisibleAgentHorizontalNdcSeparation === "number" &&
    Number.isFinite(value.minimumVisibleAgentHorizontalNdcSeparation) &&
    value.minimumVisibleAgentHorizontalNdcSeparation >= 0.24
  );
}

export function parseCaptureBrowserFrameRequest(
  rawRequest: string,
  options: {
    nowMs: number;
    outputDirectory: string;
  },
): CaptureBrowserFrameRequest {
  if (
    Buffer.byteLength(rawRequest, "utf8") === 0 ||
    Buffer.byteLength(rawRequest, "utf8") >
      CAPTURE_BROWSER_FRAME_REQUEST_MAX_BYTES
  ) {
    throw new Error("Capture-browser frame request has an invalid byte length");
  }
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 1) {
    throw new Error(
      "Capture-browser frame request parser requires a valid clock",
    );
  }
  const outputDirectory = requireCanonicalAbsolutePath(
    options.outputDirectory,
    "Capture-browser frame output directory",
  );

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawRequest) as unknown;
  } catch {
    throw new Error("Capture-browser frame request must be valid JSON");
  }
  if (!isRecord(decoded)) {
    throw new Error("Capture-browser frame request must be a JSON object");
  }
  const keys = Object.keys(decoded).sort();
  if (
    keys.length !== REQUEST_KEYS.length ||
    !REQUEST_KEYS.every((key, index) => key === keys[index])
  ) {
    throw new Error("Capture-browser frame request has unexpected fields");
  }
  if (decoded.schemaVersion !== CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION) {
    throw new Error("Capture-browser frame request schema is unsupported");
  }
  if (
    typeof decoded.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(decoded.requestId)
  ) {
    throw new Error("Capture-browser frame requestId is invalid");
  }
  if (
    typeof decoded.outputFilename !== "string" ||
    !OUTPUT_FILENAME_PATTERN.test(decoded.outputFilename) ||
    path.basename(decoded.outputFilename) !== decoded.outputFilename
  ) {
    throw new Error("Capture-browser frame output filename is invalid");
  }
  if (
    decoded.expectedCameraTargetSlot !== "agent1" &&
    decoded.expectedCameraTargetSlot !== "agent2"
  ) {
    throw new Error(
      "Capture-browser frame expected camera target slot is invalid",
    );
  }
  if (typeof decoded.expectedPairShot !== "boolean") {
    throw new Error("Capture-browser frame expected pair-shot flag is invalid");
  }
  if (
    !Number.isSafeInteger(decoded.requestedAtMs) ||
    (decoded.requestedAtMs as number) < 1
  ) {
    throw new Error("Capture-browser frame requestedAtMs is invalid");
  }
  const requestedAtMs = decoded.requestedAtMs as number;
  if (
    requestedAtMs >
    options.nowMs + CAPTURE_BROWSER_FRAME_REQUEST_MAX_FUTURE_MS
  ) {
    throw new Error("Capture-browser frame request is from the future");
  }
  if (
    options.nowMs - requestedAtMs >
    CAPTURE_BROWSER_FRAME_REQUEST_MAX_AGE_MS
  ) {
    throw new Error("Capture-browser frame request is stale");
  }

  const outputPath = path.join(outputDirectory, decoded.outputFilename);
  if (path.dirname(outputPath) !== outputDirectory) {
    throw new Error("Capture-browser frame output escaped its directory");
  }
  return {
    schemaVersion: CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION,
    requestId: decoded.requestId,
    outputFilename: decoded.outputFilename,
    requestedAtMs,
    expectedCameraTargetSlot: decoded.expectedCameraTargetSlot,
    expectedPairShot: decoded.expectedPairShot,
    outputPath,
  };
}
