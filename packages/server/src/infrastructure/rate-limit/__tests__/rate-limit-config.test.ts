import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAuthRateLimit,
  getGlobalRateLimit,
  isPublicStaticDeliveryRequest,
  isRateLimitEnabled,
} from "../rate-limit-config.js";

describe("production rate-limit policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cannot be disabled in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_RATE_LIMIT", "true");
    expect(isRateLimitEnabled()).toBe(true);
  });

  it("cannot be disabled in staging", () => {
    vi.stubEnv("NODE_ENV", "staging");
    vi.stubEnv("DISABLE_RATE_LIMIT", "true");
    expect(isRateLimitEnabled()).toBe(true);
  });

  it("allows an explicit local-development disable but fails closed on typos", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DISABLE_RATE_LIMIT", "true");
    expect(isRateLimitEnabled()).toBe(false);
    vi.stubEnv("DISABLE_RATE_LIMIT", "treu");
    expect(isRateLimitEnabled()).toBe(true);
  });

  it("keeps the authentication route at five attempts per minute per IP", () => {
    expect(getAuthRateLimit()).toMatchObject({
      max: 5,
      timeWindow: "1 minute",
    });
  });

  it("keeps immutable browser delivery outside the application API bucket", () => {
    const request = (method: string, url: string) =>
      ({ method, routeOptions: { url } }) as never;

    for (const url of [
      "/game-assets/*",
      "/game-assets/manifests/*",
      "/live/*",
    ]) {
      expect(isPublicStaticDeliveryRequest(request("GET", url))).toBe(true);
      expect(isPublicStaticDeliveryRequest(request("HEAD", url))).toBe(true);
      expect(isPublicStaticDeliveryRequest(request("POST", url))).toBe(false);
    }

    for (const url of ["/game-assets-evil/*", "/api/*", "/admin/*", "/*"]) {
      expect(isPublicStaticDeliveryRequest(request("GET", url))).toBe(false);
    }

    const allowList = getGlobalRateLimit().allowList;
    expect(typeof allowList).toBe("function");
    expect(
      (allowList as (request: never, key: string) => boolean)(
        request("GET", "/game-assets/*"),
        "127.0.0.1",
      ),
    ).toBe(true);
    expect(
      (allowList as (request: never, key: string) => boolean)(
        request("GET", "/api/*"),
        "127.0.0.1",
      ),
    ).toBe(false);
  });
});
