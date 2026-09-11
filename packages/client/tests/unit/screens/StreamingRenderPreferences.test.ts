import { afterEach, describe, expect, it } from "vitest";
import { collectStreamingRenderProfileApplication } from "../../../src/screens/StreamingMode";
import {
  World,
  ClientInterface,
  ClientGraphics,
  Environment,
  THREE,
  STREAMING_RENDER_PROFILES,
  resolveStreamingRenderPreferences,
} from "@hyperforge/shared";

// Actual World/ClientInterface and JSDOM localStorage. No renderer is created;
// these tests prove startup precedence/persistence, not shadow pixels or GPU work.
describe("broadcast startup preference ownership", () => {
  afterEach(() => localStorage.removeItem("prefs"));
  const makePrefs = () => {
    const world = new World();
    const prefs = new ClientInterface(world);
    world.addSystem("prefs", prefs);
    return prefs;
  };
  const requested = resolveStreamingRenderPreferences(
    1280,
    720,
    STREAMING_RENDER_PROFILES["shadows-720p60-v1"],
  );

  it("applies the candidate after persisted preferences, preserving ordinary-user values on save", async () => {
    const ordinary = {
      dpr: 1.75,
      shadows: "low",
      postprocessing: true,
      bloom: true,
      colorGrading: "cinematic",
      depthBlur: true,
      waterReflections: true,
      entityHighlighting: true,
      music: 0.8,
    };
    localStorage.setItem("prefs", JSON.stringify(ordinary));
    const prefs = makePrefs();
    prefs.configureStreamingRenderPreferences(requested);
    expect(prefs.dpr).toBe(1); // Before any renderer init can read the settings.
    await prefs.init({});
    expect(prefs).toMatchObject(requested);
    expect(prefs.music).toBe(0.8);
    expect(prefs.changes).toBeNull(); // No deferred shadow rebuild from startup.
    prefs.setMusic(0.3);
    await prefs.persist();
    expect(JSON.parse(localStorage.getItem("prefs")!)).toMatchObject({
      ...ordinary,
      music: 0.3,
    });
    const normalClient = makePrefs();
    await normalClient.init({});
    expect(normalClient).toMatchObject({ ...ordinary, music: 0.3 });
  });

  it("does not write preferences merely by configuring or initializing a stream", async () => {
    const prefs = makePrefs();
    prefs.configureStreamingRenderPreferences(requested);
    await prefs.init({});
    expect(localStorage.getItem("prefs")).toBeNull();
    expect(prefs.changes).toBeNull();
  });

  it("preserves missing ordinary settings as their original defaults during an unrelated save", async () => {
    localStorage.setItem("prefs", JSON.stringify({ music: 0.9 }));
    const prefs = makePrefs();
    prefs.configureStreamingRenderPreferences(requested);
    await prefs.init({});
    prefs.setMusic(0.2);
    await prefs.persist();
    expect(JSON.parse(localStorage.getItem("prefs")!)).toMatchObject({
      music: 0.2,
      shadows: "med",
      postprocessing: true,
      bloom: true,
      depthBlur: true,
      waterReflections: true,
      entityHighlighting: true,
    });
  });

  it.each(["canonical-720p60-v1", "fallback-720p30-v1"] as const)(
    "keeps %s shadowless and non-persistent",
    async (id) => {
      localStorage.setItem(
        "prefs",
        JSON.stringify({ shadows: "high", dpr: 2 }),
      );
      const prefs = makePrefs();
      prefs.configureStreamingRenderPreferences(
        resolveStreamingRenderPreferences(
          1280,
          720,
          STREAMING_RENDER_PROFILES[id],
        ),
      );
      await prefs.init({});
      expect(prefs.shadows).toBe("none");
      expect(prefs.dpr).toBe(1);
      await prefs.persist();
      expect(JSON.parse(localStorage.getItem("prefs")!)).toMatchObject({
        shadows: "high",
        dpr: 2,
      });
    },
  );

  it("rejects mid-session policy changes instead of silently changing the selected workload", async () => {
    const prefs = makePrefs();
    prefs.configureStreamingRenderPreferences(requested);
    await prefs.init({});
    expect(() => prefs.setShadows("none")).toThrow(/startup-fixed/);
    expect(() => prefs.setDPR(0.5)).toThrow(/startup-fixed/);
    expect(() => prefs.setWaterReflections(true)).toThrow(/startup-fixed/);
    expect(() => prefs.configureStreamingRenderPreferences(requested)).toThrow(
      /before initialization/,
    );
    prefs.setShadows("med");
    expect(prefs).toMatchObject(requested);
  });

  it("does not impose a policy on ordinary interactive preferences", async () => {
    const prefs = makePrefs();
    await prefs.init({});
    prefs.setShadows("none");
    prefs.setWaterReflections(false);
    await prefs.persist();
    expect(JSON.parse(localStorage.getItem("prefs")!)).toMatchObject({
      shadows: "none",
      waterReflections: false,
    });
  });

  it.each([0, -1, NaN, Infinity, 2])(
    "rejects invalid broadcast DPR %s",
    (dpr) => {
      const prefs = makePrefs();
      expect(() =>
        prefs.configureStreamingRenderPreferences({ ...requested, dpr }),
      ).toThrow(/DPR/);
    },
  );

  it("reads actual Three owners but never qualifies an uninitialized/unrendered GPU", async () => {
    const world = new World();
    const prefs = new ClientInterface(world);
    world.addSystem("prefs", prefs);
    prefs.configureStreamingRenderPreferences(requested);
    await prefs.init({});
    const graphics = new ClientGraphics(world);
    world.addSystem("graphics", graphics);
    const environment = new Environment(world);
    world.addSystem("environment", environment);
    // Constructing these real objects allocates no adapter/device or GPU map.
    graphics.renderer = new THREE.WebGPURenderer({ antialias: true });
    await environment.init({});
    environment.buildSunLight();
    try {
      const receipt = collectStreamingRenderProfileApplication(
        world,
        STREAMING_RENDER_PROFILES["shadows-720p60-v1"],
        requested,
      );
      expect(receipt).toMatchObject({
        ready: false,
        mismatchReason: "renderer_not_rendered",
      });
      expect(receipt.applied?.renderer).toMatchObject({
        hasRendered: false,
        samples: 4,
      });
      expect(receipt.applied?.sunlight).toMatchObject({
        name: "SunLight_Single",
        castShadow: true,
        cascaded: false,
        mapSize: [4096, 4096],
        allocatedMapSize: null,
        frustum: [-200, 200, 200, -200, 0.5, 600],
      });
      expect(environment.sunLight?.shadow.map).toBeNull();
    } finally {
      environment.destroy();
      graphics.renderer.dispose();
    }
  });
});
