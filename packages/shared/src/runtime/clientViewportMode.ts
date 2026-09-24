import {
  createGrassPlacementCellOperations,
  type GrassPlacementCoverageTrial,
} from "../utils/workers/GrassPlacementCell";
import type {
  CompactCoastBlend,
  CompactPondBlend,
} from "../systems/shared/world/CompactTerrainMaterial";
import {
  deserializeWorldTerrainProfile,
  isCompactSculptProfile,
  worldTerrainProfileIdentity,
} from "../systems/shared/world/WorldTerrainProfile";

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
  // Fine continuous meadow trial with bounded grass-owned cells. A new profile
  // records changed population explicitly; all render-quality settings match.
  "island-fine-meadow-720p60-v1": Object.freeze({
    id: "island-fine-meadow-720p60-v1" as const,
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
    grassProfile: "fine-meadow-v1" as const,
    avatarLodPolicy: "distance-authoritative-v1" as const,
  }),
});

export type StreamingRenderProfileId = keyof typeof STREAMING_RENDER_PROFILES;
export type SkyAtmosphereMode = "gradient-v1" | "scattering-v1";
export type GrassAppearanceCandidate = "natural-tuft-v1" | "fine-meadow-v1";
export type GrassLightingCandidate = "canopy-normal-v1" | "leaf-volume-v1";
export type GrassGeometryCandidate =
  "sheath-close-v1" | "rooted-fan-v1" | "meadow-canopy-v1" | "meadow-field-v1";
export type GrassPaletteCandidate = "regional-v1";
export type RootedFlowerCandidate = "rooted-v1";

/** Explicit native shadow correctness trial; omission keeps current defaults.
 * The Environment owner separately admits WebGPU, compact terrain and one map. */
export function resolveSingleMapShadowFlow(
  win?: Window,
): "uniform-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("shadowFlow") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "uniform-v1")
    throw new Error("Unknown or duplicate single-map shadow flow candidate");
  if (
    (params?.getAll("page").length ?? 0) > 1 ||
    (params?.getAll("embedded").length ?? 0) > 1 ||
    ![
      "island-720p60-v1",
      "island-meadow-720p60-v1",
      "island-fine-meadow-720p60-v1",
    ].includes(resolveExplicitStreamingRenderProfile(windowRef)?.id ?? "")
  )
    throw new Error(
      "Single-map shadow flow requires the explicit non-embedded island profile",
    );
  return "uniform-v1";
}

/** Explicit rooted-flower population; omission never enables this owner. */
export function resolveRootedFlowerCandidate(
  win?: Window,
): RootedFlowerCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("flowers") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "rooted-v1")
    throw new Error("Unknown or duplicate rooted flower candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Rooted flowers require the explicit fine meadow pair");
  return "rooted-v1";
}

/** Explicit tree motion qualification; omission keeps the existing renderer.
 * Resolve once during world creation, never per frame or from material cache. */
export function resolveTreeWindCandidate(
  win?: Window,
): "connected-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const values = getSearchParams(windowRef)?.getAll("treeWind") ?? [];
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0] !== "connected-v1")
    throw new Error("Unknown or duplicate tree wind candidate");
  return "connected-v1";
}

/** Explicit fine-meadow reflectance trial; captured once by the terrain owner.
 * No profile, placement, density, geometry, or lighting selection is changed. */
export function resolveGrassPaletteCandidate(
  win?: Window,
): GrassPaletteCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassPalette") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "regional-v1")
    throw new Error("Unknown or duplicate grass palette candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Grass palette requires the explicit fine meadow pair");
  return "regional-v1";
}

/** Fine-only shading trial, captured once by the terrain owner; no density change. */
export function resolveGrassLightingCandidate(
  win?: Window,
): GrassLightingCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassLighting") ?? [];
  if (!values.length) return undefined;
  if (
    values.length !== 1 ||
    (values[0] !== "canopy-normal-v1" && values[0] !== "leaf-volume-v1")
  )
    throw new Error("Unknown or duplicate grass lighting candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Grass lighting requires the explicit fine meadow pair");
  return values[0];
}

/** Explicit grass geometry/composition; the field candidate also adds density.
 * Omission retains the historical geometry; capture once with the terrain owner. */
export function resolveGrassGeometryCandidate(
  win?: Window,
): GrassGeometryCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassGeometry") ?? [];
  if (!values.length) return undefined;
  if (
    values.length !== 1 ||
    (values[0] !== "sheath-close-v1" &&
      values[0] !== "rooted-fan-v1" &&
      values[0] !== "meadow-canopy-v1" &&
      values[0] !== "meadow-field-v1")
  )
    throw new Error("Unknown or duplicate grass geometry candidate");
  if (resolveGrassLightingCandidate(windowRef) !== "leaf-volume-v1")
    throw new Error(
      "Grass geometry requires the explicit leaf-volume fine meadow",
    );
  if (
    values[0] === "meadow-field-v1" &&
    (params?.has("grassCoverage") || params?.has("grassCoverageCell"))
  )
    throw new Error(
      "Dense meadow field cannot mix a single-cell coverage trial",
    );
  return values[0];
}

/** Explicit dirt-material preview; its terrain owner also admits the sculpt profile. */
export function resolveCompactDirtProjectionCandidate(
  win?: Window,
): "stochastic-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("dirtProjection") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "stochastic-v1")
    throw new Error("Unknown or duplicate dirt projection candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Dirt projection requires the explicit fine meadow pair");
  return "stochastic-v1";
}

/** Explicit rock-material preview, independent of dirt and surface blending. */
export function resolveCompactRockProjectionCandidate(
  win?: Window,
): "stochastic-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("rockProjection") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "stochastic-v1")
    throw new Error("Unknown or duplicate rock projection candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Rock projection requires the explicit fine meadow pair");
  return "stochastic-v1";
}

/** Opt-in exact-zero rock sampling; omission preserves the existing shader. */
export function resolveCompactRockSampling(
  win?: Window,
): "exact-zero-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("rockSampling") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "exact-zero-v1")
    throw new Error("Unknown or duplicate rock sampling candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Rock sampling requires the explicit fine meadow pair");
  if (
    resolveCompactRockProjectionCandidate(windowRef) !== "stochastic-v1" ||
    resolveCompactDirtProjectionCandidate(windowRef) !== "stochastic-v1" ||
    resolveCompactSurfaceBlendCandidate(windowRef) !== "height-v1" ||
    resolveCompactPondBlendCandidate(windowRef) !== "composition-v1"
  )
    throw new Error(
      "Rock sampling requires stochastic rock/dirt, height-v1 and composition-v1",
    );
  if (resolveCompactCoastBlend(windowRef) === "cavity-v1")
    throw new Error("Rock sampling does not support cavity-v1 coast blending");
  return "exact-zero-v1";
}

/** Explicit surface-blend preview; the terrain owner separately admits sculpt terrain. */
export function resolveCompactSurfaceBlendCandidate(
  win?: Window,
): "height-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("terrainBlend") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "height-v1")
    throw new Error("Unknown or duplicate terrain blend candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Terrain blend requires the explicit fine meadow pair");
  return "height-v1";
}

/** Pond-only preview; never selected by a rendering/default profile. */
export function resolveCompactPondBlendCandidate(
  win?: Window,
): CompactPondBlend | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("pondBlend") ?? [];
  if (!values.length) return undefined;
  if (
    values.length !== 1 ||
    (values[0] !== "relief-v1" &&
      values[0] !== "relief-contact-v1" &&
      values[0] !== "shore-contact-v1" &&
      values[0] !== "composition-v1")
  )
    throw new Error("Unknown or duplicate pond blend candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Pond blend requires the explicit fine meadow pair");
  if (resolveCompactSurfaceBlendCandidate(windowRef) !== "height-v1")
    throw new Error("Pond blend requires terrainBlend=height-v1");
  return values[0];
}

/** Restart-owned coastal preview; absence preserves existing profiles. */
export function resolveCompactCoastBlend(
  win?: Window,
): CompactCoastBlend | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("coastBlend") ?? [];
  if (!values.length) return undefined;
  if (
    values.length !== 1 ||
    (values[0] !== "detail-v1" &&
      values[0] !== "distribution-v1" &&
      values[0] !== "cavity-v1")
  )
    throw new Error("Unknown or duplicate coast blend candidate");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error("Coast blend requires the explicit fine meadow pair");
  if (resolveCompactSurfaceBlendCandidate(windowRef) !== "height-v1")
    throw new Error("Coast blend requires terrainBlend=height-v1");
  return values[0];
}

/** Explicit fine-grass road clearance, captured by its owner until restart. */
export function resolveGrassRoadClearance(
  win?: Window,
): "per-blade-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassRoadClearance") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "per-blade-v1")
    throw new Error("Unknown or duplicate grass road-clearance selector");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error(
      "Grass road clearance requires the explicit fine meadow pair",
    );
  return "per-blade-v1";
}

/** Explicit execution trial only; no grass density, geometry or cap changes.
 * Captured at owner creation, never toggled under in-flight transfers. */
export function resolveGrassGroundingExecution(
  win?: Window,
): "worker-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassGrounding") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "worker-v1")
    throw new Error("Unknown or duplicate grass grounding execution selector");
  if (
    resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1" ||
    params?.get("streamRenderProfile") !== "island-fine-meadow-720p60-v1"
  )
    throw new Error(
      "Grass grounding worker requires the explicit fine meadow pair",
    );
  return "worker-v1";
}

/** Explicit single-cell density trial, captured by its owner until restart. */
export function resolveGrassCoverageTrial(
  win?: Window,
): GrassPlacementCoverageTrial | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const selectors = params?.getAll("grassCoverage") ?? [];
  const cells = params?.getAll("grassCoverageCell") ?? [];
  if (!selectors.length && !cells.length) return undefined;
  if (selectors.length !== 1 || cells.length !== 1)
    throw new Error("Grass coverage requires one selector and one cell");
  // Canonical decimal indices only: no coercion of whitespace, fractions,
  // exponents, alternate bases or signed zero into a different selected cell.
  if (!/^(0|-?[1-9]\d*),(0|-?[1-9]\d*)$/u.test(cells[0]))
    throw new Error(
      "Grass coverage requires two canonical integer cell indices",
    );
  if (resolveGrassAppearanceCandidate(windowRef) !== "fine-meadow-v1")
    throw new Error("Grass coverage requires the explicit fine meadow pair");
  const [indexX, indexZ] = cells[0].split(",").map(Number);
  // The shared worker-domain validator owns the bounded grid and selector;
  // it also returns detached, frozen trial and cell records.
  return createGrassPlacementCellOperations().validateCoverageTrial({
    id: selectors[0],
    cell: { schemaVersion: 1, size: 25, indexX, indexZ },
  });
}

/** Explicit shared ground/grass art trial; never a population or quality switch. */
export function resolveHabitatCompositionCandidate(
  win?: Window,
): "haven-understory-v1" | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const values = getSearchParams(windowRef)?.getAll("habitatComposition") ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "haven-understory-v1")
    throw new Error("Unknown or duplicate habitat composition candidate");
  if (
    !["natural-tuft-v1", "fine-meadow-v1"].includes(
      resolveGrassAppearanceCandidate(windowRef) ?? "",
    )
  )
    throw new Error("Habitat composition requires the explicit natural meadow");
  return "haven-understory-v1";
}

/** Explicit appearance/profile pair; no unrequested population or default change. */
export function resolveGrassAppearanceCandidate(
  win?: Window,
): GrassAppearanceCandidate | undefined {
  const windowRef = getWindowRef(win);
  if (!windowRef) return undefined;
  const params = getSearchParams(windowRef);
  const values = params?.getAll("grassAppearance") ?? [];
  if (!values.length) {
    if (
      (params?.getAll("streamRenderProfile") ?? []).includes(
        "island-fine-meadow-720p60-v1",
      )
    ) {
      resolveExplicitStreamingRenderProfile(windowRef);
      throw new Error("Fine meadow requires its explicit grass appearance");
    }
    return undefined;
  }
  if (
    values.length !== 1 ||
    !["natural-tuft-v1", "fine-meadow-v1"].includes(values[0])
  ) {
    throw new Error("Unknown or duplicate grass appearance candidate");
  }
  if (
    (params?.getAll("page").length ?? 0) > 1 ||
    (params?.getAll("embedded").length ?? 0) > 1
  ) {
    throw new Error("Grass appearance requires an unambiguous viewport route");
  }
  const fine = values[0] === "fine-meadow-v1";
  if (
    resolveExplicitStreamingRenderProfile(windowRef)?.id !==
    (fine ? "island-fine-meadow-720p60-v1" : "island-meadow-720p60-v1")
  ) {
    throw new Error(
      fine
        ? "Fine grass requires the explicit non-embedded fine meadow profile"
        : "Natural grass requires the explicit non-embedded dense meadow profile",
    );
  }
  return fine ? "fine-meadow-v1" : "natural-tuft-v1";
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
    ![
      "island-720p60-v1",
      "island-meadow-720p60-v1",
      "island-fine-meadow-720p60-v1",
    ].includes(resolveExplicitStreamingRenderProfile(windowRef)?.id ?? "")
  )
    throw new Error(
      "Scattering sky requires the explicit non-embedded island profile",
    );
  return "scattering-v1";
}

export type StreamingRenderProfile =
  (typeof STREAMING_RENDER_PROFILES)[StreamingRenderProfileId];

/**
 * Explicit local art preview for an ordinary playable client. This only admits
 * the retained island selectors; it never applies broadcast preferences or
 * turns off controls, local physics, or exploration systems.
 */
export function resolveLocalPlayerWorldPreview(win?: Window): boolean {
  const windowRef = getWindowRef(win);
  if (!windowRef) return false;
  const params = getSearchParams(windowRef);
  const selections = params?.getAll("worldPreview") ?? [];
  if (!selections.length) return false;
  if (selections.length !== 1 || selections[0] !== "retained-v1") {
    throw new Error("worldPreview requires exactly one retained-v1 value");
  }
  if (
    windowRef.location.origin !== "http://localhost:3333" ||
    windowRef.location.pathname !== "/" ||
    ["page", "mode", "embedded", "streamWorld"].some((key) =>
      params?.has(key),
    ) ||
    windowRef.__HYPERIA_EMBEDDED__ === true ||
    windowRef.__HYPERIA_CONFIG__?.mode === "spectator"
  ) {
    throw new Error(
      "worldPreview requires the non-embedded localhost player route",
    );
  }
  const profiles = params?.getAll("streamRenderProfile") ?? [];
  if (profiles.length !== 1 || profiles[0] !== "island-fine-meadow-720p60-v1") {
    throw new Error("worldPreview requires exactly one fine meadow profile");
  }
  return true;
}

export function resolveExplicitStreamingRenderProfile(
  win?: Window,
): StreamingRenderProfile | null {
  const windowRef = getWindowRef(win);
  if (!windowRef) return null;
  const localPlayerPreview = resolveLocalPlayerWorldPreview(windowRef);
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
    ((!isStreamPageRoute(windowRef) && !localPlayerPreview) ||
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
  /** Explicit fine geometry/addressing revision; absent for ordinary owners. */
  geometryLayout?: import("../systems/shared/world/GrassBladeLayout").FineGrassGeometryLayout;
  /** Opt-in authored composition; historical receipts omit this identity. */
  geometryCandidate?: GrassGeometryCandidate;
  profileId:
    | "ordinary-v1"
    | "fixed-arena-v1"
    | "compact-island-v1"
    | "compact-meadow-v2"
    | "fine-meadow-v1";
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
  /** Grass-owned cells reference real terrain leaves; they are not terrain nodes. */
  placement?: {
    schemaVersion: 1;
    mode: "world-cells-v1";
    /** Explicit fine-only sampling policy; absent in historical receipts. */
    placementDistribution?: "fine-cell-stratified-v1";
    /** Restart-owned single-cell experiment; absent for unchanged coverage. */
    readonly coverageTrial?: GrassPlacementCoverageTrial;
    cellSize: 25;
    nearLodDistance: 40;
    /** Extra detail within cells intersecting 12m; population boundary stays 40m. */
    detailLodDistance?: 12;
    liveCells: number;
  };
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
    /** Explicit fine-only mode and live mask bytes, not a GPU allocation claim. */
    roadClearance?: {
      mode: "per-blade-v1";
      visibilityBytes: number;
    };
    activeSliceMs: number;
    maximumSliceMs: number;
    execution?: "worker-v1";
    /** Bounded worker-owned payload accounting, not total CPU/GPU heap. */
    worker?: import("../systems/shared/world/GrassGroundingWorkerCoordinator").GrassGroundingWorkerCoordinator["receipt"];
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
    /** Canonical profile captured by the actual compact single-map light owner. */
    terrainProfileIdentity?: string | null;
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

// Readiness is sampled repeatedly. Retain just one bounded identity so a stable
// light does not reparse/validate its complete terrain profile every sample.
let lastShadowTerrainIdentity: string | null = null;
let lastShadowTerrainIdentityValid = false;
function isCanonicalCompactShadowIdentity(identity: string): boolean {
  if (identity.length === 0 || identity.length > 16_384) return false;
  if (identity === lastShadowTerrainIdentity)
    return lastShadowTerrainIdentityValid;
  const prefix = "hyperia-world-terrain-profile-v1\n";
  let valid = false;
  if (identity.startsWith(prefix)) {
    try {
      const profile = deserializeWorldTerrainProfile(
        identity.slice(prefix.length),
      );
      valid =
        isCompactSculptProfile(profile) &&
        worldTerrainProfileIdentity(profile) === identity;
    } catch {
      // An invalid or noncanonical supplied identity must never enable bias 0.
    }
  }
  lastShadowTerrainIdentity = identity;
  lastShadowTerrainIdentityValid = valid;
  return valid;
}

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
    profile.grassProfile === "compact-meadow-v2" ||
    profile.grassProfile === "fine-meadow-v1"
  ) {
    const denseMeadow = profile.grassProfile === "compact-meadow-v2";
    const fineMeadow = profile.grassProfile === "fine-meadow-v1";
    const grass = applied.grass;
    if (!grass) return finish("grass_unavailable");
    const meadowField = grass.geometryCandidate === "meadow-field-v1";
    if (
      grass.schemaVersion !== 1 ||
      grass.profileId !== profile.grassProfile ||
      grass.eligibility !== "compact-pbr-v1" ||
      typeof grass.terrainProfileIdentity !== "string" ||
      grass.terrainProfileIdentity.trim().length === 0 ||
      grass.terrainProfileIdentity.length > 16384 ||
      grass.minimumLodLevel !== (fineMeadow ? 0 : 1) ||
      grass.clumpSpacingMultiplier !==
        (fineMeadow ? (meadowField ? 0.5 / 0.7 : 1) : denseMeadow ? 2.5 : 4) ||
      grass.clumpSpacing !==
        (fineMeadow ? (meadowField ? 0.5 : 0.7) : denseMeadow ? 1.75 : 2.8) ||
      grass.maxRenderDistance !== 140 ||
      grass.maxChunksPerFrame !== 1 ||
      grass.castShadow !== false ||
      grass.destroyed !== false ||
      (grass.geometryLayout === "fine-meadow-ribbon-v1" && !meadowField) ||
      (grass.geometryCandidate !== undefined &&
        (!fineMeadow ||
          grass.geometryLayout !==
            (meadowField
              ? "fine-meadow-ribbon-v1"
              : "fine-folded-sheath-near5-v1") ||
          (grass.geometryCandidate !== "sheath-close-v1" &&
            grass.geometryCandidate !== "rooted-fan-v1" &&
            grass.geometryCandidate !== "meadow-canopy-v1" &&
            !meadowField)))
    )
      return finish("grass_profile");
    if (fineMeadow) {
      const placement = grass.placement;
      if (
        placement?.schemaVersion !== 1 ||
        placement.mode !== "world-cells-v1" ||
        placement.cellSize !== 25 ||
        placement.nearLodDistance !== 40 ||
        placement.detailLodDistance !==
          (grass.geometryLayout === "fine-folded-sheath-near5-v1" || meadowField
            ? 12
            : undefined) ||
        (meadowField && placement.coverageTrial !== undefined) ||
        !Number.isSafeInteger(placement.liveCells) ||
        placement.liveCells < 0
      )
        return finish("grass_placement");
    } else if (grass.placement !== undefined) {
      return finish("grass_placement");
    }
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
      sun.name !== "SunLight_NoShadows" ||
      sun.terrainProfileIdentity != null
    ) {
      return finish("unexpected_sun_shadows");
    }
  } else {
    const identity = sun.terrainProfileIdentity;
    const compact =
      typeof identity === "string" &&
      isCanonicalCompactShadowIdentity(identity);
    if (identity != null && !compact) return finish("sun_terrain_profile");
    if (
      profile.grassProfile !== "fixed-arena-v1" &&
      (!compact || applied.grass?.terrainProfileIdentity !== identity)
    )
      return finish("sun_grass_terrain_profile");
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
      sun.bias !== (compact ? 0 : 0.0002) ||
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
  resolveLocalPlayerWorldPreview(win);
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
