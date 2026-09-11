import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as clientEntry from "../../index.client";
import {
  evaluateStreamingRenderProfileApplication,
  resolveStreamingRenderPreferences,
  STREAMING_RENDER_PROFILES,
} from "../clientViewportMode";
import type { StreamingRenderProfileApplication } from "../../index.client";

// Import the actual client bundle source entry, not the broader Node/runtime
// barrel. This catches exports that typecheck through framework.d.ts but are
// missing from framework.client.js. No renderer or GPU is initialized here.
describe("stream render profile client package boundary", () => {
  it("uses the actual client build entrypoint and exposes both runtime functions", () => {
    const script = readFileSync(
      new URL("../../../scripts/build.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toMatch(
      /entryPoints:\s*\[\s*['"]src\/index\.client\.ts['"]\s*\]/,
    );
    expect(clientEntry.resolveStreamingRenderPreferences).toBe(
      resolveStreamingRenderPreferences,
    );
    expect(clientEntry.evaluateStreamingRenderProfileApplication).toBe(
      evaluateStreamingRenderProfileApplication,
    );
    expect(clientEntry.STREAMING_RENDER_PROFILES).toBe(
      STREAMING_RENDER_PROFILES,
    );
  });

  it("calls the exact public client API and cannot qualify requested-only state", () => {
    const profile = clientEntry.STREAMING_RENDER_PROFILES["shadows-720p60-v1"];
    const requested = clientEntry.resolveStreamingRenderPreferences(
      1280,
      720,
      profile,
    );
    const application: StreamingRenderProfileApplication =
      clientEntry.evaluateStreamingRenderProfileApplication(
        profile,
        requested,
        null,
      );
    expect(requested).toMatchObject({
      shadows: "med",
      dpr: 1,
      postprocessing: false,
    });
    expect(application).toMatchObject({
      ready: false,
      mismatchReason: "renderer_unavailable",
    });
  });
});
