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

export type CaptureRenderProfileId =
  | typeof CANONICAL_CAPTURE_RENDER_PROFILE
  | typeof FALLBACK_CAPTURE_RENDER_PROFILE;

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
};

type CaptureRenderProfileContract = Omit<
  CaptureRenderProfileSnapshot,
  "explicit"
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
  if (!(candidate.id in CAPTURE_RENDER_PROFILE_CONTRACTS)) return null;
  const id = candidate.id as CaptureRenderProfileId;
  const contract = CAPTURE_RENDER_PROFILE_CONTRACTS[id];
  for (const [field, expected] of Object.entries(contract)) {
    if (candidate[field] !== expected) return null;
  }
  return { ...contract, explicit: true };
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
  const profileId = resolveCaptureRenderProfileId(safeFps);
  if (!profileId) {
    throw new Error(
      `Unsupported capture frame rate ${safeFps}; configured render profiles support only 30 or 60 FPS`,
    );
  }
  const advertisedProfile = (
    url.searchParams.get("streamRenderProfile") || ""
  ).trim();
  if (advertisedProfile && advertisedProfile !== profileId) {
    throw new Error(
      `Capture render profile ${advertisedProfile} contradicts streamFps=${safeFps}`,
    );
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
