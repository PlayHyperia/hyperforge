import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUDFLARE_ORIGIN_SECRET_HEADER,
  getCloudflareOriginSecretFingerprint,
  registerCloudflareOriginLock,
  resolveCloudflareOriginSecret,
} from "../origin-lock.js";

const SECRET = "origin-lock-test-secret-0123456789abcdef";
const openServers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function createServer(secret: string | null = SECRET): FastifyInstance {
  const server = Fastify();
  openServers.push(server);
  registerCloudflareOriginLock(server, {
    CLOUDFLARE_ORIGIN_SECRET: secret ?? undefined,
  });
  server.get("/private", async () => ({ ok: true }));
  server.get("/health", async () => ({ status: "ok" }));
  server.get("/status", async () => ({ status: "ok" }));
  server.get("/healthz", async () => ({ status: "lookalike" }));
  server.get("/status/admin", async () => ({ status: "lookalike" }));
  server.post("/health", async () => ({ status: "mutated" }));
  return server;
}

describe("Cloudflare origin-lock configuration", () => {
  it("treats an absent or exactly empty value as disabled", () => {
    expect(resolveCloudflareOriginSecret({})).toBeUndefined();
    expect(
      resolveCloudflareOriginSecret({ CLOUDFLARE_ORIGIN_SECRET: "" }),
    ).toBeUndefined();
  });

  it.each([
    ["too short", "short"],
    ["outer whitespace", ` ${SECRET}`],
    ["a comma", `${SECRET},second`],
    ["a control character", `${SECRET}\n`],
    ["more than 512 bytes", "x".repeat(513)],
  ])("rejects %s", (_label, value) => {
    expect(() =>
      resolveCloudflareOriginSecret({ CLOUDFLARE_ORIGIN_SECRET: value }),
    ).toThrow(/CLOUDFLARE_ORIGIN_SECRET/);
  });

  it("returns a stable non-secret fingerprint", () => {
    const fingerprint = getCloudflareOriginSecretFingerprint(SECRET);
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).toBe(getCloudflareOriginSecretFingerprint(SECRET));
    expect(fingerprint).not.toContain(SECRET);
    expect(getCloudflareOriginSecretFingerprint(`${SECRET}x`)).not.toBe(
      fingerprint,
    );
  });
});

describe("Cloudflare origin-lock request enforcement", () => {
  it("allows ordinary traffic only with the exact configured credential", async () => {
    const server = createServer();

    const accepted = await server.inject({
      method: "GET",
      url: "/private",
      headers: { [CLOUDFLARE_ORIGIN_SECRET_HEADER]: SECRET },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ ok: true });

    for (const presented of [undefined, "wrong", `${SECRET}x`]) {
      const response = await server.inject({
        method: "GET",
        url: "/private",
        headers:
          presented === undefined
            ? undefined
            : { [CLOUDFLARE_ORIGIN_SECRET_HEADER]: presented },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ error: "Forbidden" });
      expect(response.body).not.toContain(SECRET);
    }
  });

  it("rejects duplicate and comma-coalesced credential headers", async () => {
    const server = createServer();
    const duplicate = await server.inject({
      method: "GET",
      url: "/private",
      headers: {
        [CLOUDFLARE_ORIGIN_SECRET_HEADER]: [SECRET, SECRET],
      },
    });
    expect(duplicate.statusCode).toBe(403);

    const coalesced = await server.inject({
      method: "GET",
      url: "/private",
      headers: {
        [CLOUDFLARE_ORIGIN_SECRET_HEADER]: `${SECRET}, ${SECRET}`,
      },
    });
    expect(coalesced.statusCode).toBe(403);
  });

  it("exempts only exact read-only health and status probes", async () => {
    const server = createServer();

    for (const [method, url] of [
      ["GET", "/health"],
      ["GET", "/health?full=1"],
      ["GET", "/status"],
      ["HEAD", "/status"],
    ] as const) {
      const response = await server.inject({ method, url });
      expect(response.statusCode).toBe(200);
    }

    for (const [method, url] of [
      ["GET", "/healthz"],
      ["GET", "/status/admin"],
      ["POST", "/health"],
    ] as const) {
      const response = await server.inject({ method, url });
      expect(response.statusCode).toBe(403);
    }
  });

  it("does not install enforcement when the credential is absent", async () => {
    const server = createServer(null);
    const response = await server.inject({ method: "GET", url: "/private" });
    expect(response.statusCode).toBe(200);
  });
});
