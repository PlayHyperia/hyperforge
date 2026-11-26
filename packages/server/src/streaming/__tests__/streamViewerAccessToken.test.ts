import { describe, expect, it } from "vitest";

import {
  extractStreamingViewerBearerToken,
  hasValidStreamingViewerAccessToken,
  resolveStreamingViewerAccessToken,
} from "../stream-viewer-access-token.js";

describe("stream viewer access token", () => {
  it("prefers the explicit viewer token and derives a stable fallback from JWT", () => {
    expect(
      resolveStreamingViewerAccessToken({
        STREAMING_VIEWER_ACCESS_TOKEN: "viewer-secret",
        JWT_SECRET: "jwt-secret",
      }),
    ).toBe("viewer-secret");
    expect(
      resolveStreamingViewerAccessToken({ JWT_SECRET: "jwt-secret" }),
    ).toHaveLength(64);
    expect(resolveStreamingViewerAccessToken({})).toBe("");
  });

  it("extracts only non-empty Bearer credentials", () => {
    expect(extractStreamingViewerBearerToken("Bearer viewer-secret")).toBe(
      "viewer-secret",
    );
    expect(extractStreamingViewerBearerToken("bearer  viewer-secret ")).toBe(
      "viewer-secret",
    );
    expect(
      extractStreamingViewerBearerToken(["Bearer first", "Bearer next"]),
    ).toBe("first");
    expect(extractStreamingViewerBearerToken("Basic viewer-secret")).toBeNull();
    expect(extractStreamingViewerBearerToken("Bearer   ")).toBeNull();
  });

  it("uses timing-safe digest comparison and fails closed", () => {
    const env = { STREAMING_VIEWER_ACCESS_TOKEN: "viewer-secret" };
    expect(
      hasValidStreamingViewerAccessToken("Bearer viewer-secret", env),
    ).toBe(true);
    expect(hasValidStreamingViewerAccessToken("Bearer wrong-secret", env)).toBe(
      false,
    );
    expect(hasValidStreamingViewerAccessToken(undefined, env)).toBe(false);
    expect(hasValidStreamingViewerAccessToken("Bearer viewer-secret", {})).toBe(
      false,
    );
  });
});
