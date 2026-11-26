/* global ReadableStreamDefaultReader */

import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocateNextBettingClientId,
  hasAllowedInternalBettingOrigin,
  normalizeInternalAllowedOrigin,
  parseReplayCursor,
  registerStreamingBettingRoutes,
} from "../../../src/routes/streaming-betting-routes.js";
import type { StreamingDuelCycle } from "../../../src/systems/StreamingDuelScheduler/types.js";

type ParsedSseEvent = {
  id: number | null;
  event: string;
  data: Record<string, unknown>;
};

function createRouteCycle(
  overrides: Partial<StreamingDuelCycle> = {},
): StreamingDuelCycle {
  return {
    cycleId: "cycle-1",
    phase: "FIGHTING",
    cycleStartTime: 1_000,
    phaseStartTime: 2_000,
    phaseVersion: 4,
    agent1: null,
    agent2: null,
    duelId: "duel-1",
    duelKeyHex: "0xabcdef",
    competitiveSnapshotVersion: null,
    competitiveSnapshotDigest: null,
    competitiveSnapshot: null,
    arenaId: null,
    betOpenTime: 1_000,
    betCloseTime: 2_000,
    countdownValue: null,
    fightStartTime: 3_000,
    duelEndTime: null,
    arenaPositions: null,
    winnerId: null,
    loserId: null,
    outcome: null,
    winReason: null,
    seed: null,
    replayHash: null,
    ...overrides,
  };
}

function createRouteOptions(
  overrides: Partial<Parameters<typeof registerStreamingBettingRoutes>[0]> = {},
) {
  const world = Object.assign(new EventEmitter(), {
    getSystem: () => null,
  });
  return {
    fastify: Fastify(),
    world: world as never,
    replayBuffer: 16,
    replayMaxBytes: 64 * 1024,
    pushIntervalMs: 250,
    heartbeatMs: 5000,
    maxPendingBytes: 64 * 1024,
    maxClients: 1,
    bootstrapRateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
    eventsRateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
    internalAllowedOrigin: null,
    externalStatusFile: null,
    externalStatusMaxAgeMs: 15_000,
    getStreamingDuelScheduler: () => ({
      getCurrentCycle: () => null,
    }),
    getStreamingDuelAuthoritySnapshot: () => ({
      configured: true,
      role: "authority" as const,
      verified: true,
      schedulerRunning: true,
      fencingToken: "7",
      acquiredAt: 1_000,
      renewedAt: 2_000,
      expiresAt: 17_000,
      lastError: null,
    }),
    getStreamCaptureStats: () => ({
      clientConnected: true,
      ffmpegRunning: true,
    }),
    ...overrides,
  };
}

async function readSseEvents(
  response: Response,
  count: number,
): Promise<{
  events: ParsedSseEvent[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  if (!response.body) throw new Error("SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffered = "";
  const timeoutAt = Date.now() + 5_000;

  while (events.length < count) {
    const remainingMs = timeoutAt - Date.now();
    if (remainingMs <= 0) throw new Error("timed out reading betting SSE");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("timed out reading betting SSE")),
          remainingMs,
        );
      }),
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    if (chunk.done)
      throw new Error("betting SSE closed before replay completed");
    buffered += decoder
      .decode(chunk.value, { stream: true })
      .replace(/\r\n/g, "\n");

    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf("\n\n");
      if (!frame || frame.startsWith(":")) continue;

      let id: number | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) {
          const parsed = Number.parseInt(line.slice(3).trim(), 10);
          id = Number.isSafeInteger(parsed) ? parsed : null;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (data.length > 0) {
        events.push({
          id,
          event,
          data: JSON.parse(data.join("\n")) as Record<string, unknown>,
        });
      }
    }
  }

  return { events, reader };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= timeoutAt) {
      throw new Error("timed out waiting for route state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("streaming-betting-routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns bootstrap state for valid authenticated requests", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 3,
      sourceEpoch: expect.any(Number),
      replay: expect.objectContaining({
        sourceEpoch: expect.any(Number),
      }),
    });

    routes.close();
    await options.fastify.close();
  });

  it("exposes exact authenticated authority health instead of generic server health", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const cycle = createRouteCycle({
      phase: "ANNOUNCEMENT",
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "a".repeat(64),
      competitiveSnapshot: {
        persisted: true,
        diagnostic: false,
      } as never,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
        getDurableBettingTerminal: () => null,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);

    const unauthorized = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/authority-health",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/authority-health",
      headers: { authorization: "Bearer bet-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      ready: true,
      sourceEpoch: expect.any(Number),
      duelId: "duel-1",
      duelKeyHex: "0xabcdef",
      snapshotDigest: "a".repeat(64),
      phase: "ANNOUNCEMENT",
      outcome: null,
      cancellationReason: null,
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
    });

    routes.close();
    await options.fastify.close();
  });

  it("fails authority health closed when the production lease is not verified", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const cycle = createRouteCycle({
      phase: "ANNOUNCEMENT",
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "b".repeat(64),
      competitiveSnapshot: {
        persisted: true,
        diagnostic: false,
      } as never,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
        getDurableBettingTerminal: () => null,
      }),
      getStreamingDuelAuthoritySnapshot: () => ({
        configured: true,
        role: "authority",
        verified: false,
        schedulerRunning: true,
        fencingToken: null,
        acquiredAt: 1_000,
        renewedAt: 2_000,
        expiresAt: 2_000,
        lastError: "lease_local_deadline_elapsed",
      }),
    });
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/authority-health",
      headers: { authorization: "Bearer bet-secret" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ready: false,
      duelId: "duel-1",
      competitiveSnapshotPersisted: true,
      competitiveSnapshotDiagnostic: false,
    });

    routes.close();
    await options.fastify.close();
  });

  it("exposes the same fail-closed renderer health used by the public stream", async () => {
    const cycle = createRouteCycle({ phase: "FIGHTING" });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);

    expect(routes.getRendererHealth()).toMatchObject({
      ready: false,
      degradedReason: "agents_missing",
      updatedAt: expect.any(Number),
    });

    routes.close();
    await options.fastify.close();
  });

  it("advances changed lifecycle state through polling without an SSE client", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    let cycle = createRouteCycle({
      phase: "ANNOUNCEMENT",
      phaseVersion: 1,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const requestState = () =>
      options.fastify.inject({
        method: "GET",
        url: "/api/internal/bet-sync/state",
        headers: { authorization: "Bearer bet-secret" },
      });

    const announcement = await requestState();
    expect(announcement.statusCode).toBe(200);
    expect(announcement.json()).toMatchObject({
      seq: 1,
      phase: "ANNOUNCEMENT",
      phaseVersion: 1,
    });

    cycle = createRouteCycle({
      phase: "COUNTDOWN",
      phaseVersion: 2,
      countdownValue: 3,
    });
    const countdown = await requestState();
    expect(countdown.statusCode).toBe(200);
    expect(countdown.json()).toMatchObject({
      seq: 2,
      phase: "COUNTDOWN",
      phaseVersion: 2,
    });

    const unchanged = await requestState();
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toMatchObject({
      seq: 2,
      phase: "COUNTDOWN",
      replay: { bufferedFrames: 2, latestSeq: 2 },
    });
    expect(routes.getMetrics()).toMatchObject({
      clients: { connected: 0 },
      replay: { size: 2, oldestSeq: 1, latestSeq: 2 },
    });

    routes.close();
    await options.fastify.close();
  });

  it("refreshes feed observation health without creating duplicate state frames", async () => {
    let observedNow = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => observedNow);
    const cycle = createRouteCycle();
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);

    routes.captureCurrentState();
    expect(routes.getMetrics().replay).toMatchObject({
      size: 1,
      latestEmittedAt: 10_000,
      latestObservedAt: 10_000,
    });

    observedNow = 30_000;
    routes.captureCurrentState();
    expect(routes.getMetrics().replay).toMatchObject({
      size: 1,
      latestEmittedAt: 10_000,
      latestObservedAt: 30_000,
    });

    routes.close();
    await options.fastify.close();
  });

  it("captures and replays a terminal cancellation before the scheduler clears its cycle", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    let cycle: StreamingDuelCycle | null = createRouteCycle();
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;
    let observedNow = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => observedNow++);

    world.emit("streaming:cycle:aborted", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      reason: "combat_engagement_failed",
    });
    world.emit("streaming:cycle:aborted", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      reason: "combat_engagement_failed",
    });
    cycle = null;

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 3,
      duelId: "duel-1",
      duelKey: "0xabcdef",
      duelEndTime: expect.any(Number),
      winnerId: null,
      outcome: "cancelled",
      cancellationReason: "combat_engagement_failed",
    });
    expect(routes.getMetrics().replay.size).toBe(1);

    routes.close();
    expect(world.listenerCount("streaming:cycle:aborted")).toBe(0);
    await options.fastify.close();
  });

  it("serves the retained terminal state and replay after the scheduler singleton clears", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const cycle = createRouteCycle({
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "a".repeat(64),
      competitiveSnapshot: {
        persisted: true,
        diagnostic: false,
      } as never,
    });
    let schedulerAvailable = true;
    const scheduler = {
      getCurrentCycle: () => cycle,
      getDurableBettingTerminal: () => null,
    };
    const options = createRouteOptions({
      maxClients: 2,
      pushIntervalMs: 60_000,
      heartbeatMs: 60_000,
      getStreamingDuelScheduler: () => (schedulerAvailable ? scheduler : null),
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;

    routes.captureCurrentState();
    world.emit("streaming:cycle:aborted", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      reason: "scheduler_shutdown",
    });
    await waitForCondition(() => routes.getMetrics().replay.size === 2);
    schedulerAvailable = false;

    const stateResponse = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: { authorization: "Bearer bet-secret" },
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json()).toMatchObject({
      seq: 2,
      duelId: "duel-1",
      duelKey: "0xabcdef",
      outcome: "cancelled",
      cancellationReason: "scheduler_shutdown",
    });

    const baseUrl = await options.fastify.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const replayResponse = await fetch(
      `${baseUrl}/api/internal/bet-sync/events?since=1`,
      { headers: { authorization: "Bearer bet-secret" } },
    );
    expect(replayResponse.status).toBe(200);
    const replay = await readSseEvents(replayResponse, 1);
    expect(replay.events).toMatchObject([
      {
        id: 2,
        event: "betting",
        data: {
          duelId: "duel-1",
          outcome: "cancelled",
          cancellationReason: "scheduler_shutdown",
        },
      },
    ]);
    await replay.reader.cancel("retained terminal replay verified");

    routes.close();
    await options.fastify.close();
  });

  it("does not serve a retained nonterminal frame after the scheduler singleton clears", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const cycle = createRouteCycle({
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "b".repeat(64),
      competitiveSnapshot: {
        persisted: true,
        diagnostic: false,
      } as never,
    });
    let schedulerAvailable = true;
    const options = createRouteOptions({
      getStreamingDuelScheduler: () =>
        schedulerAvailable
          ? {
              getCurrentCycle: () => cycle,
              getDurableBettingTerminal: () => null,
            }
          : null,
    });
    const routes = registerStreamingBettingRoutes(options);

    routes.captureCurrentState();
    expect(routes.getMetrics().replay.size).toBe(1);
    schedulerAvailable = false;

    for (const url of [
      "/api/internal/bet-sync/state",
      "/api/internal/bet-sync/events?since=0",
    ]) {
      const response = await options.fastify.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer bet-secret" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "Streaming mode not active",
      });
    }

    routes.close();
    await options.fastify.close();
  });

  it("bootstraps a durable cancellation even when routes attach after the cycle cleared", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const terminalCycle = createRouteCycle({
      phase: "FIGHTING",
      duelEndTime: 9_000,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () =>
        ({
          getCurrentCycle: () => null,
          getDurableBettingTerminal: () => ({
            cycle: terminalCycle,
            terminal: {
              outcome: "cancelled",
              cancellationReason: "scheduler_shutdown",
              duelEndTime: 9_000,
            },
          }),
        }) as never,
    });
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: { authorization: "Bearer bet-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 3,
      duelId: "duel-1",
      duelKey: "0xabcdef",
      duelEndTime: 9_000,
      outcome: "cancelled",
      cancellationReason: "scheduler_shutdown",
    });

    routes.close();
    await options.fastify.close();
  });

  it("captures an emitted durable cancellation after the live cycle has cleared", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const terminalCycle = createRouteCycle({
      phase: "FIGHTING",
      duelEndTime: 9_000,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () =>
        ({
          getCurrentCycle: () => null,
          getDurableBettingTerminal: () => ({
            cycle: terminalCycle,
            terminal: {
              outcome: "cancelled",
              cancellationReason: "scheduler_shutdown",
              duelEndTime: 9_000,
            },
          }),
        }) as never,
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;

    world.emit("streaming:cycle:aborted", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      reason: "scheduler_shutdown",
    });

    await waitForCondition(() => routes.getMetrics().replay.size === 1);
    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: { authorization: "Bearer bet-secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duelId: "duel-1",
      duelKey: "0xabcdef",
      outcome: "cancelled",
      cancellationReason: "scheduler_shutdown",
      duelEndTime: 9_000,
    });

    routes.close();
    await options.fastify.close();
  });

  it("captures and replays a terminal win before the scheduler clears its cycle", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    let cycle: StreamingDuelCycle | null = createRouteCycle({
      phase: "RESOLUTION",
      duelEndTime: 4_000,
      winnerId: "agent-a",
      loserId: "agent-b",
      outcome: "win",
      winReason: "kill",
      seed: "42",
      replayHash: "ab".repeat(32),
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;

    world.emit("streaming:resolution:start", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      outcome: "win",
    });
    world.emit("streaming:resolution:start", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      outcome: "win",
    });
    cycle = null;

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 3,
      duelId: "duel-1",
      duelEndTime: 4_000,
      winnerId: "agent-a",
      outcome: "win",
      cancellationReason: null,
      winReason: "kill",
      seed: "42",
      replayHash: "ab".repeat(32),
    });
    expect(routes.getMetrics().replay.size).toBe(1);

    routes.close();
    expect(world.listenerCount("streaming:resolution:start")).toBe(0);
    await options.fastify.close();
  });

  it("replays every terminal frame over real SSE after disconnect and reconnect", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const agent1 = {
      characterId: "agent-a",
      name: "Agent A",
      provider: "provider-a",
      model: "model-a",
      combatLevel: 10,
      wins: 1,
      losses: 0,
      currentHp: 20,
      maxHp: 30,
      originalPosition: [0, 0, 0] as [number, number, number],
      damageDealtThisFight: 10,
      equipment: {},
      inventory: [],
      rank: 1,
      headToHeadWins: 1,
      headToHeadLosses: 0,
    };
    const agent2 = {
      ...agent1,
      characterId: "agent-b",
      name: "Agent B",
      wins: 0,
      losses: 1,
      currentHp: 0,
      damageDealtThisFight: 5,
      rank: 2,
      headToHeadWins: 0,
      headToHeadLosses: 1,
    };
    let cycle: StreamingDuelCycle | null = createRouteCycle({
      cycleId: "cycle-bootstrap",
      duelId: "duel-bootstrap",
      duelKeyHex: "10".repeat(32),
      agent1,
      agent2,
    });
    const options = createRouteOptions({
      maxClients: 2,
      pushIntervalMs: 60_000,
      heartbeatMs: 60_000,
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;
    const baseUrl = await options.fastify.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const eventsUrl = `${baseUrl}/api/internal/bet-sync/events`;
    const headers = { authorization: "Bearer bet-secret" };

    const firstResponse = await fetch(eventsUrl, { headers });
    expect(firstResponse.status).toBe(200);
    const firstDelivery = await readSseEvents(firstResponse, 1);
    expect(firstDelivery.events).toMatchObject([
      {
        id: 1,
        event: "betting",
        data: { duelId: "duel-bootstrap", outcome: null },
      },
    ]);
    await firstDelivery.reader.cancel("intentional keeper disconnect");
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);

    cycle = createRouteCycle({
      cycleId: "cycle-cancelled",
      duelId: "duel-cancelled",
      duelKeyHex: "20".repeat(32),
      agent1,
      agent2,
    });
    world.emit("streaming:cycle:aborted", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      reason: "combat_engagement_failed",
    });
    world.emit("streaming:cycle:aborted", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      reason: "combat_engagement_failed",
    });

    cycle = createRouteCycle({
      cycleId: "cycle-win",
      duelId: "duel-win",
      duelKeyHex: "30".repeat(32),
      phase: "RESOLUTION",
      agent1,
      agent2,
      duelEndTime: 5_000,
      winnerId: "agent-a",
      loserId: "agent-b",
      outcome: "win",
      winReason: "kill",
      seed: "99",
      replayHash: "cd".repeat(32),
    });
    world.emit("streaming:resolution:start", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      outcome: "win",
    });
    world.emit("streaming:resolution:start", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      outcome: "win",
    });

    cycle = createRouteCycle({
      cycleId: "cycle-draw",
      duelId: "duel-draw",
      duelKeyHex: "40".repeat(32),
      phase: "RESOLUTION",
      agent1,
      agent2,
      duelEndTime: 6_000,
      outcome: "draw",
      winReason: "draw",
      seed: "100",
      replayHash: "ef".repeat(32),
    });
    world.emit("streaming:cycle:aborted", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      reason: "draw",
    });
    world.emit("streaming:cycle:aborted", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      reason: "draw",
    });
    cycle = null;

    expect(routes.getMetrics()).toMatchObject({
      clients: { connected: 0 },
      replay: { size: 4, oldestSeq: 1, latestSeq: 4 },
    });

    const replayResponse = await fetch(eventsUrl, {
      headers: {
        ...headers,
        "last-event-id": "1",
      },
    });
    expect(replayResponse.status).toBe(200);
    const replayDelivery = await readSseEvents(replayResponse, 3);
    expect(replayDelivery.events.map(({ id }) => id)).toEqual([2, 3, 4]);
    expect(
      replayDelivery.events.map(({ data }) => ({
        duelId: data.duelId,
        outcome: data.outcome,
        reason: data.cancellationReason,
        winnerId: data.winnerId,
      })),
    ).toEqual([
      {
        duelId: "duel-cancelled",
        outcome: "cancelled",
        reason: "combat_engagement_failed",
        winnerId: null,
      },
      {
        duelId: "duel-win",
        outcome: "win",
        reason: null,
        winnerId: "agent-a",
      },
      {
        duelId: "duel-draw",
        outcome: "draw",
        reason: "draw",
        winnerId: null,
      },
    ]);
    await replayDelivery.reader.cancel("replay verified");
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);

    routes.close();
    await options.fastify.close();
  });

  it("fails closed with an explicit reset when real SSE replay retention is exceeded", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    let cycle: StreamingDuelCycle | null = createRouteCycle({
      cycleId: "cycle-1",
      duelId: "duel-1",
      duelKeyHex: "11".repeat(32),
    });
    const options = createRouteOptions({
      replayBuffer: 2,
      maxClients: 2,
      pushIntervalMs: 60_000,
      heartbeatMs: 60_000,
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const baseUrl = await options.fastify.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const eventsUrl = `${baseUrl}/api/internal/bet-sync/events`;
    const headers = { authorization: "Bearer bet-secret" };

    const firstResponse = await fetch(eventsUrl, { headers });
    const firstDelivery = await readSseEvents(firstResponse, 1);
    expect(firstDelivery.events[0]?.id).toBe(1);
    await firstDelivery.reader.cancel("force retained-gap scenario");
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);

    for (let index = 2; index <= 4; index += 1) {
      cycle = createRouteCycle({
        cycleId: `cycle-${index}`,
        duelId: `duel-${index}`,
        duelKeyHex: String(index).padStart(2, "0").repeat(32),
      });
      routes.captureCurrentState();
    }
    expect(routes.getMetrics()).toMatchObject({
      replay: { size: 2, oldestSeq: 3, latestSeq: 4 },
    });

    const resetResponse = await fetch(eventsUrl, {
      headers: { ...headers, "last-event-id": "1" },
    });
    expect(resetResponse.status).toBe(200);
    const resetDelivery = await readSseEvents(resetResponse, 1);
    expect(resetDelivery.events).toMatchObject([
      {
        id: 4,
        event: "reset",
        data: { duelId: "duel-4", seq: 4 },
      },
    ]);
    await resetDelivery.reader.cancel("reset verified");
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);

    routes.close();
    await options.fastify.close();
  });

  it("preserves a draw outcome in the terminal cancellation frame", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const cycle = createRouteCycle({
      phase: "RESOLUTION",
      outcome: "draw",
      winReason: "draw",
      duelEndTime: 4_000,
    });
    const options = createRouteOptions({
      getStreamingDuelScheduler: () => ({
        getCurrentCycle: () => cycle,
      }),
    });
    const routes = registerStreamingBettingRoutes(options);
    const world = options.world as unknown as EventEmitter;

    world.emit("streaming:cycle:aborted", {
      cycleId: "cycle-1",
      duelId: "duel-1",
      reason: "draw",
    });

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "draw",
      cancellationReason: "draw",
      duelEndTime: 4_000,
    });

    routes.close();
    await options.fastify.close();
  });

  it("rejects query-token auth on the bootstrap route", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state?streamToken=bet-secret",
    });

    expect(response.statusCode).toBe(401);
    routes.close();
    await options.fastify.close();
  });

  it("returns 503 once betting SSE capacity is exhausted after auth succeeds", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");

    const options = createRouteOptions({
      maxClients: 0,
    });
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/events",
      headers: {
        authorization: "Bearer bet-secret",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "Bet sync SSE capacity reached",
    });

    routes.close();
    await options.fastify.close();
  });

  it("fails closed in production when betting-feed auth is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer whatever",
      },
    });

    expect(response.statusCode).toBe(503);
    routes.close();
    await options.fastify.close();
  });

  it("allows explicit skip-auth only in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "");
    vi.stubEnv("BETTING_FEED_SKIP_AUTH", "true");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
    });

    expect(response.statusCode).toBe(200);
    routes.close();
    await options.fastify.close();
  });

  it("ignores skip-auth in test environments", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "");
    vi.stubEnv("BETTING_FEED_SKIP_AUTH", "true");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
    });

    expect(response.statusCode).toBe(503);
    routes.close();
    await options.fastify.close();
  });

  it("ignores skip-auth in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "");
    vi.stubEnv("BETTING_FEED_SKIP_AUTH", "true");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
    });

    expect(response.statusCode).toBe(503);
    routes.close();
    await options.fastify.close();
  });

  it("does not treat the viewer token as a betting-feed fallback", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "");
    vi.stubEnv("STREAMING_VIEWER_ACCESS_TOKEN", "viewer-secret");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer viewer-secret",
      },
    });

    expect(response.statusCode).toBe(503);
    routes.close();
    await options.fastify.close();
  });

  it("reuses and releases the external status poller across repeated route registration", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const firstOptions = createRouteOptions({
      externalStatusFile: "/tmp/nonexistent-betting-status.json",
    });
    const secondOptions = createRouteOptions({
      externalStatusFile: "/tmp/nonexistent-betting-status.json",
    });

    const firstRoutes = registerStreamingBettingRoutes(firstOptions);
    const secondRoutes = registerStreamingBettingRoutes(secondOptions);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    firstRoutes.close();
    await firstOptions.fastify.close();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    secondRoutes.close();
    await secondOptions.fastify.close();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the external status poller when Fastify closes even without manual route cleanup", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const options = createRouteOptions({
      externalStatusFile: "/tmp/nonexistent-betting-status.json",
    });

    registerStreamingBettingRoutes(options);
    await options.fastify.close();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts only one explicit internal betting CORS origin", () => {
    expect(normalizeInternalAllowedOrigin("https://bets.example.com")).toBe(
      "https://bets.example.com",
    );
    expect(normalizeInternalAllowedOrigin("*")).toBeNull();
    expect(normalizeInternalAllowedOrigin("null")).toBeNull();
    expect(
      normalizeInternalAllowedOrigin(
        "https://bets.example.com,https://other.example.com",
      ),
    ).toBeNull();
    expect(
      normalizeInternalAllowedOrigin("https://bets.example.com/path"),
    ).toBeNull();
    expect(
      hasAllowedInternalBettingOrigin(
        "https://bets.example.com",
        "https://bets.example.com",
      ),
    ).toBe(true);
    expect(
      hasAllowedInternalBettingOrigin(
        "https://other.example.com",
        "https://bets.example.com",
      ),
    ).toBe(false);
    expect(
      hasAllowedInternalBettingOrigin("https://bets.example.com", null),
    ).toBe(false);
    expect(hasAllowedInternalBettingOrigin(undefined, null)).toBe(true);
  });

  it("rejects browser origins except the one exact internal betting origin", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");
    const options = createRouteOptions({
      internalAllowedOrigin: "https://bets.example.com",
    });
    const routes = registerStreamingBettingRoutes(options);

    const rejected = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
        origin: "https://other.example.com",
      },
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: {
        authorization: "Bearer bet-secret",
        origin: "https://bets.example.com",
      },
    });
    expect(accepted.statusCode).toBe(200);
    routes.close();
    await options.fastify.close();
  });

  it("rotates betting feed tokens without restarting or extending retired access", async () => {
    let authNowMs = 1_000;
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "old-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "");
    const options = createRouteOptions({
      getAuthNowMs: () => authNowMs,
    });
    const routes = registerStreamingBettingRoutes(options);
    const requestWith = (token: string) =>
      options.fastify.inject({
        method: "GET",
        url: "/api/internal/bet-sync/state",
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await requestWith("old-secret")).statusCode).toBe(200);
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "new-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "old-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "2000");
    expect((await requestWith("new-secret")).statusCode).toBe(200);
    expect((await requestWith("old-secret")).statusCode).toBe(200);
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "");
    expect((await requestWith("new-secret")).statusCode).toBe(503);
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "2000");
    authNowMs = 2_000;
    expect((await requestWith("old-secret")).statusCode).toBe(401);
    expect((await requestWith("new-secret")).statusCode).toBe(200);
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "");
    expect((await requestWith("old-secret")).statusCode).toBe(401);
    routes.close();
    await options.fastify.close();
  });

  it("revokes an expired previous-token SSE connection while preserving current-token access", async () => {
    const authClockStartedAt = Date.now();
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "new-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "old-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "2000");
    const options = createRouteOptions({
      maxClients: 2,
      pushIntervalMs: 60_000,
      heartbeatMs: 60_000,
      getAuthNowMs: () => 1_000 + (Date.now() - authClockStartedAt),
    });
    const routes = registerStreamingBettingRoutes(options);
    const baseUrl = await options.fastify.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const eventsUrl = `${baseUrl}/api/internal/bet-sync/events`;

    const previousResponse = await fetch(eventsUrl, {
      headers: { authorization: "Bearer old-secret" },
    });
    expect(previousResponse.status).toBe(200);
    const previousDelivery = await readSseEvents(previousResponse, 1);
    expect(routes.getMetrics().clients.connected).toBe(1);

    await waitForCondition(() => routes.getMetrics().clients.connected === 0);
    await previousDelivery.reader.cancel("previous token expired");

    const currentResponse = await fetch(eventsUrl, {
      headers: { authorization: "Bearer new-secret" },
    });
    expect(currentResponse.status).toBe(200);
    const currentDelivery = await readSseEvents(currentResponse, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routes.getMetrics().clients.connected).toBe(1);
    await currentDelivery.reader.cancel("current token verified");
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);

    routes.close();
    await options.fastify.close();
  });

  it("revokes a previous-token SSE connection immediately when rotation settings are retired", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "new-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "old-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "5000");
    const options = createRouteOptions({
      maxClients: 2,
      pushIntervalMs: 60_000,
      heartbeatMs: 60_000,
      getAuthNowMs: () => 1_000,
    });
    const routes = registerStreamingBettingRoutes(options);
    const baseUrl = await options.fastify.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const previousResponse = await fetch(
      `${baseUrl}/api/internal/bet-sync/events`,
      { headers: { authorization: "Bearer old-secret" } },
    );
    const previousDelivery = await readSseEvents(previousResponse, 1);
    expect(routes.getMetrics().clients.connected).toBe(1);

    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "");
    const currentBootstrap = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/state",
      headers: { authorization: "Bearer new-secret" },
    });
    expect(currentBootstrap.statusCode).toBe(200);
    await waitForCondition(() => routes.getMetrics().clients.connected === 0);
    await previousDelivery.reader.cancel("previous token retired");

    routes.close();
    await options.fastify.close();
  });

  it("refuses to register with an invalid previous-token rotation", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "new-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS", "old-secret");
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS", "");
    const options = createRouteOptions();

    expect(() => registerStreamingBettingRoutes(options)).toThrow(
      "previous_token_requires_expiry",
    );
    await options.fastify.close();
  });

  it("prefers Last-Event-Id over the initial since query parameter", () => {
    const request = {
      headers: {
        "last-event-id": "55",
      },
      query: {
        since: "12",
      },
    } as never;

    expect(parseReplayCursor(request)).toBe(55);
  });

  it("rejects query-token auth on the events route", async () => {
    vi.stubEnv("BETTING_FEED_ACCESS_TOKEN", "bet-secret");

    const options = createRouteOptions();
    const routes = registerStreamingBettingRoutes(options);

    const response = await options.fastify.inject({
      method: "GET",
      url: "/api/internal/bet-sync/events?streamToken=bet-secret",
    });

    expect(response.statusCode).toBe(401);
    routes.close();
    await options.fastify.close();
  });

  it("allocates betting client ids without colliding after wraparound", () => {
    const allocation = allocateNextBettingClientId(
      Number.MAX_SAFE_INTEGER - 1,
      [1],
    );

    expect(allocation).toEqual({
      clientId: Number.MAX_SAFE_INTEGER - 1,
      nextCursor: 1,
    });

    const wrapped = allocateNextBettingClientId(allocation.nextCursor, [1, 2]);
    expect(wrapped).toEqual({
      clientId: 3,
      nextCursor: 4,
    });
  });
});
