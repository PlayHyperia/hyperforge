# Hyperia performance budget — Native350, October 6, 2026

## Result

**60 FPS at actual 2× is not achieved.** The focus-bounded Chrome recording observes approximately **28.5 Hz** game callbacks and browser presentation feedback. This is a profiled stationary view, not an uninstrumented sustained gameplay acceptance run.

The game is the current canonical Build349 on `codex/sol-duel-stream-launch`, including pushed tree checkpoint `e88e8193cbfada2e8f934e75855befa93193019d`. Build admission verifies nine bundles/source maps, zero private source overrides, and exact current tree bytes. Settings remain **3024×1724 drawing buffer, DPR2, MSAA4, High shadows, postprocessing and bloom**. Hardware: MacBook Pro, Apple M5, 10 CPU cores, 24 GB RAM; AC power was present. Other host load is not certified absent.

## Actual timing

Native DevTools recording: 91.850 seconds overall, including setup and unfocused edges. Actual `ClientInput.onFocus`/`onBlur` callbacks bracket **+33.437109 to +79.640888 seconds**. Fully contained game RAF callbacks are identified by the recurring request-ID chain and sampled `ClientRuntime.onAnimationFrame → World.tick` ancestry.

| Focus-bounded observation               | Count |      Mean |       p95 |
| --------------------------------------- | ----: | --------: | --------: |
| Game RAF callback wall work             | 1,316 | 12.612 ms | 16.265 ms |
| Game callback-start intervals           | 1,315 | 35.111 ms | 38.376 ms |
| Browser presentation-feedback intervals | 1,315 | 35.111 ms | 41.667 ms |

Every retained callback-start interval exceeds 16.667 ms. Trimming one second from each focus boundary still gives approximately 28.54 Hz. This rules out handoff edges as the explanation for this recording, not every possible host confound.

`GPUTask` events are CPU work on Chrome's GPU-process main thread, not hardware execution timestamps for terrain/grass. **Do not subtract 12.6 from 35.1 and label the difference GPU time.** No current exclusive GPU-per-feature budget is claimed.

## Ranked CPU work

A separate conservative **35–78 second** window includes 1,229 complete game-render callbacks. The real V8 profile is reconstructed from PID13739/profile0x1, including profiler-thread chunks. Signed deltas are retained and samples are stably time-sorted; attribution is clipped to the complete callback intervals. These are **sampled self costs**, not exact instrumented function durations.

| Rank | Sampled function                              | Mean per game callback |
| ---- | --------------------------------------------- | ---------------------: |
| 1    | `updateMatrixWorld`                           |               1.491 ms |
| 2    | `multiplyMatrices`                            |               1.108 ms |
| 3    | `_projectObject` — scene traversal/projection |               1.042 ms |
| 4    | `writeBuffer` — CPU buffer submission         |               0.700 ms |
| 5    | `_renderObjectDirect`                         |               0.602 ms |
| 6    | `Bindings._update`                            |               0.438 ms |
| 7    | `UniformsGroup.update`                        |               0.431 ms |
| 8    | `getMaterialCacheKey`                         |               0.408 ms |

Inclusive graphics averages **10.333 ms** and inclusive `World.tick` **12.077 ms**; they overlap and must not be added. Full callback wall mean in this narrower window is 12.510 ms. Matrix multiplication occurs in several callers: summing the first two self rows does not isolate scene propagation.

Disjoint sampled graphics attribution by view: main/output **3.941 ms**, primary shadow **1.791 ms**, reflection excluding its shadow **3.006 ms**, reflection shadow **1.596 ms** per callback. These are CPU render-preparation subdivisions, not GPU pass times.

Scene-driven matrix propagation averages **1.905 ms**. The first/main propagation is required; repeated reflection/shadow propagation accounts for **1.299 ms/callback of sampled work**, an upper work ceiling rather than predicted savings. Samples lack object IDs and cannot separate static environment from actor/bone descendants.

A second, separate `Animation.update` RAF loop is genuinely present, but consumes only **12.015 ms total across 1,229 callbacks** (median 0.009 ms), without sampled `World.tick`/render ancestry. Its renderer identity is unproved. Do not describe it as a second full world render or a large preview cost.

## Ranked submitted geometry

Three ordinary consecutive frames **8384–8386** each reconcile to **800 actual draw-counter increments and 8,623,259 submitted triangle slots**. There are 690 backend visits per frame; visits and actual draws are not interchangeable. Shadow rows are assigned using original object identity rather than the shadow material name.

| Rank | Category                     | Draw increments/frame | Triangle slots/frame |
| ---- | ---------------------------- | --------------------: | -------------------: |
| 1    | Grass                        |                    63 |            5,116,788 |
| 2    | Quad terrain                 |                    29 |              923,466 |
| 3    | Mushrooms                    |                    36 |              822,132 |
| 4    | Rooted flowers               |                     4 |              496,928 |
| 5    | Confirmed batched roots      |                   184 |              478,284 |
| 6    | Pond foliage                 |                    10 |              220,510 |
| 7    | Parent-qualified stations    |                    25 |              171,526 |
| 8    | Unattributed instanced roots |                    70 |              136,092 |
| 9    | Skinned actors/silhouette    |                    27 |               80,992 |
| 10   | Water                        |                    64 |               57,936 |
| 11   | Sky, including cloud planes  |                   128 |               32,808 |
| 12   | Outcrop LOD meshes           |                    12 |               32,000 |
| 13   | Pond docks                   |                     8 |               19,712 |
| 14   | Named bank/smithy parts      |                    24 |               11,168 |
| 15   | Arena/lobby/fence/pillars    |                    52 |               10,008 |
| 16   | Pond rocks                   |                     6 |                8,044 |
| 17   | Unjoined auxiliary object145 |                     1 |                3,968 |
| 18   | Fishing glows                |                    56 |                  896 |
| 19   | Output transform             |                     1 |                    1 |
|      | **Total**                    |               **800** |        **8,623,259** |

A later scene snapshot at frame 40785 matches **97/98 initially unnamed IDs** exactly by ID/name/userType/class. That splits the original 431-draw/795,714-triangle bucket into eight confirmed batched roots, twelve station-parent meshes, 31 still-unattributed instanced roots, 18 arena children, 28 cloud planes and one auxiliary object absent from the main scene. This is a later-frame identity/parent join, **not same-frame ancestry proof**. Batched species remain unqualified; 34 other batched roots appear in the scene snapshot but submit no geometry in the three captured frames.

Grass is **59.3% of submitted triangle slots**, not 59.3% of frame time. Water's low triangle count does not imply cheap shading/reflections. The unnamed bucket is not an established tree category. Frame counts do not describe unique asset triangle counts or geometry-memory residency.

Primary camera16 submits 330 draws/4,895,601 triangles; shadow camera111 216/1,244,326; camera3680 252/2,479,363; the remaining views account for two draws/3,969 triangles. The original draw export has null render-target IDs. A later read-only snapshot resolves camera3680 by exact identity from the water reflector's `virtualCameras.get(world.camera)` map; this is a later same-session identity check, not a contemporaneous target capture.

## Decisions and next implementation gates

- [x] Integrate and push exact-empty tree batches: repeated prior stationary CPU saving of 1.3–1.5 ms, 95/95 focused tests and independent 25/25 real-fixture tests. This is an actual source optimization, not 60 FPS acceptance.
- [x] Obtain a current focused CPU trace and separate geometry ranking at unchanged 2× quality.
- [x] Park unchanged mushroom existing-sphere culling: all nine currently submitted chunks intersect main/reflection/sun views. Their generic 20 m padding is not a validated model bound. Stock InstancedMesh culling also requires repair because geometry spheres already contain world coordinates; blindly enabling it double-transforms the bounds.
- [x] Park repeated terrain-AABB gating: the old Native211 screen already tested this mechanism, with inconsistent net gain. Do not relabel it as a new improvement.
- [ ] Identify a substantial quality-equivalent reduction in grass rendering work with actual vertex/fragment/coverage attribution; existing chunk culling, zero-mask omission, ground/basis caching and parked compaction proposals are not new wins.
- [ ] Investigate actor/static transform ownership before attempting repeated matrix propagation reuse. Preserve the first native update, render-time equipment/bow writers, skin bind-matrix side effects, camera updates, topology changes and fallback for unsupported callbacks/reentrancy. A global `scene.matrixWorldAutoUpdate=false` switch is **not approved by this audit**.
- [ ] Resolve the unnamed draw-heavy bucket to owned systems before changing batching or claiming trees are the culprit.
- [ ] Consider tighter mushroom bounds only after complete model/scale verification and fresh useful-coverage evidence. There is no existing-sphere benefit in this view.
- [ ] Finish actual hardware GPU attribution. The current Metal/Dawn route remains parked after its tooling refusals; do not repeat it unchanged or weaken browser/security protections.
- [ ] Validate each accepted candidate in matched natural before/after runs, including movement/arena/day-cycle, actual equipment/skinning and dynamic load/reconnect behavior.
- [ ] Accept performance only after sustained actual 2× 60 FPS/16.667ms evidence with specified hardware/scene population, tail latency, memory and visual parity. Art work remains deferred.

The full-island sun map spans 400 m and covers the compact island: a blanket distant-grass shadow removal or a new outside-map grass gate is not established as a useful current optimization. Its exact coverage, complete wind bounds and numerical/bias contract would still be required; it is not the next assumed large win.

## Retained evidence and cleanup

Root reruns both pinned cadence and self-CPU audits successfully. The audit history retains the original unsigned-delta refusal and the separately reviewed reporting correction; all 11,942 signed negative deltas stay in the reconstruction, and 577 GPU-process tasks with missing optional thread durations remain explicitly unknown. These are analysis/reporting changes, not altered native samples or production code. [Reproducible root audit](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/native350-root-performance-audit.json).

- [Raw draw inventory](/Users/lucid/Downloads/hyperia-native350-render-inventory-01.json): 775,573 bytes; SHA256 `9ccfa60ea8758edc29de90822b9fc0f740d1549d52c837c54e164c5ee70f5b6b`.
- [Raw CPU trace](/Users/lucid/Downloads/hyperia-native350-cpu-trace-01.json.gz): 17,229,496 bytes; SHA256 `d46f65488999e00f8bbef253910cd0385d8ce96965bc2bc45cf23c788ffa3ca7`.
- [Mushroom/view bounds snapshot](/Users/lucid/Downloads/hyperia-native350-mushroom-bounds-01.json): 8,832 bytes; SHA256 `57201dda1805eb61f57acabd428ac5b2b6e4c8fee7f37f27fad49434bbb33739`.
- [Scene ownership snapshot](/Users/lucid/Downloads/hyperia-native350-scene-ownership-01.json): 290,192 bytes; SHA256 `7e15d6d7ee0cf5838da6d6b015ae4baf5eed89f607291488236d5015e64933f4`; later frame40785, 2,346 nodes/537 meshes/42 batched roots.
- [Canonical build report](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/isolated-build349-report.json): SHA256 `d04a5187d095f4cf52c094ed85d5425bfea06714216b9ec4bce19ad891cd2c73`.
- [Stopped runtime preservation receipt](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/runtime-native350-canonical-performance01/process.json): STOPPED at 15:59:31 UTC, errors[], exact protectedBefore/After, disposable database removed, all four private ports retired. Root freshly rehashes 2,288 protected files. Public 3333/5555/5556 owners and saved database remain unchanged.

The temporary draw wrapper restores before profiling; final native readback shows no inventory alias, null render-object callback, healthy device and original 2×/MSAA4. Owned DevTools/private game tab close; original New Tab remains. Initial console errors are the acknowledged missing cow/placeholder path, not claimed globally absent; subsequent warnings are inspected but no unrelated content is changed.

The source contract review also checks the actual installed r186 implementation against [Three.js Renderer r186](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js). Its scene updates are conditional on automatic matrix-world updating; disabling that option is not itself proof that game transforms and skinning stay correct.
