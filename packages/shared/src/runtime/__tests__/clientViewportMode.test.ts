import { describe, expect, it } from "vitest";
import {
  isEmbeddedSpectatorViewport,
  isStreamPageRoute,
  isStreamingLikeViewport,
  resolveClientViewportRuntimeProfile,
  resolveExplicitStreamingRenderProfile,
  resolveExplicitStreamingWorldProfile,
  resolveGrassAppearanceCandidate,
  resolveSkyAtmosphereMode,
  resolveStreamingRenderFrameRate,
  shouldAdmitNetworkEntityInViewport,
  shouldStreamVegetationBackgroundLods,
  STREAMING_RENDER_PROFILES,
  resolveStreamingRenderPreferences,
  evaluateStreamingRenderProfileApplication,
  type StreamingRenderAppliedState,
  type StreamingGrassProfileReceipt,
} from "../clientViewportMode";

function makeWindow(pathname: string, search = ""): Window {
  return { location: { pathname, search } } as unknown as Window;
}

describe("explicit grass appearance candidate selection", () => {
  const selection =
    "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1";

  it("leaves absent appearance selections and existing profiles unchanged", () => {
    expect(resolveGrassAppearanceCandidate()).toBeUndefined();
    for (const pathname of ["/play", "/stream.html"]) {
      expect(
        resolveGrassAppearanceCandidate(makeWindow(pathname)),
      ).toBeUndefined();
      for (const id of Object.keys(STREAMING_RENDER_PROFILES)) {
        expect(
          resolveGrassAppearanceCandidate(
            makeWindow(pathname, `?streamRenderProfile=${id}`),
          ),
        ).toBeUndefined();
      }
    }
  });

  it.each([
    ["/stream.html", `?${selection}`],
    ["/stream.html", `?${selection}&streamFps=60&embedded=false`],
    ["/", `?page=stream&${selection}`],
  ])("admits an explicit non-embedded dense meadow at %s%s", (path, search) => {
    expect(resolveGrassAppearanceCandidate(makeWindow(path, search))).toBe(
      "natural-tuft-v1",
    );
  });

  it.each([
    "",
    "unknown",
    "NATURAL-TUFT-V1",
    "%20natural-tuft-v1",
    "natural-tuft-v1%20",
    "natural-tuft-v1&grassAppearance=natural-tuft-v1",
    "natural-tuft-v1&grassAppearance=unknown",
  ])("rejects malformed or duplicate appearance values: %s", (value) => {
    expect(() =>
      resolveGrassAppearanceCandidate(
        makeWindow(
          "/stream.html",
          `?streamRenderProfile=island-meadow-720p60-v1&grassAppearance=${value}`,
        ),
      ),
    ).toThrow("Unknown or duplicate grass appearance candidate");
  });

  it.each([
    "/play?" + selection,
    "/stream.html?grassAppearance=natural-tuft-v1",
    "/stream.html?streamRenderProfile=canonical-720p60-v1&grassAppearance=natural-tuft-v1",
    "/stream.html?streamRenderProfile=fallback-720p30-v1&grassAppearance=natural-tuft-v1",
    "/stream.html?streamRenderProfile=shadows-720p60-v1&grassAppearance=natural-tuft-v1",
    "/stream.html?streamRenderProfile=island-720p60-v1&grassAppearance=natural-tuft-v1",
    "/stream.html?streamRenderProfile=unknown&grassAppearance=natural-tuft-v1",
    "/stream.html?" + selection + "&embedded=true",
    "/stream.html?" + selection + "&embedded=1",
    "/stream.html?" + selection + "&embedded=false&embedded=true",
    "/?page=stream&page=play&" + selection,
    "/stream.html?" + selection + "&streamFps=30",
    "/stream.html?" + selection + "&streamFps=60.0",
    "/stream.html?" + selection + "&streamFps=60&streamFps=60",
    "/stream.html?" +
      selection +
      "&streamRenderProfile=island-meadow-720p60-v1",
  ])("rejects an ineligible or ambiguous route: %s", (url) => {
    const [pathname, query] = url.split("?");
    expect(() =>
      resolveGrassAppearanceCandidate(makeWindow(pathname, "?" + query)),
    ).toThrow();
  });

  it("rejects an embedded application even without an embedded URL flag", () => {
    const win = makeWindow("/stream.html", "?" + selection) as Window & {
      __HYPERIA_EMBEDDED__?: boolean;
    };
    win.__HYPERIA_EMBEDDED__ = true;
    expect(() => resolveGrassAppearanceCandidate(win)).toThrow("non-embedded");
  });

  it("does not change render budgets or viewport population/admission policy", () => {
    const baseline = makeWindow(
      "/stream.html",
      "?streamRenderProfile=island-meadow-720p60-v1&streamWorld=preparation-v1",
    );
    const candidate = makeWindow(
      "/stream.html",
      baseline.location.search + "&grassAppearance=natural-tuft-v1",
    );
    expect(resolveGrassAppearanceCandidate(candidate)).toBe("natural-tuft-v1");
    expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
      STREAMING_RENDER_PROFILES["island-meadow-720p60-v1"],
    );
    expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
      resolveExplicitStreamingRenderProfile(baseline),
    );
    expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
      resolveClientViewportRuntimeProfile(baseline),
    );
    expect(
      resolveStreamingRenderPreferences(
        1280,
        720,
        resolveExplicitStreamingRenderProfile(candidate),
      ),
    ).toEqual(
      resolveStreamingRenderPreferences(
        1280,
        720,
        resolveExplicitStreamingRenderProfile(baseline),
      ),
    );
  });
});

describe("explicit atmosphere candidate selection", () => {
  it("leaves defaults unchanged and admits only an explicit full-island candidate", () => {
    expect(resolveSkyAtmosphereMode()).toBe("gradient-v1");
    expect(
      resolveSkyAtmosphereMode(
        makeWindow("/stream.html", "?streamRenderProfile=island-720p60-v1"),
      ),
    ).toBe("gradient-v1");
    expect(
      resolveSkyAtmosphereMode(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=island-720p60-v1&skyAtmosphere=scattering-v1",
        ),
      ),
    ).toBe("scattering-v1");
  });
  it.each([
    "/play?streamRenderProfile=island-720p60-v1&skyAtmosphere=scattering-v1",
    "/stream.html?skyAtmosphere=scattering-v1",
    "/stream.html?streamRenderProfile=canonical-720p60-v1&skyAtmosphere=scattering-v1",
    "/stream.html?streamRenderProfile=island-720p60-v1&skyAtmosphere=scattering-v1&embedded=true",
    "/stream.html?streamRenderProfile=island-720p60-v1&skyAtmosphere=",
    "/stream.html?streamRenderProfile=island-720p60-v1&skyAtmosphere=unknown",
    "/stream.html?streamRenderProfile=island-720p60-v1&skyAtmosphere=scattering-v1&skyAtmosphere=scattering-v1",
  ])("rejects an unqualified or ambiguous atmosphere selection: %s", (url) => {
    const [pathname, query] = url.split("?");
    expect(() =>
      resolveSkyAtmosphereMode(makeWindow(pathname, "?" + query)),
    ).toThrow();
  });
});

describe("opt-in shadows render contract (CPU validation, not GPU execution)", () => {
  const profile = STREAMING_RENDER_PROFILES["shadows-720p60-v1"];
  const requested = resolveStreamingRenderPreferences(1280, 720, profile);
  const observed = (): StreamingRenderAppliedState => ({
    preferences: { ...requested },
    renderer: {
      isWebGPU: true,
      hasRendered: true,
      dpr: 1,
      width: 1280,
      height: 720,
      samples: 4,
      shadowsEnabled: true,
      shadowType: 1,
      postprocessing: false,
      composerPresent: false,
    },
    sunlight: {
      name: "SunLight_Single",
      castShadow: true,
      cascaded: false,
      mapSize: [4096, 4096],
      allocatedMapSize: [4096, 4096],
      frustum: [-200, 200, 200, -200, 0.5, 600],
      bias: 0.0002,
      normalBias: 0.01,
    },
    water: { reflectionsEnabled: false, activeReflectionCount: 0 },
  });

  it("only changes the explicit id and shadows; population and all other budgets stay identical", () => {
    expect({ ...profile, id: "canonical-720p60-v1", shadows: "none" }).toEqual(
      STREAMING_RENDER_PROFILES["canonical-720p60-v1"],
    );
    expect(
      resolveExplicitStreamingRenderProfile(makeWindow("/stream.html")),
    ).toBeNull();
    expect(
      resolveExplicitStreamingRenderProfile(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=shadows-720p60-v1&streamFps=60",
        ),
      ),
    ).toBe(profile);
    expect(
      resolveClientViewportRuntimeProfile(
        makeWindow(
          "/stream.html",
          "?streamWorld=preparation-v1&streamRenderProfile=shadows-720p60-v1",
        ),
      ),
    ).toEqual(
      resolveClientViewportRuntimeProfile(
        makeWindow("/stream.html", "?streamWorld=preparation-v1"),
      ),
    );
  });

  it.each([
    "?streamRenderProfile=shadows-720p60-v1&streamFps=30",
    "?streamRenderProfile=shadows-720p60-v1&streamRenderProfile=shadows-720p60-v1",
    "?streamRenderProfile=shadows-720p60-v1&streamFps=60&streamFps=60",
    "?streamRenderProfile=toString",
    "?streamRenderProfile=__proto__",
  ])("rejects ambiguous or contradictory selections %s", (query) => {
    expect(() =>
      resolveExplicitStreamingRenderProfile(makeWindow("/stream.html", query)),
    ).toThrow();
  });

  it("does not admit the experimental profile in an ordinary viewport", () => {
    expect(() =>
      resolveExplicitStreamingRenderProfile(
        makeWindow("/play", "?streamRenderProfile=shadows-720p60-v1"),
      ),
    ).toThrow(/non-embedded StreamingMode/);
  });

  it("admits the existing page=stream alias but rejects embedded routing before it", () => {
    expect(
      resolveExplicitStreamingRenderProfile(
        makeWindow("/", "?page=stream&streamRenderProfile=shadows-720p60-v1"),
      ),
    ).toBe(profile);
    for (const query of [
      "?embedded=true&mode=spectator&streamRenderProfile=shadows-720p60-v1",
      "?embedded=true&mode=spectator&page=stream&streamRenderProfile=shadows-720p60-v1",
      "?embedded=true&mode=agent&page=stream&streamRenderProfile=shadows-720p60-v1",
    ]) {
      expect(() =>
        resolveExplicitStreamingRenderProfile(makeWindow("/", query)),
      ).toThrow(/non-embedded StreamingMode/);
    }
    const configured = makeWindow(
      "/",
      "?page=stream&streamRenderProfile=shadows-720p60-v1",
    );
    Object.assign(configured, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveExplicitStreamingRenderProfile(configured)).toThrow(
      /non-embedded StreamingMode/,
    );
  });

  it("requires observed renderer work; requested constants alone cannot qualify", () => {
    expect(
      evaluateStreamingRenderProfileApplication(profile, requested, null),
    ).toMatchObject({
      ready: false,
      mismatchReason: "renderer_unavailable",
      applied: null,
    });
    expect(
      evaluateStreamingRenderProfileApplication(profile, requested, observed()),
    ).toMatchObject({ schemaVersion: 1, ready: true, mismatchReason: null });
  });

  it("keeps the island candidate explicit and changes only its grass profile", () => {
    const island = STREAMING_RENDER_PROFILES["island-720p60-v1"];
    expect({
      ...island,
      id: profile.id,
      grassProfile: profile.grassProfile,
    }).toEqual(profile);
    for (const route of ["/stream.html", "/?page=stream"]) {
      const [path, query] = route.split("?");
      expect(
        resolveExplicitStreamingRenderProfile(
          makeWindow(
            path,
            `?${query ? `${query}&` : ""}streamRenderProfile=island-720p60-v1`,
          ),
        ),
      ).toBe(island);
    }
    for (const [path, query] of [
      ["/play", ""],
      ["/", "embedded=true&mode=spectator&"],
      ["/stream.html", "embedded=true&"],
      ["/stream.html", "streamFps=30&"],
      ["/stream.html", "streamRenderProfile=canonical-720p60-v1&"],
    ])
      expect(() =>
        resolveExplicitStreamingRenderProfile(
          makeWindow(path, `?${query}streamRenderProfile=island-720p60-v1`),
        ),
      ).toThrow();
    expect(
      resolveExplicitStreamingRenderProfile(
        makeWindow("/stream.html", "?streamFps=60"),
      ),
    ).toBeNull();
  });

  it.each(["island-720p60-v1", "island-meadow-720p60-v1"] as const)(
    "requires actual %s grass configuration, not an advertised ready bit or clump quota",
    (id) => {
      const island = STREAMING_RENDER_PROFILES[id];
      const dense = id === "island-meadow-720p60-v1";
      const state = observed();
      expect(
        evaluateStreamingRenderProfileApplication(island, requested, state)
          .mismatchReason,
      ).toBe("grass_unavailable");
      const grass: StreamingGrassProfileReceipt = {
        schemaVersion: 1,
        profileId: dense ? "compact-meadow-v2" : "compact-island-v1",
        eligibility: "compact-pbr-v1",
        terrainProfileIdentity: "admitted-terrain",
        minimumLodLevel: 1,
        clumpSpacingMultiplier: dense ? 2.5 : 4,
        clumpSpacing: dense ? 1.75 : 2.8,
        maxRenderDistance: 140,
        maxChunksPerFrame: 1,
        castShadow: false,
        destroyed: false,
        liveNodes: 0,
        pendingChunks: 0,
        inflightChunks: 0,
        settledChunks: 0,
        installedChunks: 0,
        installedClumps: 0,
      };
      state.grass = grass;
      expect(
        evaluateStreamingRenderProfileApplication(island, requested, state)
          .ready,
      ).toBe(true);
      const invalid: Partial<StreamingGrassProfileReceipt>[] = [
        { profileId: "fixed-arena-v1" },
        { profileId: dense ? "compact-island-v1" : "compact-meadow-v2" },
        { clumpSpacingMultiplier: dense ? 4 : 2.5 },
        { clumpSpacing: dense ? 2.8 : 1.75 },
        { eligibility: "legacy-biome-v1" },
        { minimumLodLevel: 2 },
        { clumpSpacingMultiplier: 1 },
        { clumpSpacing: 0.7 },
        { maxRenderDistance: 500 },
        { maxChunksPerFrame: 2 },
        { castShadow: true },
        { destroyed: true },
        { terrainProfileIdentity: "" },
        { installedClumps: NaN },
        { pendingChunks: -1 },
        { settledChunks: 0.5 },
      ];
      for (const change of invalid) {
        state.grass = { ...grass, ...change };
        expect(
          evaluateStreamingRenderProfileApplication(island, requested, state)
            .ready,
        ).toBe(false);
      }
      state.grass = null;
      expect(
        evaluateStreamingRenderProfileApplication(profile, requested, state)
          .ready,
      ).toBe(true);
    },
  );

  it("keeps dense meadow opt-in without reducing any existing rendering quality", () => {
    const original = STREAMING_RENDER_PROFILES["island-720p60-v1"];
    const dense = STREAMING_RENDER_PROFILES["island-meadow-720p60-v1"];
    expect({
      ...dense,
      id: original.id,
      grassProfile: original.grassProfile,
    }).toEqual(original);
    expect(
      resolveExplicitStreamingRenderProfile(makeWindow("/stream.html")),
    ).toBeNull();
    expect(
      resolveExplicitStreamingRenderProfile(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=island-meadow-720p60-v1",
        ),
      ),
    ).toBe(dense);
    for (const query of [
      "&embedded=true",
      "&streamFps=30",
      "&streamRenderProfile=island-720p60-v1",
    ]) {
      expect(() =>
        resolveExplicitStreamingRenderProfile(
          makeWindow(
            "/stream.html",
            "?streamRenderProfile=island-meadow-720p60-v1" + query,
          ),
        ),
      ).toThrow();
    }
    expect(() =>
      resolveExplicitStreamingRenderProfile(
        makeWindow("/play", "?streamRenderProfile=island-meadow-720p60-v1"),
      ),
    ).toThrow();
  });

  it.each([
    [
      "preferences",
      (state: StreamingRenderAppliedState) => {
        state.preferences.shadows = "none";
      },
    ],
    [
      "DPR",
      (state: StreamingRenderAppliedState) => {
        state.renderer.dpr = 0.5;
      },
    ],
    [
      "resolution",
      (state: StreamingRenderAppliedState) => {
        state.renderer.width = 640;
      },
    ],
    [
      "AA",
      (state: StreamingRenderAppliedState) => {
        state.renderer.samples = 0;
      },
    ],
    [
      "global shadow gate",
      (state: StreamingRenderAppliedState) => {
        state.renderer.shadowsEnabled = false;
      },
    ],
    [
      "unrendered",
      (state: StreamingRenderAppliedState) => {
        state.renderer.hasRendered = false;
      },
    ],
    [
      "CSM",
      (state: StreamingRenderAppliedState) => {
        state.sunlight!.cascaded = true;
      },
    ],
    [
      "unallocated",
      (state: StreamingRenderAppliedState) => {
        state.sunlight!.allocatedMapSize = null;
      },
    ],
    [
      "map size",
      (state: StreamingRenderAppliedState) => {
        state.sunlight!.mapSize = [2048, 2048];
      },
    ],
    [
      "frustum",
      (state: StreamingRenderAppliedState) => {
        state.sunlight!.frustum = [-100, 100, 100, -100, 0.5, 600];
      },
    ],
    [
      "postprocessing",
      (state: StreamingRenderAppliedState) => {
        state.renderer.composerPresent = true;
      },
    ],
    [
      "water",
      (state: StreamingRenderAppliedState) => {
        state.water!.reflectionsEnabled = true;
      },
    ],
    [
      "missing water",
      (state: StreamingRenderAppliedState) => {
        state.water = null;
      },
    ],
    [
      "non-finite bias",
      (state: StreamingRenderAppliedState) => {
        state.sunlight!.bias = NaN;
      },
    ],
  ] as const)("rejects applied mismatch: %s", (_label, change) => {
    const state = observed();
    change(state);
    expect(
      evaluateStreamingRenderProfileApplication(profile, requested, state)
        .ready,
    ).toBe(false);
  });

  it("keeps adaptive pixel budgets but refuses to call a noncanonical viewport a matched capture", () => {
    const adaptive = resolveStreamingRenderPreferences(1920, 1080, profile);
    expect(adaptive.dpr).toBeCloseTo(2 / 3);
    expect(
      evaluateStreamingRenderProfileApplication(profile, adaptive, observed())
        .mismatchReason,
    ).toBe("requested.dpr");
  });
});

describe("client viewport mode", () => {
  it("recognizes the canonical stream page without relying on a global window", () => {
    const win = makeWindow("/stream.html");
    expect(isStreamPageRoute(win)).toBe(true);
    expect(isStreamingLikeViewport(win)).toBe(true);
  });

  it("recognizes only explicit embedded spectator viewports", () => {
    expect(
      isEmbeddedSpectatorViewport(
        makeWindow("/", "?embedded=true&mode=spectator"),
      ),
    ).toBe(true);
    expect(
      isEmbeddedSpectatorViewport(
        makeWindow("/", "?embedded=true&mode=streaming"),
      ),
    ).toBe(false);
  });

  it("omits exploration-only startup work for stream and spectator viewports", () => {
    for (const win of [
      makeWindow("/stream.html"),
      makeWindow("/", "?embedded=true&mode=spectator"),
    ]) {
      expect(resolveClientViewportRuntimeProfile(win)).toEqual({
        streamingLike: true,
        enableLocalPhysics: false,
        enableExplorationScenery: false,
        enableExplorationVegetation: false,
        enableExplorationResourceNodes: false,
        enableExplorationWorldEntities: false,
        enableProceduralExplorationSystems: false,
        prewarmTreeCache: false,
      });
    }

    expect(resolveClientViewportRuntimeProfile(makeWindow("/play"))).toEqual({
      streamingLike: false,
      enableLocalPhysics: true,
      enableExplorationScenery: true,
      enableExplorationVegetation: true,
      enableExplorationResourceNodes: true,
      enableExplorationWorldEntities: true,
      enableProceduralExplorationSystems: true,
      prewarmTreeCache: true,
    });
  });

  it("admits only authoritative players to arena broadcast snapshots", () => {
    for (const win of [
      makeWindow("/stream.html"),
      makeWindow("/", "?embedded=true&mode=spectator"),
    ]) {
      expect(shouldAdmitNetworkEntityInViewport("player", win)).toBe(true);
      expect(shouldAdmitNetworkEntityInViewport("resource", win)).toBe(false);
      expect(shouldAdmitNetworkEntityInViewport("static", win)).toBe(false);
      expect(shouldAdmitNetworkEntityInViewport(undefined, win)).toBe(false);
    }

    const interactive = makeWindow("/play");
    expect(shouldAdmitNetworkEntityInViewport("resource", interactive)).toBe(
      true,
    );
    expect(shouldAdmitNetworkEntityInViewport("npc", interactive)).toBe(true);
  });

  it("admits explicit preparation content without local physics or world planners", () => {
    for (const win of [
      makeWindow("/stream.html", "?streamWorld=preparation-v1"),
      makeWindow("/", "?page=stream&streamWorld=preparation-v1"),
      makeWindow(
        "/",
        "?embedded=true&mode=spectator&streamWorld=preparation-v1",
      ),
    ]) {
      expect(resolveExplicitStreamingWorldProfile(win)).toBe("preparation-v1");
      expect(resolveClientViewportRuntimeProfile(win)).toEqual({
        streamingLike: true,
        enableLocalPhysics: false,
        enableExplorationScenery: true,
        enableExplorationVegetation: true,
        enableExplorationResourceNodes: true,
        enableExplorationWorldEntities: true,
        enableProceduralExplorationSystems: false,
        prewarmTreeCache: false,
      });
      for (const type of ["player", "resource", "npc", "static"]) {
        expect(shouldAdmitNetworkEntityInViewport(type, win)).toBe(true);
      }
      expect(shouldStreamVegetationBackgroundLods(win)).toBe(true);
    }
  });

  it("keeps preparation admission independent of the render profile", () => {
    const win = makeWindow(
      "/stream.html",
      "?streamWorld=preparation-v1&streamRenderProfile=canonical-720p60-v1&streamFps=60",
    );
    expect(resolveStreamingRenderFrameRate(win)).toBe(60);
    expect(resolveExplicitStreamingRenderProfile(win)?.grassProfile).toBe(
      "fixed-arena-v1",
    );
    expect(resolveExplicitStreamingRenderProfile(win)?.shadows).toBe("none");
    expect(
      resolveExplicitStreamingWorldProfile(makeWindow("/stream.html")),
    ).toBe(null);
  });

  it.each([
    "?streamWorld=",
    "?streamWorld=unknown-v1",
    "?streamWorld=Preparation-v1",
    "?streamWorld=%20preparation-v1",
    "?streamWorld=preparation-v1%20",
    "?streamWorld=preparation-v1&streamWorld=preparation-v1",
    "?streamWorld=&streamWorld=preparation-v1",
  ])("fails closed on a malformed preparation selection: %s", (search) => {
    const win = makeWindow("/stream.html", search);
    expect(() => resolveExplicitStreamingWorldProfile(win)).toThrow(
      "exactly one preparation-v1 value",
    );
    expect(() => resolveClientViewportRuntimeProfile(win)).toThrow();
    expect(() => shouldAdmitNetworkEntityInViewport("player", win)).toThrow();
    expect(() => shouldStreamVegetationBackgroundLods(win)).toThrow();
  });

  it("rejects preparation selection on an interactive route", () => {
    const win = makeWindow("/play", "?streamWorld=preparation-v1");
    expect(() => resolveClientViewportRuntimeProfile(win)).toThrow(
      "requires a stream or spectator viewport",
    );
  });

  it("resolves a bounded capture-aligned stream render rate", () => {
    expect(
      resolveStreamingRenderFrameRate(
        makeWindow("/stream.html", "?streamFps=60"),
      ),
    ).toBe(60);
    expect(
      resolveStreamingRenderFrameRate(
        makeWindow("/stream.html", "?streamFps=240"),
      ),
    ).toBe(60);
    expect(
      resolveStreamingRenderFrameRate(
        makeWindow("/stream.html", "?streamFps=invalid"),
      ),
    ).toBe(30);
  });

  it("binds explicit versioned render profiles to their exact frame rate", () => {
    const canonical = makeWindow(
      "/stream.html",
      "?streamRenderProfile=canonical-720p60-v1&streamFps=60",
    );
    const fallback = makeWindow(
      "/stream.html",
      "?streamRenderProfile=fallback-720p30-v1&streamFps=30",
    );

    expect(resolveExplicitStreamingRenderProfile(canonical)).toEqual({
      id: "canonical-720p60-v1",
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
    });
    expect(resolveStreamingRenderFrameRate(canonical)).toBe(60);
    expect(resolveExplicitStreamingRenderProfile(fallback)?.id).toBe(
      "fallback-720p30-v1",
    );
    expect(resolveStreamingRenderFrameRate(fallback)).toBe(30);
  });

  it("fails closed on an unknown or contradictory explicit render profile", () => {
    expect(() =>
      resolveStreamingRenderFrameRate(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=unknown-v1&streamFps=30",
        ),
      ),
    ).toThrow("Unknown streaming render profile");
    expect(() =>
      resolveStreamingRenderFrameRate(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=canonical-720p60-v1&streamFps=30",
        ),
      ),
    ).toThrow("requires streamFps=60");
    expect(() =>
      resolveStreamingRenderFrameRate(
        makeWindow(
          "/stream.html",
          "?streamRenderProfile=fallback-720p30-v1&streamFps=30fps",
        ),
      ),
    ).toThrow("requires an integer streamFps");
  });

  it("keeps deferred vegetation LOD uploads out of broadcast viewports", () => {
    expect(
      shouldStreamVegetationBackgroundLods(makeWindow("/stream.html")),
    ).toBe(false);
    expect(
      shouldStreamVegetationBackgroundLods(
        makeWindow("/", "?embedded=true&mode=spectator"),
      ),
    ).toBe(false);
    expect(shouldStreamVegetationBackgroundLods(makeWindow("/play"))).toBe(
      true,
    );
  });
});
