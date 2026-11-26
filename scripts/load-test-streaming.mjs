#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Agent, setGlobalDispatcher } from "undici";
import {
  buildStreamingSoakChecks,
  StreamingSoakIntegrityTracker,
} from "./streaming-soak-integrity.mjs";
import {
  buildStreamingTelemetryChecks,
  classifySseSequence,
  deriveSseDeliveryOverheadMs,
  StreamingSoakTelemetryCollector,
} from "./streaming-soak-telemetry.mjs";

const parsed = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "server-url": { type: "string", default: "http://localhost:5555" },
    "betting-url": { type: "string", default: "http://localhost:4179" },
    "hls-url": { type: "string" },
    "duration-s": { type: "string", default: "120" },
    "warmup-timeout-ms": { type: "string", default: "120000" },
    "request-timeout-ms": { type: "string", default: "5000" },
    "connect-timeout-ms": { type: "string", default: "10000" },
    "stats-interval-ms": { type: "string", default: "10000" },
    "metrics-poll-ms": { type: "string", default: "5000" },
    "telemetry-snapshot-ms": { type: "string", default: "60000" },
    "require-server-telemetry": { type: "boolean" },
    "require-renderer-telemetry": { type: "boolean" },
    "require-resource-telemetry": { type: "boolean" },
    "require-resource-ecology-telemetry": { type: "boolean" },
    "json-output": { type: "string" },
    "max-http-connections": { type: "string", default: "20000" },
    "sse-clients": { type: "string", default: "250" },
    "sse-ramp-ms": { type: "string", default: "3" },
    "sse-reconnect-delay-ms": { type: "string", default: "500" },
    "hls-clients": { type: "string", default: "80" },
    "hls-poll-ms": { type: "string", default: "2000" },
    "state-pollers": { type: "string", default: "10" },
    "state-poll-ms": { type: "string", default: "1000" },
    "duel-context-pollers": { type: "string", default: "3" },
    "duel-context-poll-ms": { type: "string", default: "10000" },
    "integrity-poll-ms": { type: "string", default: "1000" },
    "min-resolved-duels": { type: "string", default: "0" },
    "max-cancelled-duels": { type: "string" },
    "require-full-phase-coverage": { type: "boolean" },
    "min-sse-open-ratio": { type: "string", default: "0.95" },
    "min-sse-peak-ratio": { type: "string", default: "0.95" },
    "max-sse-p95-lag-ms": { type: "string", default: "2500" },
    "max-hls-failure-rate": { type: "string", default: "0.05" },
    "max-api-failure-rate": { type: "string", default: "0.02" },
    "allow-fail": { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: true,
}).values;

if (parsed.help) {
  console.log(`
Streaming capacity/load test harness.

Usage:
  bun scripts/load-test-streaming.mjs [options]

Core options:
  --server-url <url>              Game server base URL (default: http://localhost:5555)
  --betting-url <url>             Betting app base URL (default: http://localhost:4179)
  --hls-url <url>                 HLS playlist URL (default: <server-url>/live/stream.m3u8)
  --duration-s <seconds>          Test duration (default: 120)
  --max-http-connections <n>      Global HTTP connection pool size (default: 20000)
  --sse-clients <n>               Concurrent SSE viewers (default: 250)
  --hls-clients <n>               HLS watcher loops (default: 80)
  --state-pollers <n>             /api/streaming/state pollers (default: 10)
  --duel-context-pollers <n>      /api/streaming/duel-context pollers (default: 3)
  --integrity-poll-ms <ms>        Lifecycle-integrity sampling interval (default: 1000)
  --max-sse-p95-lag-ms <ms>      Maximum transport overhead beyond the configured public delay
  --min-resolved-duels <n>        Require at least n authoritative resolutions (default: 0)
  --max-cancelled-duels <n>       Fail above this many observed cancellations (unset by default)
  --require-full-phase-coverage   Require every observed resolution to include all four phases
  --telemetry-snapshot-ms <ms>    Retain tick/frame snapshots at this interval (default: 60000)
  --require-server-telemetry      Require authenticated tick/memory samples with zero poll failures
  --require-renderer-telemetry    Require renderer frame samples with zero poll failures
  --require-resource-telemetry    Require aggregate asset/network timing with at least one entry
  --require-resource-ecology-telemetry
                                 Require internally consistent server resource ecology samples
                                 Server telemetry reads STREAMING_LOAD_ADMIN_CODE or ADMIN_CODE
  --json-output <path>            Atomically write the complete JSON evidence artifact
  --allow-fail                    Always exit 0 and print failed checks
  -v, --verbose                   Verbose error output

Examples:
  bun scripts/load-test-streaming.mjs
  bun scripts/load-test-streaming.mjs --duration-s=180 --sse-clients=2000 --hls-clients=500
`);
  process.exit(0);
}

const serverUrl = parsed["server-url"].replace(/\/$/, "");
const bettingUrl = parsed["betting-url"].replace(/\/$/, "");
const hlsUrl = parsed["hls-url"]?.trim() || `${serverUrl}/live/stream.m3u8`;

const durationMs = Math.max(
  10_000,
  Number.parseInt(parsed["duration-s"], 10) * 1_000 || 120_000,
);
const warmupTimeoutMs = Math.max(
  10_000,
  Number.parseInt(parsed["warmup-timeout-ms"], 10) || 120_000,
);
const requestTimeoutMs = Math.max(
  1_000,
  Number.parseInt(parsed["request-timeout-ms"], 10) || 5_000,
);
const connectTimeoutMs = Math.max(
  2_000,
  Number.parseInt(parsed["connect-timeout-ms"], 10) || 10_000,
);
const statsIntervalMs = Math.max(
  2_000,
  Number.parseInt(parsed["stats-interval-ms"], 10) || 10_000,
);
const metricsPollMs = Math.max(
  1_000,
  Number.parseInt(parsed["metrics-poll-ms"], 10) || 5_000,
);
const telemetrySnapshotMs = Math.max(
  1_000,
  Number.parseInt(parsed["telemetry-snapshot-ms"], 10) || 60_000,
);
const maxHttpConnections = Math.max(
  512,
  Number.parseInt(parsed["max-http-connections"], 10) || 20_000,
);

setGlobalDispatcher(
  new Agent({
    connections: maxHttpConnections,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
  }),
);

const sseClients = Math.max(0, Number.parseInt(parsed["sse-clients"], 10) || 0);
const sseRampMs = Math.max(0, Number.parseInt(parsed["sse-ramp-ms"], 10) || 0);
const sseReconnectDelayMs = Math.max(
  50,
  Number.parseInt(parsed["sse-reconnect-delay-ms"], 10) || 500,
);
const hlsClients = Math.max(0, Number.parseInt(parsed["hls-clients"], 10) || 0);
const hlsPollMs = Math.max(
  250,
  Number.parseInt(parsed["hls-poll-ms"], 10) || 2_000,
);
const statePollers = Math.max(
  0,
  Number.parseInt(parsed["state-pollers"], 10) || 0,
);
const statePollMs = Math.max(
  250,
  Number.parseInt(parsed["state-poll-ms"], 10) || 1_000,
);
const duelContextPollers = Math.max(
  0,
  Number.parseInt(parsed["duel-context-pollers"], 10) || 0,
);
const duelContextPollMs = Math.max(
  1_000,
  Number.parseInt(parsed["duel-context-poll-ms"], 10) || 10_000,
);
const integrityPollMs = Math.max(
  250,
  Number.parseInt(parsed["integrity-poll-ms"], 10) || 1_000,
);
const minResolvedDuels = Math.max(
  0,
  Number.parseInt(parsed["min-resolved-duels"], 10) || 0,
);
const parsedMaxCancelledDuels = Number.parseInt(
  parsed["max-cancelled-duels"] ?? "",
  10,
);
const maxCancelledDuels = Number.isSafeInteger(parsedMaxCancelledDuels)
  ? Math.max(0, parsedMaxCancelledDuels)
  : null;
const requireFullPhaseCoverage = parsed["require-full-phase-coverage"] === true;
const requireServerTelemetry = parsed["require-server-telemetry"] === true;
const requireRendererTelemetry = parsed["require-renderer-telemetry"] === true;
const requireResourceTelemetry = parsed["require-resource-telemetry"] === true;
const requireResourceEcologyTelemetry =
  parsed["require-resource-ecology-telemetry"] === true;
const jsonOutputPath = String(parsed["json-output"] || "").trim();
const streamingLoadAdminCode = String(
  process.env.STREAMING_LOAD_ADMIN_CODE || process.env.ADMIN_CODE || "",
).trim();

const minSseOpenRatio = Number.parseFloat(parsed["min-sse-open-ratio"]) || 0.95;
const minSsePeakRatio = Number.parseFloat(parsed["min-sse-peak-ratio"]) || 0.95;
const maxSseP95LagMs = Number.parseFloat(parsed["max-sse-p95-lag-ms"]) || 2500;
const maxHlsFailureRate =
  Number.parseFloat(parsed["max-hls-failure-rate"]) || 0.05;
const maxApiFailureRate =
  Number.parseFloat(parsed["max-api-failure-rate"]) || 0.02;
const allowFail = parsed["allow-fail"] === true;
const verbose = parsed.verbose === true;

const sseUrl = `${serverUrl}/api/streaming/state/events`;
const stateUrl = `${serverUrl}/api/streaming/state`;
const duelContextUrl = `${serverUrl}/api/streaming/duel-context`;
const healthUrl = `${serverUrl}/health`;
const streamingMetricsUrl = `${serverUrl}/api/streaming/metrics`;
const streamingHealthUrl = `${serverUrl}/api/streaming/health`;
const serverTelemetryUrl = `${serverUrl}/admin/memory/report`;

const loadStartedAt = Date.now();
let stopRequested = false;
let runUntilMs = Date.now() + durationMs;
let latestServerMetrics = null;

class ReservoirStats {
  constructor(size = 50_000) {
    this.size = size;
    this.samples = [];
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = 0;
  }

  add(value) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);

    if (this.samples.length < this.size) {
      this.samples.push(value);
      return;
    }

    const idx = Math.floor(Math.random() * this.count);
    if (idx < this.size) {
      this.samples[idx] = value;
    }
  }

  summary() {
    if (this.count === 0) {
      return {
        count: 0,
        avg: null,
        min: null,
        p50: null,
        p95: null,
        p99: null,
        max: null,
      };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const q = (quantile) => {
      if (sorted.length === 0) return null;
      const rawIndex = Math.floor((sorted.length - 1) * quantile);
      return sorted[Math.min(sorted.length - 1, Math.max(0, rawIndex))];
    };

    return {
      count: this.count,
      avg: this.sum / this.count,
      min: this.min,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      max: this.max,
    };
  }
}

const stats = {
  sse: {
    targetClients: sseClients,
    opened: 0,
    connectedNow: 0,
    peakConnected: 0,
    closed: 0,
    connectFailures: 0,
    reconnects: 0,
    stateEvents: 0,
    resetEvents: 0,
    unavailableEvents: 0,
    heartbeatComments: 0,
    parseErrors: 0,
    gapEvents: 0,
    duplicateEvents: 0,
    outOfOrderEvents: 0,
    rxBytes: 0,
    fatalClientErrors: 0,
    lagMs: new ReservoirStats(50_000),
  },
  hls: {
    targetClients: hlsClients,
    manifestRequests: 0,
    manifestFailures: 0,
    manifestBytes: 0,
    segmentRequests: 0,
    segmentFailures: 0,
    segmentBytes: 0,
    fatalPollerErrors: 0,
    manifestLatencyMs: new ReservoirStats(20_000),
    segmentLatencyMs: new ReservoirStats(20_000),
  },
  api: {
    state: {
      pollers: statePollers,
      requests: 0,
      failures: 0,
      latencyMs: new ReservoirStats(20_000),
      fatalErrors: 0,
    },
    duelContext: {
      pollers: duelContextPollers,
      requests: 0,
      failures: 0,
      latencyMs: new ReservoirStats(20_000),
      fatalErrors: 0,
    },
  },
};
const duelIntegrity = new StreamingSoakIntegrityTracker();
const runtimeTelemetry = new StreamingSoakTelemetryCollector({
  retentionIntervalMs: telemetrySnapshotMs,
});

function log(message) {
  console.log(`[stream-load] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPercent(numerator, denominator) {
  if (!denominator) return "0.00%";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

async function writeJsonEvidence(result) {
  if (!jsonOutputPath) return null;
  const destination = path.resolve(jsonOutputPath);
  const temporary = `${destination}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    destination,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

function isAbortLikeError(error) {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("abort") ||
    normalized.includes("terminated") ||
    normalized.includes("cancelled")
  );
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        log(`ready: ${label}`);
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }

  throw new Error(
    `timeout waiting for ${label}${
      lastError
        ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})`
        : ""
    }`,
  );
}

async function warmup() {
  log("warming up endpoints...");

  await waitFor(
    "server health",
    async () => {
      const res = await fetchWithTimeout(healthUrl, requestTimeoutMs, {
        cache: "no-store",
      });
      return res.ok;
    },
    warmupTimeoutMs,
  );

  await waitFor(
    "streaming state",
    async () => {
      const res = await fetchWithTimeout(stateUrl, requestTimeoutMs, {
        cache: "no-store",
      });
      return res.ok;
    },
    warmupTimeoutMs,
  );

  if (hlsClients > 0) {
    await waitFor(
      "hls playlist",
      async () => {
        const res = await fetchWithTimeout(hlsUrl, requestTimeoutMs, {
          cache: "no-store",
        });
        if (!res.ok) return false;
        const text = await res.text();
        return text.includes("#EXTM3U");
      },
      warmupTimeoutMs,
    );
  }
}

function extractSegmentRefs(playlistText) {
  const lines = playlistText.split(/\r?\n/);
  const segments = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith("#")) continue;
    if (
      line.includes(".ts") ||
      line.includes(".m4s") ||
      line.includes(".mp4")
    ) {
      segments.push(line);
    }
  }
  return segments.reverse();
}

async function runSseClient(clientId, globalAbortController) {
  const decoder = new TextDecoder();
  let lastSeq = 0;

  while (!stopRequested && Date.now() < runUntilMs) {
    let isConnectedThisCycle = false;
    const connectionAbortController = new AbortController();
    const abortListener = () => connectionAbortController.abort();
    globalAbortController.signal.addEventListener("abort", abortListener, {
      once: true,
    });

    try {
      const url = new URL(sseUrl);
      if (lastSeq > 0) {
        url.searchParams.set("since", String(lastSeq));
      }

      const response = await fetchWithTimeout(
        url.toString(),
        connectTimeoutMs,
        {
          headers: {
            Accept: "text/event-stream",
            "Cache-Control": "no-store",
          },
          signal: connectionAbortController.signal,
        },
      );

      if (!response.ok || !response.body) {
        stats.sse.connectFailures += 1;
        await sleep(sseReconnectDelayMs);
        continue;
      }

      stats.sse.opened += 1;
      stats.sse.connectedNow += 1;
      isConnectedThisCycle = true;
      stats.sse.peakConnected = Math.max(
        stats.sse.peakConnected,
        stats.sse.connectedNow,
      );

      const reader = response.body.getReader();
      let buffer = "";
      let eventName = "message";
      let eventId = "";
      let dataLines = [];

      const consumeEvent = () => {
        const payload = dataLines.join("\n");
        const numericEventId = Number.parseInt(eventId, 10);
        const seqFromId = Number.isFinite(numericEventId)
          ? numericEventId
          : null;

        if (eventName === "state") {
          stats.sse.stateEvents += 1;
        } else if (eventName === "reset") {
          stats.sse.resetEvents += 1;
        } else if (eventName === "unavailable") {
          stats.sse.unavailableEvents += 1;
        }

        if (
          eventName === "state" ||
          eventName === "reset" ||
          eventName === "unavailable"
        ) {
          if (payload) {
            try {
              const parsed = JSON.parse(payload);
              const seq =
                typeof parsed?.seq === "number" && Number.isFinite(parsed.seq)
                  ? parsed.seq
                  : seqFromId;
              if (typeof seq === "number") {
                const sequence = classifySseSequence(lastSeq, seq);
                stats.sse.gapEvents += sequence.gapEvents;
                stats.sse.duplicateEvents += sequence.duplicateEvents;
                stats.sse.outOfOrderEvents += sequence.outOfOrderEvents;
                lastSeq = sequence.nextSeq;
              }

              if (
                typeof parsed?.emittedAt === "number" &&
                Number.isFinite(parsed.emittedAt)
              ) {
                stats.sse.lagMs.add(Date.now() - parsed.emittedAt);
              }
            } catch {
              stats.sse.parseErrors += 1;
            }
          }
        }

        eventName = "message";
        eventId = "";
        dataLines = [];
      };

      while (!stopRequested) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        stats.sse.rxBytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });

        let lineBreakIndex = buffer.indexOf("\n");
        while (lineBreakIndex >= 0) {
          const rawLine = buffer.slice(0, lineBreakIndex);
          buffer = buffer.slice(lineBreakIndex + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line === "") {
            consumeEvent();
          } else if (line.startsWith(":")) {
            stats.sse.heartbeatComments += 1;
          } else if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim() || "message";
          } else if (line.startsWith("id:")) {
            eventId = line.slice("id:".length).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
          }

          lineBreakIndex = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (!(stopRequested && isAbortLikeError(error))) {
        stats.sse.connectFailures += 1;
      }
      if (!stopRequested && verbose) {
        log(
          `sse client ${clientId} error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      globalAbortController.signal.removeEventListener("abort", abortListener);
      if (isConnectedThisCycle) {
        stats.sse.connectedNow -= 1;
        stats.sse.closed += 1;
      }
    }

    if (!stopRequested && Date.now() < runUntilMs) {
      stats.sse.reconnects += 1;
      await sleep(sseReconnectDelayMs);
    }
  }
}

async function runHlsWatcher(globalAbortController) {
  let lastSegment = null;

  while (!stopRequested && Date.now() < runUntilMs) {
    try {
      const manifestStart = Date.now();
      const manifestResponse = await fetchWithTimeout(
        hlsUrl,
        requestTimeoutMs,
        {
          cache: "no-store",
          signal: globalAbortController.signal,
        },
      );

      stats.hls.manifestRequests += 1;
      if (!manifestResponse.ok) {
        stats.hls.manifestFailures += 1;
      } else {
        const manifestText = await manifestResponse.text();
        stats.hls.manifestBytes += manifestText.length;
        stats.hls.manifestLatencyMs.add(Date.now() - manifestStart);

        const segmentRefs = extractSegmentRefs(manifestText);
        const preferredSegmentRefs = [
          segmentRefs.length >= 2 ? segmentRefs[segmentRefs.length - 2] : null,
          segmentRefs.length >= 3 ? segmentRefs[segmentRefs.length - 3] : null,
          segmentRefs.length >= 1 ? segmentRefs[segmentRefs.length - 1] : null,
        ];
        const segmentCandidates = [];
        for (const ref of preferredSegmentRefs) {
          if (!ref || ref === lastSegment || segmentCandidates.includes(ref)) {
            continue;
          }
          segmentCandidates.push(ref);
        }

        if (segmentCandidates.length > 0) {
          const segmentStart = Date.now();
          stats.hls.segmentRequests += 1;
          let segmentSucceeded = false;
          const retryDelayMs = [50, 150, 350];

          for (const candidatePath of segmentCandidates) {
            const segmentUrl = new URL(candidatePath, hlsUrl).toString();

            for (
              let attempt = 0;
              attempt < retryDelayMs.length + 1;
              attempt += 1
            ) {
              try {
                const segmentResponse = await fetchWithTimeout(
                  segmentUrl,
                  requestTimeoutMs,
                  {
                    cache: "no-store",
                    signal: globalAbortController.signal,
                  },
                );

                if (!segmentResponse.ok) {
                  // Some misses are transient during playlist rollover.
                  if (attempt < retryDelayMs.length) {
                    await sleep(retryDelayMs[attempt]);
                  }
                  continue;
                }

                const payload = await segmentResponse.arrayBuffer();
                if (payload.byteLength > 0) {
                  segmentSucceeded = true;
                  lastSegment = candidatePath;
                  stats.hls.segmentBytes += payload.byteLength;
                  stats.hls.segmentLatencyMs.add(Date.now() - segmentStart);
                  break;
                }
              } catch (error) {
                if (
                  attempt < retryDelayMs.length &&
                  !(stopRequested && isAbortLikeError(error))
                ) {
                  await sleep(retryDelayMs[attempt]);
                }
              }
            }

            if (segmentSucceeded) break;
          }

          if (!segmentSucceeded && !stopRequested) {
            stats.hls.segmentFailures += 1;
          }
        }
      }
    } catch (error) {
      if (!stopRequested && verbose) {
        log(
          `hls watcher error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!(stopRequested && isAbortLikeError(error))) {
        stats.hls.manifestRequests += 1;
        stats.hls.manifestFailures += 1;
      }
    }

    await sleep(hlsPollMs);
  }
}

async function runApiPollers(
  label,
  url,
  pollIntervalMs,
  pollerCount,
  bucket,
  globalAbortController,
) {
  const tasks = [];
  for (let i = 0; i < pollerCount; i += 1) {
    tasks.push(
      (async () => {
        while (!stopRequested && Date.now() < runUntilMs) {
          const startedAt = Date.now();
          try {
            const response = await fetchWithTimeout(url, requestTimeoutMs, {
              cache: "no-store",
              signal: globalAbortController.signal,
            });
            bucket.requests += 1;
            if (!response.ok) {
              bucket.failures += 1;
            } else {
              await response.arrayBuffer();
              bucket.latencyMs.add(Date.now() - startedAt);
            }
          } catch (error) {
            if (!(stopRequested && isAbortLikeError(error))) {
              bucket.requests += 1;
              bucket.failures += 1;
            }
            if (verbose && !stopRequested) {
              log(
                `${label} poller error: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          await sleep(pollIntervalMs);
        }
      })().catch(() => {
        bucket.fatalErrors += 1;
      }),
    );
  }
  return tasks;
}

async function runServerMetricsPoller(globalAbortController) {
  while (!stopRequested && Date.now() < runUntilMs) {
    const observedAt = Date.now();
    const requests = [
      fetchWithTimeout(streamingMetricsUrl, requestTimeoutMs, {
        cache: "no-store",
        signal: globalAbortController.signal,
      }),
      fetchWithTimeout(streamingHealthUrl, requestTimeoutMs, {
        cache: "no-store",
        signal: globalAbortController.signal,
      }),
    ];
    if (streamingLoadAdminCode) {
      requests.push(
        fetchWithTimeout(serverTelemetryUrl, requestTimeoutMs, {
          cache: "no-store",
          headers: { "x-admin-code": streamingLoadAdminCode },
          signal: globalAbortController.signal,
        }),
      );
    }

    const [metricsResult, rendererResult, serverResult] =
      await Promise.allSettled(requests);
    if (metricsResult.status === "fulfilled" && metricsResult.value.ok) {
      latestServerMetrics = await metricsResult.value.json().catch(() => null);
    }

    if (rendererResult.status === "fulfilled") {
      const payload = await rendererResult.value.json().catch(() => null);
      runtimeTelemetry.observeRenderer(payload, observedAt);
    } else {
      runtimeTelemetry.recordRendererFailure();
    }

    if (streamingLoadAdminCode) {
      if (serverResult?.status === "fulfilled" && serverResult.value.ok) {
        const payload = await serverResult.value.json().catch(() => null);
        runtimeTelemetry.observeServer(payload, observedAt);
      } else {
        runtimeTelemetry.recordServerFailure();
      }
    }
    await sleep(metricsPollMs);
  }
}

async function runDuelIntegrityPoller(globalAbortController) {
  while (!stopRequested && Date.now() < runUntilMs) {
    try {
      const response = await fetchWithTimeout(stateUrl, requestTimeoutMs, {
        cache: "no-store",
        signal: globalAbortController.signal,
      });
      if (response.ok) {
        duelIntegrity.observe(await response.json());
      }
    } catch (error) {
      if (verbose && !stopRequested && !isAbortLikeError(error)) {
        log(
          `integrity poller error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await sleep(integrityPollMs);
  }
}

function printPeriodicStats() {
  const elapsedSeconds = Math.max(
    1,
    Math.floor((Date.now() - loadStartedAt) / 1_000),
  );
  const sseRate = (stats.sse.stateEvents / elapsedSeconds).toFixed(1);
  const manifestFailureRate = formatPercent(
    stats.hls.manifestFailures,
    stats.hls.manifestRequests,
  );
  const segmentFailureRate = formatPercent(
    stats.hls.segmentFailures,
    stats.hls.segmentRequests,
  );

  log(
    [
      `elapsed=${elapsedSeconds}s`,
      `sse=${stats.sse.connectedNow}/${stats.sse.targetClients} peak=${stats.sse.peakConnected}`,
      `events=${stats.sse.stateEvents} rate=${sseRate}/s`,
      `gaps=${stats.sse.gapEvents} reconnects=${stats.sse.reconnects}`,
      `hls-manifest=${stats.hls.manifestRequests} fail=${manifestFailureRate}`,
      `hls-segment=${stats.hls.segmentRequests} fail=${segmentFailureRate}`,
      `api-state=${stats.api.state.requests} api-duel=${stats.api.duelContext.requests}`,
    ].join(" | "),
  );
}

function summarize() {
  const elapsedMs = Date.now() - loadStartedAt;
  const elapsedSeconds = elapsedMs / 1_000;

  const sseLag = stats.sse.lagMs.summary();
  const configuredPublicDelayMs = Number.isFinite(
    latestServerMetrics?.sse?.config?.publicDelayMs,
  )
    ? Math.max(0, latestServerMetrics.sse.config.publicDelayMs)
    : 0;
  const sseDeliveryOverheadP95Ms = deriveSseDeliveryOverheadMs(
    sseLag.p95,
    configuredPublicDelayMs,
  );
  const manifestLatency = stats.hls.manifestLatencyMs.summary();
  const segmentLatency = stats.hls.segmentLatencyMs.summary();
  const stateLatency = stats.api.state.latencyMs.summary();
  const duelLatency = stats.api.duelContext.latencyMs.summary();
  const duelIntegritySummary = duelIntegrity.summary();
  const runtimeTelemetrySummary = runtimeTelemetry.summary({
    serverConfigured: streamingLoadAdminCode.length > 0,
  });

  const sseOpenRatio = sseClients > 0 ? stats.sse.opened / sseClients : 1;
  const ssePeakOpenedRatio =
    stats.sse.opened > 0 ? stats.sse.peakConnected / stats.sse.opened : 1;
  const likelySingleProcessConnectionCap =
    sseClients > stats.sse.opened &&
    stats.sse.connectFailures === 0 &&
    stats.sse.opened >= 200;
  const hlsManifestFailureRate =
    stats.hls.manifestRequests > 0
      ? stats.hls.manifestFailures / stats.hls.manifestRequests
      : 0;
  const hlsSegmentFailureRate =
    stats.hls.segmentRequests > 0
      ? stats.hls.segmentFailures / stats.hls.segmentRequests
      : 0;
  const stateFailureRate =
    stats.api.state.requests > 0
      ? stats.api.state.failures / stats.api.state.requests
      : 0;
  const duelFailureRate =
    stats.api.duelContext.requests > 0
      ? stats.api.duelContext.failures / stats.api.duelContext.requests
      : 0;
  const warnings = [];
  if (likelySingleProcessConnectionCap) {
    warnings.push(
      "SSE opened below requested target with zero connect failures; use burst mode for >250 concurrent clients in this runtime.",
    );
  }

  const checks = [
    {
      label: `SSE opened ratio >= ${minSseOpenRatio}`,
      pass: sseOpenRatio >= minSseOpenRatio || likelySingleProcessConnectionCap,
      actual: Number(sseOpenRatio.toFixed(4)),
    },
    {
      label: `SSE peak/opened ratio >= ${minSsePeakRatio}`,
      pass: ssePeakOpenedRatio >= minSsePeakRatio,
      actual: Number(ssePeakOpenedRatio.toFixed(4)),
    },
    {
      label: `SSE parse errors == 0`,
      pass: stats.sse.parseErrors === 0,
      actual: stats.sse.parseErrors,
    },
    {
      label: `SSE connect failures == 0`,
      pass: stats.sse.connectFailures === 0,
      actual: stats.sse.connectFailures,
    },
    {
      label: `SSE reconnects == 0`,
      pass: stats.sse.reconnects === 0,
      actual: stats.sse.reconnects,
    },
    {
      label: `SSE reset and unavailable events == 0`,
      pass: stats.sse.resetEvents === 0 && stats.sse.unavailableEvents === 0,
      actual: {
        resets: stats.sse.resetEvents,
        unavailable: stats.sse.unavailableEvents,
      },
    },
    {
      label: `SSE sequence gaps == 0`,
      pass: stats.sse.gapEvents === 0,
      actual: stats.sse.gapEvents,
    },
    {
      label: `SSE duplicate sequences == 0`,
      pass: stats.sse.duplicateEvents === 0,
      actual: stats.sse.duplicateEvents,
    },
    {
      label: `SSE out-of-order sequences == 0`,
      pass: stats.sse.outOfOrderEvents === 0,
      actual: stats.sse.outOfOrderEvents,
    },
    {
      label: `SSE fatal client errors == 0`,
      pass: stats.sse.fatalClientErrors === 0,
      actual: stats.sse.fatalClientErrors,
    },
    {
      label: `SSE p95 delivery overhead beyond configured public delay <= ${maxSseP95LagMs}ms`,
      pass:
        sseDeliveryOverheadP95Ms == null
          ? true
          : sseDeliveryOverheadP95Ms <= maxSseP95LagMs,
      actual: sseDeliveryOverheadP95Ms,
    },
    {
      label: `HLS manifest failure rate <= ${maxHlsFailureRate}`,
      pass: hlsManifestFailureRate <= maxHlsFailureRate,
      actual: Number(hlsManifestFailureRate.toFixed(4)),
    },
    {
      label: `HLS segment failure rate <= ${maxHlsFailureRate}`,
      pass: hlsSegmentFailureRate <= maxHlsFailureRate,
      actual: Number(hlsSegmentFailureRate.toFixed(4)),
    },
    {
      label: `HLS fatal poller errors == 0`,
      pass: stats.hls.fatalPollerErrors === 0,
      actual: stats.hls.fatalPollerErrors,
    },
    {
      label: `API state failure rate <= ${maxApiFailureRate}`,
      pass: stateFailureRate <= maxApiFailureRate,
      actual: Number(stateFailureRate.toFixed(4)),
    },
    {
      label: `API duel-context failure rate <= ${maxApiFailureRate}`,
      pass: duelFailureRate <= maxApiFailureRate,
      actual: Number(duelFailureRate.toFixed(4)),
    },
    {
      label: `API fatal poller errors == 0`,
      pass:
        stats.api.state.fatalErrors === 0 &&
        stats.api.duelContext.fatalErrors === 0,
      actual: {
        state: stats.api.state.fatalErrors,
        duelContext: stats.api.duelContext.fatalErrors,
      },
    },
    ...buildStreamingSoakChecks(duelIntegritySummary, {
      minResolvedDuels,
      maxCancelledDuels,
      requireFullPhaseCoverage,
    }),
    ...buildStreamingTelemetryChecks(runtimeTelemetrySummary, {
      requireServerTelemetry,
      requireRendererTelemetry,
      requireResourceTelemetry,
      requireResourceEcologyTelemetry,
    }),
  ];

  const ok = checks.every((check) => check.pass);

  return {
    ok,
    startedAt: new Date(loadStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    elapsedSeconds,
    targetLoad: {
      sseClients,
      hlsClients,
      statePollers,
      duelContextPollers,
      hlsPollMs,
      statePollMs,
      duelContextPollMs,
      integrityPollMs,
      minResolvedDuels,
      maxCancelledDuels,
      requireFullPhaseCoverage,
      metricsPollMs,
      telemetrySnapshotMs,
      requireServerTelemetry,
      requireRendererTelemetry,
      requireResourceTelemetry,
      requireResourceEcologyTelemetry,
    },
    sse: {
      opened: stats.sse.opened,
      openedRatio: sseOpenRatio,
      peakConnected: stats.sse.peakConnected,
      peakOpenedRatio: ssePeakOpenedRatio,
      connectedNow: stats.sse.connectedNow,
      closed: stats.sse.closed,
      connectFailures: stats.sse.connectFailures,
      reconnects: stats.sse.reconnects,
      stateEvents: stats.sse.stateEvents,
      stateEventsPerSecond:
        elapsedSeconds > 0 ? stats.sse.stateEvents / elapsedSeconds : 0,
      resetEvents: stats.sse.resetEvents,
      unavailableEvents: stats.sse.unavailableEvents,
      heartbeatComments: stats.sse.heartbeatComments,
      parseErrors: stats.sse.parseErrors,
      gapEvents: stats.sse.gapEvents,
      duplicateEvents: stats.sse.duplicateEvents,
      outOfOrderEvents: stats.sse.outOfOrderEvents,
      rxBytes: stats.sse.rxBytes,
      likelySingleProcessConnectionCap,
      lagMs: sseLag,
      configuredPublicDelayMs,
      deliveryOverheadP95Ms: sseDeliveryOverheadP95Ms,
    },
    hls: {
      manifestRequests: stats.hls.manifestRequests,
      manifestFailures: stats.hls.manifestFailures,
      manifestFailureRate: hlsManifestFailureRate,
      manifestBytes: stats.hls.manifestBytes,
      manifestLatencyMs: manifestLatency,
      segmentRequests: stats.hls.segmentRequests,
      segmentFailures: stats.hls.segmentFailures,
      segmentFailureRate: hlsSegmentFailureRate,
      segmentBytes: stats.hls.segmentBytes,
      segmentLatencyMs: segmentLatency,
    },
    api: {
      state: {
        requests: stats.api.state.requests,
        failures: stats.api.state.failures,
        failureRate: stateFailureRate,
        latencyMs: stateLatency,
      },
      duelContext: {
        requests: stats.api.duelContext.requests,
        failures: stats.api.duelContext.failures,
        failureRate: duelFailureRate,
        latencyMs: duelLatency,
      },
    },
    duelIntegrity: duelIntegritySummary,
    runtimeTelemetry: runtimeTelemetrySummary,
    checks,
    warnings,
    serverMetricsSample: latestServerMetrics,
  };
}

async function main() {
  log("starting streaming load test");
  log(
    `targets: sse=${sseClients}, hls=${hlsClients}, state-pollers=${statePollers}, duel-context-pollers=${duelContextPollers}`,
  );

  await warmup();
  runUntilMs = Date.now() + durationMs;

  const globalAbortController = new AbortController();
  const tasks = [];

  tasks.push(
    runServerMetricsPoller(globalAbortController).catch(() => {
      // best-effort endpoint
    }),
  );
  tasks.push(
    runDuelIntegrityPoller(globalAbortController).catch(() => {
      duelIntegrity.recordIssue("integrity_poller_failed");
    }),
  );

  for (let i = 0; i < hlsClients; i += 1) {
    tasks.push(
      runHlsWatcher(globalAbortController).catch(() => {
        stats.hls.fatalPollerErrors += 1;
      }),
    );
  }

  tasks.push(
    ...(await runApiPollers(
      "state",
      stateUrl,
      statePollMs,
      statePollers,
      stats.api.state,
      globalAbortController,
    )),
  );
  tasks.push(
    ...(await runApiPollers(
      "duel-context",
      duelContextUrl,
      duelContextPollMs,
      duelContextPollers,
      stats.api.duelContext,
      globalAbortController,
    )),
  );

  for (let i = 0; i < sseClients; i += 1) {
    tasks.push(
      runSseClient(i + 1, globalAbortController).catch(() => {
        stats.sse.fatalClientErrors += 1;
      }),
    );
    if (sseRampMs > 0) {
      await sleep(sseRampMs);
    }
  }

  log(`load running for ${Math.round(durationMs / 1000)}s...`);
  const statsTimer = setInterval(printPeriodicStats, statsIntervalMs);
  await sleep(durationMs);

  stopRequested = true;
  globalAbortController.abort();
  clearInterval(statsTimer);
  await Promise.allSettled(tasks);

  const result = summarize();
  const evidence = await writeJsonEvidence(result);
  if (evidence) {
    log(
      `evidence written: ${evidence.destination} (sha256 ${evidence.sha256})`,
    );
  }
  log(`completed. overall result: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok && !allowFail) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `[stream-load] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
