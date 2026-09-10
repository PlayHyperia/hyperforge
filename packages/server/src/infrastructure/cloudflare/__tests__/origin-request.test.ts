import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_ORIGIN_SECRET_HEADER,
  prepareOriginRequest,
} from "../origin-request.js";

describe("Cloudflare origin request preparation", () => {
  it("overwrites a client-provided credential and preserves request metadata", async () => {
    const original = new Request("https://hyperia.gg/api/duels?limit=1", {
      method: "POST",
      headers: {
        authorization: "Bearer public-token",
        [CLOUDFLARE_ORIGIN_SECRET_HEADER]: "attacker-controlled",
      },
      body: "payload",
    });

    const forwarded = prepareOriginRequest(original, "edge-owned-secret");

    expect(forwarded).not.toBe(original);
    expect(forwarded.url).toBe(original.url);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer public-token");
    expect(forwarded.headers.get(CLOUDFLARE_ORIGIN_SECRET_HEADER)).toBe(
      "edge-owned-secret",
    );
    expect(await forwarded.text()).toBe("payload");
  });

  it("strips the client-provided credential when the edge lock is disabled", () => {
    const original = new Request("https://hyperia.gg/", {
      headers: {
        [CLOUDFLARE_ORIGIN_SECRET_HEADER]: "attacker-controlled",
      },
    });

    const forwarded = prepareOriginRequest(original, undefined);
    expect(forwarded.headers.has(CLOUDFLARE_ORIGIN_SECRET_HEADER)).toBe(false);
  });
});
