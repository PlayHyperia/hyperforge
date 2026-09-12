import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as study from "./native-gpu-frame-probe.mjs";
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Pure accounting vectors, not a mock renderer/clock or a performance result.
function queryAccountingVector() {
  const frames = [0, 1000, 6000, 10999, 11000].map((elapsed, i) => ({
    rendererFrame: i + 1,
    worldFrameBefore: 40 + i,
    worldFrameAfter: 41 + i,
    at: 500 + elapsed,
    elapsed,
    cpuMs: i + 1,
    visibility: "visible",
    focused: true,
    renderPasses: 1,
    computePasses: 1,
    drawCalls: 20,
    triangles: 1000,
    infoResets: 1,
  }));
  const passes = frames.flatMap((f) =>
    ["render", "compute"].map((type) => ({
      type,
      uid: (type === "render" ? "r" : "c") + ":1:7:f" + f.rendererFrame,
      rendererFrame: f.rendererFrame,
      worldFrame: f.worldFrameAfter,
    })),
  );
  const batches = ["render", "compute"].map((type) => ({
    type,
    queryCount: 10,
    startedAt: 1,
    finishedAt: 2,
    values: passes
      .filter((p) => p.type === type)
      .map((p, i) => ({
        uid: p.uid,
        ms: type === "render" ? [20, 2, 4, 8, 30][i] : 0.1,
      })),
  }));
  return {
    schemaVersion: 1,
    stopReason: "duration",
    dropped: 0,
    errors: [],
    warmupMs: 1000,
    durationMs: 10000,
    cleanup: {
      tickRestored: true,
      resetRestored: true,
      queryRestored: true,
      trackingRestored: true,
      descriptorsRestored: true,
      poolsRestored: true,
    },
    frames,
    passes,
    batches,
    pools: ["render", "compute"].map((type) => ({
      type,
      disposed: true,
      maxQueries: 2048,
      querySetCount: 2048,
      bufferBytes: 32768,
    })),
  };
}
test("GPU accounting groups every render/compute pass per actual frame, not just the last async result", () => {
  const raw = queryAccountingVector(),
    before = structuredClone(raw),
    s = study.summarizeNativeGpuFrames(raw);
  assert.deepEqual(raw, before);
  assert.equal(s.measuredFrames, 3);
  assert.equal(s.resolvedPasses, 10);
  assert.deepEqual(s.renderGpuMs, {
    count: 3,
    min: 2,
    p50: 4,
    p95: 8,
    p99: 8,
    max: 8,
  });
  assert.equal(s.totalPassGpuMs.p50, 4.1);
  assert.equal(s.totalPassGpuMs.p95, 8.1);
  assert.equal(s.cpuTickMs.p50, 3);
  assert.equal(s.performanceApproved, false);
});
test("GPU accounting rejects missing, duplicate, negative, off-tick and unclean evidence", () => {
  const corrupt = [
    (r) => r.batches[0].values.pop(),
    (r) => r.batches.push(r.batches[0]),
    (r) => (r.batches[0].values[0].ms = -0.1),
    (r) => (r.batches[0].values[0].ms = NaN),
    (r) => (r.passes[0].worldFrame = null),
    (r) => (r.passes[0].uid = "r:1:7:f999"),
    (r) => r.passes.push(r.passes[0]),
    (r) => r.frames[1].renderPasses++,
    (r) => (r.frames[1].focused = false),
    (r) => (r.frames[1].visibility = "hidden"),
    (r) => (r.cleanup = {}),
    (r) => (r.cleanup.descriptorsRestored = false),
    (r) => (r.cleanup.resetRestored = false),
    (r) => (r.frames[1].drawCalls = 0),
    (r) => (r.frames[1].triangles = NaN),
    (r) => (r.frames[1].infoResets = -1),
    (r) => (r.pools[0].disposed = false),
    (r) => r.pools.pop(),
    (r) => r.dropped++,
    (r) => r.errors.push("overflow"),
    (r) => (r.stopReason = "watchdog"),
    (r) => (r.frames.at(-1).elapsed = 10999),
  ];
  for (const mutate of corrupt) {
    const raw = queryAccountingVector();
    mutate(raw);
    assert.throws(() => study.summarizeNativeGpuFrames(raw));
  }
});
test("native probe retains the client loop and cached pass-descriptor ownership", () => {
  const src = study.measureNativeGpuFrames.toString().replace(/\s+/g, "");
  for (const forbidden of [
    "setAnimationLoop(",
    "requestAdapter(",
    "requestDevice(",
    "setPixelRatio(",
    "onSubmittedWorkDone(",
    "renderer.render(",
  ])
    assert(!src.includes(forbidden));
  for (const required of [
    "Reflect.apply(originalTick,this,args)",
    "Reflect.apply(originalQuery, this, [type, uid, descriptor])",
    "pool.resolveQueriesAsync()",
    "await pool.dispose()",
    "delete descriptor.timestampWrites",
    "backend.trackTimestamp = false",
    "Reflect.apply(originalReset,this,args)",
    "r.info.render.calls - row.renderPasses",
    "activeFrame.drawCalls += this.render.drawCalls",
    "result.warmupMs + result.durationMs",
  ])
    assert(src.includes(required.replace(/\s+/g, "")));
});
test("actual Three info reset clears frame counts, but retains lifetime render/compute calls", async () => {
  const { default: Info } = await import(
    pathToFileURL(
      path.join(repo, "node_modules/three/src/renderers/common/Info.js"),
    ).href
  );
  const { Mesh, BoxGeometry, MeshBasicMaterial } = await import(
    pathToFileURL(path.join(repo, "node_modules/three/build/three.core.js"))
      .href
  );
  const info = new Info(),
    geometry = new BoxGeometry(),
    material = new MeshBasicMaterial(),
    mesh = new Mesh(geometry, material);
  try {
    info.update(mesh, geometry.index.count, 3);
    assert.equal(info.render.drawCalls, 1);
    assert.equal(info.render.triangles, 36);
    // Counter initialization is a unit input, not a simulated renderer/performance measurement.
    info.render.calls = 12;
    info.compute.calls = 4;
    info.render.frameCalls = 6;
    info.compute.frameCalls = 2;
    info.reset();
    assert.equal(info.render.calls, 12);
    assert.equal(info.compute.calls, 4);
    for (const key of ["drawCalls", "triangles", "frameCalls"])
      assert.equal(info.render[key], 0);
    assert.equal(info.compute.frameCalls, 0);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
test("timestamp admission matches the actual r186 backend constructor, not an assumed empty object", async () => {
  const { WebGPUBackend } = await import(
    pathToFileURL(path.join(repo, "node_modules/three/build/three.webgpu.js"))
      .href
  );
  const backend = new WebGPUBackend();
  assert.equal(backend.trackTimestamp, false);
  assert.deepEqual(backend.timestampQueryPool, { render: null, compute: null });
  const descriptors = Object.getOwnPropertyDescriptors(
    backend.timestampQueryPool,
  );
  for (const type of ["render", "compute"])
    assert.deepEqual(descriptors[type], {
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  assert(
    study.measureNativeGpuFrames
      .toString()
      .replace(/\s+/g, "")
      .includes("Object.defineProperty(pools,type,poolDescriptors[type])"),
  );
});
