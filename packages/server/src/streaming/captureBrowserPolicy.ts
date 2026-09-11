import {
  evaluateStreamingRenderProfileApplication,
  STREAMING_RENDER_PROFILES,
  type StreamingRenderAppliedState,
  type StreamingRenderPreferences,
  type StreamingRenderProfileApplication,
} from "../../../shared/src/runtime/clientViewportMode";

type CaptureReadinessDiagnostics = {
  hasCanvas: boolean;
  hasStreamingBootUi: boolean;
  hasCriticalErrorUi: boolean;
  readyFlag: boolean;
};

export type CaptureRendererHealthSnapshot = {
  ready: boolean;
  degradedReason: string | null;
  diagnostics: CaptureReadinessDiagnostics | null;
  renderProfile?: CaptureRenderProfileSnapshot | null;
};

export const DEFAULT_CAPTURE_GAME_URL = "http://localhost:3333/stream.html";
export const CANONICAL_CAPTURE_RENDER_PROFILE = "canonical-720p60-v1";
export const FALLBACK_CAPTURE_RENDER_PROFILE = "fallback-720p30-v1";
export const SHADOWS_CAPTURE_RENDER_PROFILE = "shadows-720p60-v1";

export type CaptureRenderProfileId =
  | typeof CANONICAL_CAPTURE_RENDER_PROFILE
  | typeof FALLBACK_CAPTURE_RENDER_PROFILE
  | typeof SHADOWS_CAPTURE_RENDER_PROFILE;

export type CaptureRenderProfileSnapshot = {
  id: string;
  targetFps: number;
  sourceFps: number;
  outputFps: number;
  viewportWidth: number;
  viewportHeight: number;
  outputWidth: number;
  outputHeight: number;
  renderPixelBudget: number;
  maximumDpr: number;
  antialiasing: boolean;
  shadows: string;
  postprocessing: boolean;
  grassProfile: string;
  avatarLodPolicy: string;
  explicit: boolean;
  application?: StreamingRenderProfileApplication | null;
};

type CaptureRenderProfileContract = Omit<
  CaptureRenderProfileSnapshot,
  "explicit" | "application"
>;

export const CAPTURE_RENDER_PROFILE_CONTRACTS = Object.freeze({
  [CANONICAL_CAPTURE_RENDER_PROFILE]: Object.freeze({
    id: CANONICAL_CAPTURE_RENDER_PROFILE,
    targetFps: 60,
    sourceFps: 60,
    outputFps: 60,
    viewportWidth: 1280,
    viewportHeight: 720,
    outputWidth: 1280,
    outputHeight: 720,
    renderPixelBudget: 1280 * 720,
    maximumDpr: 1,
    antialiasing: true,
    shadows: "none",
    postprocessing: false,
    grassProfile: "fixed-arena-v1",
    avatarLodPolicy: "distance-authoritative-v1",
  }),
  [FALLBACK_CAPTURE_RENDER_PROFILE]: Object.freeze({
    id: FALLBACK_CAPTURE_RENDER_PROFILE,
    targetFps: 30,
    sourceFps: 30,
    outputFps: 30,
    viewportWidth: 1280,
    viewportHeight: 720,
    outputWidth: 1280,
    outputHeight: 720,
    renderPixelBudget: 1280 * 720,
    maximumDpr: 1,
    antialiasing: true,
    shadows: "none",
    postprocessing: false,
    grassProfile: "fixed-arena-v1",
    avatarLodPolicy: "distance-authoritative-v1",
  }),
  [SHADOWS_CAPTURE_RENDER_PROFILE]: Object.freeze({
    id: SHADOWS_CAPTURE_RENDER_PROFILE,
    targetFps: 60,
    sourceFps: 60,
    outputFps: 60,
    viewportWidth: 1280,
    viewportHeight: 720,
    outputWidth: 1280,
    outputHeight: 720,
    renderPixelBudget: 1280 * 720,
    maximumDpr: 1,
    antialiasing: true,
    shadows: "med",
    postprocessing: false,
    grassProfile: "fixed-arena-v1",
    avatarLodPolicy: "distance-authoritative-v1",
  }),
}) satisfies Readonly<
  Record<CaptureRenderProfileId, Readonly<CaptureRenderProfileContract>>
>;

export function assertCaptureRenderProfileContract(params: {
  profileId: CaptureRenderProfileId | null;
  sourceFps: number;
  outputFps: number;
  viewportWidth: number;
  viewportHeight: number;
  outputWidth: number;
  outputHeight: number;
}): asserts params is typeof params & { profileId: CaptureRenderProfileId } {
  const contract = params.profileId
    ? CAPTURE_RENDER_PROFILE_CONTRACTS[params.profileId]
    : null;
  if (!contract) {
    throw new Error("Capture requires a supported versioned render profile");
  }
  const actual = {
    sourceFps: params.sourceFps,
    outputFps: params.outputFps,
    viewportWidth: params.viewportWidth,
    viewportHeight: params.viewportHeight,
    outputWidth: params.outputWidth,
    outputHeight: params.outputHeight,
  };
  for (const [field, actualValue] of Object.entries(actual)) {
    const expected = contract[field as keyof typeof actual];
    if (actualValue !== expected) {
      throw new Error(
        `Capture render profile ${contract.id} requires ${field}=${expected}`,
      );
    }
  }
}

export function resolveCaptureRenderProfileId(
  framesPerSecond: number,
): CaptureRenderProfileId | null {
  return framesPerSecond === 60
    ? CANONICAL_CAPTURE_RENDER_PROFILE
    : framesPerSecond === 30
      ? FALLBACK_CAPTURE_RENDER_PROFILE
      : null;
}

export function matchesExpectedCaptureRenderProfile(
  snapshot: CaptureRenderProfileSnapshot | null | undefined,
  expectedId: CaptureRenderProfileId | null,
): boolean {
  const normalized = normalizeCaptureRenderProfileSnapshot(snapshot);
  return normalized !== null && normalized.id === expectedId;
}

export function normalizeCaptureRenderProfileSnapshot(
  value: unknown,
): CaptureRenderProfileSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.explicit !== true || typeof candidate.id !== "string") {
    return null;
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      CAPTURE_RENDER_PROFILE_CONTRACTS,
      candidate.id,
    )
  )
    return null;
  const id = candidate.id as CaptureRenderProfileId;
  const contract = CAPTURE_RENDER_PROFILE_CONTRACTS[id];
  for (const [field, expected] of Object.entries(contract)) {
    if (candidate[field] !== expected) return null;
  }
  if (candidate.application !== undefined && candidate.application !== null) {
    const application = normalizeCaptureRenderApplication(
      candidate.application,
      id,
    );
    return application ? { ...contract, explicit: true, application } : null;
  }
  if (id === SHADOWS_CAPTURE_RENDER_PROFILE) return null;
  return { ...contract, explicit: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRenderPreferences(
  value: unknown,
): value is StreamingRenderPreferences {
  if (!isRecord(value)) return false;
  return (
    typeof value.dpr === "number" &&
    Number.isFinite(value.dpr) &&
    typeof value.shadows === "string" &&
    typeof value.colorGrading === "string" &&
    [
      "postprocessing",
      "bloom",
      "depthBlur",
      "waterReflections",
      "entityHighlighting",
    ].every((key) => typeof value[key] === "boolean")
  );
}

function isFiniteTuple(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    Array.from(value).every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    )
  );
}

function isAppliedRenderState(
  value: unknown,
): value is StreamingRenderAppliedState {
  if (
    !isRecord(value) ||
    !isRenderPreferences(value.preferences) ||
    !isRecord(value.renderer)
  )
    return false;
  const renderer = value.renderer;
  if (
    ![
      "isWebGPU",
      "hasRendered",
      "shadowsEnabled",
      "postprocessing",
      "composerPresent",
    ].every((key) => typeof renderer[key] === "boolean") ||
    !["dpr", "width", "height", "samples", "shadowType"].every(
      (key) =>
        typeof renderer[key] === "number" && Number.isFinite(renderer[key]),
    )
  )
    return false;
  if (
    value.water !== null &&
    (!isRecord(value.water) ||
      typeof value.water.reflectionsEnabled !== "boolean" ||
      typeof value.water.activeReflectionCount !== "number" ||
      !Number.isSafeInteger(value.water.activeReflectionCount) ||
      value.water.activeReflectionCount < 0)
  )
    return false;
  const sun = value.sunlight;
  return (
    sun === null ||
    (isRecord(sun) &&
      typeof sun.name === "string" &&
      typeof sun.castShadow === "boolean" &&
      typeof sun.cascaded === "boolean" &&
      isFiniteTuple(sun.mapSize, 2) &&
      (sun.allocatedMapSize === null ||
        isFiniteTuple(sun.allocatedMapSize, 2)) &&
      isFiniteTuple(sun.frustum, 6) &&
      typeof sun.bias === "number" &&
      Number.isFinite(sun.bias) &&
      typeof sun.normalBias === "number" &&
      Number.isFinite(sun.normalBias))
  );
}

function normalizeCaptureRenderApplication(
  value: unknown,
  profileId: CaptureRenderProfileId,
): StreamingRenderProfileApplication | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.ready !== true ||
    value.mismatchReason !== null ||
    !isRenderPreferences(value.requested) ||
    !isAppliedRenderState(value.applied)
  )
    return null;
  const evaluated = evaluateStreamingRenderProfileApplication(
    STREAMING_RENDER_PROFILES[profileId],
    value.requested,
    value.applied,
  );
  return evaluated.ready && evaluated.mismatchReason === null
    ? evaluated
    : null;
}

export function applyCaptureFrameRateToUrl(
  rawUrl: string,
  framesPerSecond: number,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const safeFps = Number.isFinite(framesPerSecond)
    ? Math.min(60, Math.max(1, Math.round(framesPerSecond)))
    : 30;
  let profileId = resolveCaptureRenderProfileId(safeFps);
  if (!profileId) {
    throw new Error(
      `Unsupported capture frame rate ${safeFps}; configured render profiles support only 30 or 60 FPS`,
    );
  }
  const profiles = url.searchParams.getAll("streamRenderProfile");
  const rates = url.searchParams.getAll("streamFps");
  if (profiles.length > 1 || rates.length > 1) {
    throw new Error("Capture requires a single render profile and frame rate");
  }
  if (profiles.length === 1) {
    const advertisedProfile = profiles[0].trim();
    if (
      !Object.prototype.hasOwnProperty.call(
        CAPTURE_RENDER_PROFILE_CONTRACTS,
        advertisedProfile,
      )
    ) {
      throw new Error(
        `Unsupported capture render profile ${advertisedProfile}`,
      );
    }
    const advertisedId = advertisedProfile as CaptureRenderProfileId;
    if (CAPTURE_RENDER_PROFILE_CONTRACTS[advertisedId].targetFps !== safeFps) {
      throw new Error(
        `Capture render profile ${advertisedProfile} contradicts streamFps=${safeFps}`,
      );
    }
    profileId = advertisedId;
  }
  if (
    rates.length === 1 &&
    (!/^\d+$/.test(rates[0].trim()) || Number(rates[0]) !== safeFps)
  ) {
    throw new Error(`Capture URL frame rate contradicts streamFps=${safeFps}`);
  }
  url.searchParams.set("streamFps", String(safeFps));
  url.searchParams.set("streamRenderProfile", profileId);
  return url.toString();
}

export function resolveCaptureUrlCandidates(params: {
  primaryUrl?: string;
  fallbackUrls?: string;
}): string[] {
  const primaryUrl = params.primaryUrl?.trim() || DEFAULT_CAPTURE_GAME_URL;
  const explicitFallbacks = (params.fallbackUrls ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([primaryUrl, ...explicitFallbacks])];
}

/** One browser/encoder contract must hold across every configured navigation fallback. */
export function resolveCaptureRenderProfileForUrls(
  rawUrls: readonly string[],
  framesPerSecond: number,
): CaptureRenderProfileId {
  if (rawUrls.length === 0)
    throw new Error("Capture requires at least one game URL");
  let selected: CaptureRenderProfileId | null = null;
  for (const rawUrl of rawUrls) {
    const normalized = applyCaptureFrameRateToUrl(rawUrl, framesPerSecond);
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error("Capture requires a valid game URL");
    }
    const id = url.searchParams.get("streamRenderProfile");
    if (
      !id ||
      !Object.prototype.hasOwnProperty.call(
        CAPTURE_RENDER_PROFILE_CONTRACTS,
        id,
      )
    ) {
      throw new Error("Capture requires a supported versioned render profile");
    }
    if (selected !== null && selected !== id) {
      throw new Error("Capture fallback URLs require the same render profile");
    }
    selected = id as CaptureRenderProfileId;
  }
  if (selected === null)
    throw new Error("Capture requires at least one game URL");
  return selected;
}

/**
 * Accept only an explicitly addressed loopback CDP host. The long-lived
 * renderer carries the private spectator credential and a live game page, so
 * the encoder must never attach to an arbitrary remote debugging endpoint.
 */
export function resolveCaptureBrowserEndpoint(
  rawEndpoint: string | undefined,
): string | null {
  const configured = rawEndpoint?.trim() || "";
  if (!configured) return null;

  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new Error("Capture browser endpoint must be a valid loopback URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    endpoint.protocol !== "http:" ||
    !loopbackHosts.has(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "Capture browser endpoint must be an uncredentialed loopback HTTP origin with an explicit port",
    );
  }
  return endpoint.origin;
}

export function buildDefaultCaptureLaunchArgs(params: {
  angleBackend: string;
  featureFlags: string;
  disableSandbox?: boolean;
}): string[] {
  return [
    "--use-gl=angle",
    `--use-angle=${params.angleBackend}`,
    "--enable-webgl",
    "--enable-unsafe-webgpu",
    params.featureFlags,
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    ...(params.disableSandbox ? ["--no-sandbox"] : []),
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-hang-monitor",
  ];
}

export function resolveDefaultCaptureFeatureFlags(platform: string): string {
  const features = ["UseSkiaRenderer", "WebGPU"];
  // Vulkan is part of the Linux capture path. Enabling it while Chromium is
  // explicitly using ANGLE/Metal on macOS creates two competing GPU backend
  // selections and can leave WebGPU initialization stuck or unavailable.
  if (platform === "linux") features.unshift("Vulkan");
  return `--enable-features=${features.join(",")}`;
}

export function resolveAllowedCaptureOrigins(
  rawUrls: readonly string[],
): string[] {
  const origins = new Set<string>();
  for (const rawUrl of rawUrls) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed candidate URLs here; startup will fail when it tries
      // to navigate to them.
    }
  }
  return [...origins];
}

export function resolveUnexpectedCaptureOrigin(
  rawUrl: string,
  allowedOrigins: readonly string[],
): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return parsed.origin;
    }
    return allowedOrigins.includes(parsed.origin) ? null : parsed.origin;
  } catch {
    return rawUrl;
  }
}

export function shouldAcceptCaptureReadiness(params: {
  snapshot: CaptureRendererHealthSnapshot;
  startedAt: number;
  nowMs: number;
  bootUiGraceMs?: number;
  expectedRenderProfileId?: CaptureRenderProfileId | null;
}): boolean {
  const { snapshot, startedAt, nowMs } = params;
  if (
    params.expectedRenderProfileId &&
    !matchesExpectedCaptureRenderProfile(
      snapshot.renderProfile,
      params.expectedRenderProfileId,
    )
  ) {
    return false;
  }
  if (snapshot.ready) {
    return true;
  }

  if (snapshot.diagnostics?.hasCriticalErrorUi) {
    return false;
  }

  if (
    snapshot.degradedReason &&
    snapshot.degradedReason !== "loading_overlay_active"
  ) {
    return false;
  }

  return (
    snapshot.diagnostics?.hasStreamingBootUi === true &&
    nowMs - startedAt >= (params.bootUiGraceMs ?? 180_000)
  );
}
