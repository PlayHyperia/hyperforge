import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRequiredBrowserOriginPreHandler,
  createOriginValidator,
  registerWriteOriginProtection,
  resolveAllowedOrigins,
} from "../origin-policy.js";

const openServers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function createWriteServer(nodeEnv = "production"): FastifyInstance {
  const server = Fastify();
  openServers.push(server);
  registerWriteOriginProtection(server, resolveAllowedOrigins(nodeEnv, {}));
  server.get("/resource", async () => ({ ok: true }));
  server.post("/resource", async () => ({ ok: true }));
  server.post("/health", async () => ({ ok: true }));
  return server;
}

describe("browser origin allowlist", () => {
  it("accepts exact production and controlled preview origins", () => {
    const validate = createOriginValidator(
      resolveAllowedOrigins("production", {}),
    );

    for (const origin of [
      "https://hyperbet.win",
      "https://hyperia.gg",
      "https://feature-123.hyperbet-solana.pages.dev",
      "https://spectate.hyperia.gg",
      "https://client.privy.io",
    ]) {
      expect(validate(origin), origin).toBe(true);
    }
  });

  it("rejects legacy HTTP, local, substring, and unrelated preview origins in production", () => {
    const validate = createOriginValidator(
      resolveAllowedOrigins("production", {}),
    );

    for (const origin of [
      "http://hyperia.pages.dev",
      "http://localhost:3000",
      "https://localhost.evil.example",
      "https://hyperia.gg.attacker.example",
      "https://attacker.up.railway.app",
      "null",
    ]) {
      expect(validate(origin), origin).toBe(false);
    }
  });

  it("allows exact loopback and private-network origins only outside production-like environments", () => {
    const development = createOriginValidator(
      resolveAllowedOrigins("development", {}),
    );
    const staging = createOriginValidator(resolveAllowedOrigins("staging", {}));

    for (const origin of [
      "http://localhost:5173",
      "https://127.0.0.1:4443",
      "http://[::1]:3000",
      "http://10.0.0.8:5555",
      "http://172.20.0.5:5555",
      "http://192.168.1.4:5555",
    ]) {
      expect(development(origin), origin).toBe(true);
      expect(staging(origin), origin).toBe(false);
    }
    expect(development("https://localhost.evil.example")).toBe(false);
  });

  it("normalizes configured app origins and fails closed on malformed production values", () => {
    const validate = createOriginValidator(
      resolveAllowedOrigins("production", {
        PUBLIC_APP_URL: "https://spectator.example/",
        CLIENT_URL: "https://game.example",
      }),
    );
    expect(validate("https://spectator.example")).toBe(true);
    expect(validate("https://game.example")).toBe(true);
    expect(validate("https://spectator.example/")).toBe(false);

    for (const [name, value] of [
      ["insecure", "http://spectator.example"],
      ["path", "https://spectator.example/private"],
      ["query", "https://spectator.example/?mode=unsafe"],
      ["credentials", "https://user:pass@spectator.example"],
      ["outer whitespace", " https://spectator.example"],
    ]) {
      expect(
        () => resolveAllowedOrigins("production", { PUBLIC_APP_URL: value }),
        name,
      ).toThrow(/PUBLIC_APP_URL/);
    }
  });

  it("allows one exact HTTP loopback origin only inside the explicit local-smoke boundary", () => {
    const origin = "http://127.0.0.1:35553";
    const validate = createOriginValidator(
      resolveAllowedOrigins("production", {
        DUEL_LOCAL_BROWSER_ORIGIN: origin,
        DUEL_LOCAL_SMOKE_MODE: "true",
        LOAD_TEST_MODE: "true",
      }),
    );

    expect(validate(origin)).toBe(true);
    expect(validate("http://localhost:35553")).toBe(false);
    expect(validate("http://127.0.0.1:35554")).toBe(false);
    expect(validate("http://127.0.0.1.evil.example:35553")).toBe(false);

    for (const [name, env] of [
      [
        "missing local-smoke mode",
        {
          DUEL_LOCAL_BROWSER_ORIGIN: origin,
          LOAD_TEST_MODE: "true",
        },
      ],
      [
        "missing load-test mode",
        {
          DUEL_LOCAL_BROWSER_ORIGIN: origin,
          DUEL_LOCAL_SMOKE_MODE: "true",
        },
      ],
      [
        "non-loopback hostname",
        {
          DUEL_LOCAL_BROWSER_ORIGIN: "http://arena.example:35553",
          DUEL_LOCAL_SMOKE_MODE: "true",
          LOAD_TEST_MODE: "true",
        },
      ],
      [
        "credentialed loopback",
        {
          DUEL_LOCAL_BROWSER_ORIGIN: "http://user:pass@127.0.0.1:35553",
          DUEL_LOCAL_SMOKE_MODE: "true",
          LOAD_TEST_MODE: "true",
        },
      ],
      [
        "loopback path",
        {
          DUEL_LOCAL_BROWSER_ORIGIN: "http://127.0.0.1:35553/stream.html",
          DUEL_LOCAL_SMOKE_MODE: "true",
          LOAD_TEST_MODE: "true",
        },
      ],
    ] as const) {
      expect(() => resolveAllowedOrigins("production", env), name).toThrow(
        /DUEL_LOCAL_BROWSER_ORIGIN/,
      );
    }
  });
});

describe("state-changing request origin enforcement", () => {
  it("permits exact allowed origins and origin-less server traffic", async () => {
    const server = createWriteServer();

    const browser = await server.inject({
      method: "POST",
      url: "/resource",
      headers: { origin: "https://hyperbet.win" },
    });
    expect(browser.statusCode).toBe(200);

    const serverToServer = await server.inject({
      method: "POST",
      url: "/resource",
    });
    expect(serverToServer.statusCode).toBe(200);
  });

  it("rejects bypass-shaped and disallowed origins with a generic response", async () => {
    const server = createWriteServer();

    for (const [url, origin] of [
      ["/resource", "https://localhost.evil.example"],
      ["/resource", "https://attacker.up.railway.app"],
      ["/health", "https://attacker.example"],
    ]) {
      const response = await server.inject({
        method: "POST",
        url,
        headers: { origin },
      });
      expect(response.statusCode, `${url} ${origin}`).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ error: "Forbidden" });
      expect(response.body).not.toContain(origin);
    }
  });

  it("rejects duplicate, comma-coalesced, and oversized Origin headers", async () => {
    const server = createWriteServer();
    const headers = [
      ["https://hyperbet.win", "https://hyperbet.win"],
      "https://hyperbet.win, https://hyperbet.win",
      `https://${"a".repeat(2050)}.example`,
    ];

    for (const origin of headers) {
      const response = await server.inject({
        method: "POST",
        url: "/resource",
        headers: { origin } as unknown as Record<string, string>,
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("does not apply write-only validation to safe reads", async () => {
    const server = createWriteServer();
    const response = await server.inject({
      method: "GET",
      url: "/resource",
      headers: { origin: "https://attacker.example" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("required browser origin enforcement", () => {
  it("requires one exact allowed Origin for browser-only proxy surfaces", async () => {
    const server = Fastify();
    openServers.push(server);
    server.get(
      "/browser-only",
      {
        preHandler: createRequiredBrowserOriginPreHandler(
          resolveAllowedOrigins("production", {}),
        ),
      },
      async () => ({ ok: true }),
    );

    const accepted = await server.inject({
      method: "GET",
      url: "/browser-only",
      headers: { origin: "https://hyperbet.win" },
    });
    expect(accepted.statusCode).toBe(200);

    for (const headers of [
      undefined,
      { origin: "https://localhost.evil.example" },
      {
        origin: ["https://hyperbet.win", "https://hyperbet.win"],
      } as unknown as Record<string, string>,
    ]) {
      const response = await server.inject({
        method: "GET",
        url: "/browser-only",
        headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ error: "Forbidden" });
    }
  });
});
