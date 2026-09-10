import { describe, expect, it } from "vitest";
import {
  isEmbeddedSpectatorViewport,
  isStreamPageRoute,
  isStreamingLikeViewport,
  resolveClientViewportRuntimeProfile,
  resolveExplicitStreamingRenderProfile,
  resolveExplicitStreamingWorldProfile,
  resolveStreamingRenderFrameRate,
  shouldAdmitNetworkEntityInViewport,
  shouldStreamVegetationBackgroundLods,
} from "../clientViewportMode";

function makeWindow(pathname: string, search = ""): Window {
  return { location: { pathname, search } } as unknown as Window;
}

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
