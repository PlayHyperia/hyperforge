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
  // Explicit qualification candidate. Never selected by the FPS/default route.
  "shadows-720p60-v1": Object.freeze({
    id: "shadows-720p60-v1" as const,
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
    shadows: "med" as const,
    postprocessing: false,
    grassProfile: "fixed-arena-v1" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
  // Explicit island vegetation experiment; FPS/default selection stays unchanged.
  "island-720p60-v1": Object.freeze({
    id: "island-720p60-v1" as const,
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
    shadows: "med" as const,
    postprocessing: false,
    grassProfile: "compact-island-v1" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
  // Denser meadow qualification only; never selected by FPS/default routing.
  "island-meadow-720p60-v1": Object.freeze({
    id: "island-meadow-720p60-v1" as const,
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
    shadows: "med" as const,
    postprocessing: false,
    grassProfile: "compact-meadow-v2" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
});

export type StreamingRenderProfileId = keyof typeof STREAMING_RENDER_PROFILES;
export type SkyAtmosphereMode = "gradient-v1" | "scattering-v1";
export type GrassAppearanceCandidate = "natural-tuft-v1";

/** Appearance-only qualification; dense meadow population settings stay unchanged. */
export function resolveGrassAppearanceCandidate(
  win?: Window,
): GrassAppearanceCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassAppearance") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "natural-tuft-v1") {
    throw new Error("Unknown or duplicate grass appearance candidate");
  }
  if (
    (params?.getAll("page").length ?? 0) > 1 ||
    (params?.getAll("embedded").length ?? 0) > 1
  ) {
    throw new Error("Grass appearance requires an unambiguous viewport route");
  }
  if (
    resolveExplicitStreamingRenderProfile(windowRef)?.id !==
    "island-meadow-720p60-v1"
  ) {
    throw new Error(
      "Natural grass requires the explicit non-embedded dense meadow profile",
    );
  }
  return "natural-tuft-v1";
}

/** Explicit full-island art candidate; never a silent broadcast/default change. */
export function resolveSkyAtmosphereMode(win?: Window): SkyAtmosphereMode {
  const windowRef = getWindowRef(win);
  if (!windowRef) return "gradient-v1";
  const values = getSearchParams(windowRef)?.getAll("skyAtmosphere") ?? [];
  if (!values.length) return "gradient-v1";
  if (values.length !== 1 || values[0] !== "scattering-v1")
    throw new Error("Unknown or duplicate sky atmosphere candidate");
  if (
    !["island-720p60-v1", "island-meadow-720p60-v1"].includes(
      resolveExplicitStreamingRenderProfile(windowRef)?.id ?? "",
    )
  )
    throw new Error(
      "Scattering sky requires the explicit non-embedded island profile",
    );
  return "scattering-v1";
}

export type StreamingRenderProfile =
  (typeof STREAMING_RENDER_PROFILES)[StreamingRenderProfileId];

export function resolveExplicitStreamingRenderProfile(
  win?: Window,
): StreamingRenderProfile | null {
  const windowRef = getWindowRef(win);
  if (!windowRef) return null;
  const params = getSearchParams(windowRef);
  const selections = params?.getAll("streamRenderProfile") ?? [];
  if (selections.length > 1) {
    throw new Error("streamRenderProfile requires exactly one value");
  }
  const rawProfile = (selections[0] || "").trim();
  if (!rawProfile) return null;
  if (
    !Object.prototype.hasOwnProperty.call(STREAMING_RENDER_PROFILES, rawProfile)
  ) {
    throw new Error(`Unknown streaming render profile: ${rawProfile}`);
  }

  const profile =
    STREAMING_RENDER_PROFILES[rawProfile as StreamingRenderProfileId];
  if (
    profile.shadows === "med" &&
    (!isStreamPageRoute(windowRef) ||
      parseTruthy(params?.get("embedded")) ||
      windowRef.__HYPERIA_EMBEDDED__ === true)
  ) {
    throw new Error(
      "The shadows render candidate requires the non-embedded StreamingMode route",
    );
  }
  if ((params?.getAll("streamFps").length ?? 0) > 1) {
    throw new Error("streamFps requires exactly one value");
  }
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

/** Settings locked for the lifetime of a broadcast, never persisted as user prefs. */
export type StreamingRenderPreferences = {
  dpr: number;
  shadows: string;
  postprocessing: boolean;
  bloom: boolean;
  colorGrading: string;
  depthBlur: boolean;
  waterReflections: boolean;
  entityHighlighting: boolean;
};

export function resolveStreamingRenderPreferences(
  width: number,
  height: number,
  profile: StreamingRenderProfile | null,
): StreamingRenderPreferences {
  const validSize =
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0;
  return {
    dpr: validSize
      ? Math.min(
          profile?.maximumDpr ?? 1,
          Math.sqrt(
            (profile?.renderPixelBudget ?? 1280 * 720) / (width * height),
          ),
        )
      : 1,
    shadows: profile?.shadows ?? "none",
    postprocessing: profile?.postprocessing ?? false,
    bloom: false,
    colorGrading: "none",
    depthBlur: false,
    waterReflections: false,
    entityHighlighting: false,
  };
}

/** Read-only observations, not an assertion that a GPU render succeeded. */
export type GrassSurfaceEligibility = "legacy-biome-v1" | "compact-pbr-v1";

export type StreamingGrassProfileReceipt = {
  schemaVersion: 1;
  profileId:
    | "ordinary-v1"
    | "fixed-arena-v1"
    | "compact-island-v1"
    | "compact-meadow-v2";
  eligibility: GrassSurfaceEligibility;
  terrainProfileIdentity: string;
  minimumLodLevel: number;
  clumpSpacingMultiplier: number;
  clumpSpacing: number;
  maxRenderDistance: number;
  maxChunksPerFrame: number;
  castShadow: boolean;
  destroyed: boolean;
  liveNodes: number;
  pendingChunks: number;
  inflightChunks: number;
  settledChunks: number;
  installedChunks: number;
  installedClumps: number;
  grounding?: {
    schemaVersion: 1;
    mode: "blade-roots-v1";
    runningChunks: number;
    waitingSupportChunks: number;
    failedChunks: number;
    cancelledChunks: number;
    completedChunks: number;
    readyEmptyChunks: number;
    correctionBytes: number;
    activeSliceMs: number;
    maximumSliceMs: number;
  };
};

export type StreamingRenderAppliedState = {
  preferences: StreamingRenderPreferences;
  renderer: {
    isWebGPU: boolean;
    hasRendered: boolean;
    dpr: number;
    width: number;
    height: number;
    samples: number;
    shadowsEnabled: boolean;
    shadowType: number;
    postprocessing: boolean;
    composerPresent: boolean;
  };
  sunlight: {
    name: string;
    castShadow: boolean;
    cascaded: boolean;
    mapSize: readonly [number, number];
    allocatedMapSize: readonly [number, number] | null;
    frustum: readonly [number, number, number, number, number, number];
    bias: number;
    normalBias: number;
  } | null;
  water: { reflectionsEnabled: boolean; activeReflectionCount: number } | null;
  /** Required only for the opt-in island profile; older receipts stay valid. */
  grass?: StreamingGrassProfileReceipt | null;
};

export type StreamingRenderProfileApplication = {
  schemaVersion: 1;
  ready: boolean;
  mismatchReason: string | null;
  requested: StreamingRenderPreferences;
  applied: StreamingRenderAppliedState | null;
};

/** Fail closed on missing/unapplied settings; native rendering remains a separate gate. */
export function evaluateStreamingRenderProfileApplication(
  profile: StreamingRenderProfile,
  requested: StreamingRenderPreferences,
  applied: StreamingRenderAppliedState | null,
): StreamingRenderProfileApplication {
  const finish = (
    mismatchReason: string | null,
  ): StreamingRenderProfileApplication => ({
    schemaVersion: 1,
    ready: mismatchReason === null,
    mismatchReason,
    requested,
    applied,
  });
  const expected = resolveStreamingRenderPreferences(
    profile.viewportWidth,
    profile.viewportHeight,
    profile,
  );
  for (const key of Object.keys(
    expected,
  ) as (keyof StreamingRenderPreferences)[]) {
    if (requested[key] !== expected[key]) return finish(`requested.${key}`);
  }
  if (!applied) return finish("renderer_unavailable");
  if (
    profile.grassProfile === "compact-island-v1" ||
    profile.grassProfile === "compact-meadow-v2"
  ) {
    const denseMeadow = profile.grassProfile === "compact-meadow-v2";
    const grass = applied.grass;
    if (!grass) return finish("grass_unavailable");
    if (
      grass.schemaVersion !== 1 ||
      grass.profileId !== profile.grassProfile ||
      grass.eligibility !== "compact-pbr-v1" ||
      typeof grass.terrainProfileIdentity !== "string" ||
      grass.terrainProfileIdentity.trim().length === 0 ||
      grass.terrainProfileIdentity.length > 16384 ||
      grass.minimumLodLevel !== 1 ||
      grass.clumpSpacingMultiplier !== (denseMeadow ? 2.5 : 4) ||
      grass.clumpSpacing !== (denseMeadow ? 1.75 : 2.8) ||
      grass.maxRenderDistance !== 140 ||
      grass.maxChunksPerFrame !== 1 ||
      grass.castShadow !== false ||
      grass.destroyed !== false
    )
      return finish("grass_profile");
    for (const value of [
      grass.liveNodes,
      grass.pendingChunks,
      grass.inflightChunks,
      grass.settledChunks,
      grass.installedChunks,
      grass.installedClumps,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0)
        return finish("grass_state");
    }
  }
  for (const key of Object.keys(
    expected,
  ) as (keyof StreamingRenderPreferences)[]) {
    if (applied.preferences[key] !== expected[key])
      return finish(`preferences.${key}`);
  }
  const renderer = applied.renderer;
  if (!renderer.isWebGPU || !renderer.hasRendered)
    return finish("renderer_not_rendered");
  if (
    renderer.dpr !== expected.dpr ||
    renderer.width !== profile.outputWidth ||
    renderer.height !== profile.outputHeight
  )
    return finish("render_dimensions");
  if (renderer.samples !== 4) return finish("antialiasing_samples");
  // THREE.PCFShadowMap's stable wire value. The collector reads the actual enum.
  if (!renderer.shadowsEnabled || renderer.shadowType !== 1)
    return finish("renderer_shadow_map");
  if (renderer.postprocessing || renderer.composerPresent)
    return finish("postprocessing");
  if (
    !applied.water ||
    applied.water.reflectionsEnabled ||
    applied.water.activeReflectionCount !== 0
  ) {
    return finish("water_reflections");
  }
  const sun = applied.sunlight;
  if (!sun) return finish("sunlight_unavailable");
  if (sun.cascaded) return finish("unexpected_cascaded_shadows");
  if (profile.shadows === "none") {
    if (
      sun.castShadow ||
      sun.allocatedMapSize !== null ||
      sun.name !== "SunLight_NoShadows"
    ) {
      return finish("unexpected_sun_shadows");
    }
  } else {
    if (!sun.castShadow || sun.name !== "SunLight_Single")
      return finish("sun_shadows_disabled");
    if (
      sun.mapSize[0] !== 4096 ||
      sun.mapSize[1] !== 4096 ||
      sun.allocatedMapSize?.[0] !== 4096 ||
      sun.allocatedMapSize?.[1] !== 4096
    ) {
      return finish("sun_shadow_map_size");
    }
    const frustum = [-200, 200, 200, -200, 0.5, 600];
    if (
      sun.frustum.length !== frustum.length ||
      sun.frustum.some((value, index) => value !== frustum[index]) ||
      sun.bias !== 0.0002 ||
      sun.normalBias !== 0.01
    )
      return finish("sun_shadow_projection");
  }
  return finish(null);
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
