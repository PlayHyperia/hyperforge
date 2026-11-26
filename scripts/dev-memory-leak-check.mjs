#!/usr/bin/env bun
/**
 * Dev Memory Leak Check
 *
 * Runs a dev command (default: `bun run dev`) and samples process-tree memory.
 * Writes NDJSON samples + a summary JSON report for leak analysis.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  classifyMemoryProcess,
  isSteadyStateMemorySample,
} from "./lib/memory-leak-analysis.mjs";

const ONE_MB_KB = 1024;

const { values, positionals } = parseArgs({
  options: {
    "interval-ms": { type: "string", default: "5000" },
    "duration-s": { type: "string", default: "0" },
    "warn-growth-mb": { type: "string", default: "250" },
    "server-port": { type: "string", default: "5555" },
    "out-dir": { type: "string" },
    "skip-streaming-metrics": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

function parsePositiveInt(rawValue, fallback, minValue = 1) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function formatStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function formatMbFromKb(kb) {
  return (kb / ONE_MB_KB).toFixed(1);
}

function safePsSnapshot() {
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
    });
    const rows = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const rssKb = Number.parseInt(match[3], 10);
      const command = match[4];
      rows.push({ pid, ppid, rssKb, command });
    }
    return rows;
  } catch (error) {
    console.warn(
      `[memcheck] Failed to collect process snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function collectProcessTree(rootPid, rows) {
  if (!rootPid) return [];

  const childrenByParent = new Map();
  for (const row of rows) {
    let list = childrenByParent.get(row.ppid);
    if (!list) {
      list = [];
      childrenByParent.set(row.ppid, list);
    }
    list.push(row.pid);
  }

  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid == null || seen.has(pid)) continue;
    seen.add(pid);
    const children = childrenByParent.get(pid);
    if (!children) continue;
    for (const childPid of children) {
      if (!seen.has(childPid)) queue.push(childPid);
    }
  }

  const tree = rows.filter((row) => seen.has(row.pid));
  tree.sort((a, b) => b.rssKb - a.rssKb);
  return tree;
}

function collectProcessTreePids(rootPid, rows) {
  if (!rootPid) return [];

  const childrenByParent = new Map();
  for (const row of rows) {
    let list = childrenByParent.get(row.ppid);
    if (!list) {
      list = [];
      childrenByParent.set(row.ppid, list);
    }
    list.push(row.pid);
  }

  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid == null || seen.has(pid)) continue;
    seen.add(pid);
    const children = childrenByParent.get(pid);
    if (!children) continue;
    for (const childPid of children) {
      if (!seen.has(childPid)) queue.push(childPid);
    }
  }

  return [...seen];
}

function signalProcessTree(rootPid, signal) {
  if (!rootPid) return 0;
  const rows = safePsSnapshot();
  const treePids = collectProcessTreePids(rootPid, rows).filter(
    (pid) => pid !== process.pid,
  );

  // Kill descendants first to minimize re-parenting races.
  treePids.sort((a, b) => b - a);
  for (const pid of treePids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or inaccessible.
    }
  }
  return treePids.length;
}

async function fetchJsonWithTimeout(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const intervalMs = parsePositiveInt(values["interval-ms"], 5000);
const durationSeconds = parsePositiveInt(values["duration-s"], 0, 0);
const durationMs = durationSeconds > 0 ? durationSeconds * 1000 : 0;
const warnGrowthMb = parsePositiveInt(values["warn-growth-mb"], 250);
const warnGrowthKb = warnGrowthMb * ONE_MB_KB;
const serverPort = parsePositiveInt(values["server-port"], 5555);
const skipStreamingMetrics = Boolean(values["skip-streaming-metrics"]);
const commandParts =
  positionals.length > 0 ? positionals : ["bun", "run", "dev"];
const [command, ...commandArgs] = commandParts;

if (!command) {
  console.error("[memcheck] No command provided.");
  process.exit(1);
}

const outDir = path.resolve(
  values["out-dir"] || path.join("logs", `dev-memory-${formatStamp()}`),
);
fs.mkdirSync(outDir, { recursive: true });
const samplesPath = path.join(outDir, "samples.ndjson");
const summaryPath = path.join(outDir, "summary.json");
const sampleStream = fs.createWriteStream(samplesPath, { flags: "a" });

const startedAtIso = new Date().toISOString();
const startedAt = Date.now();

console.log("[memcheck] Starting monitor");
console.log(`[memcheck] command: ${commandParts.join(" ")}`);
console.log(`[memcheck] interval: ${intervalMs}ms`);
if (durationMs > 0) {
  console.log(`[memcheck] duration: ${durationSeconds}s`);
}
console.log(`[memcheck] output: ${outDir}`);
console.log("");

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: process.env,
});

const processGrowth = new Map();
let firstTotalRssKb = null;
let lastTotalRssKb = 0;
let maxTotalRssKb = 0;
let firstSteadyStateRssKb = null;
let lastSteadyStateRssKb = 0;
let maxSteadyStateRssKb = 0;
let firstSteadyStateAtMs = null;
let lastSteadyStateAtMs = null;
let steadyStateSampleCount = 0;
let sampleCount = 0;
let sampleInFlight = false;
let childExited = false;
let childExitCode = 0;
let childExitSignal = null;
let shutdownRequested = false;
let endedByDuration = false;
let pollIntervalId = null;
let durationTimeoutId = null;
let forcedKillTimeoutId = null;

function updateGrowth(sample, elapsedMs) {
  for (const proc of sample.processes) {
    const key = `${proc.pid}`;
    const existing = processGrowth.get(key);
    if (!existing) {
      processGrowth.set(key, {
        pid: proc.pid,
        command: proc.command,
        role: proc.role,
        firstRssKb: proc.rssKb,
        lastRssKb: proc.rssKb,
        maxRssKb: proc.rssKb,
        firstSeenAt: elapsedMs,
        lastSeenAt: elapsedMs,
        samples: 1,
        positiveSteps: 0,
        previousRssKb: proc.rssKb,
        warned: false,
      });
      continue;
    }

    if (proc.rssKb >= existing.previousRssKb) {
      existing.positiveSteps += 1;
    }
    existing.previousRssKb = proc.rssKb;
    existing.lastRssKb = proc.rssKb;
    existing.maxRssKb = Math.max(existing.maxRssKb, proc.rssKb);
    existing.lastSeenAt = elapsedMs;
    existing.samples += 1;

    const growthKb = existing.lastRssKb - existing.firstRssKb;
    const mostlyGrowing =
      existing.samples >= 6 &&
      existing.positiveSteps / Math.max(1, existing.samples - 1) >= 0.7;
    if (!existing.warned && growthKb >= warnGrowthKb && mostlyGrowing) {
      existing.warned = true;
      console.warn(
        `[memcheck] Suspected leak PID ${existing.pid} (${existing.role}) growth +${formatMbFromKb(growthKb)}MB`,
      );
    }
  }
}

async function pollSample() {
  if (sampleInFlight) return;
  sampleInFlight = true;

  try {
    if (childExited) return;

    const elapsedMs = Date.now() - startedAt;
    const rows = safePsSnapshot();
    const tree = collectProcessTree(child.pid, rows);
    if (tree.length === 0) {
      return;
    }

    const processes = tree.map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      rssKb: proc.rssKb,
      role: classifyMemoryProcess(proc.command),
      command: proc.command,
    }));

    const totalRssKb = processes.reduce((sum, proc) => sum + proc.rssKb, 0);
    if (firstTotalRssKb == null) firstTotalRssKb = totalRssKb;
    lastTotalRssKb = totalRssKb;
    maxTotalRssKb = Math.max(maxTotalRssKb, totalRssKb);
    sampleCount += 1;

    let streaming = null;
    if (!skipStreamingMetrics) {
      const [metrics, rtmpStatus] = await Promise.all([
        fetchJsonWithTimeout(
          `http://localhost:${serverPort}/api/streaming/metrics`,
        ),
        fetchJsonWithTimeout(
          `http://localhost:${serverPort}/api/streaming/rtmp/status`,
        ),
      ]);
      if (metrics || rtmpStatus) {
        streaming = {
          metrics: metrics
            ? {
                sseClients: metrics?.sse?.clients?.connected ?? null,
                replaySize: metrics?.sse?.replay?.size ?? null,
                droppedSlowConsumers:
                  metrics?.sse?.clients?.droppedSlowConsumers ?? null,
              }
            : null,
          rtmp: rtmpStatus
            ? {
                active: rtmpStatus.active ?? null,
                ffmpegRunning: rtmpStatus.ffmpegRunning ?? null,
                clientConnected: rtmpStatus.clientConnected ?? null,
                bytesReceivedMB: rtmpStatus?.stats?.bytesReceivedMB ?? null,
                droppedFrames: rtmpStatus?.stats?.droppedFrames ?? null,
                backpressured: rtmpStatus?.stats?.backpressured ?? null,
                processRssMB:
                  rtmpStatus?.stats?.processMemory?.rssBytes != null
                    ? (
                        rtmpStatus.stats.processMemory.rssBytes /
                        (1024 * 1024)
                      ).toFixed(1)
                    : null,
              }
            : null,
        };
      }
    }

    const sample = {
      timestamp: new Date().toISOString(),
      elapsedMs,
      totalRssKb,
      processCount: processes.length,
      processes,
      streaming,
    };
    if (isSteadyStateMemorySample(sample)) {
      if (firstSteadyStateRssKb == null) {
        firstSteadyStateRssKb = totalRssKb;
        firstSteadyStateAtMs = elapsedMs;
      }
      lastSteadyStateRssKb = totalRssKb;
      maxSteadyStateRssKb = Math.max(maxSteadyStateRssKb, totalRssKb);
      lastSteadyStateAtMs = elapsedMs;
      steadyStateSampleCount += 1;
    }
    sampleStream.write(`${JSON.stringify(sample)}\n`);

    updateGrowth(sample, elapsedMs);

    const top = processes.slice(0, 4);
    const topSummary = top
      .map(
        (proc) =>
          `${proc.pid}:${proc.role}:${formatMbFromKb(proc.rssKb)}MB (${proc.command.split(" ").slice(0, 3).join(" ")})`,
      )
      .join(" | ");

    console.log(
      `[memcheck +${Math.round(elapsedMs / 1000)}s] total=${formatMbFromKb(totalRssKb)}MB procs=${processes.length}`,
    );
    if (topSummary) {
      console.log(`[memcheck] top: ${topSummary}`);
    }
    if (streaming?.rtmp) {
      console.log(
        `[memcheck] stream: ffmpeg=${streaming.rtmp.ffmpegRunning} client=${streaming.rtmp.clientConnected} bytesMB=${streaming.rtmp.bytesReceivedMB}`,
      );
    }
    console.log("");
  } finally {
    sampleInFlight = false;
  }
}

function requestShutdown(reason, signal = "SIGTERM") {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (reason.startsWith("duration ")) {
    endedByDuration = true;
  }
  console.log(`[memcheck] Stopping child process tree (${reason})`);
  const signaled = signalProcessTree(child.pid, signal);
  if (signaled === 0) {
    try {
      child.kill(signal);
    } catch {}
  }
  forcedKillTimeoutId = setTimeout(() => {
    if (!childExited) {
      const killed = signalProcessTree(child.pid, "SIGKILL");
      console.warn(
        `[memcheck] Child did not exit in time, force-killed ${killed} processes`,
      );
      if (killed === 0) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }, 8000);
}

async function finalize() {
  if (pollIntervalId) clearInterval(pollIntervalId);
  if (durationTimeoutId) clearTimeout(durationTimeoutId);
  if (forcedKillTimeoutId) clearTimeout(forcedKillTimeoutId);

  await pollSample();
  sampleStream.end();

  const endedAtIso = new Date().toISOString();
  const durationMsFinal = Date.now() - startedAt;
  const totalGrowthKb =
    firstTotalRssKb == null ? 0 : lastTotalRssKb - firstTotalRssKb;
  const steadyStateGrowthKb =
    firstSteadyStateRssKb == null
      ? 0
      : lastSteadyStateRssKb - firstSteadyStateRssKb;

  const growthSummary = [...processGrowth.values()]
    .map((entry) => ({
      pid: entry.pid,
      role: entry.role,
      command: entry.command,
      firstRssMb: Number((entry.firstRssKb / ONE_MB_KB).toFixed(2)),
      lastRssMb: Number((entry.lastRssKb / ONE_MB_KB).toFixed(2)),
      maxRssMb: Number((entry.maxRssKb / ONE_MB_KB).toFixed(2)),
      growthMb: Number(
        ((entry.lastRssKb - entry.firstRssKb) / ONE_MB_KB).toFixed(2),
      ),
      samples: entry.samples,
      firstSeenAtMs: entry.firstSeenAt,
      lastSeenAtMs: entry.lastSeenAt,
      warned: entry.warned,
    }))
    .sort((a, b) => b.growthMb - a.growthMb);

  const summary = {
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    durationMs: durationMsFinal,
    command: commandParts,
    intervalMs,
    sampleCount,
    totalMemory: {
      firstRssMb:
        firstTotalRssKb == null
          ? null
          : Number((firstTotalRssKb / ONE_MB_KB).toFixed(2)),
      lastRssMb: Number((lastTotalRssKb / ONE_MB_KB).toFixed(2)),
      maxRssMb: Number((maxTotalRssKb / ONE_MB_KB).toFixed(2)),
      growthMb: Number((totalGrowthKb / ONE_MB_KB).toFixed(2)),
    },
    steadyStateMemory: {
      available: firstSteadyStateRssKb != null,
      sampleCount: steadyStateSampleCount,
      firstSeenAtMs: firstSteadyStateAtMs,
      lastSeenAtMs: lastSteadyStateAtMs,
      durationMs:
        firstSteadyStateAtMs == null || lastSteadyStateAtMs == null
          ? 0
          : Math.max(0, lastSteadyStateAtMs - firstSteadyStateAtMs),
      firstRssMb:
        firstSteadyStateRssKb == null
          ? null
          : Number((firstSteadyStateRssKb / ONE_MB_KB).toFixed(2)),
      lastRssMb:
        firstSteadyStateRssKb == null
          ? null
          : Number((lastSteadyStateRssKb / ONE_MB_KB).toFixed(2)),
      maxRssMb:
        firstSteadyStateRssKb == null
          ? null
          : Number((maxSteadyStateRssKb / ONE_MB_KB).toFixed(2)),
      growthMb:
        firstSteadyStateRssKb == null
          ? null
          : Number((steadyStateGrowthKb / ONE_MB_KB).toFixed(2)),
    },
    warnGrowthMb,
    processGrowth: growthSummary,
    childExit: {
      code: childExitCode,
      signal: childExitSignal,
    },
    files: {
      samples: samplesPath,
      summary: summaryPath,
    },
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log("[memcheck] Complete");
  console.log(`[memcheck] samples: ${samplesPath}`);
  console.log(`[memcheck] summary: ${summaryPath}`);
  if (summary.totalMemory.growthMb != null) {
    console.log(
      `[memcheck] whole-run RSS growth (includes startup/shutdown): ${summary.totalMemory.growthMb.toFixed(2)}MB`,
    );
  }
  if (summary.steadyStateMemory.growthMb != null) {
    console.log(
      `[memcheck] ready steady-state RSS growth: ${summary.steadyStateMemory.growthMb.toFixed(2)}MB across ${summary.steadyStateMemory.sampleCount} samples`,
    );
  }
  if (growthSummary.length > 0) {
    const top = growthSummary.slice(0, 5);
    for (const item of top) {
      console.log(
        `[memcheck] growth PID ${item.pid} (${item.role}) +${item.growthMb.toFixed(2)}MB`,
      );
    }
  }

  process.exit(endedByDuration ? 0 : childExitCode);
}

child.on("exit", (code, signal) => {
  childExited = true;
  childExitCode = code ?? (signal ? 1 : 0);
  childExitSignal = signal;
  void finalize();
});

child.on("error", (error) => {
  console.error(
    `[memcheck] Failed to start command: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});

pollIntervalId = setInterval(() => {
  void pollSample();
}, intervalMs);

void pollSample();

if (durationMs > 0) {
  durationTimeoutId = setTimeout(() => {
    requestShutdown(`duration ${durationSeconds}s reached`);
  }, durationMs);
}

process.on("SIGINT", () => requestShutdown("SIGINT", "SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM", "SIGTERM"));
