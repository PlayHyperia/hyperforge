import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../config.js";
import { resolvePublicRuntimeEnvs } from "../routes/env-routes.js";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 5575,
    uwsPort: 5576,
    cdnUrl: "http://localhost:5575/game-assets",
    nodeEnv: "development",
    ...overrides,
  } as ServerConfig;
}

describe("resolvePublicRuntimeEnvs", () => {
  it("emits the active local API, websocket, and asset endpoints", () => {
    expect(resolvePublicRuntimeEnvs(makeConfig(), {}, {})).toEqual({
      PUBLIC_API_URL: "http://localhost:5575",
      PUBLIC_WS_URL: "ws://localhost:5576/ws",
      PUBLIC_CDN_URL: "http://localhost:5575/game-assets",
    });
  });

  it("preserves explicit public endpoints and honors the Fastify websocket fallback", () => {
    expect(
      resolvePublicRuntimeEnvs(
        makeConfig(),
        {
          PUBLIC_API_URL: "https://api.example",
          PUBLIC_WS_URL: "wss://ws.example/ws",
          PUBLIC_CDN_URL: "https://cdn.example",
        },
        { UWS_ENABLED: "false" },
      ),
    ).toEqual({
      PUBLIC_API_URL: "https://api.example",
      PUBLIC_WS_URL: "wss://ws.example/ws",
      PUBLIC_CDN_URL: "https://cdn.example",
    });

    expect(
      resolvePublicRuntimeEnvs(makeConfig(), {}, { UWS_ENABLED: "false" })
        .PUBLIC_WS_URL,
    ).toBe("ws://localhost:5575/ws");
  });

  it("does not invent production API or websocket topology", () => {
    expect(
      resolvePublicRuntimeEnvs(
        makeConfig({
          nodeEnv: "production",
          cdnUrl: "https://assets.hyperia.club",
        }),
        {},
        {},
      ),
    ).toEqual({ PUBLIC_CDN_URL: "https://assets.hyperia.club" });
  });
});
