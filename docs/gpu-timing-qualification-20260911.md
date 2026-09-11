# GPU timing qualification: implementation brief

Date: 2026-09-11. Status: **source audit and proposed implementation only**. This
diagnostic is not implemented, and the identified query-coverage risk has not
been reproduced on a native GPU. Existing RAF cadence and render counters are
not GPU timing. Nothing here qualifies whole-frame latency, compositor/display
latency, FPS, or production performance.

## Verified installed r186 behavior

References below are repository-relative paths and installed-source line numbers,
not claims about a future Three release. The installed backend includes the
project's existing r186 patches.

| Concern                        | Source and finding                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in                         | `node_modules/three/src/renderers/common/Backend.js:76`: constructor `trackTimestamp` defaults to false.                                                                                                                                                                                                       |
| Device feature                 | `node_modules/three/src/renderers/webgpu/WebGPUBackend.js:242–298`: normal device creation requests supported known features, then gates tracking on actual `timestamp-query` support. An externally supplied device must already have the feature.                                                            |
| Misleading capability shortcut | `WebGPUBackend.js:394`: `hasTimestamp` always returns true. Admission must instead check the initialized renderer's `hasFeature('timestamp-query')`, actual device features, and construction intent.                                                                                                          |
| Fixed pools                    | `WebGPUBackend.js:2594–2597`: lazy, separate render/compute pools, each with 2,048 queries, or 1,024 begin/end pairs.                                                                                                                                                                                          |
| Fixed buffers                  | `node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js:33–55`: one query set and two 16KiB buffers per pool. Both pools total **64KiB of buffer allocation**, plus implementation-dependent query storage and bounded JavaScript bookkeeping. This is not a total process-memory estimate. |
| Frame identity                 | `Backend.js:476–500` builds context UIDs with renderer frame IDs; `node_modules/three/src/renderers/common/Animation.js:81–85` advances that frame. Renderer frames, actual rendered calls, and observer RAF samples are distinct.                                                                             |
| Scalar meaning                 | `WebGPUTimestampQueryPool.js:207–237` stores per-UID durations, groups them by renderer frame, and returns the **last resolved frame's sum**. It does not return the whole resolve-batch sum or elapsed queue interval.                                                                                        |
| Async readback                 | `WebGPUTimestampQueryPool.js:104–119,148–184`: concurrent resolves share pending work; query resolution and buffer copy are submitted before asynchronous mapping. CPU-visible mapping latency is not GPU pass duration.                                                                                       |
| Staleness                      | `WebGPUTimestampQueryPool.js:98–100,142–145,177–195,239–248`: empty, disposed, mapping-conflict and caught-error paths can return the previous `lastValue`. Promise fulfillment and `renderer.info.render.timestamp` alone cannot prove freshness.                                                             |
| Saturation                     | `WebGPUTimestampQueryPool.js:71–76`: capacity exhaustion requests an asynchronous resolve and clears current bookkeeping. An already-pending resolve can leave incomplete coverage. Overflow must invalidate qualification, not silently become a partial total.                                               |

Audited SHA-256:

- `WebGPUTimestampQueryPool.js`: `719c23dab1783a752b5c454f2564d39a28638e191aa4078cc82cfc1b968c0dfb`
- `WebGPUBackend.js`: `f572de154dbce29e906209aa103399d38653b7601c3605b0fce20b0c8d80efb9`

## Native-pass coverage risk

`WebGPUBackend.js:943` allocates timestamp writes when beginning a logical render
context. The framebuffer-copy path ends its native pass at line3143 and resumes
with the same descriptor at line3173, without allocating another pair. Repeated
writes can replace an earlier segment's timestamps. Layered render descriptors
also share timestamp writes at line1254 and execute multiple passes at line1464.
These paths prevent assuming that one logical-context timestamp covers every
native pass. The application's viewport/water-copy path makes this relevant.

First verify this with real native pass/query receipts. Until unique, complete
interval coverage is established, label results **instrumented queried-pass
durations**, and report aggregate GPU qualification as unavailable. Do not patch
the backend or rewrite pass descriptors merely to make a measurement gate pass.

## Staged, least-invasive implementation

1. Add an explicit diagnostic-only construction option in
   `packages/shared/src/utils/rendering/RendererFactory.ts:34`, forwarded through
   `baseRendererOpts` at line212 to both device-limit attempts. Leave normal
   defaults, rendering profiles, resolution, lighting and quality unchanged.
2. Pass that intent before the first renderer construction in
   `packages/shared/src/systems/client/ClientGraphics.ts:101`. Use a fresh,
   dedicated capture page. Its module-level renderer persists across world
   teardown: `destroy()` at line534 stops the animation loop and removes the
   canvas but does not dispose the renderer. Reject a reused renderer with
   incompatible diagnostic intent; do not toggle an existing backend or dispose
   this shared renderer from an observer.
3. Add one bounded, generation-owned resolver. Allow at most one outstanding
   resolve per query type; never await readback in the rendering loop or route it
   through the renderer preparation queue. Retain exact UID/frame freshness,
   coverage and dropped counts, not just the scalar result. Finalize only closed
   frames; distinguish skipped rendering from measured zero. A proposed initial
   window is 10 seconds with at most 600 completed-frame receipts and an explicit
   bounded per-pass receipt cap. Cap hits invalidate completeness.
4. Record device identity/support, construction mode, CPU readback latency,
   sample age and unavailable/invalid reasons. Unsupported features mean
   unavailable, not zero and not a lower rendering profile. Stop publication on
   timeout, device loss or owner retirement; prevent late promises publishing
   into a replacement world. The diagnostic releases its own observation state;
   actual renderer disposal owns its query pools and awaits pending resolution
   (`Backend.js:825–831`, `WebGPUTimestampQueryPool.js:260–325`).
5. Only after native coverage qualification, report render and compute pass sums
   separately, with the measured interval and omissions. Copies outside measured
   passes are excluded. A sum of pass durations is not `max(end)-min(start)`, CPU
   frame cost, presentation latency, or an FPS estimate. Keep low-overhead RAF
   evidence and matched uninstrumented controls separate.

## Required tests and acceptance gates

- Pure bookkeeping tests: bounded retention, duplicate/stale results, partial
  frames, zero, negative deltas, timeout, retirement and asynchronous cleanup.
  These are not simulated GPU qualification.
- Real native WebGPU tests: single pass; multiple logical renders in one frame;
  render plus compute; framebuffer-copy/pass-resume; layered passes if admitted;
  capacity pressure with pending readback; teardown during mapping.
- Actual-world coverage: account for every native pass with unique intervals,
  preserve all GPU/page error gates, and reject saturation or missing samples.
  If the split-pass gap is confirmed, design and review a narrow timestamp-path
  correction before claiming complete GPU sums.
- Matched instrumented/uninstrumented captures must retain identical scene,
  camera, resolution and profile. Record browser/device information and
  quantization policy. Do not silently enable developer timing overrides.

The standard exposes no WebGL-style disjoint flag. Timestamp values are
implementation-defined; counter resets can yield negative deltas, which must be
discarded without failing the application. Device loss and query/readback errors
invalidate affected evidence. A quantized zero is not proof of free GPU work.
See the [WebGPU timestamp specification](https://gpuweb.github.io/gpuweb/#timestamp)
and the audited [specification source](https://github.com/gpuweb/gpuweb/blob/e0aff163a37eb3633ffd612e2a943ceb6196d6af/spec/index.bs#L14822).

Chrome documents 100µs timestamp quantization under normal settings; its
developer-feature override is development-only. Nanosecond units do not imply
nanosecond accuracy. See [Chrome WebGPU developer features](https://developer.chrome.com/docs/web-platform/webgpu/developer-features)
(published 2025-06-03; checked 2026-09-11).
