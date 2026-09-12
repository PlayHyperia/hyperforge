import assert from "node:assert/strict";

// Opt-in diagnostics for the actual r186 client. Never installed by the game.
export async function measureNativeGpuFrames() {
  const key = "__HYPERIA_GPU_FRAME_PROBE01__",
    w = window.world,
    r = w?.graphics?.renderer,
    backend = r?.backend;
  if (
    window[key] ||
    !backend?.isWebGPUBackend ||
    !backend.device.features.has("timestamp-query")
  )
    throw Error("Exclusive native WebGPU timestamp support required");
  const tickDescriptor = Object.getOwnPropertyDescriptor(w, "tick");
  const queryDescriptor = Object.getOwnPropertyDescriptor(
    backend,
    "initTimestampQuery",
  );
  const resetDescriptor = Object.getOwnPropertyDescriptor(r.info, "reset"),
    originalReset = r.info.reset;
  const originalTick = w.tick,
    originalQuery = backend.initTimestampQuery,
    pools = backend.timestampQueryPool;
  const poolDescriptors = Object.getOwnPropertyDescriptors(pools);
  if (
    !tickDescriptor?.writable ||
    typeof originalTick !== "function" ||
    typeof originalQuery !== "function" ||
    typeof originalReset !== "function" ||
    backend.trackTimestamp !== false ||
    Object.keys(pools).sort().join(",") !== "compute,render" ||
    pools.render !== null ||
    pools.compute !== null
  )
    throw Error(
      "Unowned default timestamp state and actual world tick required",
    );
  const result = {
    schemaVersion: 1,
    warmupMs: 1000,
    durationMs: 10000,
    frames: [],
    passes: [],
    batches: [],
    pools: [],
    errors: [],
    cleanup: null,
    startedAt: performance.now(),
    finishedAt: null,
    stopReason: null,
    dropped: 0,
    scope:
      "Instrumented real client-tick CPU and Three render/compute-pass GPU sums. Not browser presentation, copies/idle time, stream delivery or performance acceptance.",
  };
  const pending = { render: null, compute: null },
    lastFlush = { render: 0, compute: 0 },
    descriptors = new Map();
  let running = true,
    activeFrame = null,
    anchor = null,
    finishing = null,
    watchdog;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const note = (error) => {
    if (result.errors.length < 32) result.errors.push(String(error));
    else result.dropped++;
  };
  const equalDescriptor = (a, b) =>
    Boolean(
      a &&
      b &&
      ["value", "writable", "enumerable", "configurable", "get", "set"].every(
        (k) => a[k] === b[k],
      ),
    );
  function resetHook(...args) {
    // DevStats resets these inside postTick. Observe the boundary, but retain the
    // exact native reset and lifetime call counters; never disable/reset manually.
    if (activeFrame) {
      activeFrame.drawCalls += this.render.drawCalls;
      activeFrame.triangles += this.render.triangles;
      activeFrame.infoResets++;
    }
    return Reflect.apply(originalReset, this, args);
  }
  function queryHook(type, uid, descriptor) {
    if (running && !descriptors.has(descriptor)) {
      if (descriptors.size >= 1024) note("Pass descriptor capacity exceeded");
      else
        descriptors.set(descriptor, {
          original: Object.getOwnPropertyDescriptor(
            descriptor,
            "timestampWrites",
          ),
          installed: null,
        });
    }
    const value = Reflect.apply(originalQuery, this, [type, uid, descriptor]);
    if (!running) return value;
    const saved = descriptors.get(descriptor);
    if (saved) saved.installed = descriptor.timestampWrites;
    const writes = descriptor.timestampWrites,
      pool = pools[type];
    if (
      !["render", "compute"].includes(type) ||
      !pool ||
      !writes ||
      writes.querySet !== pool.querySet ||
      !Number.isInteger(writes.beginningOfPassWriteIndex) ||
      writes.endOfPassWriteIndex !== writes.beginningOfPassWriteIndex + 1
    )
      note("Native timestamp descriptor missing or invalid");
    else if (result.passes.length < 65536)
      result.passes.push({
        type,
        uid,
        rendererFrame: r.info.frame,
        worldFrame: activeFrame ? activeFrame.worldFrameBefore + 1 : null,
        queryIndex: writes.beginningOfPassWriteIndex,
      });
    else {
      result.dropped++;
      note("Pass ledger capacity exceeded");
    }
    return value;
  }
  function flush(type) {
    const pool = pools[type];
    if (!pool || !pool.currentQueryIndex || pending[type]) return pending[type];
    if (pool.pendingResolve) {
      note("Unowned/overflow timestamp resolution");
      return null;
    }
    const offsets = [...pool.queryOffsets],
      queryCount = pool.currentQueryIndex;
    if (queryCount !== offsets.length * 2 || queryCount > pool.maxQueries)
      note("Lost or duplicate native query allocation");
    const batch = {
      type,
      queryCount,
      startedAt: performance.now(),
      finishedAt: null,
      values: [],
    };
    result.batches.push(batch);
    lastFlush[type] = batch.startedAt;
    // Same real pool method used by Backend.resolveTimestampsAsync; no renderer-info mutation.
    pending[type] = pool
      .resolveQueriesAsync()
      .then(() => {
        batch.finishedAt = performance.now();
        for (const [uid] of offsets) {
          const ms = pool.timestamps.get(uid);
          if (!Number.isFinite(ms) || ms < 0)
            note("Missing/invalid GPU duration: " + uid);
          batch.values.push({ uid, ms: ms ?? null });
        }
        if (pool.timestamps.size !== offsets.length)
          note("Resolved native query count mismatch");
      })
      .catch((error) => note(error?.stack ?? error))
      .finally(() => {
        pending[type] = null;
      });
    return pending[type];
  }
  function finish(reason) {
    if (finishing) return finishing;
    running = false;
    clearTimeout(watchdog);
    result.stopReason = reason;
    backend.trackTimestamp = false;
    let descriptorsRestored = true;
    // r186 caches render-pass descriptors. Disabling tracking alone leaves their
    // old query-set reference live; restore it before any later frame/disposal.
    for (const [descriptor, saved] of descriptors) {
      if (descriptor.timestampWrites !== saved.installed) {
        descriptorsRestored = false;
        note("Foreign pass timestamp descriptor; not overwritten");
      } else if (saved.original)
        Object.defineProperty(descriptor, "timestampWrites", saved.original);
      else delete descriptor.timestampWrites;
    }
    if (w.tick !== tickHook) note("Foreign world tick owner; not overwritten");
    else Object.defineProperty(w, "tick", tickDescriptor);
    if (backend.initTimestampQuery !== queryHook)
      note("Foreign timestamp hook; not overwritten");
    else if (queryDescriptor)
      Object.defineProperty(backend, "initTimestampQuery", queryDescriptor);
    else delete backend.initTimestampQuery;
    if (r.info.reset !== resetHook)
      note("Foreign info reset owner; not overwritten");
    else if (resetDescriptor)
      Object.defineProperty(r.info, "reset", resetDescriptor);
    else delete r.info.reset;
    finishing = (async () => {
      let drainTimer;
      const drain = async () => {
        await Promise.all(Object.values(pending).filter(Boolean));
        await Promise.all(["render", "compute"].map(flush).filter(Boolean));
      };
      try {
        await Promise.race([
          drain(),
          new Promise((_, reject) => {
            drainTimer = setTimeout(
              () => reject(Error("GPU query drain exceeded 15s")),
              15000,
            );
          }),
        ]);
        for (const type of ["render", "compute"]) {
          const pool = pools[type];
          if (!pool) continue;
          const receipt = {
            type,
            maxQueries: pool.maxQueries,
            querySetCount: pool.querySet.count,
            bufferBytes: pool.resolveBuffer.size + pool.resultBuffer.size,
            disposed: false,
          };
          result.pools.push(receipt);
          await pool.dispose();
          receipt.disposed =
            pool.isDisposed &&
            !pool.querySet &&
            !pool.resolveBuffer &&
            !pool.resultBuffer &&
            !pool.pendingResolve;
          if (pools[type] === pool)
            Object.defineProperty(pools, type, poolDescriptors[type]);
          else note("Foreign timestamp pool; not restored");
        }
      } catch (error) {
        note(error?.stack ?? error);
      } finally {
        clearTimeout(drainTimer);
      }
      result.finishedAt = performance.now();
      result.cleanup = {
        tickRestored: equalDescriptor(
          Object.getOwnPropertyDescriptor(w, "tick"),
          tickDescriptor,
        ),
        resetRestored:
          r.info.reset === originalReset &&
          (resetDescriptor
            ? equalDescriptor(
                Object.getOwnPropertyDescriptor(r.info, "reset"),
                resetDescriptor,
              )
            : !Object.hasOwn(r.info, "reset")),
        queryRestored:
          backend.initTimestampQuery === originalQuery &&
          (queryDescriptor
            ? equalDescriptor(
                Object.getOwnPropertyDescriptor(backend, "initTimestampQuery"),
                queryDescriptor,
              )
            : !Object.hasOwn(backend, "initTimestampQuery")),
        trackingRestored: backend.trackTimestamp === false,
        descriptorsRestored,
        poolsRestored:
          backend.timestampQueryPool === pools &&
          Object.keys(pools).sort().join(",") === "compute,render" &&
          ["render", "compute"].every((type) =>
            equalDescriptor(
              Object.getOwnPropertyDescriptor(pools, type),
              poolDescriptors[type],
            ),
          ),
      };
      if (window[key]?.done === done) delete window[key];
      else note("Foreign probe owner; not removed");
      resolveDone(result);
      return result;
    })();
    return finishing;
  }
  function tickHook(...args) {
    if (!running) return Reflect.apply(originalTick, this, args);
    const start = performance.now();
    if (anchor === null) anchor = start;
    const row = {
      rendererFrame: r.info.frame,
      worldFrameBefore: w.frame,
      worldFrameAfter: null,
      at: start,
      elapsed: start - anchor,
      cpuMs: null,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      phase: w.getSystem("environment").skySystem.dayPhase,
      renderPasses: r.info.render.calls,
      computePasses: r.info.compute.calls,
      drawCalls: -r.info.render.drawCalls,
      triangles: -r.info.render.triangles,
      infoResets: 0,
    };
    activeFrame = row;
    let value;
    const nativeStart = performance.now();
    try {
      value = Reflect.apply(originalTick, this, args);
    } catch (error) {
      note(error?.stack ?? error);
      finish("native-throw");
      throw error;
    } finally {
      row.cpuMs = performance.now() - nativeStart;
      activeFrame = null;
    }
    row.worldFrameAfter = w.frame;
    row.renderPasses = r.info.render.calls - row.renderPasses;
    row.computePasses = r.info.compute.calls - row.computePasses;
    row.drawCalls += r.info.render.drawCalls;
    row.triangles += r.info.render.triangles;
    if (
      r.info.frame !== row.rendererFrame ||
      row.worldFrameAfter !== row.worldFrameBefore + 1
    )
      note("Native client/renderer frame ownership changed");
    if (result.frames.length < 2400) result.frames.push(row);
    else {
      result.dropped++;
      note("Client frame capacity exceeded");
    }
    for (const type of ["render", "compute"])
      if (start - lastFlush[type] >= 100) flush(type);
    if (row.elapsed >= result.warmupMs + result.durationMs) finish("duration");
    else if (result.errors.length || result.dropped) finish("invalid-evidence");
    return value;
  }
  window[key] = { done, stop: finish };
  Object.defineProperty(w, "tick", { ...tickDescriptor, value: tickHook });
  Object.defineProperty(backend, "initTimestampQuery", {
    value: queryHook,
    writable: true,
    configurable: true,
    enumerable: queryDescriptor?.enumerable ?? false,
  });
  Object.defineProperty(r.info, "reset", {
    value: resetHook,
    writable: true,
    configurable: true,
    enumerable: resetDescriptor?.enumerable ?? false,
  });
  backend.trackTimestamp = true;
  watchdog = setTimeout(() => finish("watchdog"), 20000);
  return done;
}

export function summarizeNativeGpuFrames(raw) {
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.stopReason, "duration");
  assert.equal(raw.dropped, 0);
  assert.deepEqual(raw.errors, []);
  assert.deepEqual(raw.cleanup, {
    tickRestored: true,
    resetRestored: true,
    queryRestored: true,
    trackingRestored: true,
    descriptorsRestored: true,
    poolsRestored: true,
  });
  assert.equal(raw.warmupMs, 1000);
  assert.equal(raw.durationMs, 10000);
  assert(
    raw.frames.length > 1 &&
      raw.frames.length <= 2400 &&
      raw.passes.length <= 65536,
  );
  assert(raw.frames.at(-1).elapsed >= raw.warmupMs + raw.durationMs);
  const frameMap = new Map(),
    passMap = new Map();
  for (const f of raw.frames) {
    assert(
      Number.isFinite(f.cpuMs) &&
        f.cpuMs >= 0 &&
        f.visibility === "visible" &&
        f.focused,
    );
    assert(
      Number.isSafeInteger(f.drawCalls) &&
        f.drawCalls > 0 &&
        Number.isFinite(f.triangles) &&
        f.triangles > 0,
    );
    assert(Number.isSafeInteger(f.infoResets) && f.infoResets >= 0);
    assert.equal(f.worldFrameAfter, f.worldFrameBefore + 1);
    assert(!frameMap.has(f.rendererFrame));
    frameMap.set(f.rendererFrame, {
      ...f,
      renderGpuMs: 0,
      computeGpuMs: 0,
      renderQueryCount: 0,
      computeQueryCount: 0,
    });
  }
  for (const p of raw.passes) {
    const m = /^(r|c):\d+:[\d,]+:f(\d+)$/.exec(p.uid);
    assert(m && ["render", "compute"].includes(p.type));
    assert.equal(m[1], p.type === "render" ? "r" : "c");
    assert.equal(Number(m[2]), p.rendererFrame);
    assert(!passMap.has(p.uid));
    const frame = frameMap.get(p.rendererFrame);
    assert(frame, "GPU pass has no observed client frame");
    assert.equal(
      p.worldFrame,
      frame.worldFrameAfter,
      "Unmeasured off-tick GPU work must not be silently omitted",
    );
    passMap.set(p.uid, { ...p, resolved: false });
  }
  for (const batch of raw.batches) {
    assert.equal(batch.queryCount, batch.values.length * 2);
    assert(batch.finishedAt >= batch.startedAt);
    for (const v of batch.values) {
      const p = passMap.get(v.uid);
      assert(p && !p.resolved);
      assert.equal(p.type, batch.type);
      assert(Number.isFinite(v.ms) && v.ms >= 0);
      p.resolved = true;
      const frame = frameMap.get(p.rendererFrame);
      frame[p.type + "GpuMs"] += v.ms;
      frame[p.type + "QueryCount"]++;
    }
  }
  assert([...passMap.values()].every((p) => p.resolved));
  for (const f of frameMap.values()) {
    assert.equal(f.renderPasses, f.renderQueryCount);
    assert.equal(f.computePasses, f.computeQueryCount);
    assert(f.renderQueryCount > 0);
  }
  assert(raw.pools.length > 0);
  assert.deepEqual(
    raw.pools.map((p) => p.type).sort(),
    [...new Set(raw.passes.map((p) => p.type))].sort(),
  );
  for (const p of raw.pools)
    assert(
      p.disposed &&
        p.maxQueries === 2048 &&
        p.querySetCount === 2048 &&
        p.bufferBytes === 32768,
    );
  const measured = [...frameMap.values()].filter(
    (f) =>
      f.elapsed >= raw.warmupMs && f.elapsed < raw.warmupMs + raw.durationMs,
  );
  assert(measured.length > 1);
  const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    assert(sorted.every(Number.isFinite));
    const percentile = (p) =>
      sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    return {
      count: sorted.length,
      min: sorted[0],
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1),
    };
  };
  const intervals = measured.slice(1).map((f, i) => f.at - measured[i].at);
  assert(intervals.every((v) => v > 0));
  return {
    complete: true,
    performanceApproved: false,
    measuredFrames: measured.length,
    resolvedPasses: passMap.size,
    measuredSpanMs: measured.at(-1).at - measured[0].at,
    cpuTickMs: distribution(measured.map((f) => f.cpuMs)),
    renderGpuMs: distribution(measured.map((f) => f.renderGpuMs)),
    computeGpuMs: distribution(measured.map((f) => f.computeGpuMs)),
    totalPassGpuMs: distribution(
      measured.map((f) => f.renderGpuMs + f.computeGpuMs),
    ),
    clientTickIntervalMs: distribution(intervals),
    drawCalls: distribution(measured.map((f) => f.drawCalls)),
    triangles: distribution(measured.map((f) => f.triangles)),
    scope:
      "Actual query-pass sums and instrumented client CPU. Not presented FPS, copy/queue idle time or full stream/target-device qualification.",
  };
}
