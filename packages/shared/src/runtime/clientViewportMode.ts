interface HyperiaViewportWindow extends Window {
  __HYPERIA_EMBEDDED__?: boolean;
  __HYPERIA_CONFIG__?: {
    mode?: string;
  };
}

export const STREAMING_RENDER_PROFILES = Object.freeze({
  "canonical-720p60-v1": Object.freeze({
    id: "canonical-720p60-v1" as const,
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
    shadows: "none" as const,
    postprocessing: false,
    grassProfile: "fixed-arena-v1" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
  "fallback-720p30-v1": Object.freeze({
    id: "fallback-720p30-v1" as const,
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
    shadows: "none" as const,
    postprocessing: false,
    grassProfile: "fixed-arena-v1" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
});

export type StreamingRenderProfileId = keyof typeof STREAMING_RENDER_PROFILES;
export type StreamingRenderProfile =
  (typeof STREAMING_RENDER_PROFILES)[StreamingRenderProfileId];

export function resolveExplicitStreamingRenderProfile(
  win?: Window,
): StreamingRenderProfile | null {
  const windowRef = getWindowRef(win);
  if (!windowRef) return null;
  const params = getSearchParams(windowRef);
  const rawProfile = (params?.get("streamRenderProfile") || "").trim();
  if (!rawProfile) return null;
  if (!(rawProfile in STREAMING_RENDER_PROFILES)) {
    throw new Error(`Unknown streaming render profile: ${rawProfile}`);
  }

  const profile =
    STREAMING_RENDER_PROFILES[rawProfile as StreamingRenderProfileId];
  const rawFps = (params?.get("streamFps") || "").trim();
  if (rawFps && !/^\d+$/u.test(rawFps)) {
    throw new Error(
      `Streaming render profile ${profile.id} requires an integer streamFps`,
    );
  }
  if (rawFps && Number(rawFps) !== profile.targetFps) {
    throw new Error(
      `Streaming render profile ${profile.id} requires streamFps=${profile.targetFps}`,
    );
  }
  return profile;
}

function parseTruthy(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function getWindowRef(win?: Window): HyperiaViewportWindow | undefined {
  if (win) return win as HyperiaViewportWindow;
  if (typeof window === "undefined") return undefined;
  return window as HyperiaViewportWindow;
}

function getSearchParams(win: HyperiaViewportWindow): URLSearchParams | null {
  try {
    return new URLSearchParams(win.location.search);
  } catch {
    return null;
  }
}

export function isStreamPageRoute(win?: Window): boolean {
  const windowRef = getWindowRef(win);
  if (!windowRef) return false;

  const pathname = windowRef.location.pathname.trim().toLowerCase();
  if (pathname.endsWith("/stream.html") || pathname === "/stream.html") {
    return true;
  }

  const params = getSearchParams(windowRef);
  return (params?.get("page") || "").trim().toLowerCase() === "stream";
}

export function isEmbeddedSpectatorViewport(win?: Window): boolean {
  const windowRef = getWindowRef(win);
  if (!windowRef) return false;

  const params = getSearchParams(windowRef);
  const embeddedFromQuery = parseTruthy(params?.get("embedded"));
  const modeFromQuery = (params?.get("mode") || "").trim().toLowerCase();

  const embeddedFromConfig =
    windowRef.__HYPERIA_EMBEDDED__ === true &&
    windowRef.__HYPERIA_CONFIG__?.mode === "spectator";

  return (
    (embeddedFromQuery && modeFromQuery === "spectator") || embeddedFromConfig
  );
}

export function isStreamingLikeViewport(win?: Window): boolean {
  return isStreamPageRoute(win) || isEmbeddedSpectatorViewport(win);
}

export type StreamingWorldProfileId = "preparation-v1";

/**
 * Explicit, startup-only preparation broadcast admission. This is independent
 * of the render profile and does not move agents or change server authority.
 * Reject malformed selections rather than silently presenting an empty arena
 * profile as a populated preparation view.
 */
export function resolveExplicitStreamingWorldProfile(
  win?: Window,
): StreamingWorldProfileId | null {
  const windowRef = getWindowRef(win);
  if (!windowRef) return null;
  const selections = getSearchParams(windowRef)?.getAll("streamWorld") ?? [];
  if (selections.length === 0) return null;
  if (selections.length !== 1 || selections[0] !== "preparation-v1") {
    throw new Error("streamWorld requires exactly one preparation-v1 value");
  }
  if (!isStreamingLikeViewport(windowRef)) {
    throw new Error("streamWorld requires a stream or spectator viewport");
  }
  return "preparation-v1";
}

export function shouldStreamVegetationBackgroundLods(win?: Window): boolean {
  return resolveClientViewportRuntimeProfile(win).enableExplorationVegetation;
}

export interface ClientViewportRuntimeProfile {
  streamingLike: boolean;
  enableLocalPhysics: boolean;
  enableExplorationScenery: boolean;
  enableExplorationVegetation: boolean;
  enableExplorationResourceNodes: boolean;
  enableExplorationWorldEntities: boolean;
  enableProceduralExplorationSystems: boolean;
  prewarmTreeCache: boolean;
}

/**
 * Resolve expensive client-world capabilities once, before systems register.
 * Broadcast/spectator viewports render authoritative arena state and never
 * control an exploration character, so they do not need local physics or the
 * world-wide procedural town/POI planning pass. Interactive clients retain the
 * complete exploration runtime. Explicit streamWorld=preparation-v1 admits
 * existing server-authored hub entities and camera-local scenery/vegetation,
 * without local physics, procedural towns/POIs or eager tree-cache prewarming.
 * Stream terrain/grass budgets remain unchanged; this is not a performance or
 * preparation-readiness certification and does not construct new hub content.
 */
export function resolveClientViewportRuntimeProfile(
  win?: Window,
): ClientViewportRuntimeProfile {
  const streamingLike = isStreamingLikeViewport(win);
  const interactive = !streamingLike;
  const preparation =
    resolveExplicitStreamingWorldProfile(win) === "preparation-v1";
  const explorationContent = interactive || preparation;
  return {
    streamingLike,
    enableLocalPhysics: interactive,
    enableExplorationScenery: explorationContent,
    enableExplorationVegetation: explorationContent,
    enableExplorationResourceNodes: explorationContent,
    enableExplorationWorldEntities: explorationContent,
    enableProceduralExplorationSystems: interactive,
    prewarmTreeCache: interactive,
  };
}

/**
 * Arena broadcast viewports synchronize authoritative fighters but omit the
 * exploration entities surrounding their transient world-spawn position.
 * Interactive and explicit preparation broadcast clients retain the complete
 * server-authored world snapshot; this is not client-side entity fabrication.
 */
export function shouldAdmitNetworkEntityInViewport(
  entityType: unknown,
  win?: Window,
): boolean {
  return (
    resolveClientViewportRuntimeProfile(win).enableExplorationWorldEntities ||
    entityType === "player"
  );
}

export function resolveStreamingRenderFrameRate(
  win?: Window,
  fallback = 30,
): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(60, Math.max(1, Math.round(fallback)))
    : 30;
  const windowRef = getWindowRef(win);
  if (!windowRef) return safeFallback;
  const explicitProfile = resolveExplicitStreamingRenderProfile(windowRef);
  if (explicitProfile) return explicitProfile.targetFps;
  const rawValue = getSearchParams(windowRef)?.get("streamFps") || "";
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(60, Math.max(1, parsed));
}
