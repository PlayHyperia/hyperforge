import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import Fastify from "fastify";
import { World } from "@hyperforge/shared";
import { describe, expect, it } from "vitest";

import { registerStreamingRoutes } from "../streaming.js";
import { registerStreamingBettingRoutes } from "../streaming-betting-routes.js";
import { StreamingDuelScheduler } from "../../systems/StreamingDuelScheduler/index.js";

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SSE close deadline expired")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type OpenSse = {
  request: ClientRequest;
  response: IncomingMessage;
  ended: Promise<void>;
};

async function openSse(url: string, token?: string): Promise<OpenSse> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      agent: false,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    request.setTimeout(5_000, () =>
      request.destroy(new Error("SSE connection timed out")),
    );
    request.on("error", reject);
    request.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        request.destroy();
        reject(new Error(`SSE connection returned ${response.statusCode}`));
        return;
      }
      const ended = new Promise<void>((resolveEnd, rejectEnd) => {
        response.once("end", resolveEnd);
        response.once("aborted", () =>
          rejectEnd(new Error("SSE response was aborted")),
        );
        response.once("error", rejectEnd);
      });
      // Attach immediately so a failed test's cleanup cannot emit an unhandled rejection.
      void ended.catch(() => {});
      response.on("data", () => {});
      response.once("data", () => resolve({ request, response, ended }));
    });
  });
}

describe("real streaming SSE shutdown", () => {
  it("reproduces why onClose-only SSE cleanup cannot complete server close", async () => {
    const server = Fastify();
    let activeResponse: http.ServerResponse | undefined;
    let onCloseReached = false;
    server.get("/events", (_request, reply) => {
      reply.hijack();
      activeResponse = reply.raw;
      reply.raw.setHeader("content-type", "text/event-stream");
      reply.raw.write(": transport diagnostic\n\n");
    });
    server.addHook("onClose", async () => {
      onCloseReached = true;
      activeResponse?.end();
    });
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    let client: OpenSse | undefined;
    let closing: Promise<void> | undefined;
    try {
      client = await openSse(`${url}/events`);
      closing = server.close();
      await expect(bounded(closing, 100)).rejects.toThrow(
        "SSE close deadline expired",
      );
      expect(onCloseReached).toBe(false);
      expect(client.response.readableEnded).toBe(false);
    } finally {
      client?.request.destroy();
      await bounded(closing ?? server.close());
    }
    expect(onCloseReached).toBe(true);
  });

  for (const publicRoutes of [true, false]) {
    it(`closes actual ${publicRoutes ? "public" : "standalone private"} SSE responses before waiting for HTTP close`, async () => {
      const server = Fastify();
      // A real, uninitialized world has no duel/renderer/database authority.
      // This verifies transport lifecycle only; it does not invent a healthy duel or ACK.
      const world = new World();
      const scheduler = publicRoutes ? null : new StreamingDuelScheduler(world);
      const token = randomBytes(32).toString("hex");
      const previousToken = process.env.BETTING_FEED_ACCESS_TOKEN;
      process.env.BETTING_FEED_ACCESS_TOKEN = token;
      const clients: OpenSse[] = [];
      let closing: Promise<void> | undefined;
      try {
        if (publicRoutes) {
          registerStreamingRoutes(server, world);
        } else {
          registerStreamingBettingRoutes({
            fastify: server,
            world,
            replayBuffer: 16,
            replayMaxBytes: 64 * 1024,
            pushIntervalMs: 250,
            heartbeatMs: 5_000,
            maxPendingBytes: 64 * 1024,
            maxClients: 4,
            bootstrapRateLimit: { max: 10, timeWindow: "1 minute" },
            eventsRateLimit: { max: 10, timeWindow: "1 minute" },
            internalAllowedOrigin: null,
            externalStatusFile: null,
            externalStatusMaxAgeMs: 15_000,
            getStreamingDuelScheduler: () => scheduler,
          });
        }
        const url = await server.listen({ host: "127.0.0.1", port: 0 });
        if (publicRoutes)
          clients.push(await openSse(`${url}/api/streaming/state/events`));
        if (!publicRoutes) {
          for (const endpoint of [
            "/api/internal/bet-sync/events",
            "/api/streaming/betting/events",
          ]) {
            clients.push(await openSse(`${url}${endpoint}`, token));
          }
        }
        for (const client of clients)
          expect(client.response.readableEnded).toBe(false);
        closing = server.close();
        await bounded(
          Promise.all([closing, ...clients.map((client) => client.ended)]),
        );
        expect(server.server.listening).toBe(false);
        for (const client of clients) {
          expect(client.response.readableEnded).toBe(true);
          expect(client.response.aborted).toBe(false);
        }
        await bounded(server.close());
      } finally {
        for (const client of clients) client.request.destroy();
        try {
          await bounded(closing ?? server.close());
        } finally {
          if (previousToken === undefined)
            delete process.env.BETTING_FEED_ACCESS_TOKEN;
          else process.env.BETTING_FEED_ACCESS_TOKEN = previousToken;
          scheduler?.destroy();
          await scheduler?.waitForShutdownCleanup();
          world.destroy();
        }
      }
    });
  }

  it("keeps HTTP/SSE teardown after the exact terminal publication and configured ACK barrier", () => {
    const source = readFileSync(
      new URL("../../startup/shutdown.ts", import.meta.url),
      "utf8",
    );
    const shutdown = source.slice(
      source.indexOf("const gracefulShutdown = async"),
      source.indexOf("// Register signal handlers"),
    );
    const positions = [
      "await destroyStreamingDuelAuthority()",
      "await streamingRoutes.waitForBettingTerminalFrame(",
      "await waitForStreamingDuelShutdownAcknowledgement(",
      'event: "shutdown-complete"',
      "await closeHttpServer(context)",
    ].map((fragment) => shutdown.indexOf(fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(shutdown).toContain('cancellationReason: "scheduler_shutdown"');
    expect(shutdown).toContain("duelId: terminalFrame.duelId");
  });
});
