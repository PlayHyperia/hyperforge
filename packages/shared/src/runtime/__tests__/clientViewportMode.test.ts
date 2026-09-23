import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { DataManager } from "../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../data/world-areas";
import { TerrainSystem } from "../../systems/shared/world/TerrainSystem";
import { createCompactTerrainColorOperations } from "../../systems/shared/world/CompactTerrainPalette";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../../systems/shared/world/WorldTerrainProfile";
import {
  isEmbeddedSpectatorViewport,
  isStreamPageRoute,
  isStreamingLikeViewport,
  resolveClientViewportRuntimeProfile,
  resolveExplicitStreamingRenderProfile,
  resolveExplicitStreamingWorldProfile,
  resolveCompactDirtProjectionCandidate,
  resolveCompactRockProjectionCandidate,
  resolveCompactSurfaceBlendCandidate,
  resolveCompactPondBlendCandidate,
  resolveCompactCoastBlend,
  resolveGrassAppearanceCandidate,
  resolveGrassLightingCandidate,
  resolveGrassGeometryCandidate,
  resolveGrassPaletteCandidate,
  resolveRootedFlowerCandidate,
  resolveTreeWindCandidate,
  resolveGrassCoverageTrial,
  resolveGrassRoadClearance,
  resolveGrassGroundingExecution,
  resolveHabitatCompositionCandidate,
  resolveSkyAtmosphereMode,
  resolveStreamingRenderFrameRate,
  shouldAdmitNetworkEntityInViewport,
  shouldStreamVegetationBackgroundLods,
  STREAMING_RENDER_PROFILES,
  resolveStreamingRenderPreferences,
  evaluateStreamingRenderProfileApplication,
  type StreamingRenderAppliedState,
  type StreamingGrassProfileReceipt,
  type GrassPaletteCandidate,
  type GrassGeometryCandidate,
  type RootedFlowerCandidate,
} from "../clientViewportMode";

function makeWindow(pathname: string, search = ""): Window {
  return { location: { pathname, search } } as unknown as Window;
}

describe("explicit rooted flower selection", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const candidate: RootedFlowerCandidate = "rooted-v1";
  const selected = `flowers=${candidate}`;

  it("never enables flowers from omission, appearance or a profile alone", () => {
    expect(resolveRootedFlowerCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html", "/"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveRootedFlowerCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveRootedFlowerCandidate(makeWindow("/stream.html", `?${fine}`)),
    ).toBeUndefined();
  });

  it("admits only the explicit fine pair without changing existing selectors or budgets", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const baseline = makeWindow(path, `?${prefix}${fine}`);
      const flower = makeWindow(
        path,
        `${baseline.location.search}&${selected}`,
      );
      const search = flower.location.search;
      expect(resolveRootedFlowerCandidate(flower)).toBe(candidate);
      expect(resolveRootedFlowerCandidate(flower)).toBe(candidate);
      expect(flower.location.search).toBe(search);
      expect(resolveGrassAppearanceCandidate(flower)).toBe("fine-meadow-v1");
      expect(resolveExplicitStreamingRenderProfile(flower)).toBe(
        resolveExplicitStreamingRenderProfile(baseline),
      );
      expect(resolveClientViewportRuntimeProfile(flower)).toEqual(
        resolveClientViewportRuntimeProfile(baseline),
      );
      expect(resolveGrassPaletteCandidate(flower)).toBeUndefined();
      expect(resolveGrassLightingCandidate(flower)).toBeUndefined();
      expect(resolveGrassCoverageTrial(flower)).toBeUndefined();
      expect(resolveGrassGroundingExecution(flower)).toBeUndefined();
    }
    const combined = makeWindow(
      "/stream.html",
      `?${fine}&${selected}&grassPalette=regional-v1&grassGrounding=worker-v1`,
    );
    expect(resolveRootedFlowerCandidate(combined)).toBe(candidate);
    expect(resolveGrassPaletteCandidate(combined)).toBe("regional-v1");
    expect(resolveGrassGroundingExecution(combined)).toBe("worker-v1");
  });

  it.each(["", "true", "rooted-v2", "ROOTED-V1", " rooted-v1", "rooted-v1 "])(
    "rejects a noncanonical flower selector case %$",
    (value) => {
      expect(() =>
        resolveRootedFlowerCandidate(
          makeWindow(
            "/stream.html",
            `?${fine}&flowers=${encodeURIComponent(value)}`,
          ),
        ),
      ).toThrow("Unknown or duplicate rooted flower candidate");
    },
  );

  it("rejects missing prerequisites, duplicates, embedded and incompatible routes", () => {
    for (const query of [
      "",
      "grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      `${fine}&embedded=true`,
      `${fine}&embedded=false&embedded=false`,
      `${fine}&streamFps=30`,
      `${fine}&grassAppearance=fine-meadow-v1`,
      `${fine}&streamRenderProfile=island-fine-meadow-720p60-v1`,
      `${fine}&page=stream&page=stream`,
      `${fine}&${selected}`,
      `${fine}&flowers=unknown`,
      ...Object.keys(STREAMING_RENDER_PROFILES)
        .filter((profile) => profile !== "island-fine-meadow-720p60-v1")
        .map(
          (profile) =>
            `streamRenderProfile=${profile}&grassAppearance=fine-meadow-v1`,
        ),
    ])
      expect(() =>
        resolveRootedFlowerCandidate(
          makeWindow("/stream.html", `?${query}&${selected}`),
        ),
      ).toThrow();
    for (const path of ["/play", "/"])
      expect(() =>
        resolveRootedFlowerCandidate(makeWindow(path, `?${fine}&${selected}`)),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveRootedFlowerCandidate(embedded)).toThrow(
      "non-embedded",
    );
  });
});

describe("explicit connected tree wind selection", () => {
  it("keeps all existing routes and profiles unchanged when omitted", () => {
    expect(resolveTreeWindCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html", "/"]) {
      expect(resolveTreeWindCandidate(makeWindow(path))).toBeUndefined();
      expect(
        resolveTreeWindCandidate(makeWindow(path, "?treeWind=connected-v1")),
      ).toBe("connected-v1");
    }
  });

  it("rejects unknown, empty and duplicate selectors", () => {
    for (const search of [
      "?treeWind=",
      "?treeWind=legacy-leaf-v1",
      "?treeWind=true",
      "?treeWind=connected-v1&treeWind=connected-v1",
    ])
      expect(() =>
        resolveTreeWindCandidate(makeWindow("/play", search)),
      ).toThrow("Unknown or duplicate tree wind candidate");
  });

  it("resolves once and supplies the same selection to both actual resource pools", () => {
    const source = readFileSync(
      new URL("../createClientWorld.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/resolveTreeWindCandidate\(\)/gu)).toHaveLength(1);
    for (const init of [
      "initGLBTreeInstancer",
      "initGLBTreeBatchedInstancer",
    ]) {
      expect(source).toMatch(
        new RegExp(
          init +
            "\\(\\s*stageSystem\\.scene[\\s\\S]*?world,\\s*treeWindOptions,\\s*\\)",
        ),
      );
    }
  });
});

describe("explicit regional grass palette selection", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const palette: GrassPaletteCandidate = "regional-v1";
  const selected = `grassPalette=${palette}`;

  it("preserves omission, default routes, and every existing profile", () => {
    expect(resolveGrassPaletteCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html", "/"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveGrassPaletteCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveGrassPaletteCandidate(makeWindow("/stream.html", `?${fine}`)),
    ).toBeUndefined();
  });

  it("admits only the explicit fine pair without changing any other selector or render budget", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const baseline = makeWindow(path, `?${prefix}${fine}`);
      const candidate = makeWindow(
        path,
        `${baseline.location.search}&${selected}`,
      );
      const originalSearch = candidate.location.search;
      expect(resolveGrassPaletteCandidate(candidate)).toBe(palette);
      expect(resolveGrassPaletteCandidate(candidate)).toBe(palette);
      expect(candidate.location.search).toBe(originalSearch);
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
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
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
      expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
      expect(resolveGrassGroundingExecution(candidate)).toBeUndefined();
      expect(resolveGrassLightingCandidate(candidate)).toBeUndefined();
    }
    const both = makeWindow(
      "/stream.html",
      `?${fine}&${selected}&grassLighting=leaf-volume-v1&grassGrounding=worker-v1`,
    );
    expect(resolveGrassPaletteCandidate(both)).toBe(palette);
    expect(resolveGrassLightingCandidate(both)).toBe("leaf-volume-v1");
    expect(resolveGrassGroundingExecution(both)).toBe("worker-v1");
  });

  it.each([
    "",
    "unknown",
    "regional-v2",
    "REGIONAL-V1",
    " regional-v1",
    "regional-v1 ",
    "regional-v1\n",
    "regional-v1,regional-v1",
    "fine-meadow-regional-v1",
  ])("rejects noncanonical palette case %$", (value) => {
    expect(() =>
      resolveGrassPaletteCandidate(
        makeWindow(
          "/stream.html",
          `?${fine}&grassPalette=${encodeURIComponent(value)}`,
        ),
      ),
    ).toThrow("grass palette");
  });

  it("rejects duplicate/ambiguous selectors and incompatible routes instead of falling back", () => {
    const queries = [
      "",
      "grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      `${fine}&embedded=true`,
      `${fine}&embedded=false&embedded=false`,
      `${fine}&streamFps=30`,
      `${fine}&grassAppearance=fine-meadow-v1`,
      `${fine}&streamRenderProfile=island-fine-meadow-720p60-v1`,
      `${fine}&page=stream&page=stream`,
      `${fine}&${selected}`,
      `${fine}&grassPalette=unknown`,
      ...Object.keys(STREAMING_RENDER_PROFILES)
        .filter((profile) => profile !== "island-fine-meadow-720p60-v1")
        .map(
          (profile) =>
            `streamRenderProfile=${profile}&grassAppearance=fine-meadow-v1`,
        ),
      "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1%20&grassAppearance=fine-meadow-v1",
    ];
    for (const query of queries)
      expect(() =>
        resolveGrassPaletteCandidate(
          makeWindow("/stream.html", `?${query}&${selected}`),
        ),
      ).toThrow();
    for (const path of ["/play", "/"])
      expect(() =>
        resolveGrassPaletteCandidate(makeWindow(path, `?${fine}&${selected}`)),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveGrassPaletteCandidate(embedded)).toThrow(
      "non-embedded",
    );
  });
});

describe("explicit grass grounding execution selection", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "grassGrounding=worker-v1";

  it("never enables worker execution from an absent selector or render profile alone", () => {
    expect(resolveGrassGroundingExecution()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveGrassGroundingExecution(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveGrassGroundingExecution(makeWindow("/stream.html", `?${fine}`)),
    ).toBeUndefined();
  });

  it("admits the explicit worker/fine pair without changing render or grass budgets", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const baseline = makeWindow(path, `?${prefix}${fine}`);
      const candidate = makeWindow(
        path,
        `${baseline.location.search}&${selected}`,
      );
      expect(resolveGrassGroundingExecution(candidate)).toBe("worker-v1");
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
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
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
      expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
      expect(resolveGrassLightingCandidate(candidate)).toBeUndefined();
    }
  });

  it.each([
    "",
    "unknown",
    "main-v1",
    "worker-v2",
    "WORKER-V1",
    " worker-v1",
    "worker-v1 ",
    "worker-v1\n",
    "worker-v1,worker-v1",
  ])("rejects noncanonical grounding execution %j", (value) => {
    expect(() =>
      resolveGrassGroundingExecution(
        makeWindow(
          "/stream.html",
          `?${fine}&grassGrounding=${encodeURIComponent(value)}`,
        ),
      ),
    ).toThrow("grass grounding execution");
  });

  it("rejects duplicate selectors, including repeated and conflicting prerequisites", () => {
    for (const extra of [
      selected,
      "grassGrounding=",
      "grassGrounding=unknown",
      "grassAppearance=fine-meadow-v1",
      "grassAppearance=natural-tuft-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=canonical-720p60-v1",
      "page=stream&page=stream",
      "embedded=false&embedded=false",
    ])
      expect(() =>
        resolveGrassGroundingExecution(
          makeWindow("/stream.html", `?${fine}&${selected}&${extra}`),
        ),
      ).toThrow();
  });

  it("requires both exact fine prerequisites and a compatible non-embedded route", () => {
    for (const prerequisites of [
      "",
      "grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      `${fine}&embedded=true`,
      `${fine}&streamFps=30`,
      ...Object.keys(STREAMING_RENDER_PROFILES)
        .filter((profile) => profile !== "island-fine-meadow-720p60-v1")
        .map(
          (profile) =>
            `streamRenderProfile=${profile}&grassAppearance=fine-meadow-v1`,
        ),
    ])
      expect(() =>
        resolveGrassGroundingExecution(
          makeWindow("/stream.html", `?${prerequisites}&${selected}`),
        ),
      ).toThrow();
    expect(() =>
      resolveGrassGroundingExecution(
        makeWindow("/play", `?${fine}&${selected}`),
      ),
    ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveGrassGroundingExecution(embedded)).toThrow();
  });
});

describe("explicit fine canopy-normal lighting selection", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "grassLighting=canopy-normal-v1";

  it("keeps absent/default selection and all render budgets unchanged", () => {
    expect(resolveGrassLightingCandidate()).toBeUndefined();
    for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
      expect(
        resolveGrassLightingCandidate(
          makeWindow("/stream.html", `?streamRenderProfile=${profile}`),
        ),
      ).toBeUndefined();
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
    ]) {
      const baseline = makeWindow(path, `?${prefix}${fine}`);
      const candidate = makeWindow(
        path,
        `${baseline.location.search}&${selected}`,
      );
      expect(resolveGrassLightingCandidate(candidate)).toBe("canopy-normal-v1");
      expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
        resolveExplicitStreamingRenderProfile(baseline),
      );
      expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
        resolveClientViewportRuntimeProfile(baseline),
      );
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
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
    }
  });

  it.each([
    "",
    "unknown",
    "CANOPY-NORMAL-V1",
    " canopy-normal-v1",
    "canopy-normal-v1 ",
    "canopy-normal-v1\n",
  ])("rejects noncanonical lighting %j", (value) => {
    expect(() =>
      resolveGrassLightingCandidate(
        makeWindow(
          "/stream.html",
          `?${fine}&grassLighting=${encodeURIComponent(value)}`,
        ),
      ),
    ).toThrow("grass lighting");
  });

  it("rejects duplicate selectors and every incompatible explicit fine route", () => {
    for (const query of [
      "",
      "grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      `${fine}&embedded=true`,
      `${fine}&embedded=false&embedded=false`,
      `${fine}&streamFps=30`,
      `${fine}&grassAppearance=fine-meadow-v1`,
      `${fine}&streamRenderProfile=island-fine-meadow-720p60-v1`,
      `${fine}&${selected}`,
    ])
      expect(() =>
        resolveGrassLightingCandidate(
          makeWindow("/stream.html", `?${query}&${selected}`),
        ),
      ).toThrow();
    expect(() =>
      resolveGrassLightingCandidate(
        makeWindow("/play", `?${fine}&${selected}`),
      ),
    ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveGrassLightingCandidate(embedded)).toThrow();
  });

  it.each([false, true])(
    "captures actual terrain lighting once (selected=%s)",
    (selectedInitially) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const input = makeWindow(
        "/stream.html",
        `?${fine}${selectedInitially ? `&${selected}` : ""}`,
      );
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: input,
      });
      try {
        terrain["getCompactGrassColorGrade"]();
        const captured = terrain["grassVisualSelection"]!;
        expect(Object.isFrozen(captured)).toBe(true);
        expect(captured.lighting).toBe(
          selectedInitially ? "canopy-normal-v1" : undefined,
        );
        expect(Object.prototype.hasOwnProperty.call(captured, "lighting")).toBe(
          selectedInitially,
        );
        input.location.search = "?grassLighting=invalid";
        terrain["getCompactGrassColorGrade"]();
        expect(terrain["grassVisualSelection"]).toBe(captured);
        const source = readFileSync(
          new URL(
            "../../systems/shared/world/TerrainSystem.ts",
            import.meta.url,
          ),
          "utf8",
        );
        expect(
          source.match(/resolveGrassLightingCandidate\(\)/gu),
        ).toHaveLength(1);
        expect(source).toMatch(
          /grassSelection\.appearance,\s*this\.getCompactHabitatMaterial\(\),\s*grassSelection\.lighting,/u,
        );
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
        else Reflect.deleteProperty(globalThis, "window");
        world.destroy();
      }
    },
  );
});

describe("explicit fine leaf-volume lighting selection", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "grassLighting=leaf-volume-v1";

  it("admits only the explicit fine pair without changing its render budgets", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
    ]) {
      const baseline = makeWindow(path, `?${prefix}${fine}`);
      const candidate = makeWindow(
        path,
        `${baseline.location.search}&${selected}`,
      );
      expect(resolveGrassLightingCandidate(candidate)).toBe("leaf-volume-v1");
      expect(resolveGrassLightingCandidate(baseline)).toBeUndefined();
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
    }
  });

  it.each([
    "LEAF-VOLUME-V1",
    " leaf-volume-v1",
    "leaf-volume-v1 ",
    "leaf-volume-v1\n",
    "leaf-volume-v2",
    "leaf-volume-v1,canopy-normal-v1",
  ])("rejects noncanonical leaf-volume selection %j", (value) => {
    expect(() =>
      resolveGrassLightingCandidate(
        makeWindow(
          "/stream.html",
          `?${fine}&grassLighting=${encodeURIComponent(value)}`,
        ),
      ),
    ).toThrow("grass lighting");
  });

  it("rejects duplicate/mixed lighting modes and incompatible owners", () => {
    for (const query of [
      "",
      "grassAppearance=fine-meadow-v1",
      "streamRenderProfile=island-fine-meadow-720p60-v1",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      `${fine}&embedded=true`,
      `${fine}&embedded=false&embedded=false`,
      `${fine}&streamFps=30`,
      `${fine}&grassAppearance=fine-meadow-v1`,
      `${fine}&streamRenderProfile=island-fine-meadow-720p60-v1`,
      `${fine}&${selected}`,
      `${fine}&grassLighting=canopy-normal-v1`,
    ])
      expect(() =>
        resolveGrassLightingCandidate(
          makeWindow("/stream.html", `?${query}&${selected}`),
        ),
      ).toThrow();
    expect(() =>
      resolveGrassLightingCandidate(
        makeWindow("/play", `?${fine}&${selected}`),
      ),
    ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveGrassLightingCandidate(embedded)).toThrow();
  });

  it("captures leaf-volume once on the actual terrain owner", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const input = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: input,
    });
    try {
      terrain["getCompactGrassColorGrade"]();
      const captured = terrain["grassVisualSelection"]!;
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured.lighting).toBe("leaf-volume-v1");
      input.location.search = `?${fine}&grassLighting=canopy-normal-v1`;
      terrain["getCompactGrassColorGrade"]();
      expect(terrain["grassVisualSelection"]).toBe(captured);
      expect(captured.lighting).toBe("leaf-volume-v1");
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
      world.destroy();
    }
  });
});

describe.each(["sheath-close-v1", "rooted-fan-v1"] as const)(
  "explicit %s geometry selection",
  (geometry: GrassGeometryCandidate) => {
    const fine =
      "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
    const lighting = "grassLighting=leaf-volume-v1";
    const selected = `grassGeometry=${geometry}`;
    const otherGeometry: GrassGeometryCandidate =
      geometry === "sheath-close-v1" ? "rooted-fan-v1" : "sheath-close-v1";

    it("never infers geometry from omission, appearance, lighting or profile", () => {
      expect(resolveGrassGeometryCandidate()).toBeUndefined();
      for (const path of ["/play", "/stream.html", "/"])
        for (const query of [
          "",
          fine,
          `${fine}&${lighting}`,
          "grassLighting=invalid",
        ])
          expect(
            resolveGrassGeometryCandidate(makeWindow(path, `?${query}`)),
          ).toBeUndefined();
    });

    it("admits the exact fine/leaf-volume pair without changing renderer or population selectors", () => {
      for (const [path, prefix] of [
        ["/stream.html", ""],
        ["/", "page=stream&"],
        ["/stream.html", "embedded=false&streamFps=60&"],
      ]) {
        const baseline = makeWindow(path, `?${prefix}${fine}&${lighting}`);
        const candidate = makeWindow(
          path,
          `${baseline.location.search}&${selected}`,
        );
        expect(resolveGrassGeometryCandidate(candidate)).toBe(geometry);
        expect(resolveGrassGeometryCandidate(baseline)).toBeUndefined();
        expect(resolveGrassLightingCandidate(candidate)).toBe("leaf-volume-v1");
        expect(resolveGrassAppearanceCandidate(candidate)).toBe(
          "fine-meadow-v1",
        );
        expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
          resolveExplicitStreamingRenderProfile(baseline),
        );
        expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
          resolveClientViewportRuntimeProfile(baseline),
        );
        expect(resolveGrassCoverageTrial(candidate)).toEqual(
          resolveGrassCoverageTrial(baseline),
        );
        expect(resolveGrassGroundingExecution(candidate)).toEqual(
          resolveGrassGroundingExecution(baseline),
        );
        expect(resolveGrassRoadClearance(candidate)).toEqual(
          resolveGrassRoadClearance(baseline),
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
      }
    });

    it.each([
      "",
      geometry.toUpperCase(),
      ` ${geometry}`,
      `${geometry} `,
      `${geometry}\n`,
      geometry.replace("-v1", "-v2"),
      "folded-sheath-v1",
      `${geometry},other`,
      `${geometry},${otherGeometry}`,
    ])("fails closed on noncanonical geometry %j", (value) => {
      expect(() =>
        resolveGrassGeometryCandidate(
          makeWindow(
            "/stream.html",
            `?${fine}&${lighting}&grassGeometry=${encodeURIComponent(value)}`,
          ),
        ),
      ).toThrow("grass geometry");
    });

    it("rejects duplicates and incompatible lighting, profiles and viewport owners", () => {
      for (const query of [
        "",
        fine,
        lighting,
        `grassAppearance=fine-meadow-v1&${lighting}`,
        `streamRenderProfile=island-fine-meadow-720p60-v1&${lighting}`,
        `${fine}&grassLighting=canopy-normal-v1`,
        `${fine}&${lighting}&${lighting}`,
        `${fine}&${lighting}&${selected}`,
        `${fine}&${lighting}&grassGeometry=${otherGeometry}`,
        `${fine}&${lighting}&grassGeometry=`,
        `${fine}&${lighting}&grassAppearance=fine-meadow-v1`,
        `${fine}&${lighting}&streamRenderProfile=island-fine-meadow-720p60-v1`,
        `${fine}&${lighting}&embedded=true`,
        `${fine}&${lighting}&embedded=false&embedded=false`,
        `${fine}&${lighting}&streamFps=30`,
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1&grassLighting=leaf-volume-v1",
      ])
        expect(() =>
          resolveGrassGeometryCandidate(
            makeWindow("/stream.html", `?${query}&${selected}`),
          ),
        ).toThrow();
      expect(() =>
        resolveGrassGeometryCandidate(
          makeWindow("/play", `?${fine}&${lighting}&${selected}`),
        ),
      ).toThrow();
      const embedded = makeWindow(
        "/stream.html",
        `?${fine}&${lighting}&${selected}`,
      );
      Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
      expect(() => resolveGrassGeometryCandidate(embedded)).toThrow();
    });

    it("rejects either ordering of different valid geometry selectors", () => {
      for (const values of [
        [geometry, otherGeometry],
        [otherGeometry, geometry],
      ])
        expect(() =>
          resolveGrassGeometryCandidate(
            makeWindow(
              "/stream.html",
              `?${fine}&${lighting}&${values
                .map((value) => `grassGeometry=${value}`)
                .join("&")}`,
            ),
          ),
        ).toThrow("Unknown or duplicate grass geometry candidate");
    });

    it.each([false, true])(
      "captures geometry selection once on the real terrain owner, selected=%s",
      (enabled) => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
        const world = new World();
        const terrain = world.register(
          "terrain",
          TerrainSystem,
        ) as TerrainSystem;
        const input = makeWindow(
          "/stream.html",
          `?${fine}&${lighting}${enabled ? `&${selected}` : ""}`,
        );
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: input,
        });
        try {
          terrain["getCompactGrassColorGrade"]();
          const captured = terrain["grassVisualSelection"]!;
          expect(Object.isFrozen(captured)).toBe(true);
          expect(captured.geometry).toBe(enabled ? geometry : undefined);
          expect(
            Object.prototype.hasOwnProperty.call(captured, "geometry"),
          ).toBe(enabled);
          input.location.search = `?${fine}&${lighting}${enabled ? "" : `&${selected}`}`;
          terrain["getCompactGrassColorGrade"]();
          expect(terrain["grassVisualSelection"]).toBe(captured);
          expect(captured.geometry).toBe(enabled ? geometry : undefined);
          input.location.search = `?${fine}&${lighting}&grassGeometry=${otherGeometry}`;
          terrain["getCompactGrassColorGrade"]();
          expect(terrain["grassVisualSelection"]).toBe(captured);
          expect(captured.geometry).toBe(enabled ? geometry : undefined);
        } finally {
          if (previous) Object.defineProperty(globalThis, "window", previous);
          else Reflect.deleteProperty(globalThis, "window");
          world.destroy();
        }
      },
    );
  },
);

describe("client resource-pool startup ordering", () => {
  it("binds the registered scene before asynchronous resource registration", () => {
    // Structural guard only; actual warm-reload tree ownership is verified in
    // the WebGPU client. Timers here can silently drop the first resource batch.
    const source = readFileSync(
      new URL("../createClientWorld.ts", import.meta.url),
      "utf8",
    );
    const stageRegistration = source.indexOf(
      'replaceSystem(world, "stage", Stage)',
    );
    const setupDefinition = source.indexOf("const setupStageWithTHREE =");
    const setupCall = source.indexOf("\n  setupStageWithTHREE();");
    const resourceRegistration = source.indexOf("await registerSystems(world");
    expect(stageRegistration).toBeGreaterThan(-1);
    expect(setupDefinition).toBeGreaterThan(stageRegistration);
    expect(setupCall).toBeGreaterThan(setupDefinition);
    expect(resourceRegistration).toBeGreaterThan(setupCall);
    expect(source).not.toMatch(/setTimeout\(\s*setupStageWithTHREE/);
    for (const owner of [
      "initGLBTreeInstancer",
      "initGLBTreeBatchedInstancer",
      "initPlaceholderInstancer",
      "initGLBResourceInstancer",
    ])
      expect(source.slice(setupDefinition, setupCall)).toContain(`${owner}(`);
  });
});

describe("explicit height surface-blend preview URL policy", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "terrainBlend=height-v1";

  it("leaves absent selection undefined across existing routes and profiles", () => {
    expect(resolveCompactSurfaceBlendCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveCompactSurfaceBlendCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveCompactSurfaceBlendCandidate(
        makeWindow("/stream.html", "?" + fine),
      ),
    ).toBeUndefined();
  });

  it("admits only the explicit fine pair without changing rendering or grass selection", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const original = makeWindow(
        path,
        `?${prefix}${fine}&habitatComposition=haven-understory-v1&grassRoadClearance=per-blade-v1`,
      );
      const candidate = makeWindow(
        path,
        `${original.location.search}&${selected}`,
      );
      expect(resolveCompactSurfaceBlendCandidate(candidate)).toBe("height-v1");
      expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
        resolveExplicitStreamingRenderProfile(original),
      );
      expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
        resolveClientViewportRuntimeProfile(original),
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
          resolveExplicitStreamingRenderProfile(original),
        ),
      );
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
      expect(resolveHabitatCompositionCandidate(candidate)).toBe(
        "haven-understory-v1",
      );
      expect(resolveGrassRoadClearance(candidate)).toBe("per-blade-v1");
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
    }
  });

  it("keeps terrain blending and dirt projection independently selectable", () => {
    for (const blend of [false, true])
      for (const projection of [false, true]) {
        const query = [
          fine,
          ...(blend ? [selected] : []),
          ...(projection ? ["dirtProjection=stochastic-v1"] : []),
        ].join("&");
        const win = makeWindow("/stream.html", "?" + query);
        expect(resolveCompactSurfaceBlendCandidate(win)).toBe(
          blend ? "height-v1" : undefined,
        );
        expect(resolveCompactDirtProjectionCandidate(win)).toBe(
          projection ? "stochastic-v1" : undefined,
        );
      }
  });

  it("rejects empty, unknown, coerced and duplicate blend selectors", () => {
    for (const value of [
      "",
      "unknown",
      "linear-v1",
      "HEIGHT-V1",
      "%20height-v1",
      "height-v1%20",
      "height-v1%0A",
      "height-v1&terrainBlend=height-v1",
      "height-v1&terrainBlend=",
    ])
      expect(() =>
        resolveCompactSurfaceBlendCandidate(
          makeWindow("/stream.html", `?${fine}&terrainBlend=${value}`),
        ),
      ).toThrow("terrain blend candidate");
  });

  it("rejects missing, nonexact, embedded and ambiguous fine selections", () => {
    for (const [path, query] of [
      ["/play", fine],
      ["/stream.html", ""],
      ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
      ["/stream.html", "grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=island-fine-meadow-720p60-v1%20&grassAppearance=fine-meadow-v1",
      ],
      ["/stream.html", fine + "&embedded=true"],
      ["/stream.html", fine + "&embedded=false&embedded=false"],
      ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
      ],
      ["/stream.html", fine + "&streamFps=30"],
      ["/stream.html", fine + "&streamFps=60&streamFps=60"],
      ["/", "page=stream&page=stream&" + fine],
    ])
      expect(() =>
        resolveCompactSurfaceBlendCandidate(
          makeWindow(path, `?${query}&${selected}`),
        ),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveCompactSurfaceBlendCandidate(embedded)).toThrow(
      "non-embedded",
    );
  });

  it("captures absence or selection once and admits sculpt terrain before material construction", () => {
    const source = readFileSync(
      new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    expect(
      source.match(/resolveCompactSurfaceBlendCandidate\(\)/gu),
    ).toHaveLength(1);
    const capture = source.slice(
      source.indexOf("  private getCompactSurfaceBlend()"),
      source.indexOf("  private getCompactGrassColorGrade()"),
    );
    expect(capture).toContain("if (this.compactSurfaceBlend === undefined)");
    expect(capture).toContain(
      "selection && !isCompactSculptProfile(this.getWorldTerrainProfile())",
    );
    expect(capture).toContain("this.compactSurfaceBlend = selection ?? null;");
    expect(capture).toContain("return this.compactSurfaceBlend ?? undefined;");
    expect(source).toContain(
      "compactSurfaceBlend: this.getCompactSurfaceBlend(),",
    );
    const initialize = source.slice(
      source.indexOf("  private async initialize():"),
      source.indexOf("  async start():"),
    );
    const captureIndex = initialize.indexOf("this.getCompactSurfaceBlend();");
    expect(captureIndex).toBeGreaterThan(0);
    expect(captureIndex).toBeLessThan(
      initialize.indexOf("this.initTerrainMaterial();"),
    );
    expect(capture).not.toContain("compactDirtProjection");
  });
});

describe("explicit pond relief preview URL policy", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const height = "terrainBlend=height-v1";
  const candidates = [
    "relief-v1",
    "relief-contact-v1",
    "shore-contact-v1",
  ] as const;
  const urlCandidates = [...candidates, "composition-v1"] as const;

  it("keeps absent pond selection undefined for every existing route/profile", () => {
    expect(resolveCompactPondBlendCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveCompactPondBlendCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveCompactPondBlendCandidate(
        makeWindow("/stream.html", `?${fine}&${height}`),
      ),
    ).toBeUndefined();
  });

  it.each(urlCandidates)(
    "admits %s only with the fine/height pair without changing profiles or budgets",
    (selection) => {
      const selected = `pondBlend=${selection}`;
      for (const [path, prefix] of [
        ["/stream.html", ""],
        ["/", "page=stream&"],
      ])
        for (const dirt of ["", "&dirtProjection=stochastic-v1"])
          for (const rock of ["", "&rockProjection=stochastic-v1"]) {
            const baseline = makeWindow(
              path,
              `?${prefix}${fine}&${height}${dirt}${rock}`,
            );
            const candidate = makeWindow(
              path,
              `${baseline.location.search}&${selected}`,
            );
            expect(resolveCompactPondBlendCandidate(candidate)).toBe(selection);
            expect(resolveCompactSurfaceBlendCandidate(candidate)).toBe(
              "height-v1",
            );
            expect(resolveCompactDirtProjectionCandidate(candidate)).toBe(
              resolveCompactDirtProjectionCandidate(baseline),
            );
            expect(resolveCompactRockProjectionCandidate(candidate)).toBe(
              resolveCompactRockProjectionCandidate(baseline),
            );
            expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
              resolveExplicitStreamingRenderProfile(baseline),
            );
            expect(resolveExplicitStreamingWorldProfile(candidate)).toBe(
              resolveExplicitStreamingWorldProfile(baseline),
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
            expect(resolveGrassAppearanceCandidate(candidate)).toBe(
              "fine-meadow-v1",
            );
            expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
            expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
          }
    },
  );

  it.each([
    "",
    "unknown",
    "RELIEF-V1",
    "%20relief-v1",
    "relief-v1%20",
    "relief-v1%0A",
    "relief-v1&pondBlend=relief-v1",
    "relief-v1&pondBlend=",
    "RELIEF-CONTACT-V1",
    "%20relief-contact-v1",
    "relief-contact-v1%20",
    "relief-contact-v1%0A",
    "relief-contact-v1&pondBlend=relief-contact-v1",
    "relief-contact-v1&pondBlend=",
    "relief-v1&pondBlend=relief-contact-v1",
    "relief-contact-v1&pondBlend=relief-v1",
    "&pondBlend=relief-contact-v1",
    "relief-contact-wet-v1",
    "SHORE-CONTACT-V1",
    "%20shore-contact-v1",
    "shore-contact-v1%20",
    "shore-contact-v1%0A",
    "shore-contact-v1&pondBlend=shore-contact-v1",
    "shore-contact-v1&pondBlend=",
    "shore-contact-v1&pondBlend=relief-v1",
    "relief-contact-v1&pondBlend=shore-contact-v1",
    "COMPOSITION-V1",
    "%20composition-v1",
    "composition-v1%20",
    "composition-v1%0A",
    "composition-v1&pondBlend=composition-v1",
    "composition-v1&pondBlend=",
    "composition-v1&pondBlend=shore-contact-v1",
    "relief-contact-v1&pondBlend=composition-v1",
  ])("rejects invalid or duplicate pond selector %s", (value) => {
    expect(() =>
      resolveCompactPondBlendCandidate(
        makeWindow("/stream.html", `?${fine}&${height}&pondBlend=${value}`),
      ),
    ).toThrow("pond blend candidate");
  });

  it.each([
    "",
    "terrainBlend=",
    "terrainBlend=linear-v1",
    "terrainBlend=HEIGHT-V1",
    "terrainBlend=%20height-v1",
    "terrainBlend=height-v1%20",
    "terrainBlend=height-v1&terrainBlend=height-v1",
    "terrainBlend=height-v1&terrainBlend=",
  ])(
    "rejects absent, invalid or ambiguous height dependency %s",
    (dependency) => {
      for (const selection of urlCandidates)
        expect(() =>
          resolveCompactPondBlendCandidate(
            makeWindow(
              "/stream.html",
              `?${fine}&${dependency}&pondBlend=${selection}`,
            ),
          ),
        ).toThrow();
    },
  );

  it.each(urlCandidates)(
    "rejects invalid fine pairs and embedded or ambiguous routes for %s",
    (selection) => {
      const selected = `pondBlend=${selection}`;
      for (const [path, query] of [
        ["/play", fine],
        ["/stream.html", ""],
        ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
        ["/stream.html", "grassAppearance=fine-meadow-v1"],
        [
          "/stream.html",
          "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
        ],
        [
          "/stream.html",
          "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
        ],
        ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
        [
          "/stream.html",
          fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
        ],
        ["/stream.html", fine + "&embedded=true"],
        ["/stream.html", fine + "&embedded=false&embedded=false"],
        ["/stream.html", fine + "&streamFps=30"],
        ["/stream.html", fine + "&streamFps=60&streamFps=60"],
        ["/", "page=stream&page=stream&" + fine],
      ])
        expect(() =>
          resolveCompactPondBlendCandidate(
            makeWindow(path, `?${query}&${height}&${selected}`),
          ),
        ).toThrow();
      const embedded = makeWindow(
        "/stream.html",
        `?${fine}&${height}&${selected}`,
      );
      Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
      expect(() => resolveCompactPondBlendCandidate(embedded)).toThrow(
        "non-embedded",
      );
    },
  );

  function withTerrainUrl(
    search: string,
    check: (terrain: TerrainSystem, input: Window) => void,
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const input = makeWindow("/stream.html", search);
    const identity = DataManager.getWorldContentIdentity();
    // URL data is the only input fixture; the TerrainSystem and admitted pond
    // are real owners. This is not browser/rendering qualification.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: input,
    });
    try {
      check(terrain, input);
      expect(DataManager.getWorldContentIdentity()).toBe(identity);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
      world.destroy();
    }
  }

  it.each(candidates)(
    "captures %s and absent pond choices once on actual terrain owners",
    (selection) => {
      const selected = `pondBlend=${selection}`;
      withTerrainUrl(`?${fine}&${height}&${selected}`, (terrain, input) => {
        const profile = terrain.getWorldTerrainProfile();
        expect(terrain["getCompactPondBlend"]()).toBe(selection);
        expect(terrain["getCompactSurfaceBlend"]()).toBe("height-v1");
        expect(terrain["getCompactPondMaterial"]()).toEqual(
          ALL_WORLD_AREAS.haven_pond.waterBodies![0],
        );
        input.location.search = "?pondBlend=invalid";
        expect(terrain["getCompactPondBlend"]()).toBe(selection);
        const otherSelection =
          selection === "relief-v1" ? "relief-contact-v1" : "relief-v1";
        input.location.search = `?${fine}&${height}&pondBlend=${otherSelection}`;
        expect(terrain["getCompactPondBlend"]()).toBe(selection);
        expect(terrain.getWorldTerrainProfile()).toBe(profile);
      });
      withTerrainUrl(`?${fine}&${height}`, (terrain, input) => {
        expect(terrain["getCompactPondBlend"]()).toBeUndefined();
        expect(terrain["compactPondBlend"]).toBeNull();
        input.location.search += `&${selected}`;
        expect(terrain["getCompactPondBlend"]()).toBeUndefined();
      });
    },
  );

  it.each(candidates)(
    "rejects incompatible terrain and a captured absent height choice for %s",
    (selection) => {
      const selected = `pondBlend=${selection}`;
      withTerrainUrl(`?${fine}&${height}&${selected}`, (terrain) => {
        terrain["activeTerrainProfile"] = COMPACT_WORLD_TERRAIN_PROFILE;
        expect(() => terrain["getCompactPondBlend"]()).toThrow(
          "compact sculpt terrain",
        );
        expect(terrain["compactPondBlend"]).toBeUndefined();
      });
      withTerrainUrl(`?${fine}`, (terrain, input) => {
        expect(terrain["getCompactSurfaceBlend"]()).toBeUndefined();
        input.location.search += `&${height}&${selected}`;
        expect(() => terrain["getCompactPondBlend"]()).toThrow(
          "captured height-v1",
        );
        expect(terrain["compactPondBlend"]).toBeUndefined();
      });
    },
  );

  it.each(candidates)(
    "requires the actual single admitted pond before accepting %s",
    (selection) => {
      const selected = `pondBlend=${selection}`;
      const area = ALL_WORLD_AREAS.haven_pond;
      const original = area.waterBodies;
      try {
        area.waterBodies = [];
        withTerrainUrl(`?${fine}&${height}&${selected}`, (terrain) => {
          expect(() => terrain["getCompactPondBlend"]()).toThrow(
            "single admitted Haven pond",
          );
          expect(terrain["compactPondBlend"]).toBeUndefined();
        });
      } finally {
        area.waterBodies = original;
      }
    },
  );

  it("wires the captured pond selection before material construction", () => {
    const source = readFileSync(
      new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/resolveCompactPondBlendCandidate\(\)/gu)).toHaveLength(
      1,
    );
    const capture = source.slice(
      source.indexOf("  private getCompactPondBlend()"),
      source.indexOf("  private getCompactGrassColorGrade()"),
    );
    expect(capture).toContain("this.compactPondBlend = selection ?? null;");
    expect(capture).toContain("return this.compactPondBlend ?? undefined;");
    expect(capture).toContain("this.getCompactPondMaterial()");
    expect(source).toContain("compactPondBlend: this.getCompactPondBlend(),");
    const initialize = source.slice(
      source.indexOf("  private async initialize():"),
      source.indexOf("  async start():"),
    );
    expect(initialize.indexOf("this.getCompactPondBlend();")).toBeGreaterThan(
      initialize.indexOf("this.getCompactSurfaceBlend();"),
    );
    expect(initialize.indexOf("this.getCompactPondBlend();")).toBeLessThan(
      initialize.indexOf("this.initTerrainMaterial();"),
    );
  });
});

describe("pond distribution selection ownership", () => {
  it.each([
    undefined,
    "relief-v1",
    "relief-contact-v1",
    "shore-contact-v1",
  ] as const)(
    "forwards only the support-changing pond mode to real setup (%s)",
    async (mode) => {
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      terrain["activeTerrainProfile"] = validateWorldTerrainProfile({
        ...terrain.getWorldTerrainProfile(),
        southernMeadow: {
          schemaVersion: 1,
          minX: 304,
          maxX: 500,
          minZ: 345,
          maxZ: 535,
          featherX: 24,
          featherZ: 24,
          northHeight: 26.8,
          southHeight: 25.3,
          crossFall: 1,
          rollAmplitude: 0.65,
          rollWavelength: 100,
        },
      });
      terrain["compactPondBlend"] = mode ?? null;
      terrain["compactSurfaceBlend"] = "height-v1";
      try {
        await terrain.init();
        const setup = terrain["buildGrassWorkerSetup"]();
        const field = terrain["getCompactMacroMaterial"]();
        if (mode === "shore-contact-v1") {
          expect(setup.compactPondBlend).toBe(mode);
          expect(field?.pondDistribution).toEqual({
            id: mode,
            soilFullHeight: 0.055,
            soilEndHeight: 0.165,
          });
          expect(Object.isFrozen(field?.pondDistribution)).toBe(true);
        } else {
          expect(setup).not.toHaveProperty("compactPondBlend");
          expect(field).not.toHaveProperty("pondDistribution");
        }
        expect(setup).not.toHaveProperty("compactCoastBlend");
        expect(setup.terrainConfig.TERRAIN_PROFILE).toEqual(
          terrain.getWorldTerrainProfile(),
        );
      } finally {
        world.destroy();
      }
    },
  );
});

describe.each(["detail-v1", "distribution-v1", "cavity-v1"] as const)(
  "explicit coastal %s preview URL policy",
  (coastMode) => {
    const fine =
      "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
    const height = "terrainBlend=height-v1";
    const selected = `coastBlend=${coastMode}`;

    it("keeps absent coastal selection undefined for existing routes and profiles", () => {
      expect(resolveCompactCoastBlend()).toBeUndefined();
      for (const path of ["/play", "/stream.html"])
        for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
          expect(
            resolveCompactCoastBlend(
              makeWindow(path, `?streamRenderProfile=${profile}`),
            ),
          ).toBeUndefined();
      expect(
        resolveCompactCoastBlend(
          makeWindow("/stream.html", `?${fine}&${height}`),
        ),
      ).toBeUndefined();
    });

    it("admits only the explicit fine/height pair independently of projections and pond treatment", () => {
      for (const [path, prefix] of [
        ["/stream.html", ""],
        ["/", "page=stream&"],
      ])
        for (const dirt of ["", "&dirtProjection=stochastic-v1"])
          for (const rock of ["", "&rockProjection=stochastic-v1"])
            for (const pond of [
              "",
              "&pondBlend=relief-v1",
              "&pondBlend=relief-contact-v1",
            ]) {
              const baseline = makeWindow(
                path,
                `?${prefix}${fine}&${height}${dirt}${rock}${pond}`,
              );
              const candidate = makeWindow(
                path,
                `${baseline.location.search}&${selected}`,
              );
              expect(resolveCompactCoastBlend(candidate)).toBe(coastMode);
              expect(resolveCompactSurfaceBlendCandidate(candidate)).toBe(
                "height-v1",
              );
              expect(resolveCompactDirtProjectionCandidate(candidate)).toBe(
                resolveCompactDirtProjectionCandidate(baseline),
              );
              expect(resolveCompactRockProjectionCandidate(candidate)).toBe(
                resolveCompactRockProjectionCandidate(baseline),
              );
              expect(resolveCompactPondBlendCandidate(candidate)).toBe(
                resolveCompactPondBlendCandidate(baseline),
              );
              expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
                resolveExplicitStreamingRenderProfile(baseline),
              );
              expect(resolveExplicitStreamingWorldProfile(candidate)).toBe(
                resolveExplicitStreamingWorldProfile(baseline),
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
              expect(resolveGrassAppearanceCandidate(candidate)).toBe(
                "fine-meadow-v1",
              );
              expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
              expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
            }
    });

    it.each([
      "",
      "unknown",
      "DETAIL-V1",
      "%20detail-v1",
      "detail-v1%20",
      "detail-v1%0A",
      "detail-v1&coastBlend=detail-v1",
      "detail-v1&coastBlend=",
      "&coastBlend=detail-v1",
      "detail-v1&coastBlend=unknown",
      "unknown&coastBlend=detail-v1",
      "distribution-v1&coastBlend=detail-v1",
      "detail-v1&coastBlend=distribution-v1",
      "distribution-v1&coastBlend=distribution-v1",
      "distribution-v1&coastBlend=",
      "DISTRIBUTION-V1",
      "%20distribution-v1",
      "distribution-v1%20",
      "distribution-v1%0A",
      "CAVITY-V1",
      "%20cavity-v1",
      "cavity-v1%20",
      "cavity-v1%0A",
      "cavity-v1&coastBlend=cavity-v1",
      "cavity-v1&coastBlend=",
      "&coastBlend=cavity-v1",
      "cavity-v1&coastBlend=unknown",
      "unknown&coastBlend=cavity-v1",
      "cavity-v1&coastBlend=detail-v1",
      "detail-v1&coastBlend=cavity-v1",
      "cavity-v1&coastBlend=distribution-v1",
      "distribution-v1&coastBlend=cavity-v1",
      "relief-v1",
      "relief-contact-v1",
    ])("rejects malformed or duplicate coastal selection %s", (value) => {
      expect(() =>
        resolveCompactCoastBlend(
          makeWindow("/stream.html", `?${fine}&${height}&coastBlend=${value}`),
        ),
      ).toThrow("coast blend candidate");
    });

    it.each([
      "",
      "terrainBlend=",
      "terrainBlend=linear-v1",
      "terrainBlend=HEIGHT-V1",
      "terrainBlend=%20height-v1",
      "terrainBlend=height-v1%20",
      "terrainBlend=height-v1&terrainBlend=height-v1",
      "terrainBlend=height-v1&terrainBlend=",
    ])(
      "rejects absent, invalid or ambiguous height dependency %s",
      (dependency) => {
        expect(() =>
          resolveCompactCoastBlend(
            makeWindow("/stream.html", `?${fine}&${dependency}&${selected}`),
          ),
        ).toThrow();
      },
    );

    it("rejects incompatible fine pairs and embedded or ambiguous routes", () => {
      for (const [path, query] of [
        ["/play", fine],
        ["/stream.html", ""],
        ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
        ["/stream.html", "grassAppearance=fine-meadow-v1"],
        [
          "/stream.html",
          "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
        ],
        [
          "/stream.html",
          "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
        ],
        ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
        [
          "/stream.html",
          fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
        ],
        ["/stream.html", fine + "&embedded=true"],
        ["/stream.html", fine + "&embedded=false&embedded=false"],
        ["/stream.html", fine + "&streamFps=30"],
        ["/stream.html", fine + "&streamFps=60&streamFps=60"],
        ["/", "page=stream&page=stream&" + fine],
      ])
        expect(() =>
          resolveCompactCoastBlend(
            makeWindow(path, `?${query}&${height}&${selected}`),
          ),
        ).toThrow();
      const embedded = makeWindow(
        "/stream.html",
        `?${fine}&${height}&${selected}`,
      );
      Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
      expect(() => resolveCompactCoastBlend(embedded)).toThrow("non-embedded");
    });

    function withTerrainUrl(
      search: string,
      check: (terrain: TerrainSystem, input: Window) => void,
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const input = makeWindow("/stream.html", search);
      const identity = DataManager.getWorldContentIdentity();
      // Only URL/admission data varies; exercise the real terrain/material owners.
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: input,
      });
      try {
        check(terrain, input);
        expect(DataManager.getWorldContentIdentity()).toBe(identity);
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
        else Reflect.deleteProperty(globalThis, "window");
        world.destroy();
      }
    }

    it.each([false, true])(
      "captures coastal absence/selection once and forwards it to the real material (selected=%s)",
      (selectedInitially) => {
        withTerrainUrl(
          `?${fine}&${height}${selectedInitially ? `&${selected}` : ""}`,
          (terrain, input) => {
            // The default manifest intentionally does not promote this preview.
            // Admit the same authored meadow data used by the coastal material
            // fixture, without altering DataManager or the production defaults.
            const profile = validateWorldTerrainProfile({
              ...terrain.getWorldTerrainProfile(),
              southernMeadow: {
                schemaVersion: 1,
                minX: 304,
                maxX: 500,
                minZ: 345,
                maxZ: 535,
                featherX: 24,
                featherZ: 24,
                northHeight: 26.8,
                southHeight: 25.3,
                crossFall: 1,
                rollAmplitude: 0.65,
                rollWavelength: 100,
              },
            });
            terrain["activeTerrainProfile"] = profile;
            const choice = selectedInitially ? coastMode : undefined;
            // Enter through the dependent field first: owner capture must not
            // recurse between macro-field construction and coastal admission.
            const initialMacroField = terrain["getCompactMacroMaterial"]();
            if (coastMode === "cavity-v1") {
              const operations = createCompactTerrainColorOperations();
              expect(operations.coastBlend(choice)).toBe(choice);
              expect(initialMacroField).toEqual(operations.macroField(profile));
              expect(initialMacroField).not.toHaveProperty(
                "coastalDistribution",
              );
            }
            expect(initialMacroField?.coastalDistribution?.id).toBe(
              choice === "distribution-v1" ? "distribution-v1" : undefined,
            );
            expect(terrain["getCompactCoastBlend"]()).toBe(choice);
            expect(terrain["compactCoastBlend"]).toBe(
              selectedInitially ? coastMode : null,
            );
            expect(terrain["getCompactSurfaceBlend"]()).toBe("height-v1");
            expect(
              terrain["getCompactMacroMaterial"]()?.coastalMeadow,
            ).toBeDefined();
            const macroField = terrain["getCompactMacroMaterial"]();
            input.location.search = `?${fine}&${height}&coastBlend=${selectedInitially ? "invalid" : coastMode}`;
            expect(terrain["getCompactCoastBlend"]()).toBe(choice);
            expect(terrain["getCompactMacroMaterial"]()).toBe(macroField);
            terrain["initTerrainMaterial"]();
            const material = terrain.getTerrainMaterialWithUniforms();
            expect(material).not.toBeNull();
            expect(material?.compactCoastBlend).toBe(choice);
            expect(
              Object.prototype.hasOwnProperty.call(
                material,
                "compactCoastBlend",
              ),
            ).toBe(selectedInitially);
            expect(terrain.getWorldTerrainProfile()).toBe(profile);
            material?.dispose();
          },
        );
      },
    );

    it("rejects incompatible terrain and a height choice absent at owner capture", () => {
      withTerrainUrl(`?${fine}&${height}&${selected}`, (terrain) => {
        terrain["activeTerrainProfile"] = COMPACT_WORLD_TERRAIN_PROFILE;
        expect(() => terrain["getCompactCoastBlend"]()).toThrow(
          "compact sculpt terrain",
        );
        expect(terrain["compactCoastBlend"]).toBeUndefined();
      });
      withTerrainUrl(`?${fine}`, (terrain, input) => {
        expect(terrain["getCompactSurfaceBlend"]()).toBeUndefined();
        input.location.search += `&${height}&${selected}`;
        expect(() => terrain["getCompactCoastBlend"]()).toThrow(
          "captured height-v1",
        );
        expect(terrain["compactCoastBlend"]).toBeUndefined();
      });
    });

    it("requires the real admitted coastal macro domain before capturing selection", () => {
      withTerrainUrl(`?${fine}&${height}&${selected}`, (terrain) => {
        const { southernMeadow: _excluded, ...withoutMeadow } =
          terrain.getWorldTerrainProfile();
        terrain["activeTerrainProfile"] =
          validateWorldTerrainProfile(withoutMeadow);
        expect(() => terrain["getCompactCoastBlend"]()).toThrow(
          "admitted coastal meadow",
        );
        expect(terrain["compactCoastBlend"]).toBeUndefined();
      });
    });

    it("captures and forwards the coastal choice before material construction", () => {
      const source = readFileSync(
        new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
        "utf8",
      );
      expect(source.match(/resolveCompactCoastBlend\(\)/gu)).toHaveLength(1);
      const capture = source.slice(
        source.indexOf("  private getCompactCoastBlend()"),
        source.indexOf("  private getCompactGrassColorGrade()"),
      );
      expect(capture).toContain("this.compactCoastBlend = selection ?? null;");
      expect(capture).toContain("return this.compactCoastBlend ?? undefined;");
      expect(capture).toContain("compactTerrainColorOperations.macroField(");
      expect(capture).not.toContain("this.getCompactMacroMaterial()");
      expect(source).toContain(
        "compactCoastBlend: this.getCompactCoastBlend(),",
      );
      expect(source).toContain(
        'this.getCompactCoastBlend() === "distribution-v1"',
      );
      expect(source).toContain(
        '{ compactCoastBlend: "distribution-v1" as const }',
      );
      const initialize = source.slice(
        source.indexOf("  private async initialize():"),
        source.indexOf("  async start():"),
      );
      expect(
        initialize.indexOf("this.getCompactCoastBlend();"),
      ).toBeGreaterThan(initialize.indexOf("this.getCompactSurfaceBlend();"));
      expect(initialize.indexOf("this.getCompactCoastBlend();")).toBeLessThan(
        initialize.indexOf("this.initTerrainMaterial();"),
      );
    });
  },
);

describe("cavity-only coastal selection ownership", () => {
  it("validates the literal without changing any existing macro-field defaults", () => {
    const operations = createCompactTerrainColorOperations();
    for (const value of [
      undefined,
      "detail-v1",
      "distribution-v1",
      "cavity-v1",
    ] as const)
      expect(operations.coastBlend(value)).toBe(value);
    for (const value of [
      null,
      "",
      "CAVITY-V1",
      " cavity-v1",
      "cavity-v1 ",
      "cavity-v1\n",
      {},
      1,
    ])
      expect(() => operations.coastBlend(value)).toThrow(
        "Invalid compact coast blend",
      );
    const profile = DataManager.getWorldTerrainProfile();
    expect(operations.macroField(profile, "cavity-v1")).toEqual(
      operations.macroField(profile),
    );
    expect(
      operations.macroField(COMPACT_WORLD_TERRAIN_PROFILE, "cavity-v1"),
    ).toBeNull();
  });

  it("does not forward an appearance-only cavity selection to the actual grass worker setup", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    // The real URL/capture/material path is exercised above. Select this
    // appearance mode before initializing the independent CPU terrain owner.
    terrain["compactCoastBlend"] = "cavity-v1";
    terrain["compactSurfaceBlend"] = "height-v1";
    try {
      await terrain.init();
      const setup = terrain["buildGrassWorkerSetup"]();
      expect(setup).not.toHaveProperty("compactCoastBlend");
      expect(terrain["getCompactCoastBlend"]()).toBe("cavity-v1");
      expect(terrain["getCompactMacroMaterial"]()).not.toHaveProperty(
        "coastalDistribution",
      );
      expect(setup.terrainConfig.TERRAIN_PROFILE).toEqual(
        terrain.getWorldTerrainProfile(),
      );
    } finally {
      world.destroy();
    }
  });
});

describe("explicit stochastic dirt preview URL policy", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "dirtProjection=stochastic-v1";

  it("leaves absent selection undefined for every existing route and profile", () => {
    expect(resolveCompactDirtProjectionCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveCompactDirtProjectionCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveCompactDirtProjectionCandidate(
        makeWindow("/stream.html", "?" + fine),
      ),
    ).toBeUndefined();
  });

  it("admits the exact non-embedded fine pair without changing existing rendering or grass selections", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const original = makeWindow(
        path,
        `?${prefix}${fine}&habitatComposition=haven-understory-v1`,
      );
      const candidate = makeWindow(
        path,
        `${original.location.search}&${selected}`,
      );
      expect(resolveCompactDirtProjectionCandidate(candidate)).toBe(
        "stochastic-v1",
      );
      expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
        resolveExplicitStreamingRenderProfile(original),
      );
      expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
        resolveClientViewportRuntimeProfile(original),
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
          resolveExplicitStreamingRenderProfile(original),
        ),
      );
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
      expect(resolveHabitatCompositionCandidate(candidate)).toBe(
        "haven-understory-v1",
      );
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
      expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
    }
  });

  it("rejects empty, coerced, duplicate and unsupported projection selectors", () => {
    for (const value of [
      "",
      "unknown",
      "STOCHASTIC-V1",
      "%20stochastic-v1",
      "stochastic-v1%20",
      "stochastic-v1%0A",
      "stochastic-v1&dirtProjection=stochastic-v1",
      "stochastic-v1&dirtProjection=",
    ])
      expect(() =>
        resolveCompactDirtProjectionCandidate(
          makeWindow("/stream.html", `?${fine}&dirtProjection=${value}`),
        ),
      ).toThrow("dirt projection candidate");
  });

  it("rejects missing, nonexact, embedded, mismatched and ambiguous fine selections", () => {
    for (const [path, query] of [
      ["/play", fine],
      ["/stream.html", ""],
      ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
      ["/stream.html", "grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=island-fine-meadow-720p60-v1%20&grassAppearance=fine-meadow-v1",
      ],
      ["/stream.html", fine + "&embedded=true"],
      ["/stream.html", fine + "&embedded=false&embedded=false"],
      ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
      ],
      ["/stream.html", fine + "&streamFps=30"],
      ["/stream.html", fine + "&streamFps=60&streamFps=60"],
      ["/", "page=stream&page=stream&" + fine],
    ])
      expect(() =>
        resolveCompactDirtProjectionCandidate(
          makeWindow(path, `?${query}&${selected}`),
        ),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveCompactDirtProjectionCandidate(embedded)).toThrow(
      "non-embedded",
    );
  });

  it("captures the selection once and admits sculpt terrain before material construction", () => {
    const source = readFileSync(
      new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    expect(
      source.match(/resolveCompactDirtProjectionCandidate\(\)/gu),
    ).toHaveLength(1);
    const capture = source.slice(
      source.indexOf("  private getCompactDirtProjection()"),
      source.indexOf("  private getCompactGrassColorGrade()"),
    );
    expect(capture).toContain("if (this.compactDirtProjection === undefined)");
    expect(capture).toContain(
      "selection && !isCompactSculptProfile(this.getWorldTerrainProfile())",
    );
    expect(capture).toContain(
      "this.compactDirtProjection = selection ?? null;",
    );
    expect(source).toContain(
      "compactDirtProjection: this.getCompactDirtProjection(),",
    );
    const initialize = source.slice(
      source.indexOf("  private async initialize():"),
      source.indexOf("  async start():"),
    );
    const captureIndex = initialize.indexOf("this.getCompactDirtProjection();");
    expect(captureIndex).toBeGreaterThan(0);
    expect(captureIndex).toBeLessThan(
      initialize.indexOf("this.initTerrainMaterial();"),
    );
  });
});

describe("explicit stochastic rock preview URL policy", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "rockProjection=stochastic-v1";

  it("keeps rock, dirt and height blending independently selectable", () => {
    for (const rock of [false, true])
      for (const dirt of [false, true])
        for (const height of [false, true]) {
          const selectors = [
            fine,
            ...(rock ? [selected] : []),
            ...(dirt ? ["dirtProjection=stochastic-v1"] : []),
            ...(height ? ["terrainBlend=height-v1"] : []),
          ];
          const win = makeWindow("/stream.html", `?${selectors.join("&")}`);
          expect(resolveCompactRockProjectionCandidate(win)).toBe(
            rock ? "stochastic-v1" : undefined,
          );
          expect(resolveCompactDirtProjectionCandidate(win)).toBe(
            dirt ? "stochastic-v1" : undefined,
          );
          expect(resolveCompactSurfaceBlendCandidate(win)).toBe(
            height ? "height-v1" : undefined,
          );
        }
  });

  it("leaves absent selection undefined for every existing route and profile", () => {
    expect(resolveCompactRockProjectionCandidate()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)])
        expect(
          resolveCompactRockProjectionCandidate(
            makeWindow(path, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    expect(
      resolveCompactRockProjectionCandidate(
        makeWindow("/stream.html", "?" + fine),
      ),
    ).toBeUndefined();
  });

  it("admits the exact non-embedded fine pair without changing existing rendering or grass selections", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const original = makeWindow(
        path,
        `?${prefix}${fine}&habitatComposition=haven-understory-v1`,
      );
      const candidate = makeWindow(
        path,
        `${original.location.search}&${selected}`,
      );
      expect(resolveCompactRockProjectionCandidate(candidate)).toBe(
        "stochastic-v1",
      );
      expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
        resolveExplicitStreamingRenderProfile(original),
      );
      expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
        resolveClientViewportRuntimeProfile(original),
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
          resolveExplicitStreamingRenderProfile(original),
        ),
      );
      expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
      expect(resolveHabitatCompositionCandidate(candidate)).toBe(
        "haven-understory-v1",
      );
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
      expect(resolveGrassRoadClearance(candidate)).toBeUndefined();
    }
  });

  it("rejects empty, coerced, duplicate and unsupported projection selectors", () => {
    for (const value of [
      "",
      "unknown",
      "STOCHASTIC-V1",
      "%20stochastic-v1",
      "stochastic-v1%20",
      "stochastic-v1%0A",
      "stochastic-v1&rockProjection=stochastic-v1",
      "stochastic-v1&rockProjection=",
    ])
      expect(() =>
        resolveCompactRockProjectionCandidate(
          makeWindow("/stream.html", `?${fine}&rockProjection=${value}`),
        ),
      ).toThrow("rock projection candidate");
  });

  it("rejects missing, nonexact, embedded, mismatched and ambiguous fine selections", () => {
    for (const [path, query] of [
      ["/play", fine],
      ["/stream.html", ""],
      ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
      ["/stream.html", "grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=island-fine-meadow-720p60-v1%20&grassAppearance=fine-meadow-v1",
      ],
      ["/stream.html", fine + "&embedded=true"],
      ["/stream.html", fine + "&embedded=false&embedded=false"],
      ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
      ],
      ["/stream.html", fine + "&streamFps=30"],
      ["/stream.html", fine + "&streamFps=60&streamFps=60"],
      ["/", "page=stream&page=stream&" + fine],
    ])
      expect(() =>
        resolveCompactRockProjectionCandidate(
          makeWindow(path, `?${query}&${selected}`),
        ),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveCompactRockProjectionCandidate(embedded)).toThrow(
      "non-embedded",
    );
  });

  it("captures the selection once and admits sculpt terrain before material construction", () => {
    const source = readFileSync(
      new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    expect(
      source.match(/resolveCompactRockProjectionCandidate\(\)/gu),
    ).toHaveLength(1);
    const capture = source.slice(
      source.indexOf("  private getCompactRockProjection()"),
      source.indexOf("  private getCompactGrassColorGrade()"),
    );
    expect(capture).toContain("if (this.compactRockProjection === undefined)");
    expect(capture).toContain(
      "selection && !isCompactSculptProfile(this.getWorldTerrainProfile())",
    );
    expect(capture).toContain(
      "this.compactRockProjection = selection ?? null;",
    );
    expect(source).toContain(
      "compactRockProjection: this.getCompactRockProjection(),",
    );
    const initialize = source.slice(
      source.indexOf("  private async initialize():"),
      source.indexOf("  async start():"),
    );
    const captureIndex = initialize.indexOf("this.getCompactRockProjection();");
    expect(captureIndex).toBeGreaterThan(0);
    expect(captureIndex).toBeLessThan(
      initialize.indexOf("this.initTerrainMaterial();"),
    );
  });
});

describe("explicit per-blade grass road-clearance URL policy", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const selected = "grassRoadClearance=per-blade-v1";

  it("leaves absence undefined without selecting or altering an existing profile", () => {
    expect(resolveGrassRoadClearance()).toBeUndefined();
    for (const path of ["/play", "/stream.html"])
      for (const profile of ["", ...Object.keys(STREAMING_RENDER_PROFILES)]) {
        const win = makeWindow(path, `?streamRenderProfile=${profile}`);
        expect(resolveGrassRoadClearance(win)).toBeUndefined();
      }
    expect(
      resolveGrassRoadClearance(makeWindow("/stream.html", "?" + fine)),
    ).toBeUndefined();
  });

  it("admits one exact selector and fine pair, including independent coverage opt-in", () => {
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
      ["/stream.html", "embedded=false&streamFps=60&"],
    ]) {
      const original = makeWindow(path, `?${prefix}${fine}`);
      const candidate = makeWindow(
        path,
        `${original.location.search}&${selected}`,
      );
      expect(resolveGrassRoadClearance(candidate)).toBe("per-blade-v1");
      expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
        resolveExplicitStreamingRenderProfile(original),
      );
      expect(resolveClientViewportRuntimeProfile(candidate)).toEqual(
        resolveClientViewportRuntimeProfile(original),
      );
      expect(resolveGrassCoverageTrial(candidate)).toBeUndefined();
      candidate.location.search +=
        "&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=12,11";
      expect(resolveGrassRoadClearance(candidate)).toBe("per-blade-v1");
      expect(resolveGrassCoverageTrial(candidate)?.cell).toEqual({
        schemaVersion: 1,
        size: 25,
        indexX: 12,
        indexZ: 11,
      });
    }
  });

  it("rejects empty, duplicate, coerced and unsupported road-clearance selectors", () => {
    for (const value of [
      "",
      "unknown",
      "PER-BLADE-V1",
      "%20per-blade-v1",
      "per-blade-v1%20",
      "per-blade-v1%0A",
      "per-blade-v1&grassRoadClearance=per-blade-v1",
      "per-blade-v1&grassRoadClearance=",
    ])
      expect(() =>
        resolveGrassRoadClearance(
          makeWindow("/stream.html", `?${fine}&grassRoadClearance=${value}`),
        ),
      ).toThrow("road-clearance selector");
  });

  it("rejects missing, nonexact, incompatible, embedded and ambiguous fine pairings", () => {
    for (const [path, query] of [
      ["/play", fine],
      ["/stream.html", ""],
      ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
      ["/stream.html", "grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=%20island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=island-fine-meadow-720p60-v1%20&grassAppearance=fine-meadow-v1",
      ],
      ["/stream.html", fine + "&embedded=true"],
      ["/stream.html", fine + "&embedded=false&embedded=false"],
      ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
      [
        "/stream.html",
        fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
      ],
      ["/stream.html", fine + "&streamFps=30"],
      ["/stream.html", fine + "&streamFps=60&streamFps=60"],
      ["/", "page=stream&page=stream&" + fine],
    ])
      expect(() =>
        resolveGrassRoadClearance(makeWindow(path, `?${query}&${selected}`)),
      ).toThrow();
    const embedded = makeWindow("/stream.html", `?${fine}&${selected}`);
    Object.assign(embedded, { __HYPERIA_EMBEDDED__: true });
    expect(() => resolveGrassRoadClearance(embedded)).toThrow("non-embedded");
  });
});

describe("explicit single-cell grass coverage URL policy (not native startup proof)", () => {
  const fine =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
  const trial =
    "grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=12,11";

  it("leaves absent selections undefined without changing any existing profile", () => {
    expect(resolveGrassCoverageTrial()).toBeUndefined();
    for (const pathname of ["/play", "/stream.html"]) {
      expect(resolveGrassCoverageTrial(makeWindow(pathname))).toBeUndefined();
      for (const profile of Object.keys(STREAMING_RENDER_PROFILES))
        expect(
          resolveGrassCoverageTrial(
            makeWindow(pathname, `?streamRenderProfile=${profile}`),
          ),
        ).toBeUndefined();
    }
    expect(
      resolveGrassCoverageTrial(makeWindow("/stream.html", "?" + fine)),
    ).toBeUndefined();
  });

  it.each([
    ["/stream.html", ""],
    ["/", "page=stream&"],
    ["/stream.html", "embedded=false&streamFps=60&"],
  ])("admits the explicit fine pair on %s with %s", (pathname, prefix) => {
    expect(
      resolveGrassCoverageTrial(
        makeWindow(pathname, `?${prefix}${fine}&${trial}`),
      ),
    ).toEqual({
      id: "sixty-centimetre-cell-v1",
      cell: { schemaVersion: 1, size: 25, indexX: 12, indexZ: 11 },
    });
  });

  it.each([
    [0, 0],
    [-1, 2],
    [27, -31],
    [-4096, 4095],
    [4095, -4096],
  ])("uses a generic bounded grid, including %s,%s", (indexX, indexZ) => {
    expect(
      resolveGrassCoverageTrial(
        makeWindow(
          "/stream.html",
          `?${fine}&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=${indexX},${indexZ}`,
        ),
      )?.cell,
    ).toEqual({ schemaVersion: 1, size: 25, indexX, indexZ });
  });

  it.each([
    "grassCoverage=sixty-centimetre-cell-v1",
    "grassCoverageCell=12,11",
    "grassCoverage=&grassCoverageCell=12,11",
    "grassCoverage=unknown&grassCoverageCell=12,11",
    "grassCoverage=SIXTY-CENTIMETRE-CELL-V1&grassCoverageCell=12,11",
    "grassCoverage=%20sixty-centimetre-cell-v1&grassCoverageCell=12,11",
    "grassCoverage=sixty-centimetre-cell-v1%20&grassCoverageCell=12,11",
    trial + "&grassCoverage=sixty-centimetre-cell-v1",
    trial + "&grassCoverage=unknown",
    trial + "&grassCoverageCell=12,11",
    trial + "&grassCoverageCell=13,11",
    trial + "&grassCoverageCell=",
  ])(
    "rejects partial, duplicate or unsupported coverage selection: %s",
    (query) => {
      expect(() =>
        resolveGrassCoverageTrial(
          makeWindow("/stream.html", `?${fine}&${query}`),
        ),
      ).toThrow();
    },
  );

  it.each([
    "",
    "12",
    "12,",
    ",11",
    "12,11,0",
    "12_11",
    "12;11",
    "12.0,11",
    "12,11.5",
    "1e1,11",
    "0xc,11",
    "+12,11",
    "%2B12,11",
    "012,11",
    "-0,11",
    "12,-0",
    "%2012,11",
    "12,%2011",
    "12,11%20",
    "12,11%0A",
    "NaN,11",
    "12,Infinity",
    "4096,11",
    "12,4096",
    "-4097,11",
    "12,-4097",
    "9007199254740992,11",
    "12,-9007199254740992",
  ])("rejects noncanonical or out-of-bounds cells: %s", (cell) => {
    expect(() =>
      resolveGrassCoverageTrial(
        makeWindow(
          "/stream.html",
          `?${fine}&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=${cell}`,
        ),
      ),
    ).toThrow();
  });

  it("rejects the obsolete half-metre trial instead of relabeling its density", () => {
    expect(() =>
      resolveGrassCoverageTrial(
        makeWindow(
          "/stream.html",
          `?${fine}&grassCoverage=half-metre-cell-v1&grassCoverageCell=12,11`,
        ),
      ),
    ).toThrow("unsupported placement coverage");
  });

  it.each([
    ["/play", fine],
    ["/stream.html", ""],
    ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
    ["/stream.html", "grassAppearance=fine-meadow-v1"],
    [
      "/stream.html",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
    ],
    [
      "/stream.html",
      "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
    ],
    [
      "/stream.html",
      "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
    ],
    ["/stream.html", fine + "&embedded=true"],
    ["/stream.html", fine + "&embedded=false&embedded=false"],
    ["/stream.html", fine + "&grassAppearance=fine-meadow-v1"],
    [
      "/stream.html",
      fine + "&streamRenderProfile=island-fine-meadow-720p60-v1",
    ],
    ["/stream.html", fine + "&streamFps=30"],
    ["/stream.html", fine + "&streamFps=60&streamFps=60"],
    ["/", "page=stream&page=stream&" + fine],
  ])("rejects incompatible or ambiguous fine routes: %s?%s", (path, query) => {
    expect(() =>
      resolveGrassCoverageTrial(makeWindow(path, `?${query}&${trial}`)),
    ).toThrow();
  });

  it("returns a detached, deeply frozen selection instead of a live URL binding", () => {
    const input = makeWindow("/stream.html", `?${fine}&${trial}`);
    const selection = resolveGrassCoverageTrial(input)!;
    const repeated = resolveGrassCoverageTrial(input)!;
    expect(repeated).toEqual(selection);
    expect(repeated).not.toBe(selection);
    expect(repeated.cell).not.toBe(selection.cell);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.cell)).toBe(true);
    expect(Reflect.set(selection, "id", "unknown")).toBe(false);
    expect(Reflect.set(selection.cell, "indexX", 13)).toBe(false);
    input.location.search = `?${fine}&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=13,11`;
    expect(selection.cell.indexX).toBe(12);
    expect(resolveGrassCoverageTrial(input)?.cell.indexX).toBe(13);
  });

  it("preserves render settings and non-grass viewport policies", () => {
    const baseline = makeWindow(
      "/stream.html",
      `?${fine}&streamWorld=preparation-v1`,
    );
    const candidate = makeWindow(
      "/stream.html",
      `${baseline.location.search}&${trial}`,
    );
    expect(resolveGrassCoverageTrial(candidate)).toBeDefined();
    expect(resolveGrassAppearanceCandidate(candidate)).toBe("fine-meadow-v1");
    expect(resolveExplicitStreamingRenderProfile(candidate)).toBe(
      resolveExplicitStreamingRenderProfile(baseline),
    );
    expect(resolveExplicitStreamingWorldProfile(candidate)).toEqual(
      resolveExplicitStreamingWorldProfile(baseline),
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

  it("keeps the terrain startup source capture-once and forwards only an explicit fine trial", () => {
    // Source ownership contract only. Real URL startup/manager selection still
    // requires the separate native WebGPU run, not a fabricated browser world.
    const source = readFileSync(
      new URL("../../systems/shared/world/TerrainSystem.ts", import.meta.url),
      "utf8",
    );
    const capture = source.slice(
      source.indexOf("  private getCompactGrassColorGrade()"),
      source.indexOf("  private getCompactHabitatMaterial("),
    );
    expect(source.match(/resolveGrassCoverageTrial\(\)/gu)).toHaveLength(1);
    expect(capture).toMatch(
      /if \(this\.compactGrassColorGrade === undefined\) \{[\s\S]*const coverageTrial = resolveGrassCoverageTrial\(\);/u,
    );
    expect(capture).toMatch(
      /this\.grassVisualSelection = Object\.freeze\(\{\s*appearance,\s*profile,\s*coverageTrial,\s*\.\.\.\(roadClearance \? \{ roadClearance \} : \{\}\),\s*\.\.\.\(lighting \? \{ lighting \} : \{\}\),\s*\.\.\.\(geometry \? \{ geometry \} : \{\}\),\s*\.\.\.\(palette \? \{ palette \} : \{\}\),\s*\.\.\.\(groundingExecution \? \{ groundingExecution \} : \{\}\),\s*\.\.\.\(flowers \? \{ flowers \} : \{\}\),?\s*\}\)/u,
    );
    expect(source).toMatch(
      /grassSelection\.profile\?\.grassProfile === "fine-meadow-v1"\s*\? grassSelection\.coverageTrial \|\| grassSelection\.roadClearance\s*\? \{\s*\.\.\.FINE_MEADOW_GRASS_VISUAL_PROFILE,\s*\.\.\.\(grassSelection\.coverageTrial\s*\? \{ coverageTrial: grassSelection\.coverageTrial \}\s*: \{\}\),\s*\.\.\.\(grassSelection\.roadClearance\s*\? \{ roadClearance: grassSelection\.roadClearance \}\s*: \{\}\),?\s*\}\s*: FINE_MEADOW_GRASS_VISUAL_PROFILE/u,
    );
    expect(source.match(/resolveGrassRoadClearance\(\)/gu)).toHaveLength(1);
    expect(source.match(/resolveGrassGeometryCandidate\(\)/gu)).toHaveLength(1);
    expect(capture).toContain(
      "const geometry = resolveGrassGeometryCandidate();",
    );
    expect(source.match(/resolveGrassPaletteCandidate\(\)/gu)).toHaveLength(1);
    expect(capture).toContain(
      "const palette = resolveGrassPaletteCandidate();",
    );
    expect(source.match(/resolveGrassGroundingExecution\(\)/gu)).toHaveLength(
      1,
    );
    expect(capture).toContain(
      "const roadClearance = resolveGrassRoadClearance();",
    );
    const initialize = source.slice(
      source.indexOf("  private async initialize():"),
      source.indexOf("  async start():"),
    );
    expect(
      initialize.indexOf("this.getCompactGrassColorGrade();"),
    ).toBeLessThan(initialize.indexOf("this.initTerrainMaterial();"));
  });
});

describe("explicit habitat composition selection", () => {
  const meadow =
    "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1";
  it("retains absent/default selection and admits only the explicit matching meadow", () => {
    expect(resolveHabitatCompositionCandidate()).toBeUndefined();
    expect(
      resolveHabitatCompositionCandidate(makeWindow("/play")),
    ).toBeUndefined();
    expect(
      resolveHabitatCompositionCandidate(
        makeWindow("/stream.html", "?" + meadow),
      ),
    ).toBeUndefined();
    for (const [path, query] of [
      ["/stream.html", meadow],
      ["/", "page=stream&" + meadow],
    ])
      expect(
        resolveHabitatCompositionCandidate(
          makeWindow(
            path,
            "?" + query + "&habitatComposition=haven-understory-v1",
          ),
        ),
      ).toBe("haven-understory-v1");
  });
  it.each([
    "",
    "unknown",
    "HAVEN-UNDERSTORY-V1",
    "%20haven-understory-v1",
    "haven-understory-v1%20",
    "haven-understory-v1&habitatComposition=haven-understory-v1",
  ])("rejects invalid/duplicate habitat values: %s", (value) => {
    expect(() =>
      resolveHabitatCompositionCandidate(
        makeWindow(
          "/stream.html",
          "?" + meadow + "&habitatComposition=" + value,
        ),
      ),
    ).toThrow();
  });
  it.each([
    ["/play", meadow],
    ["/stream.html", ""],
    ["/stream.html", "streamRenderProfile=island-meadow-720p60-v1"],
    [
      "/stream.html",
      "streamRenderProfile=canonical-720p60-v1&grassAppearance=natural-tuft-v1",
    ],
    ["/stream.html", meadow + "&embedded=true"],
    ["/stream.html", meadow + "&embedded=false&embedded=true"],
    ["/stream.html", meadow + "&streamFps=30"],
    ["/stream.html", meadow + "&grassAppearance=natural-tuft-v1"],
    ["/", "page=stream&page=play&" + meadow],
  ])("rejects incompatible routes %s%s", (path, query) => {
    expect(() =>
      resolveHabitatCompositionCandidate(
        makeWindow(
          path,
          "?" + query + "&habitatComposition=haven-understory-v1",
        ),
      ),
    ).toThrow();
  });
});

describe("explicit grass appearance candidate selection", () => {
  const selection =
    "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=natural-tuft-v1";

  it("leaves absent appearance selections and existing profiles unchanged", () => {
    expect(resolveGrassAppearanceCandidate()).toBeUndefined();
    for (const pathname of ["/play", "/stream.html"]) {
      expect(
        resolveGrassAppearanceCandidate(makeWindow(pathname)),
      ).toBeUndefined();
      for (const id of Object.keys(STREAMING_RENDER_PROFILES).filter(
        // Fine meadow is a new paired selection, covered separately below.
        (value) => value !== "island-fine-meadow-720p60-v1",
      )) {
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
  const compactIdentity = worldTerrainProfileIdentity(
    SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  );
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

  it("requires exactly the bias belonging to the canonical light terrain identity", () => {
    const state = observed();
    const sun = state.sunlight!;
    const evaluate = () =>
      evaluateStreamingRenderProfileApplication(profile, requested, state);
    sun.bias = 0;
    expect(evaluate().mismatchReason).toBe("sun_shadow_projection");
    sun.terrainProfileIdentity = compactIdentity;
    expect(evaluate().ready).toBe(true);
    // A repeated sample exercises the bounded canonical identity cache.
    expect(evaluate().ready).toBe(true);
    sun.bias = 0.0002;
    expect(evaluate().mismatchReason).toBe("sun_shadow_projection");
    sun.terrainProfileIdentity = null;
    expect(evaluate().ready).toBe(true);
    for (const identity of [
      "",
      "compact-duel-island-v6",
      "x".repeat(16_385),
      compactIdentity + "\n",
      compactIdentity.replace('"schemaVersion":1', '"schemaVersion":2'),
      compactIdentity.replace('{"schemaVersion"', '{ "schemaVersion"'),
      "hyperia-world-terrain-profile-v1\n{}",
      worldTerrainProfileIdentity(COMPACT_WORLD_TERRAIN_PROFILE),
    ]) {
      sun.terrainProfileIdentity = identity;
      for (const bias of [0, 0.0002]) {
        sun.bias = bias;
        expect(evaluate().mismatchReason).toBe("sun_terrain_profile");
      }
    }
    sun.terrainProfileIdentity = compactIdentity;
    sun.bias = 0;
    expect(evaluate().ready).toBe(true);
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
        terrainProfileIdentity: compactIdentity,
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
          .mismatchReason,
      ).toBe("sun_grass_terrain_profile");
      state.sunlight!.terrainProfileIdentity = compactIdentity;
      state.sunlight!.bias = 0;
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
        {
          terrainProfileIdentity: worldTerrainProfileIdentity(
            COMPACT_WORLD_TERRAIN_PROFILE,
          ),
        },
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

  it("admits the fine meadow only as an explicit matching appearance/profile pair", () => {
    const original = STREAMING_RENDER_PROFILES["island-meadow-720p60-v1"];
    const fine = STREAMING_RENDER_PROFILES["island-fine-meadow-720p60-v1"];
    expect({
      ...fine,
      id: original.id,
      grassProfile: original.grassProfile,
    }).toEqual(original);
    const query =
      "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
    for (const [path, prefix] of [
      ["/stream.html", ""],
      ["/", "page=stream&"],
    ]) {
      const windowRef = makeWindow(path, "?" + prefix + query);
      expect(resolveExplicitStreamingRenderProfile(windowRef)).toBe(fine);
      expect(resolveGrassAppearanceCandidate(windowRef)).toBe("fine-meadow-v1");
      expect(
        resolveHabitatCompositionCandidate(
          makeWindow(
            path,
            "?" + prefix + query + "&habitatComposition=haven-understory-v1",
          ),
        ),
      ).toBe("haven-understory-v1");
    }
    for (const [path, search] of [
      ["/play", query],
      ["/stream.html", query + "&embedded=true"],
      ["/stream.html", query + "&streamFps=30"],
      ["/stream.html", query + "&grassAppearance=fine-meadow-v1"],
      ["/stream.html", query + "&grassAppearance=natural-tuft-v1"],
      ["/stream.html", query + "&streamRenderProfile=island-meadow-720p60-v1"],
      ["/stream.html", "streamRenderProfile=island-fine-meadow-720p60-v1"],
      [
        "/stream.html",
        "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=natural-tuft-v1",
      ],
      [
        "/stream.html",
        "streamRenderProfile=island-meadow-720p60-v1&grassAppearance=fine-meadow-v1",
      ],
      ["/stream.html", "grassAppearance=fine-meadow-v1"],
    ]) {
      expect(() =>
        resolveGrassAppearanceCandidate(makeWindow(path, "?" + search)),
      ).toThrow();
    }
    expect(
      resolveExplicitStreamingRenderProfile(makeWindow("/stream.html")),
    ).toBeNull();
    expect(
      resolveGrassAppearanceCandidate(makeWindow("/play")),
    ).toBeUndefined();
  });

  it("requires an actual fine cell profile receipt and preserves renderer-quality gates", () => {
    const fine = STREAMING_RENDER_PROFILES["island-fine-meadow-720p60-v1"];
    const grass: StreamingGrassProfileReceipt = {
      schemaVersion: 1,
      profileId: "fine-meadow-v1",
      eligibility: "compact-pbr-v1",
      terrainProfileIdentity: compactIdentity,
      minimumLodLevel: 0,
      clumpSpacingMultiplier: 1,
      clumpSpacing: 0.7,
      maxRenderDistance: 140,
      maxChunksPerFrame: 1,
      castShadow: false,
      destroyed: false,
      liveNodes: 6,
      pendingChunks: 0,
      inflightChunks: 0,
      settledChunks: 0,
      installedChunks: 96,
      installedClumps: 120000,
      placement: {
        schemaVersion: 1,
        mode: "world-cells-v1",
        cellSize: 25,
        nearLodDistance: 40,
        liveCells: 96,
      },
    };
    const state = observed();
    state.grass = grass;
    state.sunlight!.terrainProfileIdentity = compactIdentity;
    state.sunlight!.bias = 0;
    expect(
      evaluateStreamingRenderProfileApplication(fine, requested, state).ready,
    ).toBe(true);
    const closeGrass: StreamingGrassProfileReceipt = {
      ...grass,
      geometryLayout: "fine-folded-sheath-near5-v1",
      placement: { ...grass.placement!, detailLodDistance: 12 },
    };
    // Existing saved close-layout receipts predate candidate identity.
    expect(closeGrass).not.toHaveProperty("geometryCandidate");
    expect(
      evaluateStreamingRenderProfileApplication(fine, requested, {
        ...state,
        grass: closeGrass,
      }).ready,
    ).toBe(true);
    for (const geometryCandidate of [
      "sheath-close-v1",
      "rooted-fan-v1",
    ] as const) {
      const selectedGrass = { ...closeGrass, geometryCandidate };
      expect(
        evaluateStreamingRenderProfileApplication(fine, requested, {
          ...state,
          grass: selectedGrass,
        }).ready,
      ).toBe(true);
      for (const geometryLayout of [
        undefined,
        "fine-folded-lancet-v1",
        "fine-linear-sweep-3seg-v1",
      ] as const)
        expect(
          evaluateStreamingRenderProfileApplication(fine, requested, {
            ...state,
            grass: { ...selectedGrass, geometryLayout },
          }).mismatchReason,
        ).toBe("grass_profile");
      expect(
        evaluateStreamingRenderProfileApplication(
          STREAMING_RENDER_PROFILES["island-meadow-720p60-v1"],
          requested,
          {
            ...state,
            grass: {
              ...selectedGrass,
              profileId: "compact-meadow-v2",
              minimumLodLevel: 1,
              clumpSpacingMultiplier: 2.5,
              clumpSpacing: 1.75,
              placement: undefined,
            },
          },
        ).mismatchReason,
      ).toBe("grass_profile");
    }
    for (const geometryCandidate of [
      "",
      "ROOTED-FAN-V1",
      "rooted-fan-v1 ",
      "rooted-fan-v2",
      "sheath-close-v2",
      null,
      1,
      {},
    ]) {
      const invalidGrass = { ...closeGrass };
      // Exercise malformed observed data without broad casts or mocked owners.
      Reflect.set(invalidGrass, "geometryCandidate", geometryCandidate);
      expect(
        evaluateStreamingRenderProfileApplication(fine, requested, {
          ...state,
          grass: invalidGrass,
        }).mismatchReason,
      ).toBe("grass_profile");
    }
    // This validates observed configuration, not population completion or cost.
    for (const change of [
      { profileId: "compact-meadow-v2" as const },
      { minimumLodLevel: 1 },
      { clumpSpacingMultiplier: 2.5 },
      { clumpSpacing: 1.75 },
      { placement: undefined },
      { maxRenderDistance: 80 },
      { maxChunksPerFrame: 16 },
    ]) {
      expect(
        evaluateStreamingRenderProfileApplication(fine, requested, {
          ...state,
          grass: { ...grass, ...change },
        }).ready,
      ).toBe(false);
    }
    for (const change of [
      { cellSize: 50 },
      { nearLodDistance: 80 },
      { liveCells: -1 },
      { liveCells: NaN },
      { liveCells: 0.5 },
    ]) {
      const invalid = {
        ...grass,
        placement: { ...grass.placement!, ...change },
      } as StreamingGrassProfileReceipt;
      expect(
        evaluateStreamingRenderProfileApplication(fine, requested, {
          ...state,
          grass: invalid,
        }).mismatchReason,
      ).toBe("grass_placement");
    }
    state.renderer.samples = 1;
    expect(
      evaluateStreamingRenderProfileApplication(fine, requested, state)
        .mismatchReason,
    ).toBe("antialiasing_samples");
    state.renderer.samples = 4;
    state.renderer.dpr = 0.5;
    expect(
      evaluateStreamingRenderProfileApplication(fine, requested, state)
        .mismatchReason,
    ).toBe("render_dimensions");
  });

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
