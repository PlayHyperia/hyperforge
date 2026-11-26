import { describe, expect, it } from "vitest";

import { resolveClientConnectionAuthMode } from "../clientNetworkAuthPolicy";

const BASE = {
  urlHasAuthToken: false,
  authToken: "",
  embeddedSpectator: false,
  allowLoadTestBypass: false,
};

describe("client connection authentication policy", () => {
  it("does not wait for auth-result when the server uses load-test bypass", () => {
    expect(
      resolveClientConnectionAuthMode({
        ...BASE,
        url: "ws://localhost:5556/ws?loadTestBot=true&duelBot=true",
        allowLoadTestBypass: true,
      }),
    ).toBe("load-test-bypass");
  });

  it("does not trust the load-test query flag unless the local runtime enables it", () => {
    expect(
      resolveClientConnectionAuthMode({
        ...BASE,
        url: "ws://localhost:5556/ws?loadTestBot=true",
      }),
    ).toBe("first-message");
  });

  it("requires first-message auth for an ordinary credential-free player", () => {
    expect(
      resolveClientConnectionAuthMode({
        ...BASE,
        url: "ws://localhost:5556/ws?loadTestBot=false",
      }),
    ).toBe("first-message");
  });

  it("keeps viewer and token-backed connections on their established paths", () => {
    expect(
      resolveClientConnectionAuthMode({
        ...BASE,
        url: "ws://localhost:5556/ws?mode=streaming",
      }),
    ).toBe("anonymous-viewer");
    expect(
      resolveClientConnectionAuthMode({
        ...BASE,
        url: "ws://localhost:5556/ws?authToken=secret",
        urlHasAuthToken: true,
      }),
    ).toBe("url-token");
  });
});
