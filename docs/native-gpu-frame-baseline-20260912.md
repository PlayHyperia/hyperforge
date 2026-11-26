# Native CPU/GPU frame baseline — 2026-09-12

## Result and decision

The existing island does not yet have demonstrated performance headroom for
more foliage or effects. In the overview, the instrumented client tick itself
exceeds the 16.67ms frame interval associated with 60Hz, and GPU pass sums are
also substantial. Optimize the measured work before expanding visual density.
Do not reduce resolution, shadow quality, functional trees or approved content
to make the baseline appear faster. This is diagnosis, not a graphics downgrade.

Native run: `asset-studio/game-test-integration/gpu-frame-probe03/`.
Report SHA-256:
`51861d08587b616b317c632b97431bff9adb437f0901dafa3c81b15de85667b7`.
Runtime source commit: `e98463a0c99e4ef25b181a99c3252f07dd92edac`.

| Metric                                        | Campus overview |     Near meadow |
| --------------------------------------------- | --------------: | --------------: |
| Measured client frames                        |             467 |             601 |
| Client tick elapsed, median / p95             | 20.40 / 25.80ms |  9.90 / 12.60ms |
| GPU render-pass sum, median / p95             | 18.42 / 23.86ms | 16.78 / 19.20ms |
| Client tick interval, median / p95            | 20.70 / 26.30ms | 16.70 / 17.90ms |
| Draw calls across all passes, median          |           1,285 |             616 |
| Submitted triangles across all passes, median |       5,348,419 |       2,820,535 |
| Render passes per client tick                 |               6 |               4 |

Both compute ledgers contained **zero compute passes**. This is observed absence
in these windows, not a substituted zero for unsupported/missing query results.
CPU and GPU work overlap: **do not add their durations**. Client tick cadence is
not browser-presented FPS. No full GPU wall-frame or end-to-end stream timing
was measured. The CPU value is instrumented tick wall elapsed, including native
submission, query-hook overhead and any scheduling interruption; it is not a
profiler's CPU-thread execution-time measurement.

## Conditions and bounded instrumentation

Headful Chrome 152, nonfallback Metal WebGPU, Apple M5/24GiB host; fixed
`island-720p60-v1`: 1280x720, DPR1, four-sample MSAA, existing shadows and water,
postprocessing off as in the prior baseline. Six grass chunks retain 2,275
clumps, with 48 functional trees and 52 dressing placements. Two live diagnostic
agents and existing NPCs are present. The isolated launcher skips betting,
keeper and stream; this is not competitive-fight/encoding/betting load.

Each window has a one-second warmup followed by ten seconds of measurement.
Camera/settings match exactly at its boundaries; no screenshot or traversal
census runs inside the window. Natural daylight advances: overview phase
0.49247–0.53918; meadow 0.54070–0.58756. These are different views and phases,
not an A/B claim about an optimization. Existing lightweight harness observers
remain installed. No cache purge or uninstrumented-overhead comparison is claimed.

The probe temporarily wraps the actual world tick and the actual r186 timestamp
initializer, forwarding the original receiver and arguments. It uses Three's
real query pools and asynchronous readbacks. An observed `info.reset()` boundary
preserves draw/triangle accounting without preventing or adding a reset. Render
and compute pass counts use native lifetime-counter deltas, which survive reset.

Each query UID is joined to its real renderer/client frame; all values are
retained instead of taking only the scalar result of an async query batch.
Percentiles use nearest rank over measured frames. Bounds: 2,400 client rows,
65,536 pass rows, 1,024 cached descriptors, 2,048 queries per allocated pool,
20-second watchdog and 15-second drain deadline. Readbacks occur no more often
than every 100ms per pool, with at most one pending readback per pool. There is
no replacement animation loop, device, render, clock, queue-completion wait,
resolution override or dummy GPU work.

Cleanup restores the tick, reset method, timestamp initializer, tracking state,
cached pass descriptors and original `{render:null,compute:null}` property
descriptors. Restoring cached `timestampWrites` is necessary: otherwise they can
retain a soon-to-be-disposed query set even after tracking is disabled. Both
windows disposed the actual render pool's query set and 32,768 bytes of resolve/
readback buffers. All six ownership-restoration flags are true.

## Verification and retained failures

- `asset-studio/gpu-frame-profile01/preflight03.log`: 12/12 harness preflights.
  Existing startup, scene, camera, content-error, source and cleanup gates remain.
- `scripts/diagnostics/native-gpu-frame-probe.test.mjs`: 5/5 focused tests after
  formatting. Arithmetic vectors reject incomplete, duplicate, negative, hidden,
  off-tick and unclean evidence. Tests also inspect the actual r186 backend's
  default pools and actual `Info.reset()` behavior. These are unit tests, not a
  substitute for the native run or a simulated GPU result.
- The two exported functions in `scripts/diagnostics/native-gpu-frame-probe.mjs`
  are a durable opt-in copy of the functions actually executed by the external
  harness. Prettier-normalized function bodies were compared for exact equality;
  their hashes are saved in the evidence JSON. The game does not import/install
  the probe. No game-runtime source or asset changed in this checkpoint.
- Independent `service-planting01/verify-native-root.mjs` verification joins
  every raw UID/value/query index independently, checks pass order and client
  ownership, and recalculates all published distributions without importing the
  producer's summary. **5,744/5,744 raw passes**, 1,178 total client rows including
  warmup/terminal rows, and 1,068 measured rows; no missing/duplicate/off-tick work.
- `asset-studio/gpu-frame-profile01/native-root03.log`: 675 current source pins,
  596 archives (59,175,506 bytes), 14 PNG hashes, instance transforms, grass
  frusta, cutaways, cameras and ownership verified. All eight world images were
  directly inspected. Its historical `newShrubs:20` field is not new work here.
- No page, GPU or cleanup errors. Owned browser, launcher and all four ports
  close cleanly. **Study passes; overall still fails** the 19 existing cow/dagger
  content errors. They are not suppressed or reclassified as a successful launch.

Preserved failed diagnostic runs:

1. `gpu-frame-probe01`, report SHA
   `cce105fd588fd810370f314ba1c4f8cead44b8de49f4dc4ee85110b11a030fce`:
   admission wrongly expected an empty pool object. The actual constructor
   supplies two null slots. Failure occurred before probe hooks were installed.
2. `gpu-frame-probe02`, report SHA
   `26b881bc099d54df11dde9309af4721d7fcf2ae1e8a5f83bce9285137a89e0b1`:
   queries resolved, but summary rejected zero frame counters. DevStats calls
   `Info.reset()` during the tick. Corrected by observing that real reset and
   using lifetime-call deltas; the rejected summary remains rejected.

The saved [machine-readable baseline](evidence/native-gpu-frame-baseline-20260912.json)
contains raw-report provenance and unrounded distributions. It does not replace
the full local source/image/query archive.

## Next implementation gates

1. Identify the actual six/four passes, their scene/camera/target owners and
   expensive draw categories. Profile real CPU stacks separately. The pass
   counts alone do not establish whether shadows, reflections, skinning,
   traversal or another subsystem dominates. Avoid speculative optimizations.
2. Reduce proven redundant work with correct batching, culling and ownership;
   retain visual quality and functional resource behavior. Correct DevStats'
   stale WebGPU assumptions: `render.calls` counts render invocations, not draw
   calls, and current r186 does expose `Info.reset()`.
3. Resolve loading/grass-grounding contention, then build substantial layered
   understory and fractured ridge/coast silhouettes. The reviewed lawn still
   looks sparse/airbrushed, ridges soft and synthetic, shrubs repetitive/cool,
   water/sky flat. No AAA art acceptance is granted by the timing tests.
4. Qualify actual presented frames, uninstrumented overhead, complete native
   memory, moving cameras/agents, full stream/betting load, sustained runs and
   target-device tiers. One M5 host and ten-second windows are not scalability
   or launch evidence. Keep integrated lighting/sky/water/contact, animation,
   avatar/equipment, audio and full agent-loop work on the launch checklist.

## Primary references

[Three's query-pool API](https://threejs.org/docs/pages/WebGPUTimestampQueryPool.html)
documents allocation, asynchronous resolution and disposal. The installed r186
source was also read: its scalar resolver returns the final frame in a batch,
so that scalar cannot stand in for a frame distribution.

[Chrome's timestamp-query guidance](https://developer.chrome.com/blog/new-in-webgpu-121)
explains optional feature support, pass timestamp writes, quantization and
invalid/negative counter intervals. No precision/security flags were disabled;
the numeric fractions in the report must not be interpreted as nanosecond
accuracy. Pass timestamps do not measure compositor presentation or queue idle.
