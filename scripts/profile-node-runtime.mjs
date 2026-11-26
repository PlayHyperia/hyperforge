#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const durationMs = Number.parseInt(
  process.env.PROFILE_DURATION_MS || "240000",
  10,
);
const inspectorOrigin = process.env.NODE_INSPECTOR_ORIGIN || "http://127.0.0.1:9229";
const outputPath = path.resolve(
  process.env.PROFILE_OUTPUT ||
    `artifacts/server-runtime-profile-${new Date().toISOString().replaceAll(":", "-")}.json`,
);

if (!Number.isFinite(durationMs) || durationMs < 10_000) {
  throw new Error("PROFILE_DURATION_MS must be at least 10000");
}

const targetsResponse = await fetch(`${inspectorOrigin}/json/list`);
if (!targetsResponse.ok) {
  throw new Error(
    `Inspector target discovery failed with HTTP ${targetsResponse.status}`,
  );
}
const targets = await targetsResponse.json();
const target = targets.find(
  (candidate) => candidate?.type === "node" && candidate.webSocketDebuggerUrl,
);
if (!target) {
  throw new Error(`No Node inspector target is available at ${inspectorOrigin}`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextMessageId = 1;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) {
    request.reject(new Error(message.error.message || "Inspector command failed"));
    return;
  }
  request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener(
    "error",
    () => reject(new Error("Could not connect to the Node inspector")),
    { once: true },
  );
});

function call(method, params = {}) {
  const id = nextMessageId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime evaluation failed",
    );
  }
  return result.result?.value;
}

const monitorExpression = String.raw`
(async () => {
  globalThis.__hyperiaRuntimeProfile?.stop?.();
  const { PerformanceObserver, performance } =
    process.getBuiltinModule("node:perf_hooks");
  const state = {
    startedAt: Date.now(),
    gcEntries: [],
    lagEvents: [],
    maxLagMs: 0,
    probeCount: 0,
  };
  let expectedAt = performance.now() + 50;
  let cpuBaseline = process.cpuUsage();
  let eluBaseline = performance.eventLoopUtilization();
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.gcEntries.push({
        at: Math.round(performance.timeOrigin + entry.startTime),
        durationMs: Number(entry.duration.toFixed(3)),
        kind: entry.detail?.kind ?? entry.kind ?? null,
        flags: entry.detail?.flags ?? entry.flags ?? null,
      });
    }
    if (state.gcEntries.length > 2000) {
      state.gcEntries.splice(0, state.gcEntries.length - 2000);
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  let timer = null;
  const probe = () => {
    const monotonicNow = performance.now();
    const observedAt = Date.now();
    const lagMs = Math.max(0, monotonicNow - expectedAt);
    const cpu = process.cpuUsage(cpuBaseline);
    cpuBaseline = process.cpuUsage();
    const elu = performance.eventLoopUtilization(eluBaseline);
    eluBaseline = performance.eventLoopUtilization();
    state.probeCount += 1;
    state.maxLagMs = Math.max(state.maxLagMs, lagMs);
    if (lagMs >= 100) {
      state.lagEvents.push({
        at: observedAt,
        lagMs: Number(lagMs.toFixed(3)),
        cpuUserMs: Number((cpu.user / 1000).toFixed(3)),
        cpuSystemMs: Number((cpu.system / 1000).toFixed(3)),
        eventLoopUtilization: Number(elu.utilization.toFixed(6)),
        heapUsedMB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(3)),
      });
      if (state.lagEvents.length > 500) state.lagEvents.shift();
    }
    expectedAt = monotonicNow + 50;
    timer = setTimeout(probe, 50);
    timer.unref?.();
  };
  timer = setTimeout(probe, 50);
  timer.unref?.();

  globalThis.__hyperiaRuntimeProfile = {
    snapshot: () => ({
      ...state,
      uptimeMs: Date.now() - state.startedAt,
      memory: process.memoryUsage(),
    }),
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      gcObserver.disconnect();
    },
  };
  return true;
})()
`;

await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 1000 });
await evaluate(monitorExpression);
await call("Profiler.start");

const startedAt = Date.now();
const progressTimer = setInterval(async () => {
  try {
    const snapshot = await evaluate(
      "globalThis.__hyperiaRuntimeProfile?.snapshot?.()",
    );
    process.stdout.write(
      `${JSON.stringify({
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        gcCount: snapshot?.gcEntries?.length ?? 0,
        lagEventCount: snapshot?.lagEvents?.length ?? 0,
        maxLagMs: Number((snapshot?.maxLagMs ?? 0).toFixed(1)),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`profile progress failed: ${error.message}\n`);
  }
}, 30_000);
progressTimer.unref?.();

await new Promise((resolve) => setTimeout(resolve, durationMs));
clearInterval(progressTimer);

const [{ profile }, runtime] = await Promise.all([
  call("Profiler.stop"),
  evaluate("globalThis.__hyperiaRuntimeProfile?.snapshot?.()"),
]);
await evaluate("globalThis.__hyperiaRuntimeProfile?.stop?.()");
socket.close();

const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
const selfTimeByNode = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  const nodeId = profile.samples[index];
  selfTimeByNode.set(
    nodeId,
    (selfTimeByNode.get(nodeId) || 0) + (profile.timeDeltas[index] || 0),
  );
}
const topSelfTime = Array.from(selfTimeByNode.entries())
  .map(([nodeId, microseconds]) => {
    const callFrame = nodesById.get(nodeId)?.callFrame || {};
    return {
      functionName: callFrame.functionName || "(anonymous)",
      url: callFrame.url || "",
      lineNumber:
        Number.isInteger(callFrame.lineNumber) && callFrame.lineNumber >= 0
          ? callFrame.lineNumber + 1
          : null,
      selfTimeMs: Number((microseconds / 1000).toFixed(3)),
    };
  })
  .sort((left, right) => right.selfTimeMs - left.selfTimeMs)
  .slice(0, 50);

const totalProfileMs = profile.timeDeltas.reduce(
  (total, microseconds) => total + microseconds / 1000,
  0,
);
const gcSelfTimeMs = topSelfTime
  .filter((entry) => /garbage collector/i.test(entry.functionName))
  .reduce((total, entry) => total + entry.selfTimeMs, 0);
const gcDurationMs = runtime.gcEntries.reduce(
  (total, entry) => total + entry.durationMs,
  0,
);
const maxGcDurationMs = runtime.gcEntries.reduce(
  (maximum, entry) => Math.max(maximum, entry.durationMs),
  0,
);

const report = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  durationMs,
  target: {
    title: target.title,
    url: target.url,
  },
  summary: {
    totalProfileMs: Number(totalProfileMs.toFixed(3)),
    sampleCount: profile.samples.length,
    gcCount: runtime.gcEntries.length,
    gcDurationMs: Number(gcDurationMs.toFixed(3)),
    maxGcDurationMs: Number(maxGcDurationMs.toFixed(3)),
    gcSelfTimeMs: Number(gcSelfTimeMs.toFixed(3)),
    lagEventCount: runtime.lagEvents.length,
    maxLagMs: Number(runtime.maxLagMs.toFixed(3)),
  },
  lagEvents: runtime.lagEvents,
  gcEntries: runtime.gcEntries,
  topSelfTime,
  profile,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
process.stdout.write(
  `${JSON.stringify({ outputPath, summary: report.summary, topSelfTime: topSelfTime.slice(0, 10) }, null, 2)}\n`,
);
