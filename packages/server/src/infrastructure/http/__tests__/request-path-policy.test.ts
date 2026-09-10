import { describe, expect, it } from "vitest";

import {
  getRequestPathname,
  isReservedHttpPath,
  shouldServeSpaForRequestUrl,
} from "../request-path-policy.js";

describe("SPA request-path policy", () => {
  it("serves only application navigation paths", () => {
    for (const url of ["/duels", "/agents/alpha", "/watch?duel=123"]) {
      expect(shouldServeSpaForRequestUrl(url), url).toBe(true);
    }
  });

  it("reserves production namespaces at their exact boundary", () => {
    for (const url of [
      "/api",
      "/api/unknown",
      "/debug",
      "/debug/public",
      "/admin/unknown",
      "/health",
      "/health/check",
      "/status?detail=1",
      "/ws",
      "/live/missing.m3u8?token=private",
      "/missing.js?cache=1",
    ]) {
      expect(shouldServeSpaForRequestUrl(url), url).toBe(false);
    }
  });

  it("does not reserve lookalike application routes", () => {
    for (const pathname of ["/apiary", "/administrator", "/healthy"]) {
      expect(isReservedHttpPath(pathname), pathname).toBe(false);
      expect(shouldServeSpaForRequestUrl(pathname), pathname).toBe(true);
    }
  });

  it("removes the query before extension and namespace decisions", () => {
    expect(getRequestPathname("/missing.js?next=/duels")).toBe("/missing.js");
    expect(shouldServeSpaForRequestUrl("/missing.js?next=/duels")).toBe(false);
  });
});
