import assert from "node:assert/strict";

// Schema 1 below is retained verbatim for archived evidence. It cannot detect
// physical-pass resumes; do not reinterpret its pass sums as schema 2 results.

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

/**
 * Opt-in, serializable physical-pass diagnostic for the actual client/device.
 * The r186 logical initializer is still called with tracking disabled: it is a
 * no-op, so its module-private shared timestamp objects are NEVER mutated.
 * Only fresh physical descriptors reference the diagnostic-owned query sets.
 * Resolve/copy/readback work adds observer overhead; it is not timed GPU work.
 */
export async function measureNativePhysicalGpuFrames() {
  const key = "__HYPERIA_GPU_PHYSICAL_PROBE02__";
  const w = window.world,
    r = w?.graphics?.renderer,
    b = r?.backend;
  const d = b?.device,
    q = d?.queue;
  const limits = {
    frames: 2400,
    logical: 16384,
    segments: 32768,
    encoders: 16384,
    submissions: 16384,
    batches: 1024,
    hooks: 65536,
    descriptors: 1024,
    queries: 2048,
  };
  const requireValue = (ok, message) => {
    if (!ok) throw Error(message);
  };
  requireValue(
    !window[key] &&
      !window.__HYPERIA_GPU_FRAME_PROBE01__ &&
      !window.__HYPERIA_DIRT_GPU_SPANS01__ &&
      !window.__HYPERIA_RENDER_WORK01__ &&
      b?.isWebGPUBackend &&
      d?.features.has("timestamp-query") &&
      b.trackTimestamp === false &&
      Object.keys(b.timestampQueryPool).sort().join(",") === "compute,render" &&
      b.timestampQueryPool.render === null &&
      b.timestampQueryPool.compute === null,
    "Exclusive default native WebGPU timestamp owner required",
  );
  const nativePools = b.timestampQueryPool;
  const nativePoolDescriptors = Object.getOwnPropertyDescriptors(nativePools);
  const originalCreate = d.createCommandEncoder;
  const sameDescriptor = (a, z) =>
    a === undefined
      ? z === undefined
      : Boolean(
          z &&
          [
            "value",
            "get",
            "set",
            "writable",
            "enumerable",
            "configurable",
          ].every((k) => a[k] === z[k]),
        );
  const nativeUnchanged = () =>
    b.trackTimestamp === false &&
    b.timestampQueryPool === nativePools &&
    Object.keys(nativePools).sort().join(",") === "compute,render" &&
    ["render", "compute"].every((type) =>
      sameDescriptor(
        Object.getOwnPropertyDescriptor(nativePools, type),
        nativePoolDescriptors[type],
      ),
    );
  const result = {
    schemaVersion: 2,
    id: "native-physical-gpu-v2",
    limits,
    warmupMs: 1000,
    durationMs: 10000,
    startedAt: performance.now(),
    finishedAt: null,
    stopReason: null,
    frames: [],
    logical: [],
    segments: [],
    encoders: [],
    submissions: [],
    batches: [],
    pools: [],
    errors: [],
    dropped: 0,
    cleanup: null,
    scope:
      "Diagnostic-owned unique physical-pass timestamps and instrumented client CPU. " +
      "Observed unions exclude untimed work, copies, queue idle and presentation. " +
      "Observer resolve/copy/readback and interception overhead are not subtracted. Not performance approval.",
  };
  const owner = { w, r, b, d, q, stop: null, done: null };
  const hooks = [],
    descriptors = new Map(),
    logicalByDescriptor = new WeakMap();
  const logicalIds = new Set(),
    encoderOwners = new WeakMap(),
    commandOwners = new WeakMap();
  const poolOwners = new Map();
  let running = true,
    activeFrame = null,
    anchor = null,
    finishing = null,
    watchdog;
  let sealed = false,
    finishReason = null,
    listenerInstalled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  owner.done = done;
  const note = (error) => {
    if (sealed) return;
    if (result.errors.length < 32)
      result.errors.push(String(error?.stack ?? error).slice(0, 2048));
    else result.dropped++;
  };
  const actual = () =>
    requireValue(
      window[key] === owner &&
        window.world === w &&
        w.graphics.renderer === r &&
        r.backend === b &&
        b.device === d &&
        d.queue === q &&
        nativeUnchanged(),
      "Physical timestamp/native renderer owner changed",
    );
  const add = (array, cap, value, name) => {
    requireValue(array.length < cap, name + " capacity exceeded");
    array.push(value);
    return value;
  };
  function hook(object, name, invoke) {
    requireValue(
      hooks.length < limits.hooks,
      "Physical hook capacity exceeded",
    );
    const descriptor = Object.getOwnPropertyDescriptor(object, name),
      original = object[name];
    requireValue(
      typeof original === "function" &&
        (!descriptor ||
          ("value" in descriptor &&
            (descriptor.configurable || descriptor.writable))),
      "Unobservable native method: " + name,
    );
    const installed = {
      ...(descriptor ?? {
        configurable: true,
        writable: true,
        enumerable: false,
      }),
      value: function (...args) {
        return invoke.call(this, original, args);
      },
    };
    Object.defineProperty(object, name, installed);
    hooks.push({
      object,
      name,
      descriptor,
      original,
      installed,
      restored: false,
    });
  }
  function restoreHooks(queueOnly) {
    let restored = true;
    for (const h of [...hooks].reverse()) {
      if (h.restored || (h.object === q) !== queueOnly) continue;
      if (
        !sameDescriptor(
          Object.getOwnPropertyDescriptor(h.object, h.name),
          h.installed,
        )
      ) {
        restored = false;
        note("Foreign native hook not overwritten: " + h.name);
        continue;
      }
      try {
        if (h.descriptor) Object.defineProperty(h.object, h.name, h.descriptor);
        else delete h.object[h.name];
        h.restored =
          sameDescriptor(
            Object.getOwnPropertyDescriptor(h.object, h.name),
            h.descriptor,
          ) && h.object[h.name] === h.original;
        restored &&= h.restored;
      } catch (error) {
        restored = false;
        note(error);
      }
    }
    return restored;
  }
  function getPool(type) {
    if (poolOwners.has(type)) return poolOwners.get(type);
    requireValue(
      ["render", "compute"].includes(type) && poolOwners.size < 2,
      "Invalid physical pool type",
    );
    const row = {
      id: poolOwners.size + 1,
      type,
      count: limits.queries,
      bytesPerBuffer: limits.queries * 8,
      querySetDestroyCalled: false,
      resolveDestroyCalled: false,
      resultDestroyCalled: false,
      unmapped: false,
    };
    const pool = {
      row,
      querySet: null,
      resolveBuffer: null,
      resultBuffer: null,
      allocations: [],
      generation: 0,
      pending: null,
      lastFlush: 0,
    };
    poolOwners.set(type, pool);
    result.pools.push(row);
    // Register each partially-created owner before the next native allocation,
    // so failure cleanup also releases a partially initialized diagnostic pool.
    pool.querySet = d.createQuerySet({
      type: "timestamp",
      count: limits.queries,
      label: "hyperia-physical-" + type,
    });
    pool.resolveBuffer = d.createBuffer({
      size: row.bytesPerBuffer,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: "hyperia-physical-resolve-" + type,
    });
    pool.resultBuffer = d.createBuffer({
      size: row.bytesPerBuffer,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "hyperia-physical-readback-" + type,
    });
    return pool;
  }
  function physicalDescriptor(encoder, type, descriptor) {
    actual();
    requireValue(
      activeFrame &&
        !encoder.row.finished &&
        descriptor &&
        typeof descriptor === "object",
      "Physical pass outside measured tick or descriptor owner",
    );
    requireValue(
      descriptor.timestampWrites === undefined,
      "Foreign physical timestamp descriptor",
    );
    const logical = logicalByDescriptor.get(descriptor);
    if (logical)
      requireValue(
        logical.type === type &&
          logical.rendererFrame === r.info.frame &&
          logical.worldFrame === w.frame,
        "Stale or wrong-type logical descriptor on physical resume",
      );
    const pool = getPool(type),
      queryIndex = pool.allocations.length * 2;
    requireValue(
      queryIndex + 2 <= limits.queries,
      "Physical timestamp allocation overflow; evidence rejected",
    );
    const segment = {
      id: result.segments.length + 1,
      uid: "physical:" + (result.segments.length + 1) + ":f" + r.info.frame,
      type,
      pool: pool.row.id,
      generation: pool.generation,
      queryIndex,
      encoder: encoder.row.id,
      logicalUid: logical?.uid ?? null,
      rendererFrame: r.info.frame,
      worldFrame: w.frame,
      at: performance.now(),
      nativeStarted: false,
      descriptorPreserved: false,
      immutableWrites: false,
    };
    add(result.segments, limits.segments, segment, "Physical segment");
    pool.allocations.push(segment.id);
    encoder.row.segments.push(segment.id);
    // Copy descriptor property descriptors, retaining attachment/query/viewport
    // identities. Only timestampWrites differs; the game's cached object is untouched.
    const properties = Object.getOwnPropertyDescriptors(descriptor);
    const writes = Object.freeze({
      querySet: pool.querySet,
      beginningOfPassWriteIndex: queryIndex,
      endOfPassWriteIndex: queryIndex + 1,
    });
    properties.timestampWrites = {
      value: writes,
      configurable: false,
      writable: false,
      enumerable: true,
    };
    const copy = Object.create(Object.getPrototypeOf(descriptor), properties);
    for (const key of Reflect.ownKeys(descriptor))
      if (key !== "timestampWrites")
        requireValue(
          copy[key] === descriptor[key],
          "Physical descriptor changed a rendering field",
        );
    Object.freeze(copy);
    segment.descriptorPreserved = true;
    segment.immutableWrites = Object.isFrozen(copy) && Object.isFrozen(writes);
    return { copy, segment };
  }
  function observeEncoder(encoder, descriptor) {
    actual();
    requireValue(
      !encoderOwners.has(encoder),
      "Repeated native encoder identity",
    );
    const row = add(
      result.encoders,
      limits.encoders,
      {
        id: result.encoders.length + 1,
        label: String(descriptor?.label ?? "").slice(0, 160),
        at: performance.now(),
        finished: false,
        submitted: false,
        segments: [],
      },
      "Encoder",
    );
    const owned = { encoder, row };
    encoderOwners.set(encoder, owned);
    for (const [name, type] of [
      ["beginRenderPass", "render"],
      ["beginComputePass", "compute"],
    ])
      hook(encoder, name, function (original, args) {
        let measurement;
        if (running && !result.errors.length)
          try {
            requireValue(this === encoder, "Foreign native pass receiver");
            measurement = physicalDescriptor(owned, type, args[0]);
          } catch (error) {
            note(error);
          }
        const value = Reflect.apply(
          original,
          this,
          measurement ? [measurement.copy, ...args.slice(1)] : args,
        );
        if (measurement) measurement.segment.nativeStarted = true;
        return value;
      });
    hook(encoder, "finish", function (original, args) {
      const command = Reflect.apply(original, this, args);
      try {
        requireValue(
          this === encoder && !row.finished && !commandOwners.has(command),
          "Invalid native encoder finish",
        );
        row.finished = true;
        commandOwners.set(command, { encoder: row.id });
      } catch (error) {
        note(error);
      }
      return command;
    });
  }
  function flush(pool) {
    if (!pool.allocations.length || pool.pending) return pool.pending;
    actual();
    const allocations = [...pool.allocations];
    for (const id of allocations)
      requireValue(
        result.encoders[result.segments[id - 1].encoder - 1].submitted,
        "Resolve precedes an allocated physical command submission",
      );
    const batch = add(
      result.batches,
      limits.batches,
      {
        id: result.batches.length + 1,
        pool: pool.row.id,
        generation: pool.generation,
        queryCount: allocations.length * 2,
        allocations,
        bytes: allocations.length * 16,
        startedAt: performance.now(),
        mappedAt: null,
        finishedAt: null,
        submission: null,
        values: [],
        resolved: false,
        copied: false,
        mapped: false,
      },
      "Batch",
    );
    requireValue(
      pool.resultBuffer.mapState === "unmapped",
      "Physical result buffer still mapped",
    );
    const encoder = Reflect.apply(originalCreate, d, [
      { label: "hyperia-physical-resolve-" + batch.id },
    ]);
    encoder.resolveQuerySet(
      pool.querySet,
      0,
      batch.queryCount,
      pool.resolveBuffer,
      0,
    );
    batch.resolved = true;
    encoder.copyBufferToBuffer(
      pool.resolveBuffer,
      0,
      pool.resultBuffer,
      0,
      batch.bytes,
    );
    batch.copied = true;
    const command = encoder.finish();
    commandOwners.set(command, { batch: batch.id });
    q.submit([command]);
    // Queue submission orders this resolve before any subsequent slot reuse.
    pool.allocations = [];
    pool.generation++;
    pool.lastFlush = performance.now();
    pool.pending = (async () => {
      await pool.resultBuffer.mapAsync(GPUMapMode.READ, 0, batch.bytes);
      if (sealed) return;
      requireValue(
        pool.resultBuffer.mapState === "mapped",
        "Physical buffer map failed",
      );
      const range = pool.resultBuffer.getMappedRange(0, batch.bytes);
      requireValue(
        range.byteLength === batch.bytes,
        "Physical map range mismatch",
      );
      batch.values = Array.from(new BigUint64Array(range), (value) =>
        value.toString(),
      );
      batch.mappedAt = performance.now();
      batch.mapped = true;
      pool.resultBuffer.unmap();
      batch.finishedAt = performance.now();
    })()
      .catch(note)
      .finally(() => {
        pool.pending = null;
      });
    return pool.pending;
  }
  function finish(reason) {
    if (finishing) return finishing;
    if (activeFrame) {
      finishReason ??= reason;
      return done;
    }
    running = false;
    result.stopReason = reason;
    clearTimeout(watchdog);
    const methodsRestored = restoreHooks(false);
    finishing = (async () => {
      let timer,
        drainCompleted = false;
      try {
        await Promise.race([
          (async () => {
            await Promise.all(
              [...poolOwners.values()]
                .map((pool) => pool.pending)
                .filter(Boolean),
            );
            await Promise.all(
              [...poolOwners.values()].map(flush).filter(Boolean),
            );
            drainCompleted = true;
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Physical timestamp drain exceeded 15s")),
              15000,
            );
          }),
        ]);
      } catch (error) {
        note(error);
      } finally {
        clearTimeout(timer);
      }
      const queueRestored = restoreHooks(true);
      if (listenerInstalled) {
        d.removeEventListener("uncapturederror", onGpuError);
        listenerInstalled = false;
      }
      for (const pool of poolOwners.values()) {
        try {
          if (pool.resultBuffer?.mapState === "mapped")
            pool.resultBuffer.unmap();
          if (pool.querySet) {
            pool.querySet.destroy();
            pool.row.querySetDestroyCalled = true;
          }
          if (pool.resolveBuffer) {
            pool.resolveBuffer.destroy();
            pool.row.resolveDestroyCalled = true;
          }
          if (pool.resultBuffer) {
            pool.resultBuffer.destroy();
            pool.row.resultDestroyCalled = true;
          }
          pool.row.unmapped = pool.resultBuffer?.mapState === "unmapped";
        } catch (error) {
          note(error);
        }
      }
      const descriptorsUnchanged = [...descriptors].every(
        ([descriptor, saved]) =>
          sameDescriptor(
            Object.getOwnPropertyDescriptor(descriptor, "timestampWrites"),
            saved,
          ),
      );
      const ownersUnchanged =
        window[key] === owner &&
        window.world === w &&
        w.graphics.renderer === r &&
        r.backend === b &&
        b.device === d &&
        d.queue === q;
      const resourcesReleased = [...poolOwners.values()].every(
        (pool) =>
          pool.row.querySetDestroyCalled &&
          pool.row.resolveDestroyCalled &&
          pool.row.resultDestroyCalled &&
          pool.row.unmapped,
      );
      const restored =
        methodsRestored && queueRestored && hooks.every((h) => h.restored);
      let ownerReleased = false;
      if (ownersUnchanged && restored) {
        delete window[key];
        ownerReleased = !Object.hasOwn(window, key);
      }
      result.cleanup = {
        drainCompleted,
        methodsRestored: restored,
        nativeStateUnchanged: nativeUnchanged(),
        descriptorsUnchanged,
        ownersUnchanged,
        ownerReleased,
        resourcesReleased,
        listenerRemoved: !listenerInstalled,
        requiresTerminalBrowserCleanup:
          !restored ||
          !ownersUnchanged ||
          !ownerReleased ||
          !resourcesReleased ||
          !nativeUnchanged(),
      };
      result.finishedAt = performance.now();
      sealed = true;
      resolveDone(result);
      return result;
    })();
    return finishing;
  }
  function onGpuError(event) {
    note(
      "Native GPU validation: " + (event.error?.message ?? "uncaptured error"),
    );
  }
  owner.stop = finish;
  window[key] = owner;
  try {
    hook(q, "submit", function (original, args) {
      const commands = Array.isArray(args[0]) ? [...args[0]] : null;
      const entries = commands?.map((command) => commandOwners.get(command));
      const value = Reflect.apply(original, this, args);
      // Normal untimed game submissions may continue while our final map drains.
      if (!running && entries?.every((entry) => !entry)) return value;
      try {
        actual();
        requireValue(
          this === q && commands?.length > 0 && entries.every(Boolean),
          "Foreign physical command submission",
        );
        const row = add(
          result.submissions,
          limits.submissions,
          {
            id: result.submissions.length + 1,
            at: performance.now(),
            commands: entries.map((entry) => ({ ...entry })),
          },
          "Submission",
        );
        for (const entry of entries) {
          if (entry.encoder) {
            const encoder = result.encoders[entry.encoder - 1];
            requireValue(
              encoder.finished && !encoder.submitted,
              "Repeated/unfinished physical command submission",
            );
            encoder.submitted = true;
          } else {
            const batch = result.batches[entry.batch - 1];
            requireValue(
              batch && batch.submission === null,
              "Repeated physical resolve submission",
            );
            batch.submission = row.id;
          }
        }
      } catch (error) {
        note(error);
      }
      return value;
    });
    hook(d, "createCommandEncoder", function (original, args) {
      const encoder = Reflect.apply(original, this, args);
      if (running && !result.errors.length)
        try {
          requireValue(this === d, "Foreign physical device receiver");
          observeEncoder(encoder, args[0]);
        } catch (error) {
          note(error);
        }
      return encoder;
    });
    hook(b, "initTimestampQuery", function (original, args) {
      // Both actual r186 beginRender/beginCompute call this unconditionally.
      // Tracking stays false, preserving its native no-op and private state.
      const value = Reflect.apply(original, this, args);
      if (running && !result.errors.length)
        try {
          actual();
          const [type, uid, descriptor] = args;
          const match =
            typeof uid === "string" && /^(r|c):\d+:[\d,]+:f(\d+)$/.exec(uid);
          requireValue(
            this === b &&
              activeFrame &&
              ["render", "compute"].includes(type) &&
              match &&
              match[1] === (type === "render" ? "r" : "c") &&
              Number(match[2]) === r.info.frame &&
              !logicalIds.has(uid),
            "Invalid/off-tick logical timestamp association",
          );
          requireValue(
            descriptor && descriptor.timestampWrites === undefined,
            "Foreign logical timestamp descriptor",
          );
          if (!descriptors.has(descriptor)) {
            requireValue(
              descriptors.size < limits.descriptors,
              "Logical descriptor capacity exceeded",
            );
            descriptors.set(
              descriptor,
              Object.getOwnPropertyDescriptor(descriptor, "timestampWrites"),
            );
          }
          const row = add(
            result.logical,
            limits.logical,
            {
              uid,
              type,
              rendererFrame: r.info.frame,
              worldFrame: w.frame,
              at: performance.now(),
            },
            "Logical association",
          );
          logicalIds.add(uid);
          logicalByDescriptor.set(descriptor, row);
        } catch (error) {
          note(error);
        }
      return value;
    });
    hook(r.info, "reset", function (original, args) {
      if (activeFrame) {
        activeFrame.drawCalls += this.render.drawCalls;
        activeFrame.triangles += this.render.triangles;
        activeFrame.infoResets++;
      }
      return Reflect.apply(original, this, args);
    });
    hook(w, "tick", function (original, args) {
      if (!running) return Reflect.apply(original, this, args);
      const at = performance.now();
      anchor ??= at;
      const row = {
        rendererFrame: r.info.frame,
        worldFrameBefore: w.frame,
        worldFrameAfter: null,
        at,
        elapsed: at - anchor,
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
      const start = performance.now();
      let value;
      try {
        value = Reflect.apply(original, this, args);
      } catch (error) {
        note(error);
        finishReason = "native-throw";
        throw error;
      } finally {
        row.cpuMs = performance.now() - start;
        activeFrame = null;
        row.worldFrameAfter = w.frame;
        row.renderPasses = r.info.render.calls - row.renderPasses;
        row.computePasses = r.info.compute.calls - row.computePasses;
        row.drawCalls += r.info.render.drawCalls;
        row.triangles += r.info.render.triangles;
        try {
          actual();
          requireValue(
            r.info.frame === row.rendererFrame &&
              row.worldFrameAfter === row.worldFrameBefore + 1,
            "Physical client frame ownership changed",
          );
          add(result.frames, limits.frames, row, "Client frame");
          for (const pool of poolOwners.values())
            if (at - pool.lastFlush >= 100) flush(pool);
        } catch (error) {
          note(error);
        }
        if (finishReason) finish(finishReason);
        else if (result.errors.length || result.dropped)
          finish("invalid-evidence");
        else if (row.elapsed >= result.warmupMs + result.durationMs)
          finish("duration");
      }
      return value;
    });
    d.addEventListener("uncapturederror", onGpuError);
    listenerInstalled = true;
    watchdog = setTimeout(() => finish("watchdog"), 20000);
  } catch (error) {
    note(error);
    finish("setup-error");
  }
  return done;
}

/** Strict schema-2 ledger validation. Does not reinterpret or repair v1 evidence. */
export function summarizeNativePhysicalGpuFrames(raw) {
  assert.equal(
    raw?.schemaVersion,
    2,
    "Physical schema-2 receipt required; schema1 pass sums are not physical evidence",
  );
  assert.equal(raw.id, "native-physical-gpu-v2");
  assert.equal(raw.stopReason, "duration");
  assert.deepEqual(raw.errors, []);
  assert.equal(raw.dropped, 0);
  assert.equal(raw.warmupMs, 1000);
  assert.equal(raw.durationMs, 10000);
  const limits = {
    frames: 2400,
    logical: 16384,
    segments: 32768,
    encoders: 16384,
    submissions: 16384,
    batches: 1024,
    hooks: 65536,
    descriptors: 1024,
    queries: 2048,
  };
  assert.deepEqual(raw.limits, limits);
  assert.deepEqual(raw.cleanup, {
    drainCompleted: true,
    methodsRestored: true,
    nativeStateUnchanged: true,
    descriptorsUnchanged: true,
    ownersUnchanged: true,
    ownerReleased: true,
    resourcesReleased: true,
    listenerRemoved: true,
    requiresTerminalBrowserCleanup: false,
  });
  const finite = (value) => Number.isFinite(value);
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  assert(
    finite(raw.startedAt) &&
      finite(raw.finishedAt) &&
      raw.finishedAt >= raw.startedAt,
  );
  for (const name of [
    "frames",
    "logical",
    "segments",
    "encoders",
    "submissions",
    "batches",
  ])
    assert(
      Array.isArray(raw[name]) &&
        raw[name].length > 0 &&
        raw[name].length <= limits[name],
      "Bounded " + name + " ledger required",
    );
  assert(raw.frames.length > 1 && raw.frames.at(-1).elapsed >= 11000);
  const frames = new Map(),
    logical = new Map(),
    segments = new Map(),
    encoders = new Map(),
    pools = new Map();
  for (const [i, frame] of raw.frames.entries()) {
    assert(
      integer(frame.rendererFrame) &&
        integer(frame.worldFrameBefore) &&
        frame.worldFrameAfter === frame.worldFrameBefore + 1,
    );
    assert(
      finite(frame.at) &&
        finite(frame.elapsed) &&
        frame.elapsed === frame.at - raw.frames[0].at,
    );
    assert(i === 0 ? frame.elapsed === 0 : frame.at > raw.frames[i - 1].at);
    assert(
      frame.visibility === "visible" && frame.focused === true,
      "Physical capture requires continuously focused visible ticks",
    );
    assert(
      finite(frame.cpuMs) && frame.cpuMs >= 0 && integer(frame.infoResets),
    );
    assert(
      integer(frame.drawCalls) &&
        frame.drawCalls > 0 &&
        finite(frame.triangles) &&
        frame.triangles > 0,
    );
    assert(
      integer(frame.renderPasses) &&
        integer(frame.computePasses) &&
        !frames.has(frame.rendererFrame),
    );
    frames.set(frame.rendererFrame, {
      frame,
      logical: [],
      segments: [],
      intervals: [],
    });
  }
  for (const row of raw.logical) {
    const match =
        typeof row.uid === "string" &&
        /^(r|c):\d+:[\d,]+:f(\d+)$/.exec(row.uid),
      frame = frames.get(row.rendererFrame);
    assert(
      match &&
        frame &&
        ["render", "compute"].includes(row.type) &&
        !logical.has(row.uid),
    );
    assert.equal(match[1], row.type === "render" ? "r" : "c");
    assert.equal(Number(match[2]), row.rendererFrame);
    assert.equal(row.worldFrame, frame.frame.worldFrameAfter);
    assert(finite(row.at) && row.at >= frame.frame.at);
    logical.set(row.uid, { row, segments: [] });
    frame.logical.push(row);
  }
  assert(
    Array.isArray(raw.pools) && raw.pools.length > 0 && raw.pools.length <= 2,
  );
  for (const [i, pool] of raw.pools.entries()) {
    assert.equal(pool.id, i + 1);
    assert(["render", "compute"].includes(pool.type));
    assert(![...pools.values()].some((p) => p.row.type === pool.type));
    assert.equal(pool.count, 2048);
    assert.equal(pool.bytesPerBuffer, 16384);
    for (const key of [
      "querySetDestroyCalled",
      "resolveDestroyCalled",
      "resultDestroyCalled",
      "unmapped",
    ])
      assert.equal(pool[key], true);
    pools.set(pool.id, { row: pool, generation: 0, writes: new Map() });
  }
  for (const [i, encoder] of raw.encoders.entries()) {
    assert.equal(encoder.id, i + 1);
    assert(finite(encoder.at));
    assert.equal(encoder.finished, true);
    assert.equal(encoder.submitted, true);
    assert(
      typeof encoder.label === "string" &&
        encoder.label.length <= 160 &&
        Array.isArray(encoder.segments),
    );
    encoders.set(encoder.id, encoder);
  }
  for (const [i, segment] of raw.segments.entries()) {
    assert.equal(segment.id, i + 1);
    assert.equal(
      segment.uid,
      "physical:" + segment.id + ":f" + segment.rendererFrame,
    );
    const pool = pools.get(segment.pool),
      encoder = encoders.get(segment.encoder),
      frame = frames.get(segment.rendererFrame);
    assert(
      pool &&
        pool.row.type === segment.type &&
        encoder &&
        frame &&
        integer(segment.generation),
    );
    assert(
      integer(segment.queryIndex) &&
        segment.queryIndex % 2 === 0 &&
        segment.queryIndex + 1 < 2048,
    );
    assert.equal(segment.worldFrame, frame.frame.worldFrameAfter);
    assert(
      finite(segment.at) &&
        segment.at >= encoder.at &&
        segment.at >= frame.frame.at,
    );
    assert.equal(segment.nativeStarted, true);
    assert.equal(segment.descriptorPreserved, true);
    assert.equal(segment.immutableWrites, true);
    if (segment.logicalUid !== null) {
      const context = logical.get(segment.logicalUid);
      assert(context, "Missing physical logical association");
      for (const key of ["rendererFrame", "worldFrame", "type"])
        assert.equal(segment[key], context.row[key]);
      assert(segment.at >= context.row.at);
      context.segments.push(segment.id);
    }
    segments.set(segment.id, segment);
    frame.segments.push(segment);
  }
  for (const context of logical.values())
    assert(
      context.segments.length > 0,
      "Logical allocation without a physical segment",
    );
  for (const {
    frame,
    logical: contexts,
    segments: physical,
  } of frames.values()) {
    assert.equal(
      contexts.filter((row) => row.type === "render").length,
      frame.renderPasses,
    );
    assert.equal(
      contexts.filter((row) => row.type === "compute").length,
      frame.computePasses,
    );
    assert(physical.length > 0);
  }
  const batchById = new Map();
  for (const [i, batch] of raw.batches.entries()) {
    assert.equal(batch.id, i + 1);
    assert(pools.has(batch.pool) && integer(batch.generation));
    assert(
      integer(batch.queryCount) &&
        batch.queryCount > 0 &&
        batch.queryCount <= 2048 &&
        batch.queryCount % 2 === 0,
    );
    assert.equal(batch.bytes, batch.queryCount * 8);
    assert.equal(batch.allocations.length * 2, batch.queryCount);
    assert.equal(batch.values.length, batch.queryCount);
    assert(
      batch.resolved &&
        batch.copied &&
        batch.mapped &&
        integer(batch.submission) &&
        batch.submission > 0,
    );
    assert(
      finite(batch.startedAt) &&
        finite(batch.mappedAt) &&
        finite(batch.finishedAt) &&
        batch.startedAt <= batch.mappedAt &&
        batch.mappedAt <= batch.finishedAt,
    );
    batchById.set(batch.id, batch);
  }
  const submittedEncoders = new Set(),
    submittedBatches = new Set(),
    writtenSegments = new Set(),
    resolvedSegments = new Set();
  const timestamp = (value) => {
    assert(
      typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value),
      "Exact uint64 timestamp required",
    );
    const number = BigInt(value);
    assert(number <= 18446744073709551615n);
    return number;
  };
  for (const [i, submission] of raw.submissions.entries()) {
    assert.equal(submission.id, i + 1);
    assert(
      finite(submission.at) &&
        (i === 0 || submission.at >= raw.submissions[i - 1].at),
    );
    assert(
      Array.isArray(submission.commands) && submission.commands.length > 0,
    );
    for (const command of submission.commands) {
      assert(Object.keys(command).length === 1);
      if (command.encoder !== undefined) {
        const encoder = encoders.get(command.encoder);
        assert(encoder && !submittedEncoders.has(encoder.id));
        submittedEncoders.add(encoder.id);
        for (const id of encoder.segments) {
          const segment = segments.get(id);
          assert(
            segment &&
              segment.encoder === encoder.id &&
              !writtenSegments.has(id),
            "Repeated/missing physical segment write",
          );
          assert(segment.at <= submission.at);
          writtenSegments.add(id);
          const pool = pools.get(segment.pool);
          assert.equal(
            segment.generation,
            pool.generation,
            "Physical generation reused out of submission order",
          );
          assert(
            !pool.writes.has(segment.queryIndex),
            "Physical timestamp pair overwritten before resolve",
          );
          pool.writes.set(segment.queryIndex, id);
        }
      } else {
        const batch = batchById.get(command.batch);
        assert(batch && !submittedBatches.has(batch.id));
        submittedBatches.add(batch.id);
        assert.equal(batch.submission, submission.id);
        assert(
          batch.startedAt <= submission.at && submission.at <= batch.mappedAt,
        );
        const pool = pools.get(batch.pool);
        assert.equal(batch.generation, pool.generation);
        assert.equal(
          pool.writes.size * 2,
          batch.queryCount,
          "Resolve does not cover exact submitted physical writes",
        );
        for (const [index, id] of batch.allocations.entries()) {
          const segment = segments.get(id);
          assert(segment && !resolvedSegments.has(id));
          resolvedSegments.add(id);
          assert.equal(pool.writes.get(index * 2), id);
          assert.equal(segment.queryIndex, index * 2);
          assert.equal(segment.pool, batch.pool);
          assert.equal(segment.generation, batch.generation);
          const start = timestamp(batch.values[index * 2]),
            end = timestamp(batch.values[index * 2 + 1]);
          assert(
            end >= start && end - start <= BigInt(Number.MAX_SAFE_INTEGER),
            "Invalid native physical timestamp span",
          );
          frames.get(segment.rendererFrame).intervals.push([start, end]);
        }
        pool.writes.clear();
        pool.generation++;
      }
    }
  }
  assert.equal(submittedEncoders.size, encoders.size);
  assert.equal(submittedBatches.size, batchById.size);
  assert.equal(writtenSegments.size, segments.size);
  assert.equal(resolvedSegments.size, segments.size);
  assert([...pools.values()].every((pool) => pool.writes.size === 0));
  const union = (intervals) => {
    const ordered = [...intervals].sort((a, z) =>
      a[0] < z[0] ? -1 : a[0] > z[0] ? 1 : a[1] < z[1] ? -1 : 1,
    );
    let sum = 0n,
      total = 0n,
      low = null,
      high = null;
    for (const [start, end] of ordered) {
      sum += end - start;
      if (low === null) {
        low = start;
        high = end;
      } else if (start <= high) {
        if (end > high) high = end;
      } else {
        total += high - low;
        low = start;
        high = end;
      }
    }
    if (low !== null) total += high - low;
    return {
      sumNs: sum.toString(),
      unionNs: total.toString(),
      overlapNs: (sum - total).toString(),
    };
  };
  const measured = [...frames.values()].filter(
    ({ frame }) => frame.elapsed >= 1000 && frame.elapsed < 11000,
  );
  assert(measured.length > 1);
  const distribution = (values) => {
    const ordered = [...values].sort((a, z) => a - z);
    assert(ordered.length > 0 && ordered.every(finite));
    const percentile = (p) => ordered[Math.ceil(p * ordered.length) - 1];
    return {
      count: ordered.length,
      min: ordered[0],
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: ordered.at(-1),
    };
  };
  const intervals = measured
    .map(({ frame }, i) => (i ? frame.at - measured[i - 1].frame.at : null))
    .slice(1);
  assert(intervals.every((value) => value > 0));
  const physicalFrames = measured.map((row) => ({
    rendererFrame: row.frame.rendererFrame,
    physicalSegments: row.segments.length,
    ...union(row.intervals),
  }));
  // Individual short/auxiliary segments can quantize to zero. A complete
  // rendered terrain tick with no positive interval is unavailable evidence,
  // not a zero-cost frame (unwritten/invalid native queries can also read zero).
  assert(
    physicalFrames.every((frame) => BigInt(frame.unionNs) > 0n),
    "Physical timestamp frame has no positive observed interval; timing unavailable",
  );
  const milliseconds = (value) => {
    const ns = BigInt(value);
    assert(ns >= 0n && ns <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(ns) / 1e6;
  };
  return {
    schemaVersion: 2,
    id: raw.id,
    complete: true,
    performanceApproved: false,
    measuredFrames: measured.length,
    physicalSegments: segments.size,
    logicalContexts: logical.size,
    auxiliarySegments: raw.segments.filter(
      (segment) => segment.logicalUid === null,
    ).length,
    measuredSpanMs: measured.at(-1).frame.at - measured[0].frame.at,
    cpuTickMs: distribution(measured.map(({ frame }) => frame.cpuMs)),
    clientTickIntervalMs: distribution(intervals),
    drawCalls: distribution(measured.map(({ frame }) => frame.drawCalls)),
    triangles: distribution(measured.map(({ frame }) => frame.triangles)),
    observedPassUnionMs: distribution(
      physicalFrames.map((frame) => milliseconds(frame.unionNs)),
    ),
    observedPassOverlapMs: distribution(
      physicalFrames.map((frame) => milliseconds(frame.overlapNs)),
    ),
    physicalFrames,
    allObserved: union([...frames.values()].flatMap((row) => row.intervals)),
    scope: raw.scope,
    observerReadbackBatches: raw.batches.length,
  };
}

// Independent CPU-only diagnostic. Historical GPU schemas above stay intact.
// Self-contained so native console delivery does not need the Node summarizers.
export function installNativeCpuFrameObserver(
  { durationMs = 30000, maxRows = 12000, label = "metal-cpu" } = {},
  // Default-parameter scope cannot reference observer-body bindings. Creating
  // these reactions in a body-local factory could retain that body's context.
  createDeviceLossCallbacks = function createNativeCpuDeviceLossCallbacks() {
    // No handler argument: the factory's own arguments cannot retain it either.
    const cell = { handler: null, retired: false };
    return Object.freeze({
      attach(handler) {
        if (
          cell.retired ||
          cell.handler !== null ||
          typeof handler !== "function"
        ) {
          throw Error("Device-loss handler requires an unused live cell");
        }
        cell.handler = handler;
      },
      fulfilled(value) {
        cell.handler?.("fulfilled", value);
      },
      rejected(error) {
        cell.handler?.("rejected", error);
      },
      clear() {
        cell.handler = null;
        cell.retired = true;
      },
      isCleared() {
        return cell.retired && cell.handler === null;
      },
    });
  },
) {
  const key = "__HYPERIA_NATIVE_CPU_FRAME_OBSERVER02__";
  const need = (ok, message) => {
    if (!ok) throw Error("Native CPU observer: " + message);
  };
  need(
    Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 60000,
    "duration must be 1–60 seconds",
  );
  need(
    Number.isSafeInteger(maxRows) && maxRows >= 2 && maxRows <= 20000,
    "bounded row capacity required",
  );
  need(
    typeof label === "string" && /^[\w-]{1,64}$/.test(label),
    "bounded label required",
  );
  const w = window.world,
    g = w?.graphics,
    r = g?.renderer,
    b = r?.backend;
  const device = b?.device,
    camera = w?.camera,
    scene = w?.stage?.scene;
  const runtime = w?.getSystem("client-runtime"),
    cameraSystem = w?.getSystem("client-camera-system");
  const player = w?.entities?.player,
    terrain = w?.getSystem("terrain");
  const gate = g?.opaqueLoadingRenderGate,
    water = terrain?.waterSystem;
  need(
    !Object.hasOwn(window, key) &&
      !Object.hasOwn(window, "__HYPERIA_NATIVE_CPU_FRAME_OBSERVER01__") &&
      w &&
      g &&
      r &&
      b?.isWebGPUBackend &&
      device &&
      !r._isDeviceLost,
    "exclusive live WebGPU owner required",
  );
  const noGpuObserver = () =>
    b.trackTimestamp === false &&
    b.timestampQueryPool.render === null &&
    b.timestampQueryPool.compute === null &&
    !window.__HYPERIA_GPU_FRAME_PROBE01__ &&
    !window.__HYPERIA_GPU_PHYSICAL_PROBE02__ &&
    !window.__HYPERIA_NORMAL_PLAYER_PASS_TIMING235__ &&
    !window.__pondReview?.nativePassTiming;
  need(noGpuObserver(), "CPU-only capture requires no active GPU observer");
  need(
    player &&
      w.entities.get(player.id) === player &&
      player.data.owner === w.network.id,
    "registered local player required",
  );
  need(
    runtime && cameraSystem && camera && scene && terrain && water && gate,
    "actual runtime, camera, terrain and gate owners required",
  );
  need(
    typeof w.tick === "function" &&
      typeof g.render === "function" &&
      typeof r.getAnimationLoop === "function",
    "ordinary native loop required",
  );
  need(
    [
      "owner",
      "destroyed",
      "generation",
      "successfulPrimarySubmissions",
      "skippedSubmissions",
    ].every((name) => Object.hasOwn(gate, name)),
    "source-owned loading gate fields required",
  );
  need(
    [
      "streamRenderFramePacer",
      "forcedTickInterval",
      "disableVisibilityThrottle",
    ].every((name) => Object.hasOwn(runtime, name)),
    "source-owned runtime pacing fields required",
  );
  const columns = Object.freeze([
    "tickStartMs",
    "tickEndMs",
    "tickCpuMs",
    "tickStartIntervalMs",
    "tickCompletionIntervalMs",
    "graphicsRenderCpuMs",
    "graphicsRenderCalls",
    "firstRenderStartMs",
    "lastRenderEndMs",
    "worldFrameBefore",
    "worldFrameAfter",
    "rendererFrameBefore",
    "rendererFrameAfter",
    "rendererRenderCallsDelta",
    "successfulPrimarySubmissionsDelta",
    "inputTimestampMs",
    "visible",
    "focused",
    "nativeThrew",
  ]);
  const stride = columns.length,
    rows = new Float64Array(maxRows * stride);
  const hooks = [],
    errors = [],
    clockAlignments = [];
  const deviceLossCallbacks = createDeviceLossCallbacks();
  const installedAt = performance.now(),
    installDeadline = installedAt + 120000;
  const timeOrigin = performance.timeOrigin,
    href = location.href;
  const originalRendererRender = r.render,
    originalBackendDraw = b.draw,
    originalBackendBegin = b.beginRender;
  const composer = g.composer,
    composerRender = composer?.render,
    cameraParent = camera.parent;
  const animationLoop = r.getAnimationLoop(),
    pacer = runtime.streamRenderFramePacer;
  const pacerInterval = pacer?.intervalMs ?? null,
    disableThrottle = runtime.disableVisibilityThrottle;
  const gateGeneration = gate.generation;
  const quality = () => [
    r.getPixelRatio(),
    r.domElement.width,
    r.domElement.height,
    g.width,
    g.height,
    r.samples,
    r.shadowMap.enabled,
    r.shadowMap.type,
    w.prefs?.shadows,
    g.usePostprocessing,
    w.prefs?.postprocessing,
    w.prefs?.bloom,
    w.prefs?.colorGrading,
    w.prefs?.colorGradingIntensity,
    w.prefs?.depthBlur,
    w.prefs?.depthBlurIntensity,
    w.prefs?.depthBlurDistance,
    w.prefs?.waterReflections,
    water.reflectionsEnabled,
    r.toneMapping,
    r.outputColorSpace,
    composer?.getCurrentLUT?.() ?? null,
    composer?.isLUTEnabled?.() ?? null,
    composer?.isDepthBlurEnabled?.() ?? null,
  ];
  const initialQuality = quality();
  need(
    initialQuality[0] === 2 &&
      r.domElement.width === Math.floor(g.width * 2) &&
      r.domElement.height === Math.floor(g.height * 2) &&
      r.samples === 4,
    "native 2x/MSAA4 quality required",
  );
  need(
    typeof animationLoop === "function" && runtime.forcedTickInterval === null,
    "ordinary active animation loop required",
  );
  const qualityNames = [
    "pixelRatio",
    "canvasWidth",
    "canvasHeight",
    "logicalWidth",
    "logicalHeight",
    "samples",
    "shadowsEnabled",
    "shadowMapType",
    "shadowPreference",
    "postprocessingRoute",
    "postprocessingPreference",
    "bloom",
    "colorGrading",
    "colorGradingIntensity",
    "depthBlur",
    "depthBlurIntensity",
    "depthBlurDistance",
    "waterReflectionsPreference",
    "waterReflectionsEnabled",
    "toneMapping",
    "outputColorSpace",
    "lut",
    "lutEnabled",
    "depthBlurEnabled",
  ];
  const routeParams = new URLSearchParams(location.search);
  const route = {
    origin: location.origin,
    pathname: location.pathname,
    parameters: Object.fromEntries(
      [
        "page",
        "mode",
        "embedded",
        "streamFps",
        "streamRenderProfile",
        "disableVisibilityThrottle",
      ]
        .filter((name) => routeParams.has(name))
        .map((name) => [name, routeParams.get(name)]),
    ),
  };
  let state = "installed",
    count = 0,
    activeTick = null,
    renderDepth = 0,
    startedAt = null,
    finishedAt = null;
  let lastStart = null,
    lastEnd = null,
    lastWorldFrame = null,
    lastRendererFrame = null;
  let stopReason = null,
    errorOverflow = 0,
    cleanup = null,
    finalMetadata = null;
  let initialMetadata = null,
    startTimer = null,
    runTimer = null,
    watchdog = null,
    registered = false;
  let listenersInstalled = false,
    deviceLoss = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const errorText = (error) => {
    try {
      return String(error instanceof Error ? error.message : error);
    } catch {
      return "Unprintable diagnostic/native error";
    }
  };
  const note = (error) => {
    if (errors.length < 16) errors.push(errorText(error));
    else errorOverflow++;
  };
  const alignment = (phase) => {
    const before = performance.now(),
      unixMs = Date.now(),
      after = performance.now();
    clockAlignments.push({
      phase,
      performanceBeforeMs: before,
      unixMs,
      performanceAfterMs: after,
      timeOriginMs: performance.timeOrigin,
    });
  };
  const metadata = () => {
    const currentQuality = quality();
    return {
      atMs: performance.now(),
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      worldFrame: w.frame,
      rendererFrame: r.info.frame,
      gate: gate.getStatus(),
      camera: {
        id: camera.id,
        parentId: camera.parent?.id ?? null,
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
      },
      player: { id: player.id, position: player.position.toArray() },
      exposure: r.toneMappingExposure,
      phase: w.getSystem("environment")?.skySystem?.dayPhase ?? null,
      pacing: {
        streamPacerActive: runtime.streamRenderFramePacer !== null,
        intervalMs: runtime.streamRenderFramePacer?.intervalMs ?? null,
        forcedTickIntervalActive: runtime.forcedTickInterval !== null,
        disableVisibilityThrottle: runtime.disableVisibilityThrottle,
      },
      quality: Object.fromEntries(
        qualityNames.map((name, index) => [name, currentQuality[index]]),
      ),
    };
  };
  const sameDescriptor = (a, z) =>
    a === undefined
      ? z === undefined
      : Boolean(
          z &&
          [
            "value",
            "writable",
            "enumerable",
            "configurable",
            "get",
            "set",
          ].every((name) => a[name] === z[name]),
        );
  const guard = () => {
    need(noGpuObserver(), "GPU observer appeared during CPU-only capture");
    need(
      window.world === w &&
        w.graphics === g &&
        g.renderer === r &&
        r.backend === b &&
        b.device === device &&
        !r._isDeviceLost,
      "renderer owner/device changed",
    );
    need(
      w.entities.player === player &&
        w.entities.get(player.id) === player &&
        player.data.owner === w.network.id &&
        w.camera === camera &&
        camera.parent === cameraParent &&
        w.stage.scene === scene &&
        w.getSystem("client-camera-system") === cameraSystem,
      "player/camera/scene owner changed",
    );
    need(
      w.getSystem("terrain") === terrain &&
        terrain.waterSystem === water &&
        g.opaqueLoadingRenderGate === gate &&
        w.getSystem("client-runtime") === runtime,
      "system owner changed",
    );
    need(
      r.render === originalRendererRender &&
        b.draw === originalBackendDraw &&
        b.beginRender === originalBackendBegin &&
        g.composer === composer &&
        composer?.render === composerRender &&
        r.getAnimationLoop() === animationLoop,
      "render/loop owner changed",
    );
    need(
      hooks.every((hook) => hook.owner[hook.name] === hook.wrapper) &&
        (!registered || window[key] === controller),
      "diagnostic hook owner changed",
    );
    need(
      location.href === href &&
        performance.timeOrigin === timeOrigin &&
        runtime.streamRenderFramePacer === pacer &&
        (pacer?.intervalMs ?? null) === pacerInterval &&
        runtime.disableVisibilityThrottle === disableThrottle &&
        runtime.forcedTickInterval === null,
      "route/pacing changed",
    );
    need(
      !document.hidden &&
        document.visibilityState === "visible" &&
        document.hasFocus(),
      "document hidden or unfocused",
    );
    need(
      gate.owner === null &&
        gate.destroyed === false &&
        gate.generation === gateGeneration,
      "loading cover changed",
    );
    need(
      quality().every((value, index) =>
        Object.is(value, initialQuality[index]),
      ),
      "quality changed",
    );
  };
  const snapshot = ({ includeRows = false } = {}) => {
    need(
      !includeRows || state === "finished",
      "raw rows available only after cleanup",
    );
    return {
      schemaVersion: "cpu-only-2",
      diagnosticRevision: "detached-device-loss-cell-2",
      ownerKey: key,
      label,
      state,
      durationMs,
      maxRows,
      rowsRecorded: count,
      columns,
      installedAtMs: installedAt,
      startedAtMs: startedAt,
      finishedAtMs: finishedAt,
      stopReason,
      clockAlignments: [...clockAlignments],
      route,
      initialMetadata,
      finalMetadata,
      cleanup,
      errors: [...errors],
      errorOverflow,
      deviceLoss,
      ...(includeRows
        ? { rows: Array.from(rows.subarray(0, count * stride)) }
        : {}),
      scope:
        "Complete synchronous world.tick and graphics.render CPU call spans with instrumentation overhead; successful primary CPU submissions, not GPU completion or physical presentation FPS. Camera and time remain live. No per-draw observer, GPU query, readback, wait, manual render, or quality mutation. Timestamp alignment is a bracketed wall-clock observation, not a proven cross-process Metal clock mapping.",
      retentionScope:
        "Pending device-loss reactions retain a small retired handler cell and may retain the default-parameter options/arguments, but cannot lexically access observer-body rows/world. Supply only scalar duration/maxRows/label options. Clearing the cell detaches the body handler; retained controller/done receipts still intentionally retain their own data. No heap collection or full-memory-release claim.",
    };
  };
  const finish = (reason) => {
    if (state === "finished") return;
    stopReason ??= reason;
    if (activeTick || renderDepth) {
      state = "stopping";
      return;
    }
    if (startedAt !== null) {
      try {
        guard();
      } catch (error) {
        note(error);
        stopReason =
          stopReason === "duration" ? "invalid-evidence" : stopReason;
      }
    }
    state = "finished";
    clearTimeout(startTimer);
    clearTimeout(runTimer);
    clearTimeout(watchdog);
    // Break the only reaction-to-observer reference before cleanup resolves.
    deviceLossCallbacks.clear();
    try {
      finalMetadata = metadata();
      alignment("finished");
    } catch (error) {
      note(error);
    }
    let restored = true;
    for (const hook of hooks.slice().reverse()) {
      try {
        if (hook.owner[hook.name] !== hook.wrapper) {
          restored = false;
          note("Foreign hook not overwritten: " + hook.name);
          continue;
        }
        if (hook.descriptor)
          Object.defineProperty(hook.owner, hook.name, hook.descriptor);
        else delete hook.owner[hook.name];
        if (
          !sameDescriptor(
            Object.getOwnPropertyDescriptor(hook.owner, hook.name),
            hook.descriptor,
          ) ||
          hook.owner[hook.name] !== hook.original
        ) {
          restored = false;
          note("Descriptor restoration failed: " + hook.name);
        }
      } catch (error) {
        restored = false;
        note(error);
      }
    }
    if (listenersInstalled) {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      device.removeEventListener("uncapturederror", onGpuError);
      listenersInstalled = false;
    }
    if (registered && window[key] === controller) {
      delete window[key];
      registered = false;
    } else if (registered) {
      restored = false;
      note("Foreign diagnostic owner not overwritten");
    }
    cleanup = {
      hooksRestored: restored,
      exactDescriptors: hooks.every((hook) =>
        sameDescriptor(
          Object.getOwnPropertyDescriptor(hook.owner, hook.name),
          hook.descriptor,
        ),
      ),
      ownerAbsent: !Object.hasOwn(window, key),
      listenersRemoved: !listenersInstalled,
      deviceLossObservationStopped: deviceLossCallbacks.isCleared(),
      deviceLossHandlerCleared: deviceLossCallbacks.isCleared(),
    };
    finishedAt = performance.now();
    resolveDone(snapshot({ includeRows: true }));
  };
  const fail = (error) => {
    note(error);
    try {
      finish("invalid-evidence");
    } catch (cleanupError) {
      note(cleanupError);
    }
  };
  const onVisibility = () => {
    if (
      state === "running" &&
      (document.hidden || document.visibilityState !== "visible")
    )
      fail("document-hidden");
  };
  const onBlur = () => {
    if (state === "running") fail("document-unfocused");
  };
  const onPageHide = () => finish("pagehide");
  const onGpuError = (event) =>
    fail("uncaptured GPU error: " + errorText(event.error));
  const patch = (owner, name, make) => {
    const original = owner[name],
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
    need(
      typeof original === "function" &&
        (descriptor
          ? descriptor.configurable === true
          : Object.isExtensible(owner)),
      "restorable method required: " + name,
    );
    const wrapper = make(original);
    Object.defineProperty(owner, name, {
      value: wrapper,
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
    });
    hooks.push({ owner, name, original, descriptor, wrapper });
  };
  const controller = Object.freeze({
    done,
    snapshot,
    stop: (reason = "requested") => {
      finish(reason);
      return done;
    },
    start({ delayMs = 0 } = {}) {
      need(state === "installed", "one run per installation");
      need(
        Number.isFinite(delayMs) &&
          delayMs >= 0 &&
          delayMs <= 30000 &&
          performance.now() + delayMs + durationMs + 1000 < installDeadline,
        "bounded delayed start must fit installation lifetime",
      );
      state = "armed";
      const begin = () => {
        if (state !== "armed") return;
        try {
          guard();
          need(
            g.isPrecompileIdle() &&
              terrain.getStreamingVisualReadiness().ready &&
              window.__HYPERIA_LOADING__?.ready,
            "fully admitted warm world required",
          );
          initialMetadata = metadata();
          alignment("started");
          startedAt = performance.now();
          state = "running";
          runTimer = setTimeout(() => finish("duration"), durationMs);
        } catch (error) {
          fail(error);
        }
      };
      if (delayMs) startTimer = setTimeout(begin, delayMs);
      else begin();
      return {
        armed: state === "armed" || state === "running",
        delayMs,
        durationMs,
        installDeadlineMs: installDeadline,
      };
    },
  });
  try {
    alignment("installed");
    patch(
      g,
      "render",
      (original) =>
        function (...args) {
          if (state !== "running" && !activeTick)
            return Reflect.apply(original, this, args);
          const row = activeTick,
            start = performance.now();
          renderDepth++;
          if (!row || renderDepth !== 1 || this !== g)
            fail("off-tick, nested or foreign-this graphics render");
          if (row) {
            row.renderCalls++;
            row.firstRenderStart ??= start;
          }
          try {
            return Reflect.apply(original, this, args);
          } catch (error) {
            fail("graphics.render threw: " + errorText(error));
            throw error;
          } finally {
            const end = performance.now();
            if (row) {
              row.renderCpuMs += end - start;
              row.lastRenderEnd = end;
            }
            renderDepth--;
            if (state === "stopping" && !activeTick) finish(stopReason);
          }
        },
    );
    patch(
      w,
      "tick",
      (original) =>
        function (...args) {
          if (state !== "running") return Reflect.apply(original, this, args);
          if (performance.now() - startedAt >= durationMs) {
            finish("duration");
            return Reflect.apply(original, this, args);
          }
          if (activeTick) {
            fail("nested world tick");
            return Reflect.apply(original, this, args);
          }
          try {
            guard();
            need(
              this === w && count < maxRows,
              "tick ownership or row capacity exceeded",
            );
          } catch (error) {
            fail(error);
            return Reflect.apply(original, this, args);
          }
          const beforeFrame = w.frame,
            beforeRenderer = r.info.frame,
            beforeCalls = r.info.render.calls;
          const beforePrimary = gate.successfulPrimarySubmissions;
          const row = {
            renderCalls: 0,
            renderCpuMs: 0,
            firstRenderStart: null,
            lastRenderEnd: null,
            threw: false,
          };
          activeTick = row;
          const start = performance.now();
          try {
            return Reflect.apply(original, this, args);
          } catch (error) {
            row.threw = true;
            fail("world.tick threw: " + errorText(error));
            throw error;
          } finally {
            const end = performance.now();
            activeTick = null;
            try {
              const values = [
                start,
                end,
                end - start,
                lastStart === null ? NaN : start - lastStart,
                lastEnd === null ? NaN : end - lastEnd,
                row.renderCpuMs,
                row.renderCalls,
                row.firstRenderStart ?? NaN,
                row.lastRenderEnd ?? NaN,
                beforeFrame,
                w.frame,
                beforeRenderer,
                r.info.frame,
                r.info.render.calls - beforeCalls,
                gate.successfulPrimarySubmissions - beforePrimary,
                typeof args[0] === "number" ? args[0] : NaN,
                !document.hidden && document.visibilityState === "visible"
                  ? 1
                  : 0,
                document.hasFocus() ? 1 : 0,
                row.threw ? 1 : 0,
              ];
              rows.set(values, count++ * stride);
              guard();
              need(
                Number.isSafeInteger(w.frame) &&
                  w.frame === beforeFrame + 1 &&
                  (lastWorldFrame === null || w.frame === lastWorldFrame + 1),
                "world frame discontinuity",
              );
              need(
                Number.isSafeInteger(beforeRenderer) &&
                  r.info.frame === beforeRenderer &&
                  (lastRendererFrame === null ||
                    beforeRenderer > lastRendererFrame),
                "renderer frame discontinuity",
              );
              need(
                row.renderCalls === 1 && values[13] > 0 && values[14] === 1,
                "expected one successful ordinary primary submission",
              );
              lastStart = start;
              lastEnd = end;
              lastWorldFrame = w.frame;
              lastRendererFrame = r.info.frame;
              if (count === maxRows) fail("row capacity reached");
            } catch (error) {
              fail(error);
            }
            if (state === "stopping") finish(stopReason);
          }
        },
    );
    Object.defineProperty(window, key, {
      value: controller,
      configurable: true,
    });
    registered = true;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    device.addEventListener("uncapturederror", onGpuError);
    listenersInstalled = true;
    watchdog = setTimeout(() => finish("installation-watchdog"), 120000);
    deviceLossCallbacks.attach((kind, value) => {
      if (kind === "fulfilled") {
        deviceLoss = { reason: value.reason, message: value.message };
        fail("GPU device lost");
      } else fail(value);
    });
    device.lost.then(
      deviceLossCallbacks.fulfilled,
      deviceLossCallbacks.rejected,
    );
    return controller;
  } catch (error) {
    fail(error);
    throw error;
  }
}

// Pure arithmetic only. This does not manufacture or certify native evidence.
export function summarizeNativeCpuFrameRows(columns, rows) {
  assert(Array.isArray(columns) && Array.isArray(rows));
  assert.equal(new Set(columns).size, columns.length);
  assert(columns.length > 0 && rows.length % columns.length === 0);
  const index = (name) => {
    const value = columns.indexOf(name);
    assert(value >= 0, "Missing CPU column: " + name);
    return value;
  };
  const field = (name) => {
    const at = index(name);
    return Array.from(
      { length: rows.length / columns.length },
      (_, i) => rows[i * columns.length + at],
    );
  };
  const distribution = (values) => {
    assert(values.every((value) => Number.isFinite(value) && value >= 0));
    const ordered = [...values].sort((a, b) => a - b);
    const pick = (p) =>
      ordered.length ? ordered[Math.ceil(p * ordered.length) - 1] : null;
    return {
      samples: ordered.length,
      min: ordered[0] ?? null,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      max: ordered.at(-1) ?? null,
    };
  };
  const starts = field("tickStartMs"),
    ends = field("tickEndMs"),
    ticks = field("tickCpuMs"),
    renders = field("graphicsRenderCpuMs");
  for (let i = 0; i < starts.length; i++) {
    assert(
      Number.isFinite(starts[i]) &&
        starts[i] >= 0 &&
        Number.isFinite(ends[i]) &&
        ends[i] >= starts[i],
    );
    assert.equal(ticks[i], ends[i] - starts[i]);
    assert(
      renders[i] <= ticks[i],
      "Render CPU span cannot exceed its enclosing tick",
    );
    if (i) assert(starts[i] >= ends[i - 1] && ends[i] >= ends[i - 1]);
  }
  return {
    frames: starts.length,
    tickCpuMs: distribution(ticks),
    graphicsRenderCpuMs: distribution(renders),
    startCadenceMs: distribution(
      starts.slice(1).map((value, i) => value - starts[i]),
    ),
    completionCadenceMs: distribution(
      ends.slice(1).map((value, i) => value - ends[i]),
    ),
    performanceApproved: false,
    scope:
      "CPU row arithmetic only; no lifecycle, visibility, native capture or GPU/presentation certification.",
  };
}
