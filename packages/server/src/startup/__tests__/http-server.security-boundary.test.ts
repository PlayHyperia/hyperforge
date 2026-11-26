import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import { createHttpServer } from "../http-server.js";

const openServers: FastifyInstance[] = [];
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CLIENT_URL", "");
  vi.stubEnv("PUBLIC_APP_URL", "");
  vi.stubEnv("CLOUDFLARE_ORIGIN_SECRET", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function createProductionConfig(
  withIndex: boolean,
): Promise<ServerConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "hyperia-http-boundary-"));
  temporaryRoots.push(root);

  const publicDir = path.join(root, "public");
  const assetsDir = path.join(publicDir, "assets");
  const manifestsDir = path.join(root, "manifests");
  const worldDir = path.join(root, "world");
  await Promise.all([
    mkdir(assetsDir, { recursive: true }),
    mkdir(manifestsDir, { recursive: true }),
    mkdir(worldDir, { recursive: true }),
  ]);
  if (withIndex) {
    await writeFile(
      path.join(publicDir, "index.html"),
      "<!doctype html><title>boundary-test</title>",
      "utf8",
    );
  }

  return {
    port: 5555,
    uwsPort: 5556,
    worldDir,
    assetsDir: path.join(root, "unavailable-world-assets"),
    manifestsDir,
    iconsDir: path.join(root, "unavailable-icons"),
    hyperiaRoot: root,
    builtInAssetsDir: path.join(root, "unavailable-built-in-assets"),
    __dirname: root,
    useLocalPostgres: false,
    cdnUrl: "https://assets.hyperia.club",
    assetsUrl: "https://assets.hyperia.club/",
    saveInterval: 60,
    nodeEnv: "production",
  };
}

async function createProductionServer(withIndex = true) {
  const server = await createHttpServer(
    await createProductionConfig(withIndex),
  );
  openServers.push(server);
  return server;
}

describe("production HTTP information boundary", () => {
  it("does not expose development diagnostics or reflect missing private paths", async () => {
    const server = await createProductionServer();

    for (const url of [
      "/debug",
      "/debug/public",
      "/api",
      "/api/not-registered?token=private-query",
      "/missing.js?token=private-query",
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: "Not found" });
      expect(response.body).not.toContain("private-query");
      expect(response.body).not.toContain("hyperia-http-boundary-");
    }
  });

  it("retains SPA navigation without swallowing reserved namespaces", async () => {
    const server = await createProductionServer();
    const navigation = await server.inject({
      method: "GET",
      url: "/duels/123",
    });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.headers["content-type"]).toContain("text/html");
    expect(navigation.body).toContain("boundary-test");
  });

  it("emits CORS approval only for an exact allowed production origin", async () => {
    const server = await createProductionServer();
    const allowed = await server.inject({
      method: "GET",
      url: "/",
      headers: { origin: "https://hyperbet.win" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://hyperbet.win",
    );

    const rejected = await server.inject({
      method: "GET",
      url: "/",
      headers: { origin: "https://localhost.evil.example" },
    });
    expect(rejected.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("returns a generic frontend-unavailable response without filesystem details", async () => {
    const server = await createProductionServer(false);
    const response = await server.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Frontend not available",
      message:
        "The client application has not been built or deployed. Please ensure the client is built and copied to the server's public directory.",
    });
    expect(response.body).not.toContain("hyperia-http-boundary-");
    expect(response.body).not.toContain("expectedPath");
    expect(response.body).not.toContain("cwd");
  });
});
