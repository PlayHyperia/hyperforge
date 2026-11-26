import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { resolveTrustedProxy } from "../trusted-proxy.js";

describe("trusted proxy authority", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("ignores forwarded identities by default, including in production", async () => {
    const trustProxy = resolveTrustedProxy({ NODE_ENV: "production" });
    expect(trustProxy).toBe(false);

    const app = Fastify({ trustProxy });
    apps.push(app);
    app.get("/identity", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      headers: { "x-forwarded-for": "203.0.113.99" },
      method: "GET",
      url: "/identity",
    });
    expect(response.json()).toEqual({ ip: "127.0.0.1" });
  });

  it("rejects trust-all in deployment environments but permits it for explicit local diagnostics", () => {
    expect(() =>
      resolveTrustedProxy({ NODE_ENV: "production", TRUST_PROXY: "true" }),
    ).toThrow(/forbidden/u);
    expect(
      resolveTrustedProxy({ NODE_ENV: "development", TRUST_PROXY: "true" }),
    ).toBe(true);
  });

  it("accepts only a bounded, unique list of exact IP addresses or CIDRs", () => {
    expect(
      resolveTrustedProxy({
        NODE_ENV: "production",
        TRUST_PROXY: "10.20.0.0/16,2001:db8:1234::/48",
      }),
    ).toEqual(["10.20.0.0/16", "2001:db8:1234::/48"]);
    expect(() =>
      resolveTrustedProxy({
        NODE_ENV: "production",
        TRUST_PROXY: "10.0.0.0/33",
      }),
    ).toThrow(/invalid CIDR prefix/u);
    expect(() =>
      resolveTrustedProxy({
        NODE_ENV: "production",
        TRUST_PROXY: "10.0.0.1,10.0.0.1",
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      resolveTrustedProxy({
        NODE_ENV: "production",
        TRUST_PROXY: "provider-internal",
      }),
    ).toThrow(/invalid IP address/u);
  });
});
